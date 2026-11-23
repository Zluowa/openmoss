import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type UnifiedModelProviderConfig,
} from "@moss/contracts";
import { useState } from "react";
import { appHistory } from "~/appNavigation";
import { useMossAccountGatewayState } from "~/components/auth/useMossGatewayUnreachable";
import { MossLogoMark } from "~/components/MossLogoMark";
import { ProviderBrandTile } from "~/components/ProviderBrandIcons";
import { Button } from "~/components/ui/button";
import { ChevronRightIcon, PlusIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { closeSettings } from "~/settingsDialogStore";
import { SettingsCard, SettingsSectionShell } from "../SettingsPanelPrimitives";
import { cliBrandIconId, resolveEffectiveCliSourceUi } from "./providerWorkbenchTypes";

export function MossProviderDetailPane(props: {
  readonly activeCliProviders: ReadonlyArray<ProviderKind>;
  readonly unifiedProviders: ReadonlyArray<UnifiedModelProviderConfig>;
  readonly defaultUnifiedProviderId: string | null | undefined;
  readonly unifiedProviderByCli: Readonly<Record<string, string>> | undefined;
  readonly onSelectCli: (provider: ProviderKind) => void;
  readonly onAddUnifiedProvider?: () => void;
}) {
  const { locale, t } = useTranslation();
  const isZh = locale === "zh-CN";
  const accountState = useMossAccountGatewayState();
  const [pinwheelHovered, setPinwheelHovered] = useState(false);

  const mossRoutedClis = props.activeCliProviders.filter(
    (driver) =>
      resolveEffectiveCliSourceUi({
        defaultUnifiedProviderId: props.defaultUnifiedProviderId,
        unifiedProviderByCli: props.unifiedProviderByCli,
        provider: driver,
      }) === "moss",
  );

  const accountDescription =
    accountState === "connected"
      ? t("settings.providers.accounts.mossReady")
      : accountState === "unreachable"
        ? t("provider.readiness.reason.moss-gateway-unreachable")
        : accountState === "unavailable"
          ? t("settings.providers.accounts.mossUnavailable")
          : accountState === "checking"
            ? t("settings.providers.accounts.checking")
            : isZh
              ? "免密钥即用，自动调度云端模型"
              : "Zero setup · cloud models ready";

  const accountStatusLabel =
    accountState === "connected"
      ? t("settings.providers.accounts.connected")
      : accountState === "unreachable"
        ? t("settings.providers.accounts.unreachable")
        : accountState === "unavailable"
          ? t("settings.providers.accounts.temporarilyUnavailable")
          : accountState === "checking"
            ? t("settings.providers.accounts.checking")
            : null;

  return (
    <div className="space-y-6">
      <div
        className="flex flex-wrap items-center justify-between gap-4 pb-1"
        data-moss-account-row={accountState}
      >
        <div
          className="flex min-w-0 items-center gap-3.5"
          onMouseEnter={() => setPinwheelHovered(true)}
          onMouseLeave={() => setPinwheelHovered(false)}
        >
          <span
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-card border border-border/65 bg-foreground/[0.04] transition-colors duration-150 hover:border-border"
            data-brand-icon-id="moss"
          >
            <MossLogoMark
              {...(pinwheelHovered ? { activity: "thinking" as const } : {})}
              className="size-5.5"
            />
          </span>
          <div className="min-w-0">
            <h2 className="text-ui-lg font-medium text-foreground">
              {isZh ? "Moss 官方服务" : "Moss Managed Service"}
            </h2>
            <p className="mt-0.5 text-ui-sm text-muted-foreground">{accountDescription}</p>
          </div>
        </div>

        <div className="shrink-0">
          {accountState === "signed-out" ? (
            <Button
              type="button"
              size="sm"
              shape="capsule"
              className="transition-transform duration-120 active:scale-[0.98] motion-reduce:transition-none"
              onClick={() => {
                closeSettings();
                appHistory.push("/login");
              }}
            >
              {t("settings.providers.accounts.signInMoss")}
            </Button>
          ) : accountStatusLabel ? (
            <span className="inline-flex items-center gap-1.5 text-ui-sm text-muted-foreground">
              {accountState === "connected" ? (
                <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              ) : null}
              <span>{accountStatusLabel}</span>
            </span>
          ) : null}
        </div>
      </div>

      <SettingsSectionShell
        title={isZh ? "默认使用 Moss" : "Routed via Moss"}
        action={
          <span className="text-ui-xs text-muted-foreground tabular-nums">
            {mossRoutedClis.length} / {props.activeCliProviders.length}
          </span>
        }
      >
        <SettingsCard divided={false} className="p-2">
          {mossRoutedClis.length > 0 ? (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {mossRoutedClis.map((driver) => (
                <Button
                  key={driver}
                  type="button"
                  variant="ghost"
                  className="group h-9 w-full justify-between gap-2 rounded-row px-2.5 text-left font-normal text-foreground transition-[background-color,transform] duration-150 ease-snap hover:bg-foreground/[0.045] active:scale-[0.98] motion-reduce:transition-none"
                  onClick={() => props.onSelectCli(driver)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderBrandTile
                      variant="bare"
                      iconId={cliBrandIconId(driver)}
                      cliProvider={driver}
                      size="sm"
                      className="transition-transform duration-150 group-hover:scale-105 motion-reduce:transition-none"
                    />
                    <span className="truncate text-ui">{PROVIDER_DISPLAY_NAMES[driver]}</span>
                  </span>
                  <ChevronRightIcon className="size-3.5 shrink-0 -translate-x-0.5 text-muted-foreground/70 opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transition-none" />
                </Button>
              ))}
            </div>
          ) : (
            <p className="px-2.5 py-2 text-ui-sm text-muted-foreground">
              {isZh
                ? "当前智能体均已切换为自定义服务商或本机账号"
                : "All agents currently use custom providers or local accounts"}
            </p>
          )}
        </SettingsCard>
      </SettingsSectionShell>

      {props.unifiedProviders.length === 0 && props.onAddUnifiedProvider ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            shape="capsule"
            className="text-muted-foreground hover:text-foreground"
            onClick={props.onAddUnifiedProvider}
          >
            <PlusIcon className="size-3.5" />
            {isZh ? "添加自定义服务商" : "Add custom provider"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
