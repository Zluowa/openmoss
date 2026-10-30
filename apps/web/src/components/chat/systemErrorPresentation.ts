import type {
  ProviderKind,
  ServerProviderUsageLimit,
  RuntimeCodexErrorInfo,
} from "@synara/contracts";

import {
  formatImageGenerationResetDate,
  normalizeImageGenerationPlanName,
} from "./imageGenerationLimit.logic";
import type { ComposerAccountSourceKind } from "./providerAccountSources";

export type SystemErrorUsageVariant =
  | "managed"
  | "upgrade"
  | "upgrade-or-add-credits"
  | "add-credits"
  | "retry";

export type SystemErrorPresentation =
  | { kind: "generic" }
  | { kind: "usage-limit"; variant: SystemErrorUsageVariant };

export function resolveSystemErrorPresentation(input: {
  readonly errorInfo?: RuntimeCodexErrorInfo;
  readonly sourceKind: ComposerAccountSourceKind;
  readonly planName?: string | null | undefined;
}): SystemErrorPresentation {
  if (input.errorInfo !== "usageLimitExceeded") {
    return { kind: "generic" };
  }
  if (input.sourceKind === "moss") {
    return { kind: "usage-limit", variant: "managed" };
  }
  if (input.sourceKind !== "personal") {
    return { kind: "usage-limit", variant: "retry" };
  }
  switch (normalizeImageGenerationPlanName(input.planName)) {
    case "free":
    case "go":
      return { kind: "usage-limit", variant: "upgrade" };
    case "plus":
    case "prolite":
    case "pro lite":
      return { kind: "usage-limit", variant: "upgrade-or-add-credits" };
    case "pro":
      return { kind: "usage-limit", variant: "add-credits" };
    default:
      return { kind: "usage-limit", variant: "retry" };
  }
}

export function selectSystemErrorResetAt(
  limits: ReadonlyArray<Pick<ServerProviderUsageLimit, "usedPercent" | "resetsAt">>,
  nowMs = Date.now(),
): string | null {
  const candidates = limits.flatMap((limit) => {
    const usedPercent =
      typeof limit.usedPercent === "number" &&
      Number.isFinite(limit.usedPercent) &&
      limit.usedPercent >= 0 &&
      limit.usedPercent <= 100
        ? limit.usedPercent
        : Number.NEGATIVE_INFINITY;
    const parsedResetMs = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
    const resetMs = Number.isFinite(parsedResetMs) ? parsedResetMs : Number.NEGATIVE_INFINITY;
    return [{ resetsAt: limit.resetsAt ?? null, resetMs, usedPercent }];
  });
  candidates.sort(
    (left, right) => right.usedPercent - left.usedPercent || right.resetMs - left.resetMs,
  );
  const selected = candidates[0];
  if (!selected?.resetsAt || !Number.isFinite(selected.resetMs) || selected.resetMs <= nowMs) {
    return null;
  }
  return selected.resetsAt;
}

export function formatSystemErrorResetDate(
  resetsAt: string | null | undefined,
  locale: string,
  nowMs = Date.now(),
): string | null {
  if (!resetsAt) {
    return null;
  }
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return null;
  }
  return formatImageGenerationResetDate(resetMs / 1_000, locale, nowMs);
}

export function shouldQuerySystemErrorUsage(input: {
  readonly provider: ProviderKind;
  readonly sourceKind: ComposerAccountSourceKind;
  readonly providerInstanceId?: string | null;
}): boolean {
  if (!input.providerInstanceId) {
    return false;
  }
  return (
    input.sourceKind === "moss" || (input.sourceKind === "personal" && input.provider === "codex")
  );
}
