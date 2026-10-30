import { describe, expect, it } from "vitest";
import {
  evaluateMossQuotaAdmission,
  fetchFreshMossQuotaAdmission,
  isMossManagedProviderInstance,
  validMossQuotaResetAt,
  type MossQuotaProof,
} from "./mossQuotaAdmission";

const NOW = Date.parse("2026-08-17T00:00:00.000Z");

describe("Moss quota admission", () => {
  it("blocks an exhausted lifetime balance without inventing a renewal date", () => {
    const decision = evaluateMossQuotaAdmission({
      instanceId: "codex_moss",
      driver: "codex",
      managed: true,
      quota: {
        billingModel: "cost_budget_v1",
        quotaPolicyMode: "metered",
        requestLimit: null,
        requestsUsed: 0,
        periodEnd: null,
        usageLimits: [{ key: "lifetime", limit: 100, used: 100, resetsAt: null }],
      },
      quotaFetchedAt: NOW,
      now: NOW,
    });
    expect(decision).toMatchObject({ kind: "exhausted", resetAt: null });
  });
  it("recognizes only the exact managed Codex and Claude instances", () => {
    expect(
      isMossManagedProviderInstance({
        instanceId: "codex_moss",
        driver: "codex",
        managed: true,
      }),
    ).toBe(true);
    expect(
      isMossManagedProviderInstance({
        instanceId: "claude_moss",
        driver: "claudeAgent",
        managed: true,
      }),
    ).toBe(true);
    expect(
      isMossManagedProviderInstance({
        instanceId: "codex_moss",
        driver: "codex",
        managed: false,
      }),
    ).toBe(false);
    expect(
      isMossManagedProviderInstance({
        instanceId: "codex_byok",
        driver: "codex",
        managed: true,
      }),
    ).toBe(false);
  });

  it("blocks fresh metered zero while preserving an exact reset proof", () => {
    const decision = evaluateMossQuotaAdmission({
      instanceId: "codex_moss",
      driver: "codex",
      managed: true,
      quota: {
        quotaPolicyMode: "metered",
        requestLimit: 50,
        requestsUsed: 50,
        periodEnd: "2026-08-24T00:00:00.000Z",
        windowSource: "weekly",
      },
      quotaFetchedAt: NOW,
      accountIdentity: "phone:account-a:session-a",
      proofAccountIdentity: "phone:account-a:session-a",
      now: NOW,
    });

    expect(decision).toEqual({
      kind: "exhausted",
      remainingPercent: 0,
      limit: 50,
      used: 50,
      resetAt: "2026-08-24T00:00:00.000Z",
      usagePeriod: "weekly",
      usageBasis: "requests",
    });
  });

  it("blocks a per-account hidden-cost window without using token or request limits", () => {
    expect(
      evaluateMossQuotaAdmission({
        instanceId: "codex_moss",
        driver: "codex",
        managed: true,
        quota: {
          billingModel: "cost_budget_v1",
          usageLimits: [
            {
              key: "five_hour",
              limit: 59.1,
              used: 59.1,
              resetsAt: "2026-08-17T05:00:00.000Z",
            },
            { key: "monthly", limit: 428.7, used: 59.1, resetsAt: "2026-09-17T00:00:00.000Z" },
          ],
          quotaPolicyMode: "metered",
          requestLimit: null,
          requestsUsed: 0,
          periodEnd: "2026-09-17T00:00:00.000Z",
        },
        quotaFetchedAt: NOW,
        now: NOW,
      }),
    ).toEqual({
      kind: "exhausted",
      remainingPercent: 0,
      limit: 59.1,
      used: 59.1,
      resetAt: "2026-08-17T05:00:00.000Z",
      usagePeriod: "five-hour",
      usageBasis: "hidden-cost",
    });
  });

  it.each([
    ["unlimited", "unlimited"],
    ["unavailable", "unavailable"],
  ] as const)("does not treat %s as zero", (_label, quotaPolicyMode) => {
    expect(
      evaluateMossQuotaAdmission({
        instanceId: "claude_moss",
        driver: "claudeAgent",
        managed: true,
        quota: {
          quotaPolicyMode,
          requestLimit: null,
          requestsUsed: 50,
          periodEnd: "2026-08-24T00:00:00.000Z",
          windowSource: "weekly",
        },
        quotaFetchedAt: NOW,
        now: NOW,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("does not block stale quota proof or personal providers", () => {
    expect(
      evaluateMossQuotaAdmission({
        instanceId: "codex_moss",
        driver: "codex",
        managed: true,
        quota: {
          quotaPolicyMode: "metered",
          requestLimit: 50,
          requestsUsed: 50,
          periodEnd: "2026-08-16T23:59:59.000Z",
        },
        quotaFetchedAt: NOW,
        now: NOW,
      }),
    ).toEqual({ kind: "allow" });

    expect(
      evaluateMossQuotaAdmission({
        instanceId: "codex_byok",
        driver: "codex",
        managed: false,
        quota: {
          quotaPolicyMode: "metered",
          requestLimit: 50,
          requestsUsed: 50,
          periodEnd: "2026-08-24T00:00:00.000Z",
        },
        quotaFetchedAt: NOW,
        now: NOW,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("allows an old or cross-account zero snapshot", () => {
    const quota = {
      quotaPolicyMode: "metered" as const,
      requestLimit: 50,
      requestsUsed: 50,
      periodEnd: "2026-08-24T00:00:00.000Z",
    };
    expect(
      evaluateMossQuotaAdmission({
        instanceId: "codex_moss",
        driver: "codex",
        managed: true,
        quota,
        quotaFetchedAt: NOW - 15_001,
        now: NOW,
      }),
    ).toEqual({ kind: "allow" });
    expect(
      evaluateMossQuotaAdmission({
        instanceId: "codex_moss",
        driver: "codex",
        managed: true,
        quota,
        quotaFetchedAt: NOW,
        accountIdentity: "phone:account-b:session-b",
        proofAccountIdentity: "phone:account-a:session-a",
        now: NOW,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("marks an explicit non-weekly window as period usage", () => {
    const result = evaluateMossQuotaAdmission({
      instanceId: "codex_moss",
      driver: "codex",
      managed: true,
      quota: {
        quotaPolicyMode: "metered",
        requestLimit: 50,
        requestsUsed: 50,
        periodEnd: "2026-08-24T00:00:00.000Z",
        windowSource: "monthly",
        windowDurationSeconds: 30 * 24 * 60 * 60,
      },
      quotaFetchedAt: NOW,
      now: NOW,
    });

    expect(result).toMatchObject({ kind: "exhausted", usagePeriod: "period" });
  });

  it("fails open when account identity changes while a quota fetch is in flight", async () => {
    let resolveQuota!: (quota: MossQuotaProof) => void;
    let currentIdentity = "phone:account-a:session-a";
    const fetchQuota = new Promise<MossQuotaProof>((resolve) => {
      resolveQuota = resolve;
    });
    const admission = fetchFreshMossQuotaAdmission({
      instanceId: "codex_moss",
      driver: "codex",
      accountIdentity: currentIdentity,
      isTransitionPending: () => false,
      getCurrentAccountIdentity: () => currentIdentity,
      fetchQuota: () => fetchQuota,
      getFetchedAt: () => NOW,
    });

    currentIdentity = "phone:account-b:session-b";
    resolveQuota({
      quotaPolicyMode: "metered",
      requestLimit: 50,
      requestsUsed: 50,
      periodEnd: "2026-08-24T00:00:00.000Z",
    });

    await expect(admission).resolves.toEqual({ kind: "allow" });
  });

  it("omits invalid reset evidence", () => {
    expect(
      validMossQuotaResetAt(
        {
          periodEnd: "not-a-date",
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      validMossQuotaResetAt(
        {
          periodEnd: "2026-08-16T23:59:59.000Z",
        },
        NOW,
      ),
    ).toBeNull();
  });
});
