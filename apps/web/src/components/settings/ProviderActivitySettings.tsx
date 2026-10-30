import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { useRef, useState } from "react";

import { type AppSettings } from "~/appSettings";
import { useTranslation } from "~/localization";
import { isMossActiveProvider } from "~/providerProductCatalog";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { cn } from "~/lib/utils";
import { Switch } from "../ui/switch";
import { ProviderIcon } from "../ProviderIcon";
import { SettingResetButton } from "./SettingControls";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

/**
 * Enabling an optional CLI also makes it available in the composer picker.
 * Lived in ~/appSettings before the upstream merge; kept with its only
 * remaining consumer here.
 */
function providerEnablementSettingsPatch(
  settings: Pick<AppSettings, "disabledProviders" | "hiddenProviders">,
  disabledProviders: ReadonlyArray<ProviderKind>,
): Partial<AppSettings> {
  const disabled = new Set(disabledProviders);
  const newlyEnabled = new Set(
    settings.disabledProviders.filter((provider) => !disabled.has(provider)),
  );
  return {
    disabledProviders: [...disabledProviders],
    hiddenProviders: settings.hiddenProviders.filter((provider) => !newlyEnabled.has(provider)),
  };
}

/** Shared by both settings surfaces so optional CLIs always have an enable path. */
export function ProviderActivitySettings({
  settings,
  defaults,
  ready,
  updateSettingsAndWait,
}: {
  readonly settings: AppSettings;
  readonly defaults: AppSettings;
  readonly ready: boolean;
  readonly updateSettingsAndWait: (
    patch: Partial<AppSettings>,
    options?: { readonly throwOnError?: boolean },
  ) => Promise<void>;
}) {
  const { t, format } = useTranslation();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const providers = settings.providerOrder.filter(isMossActiveProvider);
  const disabled = new Set(settings.disabledProviders);
  const dirty =
    disabled.size !== defaults.disabledProviders.length ||
    defaults.disabledProviders.some((provider) => !disabled.has(provider));
  const update = async (nextDisabled: ProviderKind[]) => {
    if (!ready || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      await updateSettingsAndWait(providerEnablementSettingsPatch(settings, nextDisabled), {
        throwOnError: true,
      });
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <SettingsSection title={t("settings.providers.activity.title")}>
      <SettingsRow
        title={t("settings.providers.activity.title")}
        description={t("settings.providers.activity.description")}
        status={
          saving
            ? t("settings.providers.activity.saving")
            : format("settings.providers.activity.count", {
                count: providers.filter((provider) => !disabled.has(provider)).length,
              })
        }
        resetAction={
          dirty && ready && !saving ? (
            <SettingResetButton
              label={t("settings.providers.activity.title")}
              onClick={() => void update([...defaults.disabledProviders])}
            />
          ) : null
        }
      >
        <div
          className={cn(
            "mt-4",
            SETTINGS_INSET_LIST_CLASS_NAME,
            SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
          )}
        >
          {providers.map((provider) => {
            const enabled = !disabled.has(provider);
            const name = PROVIDER_DISPLAY_NAMES[provider];
            return (
              <SettingsListRow
                key={provider}
                title={
                  <span className="flex items-center gap-2">
                    <ProviderIcon provider={provider} className="size-4 shrink-0" />
                    <span>{name}</span>
                  </span>
                }
                description={t(
                  enabled
                    ? "settings.providers.activity.enabled"
                    : "settings.providers.activity.disabled",
                )}
                actions={
                  <Switch
                    checked={enabled}
                    disabled={!ready || saving}
                    aria-label={format(
                      enabled
                        ? "settings.providers.activity.disableAria"
                        : "settings.providers.activity.enableAria",
                      { provider: name },
                    )}
                    onCheckedChange={(checked) =>
                      void update(
                        checked
                          ? settings.disabledProviders.filter((value) => value !== provider)
                          : [...new Set([...settings.disabledProviders, provider])],
                      )
                    }
                  />
                }
              />
            );
          })}
        </div>
        {saveFailed ? (
          <p role="alert" className="mt-2 text-ui-sm text-destructive">
            {t("settings.providers.activity.error")}
          </p>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
