// FILE: ThreadDetailHydrationState.tsx
// Purpose: Render the transcript placeholder while thread history syncs (or after it fails).
// Layer: Chat presentation
// Depends on: shared Spinner and Button primitives, DelayedLoaderFade.

import type { OrchestrationUnreadableThread } from "@moss/contracts";

import { CopyTextButton } from "~/components/ui/copyTextButton";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { formatUnreadableThreadDetails } from "~/components/UnreadableThreadsNotice";
import { useTranslation } from "~/localization";

import { DelayedLoaderFade } from "./DelayedLoaderFade";

/** A conversation the server reported as unreadable: one plain line, never a spinner. */
function UnreadableThreadState({ unreadable }: { unreadable: OrchestrationUnreadableThread }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 select-none" role="status">
      <span className="text-ui leading-snug text-muted-foreground">
        {t("unreadableThreads.pane")}
      </span>
      <CopyTextButton
        text={formatUnreadableThreadDetails([unreadable])}
        label="details"
        copyLabel={t("unreadableThreads.copyDetails")}
        copiedLabel={t("unreadableThreads.copyDetails")}
        copiedText={t("unreadableThreads.copied")}
      />
    </div>
  );
}

export const ThreadDetailHydrationState = function ThreadDetailHydrationState({
  state,
  onRetry,
  unreadable = null,
}: {
  state: "loading" | "failed";
  onRetry: () => void;
  /** Set when the server listed this conversation as unreadable; wins over both states. */
  unreadable?: OrchestrationUnreadableThread | null;
}) {
  if (unreadable) {
    return <UnreadableThreadState unreadable={unreadable} />;
  }
  if (state === "loading") {
    return (
      // Delayed like the chat mount loader: a snapshot that lands within a few frames
      // (a warm reconnect, a short thread) swaps in without flashing the spinner first.
      <DelayedLoaderFade>
        <div className="flex flex-col items-center gap-3 select-none">
          <Spinner aria-label="Loading conversation" className="size-5 text-muted-foreground/50" />
          <span className="text-ui leading-snug text-muted-foreground/50">
            Loading conversation
          </span>
        </div>
      </DelayedLoaderFade>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <span className="text-ui leading-snug text-muted-foreground">
        This conversation didn't load.
      </span>
      <Button onClick={onRetry} size="sm" variant="outline">
        Try again
      </Button>
    </div>
  );
};
