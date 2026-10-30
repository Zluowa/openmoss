// Approval-flow host: share the existing access-mode persistence with the composer.
import type { RuntimeMode } from "@synara/contracts";
import { AutoReviewApprovalNudge } from "./AutoReviewApprovalNudge";
import {
  isAutoReviewNudgeEligible,
  useAutoReviewApprovalNudgeStore,
} from "./autoReviewApprovalNudgeState";

export function ComposerAutoReviewApprovalNudge(props: {
  threadId: string;
  runtimeMode: RuntimeMode;
  autoModeAvailable: boolean;
  persistRuntimeModeChange: (mode: RuntimeMode, notifyFailure?: boolean) => Promise<boolean>;
}) {
  const preference = useAutoReviewApprovalNudgeStore((state) => state.threads[props.threadId]);
  const dismiss = useAutoReviewApprovalNudgeStore((state) => state.dismiss);
  if (!isAutoReviewNudgeEligible(preference, props.runtimeMode, props.autoModeAvailable))
    return null;
  return (
    <div className="pb-2">
      <AutoReviewApprovalNudge
        onDismiss={() => dismiss(props.threadId)}
        onEnable={async () => {
          // The nudge owns its exact failure toast; suppress the generic mode-switch toast.
          if (!(await props.persistRuntimeModeChange("auto", false)))
            throw new Error("Auto-review mode was not persisted");
        }}
      />
    </div>
  );
}
