import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ProjectAgentSummary } from "@moss/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuTrigger, MenuCheckboxItem } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { CirclePersonIcon, SearchIcon, LayoutGridIcon, XIcon } from "~/lib/icons";
import { useProjectAgentSummaries } from "~/components/chat/project/useProjectAgentSummaries";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";
import { useMossbotCopy } from "./mossbot.copy";
import { MossbotAvatar } from "./MossbotAvatar";
import { MossbotCreateLauncher } from "./MossbotCreateLauncher";
import { MossbotRoomCreateDialog } from "./MossbotRooms";
import { MossbotConversationRoster } from "./MossbotConversationRoster";
import { MossbotFolderDialog, MossbotNewConversationMenu } from "./MossbotConversationFolders";
import { isMossbot } from "./mossbot.logic";

/** One native assistant roster on phones; a spacious conversation landing on desktop. */
export function MossbotWorkspace() {
  const { t } = useMossbotCopy();
  const navigate = useNavigate();
  const { summariesByProjectId, loaded } = useProjectAgentSummaries();
  const [creatingRoom, setCreatingRoom] = useState<string[] | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const mainId = useMossbotPreferencesStore((state) => state.mainProjectId);
  const hiddenIds = useMossbotPreferencesStore((state) => state.hiddenProjectIds);
  const assistants = [...summariesByProjectId.values()].filter(isMossbot);
  const available = assistants.filter(
    (bot) => !bot.archivedAt && !hiddenIds.includes(bot.projectId),
  );
  const main = available.find((bot) => bot.projectId === mainId) ?? available[0];
  const openAssistant = (bot: ProjectAgentSummary) => {
    if (!bot.coordinatorThreadId) return;
    useMossbotPreferencesStore.getState().setUnread(bot.projectId, false);
    void navigate({ to: "/$threadId", params: { threadId: bot.coordinatorThreadId } });
  };
  return (
    <main data-mossbot-workspace className="mossbot-home">
      <header className="mossbot-home-header">
        <div className="hidden items-center gap-3 md:flex">
          <SidebarHeaderNavigationControls />
          <span className="text-ui text-muted-foreground">Mossbot</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="mossbot-round-button md:ml-auto"
          aria-label={t("Your profile")}
          onClick={() => void navigate({ to: "/settings", search: { section: "profile" } })}
        >
          <CirclePersonIcon className="size-6" />
        </Button>
        <MossbotNewConversationMenu
          onAssistant={() => setTemplate("personal")}
          onRoom={() => setCreatingRoom([])}
          onFolder={() => setCreatingFolder(true)}
        />
      </header>
      <>
        <div className="mossbot-home-scroll">
          <div className="mossbot-home-content">
            <button
              type="button"
              className="mossbot-main-assistant"
              aria-label={
                main
                  ? `${t("Open conversation")} · ${main.coordinatorName}`
                  : t("Create your assistant")
              }
              onClick={() => (main ? openAssistant(main) : setTemplate("personal"))}
            >
              <MossbotAvatar
                icon={main?.coordinatorIcon}
                color={main?.coordinatorColor}
                className="mossbot-main-avatar"
              />
              <span className="mt-4 text-ui-lg">{main?.coordinatorName ?? "Moss"}</span>
            </button>
            {loaded && assistants.length === 0 && (
              <div className="mossbot-home-empty">
                <p className="text-ui-lg font-medium">{t("A little help, always at hand.")}</p>
                <p className="mt-2 text-ui-sm text-muted-foreground">
                  {t("Research, write, plan, and keep track of what matters.")}
                </p>
                <Button
                  className="mossbot-primary mt-5 rounded-full"
                  onClick={() => setTemplate("personal")}
                >
                  {t("Create your assistant")}
                </Button>
              </div>
            )}
            <MossbotConversationRoster
              query={query}
              showHidden={showHidden}
              showArchived={showArchived}
              onNewRoom={(id) => setCreatingRoom(id ? [id] : [])}
            />
          </div>
        </div>
        <footer className="mossbot-home-footer">
          <div className="mossbot-home-search">
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mossbot-round-button"
                    aria-label={t("Conversation filters")}
                  />
                }
              >
                <LayoutGridIcon />
              </MenuTrigger>
              <ComposerPickerMenuPopup className="mossbot-menu" align="start" side="top">
                <MenuCheckboxItem checked={showHidden} onCheckedChange={setShowHidden}>
                  {t("Show hidden assistants")}
                </MenuCheckboxItem>
                <MenuCheckboxItem checked={showArchived} onCheckedChange={setShowArchived}>
                  {t("Show archived")}
                </MenuCheckboxItem>
              </ComposerPickerMenuPopup>
            </Menu>
            <div className="mossbot-search-field">
              <SearchIcon className="size-5 shrink-0" />
              <Input
                aria-label={t("Search assistants and groups")}
                placeholder={t("Search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="mossbot-search-input"
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("Clear search")}
                  onClick={() => setQuery("")}
                >
                  <XIcon />
                </Button>
              )}
            </div>
          </div>
        </footer>
      </>
      {creatingRoom && (
        <MossbotRoomCreateDialog
          initialMemberIds={creatingRoom}
          onClose={() => setCreatingRoom(null)}
        />
      )}
      {creatingFolder && <MossbotFolderDialog onClose={() => setCreatingFolder(false)} />}
      <MossbotCreateLauncher template={template} onClose={() => setTemplate(null)} />
    </main>
  );
}
