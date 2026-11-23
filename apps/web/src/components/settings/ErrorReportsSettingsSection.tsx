// FILE: ErrorReportsSettingsSection.tsx
// Purpose: The switch for error reports, explained in one line.
// Layer: Settings UI
// Depends on: Shared settings row primitives.

import { applyErrorReportsPreference } from "~/components/ErrorReportsPreferenceSync";
import { Switch } from "~/components/ui/switch";

import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function ErrorReportsSettingsSection({
  checked,
  isDefault,
  defaultValue,
  onChange,
}: {
  readonly checked: boolean;
  readonly isDefault: boolean;
  readonly defaultValue: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  // Applied here as well as when the saved setting comes back, so turning reports
  // off stops them at once rather than after a round trip to the server.
  const change = (enabled: boolean) => {
    applyErrorReportsPreference(enabled);
    onChange(enabled);
  };

  return (
    <SettingsSection title="Privacy">
      <SettingsRow
        title="Send error reports"
        description="Send a report when Moss hits an error. Chats, code and keys are never included."
        resetAction={
          isDefault ? null : (
            <SettingResetButton label="Send error reports" onClick={() => change(defaultValue)} />
          )
        }
        control={
          <Switch
            checked={checked}
            onCheckedChange={(next) => change(Boolean(next))}
            aria-label="Send error reports"
          />
        }
      />
    </SettingsSection>
  );
}
