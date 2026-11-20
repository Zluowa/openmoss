// FILE: IssueSourcesSettings.tsx
// Purpose: Settings › Issue sources: where code review reads issues besides GitHub. Each source
//          is one click: Connect opens the same sign-in as its connector (Linear, or Atlassian
//          for Jira; one sign-in serves agents and code review), and once connected every team
//          or site shows, each with a switch.
// Layer: Settings UI
// Exports: IssueSourcesSettings

import type { ExternalIssueSource } from "@moss/contracts";
import { findMcpConnectorPreset } from "@moss/shared/mcpConnectors";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useAppSettings } from "~/appSettings";
import {
  hiddenTeamKey,
  ISSUE_SOURCE_PRESENTATION,
  ISSUE_SOURCES,
} from "~/components/issueSources/issueSources.logic";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import {
  issueSourcesQueryKeys,
  issueSourceStatusQueryOptions,
} from "~/lib/issueSourcesQueryOptions";
import { MCP_CONNECTORS_QUERY_KEY } from "~/lib/mcpConnectorsReactQuery";
import { useTranslation } from "~/localization";
import { McpConnectorConnectDialog, mcpConnectorPresetTarget } from "./McpConnectorConnectDialog";
import { McpConnectorGlyph } from "./McpConnectorGlyph";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const SOURCE_TEXT = {
  linear: {
    notConnected: "issueSources.linear.notConnected",
    failed: "issueSources.linear.failed",
    connected: "issueSources.linear.connected",
  },
  jira: {
    notConnected: "issueSources.jira.notConnected",
    failed: "issueSources.jira.failed",
    connected: "issueSources.jira.connected",
  },
} as const;

function IssueSourceRows({
  source,
  onConnect,
}: {
  source: ExternalIssueSource;
  onConnect: (source: ExternalIssueSource) => void;
}) {
  const { t, format } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const statusQuery = useQuery(issueSourceStatusQueryOptions(source));
  const presentation = ISSUE_SOURCE_PRESENTATION[source];
  const text = SOURCE_TEXT[source];
  const status = statusQuery.data;
  const hidden = new Set(settings.issueSourceHiddenTeams);

  const description = statusQuery.isPending
    ? t("issueSources.checking")
    : !status || status.state === "unavailable"
      ? format("issueSources.unavailable", { source: presentation.name })
      : status.state === "not-connected"
        ? t(text.notConnected)
        : status.state === "failed"
          ? t(text.failed)
          : format(text.connected, { count: status.teams.length });

  const control =
    status?.state === "not-connected" && findMcpConnectorPreset(presentation.presetId) ? (
      <Button variant="outline" size="sm" onClick={() => onConnect(source)}>
        {t("issueSources.connect")}
      </Button>
    ) : status?.state === "failed" ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          void queryClient.invalidateQueries({ queryKey: issueSourcesQueryKeys.source(source) })
        }
      >
        {t("codeReview.retry")}
      </Button>
    ) : null;

  return (
    <>
      <SettingsRow
        title={presentation.name}
        leading={<McpConnectorGlyph name={presentation.iconName} />}
        description={description}
        control={control}
      />
      {status?.state === "connected"
        ? status.teams.map((team) => {
            const key = hiddenTeamKey(source, team.id);
            return (
              <SettingsRow
                key={key}
                title={team.name}
                {...(team.key ? { description: team.key } : {})}
                control={
                  <Switch
                    aria-label={format("issueSources.showTeam", { team: team.name })}
                    checked={!hidden.has(key)}
                    onCheckedChange={(checked) =>
                      updateSettings({
                        issueSourceHiddenTeams: checked
                          ? settings.issueSourceHiddenTeams.filter((entry) => entry !== key)
                          : [...settings.issueSourceHiddenTeams, key],
                      })
                    }
                  />
                }
              />
            );
          })
        : null}
    </>
  );
}

export function IssueSourcesSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState<ExternalIssueSource | null>(null);
  const preset = connecting
    ? findMcpConnectorPreset(ISSUE_SOURCE_PRESENTATION[connecting].presetId)
    : undefined;

  return (
    <>
      <SettingsSection title={t("issueSources.title")}>
        {ISSUE_SOURCES.map((source) => (
          <IssueSourceRows key={source} source={source} onConnect={setConnecting} />
        ))}
      </SettingsSection>
      <McpConnectorConnectDialog
        target={preset ? mcpConnectorPresetTarget(preset) : null}
        onOpenChange={(open) => {
          if (!open) setConnecting(null);
        }}
        onConnected={() => {
          const source = connecting;
          setConnecting(null);
          void Promise.all([
            source
              ? queryClient.invalidateQueries({ queryKey: issueSourcesQueryKeys.source(source) })
              : undefined,
            queryClient.invalidateQueries({ queryKey: MCP_CONNECTORS_QUERY_KEY }),
          ]);
        }}
      />
    </>
  );
}
