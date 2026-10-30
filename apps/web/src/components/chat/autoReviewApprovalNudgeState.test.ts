import { beforeEach, describe, expect, it } from "vitest";
import {
  isAutoReviewNudgeEligible,
  useAutoReviewApprovalNudgeStore,
} from "./autoReviewApprovalNudgeState";

const state = () => useAutoReviewApprovalNudgeStore.getState();
beforeEach(() => useAutoReviewApprovalNudgeStore.setState({ threads: {} }));

describe("manual approval nudge eligibility", () => {
  it("counts distinct accepted decisions only in manual mode and caps at three", () => {
    state().recordApproval("a", "1", "decline", "approval-required");
    state().recordApproval("a", "1", "accept", "auto");
    expect(state().threads.a).toBeUndefined();
    state().recordApproval("a", "1", "accept", "approval-required");
    state().recordApproval("a", "1", "accept", "approval-required");
    state().recordApproval("a", "2", "accept", "approval-required");
    expect(isAutoReviewNudgeEligible(state().threads.a, "approval-required", true)).toBe(false);
    state().recordApproval("a", "3", "accept", "approval-required");
    state().recordApproval("a", "4", "accept", "approval-required");
    expect(state().threads.a?.approvedRequestKeys).toHaveLength(3);
    expect(isAutoReviewNudgeEligible(state().threads.a, "approval-required", true)).toBe(true);
    expect(isAutoReviewNudgeEligible(state().threads.a, "auto", true)).toBe(false);
    expect(isAutoReviewNudgeEligible(state().threads.a, "full-access", true)).toBe(false);
    expect(isAutoReviewNudgeEligible(state().threads.a, "approval-required", false)).toBe(false);
    expect(isAutoReviewNudgeEligible(state().threads.b, "approval-required", true)).toBe(false);
  });
  it("keeps dismissal across rehydration and subsequent approvals", async () => {
    state().dismiss("a");
    await useAutoReviewApprovalNudgeStore.persist.rehydrate();
    state().recordApproval("a", "late", "accept", "approval-required");
    expect(state().threads.a).toEqual({ approvedRequestKeys: [], dismissed: true });
  });
});
