// FILE: ConnectionsSettingsPanel.tsx
// Purpose: One connection hub; preserve the real local computer and SSH workflow owners.
// Layer: Settings UI
import type { AppSettingsBinding } from "~/appSettings";
import type { ConnectionTab } from "~/connectionSettingsNavigation";
import { PillTabs } from "~/components/ui/pill-tabs";
import { useTranslation } from "~/localization";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";
import { SshConnectionsSettingsPanel } from "./SshConnectionsSettingsPanel";
import { RemoteComputersSettingsPanel } from "./RemoteComputersSettingsPanel";
import { IncomingComputerConnections } from "./IncomingComputerConnections";

export function ConnectionsSettingsPanel({
  active,
  tab,
  onTabChange,
  ...binding
}: AppSettingsBinding & {
  readonly active: boolean;
  readonly tab: ConnectionTab;
  readonly onTabChange: (tab: ConnectionTab) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={active ? "flex flex-col gap-10" : "contents"}
      data-testid={active ? "connections-settings" : undefined}
    >
      {active ? (
        <PillTabs
          ariaLabel={t("settings.connections.tabs.label")}
          selected={tab}
          onSelect={onTabChange}
          tabs={[
            { id: "this", label: t("settings.connections.tabs.this") },
            { id: "devices", label: t("settings.connections.tabs.devices") },
            { id: "ssh", label: t("settings.connections.tabs.ssh") },
          ]}
        />
      ) : null}
      <ComputerSettingsPanel {...binding} active={active && tab === "this"} />
      <IncomingComputerConnections active={active && tab === "this"} />
      <RemoteComputersSettingsPanel active={active && tab === "devices"} />
      <SshConnectionsSettingsPanel active={active && tab === "ssh"} />
    </div>
  );
}
