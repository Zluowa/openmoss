import { lazy, Suspense, useEffect, useState } from "react";
import type { ProjectAgentSummary } from "@moss/contracts";
import { Button } from "~/components/ui/button";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { isElectron } from "~/env";
import { CHAT_HEADER_CONTROL_CLASS_NAME } from "~/components/chat/chatHeaderControls";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { MossbotAvatar } from "./MossbotAvatar";
import { MossbotAssistantMenu } from "./MossbotAssistantMenu";
import { useMossbotCopy } from "./mossbot.copy";

const MossbotProfile = lazy(() =>
  import("./MossbotProfile").then((module) => ({ default: module.MossbotProfile })),
);

/** Identity and overflow stay inside ChatHeader; transcript/composer/approvals stay native. */
export function MossbotConversationIdentity({
  assistant,
  onOpenWorkbench,
}: {
  assistant: ProjectAgentSummary;
  onOpenWorkbench?: (() => void) | undefined;
}) {
  const { t } = useMossbotCopy();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  useEffect(() => {
    useMossbotPreferencesStore.getState().setUnread(assistant.projectId, false);
  }, [assistant.projectId]);
  return (
    <div className="mossbot-conversation-identity" data-mossbot-conversation>
      {!isElectron && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label={t("Back to assistants")}
          onClick={() => void navigate({ to: "/mossbot" })}
        >
          <ArrowLeftIcon />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className={cn(CHAT_HEADER_CONTROL_CLASS_NAME, "min-w-0 gap-2 px-1.5")}
        aria-label={t("View profile")}
        onClick={() => setProfileOpen(true)}
      >
        <MossbotAvatar
          icon={assistant.coordinatorIcon}
          color={assistant.coordinatorColor}
          className="size-5"
        />
        <span className="truncate text-ui font-medium">{assistant.coordinatorName}</span>
      </Button>
      <MossbotAssistantMenu assistant={assistant} conversation onOpenWorkbench={onOpenWorkbench} />
      {profileOpen && (
        <Suspense fallback={null}>
          <MossbotProfile assistant={assistant} onClose={() => setProfileOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
