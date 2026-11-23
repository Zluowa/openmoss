import type {
  ProviderKind,
  ServerProviderStatus,
  UnifiedModelProviderConfig,
} from "@moss/contracts";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { ProviderBrandTile } from "~/components/ProviderBrandIcons";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { SelectItem } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { agentSettingsAnchorId } from "~/lib/agentInstall";
import { supportsAgentSignIn } from "~/lib/agentSignIn";
import { ExternalLinkIcon, SlidersIcon } from "~/lib/icons";
import { resolveAgentReadiness } from "~/lib/providerAvailability";
import {
  PROVIDER_READINESS_LABEL_KEY,
  providerReadinessDescriptionKey,
} from "~/lib/providerReadinessCopy";
import { providerSetupStatusLabel } from "~/lib/providerSetupStatus";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  installedVersionLabel,
  isProviderLatestVersionKnowable,
  isProviderUpdateActive,
  shouldOfferProviderUpdateAction,
  shouldPromptProviderUpdate,
} from "~/providerUpdates";
import { AgentInstallButton } from "../AgentInstallButton";
import { AgentSignInButton } from "../AgentSignInButton";
import { SettingResetButton, SettingsSelectControl } from "../SettingControls";
import { SettingsCard, SettingsRow, SettingsSection } from "../SettingsPanelPrimitives";
import { cliBrandIconId } from "./providerWorkbenchTypes";

const SOURCE_PILL_EASE = [0.32, 0.72, 0, 1] as const;

export function CliAgentDetailPane(props: {
  readonly provider: ProviderKind;
  readonly title: string;
  readonly setupDocsHref: string;
  readonly enabled: boolean;
  readonly isHidden: boolean;
  readonly statusReconciled: boolean;
  readonly providerStatus: ServerProviderStatus | undefined;
  readonly servedByMoss: boolean;
  readonly supportsMossAuth: boolean;
  readonly mossAuthorized: boolean;
  readonly isInstalled: boolean;
  readonly updating: boolean;
  readonly checksEnabled: boolean;
  readonly showProviderUpdateStatus: boolean;
  readonly updateStatusLabel: string | null;
  readonly routingSource: string;
  readonly unifiedProviders: ReadonlyArray<UnifiedModelProviderConfig>;
  readonly advancedOpen: boolean;
  readonly installFieldsDirty: boolean;
  readonly enablementPending: boolean;
  readonly enablementDisabled: boolean;
  readonly onAdvancedOpenChange: (open: boolean) => void;
  readonly onRouteChange: (source: string) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onToggleHidden: (hidden: boolean) => void;
  readonly onOpenInstallation: () => void;
  readonly onOpenGuide: () => void;
  readonly onResetProvider: () => void;
  readonly renderUpdateAction: (status: ServerProviderStatus, active: boolean) => ReactNode;
  readonly renderInstallCommandCard: () => ReactNode;
  readonly renderAccountsControl: () => ReactNode;
}) {
  const { locale, t, format } = useTranslation();
  const isZh = locale === "zh-CN";
  const reducedMotion = useReducedMotion();
  const providerStatus = props.providerStatus;
  const readiness =
    props.enabled && props.statusReconciled && providerStatus
      ? resolveAgentReadiness(providerStatus)
      : null;
  const servedByMoss =
    props.supportsMossAuth &&
    props.mossAuthorized &&
    readiness?.state === "needsLogin" &&
    props.servedByMoss;
  const descriptionKey = readiness ? providerReadinessDescriptionKey(readiness) : null;
  const canSignIn =
    readiness?.state === "needsLogin" && supportsAgentSignIn(props.provider, providerStatus);
  const showGuide =
    readiness?.state === "error" || (readiness?.state === "needsLogin" && !canSignIn);

  const updateAdvisory = providerStatus?.versionAdvisory;
  const updateActive = Boolean(
    (providerStatus && isProviderUpdateActive(providerStatus)) || props.updating,
  );
  const showUpdateButton = providerStatus
    ? shouldPromptProviderUpdate(providerStatus) &&
      (props.showProviderUpdateStatus || updateAdvisory?.status === "unknown")
    : false;
  const showSelfManagedUpdate = providerStatus
    ? shouldOfferProviderUpdateAction(providerStatus) &&
      !isProviderLatestVersionKnowable(providerStatus)
    : false;
  const isDesktopBundledHint =
    Boolean(providerStatus?.available) &&
    Boolean(updateAdvisory) &&
    !updateAdvisory?.canUpdate &&
    updateAdvisory?.latestVersionKnowable === true;

  const statusText = servedByMoss
    ? [
        t("settings.providers.accounts.connectedViaMoss"),
        t("chat.modelPicker.source.local"),
        t("settings.usage.status.notSignedIn"),
      ].join(" · ")
    : readiness
      ? descriptionKey
        ? format(descriptionKey, { provider: props.title })
        : t(PROVIDER_READINESS_LABEL_KEY[readiness.state])
      : providerSetupStatusLabel({
          status: providerStatus,
          reconciled: props.statusReconciled,
          disabled: !props.enabled,
        });

  const enabledUnifiedProviders = props.unifiedProviders.filter((item) => item.enabled);
  const selectedUnified = enabledUnifiedProviders.find((item) => item.id === props.routingSource);
  const effectiveSourceId = selectedUnified
    ? selectedUnified.id
    : props.routingSource === "personal" || !props.supportsMossAuth
      ? "personal"
      : "moss";

  const currentVersionLabel = providerStatus
    ? installedVersionLabel(providerStatus, props.checksEnabled)
    : null;
  const showBehindNotice =
    props.showProviderUpdateStatus && updateAdvisory?.status === "behind_latest";

  const selectedSourceContent =
    effectiveSourceId === "personal" ? (
      <span className="truncate">{isZh ? "本机" : "Local account"}</span>
    ) : selectedUnified ? (
      <span className="flex min-w-0 items-center gap-2">
        <ProviderBrandTile variant="bare" iconId={selectedUnified.iconId} size="sm" />
        <span className="truncate">{selectedUnified.name}</span>
      </span>
    ) : (
      <span className="flex min-w-0 items-center gap-2">
        <ProviderBrandTile variant="bare" iconId="moss" size="sm" />
        <span className="truncate">
          {!props.mossAuthorized
            ? isZh
              ? "Moss · 已关闭"
              : "Moss · Off"
            : isZh
              ? "Moss 托管"
              : "Moss"}
        </span>
      </span>
    );

  const segmentedOptions = [
    ...(props.supportsMossAuth
      ? [
          {
            id: "moss",
            label: isZh ? "Moss" : "Moss",
            iconId: "moss" as string | null,
            disabled: !props.mossAuthorized,
          },
        ]
      : []),
    { id: "personal", label: isZh ? "本机" : "Local", iconId: null, disabled: false },
    ...enabledUnifiedProviders.map((item) => ({
      id: item.id,
      label: item.name,
      iconId: item.iconId as string | null,
      disabled: false,
    })),
  ];

  const installCommandNode = props.renderInstallCommandCard();

  const statusDotClass = !props.enabled
    ? "bg-muted-foreground/35"
    : readiness?.state === "ready"
      ? "bg-success"
      : readiness?.state === "needsLogin"
        ? "bg-warning"
        : "bg-muted-foreground/45";

  return (
    <div className="space-y-6" id={agentSettingsAnchorId(props.provider)}>
      <div
        className="flex flex-wrap items-center justify-between gap-4 pb-1"
        data-slot="settings-row"
      >
        <div className="flex min-w-0 items-center gap-3.5">
          <ProviderBrandTile
            variant="tile"
            iconId={cliBrandIconId(props.provider)}
            cliProvider={props.provider}
            size="md"
            active={props.enabled}
          />
          <div className="min-w-0">
            <ProviderIcon provider={props.provider} className="sr-only" />
            <h2 className="text-ui-lg font-medium text-foreground">{props.title}</h2>
            <p
              className="mt-0.5 flex items-center gap-1.5 text-ui-sm text-muted-foreground"
              data-agent-readiness={servedByMoss ? "moss" : (readiness?.state ?? "unknown")}
            >
              <span
                aria-hidden="true"
                className={cn("size-1.5 shrink-0 rounded-full", statusDotClass)}
              />
              <span>{statusText}</span>
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {props.isInstalled ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground transition-transform duration-120 active:scale-95 motion-reduce:transition-none"
                    onClick={props.onOpenInstallation}
                    aria-label={format("settings.providers.installation.title", {
                      provider: props.title,
                    })}
                  >
                    <SlidersIcon className="size-4" />
                  </Button>
                }
              />
              <TooltipPopup side="top">{t("settings.providers.installation.manage")}</TooltipPopup>
            </Tooltip>
          ) : null}
          {readiness?.state === "notInstalled" ? (
            <AgentInstallButton
              provider={props.provider}
              providerLabel={props.title}
              readiness={readiness}
              status={providerStatus}
              fallbackUrl={props.setupDocsHref}
            />
          ) : null}
          {canSignIn ? (
            <AgentSignInButton
              provider={props.provider}
              providerLabel={props.title}
              status={providerStatus}
              {...(servedByMoss ? { variant: "outline" as const } : {})}
            />
          ) : null}
          {showGuide ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={props.onOpenGuide}
              aria-label={format("settings.providers.setupGuideAria", { provider: props.title })}
            >
              {t("settings.providers.setupGuide")}
              <ExternalLinkIcon className="size-3" />
            </Button>
          ) : null}
          <Switch
            checked={props.enabled}
            className={props.enablementPending ? "data-disabled:cursor-progress" : undefined}
            aria-busy={props.enablementPending}
            disabled={props.enablementDisabled}
            onCheckedChange={(checked) => props.onToggleEnabled(Boolean(checked))}
            aria-label={`${props.enabled ? "Disable" : "Enable"} ${props.title}`}
          />
        </div>
      </div>

      <SettingsSection title={isZh ? "配置与状态" : "Configuration"}>
        <SettingsRow
          title={isZh ? "模型来源" : "Model source"}
          control={
            enabledUnifiedProviders.length <= 2 ? (
              <div
                role="group"
                aria-label={isZh ? `${props.title} 模型来源` : `${props.title} model source`}
                className="inline-flex flex-wrap items-center gap-0.5 rounded-control bg-foreground/[0.045] p-0.5"
              >
                {segmentedOptions.map((option) => {
                  const active = effectiveSourceId === option.id;
                  const button = (
                    <Button
                      key={option.id}
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={option.disabled}
                      aria-pressed={active && !option.disabled}
                      onClick={() => props.onRouteChange(option.id)}
                      className={cn(
                        "relative h-7 rounded-control px-2.5 font-normal transition-colors duration-150",
                        option.disabled
                          ? "cursor-not-allowed opacity-50 text-muted-foreground"
                          : active
                            ? "text-foreground hover:bg-transparent"
                            : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {active ? (
                        <motion.span
                          layoutId={`cli-source-pill-${props.provider}`}
                          aria-hidden="true"
                          transition={
                            reducedMotion
                              ? { duration: 0 }
                              : { duration: 0.16, ease: SOURCE_PILL_EASE }
                          }
                          className={cn(
                            "pointer-events-none absolute inset-0 rounded-control border shadow-xs",
                            option.disabled
                              ? "border-border/40 bg-background/50"
                              : "border-border/65 bg-background",
                          )}
                        />
                      ) : null}
                      <span className="relative z-10 flex items-center gap-1.5">
                        {option.iconId ? (
                          <ProviderBrandTile variant="bare" iconId={option.iconId} size="sm" />
                        ) : null}
                        <span className="max-w-24 truncate">{option.label}</span>
                      </span>
                    </Button>
                  );
                  if (!option.disabled) return button;
                  return (
                    <Tooltip key={option.id}>
                      <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
                      <TooltipPopup side="top">
                        {isZh ? "已在 Moss 官方服务中关闭授权" : "Disabled in Moss Managed Service"}
                      </TooltipPopup>
                    </Tooltip>
                  );
                })}
              </div>
            ) : (
              <SettingsSelectControl
                value={effectiveSourceId}
                onValueChange={(value) => {
                  if (value) props.onRouteChange(value);
                }}
                ariaLabel={isZh ? `${props.title} 模型来源` : `${props.title} model source`}
                triggerClassName="min-w-44"
                valueContent={selectedSourceContent}
              >
                {props.supportsMossAuth ? (
                  <SelectItem hideIndicator value="moss" disabled={!props.mossAuthorized}>
                    <span className="flex items-center gap-2">
                      <ProviderBrandTile variant="bare" iconId="moss" size="sm" />
                      <span>
                        {props.mossAuthorized
                          ? isZh
                            ? "Moss 托管"
                            : "Moss"
                          : isZh
                            ? "Moss · 已关闭"
                            : "Moss · Disabled"}
                      </span>
                    </span>
                  </SelectItem>
                ) : null}
                <SelectItem hideIndicator value="personal">
                  <span>{isZh ? "本机" : "Local account"}</span>
                </SelectItem>
                {enabledUnifiedProviders.map((item) => (
                  <SelectItem hideIndicator key={item.id} value={item.id}>
                    <span className="flex items-center gap-2">
                      <ProviderBrandTile variant="bare" iconId={item.iconId} size="sm" />
                      <span className="truncate">{item.name}</span>
                    </span>
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            )
          }
        />

        <SettingsRow
          title={isZh ? "版本" : "Version"}
          description={
            props.updateStatusLabel ||
            currentVersionLabel ||
            (isZh ? "未检测到本地版本" : "No local version detected")
          }
          control={
            (showUpdateButton || showSelfManagedUpdate) && providerStatus ? (
              props.renderUpdateAction(providerStatus, updateActive)
            ) : isDesktopBundledHint ? (
              <span className="text-ui-sm text-muted-foreground">
                {isZh ? "由桌面应用更新" : "Managed by Desktop app"}
              </span>
            ) : showBehindNotice ? (
              <span className="text-ui-sm text-muted-foreground">
                {isZh ? "需手动更新" : "Manual update"}
              </span>
            ) : null
          }
        >
          {installCommandNode ? <div className="mt-2.5">{installCommandNode}</div> : null}
        </SettingsRow>

        {providerStatus?.available ? (
          <SettingsRow
            title={isZh ? "在模型菜单显示" : "Show in model picker"}
            control={
              <Switch
                checked={!props.isHidden}
                onCheckedChange={(checked) => props.onToggleHidden(!checked)}
                aria-label={`Show ${props.title} in the provider picker`}
              />
            }
          />
        ) : null}
      </SettingsSection>

      <Collapsible open={props.advancedOpen} onOpenChange={props.onAdvancedOpenChange}>
        <div className="border-t border-border/50 pt-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-ui-sm font-normal text-muted-foreground transition-colors hover:text-foreground">
              <DisclosureChevron open={props.advancedOpen} className="size-3.5 shrink-0" />
              <span>{isZh ? "高级设置与账号配置" : "Advanced settings & accounts"}</span>
            </CollapsibleTrigger>
            {props.installFieldsDirty ? (
              <SettingResetButton label={props.title} onClick={props.onResetProvider} />
            ) : null}
          </div>
          <CollapsiblePanel>
            {props.advancedOpen ? (
              <SettingsCard divided={false} className="mt-3 p-4">
                {props.renderAccountsControl()}
              </SettingsCard>
            ) : null}
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </div>
  );
}
