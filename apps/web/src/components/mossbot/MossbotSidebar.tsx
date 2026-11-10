import { MossbotRoomCreateDialog } from "./MossbotRooms";
import { MossbotConversationRoster } from "./MossbotConversationRoster";
import { MossbotFolderDialog, MossbotNewConversationMenu } from "./MossbotConversationFolders";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ProjectId } from "@moss/contracts";
import { useProjectAgentSummaries } from "~/components/chat/project/useProjectAgentSummaries";
import { SidebarPanelTitle } from "~/components/SidebarPanelTitle";
import { SidebarPrimaryAction } from "~/components/SidebarPrimaryAction";
import { SidebarIconButton } from "~/components/SidebarIconButton";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { LinkIcon, PlusIcon, SearchIcon } from "~/lib/icons";
import { useMossbotCopy } from "./mossbot.copy";

import { isMossbot } from "./mossbot.logic";
import { MossbotCreateLauncher } from "./MossbotCreateLauncher";

export function MossbotSidebar(props: { activeProjectId: ProjectId | null }) {
  const { t } = useMossbotCopy();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { summariesByProjectId } = useProjectAgentSummaries();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  const [showArchived, setShowArchived] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState<string[] | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const assistants = [...summariesByProjectId.values()].filter(isMossbot);
  return (
    <div data-mossbot-sidebar className="flex min-h-0 flex-1 flex-col">
      <SidebarPanelTitle title="Mossbot">
        <MossbotNewConversationMenu
          sidebar
          onAssistant={() => setTemplate("personal")}
          onRoom={() => setCreatingRoom([])}
          onFolder={() => setCreatingFolder(true)}
        />
        <SidebarIconButton
          icon={SearchIcon}
          label={t("Search assistants")}
          size="header"
          onClick={() => {
            setSearchOpen(!searchOpen);
            setQuery("");
          }}
        />
      </SidebarPanelTitle>
      <SidebarGroup className="px-1.5 pt-1 pb-3">
        <SidebarMenu>
          <SidebarPrimaryAction
            icon={PlusIcon}
            label={t("New assistant")}
            onClick={() => setTemplate("personal")}
          />
        </SidebarMenu>
        <DisclosureRegion open={searchOpen} contentClassName="pt-2">
          <Input
            ref={searchInput}
            aria-label={t("Search assistants")}
            placeholder={t("Find an assistant")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </DisclosureRegion>
      </SidebarGroup>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        <MossbotConversationRoster
          sidebar
          activeProjectId={props.activeProjectId}
          query={query}
          showArchived={showArchived}
          onNewRoom={(id) => setCreatingRoom(id ? [id] : [])}
        />
        {assistants.some((bot) => bot.archivedAt) && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-3 justify-start text-muted-foreground"
            aria-pressed={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            {t(showArchived ? "Hide archived" : "Show archived")}
          </Button>
        )}
      </div>
      <SidebarGroup className="mt-auto px-1.5 pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="text-muted-foreground"
              onClick={() => {
                void navigate({ to: "/settings", search: { section: "integrations" } });
                if (isMobile) setOpenMobile(false);
              }}
            >
              <LinkIcon />
              <span>{t("Connect another agent")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      {creatingRoom && (
        <MossbotRoomCreateDialog
          initialMemberIds={creatingRoom}
          onClose={() => setCreatingRoom(null)}
        />
      )}
      {creatingFolder && <MossbotFolderDialog onClose={() => setCreatingFolder(false)} />}
      <MossbotCreateLauncher
        template={template}
        onClose={() => setTemplate(null)}
        onCreated={() => {
          if (isMobile) setOpenMobile(false);
        }}
      />
    </div>
  );
}
