import { describe, expect, it, vi } from "vitest";
import { evaluateMossQuotaAdmission } from "./mossQuotaAdmission";

const NOW = Date.parse("2026-08-17T00:00:00.000Z");

describe("server Moss quota admission", () => {
  it("returns a typed exhausted decision before provider or title callbacks", () => {
    const providerRunner = vi.fn();
    const titleReactor = vi.fn();
    const decision = evaluateMossQuotaAdmission({
      instanceId: "claude_moss",
      driver: "claudeAgent",
      managed: true,
      quota: {
        quotaPolicyMode: "metered",
        requestLimit: 50,
        requestsUsed: 50,
        periodEnd: "2026-08-24T00:00:00.000Z",
        windowSource: "weekly",
      },
      quotaFetchedAt: NOW,
      now: NOW,
    });

    if (decision.kind === "allow") {
      providerRunner();
      titleReactor();
    }

    expect(decision.kind).toBe("exhausted");
    expect(providerRunner).not.toHaveBeenCalled();
    expect(titleReactor).not.toHaveBeenCalled();
  });

  it("uses the hidden per-account cost window for cost-budget plans", () => {
    expect(
      evaluateMossQuotaAdmission({
        instanceId: "codex_moss",
        driver: "codex",
        managed: true,
        quota: {
          billingModel: "cost_budget_v1",
          usageLimits: [
            {
              key: "monthly",
              limit: 1_393,
              used: 1_393,
              resetsAt: "2026-09-17T00:00:00.000Z",
            },
          ],
          quotaPolicyMode: "metered",
          requestLimit: null,
          requestsUsed: 0,
          periodEnd: "2026-09-17T00:00:00.000Z",
        },
        quotaFetchedAt: NOW,
        now: NOW,
      }),
    ).toMatchObject({
      kind: "exhausted",
      remainingPercent: 0,
      usageBasis: "hidden-cost",
      usagePeriod: "period",
    });
  });
});
