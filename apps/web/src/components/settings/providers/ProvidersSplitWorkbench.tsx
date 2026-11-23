import type {
  ProviderKind,
  ServerProviderStatus,
  UnifiedModelProviderConfig,
} from "@moss/contracts";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { ProviderBrandTile } from "~/components/ProviderBrandIcons";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PlusIcon, RefreshCwIcon, SlidersIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
  SETTINGS_SECTION_LABEL_CLASS_NAME,
} from "~/settingsPanelStyles";
import {
  SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
  SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME,
  SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME,
  SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
  SETTINGS_SIDEBAR_SECTION_CLASS_NAME,
} from "~/settingsSidebarNavStyles";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";
import {
  cliBrandIconId,
  type ProviderWorkbenchSelection,
  resolveEffectiveCliSourceUi,
} from "./providerWorkbenchTypes";

export interface SplitWorkbenchCliOption {
  readonly provider: ProviderKind;
  readonly title: string;
  readonly setupDocsHref: string;
}

const RAIL_PILL_EASE = [0.32, 0.72, 0, 1] as const;

function selectionSurfaceKey(selection: ProviderWorkbenchSelection): string {
  if (selection.kind === "unified") return `unified:${selection.id}`;
  if (selection.kind === "cli") return `cli:${selection.provider}`;
  return selection.kind;
}

function RailNavButton({
  selected,
  onClick,
  className,
  children,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <Button
      type="button"
      variant="ghost"
      aria-current={selected ? "page" : undefined}
      className={cn(
        SETTINGS_SIDEBAR_ITEM_CLASS_NAME,
        "relative justify-start font-normal transition-[background-color,color,transform] duration-120 active:scale-[0.99] motion-reduce:transition-none",
        selected
          ? "text-[var(--sidebar-accent-foreground)] hover:bg-transparent hover:text-[var(--sidebar-accent-foreground)]"
          : SETTINGS_SIDEBAR_ROW_FILL_HOVER_CLASS_NAME,
        className,
      )}
      onClick={onClick}
    >
      {selected ? (
        <motion.span
          layoutId="providers-rail-active-pill"
          aria-hidden="true"
          transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: RAIL_PILL_EASE }}
          className="pointer-events-none absolute inset-0 rounded-row bg-[var(--sidebar-selected)]"
        />
      ) : null}
      <span className="relative z-10 flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </Button>
  );
}

export function ProvidersSplitWorkbench(props: {
  readonly selection: ProviderWorkbenchSelection;
  readonly onSelect: (selection: ProviderWorkbenchSelection) => void;
  readonly unifiedProviders: ReadonlyArray<UnifiedModelProviderConfig>;
  readonly defaultUnifiedProviderId: string | null | undefined;
  readonly unifiedProviderByCli: Readonly<Record<string, string>> | undefined;
  readonly enabledCliOptions: ReadonlyArray<SplitWorkbenchCliOption>;
  readonly disabledCliOptions: ReadonlyArray<SplitWorkbenchCliOption>;
  readonly disabledOpen: boolean;
  readonly onDisabledOpenChange: (open: boolean) => void;
  readonly providerStatusByProvider: ReadonlyMap<ProviderKind, ServerProviderStatus>;
  readonly statusReconciled: boolean;
  readonly refreshingProviders: boolean;
  readonly onRefreshProviders: () => void;
  readonly onOpenAddProvider: () => void;
  readonly children: ReactNode;
}) {
  const { locale } = useTranslation();
  const isZh = locale === "zh-CN";

  const unifiedNameById = new Map(
    props.unifiedProviders.map((item) => [item.id, item.name] as const),
  );

  const refreshLabel = props.refreshingProviders
    ? isZh
      ? "正在检查…"
      : "Checking setup"
    : isZh
      ? "刷新状态"
      : "Refresh status";

  const cliRowTrail = (
    driver: ProviderKind,
  ): { kind: "route"; text: string } | { kind: "update" } | null => {
    const source = resolveEffectiveCliSourceUi({
      defaultUnifiedProviderId: props.defaultUnifiedProviderId,
      unifiedProviderByCli: props.unifiedProviderByCli,
      provider: driver,
    });
    if (source !== "moss" && source !== "personal") {
      const targetName = unifiedNameById.get(source);
      if (targetName) {
        return { kind: "route", text: `→ ${targetName}` };
      }
    }
    const status = props.providerStatusByProvider.get(driver);
    if (status?.versionAdvisory?.status === "behind_latest") {
      return { kind: "update" };
    }
    return null;
  };

  return (
    <div
      className={cn(
        SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
        "flex min-h-0 flex-1 flex-col overflow-hidden",
      )}
      data-testid="providers-split-workbench"
    >
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/50 px-7 pt-5 pb-3.5">
        <h1 className={PAGE_TITLE_CLASS_NAME}>{isZh ? "服务与智能体" : "Providers & Agents"}</h1>

        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground transition-transform duration-120 active:scale-95 motion-reduce:transition-none"
                  disabled={props.refreshingProviders}
                  aria-label={refreshLabel}
                  onClick={props.onRefreshProviders}
                >
                  <RefreshCwIcon
                    className={cn(
                      "size-4 transition-transform duration-200",
                      props.refreshingProviders && "animate-spin",
                    )}
                  />
                </Button>
              }
            />
            <TooltipPopup side="bottom">{refreshLabel}</TooltipPopup>
          </Tooltip>

          <Button
            type="button"
            variant="outline"
            size="sm"
            shape="capsule"
            className="transition-transform duration-120 active:scale-[0.98] motion-reduce:transition-none"
            onClick={props.onOpenAddProvider}
          >
            <PlusIcon className="size-3.5" />
            {isZh ? "添加服务商" : "Add provider"}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          aria-label={isZh ? "服务商与智能体导航" : "Providers and agents navigation"}
          className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-border/50 px-2.5 py-3"
        >
          <section className={SETTINGS_SIDEBAR_SECTION_CLASS_NAME}>
            <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>
              {isZh ? "模型服务商" : "Model providers"}
            </h2>
            <div className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
              <RailNavButton
                selected={props.selection.kind === "moss"}
                onClick={() => props.onSelect({ kind: "moss" })}
              >
                <ProviderBrandTile variant="bare" iconId="moss" size="sm" />
                <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
                  {isZh ? "Moss 官方服务" : "Moss Service"}
                </span>
              </RailNavButton>

              {props.unifiedProviders.map((provider) => {
                const selected =
                  props.selection.kind === "unified" && props.selection.id === provider.id;
                return (
                  <RailNavButton
                    key={provider.id}
                    selected={selected}
                    className={!provider.enabled ? "opacity-60" : undefined}
                    onClick={() => props.onSelect({ kind: "unified", id: provider.id })}
                  >
                    <ProviderBrandTile variant="bare" iconId={provider.iconId} size="sm" />
                    <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>{provider.name}</span>
                    {provider.apiKeyConfigured ? (
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-success/80"
                      />
                    ) : null}
                  </RailNavButton>
                );
              })}
            </div>
          </section>

          <section className={SETTINGS_SIDEBAR_SECTION_CLASS_NAME}>
            <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>
              {isZh ? "编码 CLI 智能体" : "Coding CLIs"}
            </h2>
            <div className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
              {props.enabledCliOptions.map((option) => {
                const selected =
                  props.selection.kind === "cli" && props.selection.provider === option.provider;
                const status = props.providerStatusByProvider.get(option.provider);
                const unavailable = Boolean(props.statusReconciled && status && !status.available);
                const trail = cliRowTrail(option.provider);
                return (
                  <RailNavButton
                    key={option.provider}
                    selected={selected}
                    onClick={() => props.onSelect({ kind: "cli", provider: option.provider })}
                  >
                    <ProviderBrandTile
                      variant="bare"
                      iconId={cliBrandIconId(option.provider)}
                      cliProvider={option.provider}
                      size="sm"
                    />
                    <span
                      className={cn(
                        SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME,
                        unavailable && !selected && "text-muted-foreground",
                      )}
                    >
                      {option.title}
                    </span>
                    {trail?.kind === "route" ? (
                      <span className="max-w-20 shrink-0 truncate text-ui-xs text-muted-foreground">
                        {trail.text}
                      </span>
                    ) : trail?.kind === "update" ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span
                              className="relative flex size-2.5 shrink-0 items-center justify-center"
                              aria-label={isZh ? "有新版本可更新" : "Update available"}
                            >
                              <span
                                aria-hidden="true"
                                className="absolute inline-flex size-2 animate-ping rounded-full bg-info/45 motion-reduce:animate-none"
                              />
                              <span
                                aria-hidden="true"
                                className="relative inline-flex size-1.5 rounded-full bg-info"
                              />
                            </span>
                          }
                        />
                        <TooltipPopup side="right">
                          {isZh ? "有新版本可更新" : "Update available"}
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </RailNavButton>
                );
              })}

              {props.disabledCliOptions.length > 0 ? (
                <Collapsible open={props.disabledOpen} onOpenChange={props.onDisabledOpenChange}>
                  <CollapsibleTrigger className="mt-1 flex w-full items-center gap-1.5 px-2 py-1 text-left text-ui-xs text-muted-foreground transition-colors hover:text-foreground">
                    <DisclosureChevron open={props.disabledOpen} className="size-3.5 shrink-0" />
                    <span>
                      {isZh
                        ? `已停用 (${props.disabledCliOptions.length})`
                        : `Disabled providers (${props.disabledCliOptions.length})`}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div
                      className={cn("flex flex-col pt-0.5", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}
                    >
                      {props.disabledCliOptions.map((option) => {
                        const selected =
                          props.selection.kind === "cli" &&
                          props.selection.provider === option.provider;
                        return (
                          <RailNavButton
                            key={option.provider}
                            selected={selected}
                            className={selected ? "opacity-100" : "opacity-65"}
                            onClick={() =>
                              props.onSelect({ kind: "cli", provider: option.provider })
                            }
                          >
                            <ProviderBrandTile
                              variant="bare"
                              iconId={cliBrandIconId(option.provider)}
                              cliProvider={option.provider}
                              size="sm"
                            />
                            <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
                              {option.title}
                            </span>
                          </RailNavButton>
                        );
                      })}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              ) : null}
            </div>
          </section>

          <section className={SETTINGS_SIDEBAR_SECTION_CLASS_NAME}>
            <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>{isZh ? "通用" : "General"}</h2>
            <div className={cn("flex flex-col", SETTINGS_SIDEBAR_LIST_GAP_CLASS_NAME)}>
              <RailNavButton
                selected={props.selection.kind === "preferences"}
                onClick={() => props.onSelect({ kind: "preferences" })}
              >
                <SlidersIcon className="size-4 shrink-0 text-inherit" />
                <span className={SETTINGS_SIDEBAR_ITEM_LABEL_CLASS_NAME}>
                  {isZh ? "偏好与默认设置" : "Preferences & defaults"}
                </span>
              </RailNavButton>
            </div>
          </section>
        </aside>

        <section
          aria-label={isZh ? "服务商详情配置" : "Provider configuration detail"}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-7 py-5"
        >
          <div
            key={selectionSurfaceKey(props.selection)}
            className="mx-auto max-w-xl sidebar-surface-enter"
          >
            {props.children}
          </div>
        </section>
      </div>
    </div>
  );
}
