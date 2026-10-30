// FILE: ComposerModelPickerTabs.tsx
// Purpose: Source row of the composer model picker — the provider serving the listed
//   models (Moss, a local CLI sign-in, an API key, another agent), opened into every
//   source the user can switch to, starred presets, and a way to manage models.
// Layer: Chat composer presentation
// Depends on: provider icons/availability helpers, account-source kinds, menu primitives.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { useState } from "react";

import { SettingsIcon, StarFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";
import { MossLogo } from "../MossLogo";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { ProviderAccountDot } from "../ProviderAccountMark";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "../ui/menu";
import { type ComposerModelPickerTab, STARRED_TAB } from "./ComposerModelPicker.logic";
import { ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
  isMossManagedSourceInstanceId,
  resolveComposerAccountSourceKind,
} from "./providerAccountSources";
import {
  composerSourceSortOrder,
  findProviderStatusForInstance,
  type ProviderModelPickerInstance,
  resolveLiveProviderAvailability,
} from "./ProviderModelPicker";

export type ComposerModelPickerProviderTab = {
  provider: ProviderKind;
  /** Account the tab lists models for; a default account shares the provider id. */
  instanceId: ProviderInstanceId;
  label: string;
  /** Account name written beside the icon of the open tab; null while the provider has
   *  one account and its icon says it all. */
  name: string | null;
  /** A second account of its provider: its icon is dotted to differ from the default. */
  dotted: boolean;
  accentColor?: string | undefined;
  /** Tooltip sentence explaining why the account cannot run right now; null when it can. */
  unavailableLabel: string | null;
  /** The tab cannot be opened at all (another account's thread, status still loading). */
  blocked: boolean;
  /** Shown in place of the model list when the account still has to be signed in or fixed. */
  setupMessage: string | null;
};

// Why an enabled account cannot run, phrased for its tab tooltip.
function describeUnavailableAccount(label: string, status: ServerProviderStatus): string {
  const reason =
    status.status === "error" || !status.available
      ? "Unavailable"
      : status.status === "warning"
        ? "Limited"
        : "Not ready";
  return [`${label} — ${reason}.`, status.message?.trim()].filter(Boolean).join(" ");
}

function resolveAccountTabState(input: {
  label: string;
  status: ServerProviderStatus | undefined;
  lockedToSibling: boolean;
}): Pick<ComposerModelPickerProviderTab, "unavailableLabel" | "blocked" | "setupMessage"> {
  const { label, status } = input;
  if (input.lockedToSibling) {
    return {
      unavailableLabel: `${label} is unavailable in this thread. Start a new thread to switch accounts.`,
      blocked: true,
      setupMessage: null,
    };
  }
  if (!resolveLiveProviderAvailability(status).disabled) {
    return { unavailableLabel: null, blocked: false, setupMessage: null };
  }
  if (!status) {
    return { unavailableLabel: `${label} — Checking.`, blocked: true, setupMessage: null };
  }
  return {
    unavailableLabel: describeUnavailableAccount(label, status),
    blocked: false,
    setupMessage:
      status.authStatus === "unauthenticated"
        ? "Open provider setup to sign in to this account."
        : (status.message?.trim() ?? `${label} is unavailable right now.`),
  };
}

// One tab per enabled account, so a second Codex or Claude account is as reachable as
// another provider. A started thread stays on its account: siblings are listed but closed.
// An account that still needs signing in stays openable and invites the user to set it up.
export function resolveComposerModelPickerProviderTabs(input: {
  options: ReadonlyArray<{ value: ProviderKind; label: string }>;
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance> | undefined;
  lockedInstanceId?: ProviderInstanceId | null | undefined;
  // Locks only this provider's sibling accounts; other providers stay pickable.
  lockedInstanceProvider?: ProviderKind | null | undefined;
}): ComposerModelPickerProviderTab[] {
  return input.options.flatMap((option) => {
    const knownAccounts = (input.providerInstances ?? []).filter(
      (instance) => instance.provider === option.value,
    );
    // Moss first, then the user's own sign-ins, then API keys: the order a new user
    // reaches them in, and the same order the rest of the composer uses.
    const accounts = knownAccounts
      .filter(
        (instance) =>
          instance.enabled &&
          findProviderStatusForInstance({
            providers: input.providers,
            provider: option.value,
            instanceId: instance.instanceId,
          })?.enabled !== false,
      )
      .toSorted((left, right) => composerSourceSortOrder(left) - composerSourceSortOrder(right));
    // A missing account list may still need a setup tab. An explicitly disabled
    // account must never be recreated as a default tab by that fallback.
    if (
      accounts.length === 0 &&
      (knownAccounts.length > 0 ||
        findProviderStatusForInstance({
          providers: input.providers,
          provider: option.value,
          instanceId: option.value,
        })?.enabled === false)
    ) {
      return [];
    }
    const hasSiblingAccounts = accounts.length > 1;
    const tabs =
      accounts.length > 0
        ? accounts.map((account) => ({
            instanceId: account.instanceId,
            label: hasSiblingAccounts
              ? providerAccountQualifiedLabel(option.label, account.label)
              : account.isDefault
                ? option.label
                : account.label,
            name: hasSiblingAccounts ? account.label : null,
            dotted: hasSiblingAccounts && !account.isDefault,
            accentColor: account.accentColor,
          }))
        : [
            {
              instanceId: option.value,
              label: option.label,
              name: null,
              dotted: false,
              accentColor: undefined,
            },
          ];
    return tabs.map((tab) => {
      const state = resolveAccountTabState({
        label: tab.label,
        status: findProviderStatusForInstance({
          providers: input.providers,
          provider: option.value,
          instanceId: tab.instanceId,
        }),
        lockedToSibling:
          input.lockedInstanceId != null &&
          tab.instanceId !== input.lockedInstanceId &&
          (input.lockedInstanceProvider == null || option.value === input.lockedInstanceProvider),
      });
      return {
        provider: option.value,
        instanceId: tab.instanceId,
        label: tab.label,
        name: tab.name,
        dotted: tab.dotted,
        accentColor: tab.accentColor,
        unavailableLabel: state.unavailableLabel,
        blocked: state.blocked,
        setupMessage: state.setupMessage,
      };
    });
  });
}

type SourcePresentation = {
  /** Provider name as the user knows it: "Moss" for every Moss-managed route. */
  title: string;
  /** The agent a Moss route runs on, or the account a sibling account is named. */
  detail: string | null;
  badge: string | null;
};

// Mirrors how service-provider switchers present a source: who serves the models
// ("Moss", "Codex", a custom profile) and how the user reaches it (their Moss
// account, a local CLI sign-in, an API key).
function presentSource(
  providerTab: ComposerModelPickerProviderTab,
  t: ReturnType<typeof useTranslation>["t"],
): SourcePresentation {
  const kind = resolveComposerAccountSourceKind({
    instanceId: providerTab.instanceId,
    provider: providerTab.provider,
  });
  if (kind === "moss") {
    return {
      title: "Moss",
      detail: PROVIDER_DISPLAY_NAMES[providerTab.provider],
      badge: t("chat.modelPicker.source.badge.moss"),
    };
  }
  return {
    title: providerTab.label,
    detail: null,
    badge: kind === "personal" ? t("chat.modelPicker.source.badge.personal") : null,
  };
}

function SourceMark(props: {
  providerTab: ComposerModelPickerProviderTab | null;
  dimmed?: boolean;
}) {
  const { providerTab } = props;
  if (providerTab === null) {
    return <StarFilledIcon aria-hidden="true" className="size-4 shrink-0 text-foreground" />;
  }
  if (isMossManagedSourceInstanceId(providerTab.instanceId)) {
    return <MossLogo className={cn("size-4", props.dimmed && "opacity-40")} />;
  }
  const TabIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[providerTab.provider];
  return (
    <span className="relative flex shrink-0">
      <TabIcon
        aria-hidden="true"
        className={cn("size-4 text-foreground", props.dimmed && "opacity-40")}
      />
      <ProviderAccountDot
        accentColor={providerTab.accentColor}
        always={providerTab.dotted}
        className="absolute -top-0.5 -right-0.5"
      />
    </span>
  );
}

function SourceBadge(props: { children: string }) {
  return (
    <span className="shrink-0 rounded-full bg-[var(--color-background-button-secondary-hover)] px-1.5 py-px text-ui-xs leading-normal font-medium text-muted-foreground">
      {props.children}
    </span>
  );
}

function SourceLabel(props: { source: SourcePresentation }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="truncate text-foreground">{props.source.title}</span>
      {props.source.badge ? <SourceBadge>{props.source.badge}</SourceBadge> : null}
      {props.source.detail ? (
        <span className="truncate text-ui-sm text-muted-foreground">{props.source.detail}</span>
      ) : null}
    </span>
  );
}

/**
 * The picker's source row: the provider serving the listed models, opened into the
 * list of every source the user can switch to (their Moss account, local CLI sign-ins,
 * API keys, other agents) plus a way to manage them.
 */
export function ComposerModelPickerSourceMenu(props: {
  tab: ComposerModelPickerTab;
  providerTabs: ReadonlyArray<ComposerModelPickerProviderTab>;
  onTabChange: (tab: ComposerModelPickerTab) => void;
  /** Omitted while the thread is locked to its provider. */
  onManageModels?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const activeTab =
    props.tab === STARRED_TAB
      ? null
      : (props.providerTabs.find((providerTab) => providerTab.instanceId === props.tab) ?? null);
  const activeSource: SourcePresentation = activeTab
    ? presentSource(activeTab, t)
    : { title: t("chat.modelPicker.source.starred"), detail: null, badge: null };
  const sourceLabel = t("chat.modelPicker.source.label");

  return (
    <div className="shrink-0 border-b border-border p-1">
      <MenuSub open={open} onOpenChange={setOpen}>
        <MenuSubTrigger
          aria-label={`${sourceLabel}: ${[activeSource.title, activeSource.detail]
            .filter(Boolean)
            .join(" · ")}`}
          className="gap-2 px-2"
          data-model-picker-source-trigger=""
        >
          <SourceMark providerTab={activeTab} dimmed={activeTab?.unavailableLabel != null} />
          <SourceLabel source={activeSource} />
        </MenuSubTrigger>
        <ComposerPickerMenuSubPopup className="min-w-56" aria-label={sourceLabel}>
          <MenuRadioGroup
            value={props.tab}
            onValueChange={(value) => {
              setOpen(false);
              props.onTabChange(value as ComposerModelPickerTab);
            }}
          >
            <MenuRadioItem value={STARRED_TAB}>
              <SourceMark providerTab={null} />
              <span className="truncate">{t("chat.modelPicker.source.starred")}</span>
            </MenuRadioItem>
            {props.providerTabs.map((providerTab) => {
              const source = presentSource(providerTab, t);
              return (
                <MenuRadioItem
                  key={providerTab.instanceId}
                  value={providerTab.instanceId}
                  disabled={providerTab.blocked}
                  title={providerTab.unavailableLabel ?? undefined}
                  aria-label={[source.title, source.detail].filter(Boolean).join(" · ")}
                >
                  <SourceMark
                    providerTab={providerTab}
                    dimmed={providerTab.unavailableLabel !== null}
                  />
                  <SourceLabel source={source} />
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
          {props.onManageModels ? (
            <>
              <MenuSeparator />
              <MenuItem
                className="gap-2 px-2.5"
                onClick={() => {
                  setOpen(false);
                  props.onManageModels?.();
                }}
              >
                <SettingsIcon aria-hidden="true" className="size-4 shrink-0" />
                {t("chat.modelPicker.source.manage")}
              </MenuItem>
            </>
          ) : null}
        </ComposerPickerMenuSubPopup>
      </MenuSub>
    </div>
  );
}
