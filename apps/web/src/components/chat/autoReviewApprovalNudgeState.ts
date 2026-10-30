// Thread-scoped eligibility and durable dismissal for the real approval flow.
import type { ProviderApprovalDecision, RuntimeMode } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage } from "~/lib/storage";

// INFERRED: the frozen Codex nudge bundle does not prove an eligibility threshold.
// Count three distinct successful manual approvals; never count rendered/replayed rows.
export const AUTO_REVIEW_MANUAL_APPROVAL_THRESHOLD = 3;
export interface AutoReviewThreadPreference {
  approvedRequestKeys: string[];
  dismissed: boolean;
}

export function isAutoReviewNudgeEligible(
  preference: AutoReviewThreadPreference | undefined,
  runtimeMode: RuntimeMode,
  autoModeAvailable: boolean,
): boolean {
  return (
    autoModeAvailable &&
    runtimeMode === "approval-required" &&
    preference?.dismissed === false &&
    preference.approvedRequestKeys.length >= AUTO_REVIEW_MANUAL_APPROVAL_THRESHOLD
  );
}

interface AutoReviewNudgeState {
  threads: Record<string, AutoReviewThreadPreference>;
  recordApproval: (
    threadId: string,
    requestKey: string,
    decision: ProviderApprovalDecision,
    mode: RuntimeMode,
  ) => void;
  dismiss: (threadId: string) => void;
}

const fallbackStorage = createMemoryStorage();
export const useAutoReviewApprovalNudgeStore = create<AutoReviewNudgeState>()(
  persist(
    (set, get) => ({
      threads: {},
      recordApproval: (threadId, requestKey, decision, mode) => {
        if (
          mode !== "approval-required" ||
          (decision !== "accept" && decision !== "acceptForSession")
        )
          return;
        const current = get().threads[threadId] ?? { approvedRequestKeys: [], dismissed: false };
        if (
          current.dismissed ||
          current.approvedRequestKeys.includes(requestKey) ||
          current.approvedRequestKeys.length >= AUTO_REVIEW_MANUAL_APPROVAL_THRESHOLD
        )
          return;
        set((state) => ({
          threads: {
            ...state.threads,
            [threadId]: {
              ...current,
              approvedRequestKeys: [...current.approvedRequestKeys, requestKey],
            },
          },
        }));
      },
      dismiss: (threadId) =>
        set((state) => ({
          threads: {
            ...state.threads,
            [threadId]: { approvedRequestKeys: [], dismissed: true },
          },
        })),
    }),
    {
      name: "moss:auto-review-approval-nudge:v1",
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return localStorage.getItem(key);
          } catch {
            return fallbackStorage.getItem(key);
          }
        },
        setItem: (key, value) => {
          fallbackStorage.setItem(key, value);
          try {
            localStorage.setItem(key, value);
          } catch {
            /* Keep the session preference when storage is unavailable. */
          }
        },
        removeItem: (key) => {
          fallbackStorage.removeItem(key);
          try {
            localStorage.removeItem(key);
          } catch {
            /* Session-only fallback. */
          }
        },
      })),
      partialize: (state) => ({ threads: state.threads }),
    },
  ),
);
