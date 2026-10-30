import { useEffect, useMemo, useState } from "react";
import type { OrchestrationThreadActivity } from "@synara/contracts";
import { Loader2Icon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import type { ThreadSession } from "../../types";
import {
  deriveConversationConnectionStatus,
  isEstablishedConversationSession,
  readProviderConnectionActivity,
} from "./conversationConnection";

export function ConversationConnectionBanner({
  threadId,
  providerKey,
  session,
  activities,
  isStarting,
  isResuming,
}: {
  threadId: string;
  providerKey: string;
  session: ThreadSession | null;
  activities: readonly OrchestrationThreadActivity[];
  isStarting: boolean;
  isResuming: boolean;
}) {
  const { t } = useTranslation();
  const [established, setEstablished] = useState<{ threadId: string; providerKey: string } | null>(
    null,
  );
  const isEstablished = isEstablishedConversationSession(session);
  const connection = useMemo(
    () => readProviderConnectionActivity(activities, providerKey, session?.provider),
    [activities, providerKey, session?.provider],
  );
  useEffect(() => {
    if (isEstablished) {
      setEstablished((previous) =>
        previous?.threadId === threadId && previous.providerKey === providerKey
          ? previous
          : { threadId, providerKey },
      );
    }
  }, [isEstablished, providerKey, threadId]);
  const status = deriveConversationConnectionStatus({
    session,
    isStarting,
    isResuming,
    isProviderConnecting: connection.isConnecting,
    hasEstablishedSession:
      isEstablished ||
      connection.hasEstablishedSession ||
      (established?.threadId === threadId && established.providerKey === providerKey),
  });
  if (status === null) return null;

  return (
    <div
      aria-live="polite"
      role="status"
      data-conversation-connection-status={status}
      className="flex items-center justify-center gap-2 px-4 py-1 text-ui-lg text-[var(--color-text-foreground-secondary)]"
    >
      <Loader2Icon aria-hidden="true" className="size-3 shrink-0 motion-safe:animate-spin" />
      {status === "reconnecting"
        ? t(
            session?.provider === "codex"
              ? "localConversation.reconnectingToCodex"
              : "localConversation.reconnectingToProvider",
          )
        : t("localConversation.loadingTask")}
    </div>
  );
}
