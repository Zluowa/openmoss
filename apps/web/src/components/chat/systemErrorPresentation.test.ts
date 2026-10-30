import { describe, expect, it } from "vitest";

import {
  formatSystemErrorResetDate,
  resolveSystemErrorPresentation,
  selectSystemErrorResetAt,
} from "./systemErrorPresentation";

const NOW_MS = Date.parse("2026-08-29T10:00:00.000Z");

const usagePresentationCases = [
  {
    name: "managed Moss",
    sourceKind: "moss",
    planName: "Pro",
    expected: { kind: "usage-limit", variant: "managed" },
  },
  {
    name: "personal Free",
    sourceKind: "personal",
    planName: "Free",
    expected: { kind: "usage-limit", variant: "upgrade" },
  },
  {
    name: "personal Go",
    sourceKind: "personal",
    planName: "Go",
    expected: { kind: "usage-limit", variant: "upgrade" },
  },
  {
    name: "personal Plus",
    sourceKind: "personal",
    planName: "Plus",
    expected: { kind: "usage-limit", variant: "upgrade-or-add-credits" },
  },
  {
    name: "personal ProLite",
    sourceKind: "personal",
    planName: "ProLite",
    expected: { kind: "usage-limit", variant: "upgrade-or-add-credits" },
  },
  {
    name: "personal Pro",
    sourceKind: "personal",
    planName: "Pro",
    expected: { kind: "usage-limit", variant: "add-credits" },
  },
  {
    name: "personal unknown plan",
    sourceKind: "personal",
    planName: "Business",
    expected: { kind: "usage-limit", variant: "retry" },
  },
  {
    name: "profile source",
    sourceKind: "profile",
    planName: "Business",
    expected: { kind: "usage-limit", variant: "retry" },
  },
] as const;

describe("system error presentation", () => {
  it.each(usagePresentationCases)(
    "keeps $name source-bound",
    ({ sourceKind, planName, expected }) => {
      expect(
        resolveSystemErrorPresentation({
          errorInfo: "usageLimitExceeded",
          sourceKind,
          planName,
        }),
      ).toEqual(expected);
    },
  );

  it("uses the highest-use window before validating its reset", () => {
    expect(
      selectSystemErrorResetAt(
        [
          { usedPercent: 100, resetsAt: undefined },
          { usedPercent: 80, resetsAt: "2026-08-30T12:00:00.000Z" },
        ],
        NOW_MS,
      ),
    ).toBeNull();
    expect(
      selectSystemErrorResetAt(
        [
          { usedPercent: 80, resetsAt: "not-a-date" },
          { usedPercent: 80, resetsAt: "2026-08-30T12:00:00.000Z" },
        ],
        NOW_MS,
      ),
    ).toBe("2026-08-30T12:00:00.000Z");
    expect(
      selectSystemErrorResetAt(
        [
          { usedPercent: 80, resetsAt: "2026-08-30T12:00:00.000Z" },
          { usedPercent: 80, resetsAt: "2026-08-31T12:00:00.000Z" },
        ],
        NOW_MS,
      ),
    ).toBe("2026-08-31T12:00:00.000Z");
    expect(
      selectSystemErrorResetAt([{ usedPercent: 80, resetsAt: "2026-08-29T09:00:00.000Z" }], NOW_MS),
    ).toBeNull();
  });

  it("formats future resets and rejects invalid or past values", () => {
    expect(formatSystemErrorResetDate("2026-08-29T12:30:00.000Z", "en-US", NOW_MS)).toBe(
      new Date("2026-08-29T12:30:00.000Z").toLocaleTimeString("en-US", { timeStyle: "short" }),
    );
    expect(formatSystemErrorResetDate("2026-08-29T09:00:00.000Z", "en-US", NOW_MS)).toBeNull();
    expect(formatSystemErrorResetDate("not-a-date", "en-US", NOW_MS)).toBeNull();
  });
});
