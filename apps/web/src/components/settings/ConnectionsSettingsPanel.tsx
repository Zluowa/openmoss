// FILE: ConnectionsSettingsPanel.tsx
// Purpose: Settings › Connections holds connections only: other devices this one controls,
//          phones that use this computer, pairing other devices with this one, and SSH
//          hosts. Computer use is its own page.
// Layer: Settings UI
import type { ConnectionTab } from "~/connectionSettingsNavigation";
import { PillTabs } from "~/components/ui/pill-tabs";
import { useTranslation } from "~/localization";
import { SshConnectionsSettingsPanel } from "./SshConnectionsSettingsPanel";
import { RemoteComputersSettingsPanel } from "./RemoteComputersSettingsPanel";
import { IncomingComputerConnections } from "./IncomingComputerConnections";
import { PhoneSettingsPanel } from "./PhoneSettingsPanel";

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
  const devicesTab = tab === "devices" || tab === "pairing";
  return (
    <div
      className={active ? "flex flex-col gap-8" : "contents"}
      data-testid={active ? "connections-settings" : undefined}
    >
      {active ? (
        <PillTabs
          ariaLabel={t("settings.connections.tabs.label")}
          selected={devicesTab ? "devices" : tab}
          onSelect={onTabChange}
          tabs={[
            { id: "devices", label: t("settings.connections.tabs.devices") },
            { id: "phone", label: t("settings.connections.tabs.phone") },
            { id: "ssh", label: t("settings.connections.tabs.ssh") },
          ]}
        />
      ) : null}
      {/* Pairing both ways is one subject: devices this one opens, and letting another device in.
          Old `tab=pairing` links land here too. */}
      <RemoteComputersSettingsPanel active={active && devicesTab} />
      <PhoneSettingsPanel active={active && tab === "phone"} />
      <IncomingComputerConnections active={active && devicesTab} />
      <SshConnectionsSettingsPanel active={active && tab === "ssh"} />
    </div>
  );
}
