// FILE: ImportSettingsPanel.tsx
// Purpose: Settings → Import panel. Conversations and projects come from the same project
//          import panel as onboarding, so both list every supported agent; the workspace
//          import flow below brings skills, settings, MCP and other configuration.
// Layer: Settings UI

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

import { useTranslation } from "../../localization";
import { ProjectImportPanel } from "../../projectImport/ProjectImportPanel";
import { WorkspaceImportFlow } from "../WorkspaceImportFlow";
import { SettingsSectionShell } from "./SettingsPanelPrimitives";

export function ImportSettingsPanel() {
  const { t } = useTranslation();
  // The panel reports when an import is running; Settings has nothing to lock meanwhile.
  const [, setConversationImportBusy] = useState(false);
  const providerStatuses = useQuery(serverConfigQueryOptions()).data?.providers;
  return (
    <div className="space-y-8">
      <SettingsSectionShell title={t("import.conversations.title")}>
        <p className="px-2 pb-2 text-ui-sm text-muted-foreground">
          {t("import.conversations.description")}
        </p>
        <ProjectImportPanel
          onBusyChange={setConversationImportBusy}
          providerStatuses={providerStatuses}
        />
      </SettingsSectionShell>
      <WorkspaceImportFlow variant="panel" includeConversations={false} />
    </div>
  );
}
