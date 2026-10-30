// Codex timeline notices restored after the upstream merge:
// stream reconnect, system error, usage limit, and generated-image placeholder.
// i18n:
//   localConversation.streamError.reconnecting
//   localConversation.streamError.serverOverloadedReconnecting
//   localConversation.usageLimit.retry
//   codex.localTaskRow.systemError
//   codex.localConversation.generatedImage

import { useTranslation } from "../../localization";
import type { WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";

export function TimelineCodexNoticeRow(props: { workEntry: WorkLogEntry; fontSizePx: number }) {
  const { format, t } = useTranslation();
  const notice = props.workEntry.codexNotice;
  const fontSize = `${props.fontSizePx}px`;

  if (props.workEntry.itemType === "image_generation" && notice === undefined) {
    const loading = props.workEntry.toolStatus === "running";
    const label = loading
      ? t("codex.localConversation.generatedImage.loading")
      : format("codex.localConversation.generatedImage", { imageNumber: 1 });
    return (
      <div className="py-1" data-generated-image-row="true" style={{ fontSize }}>
        <p className={MUTED_LABEL_TEXT_CLASS_NAME}>{label}</p>
        <div
          className={cn(
            "mt-1 h-36 w-full max-w-sm rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)]",
            loading && "animate-pulse",
          )}
          data-generated-image-placeholder="true"
        />
      </div>
    );
  }

  if (!notice) return null;

  let label = t("codex.localTaskRow.systemError");
  if (notice.kind === "stream") {
    const retry = props.workEntry.streamRetry;
    const progress =
      retry?.reconnectAttempt && retry.reconnectMaxAttempts
        ? `${retry.reconnectAttempt}/${retry.reconnectMaxAttempts}`
        : null;
    const busy =
      retry?.errorInfo === "serverOverloaded" ||
      props.workEntry.detail?.toLowerCase().includes("busy") === true;
    label = busy
      ? t("localConversation.streamError.serverOverloadedReconnecting")
      : progress
        ? format("localConversation.streamError.reconnectingProgress", { progress })
        : t("localConversation.streamError.reconnecting");
  } else if (notice.kind === "usage") {
    label = notice.resetsAt
      ? format("localConversation.usageLimit.retryAt", { resetDate: notice.resetsAt })
      : t("localConversation.usageLimit.retry");
  }

  return (
    <div
      className={cn("py-1", MUTED_LABEL_TEXT_CLASS_NAME)}
      style={{ fontSize }}
      data-codex-notice={notice.kind}
      role="status"
    >
      {label}
    </div>
  );
}
