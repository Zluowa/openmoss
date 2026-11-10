import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { MossbotRoom } from "@moss/contracts";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  EllipsisIcon,
  MessageCircleIcon,
  PinIcon,
  UsersIcon,
  EyeIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { MossbotFolderDialog, MossbotMoveToFolderMenu } from "./MossbotConversationFolders";
import { useMossbotCopy } from "./mossbot.copy";

export function MossbotRoomMenu({
  room,
  onManageMembers,
}: {
  room: MossbotRoom;
  onManageMembers?: (() => void) | undefined;
}) {
  const { t } = useMossbotCopy();
  const navigate = useNavigate();
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pinned = useMossbotPreferencesStore((s) => s.pinnedRoomIds.includes(room.id));
  const hidden = useMossbotPreferencesStore((s) => s.hiddenRoomIds.includes(room.id));
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="mossbot-round-button mossbot-overflow"
              aria-label={`${t("Group chat actions")} · ${room.name}`}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" className="mossbot-menu">
          <MenuItem
            onClick={
              onManageMembers ??
              (() => void navigate({ to: "/mossbot", search: { room: room.id } }))
            }
          >
            <UsersIcon />
            {t(onManageMembers ? "Manage members" : "Open group chat")}
          </MenuItem>
          <MenuItem
            onClick={() => useMossbotPreferencesStore.getState().setRoomUnread(room.id, true)}
          >
            <MessageCircleIcon />
            {t("Mark as unread")}
          </MenuItem>
          <MenuItem onClick={() => useMossbotPreferencesStore.getState().toggleRoomPinned(room.id)}>
            <PinIcon />
            {t(pinned ? "Unpin" : "Pin")}
          </MenuItem>
          <MossbotMoveToFolderMenu
            conversationKey={`room:${room.id}`}
            onCreate={() => setCreatingFolder(true)}
          />
          <MenuItem
            variant={hidden ? "default" : "destructive"}
            onClick={() => useMossbotPreferencesStore.getState().setRoomHidden(room.id, !hidden)}
          >
            <EyeIcon />
            {t(hidden ? "Show group chat" : "Hide group chat")}
          </MenuItem>
          <MenuItem variant="destructive" onClick={() => setDeleting(true)}>
            <TrashCanIcon />
            {t("Delete group chat…")}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      {deleting && (
        <MossbotRoomDeleteDialog
          room={room}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            void navigate({ to: "/mossbot" });
          }}
        />
      )}
      {creatingFolder && (
        <MossbotFolderDialog
          conversationKey={`room:${room.id}`}
          onClose={() => setCreatingFolder(false)}
        />
      )}
    </>
  );
}

/** Deletes the room, its member conversations and its workspace; the assistants stay. */
function MossbotRoomDeleteDialog({
  room,
  onClose,
  onDeleted,
}: {
  room: MossbotRoom;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t, errorText } = useMossbotCopy();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Delete group chat")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "Deleting removes this group chat and its conversation history. The assistants and their own chats stay.",
            )}
          </AlertDialogDescription>
          {error && (
            <p role="alert" className="text-ui text-destructive">
              {error}
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => {
              const api = readNativeApi()?.mossbotRooms;
              if (!api) return;
              setBusy(true);
              setError(null);
              void api
                .delete({ roomId: room.id })
                .then(
                  async () => {
                    const preferences = useMossbotPreferencesStore.getState();
                    if (preferences.pinnedRoomIds.includes(room.id))
                      preferences.toggleRoomPinned(room.id);
                    await queryClient.invalidateQueries({ queryKey: ["mossbot", "rooms"] });
                    onDeleted();
                  },
                  (cause: unknown) => setError(errorText(cause)),
                )
                .finally(() => setBusy(false));
            }}
          >
            {t("Delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
