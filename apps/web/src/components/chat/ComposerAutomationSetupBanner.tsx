// FILE: ComposerAutomationSetupBanner.tsx
// Purpose: Slim control strip shown above the composer while Moss is gathering the
// missing details (task and/or schedule) for a chat-created automation. The actual
// back-and-forth renders as message bubbles in the transcript; this strip just marks
// setup mode and lets the user cancel (which restores their text).
// Layer: Chat composer UI
// Exports: ComposerAutomationSetupBanner

import { Button } from "~/components/ui/button";

export const ComposerAutomationSetupBanner = function ComposerAutomationSetupBanner({
  onCancel,
}: {
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-4 sm:px-6 sm:pt-4.5 sm:pb-5">
      <span className="text-ui-sm font-medium text-muted-foreground/50">Setting up automation</span>
      <Button
        variant="outline"
        size="default"
        shape="capsule"
        type="button"
        aria-label="Cancel automation setup"
        onClick={onCancel}
        className="transition-colors duration-150"
      >
        Cancel
      </Button>
    </div>
  );
};
