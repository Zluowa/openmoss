import { lazy, Suspense, useRef, useState } from "react";
import type { ProjectAgentSummary } from "@moss/contracts";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger, MenuSub, MenuSubTrigger } from "~/components/ui/menu";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import {
  CirclePersonIcon,
  EllipsisIcon,
  MessageCircleIcon,
  PinIcon,
  ShareIcon,
  EyeIcon,
  UsersIcon,
  SettingsIcon,
  SearchIcon,
  ArchiveIcon,
  PlayIcon,
  PauseIcon,
  ArrowRightIcon,
  FoldersIcon,
  DashboardLayoutIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { requestConversationPanel } from "~/components/chat/auxiliary/conversationPanelRequest";
import { openGuestShareDialog } from "~/guestShareDialogStore";
import { usePinnedProjectAgentsStore } from "~/pinnedProjectAgentsStore";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { useStore } from "~/store";
import { readNativeApi } from "~/nativeApi";
import { useProjectAgentSummariesStore } from "~/components/chat/project/useProjectAgentSummaries";
import { toastManager } from "~/components/ui/toast";
import { useMossbotCopy } from "./mossbot.copy";
import { MossbotFolderDialog, MossbotMoveToFolderMenu } from "./MossbotConversationFolders";

const MossbotProfile = lazy(() =>
  import("./MossbotProfile").then((module) => ({ default: module.MossbotProfile })),
);
const MossbotShareTemplate = lazy(() =>
  import("./MossbotShareTemplate").then((module) => ({ default: module.MossbotShareTemplate })),
);
const MossbotDeleteDialog = lazy(() =>
  import("./MossbotDeleteDialog").then((module) => ({ default: module.MossbotDeleteDialog })),
);

/** Shared by the full list, sidebar, and native conversation header. */
export function MossbotAssistantMenu({
  assistant,
  conversation = false,
  onNewGroup,
  onOpenWorkbench,
}: {
  assistant: ProjectAgentSummary;
  conversation?: boolean;
  onNewGroup?: () => void;
  onOpenWorkbench?: (() => void) | undefined;
}) {
  const { t, errorText } = useMossbotCopy();
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [surface, setSurface] = useState<"profile" | "share" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const receipt = useRef<{ action: string; id: string } | null>(null);
  const pinned = usePinnedProjectAgentsStore((state) =>
    state.pinnedProjectAgentIds.includes(assistant.projectId),
  );
  const hidden = useMossbotPreferencesStore((state) =>
    state.hiddenProjectIds.includes(assistant.projectId),
  );
  const main = useMossbotPreferencesStore((state) => state.mainProjectId === assistant.projectId);
  const control = async (
    action: "pauseGroup" | "resumeGroup" | "archiveGroup" | "unarchiveGroup",
  ) => {
    const api = readNativeApi()?.projectAgent;
    if (!api || pending.current) return;
    pending.current = true;
    if (receipt.current?.action !== action) receipt.current = { action, id: crypto.randomUUID() };
    setBusy(true);
    try {
      const overview = await api[action]({
        requestId: receipt.current.id,
        projectId: assistant.projectId,
      });
      useProjectAgentSummariesStore.getState().applyOverview(overview);
      receipt.current = null;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("Could not update assistant"),
        description: errorText(error),
      });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="mossbot-overflow"
              aria-label={`${t("Assistant actions")} · ${assistant.coordinatorName ?? "Moss"}`}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end">
          {conversation ? (
            <>
              <MenuItem onClick={() => setSurface("profile")}>
                <CirclePersonIcon />
                {t("View profile")}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  if (assistant.coordinatorThreadId)
                    requestConversationPanel({
                      threadId: assistant.coordinatorThreadId,
                      action: "find",
                    });
                }}
              >
                <SearchIcon />
                {t("Find in conversation")}
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                onClick={() => {
                  useMossbotPreferencesStore.getState().setUnread(assistant.projectId, true);
                  if (assistant.coordinatorThreadId)
                    useStore.getState().markThreadUnread(assistant.coordinatorThreadId);
                }}
              >
                <MessageCircleIcon />
                {t("Mark as unread")}
              </MenuItem>
              <MenuItem
                onClick={() =>
                  usePinnedProjectAgentsStore
                    .getState()
                    .toggleProjectAgentPinned(assistant.projectId)
                }
              >
                <PinIcon />
                {t(pinned ? "Unpin" : "Pin")}
              </MenuItem>
              <MenuItem
                disabled={main}
                onClick={() => useMossbotPreferencesStore.getState().setMain(assistant.projectId)}
              >
                <ArrowRightIcon />
                {t(main ? "Main assistant" : "Set as main assistant")}
              </MenuItem>
              {onNewGroup && (
                <MenuItem onClick={onNewGroup}>
                  <UsersIcon />
                  {t("New group chat")}
                </MenuItem>
              )}
              <MossbotMoveToFolderMenu
                conversationKey={`assistant:${assistant.projectId}`}
                onCreate={() => setCreatingFolder(true)}
              />
            </>
          )}
          <MenuItem onClick={() => setSurface("share")}>
            <ShareIcon />
            {t("Share as template…")}
          </MenuItem>
          {conversation && (
            <MenuItem variant="destructive" onClick={() => setSurface("delete")}>
              <TrashCanIcon />
              {t("Delete assistant…")}
            </MenuItem>
          )}
          {!conversation && (
            <MenuItem
              variant={hidden ? "default" : "destructive"}
              onClick={() =>
                useMossbotPreferencesStore.getState().setHidden(assistant.projectId, !hidden)
              }
            >
              <EyeIcon />
              {t(hidden ? "Show assistant" : "Hide assistant")}
            </MenuItem>
          )}
          <MenuSub>
            <MenuSubTrigger>
              <EllipsisIcon />
              {t("More")}
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup>
              {conversation && assistant.coordinatorThreadId && (
                <MenuItem
                  onClick={() => {
                    if (assistant.coordinatorThreadId)
                      requestConversationPanel({
                        threadId: assistant.coordinatorThreadId,
                        action: "overview",
                      });
                  }}
                >
                  <DashboardLayoutIcon />
                  {t("Overview")}
                </MenuItem>
              )}
              {onOpenWorkbench && (
                <MenuItem onClick={onOpenWorkbench}>
                  <FoldersIcon />
                  {t("Files and tools")}
                </MenuItem>
              )}
              {conversation && assistant.coordinatorThreadId && (
                <MenuItem
                  onClick={() => {
                    if (assistant.coordinatorThreadId)
                      openGuestShareDialog(assistant.coordinatorThreadId);
                  }}
                >
                  <ShareIcon />
                  {t("Share conversation…")}
                </MenuItem>
              )}
              <MenuItem onClick={() => setSurface("profile")}>
                <SettingsIcon />
                {t("Assistant settings")}
              </MenuItem>
              <MenuItem
                disabled={busy || Boolean(assistant.archivedAt)}
                onClick={() => void control(assistant.pausedAt ? "resumeGroup" : "pauseGroup")}
              >
                {assistant.pausedAt ? <PlayIcon /> : <PauseIcon />}
                {t(assistant.pausedAt ? "Resume" : "Pause")}
              </MenuItem>
              <MenuItem
                disabled={busy}
                onClick={() =>
                  void control(assistant.archivedAt ? "unarchiveGroup" : "archiveGroup")
                }
              >
                <ArchiveIcon />
                {t(assistant.archivedAt ? "Restore" : "Archive assistant")}
              </MenuItem>
            </ComposerPickerMenuSubPopup>
          </MenuSub>
        </ComposerPickerMenuPopup>
      </Menu>
      {creatingFolder && (
        <MossbotFolderDialog
          conversationKey={`assistant:${assistant.projectId}`}
          onClose={() => setCreatingFolder(false)}
        />
      )}
      <Suspense fallback={null}>
        {surface === "profile" && (
          <MossbotProfile assistant={assistant} onClose={() => setSurface(null)} />
        )}
        {surface === "share" && (
          <MossbotShareTemplate assistant={assistant} onClose={() => setSurface(null)} />
        )}
        {surface === "delete" && (
          <MossbotDeleteDialog assistant={assistant} onClose={() => setSurface(null)} />
        )}
      </Suspense>
    </>
  );
}
