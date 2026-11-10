import { useState, type ReactNode } from "react";
import { RenameDialog } from "~/components/RenameDialog";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel } from "~/components/ui/collapsible";
import {
  Menu,
  MenuItem,
  MenuTrigger,
  MenuSub,
  MenuSubTrigger,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "~/components/ui/menu";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { EllipsisIcon, FoldersIcon, PlusIcon, UsersIcon } from "~/lib/icons";
import {
  useMossbotPreferencesStore,
  UNGROUPED_CONVERSATIONS,
  type MossbotConversationKey,
  type MossbotConversationFolder,
} from "~/mossbotPreferencesStore";
import { useMossbotCopy } from "./mossbot.copy";
import { ConversationSectionHeader } from "./openmaus/ConversationSectionHeader";

export function MossbotNewConversationMenu({
  onAssistant,
  onRoom,
  onFolder,
  disabled = false,
  sidebar = false,
}: {
  onAssistant: () => void;
  onRoom: () => void;
  onFolder: () => void;
  disabled?: boolean;
  sidebar?: boolean;
}) {
  const { t } = useMossbotCopy();
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={sidebar ? "sidebar-icon-button" : undefined}
            aria-label={t("New assistant or group")}
          />
        }
      >
        <PlusIcon />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end">
        <MenuItem onClick={onAssistant}>
          <PlusIcon />
          {t("New assistant")}
        </MenuItem>
        <MenuItem onClick={onRoom}>
          <UsersIcon />
          {t("New group chat")}
        </MenuItem>
        <MenuItem onClick={onFolder}>
          <FoldersIcon />
          {t("New conversation group")}
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function MossbotFolderDialog({
  folderId,
  conversationKey,
  onClose,
}: {
  folderId?: string | undefined;
  conversationKey?: MossbotConversationKey | undefined;
  onClose: () => void;
}) {
  const { t } = useMossbotCopy();
  const folders = useMossbotPreferencesStore((s) => s.folders);
  const folder = folders.find((f) => f.id === folderId);
  return (
    <RenameDialog
      open
      title={t(folder ? "Rename conversation group" : "New conversation group")}
      description={t(
        "Choose a unique name, up to 60 characters. Groups organize conversations on this device; chat members stay the same.",
      )}
      initialValue={folder?.name ?? ""}
      saveLabel={t(folder ? "Save" : "Create conversation group")}
      cancelLabel={t("Cancel")}
      savingLabel={t("Saving…")}
      isValueValid={(name) =>
        name.length <= 60 &&
        !folders.some(
          (f) => f.id !== folderId && f.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onSave={(name) => {
        if (folderId) useMossbotPreferencesStore.getState().renameFolder(folderId, name);
        else useMossbotPreferencesStore.getState().createFolder(name, conversationKey);
      }}
    />
  );
}

/** Native submenu adapts OpenMAUS SectionPicker's assign / new / ungroup flow. */
export function MossbotMoveToFolderMenu({
  conversationKey,
  onCreate,
}: {
  conversationKey: MossbotConversationKey;
  onCreate: () => void;
}) {
  const { t } = useMossbotCopy();
  const folders = useMossbotPreferencesStore((s) => s.folders);
  const current = useMossbotPreferencesStore((s) => s.folderByConversation[conversationKey]);
  return (
    <MenuSub>
      <MenuSubTrigger>
        <FoldersIcon />
        {t("Move to conversation group")}
      </MenuSubTrigger>
      <ComposerPickerMenuSubPopup>
        <MenuRadioGroup
          value={current ?? UNGROUPED_CONVERSATIONS}
          onValueChange={(id) =>
            useMossbotPreferencesStore
              .getState()
              .moveConversation(conversationKey, id === UNGROUPED_CONVERSATIONS ? null : id)
          }
        >
          <MenuRadioItem closeOnClick value={UNGROUPED_CONVERSATIONS}>
            {t("Ungrouped")}
          </MenuRadioItem>
          {folders.map((f) => (
            <MenuRadioItem closeOnClick key={f.id} value={f.id}>
              {f.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={onCreate}>
          <PlusIcon />
          {t("New conversation group")}
        </MenuItem>
      </ComposerPickerMenuSubPopup>
    </MenuSub>
  );
}

export function MossbotFolderSection({
  folder,
  count,
  searching,
  children,
}: {
  folder?: MossbotConversationFolder | undefined;
  count: number;
  searching: boolean;
  children: ReactNode;
}) {
  const { t } = useMossbotCopy();
  const id = folder?.id ?? UNGROUPED_CONVERSATIONS;
  const collapsed = useMossbotPreferencesStore((s) => s.collapsedFolderIds.includes(id));
  const folders = useMossbotPreferencesStore((s) => s.folders);
  const [renaming, setRenaming] = useState(false);
  const open = searching || !collapsed;
  const move = (direction: -1 | 1) =>
    useMossbotPreferencesStore.getState().moveFolder(id, direction);
  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          if (!searching) useMossbotPreferencesStore.getState().setFolderCollapsed(id, !next);
        }}
        data-mossbot-folder={id}
      >
        <ConversationSectionHeader
          name={folder?.name ?? t("Ungrouped")}
          count={count}
          open={open}
          onMove={folder ? move : undefined}
          menu={
            folder && (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      aria-label={`${t("Conversation group actions")} · ${folder.name}`}
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="end">
                  <MenuItem onClick={() => setRenaming(true)}>
                    {t("Rename conversation group")}
                  </MenuItem>
                  <MenuItem disabled={folders[0]?.id === id} onClick={() => move(-1)}>
                    {t("Move up")}
                  </MenuItem>
                  <MenuItem disabled={folders.at(-1)?.id === id} onClick={() => move(1)}>
                    {t("Move down")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onClick={() => useMossbotPreferencesStore.getState().removeFolder(id)}>
                    {t("Remove group, keep conversations")}
                  </MenuItem>
                </ComposerPickerMenuPopup>
              </Menu>
            )
          }
        />
        <CollapsiblePanel>
          <ul className="mossbot-assistant-list flex flex-col gap-px">{children}</ul>
        </CollapsiblePanel>
      </Collapsible>
      {renaming && <MossbotFolderDialog folderId={id} onClose={() => setRenaming(false)} />}
    </>
  );
}
