// FILE: _chat.skills.tsx
// Purpose: Path parent for the Customize route family (Plugins · Skills). Apps
//          are plugins here, as in Codex: Moss Apps list in the plugin directory.
// Layer: Route

import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { useState } from "react";

import {
  MossCustomizeInstalledRowsContext,
  MossCustomizeSecondarySidebar,
  type MossInstalledPluginRow,
  type MossCustomizeTab,
} from "~/components/MossCustomizeSecondarySidebar";
import { PluginLibrary } from "~/components/PluginLibrary";

function MossCustomizeDestinationShell() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [activeTab, setActiveTab] = useState<MossCustomizeTab>("plugins");
  const [installed, setInstalled] = useState<readonly MossInstalledPluginRow[]>([]);
  const isSkillsBrowse = pathname === "/skills" || pathname === "/skills/";

  return (
    <div
      data-moss-customize-destination
      className="flex h-svh min-h-0 min-w-0 flex-1 bg-[#f7f7f8] text-[#1f1f1f] dark:bg-[#0d0d0d] dark:text-white"
    >
      <MossCustomizeSecondarySidebar
        activeTab={activeTab}
        installed={installed}
        onSelectTab={setActiveTab}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden" data-moss-plugins-main>
        {/* The browse root is rendered here so the shell-owned tab state can
            drive both the secondary rail and PluginLibrary. Manage/detail
            routes keep their dedicated child route through Outlet. */}
        {isSkillsBrowse ? (
          <PluginLibrary
            browseTab={activeTab}
            onBrowseTabChange={(tab) => setActiveTab(tab)}
            onInstalledRowsChange={setInstalled}
            hideBrowseTabs
          />
        ) : (
          <MossCustomizeInstalledRowsContext.Provider value={setInstalled}>
            <Outlet />
          </MossCustomizeInstalledRowsContext.Provider>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/skills")({
  component: MossCustomizeDestinationShell,
});
