// FILE: MossAccountSettingsSection.tsx
// Purpose: The Moss row at the top of Settings → 模型账号: whether the Moss account is
//          connected, its service can't be reached right now, or it isn't signed in.
// Layer: Settings presentation

import { appHistory } from "~/appNavigation";
import { useMossAccountGatewayState } from "~/components/auth/useMossGatewayUnreachable";
import { MossLogo } from "~/components/MossLogo";
import { Button } from "~/components/ui/button";
import { useTranslation } from "~/localization";
import { closeSettings } from "~/settingsDialogStore";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function MossAccountSettingsSection() {
  const { t } = useTranslation();
  const state = useMossAccountGatewayState();
  const description =
    state === "connected"
      ? t("settings.providers.accounts.mossReady")
      : state === "unreachable"
        ? t("provider.readiness.reason.moss-gateway-unreachable")
        : state === "unavailable"
          ? t("settings.providers.accounts.mossUnavailable")
          : state === "signed-out"
            ? t("settings.providers.accounts.mossDescription")
            : undefined;
  const status =
    state === "connected"
      ? t("settings.providers.accounts.connected")
      : state === "unreachable"
        ? t("settings.providers.accounts.unreachable")
        : state === "unavailable"
          ? t("settings.providers.accounts.temporarilyUnavailable")
          : state === "checking"
            ? t("settings.providers.accounts.checking")
            : null;
  return (
    <SettingsSection title="Moss">
      <div data-moss-account-row={state}>
        <SettingsRow
          title="Moss"
          leading={<MossLogo className="size-5" />}
          description={description}
          status={status}
          control={
            state === "signed-out" ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  closeSettings();
                  appHistory.push("/login");
                }}
              >
                {t("settings.providers.accounts.signInMoss")}
              </Button>
            ) : null
          }
        />
      </div>
    </SettingsSection>
  );
}
