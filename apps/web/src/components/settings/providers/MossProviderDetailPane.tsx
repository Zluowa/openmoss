import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type UnifiedModelProviderConfig,
} from "@moss/contracts";
import { MOSS_SERVER_AUTHORIZED_CLI_DRIVERS } from "@moss/shared/providerInstances";
import { useState } from "react";
import { appHistory } from "~/appNavigation";
import { useMossAccountGatewayState } from "~/components/auth/useMossGatewayUnreachable";
import { MossLogoMark } from "~/components/MossLogoMark";
import { ProviderBrandTile } from "~/components/ProviderBrandIcons";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { CheckIcon, PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { closeSettings } from "~/settingsDialogStore";
import { SettingsCard, SettingsSectionShell } from "../SettingsPanelPrimitives";
import { cliBrandIconId } from "./providerWorkbenchTypes";

export function MossProviderDetailPane(props: {
  readonly activeCliProviders: ReadonlyArray<ProviderKind>;
  readonly unifiedProviders: ReadonlyArray<UnifiedModelProviderConfig>;
  readonly defaultUnifiedProviderId: string | null | undefined;
  readonly unifiedProviderByCli: Readonly<Record<string, string>> | undefined;
  readonly mossCliModelAuthEnabled: boolean;
  readonly mossCliModelAuthDisabledProviders: ReadonlyArray<ProviderKind>;
  readonly onToggleMossCliModelAuth: (enabled: boolean) => void;
  readonly onToggleMossCliProviderAuth: (provider: ProviderKind, allowed: boolean) => void;
  readonly onSetAllMossCliProvidersAuth: (allowAll: boolean) => void;
  readonly onSelectCli: (provider: ProviderKind) => void;
  readonly onAddUnifiedProvider?: () => void;
}) {
  const { locale, t } = useTranslation();
  const isZh = locale === "zh-CN";
  const accountState = useMossAccountGatewayState();
  const [pinwheelHovered, setPinwheelHovered] = useState(false);

  const activeSet = new Set(props.activeCliProviders);
  const authorizedDrivers = MOSS_SERVER_AUTHORIZED_CLI_DRIVERS.filter((driver) =>
    activeSet.has(driver),
  );
  const disabledSet = new Set(props.mossCliModelAuthDisabledProviders);
  const allowedCount = authorizedDrivers.filter((driver) => !disabledSet.has(driver)).length;
  const allAllowed = authorizedDrivers.length > 0 && allowedCount === authorizedDrivers.length;
  const noneAllowed = allowedCount === 0;

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
        title={isZh ? "服务端授权 CLI" : "CLI Model Access"}
        action={
          <div className="flex items-center gap-1.5">
            {props.mossCliModelAuthEnabled ? (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={allAllowed}
                  className="h-6 px-2 text-ui-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => props.onSetAllMossCliProvidersAuth(true)}
                >
                  {isZh ? "全开" : "All on"}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={noneAllowed}
                  className="h-6 px-2 text-ui-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => props.onSetAllMossCliProvidersAuth(false)}
                >
                  {isZh ? "全关" : "All off"}
                </Button>
              </>
            ) : null}
            <span className="text-ui-xs text-muted-foreground tabular-nums">
              {props.mossCliModelAuthEnabled
                ? `${allowedCount} / ${authorizedDrivers.length}`
                : isZh
                  ? "已关闭"
                  : "Off"}
            </span>
          </div>
        }
      >
        <SettingsCard divided={false} className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-3.5 py-3">
            <div className="min-w-0">
              <div className="text-ui font-medium text-foreground">
                {isZh ? "允许 CLI 使用 Moss 模型" : "Allow CLIs to use Moss models"}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-ui-xs text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full transition-colors duration-150 motion-reduce:transition-none",
                    props.mossCliModelAuthEnabled ? "bg-success" : "bg-muted-foreground/45",
                  )}
                />
                <span>
                  {props.mossCliModelAuthEnabled
                    ? isZh
                      ? "已开启"
                      : "Enabled"
                    : isZh
                      ? "已关闭"
                      : "Disabled"}
                </span>
              </div>
            </div>
            <Switch
              checked={props.mossCliModelAuthEnabled}
              onCheckedChange={(checked) => props.onToggleMossCliModelAuth(Boolean(checked))}
              aria-label={isZh ? "允许 CLI 使用 Moss 模型" : "Allow CLIs to use Moss models"}
            />
          </div>

          <div
            className={cn(
              "border-t border-border/50 p-2 transition-opacity duration-150 motion-reduce:transition-none",
              !props.mossCliModelAuthEnabled && "opacity-50",
            )}
          >
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {authorizedDrivers.map((driver) => {
                const allowed = !disabledSet.has(driver);
                const effectiveAllowed = props.mossCliModelAuthEnabled && allowed;
                return (
                  <Button
                    key={driver}
                    type="button"
                    role="switch"
                    aria-checked={effectiveAllowed}
                    aria-label={
                      isZh
                        ? `允许 ${PROVIDER_DISPLAY_NAMES[driver]} 使用 Moss 模型`
                        : `Allow ${PROVIDER_DISPLAY_NAMES[driver]} to use Moss models`
                    }
                    data-moss-cli-auth-toggle={driver}
                    disabled={!props.mossCliModelAuthEnabled}
                    variant="ghost"
                    onClick={() => props.onToggleMossCliProviderAuth(driver, !allowed)}
                    className={cn(
                      "h-9 w-full justify-between gap-2 rounded-row px-2.5 text-left font-normal transition-[background-color,color,transform] duration-150 ease-snap active:scale-[0.98] motion-reduce:transition-none",
                      effectiveAllowed
                        ? "bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.09]"
                        : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ProviderBrandTile
                        variant="bare"
                        iconId={cliBrandIconId(driver)}
                        cliProvider={driver}
                        size="sm"
                      />
                      <span className="truncate text-ui">{PROVIDER_DISPLAY_NAMES[driver]}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "inline-flex size-4 shrink-0 items-center justify-center rounded-full border transition-[background-color,border-color,transform] duration-150 motion-reduce:transition-none",
                        effectiveAllowed
                          ? "scale-100 border-transparent bg-success text-background"
                          : "scale-90 border-border/80 bg-transparent",
                      )}
                    >
                      {effectiveAllowed ? <CheckIcon className="size-2.5" /> : null}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
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
