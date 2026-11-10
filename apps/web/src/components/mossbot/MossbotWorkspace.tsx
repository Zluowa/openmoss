// FILE: MossbotWorkspace.tsx
// Purpose: The Mossbot landing: Moss's route surface and top bar, the standard empty state,
//          and one searchable list of assistants and group chats.
// Layer: Mossbot route UI
// Exports: MossbotWorkspace

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { SearchInput } from "~/components/ui/search-input";
import { Menu, MenuTrigger, MenuCheckboxItem } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import { FilterIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useProjectAgentSummaries } from "~/components/chat/project/useProjectAgentSummaries";
import { useMossbotCopy } from "./mossbot.copy";
import { MossbotMark } from "./MossbotAvatar";
import { MossbotCreateLauncher } from "./MossbotCreateLauncher";
import { MossbotRoomCreateDialog, useMossbotRoomList } from "./MossbotRooms";
import { MossbotConversationRoster } from "./MossbotConversationRoster";
import { MossbotFolderDialog, MossbotNewConversationMenu } from "./MossbotConversationFolders";
import { isMossbot } from "./mossbot.logic";

export function MossbotWorkspace() {
  const { t } = useMossbotCopy();
  const { summariesByProjectId, loaded } = useProjectAgentSummaries();
  const rooms = useMossbotRoomList();
  const [creatingRoom, setCreatingRoom] = useState<string[] | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const assistants = [...summariesByProjectId.values()].filter(isMossbot);
  // Nothing yet: the page is the one invitation, not an empty list under it.
  const empty = loaded && assistants.length === 0 && rooms.isSuccess && rooms.data.length === 0;
  return (
    <RouteInsetSurface>
      <div
        data-mossbot-workspace
        className={cn(
          "mossbot-home flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <RouteSurfaceHeader divider={false}>
          {/* The sidebar already names the page on desktop; phones have no sidebar. */}
          <span className="min-w-0 flex-1 truncate text-ui font-medium md:invisible">Mossbot</span>
          <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag] md:hidden">
            <MossbotNewConversationMenu
              onAssistant={() => setTemplate("personal")}
              onRoom={() => setCreatingRoom([])}
              onFolder={() => setCreatingFolder(true)}
            />
          </div>
        </RouteSurfaceHeader>
        {empty ? (
          <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 pb-16 text-center">
            <MossbotMark className="mb-3 size-8 text-muted-foreground" />
            <p className="text-ui-lg font-medium text-foreground">
              {t("A little help, always at hand.")}
            </p>
            <p className="max-w-xs text-ui leading-snug text-muted-foreground">
              {t("Research, write, plan, and keep track of what matters.")}
            </p>
            <Button size="sm" className="mt-4" onClick={() => setTemplate("personal")}>
              {t("Create your assistant")}
            </Button>
          </main>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-[680px] px-4 pt-2 pb-8 sm:px-6">
              <div className="mb-2 flex items-center gap-1">
                <SearchInput
                  aria-label={t("Search assistants and groups")}
                  placeholder={t("Search")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("Conversation filters")}
                      />
                    }
                  >
                    <FilterIcon />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="end">
                    <MenuCheckboxItem checked={showHidden} onCheckedChange={setShowHidden}>
                      {t("Show hidden assistants")}
                    </MenuCheckboxItem>
                    <MenuCheckboxItem checked={showArchived} onCheckedChange={setShowArchived}>
                      {t("Show archived")}
                    </MenuCheckboxItem>
                  </ComposerPickerMenuPopup>
                </Menu>
              </div>
              <MossbotConversationRoster
                query={query}
                showHidden={showHidden}
                showArchived={showArchived}
                onNewRoom={(id) => setCreatingRoom(id ? [id] : [])}
              />
            </div>
          </main>
        )}
      </div>
      {creatingRoom && (
        <MossbotRoomCreateDialog
          initialMemberIds={creatingRoom}
          onClose={() => setCreatingRoom(null)}
        />
      )}
      {creatingFolder && <MossbotFolderDialog onClose={() => setCreatingFolder(false)} />}
      <MossbotCreateLauncher template={template} onClose={() => setTemplate(null)} />
    </RouteInsetSurface>
  );
}
