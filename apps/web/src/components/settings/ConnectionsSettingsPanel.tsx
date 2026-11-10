// FILE: ConnectionsSettingsPanel.tsx
// Purpose: Settings › Connections holds connections only: other devices this one controls,
//          pairing other devices with this one, and SSH hosts. Computer use is its own page.
// Layer: Settings UI
import type { ConnectionTab } from "~/connectionSettingsNavigation";
import { PillTabs } from "~/components/ui/pill-tabs";
import { useTranslation } from "~/localization";
import { SshConnectionsSettingsPanel } from "./SshConnectionsSettingsPanel";
import { RemoteComputersSettingsPanel } from "./RemoteComputersSettingsPanel";
import { IncomingComputerConnections } from "./IncomingComputerConnections";

export function ConnectionsSettingsPanel({
  active,
  tab,
  onTabChange,
}: {
  readonly active: boolean;
  readonly tab: Exclude<ConnectionTab, "this">;
  readonly onTabChange: (tab: ConnectionTab) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={active ? "flex flex-col gap-8" : "contents"}
      data-testid={active ? "connections-settings" : undefined}
    >
      {active ? (
        <PillTabs
          ariaLabel={t("settings.connections.tabs.label")}
          selected={tab}
          onSelect={onTabChange}
          tabs={[
            { id: "devices", label: t("settings.connections.tabs.devices") },
            { id: "pairing", label: t("settings.connections.tabs.pairing") },
            { id: "ssh", label: t("settings.connections.tabs.ssh") },
          ]}
        />
      ) : null}
      <RemoteComputersSettingsPanel active={active && tab === "devices"} />
      <IncomingComputerConnections active={active && tab === "pairing"} />
      <SshConnectionsSettingsPanel active={active && tab === "ssh"} />
    </div>
  );
}
