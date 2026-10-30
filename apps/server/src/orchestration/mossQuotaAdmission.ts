export type MossQuotaProof = {
  readonly billingModel?: string | null | undefined;
  readonly usageLimits?: readonly {
    readonly key: string;
    readonly limit: number | null;
    readonly used: number;
    readonly resetsAt?: string | null;
  }[];
  readonly quotaPolicyMode: string | null | undefined;
  readonly requestLimit: number | null | undefined;
  readonly requestsUsed: number | null | undefined;
  readonly periodEnd: string | null | undefined;
  readonly windowSource?: string | null | undefined;
  readonly windowDurationSeconds?: number | null | undefined;
};

export type MossQuotaAdmissionInput = {
  readonly instanceId: string | null | undefined;
  readonly driver: string | null | undefined;
  readonly managed: boolean;
  readonly quota: MossQuotaProof | null | undefined;
  readonly quotaFetchedAt?: number | null;
  readonly accountIdentity?: string | null;
  readonly proofAccountIdentity?: string | null;
  readonly maxProofAgeMs?: number;
  readonly now?: number;
};

export type MossQuotaAdmission =
  | { readonly kind: "allow" }
  | {
      readonly kind: "exhausted";
      readonly remainingPercent: 0;
      readonly limit: number;
      readonly used: number;
      readonly resetAt: string | null;
      readonly usagePeriod: "five-hour" | "weekly" | "period";
      readonly usageBasis: "hidden-cost" | "requests";
    };

export function isMossManagedProviderInstance(input: {
  readonly instanceId: string | null | undefined;
  readonly driver: string | null | undefined;
  readonly managed: boolean;
}): boolean {
  return (
    input.managed &&
    ((input.instanceId === "codex_moss" && input.driver === "codex") ||
      (input.instanceId === "claude_moss" && input.driver === "claudeAgent"))
  );
}

export function validMossQuotaResetAt(
  quota: Pick<MossQuotaProof, "periodEnd"> | null | undefined,
  now = Date.now(),
): string | null {
  const periodEnd = quota?.periodEnd;
  if (typeof periodEnd !== "string" || periodEnd.trim().length === 0) {
    return null;
  }
  const resetAt = Date.parse(periodEnd);
  return Number.isFinite(resetAt) && resetAt > now ? periodEnd : null;
}

export function evaluateMossQuotaAdmission(input: MossQuotaAdmissionInput): MossQuotaAdmission {
  if (!isMossManagedProviderInstance(input)) {
    return { kind: "allow" };
  }

  const quota = input.quota;
  if (!quota || quota.quotaPolicyMode !== "metered") {
    return { kind: "allow" };
  }

  const now = input.now ?? Date.now();
  if (
    input.quotaFetchedAt !== undefined &&
    (input.quotaFetchedAt === null ||
      !Number.isFinite(input.quotaFetchedAt) ||
      input.quotaFetchedAt > now + 1_000 ||
      now - input.quotaFetchedAt > (input.maxProofAgeMs ?? 10_000))
  ) {
    return { kind: "allow" };
  }
  if (input.accountIdentity !== undefined || input.proofAccountIdentity !== undefined) {
    if (
      input.accountIdentity === null ||
      input.proofAccountIdentity === null ||
      input.accountIdentity !== input.proofAccountIdentity
    ) {
      return { kind: "allow" };
    }
  }

  if (quota.billingModel === "cost_budget_v1") {
    const exhaustedCostWindow = quota.usageLimits?.find(
      (window) =>
        (window.key === "five_hour" || window.key === "weekly" || window.key === "monthly") &&
        typeof window.limit === "number" &&
        Number.isFinite(window.limit) &&
        window.limit >= 0 &&
        typeof window.used === "number" &&
        Number.isFinite(window.used) &&
        window.used >= window.limit,
    );
    if (!exhaustedCostWindow) return { kind: "allow" };
    const resetAt = validMossQuotaResetAt(
      { periodEnd: exhaustedCostWindow.resetsAt ?? quota.periodEnd },
      now,
    );
    return {
      kind: "exhausted",
      remainingPercent: 0,
      limit: exhaustedCostWindow.limit ?? 0,
      used: exhaustedCostWindow.used,
      resetAt,
      usagePeriod:
        exhaustedCostWindow.key === "five_hour"
          ? "five-hour"
          : exhaustedCostWindow.key === "weekly"
            ? "weekly"
            : "period",
      usageBasis: "hidden-cost",
    };
  }

  const requestLimit = quota.requestLimit;
  const requestsUsed = quota.requestsUsed;
  if (
    typeof requestLimit !== "number" ||
    typeof requestsUsed !== "number" ||
    !Number.isSafeInteger(requestLimit) ||
    requestLimit < 0 ||
    !Number.isSafeInteger(requestsUsed) ||
    requestsUsed < 0 ||
    requestsUsed < requestLimit
  ) {
    return { kind: "allow" };
  }

  const periodEnd = quota.periodEnd;
  if (
    typeof periodEnd === "string" &&
    (periodEnd.trim().length === 0 || !Number.isFinite(Date.parse(periodEnd)))
  ) {
    return { kind: "allow" };
  }
  if (typeof periodEnd === "string" && Date.parse(periodEnd) <= now) {
    return { kind: "allow" };
  }

  return {
    kind: "exhausted",
    remainingPercent: 0,
    limit: requestLimit,
    used: requestsUsed,
    resetAt: validMossQuotaResetAt(quota, now),
    usagePeriod:
      quota.windowSource?.trim().toLocaleLowerCase("en-US") === "weekly" ||
      quota.windowSource?.trim().toLocaleLowerCase("en-US") === "week" ||
      quota.windowDurationSeconds === 7 * 24 * 60 * 60
        ? "weekly"
        : "period",
    usageBasis: "requests",
  };
}
