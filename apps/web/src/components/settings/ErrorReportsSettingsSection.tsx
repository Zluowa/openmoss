// FILE: ErrorReportsSettingsSection.tsx
// Purpose: The switch for error reports, and an honest account of what a report contains.
// Layer: Settings UI
// Depends on: Shared settings row and disclosure primitives.

import { useState } from "react";

import { applyErrorReportsPreference } from "~/components/ErrorReportsPreferenceSync";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Switch } from "~/components/ui/switch";

import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const SENT_DETAILS = [
  "The type of error and where in Moss's code it happened",
  "Fixed status details, such as which operation failed and its status code",
  "App version, operating system, language, and time zone",
  "Device details such as processor, memory, and graphics",
  "Whether an app session hit an error",
  "Recent app events, such as a window opening",
] as const;

const REMOVED_DETAILS = [
  "Your chats, prompts, and agent replies",
  "Your code, files, and project names",
  "Keys, passwords, tokens, and account details",
  "The text of error messages, unless it's a known message with no personal content",
  "Your computer's name and your system username",
] as const;

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
  const [detailsOpen, setDetailsOpen] = useState(false);

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
        description="Send a report when Moss hits an error, so it can be fixed."
        status="Changes apply right away. While this is off, nothing is sent."
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
      >
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 pt-2 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <DisclosureChevron open={detailsOpen} />
          What a report contains
        </button>
        <DisclosureRegion open={detailsOpen}>
          <div className="space-y-2 pt-1.5">
            <div>
              <p className="m-0 text-ui-sm font-medium text-foreground">Included</p>
              <ul className="m-0 list-disc space-y-0.5 pl-4 pt-0.5 text-ui-sm text-muted-foreground">
                {SENT_DETAILS.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="m-0 text-ui-sm font-medium text-foreground">Removed before sending</p>
              <ul className="m-0 list-disc space-y-0.5 pl-4 pt-0.5 text-ui-sm text-muted-foreground">
                {REMOVED_DETAILS.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
            <p className="m-0 text-ui-xs text-muted-foreground">
              Sentry sees your IP address when a report arrives, as with any web request, and is set
              not to store it. Sentry may retain a coarse region inferred from the connection.
            </p>
          </div>
        </DisclosureRegion>
      </SettingsRow>
    </SettingsSection>
  );
}
