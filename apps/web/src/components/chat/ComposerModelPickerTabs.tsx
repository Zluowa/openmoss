// FILE: ComposerModelPickerTabs.tsx
// Purpose: The agent and provider parts of the composer model picker. The panel has two
//   columns side by side: on the left every agent (which program runs the turn: Codex,
//   Claude, OpenCode, …), on the right the open agent's providers (服务商: where its models
//   come from: Moss, the person's own login on this computer, another account) above its
//   models. A provider that cannot run yet explains itself there with one action.
// Layer: Chat composer presentation
// Depends on: provider readiness, account-source kinds, menu primitives.

import {
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@moss/contracts";
import { type ReactNode } from "react";

import { supportsAgentSignIn, useAgentSignIn } from "~/lib/agentSignIn";

import { DownloadIcon, SettingsIcon, StarFilledIcon } from "~/lib/icons";
import { type AgentReadiness, resolveAgentReadiness } from "~/lib/providerAvailability";
import {
  isRestartRequiredReadiness,
  providerReadinessDescriptionKey,
  relaunchMoss,
} from "~/lib/providerReadinessCopy";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";
import { cn } from "~/lib/utils";
import { type TranslationKey, useTranslation } from "~/localization";
import { MossLogo } from "../MossLogo";
import { ProviderAccountAvatar, ProviderAccountDot } from "../ProviderAccountMark";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { Button } from "../ui/button";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { type ComposerModelPickerTab, STARRED_TAB } from "./ComposerModelPicker.logic";
import {
  isMossManagedSourceInstanceId,
  mossSourceInstanceIdForAgent,
} from "./providerAccountSources";
import {
  composerSourceSortOrder,
  findProviderStatusForInstance,
  type ProviderModelPickerInstance,
} from "./ProviderModelPicker";
import { COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME } from "./composerPickerStyles";
import { PICKER_PANEL_ROW_SELECTED_CLASS_NAME } from "./pickerPanelStyles";

/** The agents Moss ships its own CLI for. */
const MOSS_BUNDLED_AGENTS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent"]);

/** One provider (服务商) an agent can take its models from: one provider instance. */
export type ComposerModelPickerProviderTab = {
  provider: ProviderKind;
  /** Account the tab lists models for; a default account shares the provider id. */
  instanceId: ProviderInstanceId;
  /** The agent's own name ("Codex"), whichever account this is. */
  agentLabel: string;
  /** The agent qualified by the account while the agent has several ("Codex · Work"). */
  label: string;
  /** The account's own name, as configured. */
  accountLabel: string;
  /** The agent's default account: the person's own login on this computer. */
  isDefaultAccount: boolean;
  /** Account name written beside the icon of the open tab; null while the provider has
   *  one account and its icon says it all. */
  name: string | null;
  /** A second account of its provider: its icon is dotted to differ from the default. */
  dotted: boolean;
  accentColor?: string | undefined;
  /** Whether it can run now, and what the person does when it cannot. */
  readiness: AgentReadiness;
  /** Moss offered to a signed-out person: no instance runs yet, choosing it leads to
   *  signing in. Its id is the agent's Moss instance id, which signing in provisions. */
  mossSignIn: boolean;
  /** Closed in this thread: another account of the agent the thread already runs. */
  blocked: boolean;
};

/** One agent (the program that runs the turn) with the providers it can use, Moss first. */
export type ComposerModelPickerAgent = {
  provider: ProviderKind;
  label: string;
  sources: ReadonlyArray<ComposerModelPickerProviderTab>;
  /** Its best provider's readiness: ready when any provider can run now. */
  readiness: AgentReadiness["state"];
  /** Every provider of the agent is closed (a started thread runs on another agent). */
  blocked: boolean;
};

// Best first: an agent reads as its most usable provider.
const READINESS_RANK: Record<AgentReadiness["state"], number> = {
  ready: 0,
  checking: 1,
  needsLogin: 2,
  error: 3,
  notInstalled: 4,
};

/**
 * The name an account goes by in the composer. Every Moss lane is just "Moss", whatever the
 * server calls the instance internally ("Moss Claude"), so Claude's button reads like the
 * other agents'.
 */
export function composerAccountName(account: {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}): string {
  return isMossManagedSourceInstanceId(account.instanceId) ? "Moss" : account.label;
}

function mossSignInTab(
  option: { value: ProviderKind; label: string },
  instanceId: ProviderInstanceId,
  blocked: boolean,
): ComposerModelPickerProviderTab {
  return {
    provider: option.value,
    instanceId,
    agentLabel: option.label,
    label: providerAccountQualifiedLabel(option.label, "Moss"),
    accountLabel: "Moss",
    isDefaultAccount: false,
    name: "Moss",
    dotted: false,
    readiness: { state: "needsLogin", reason: "moss-sign-in" },
    mossSignIn: true,
    blocked,
  };
}

// One tab per enabled account, so a second Codex or Claude account is as reachable as
// another provider. A started thread stays on its account: siblings are listed but closed.
// Signed out, every agent Moss can serve also lists Moss, which leads to signing in.
export function resolveComposerModelPickerProviderTabs(input: {
  options: ReadonlyArray<{ value: ProviderKind; label: string }>;
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance> | undefined;
  lockedInstanceId?: ProviderInstanceId | null | undefined;
  // Locks only this provider's sibling accounts; other providers stay pickable.
  lockedInstanceProvider?: ProviderKind | null | undefined;
  /** The account the composer runs on: its tab always stays listed. */
  activeInstanceId?: ProviderInstanceId | null | undefined;
  /** Signed in, but Moss's gateway can't be reached: Moss rows say so, never "sign in". */
  mossGatewayUnreachable?: boolean | undefined;
}): ComposerModelPickerProviderTab[] {
  const tabs = resolveComposerModelPickerProviderTabsReachable(input);
  if (!input.mossGatewayUnreachable) return tabs;
  return tabs.map((tab) =>
    isMossManagedSourceInstanceId(tab.instanceId)
      ? { ...tab, readiness: MOSS_GATEWAY_UNREACHABLE_READINESS, mossSignIn: false }
      : tab,
  );
}

const MOSS_GATEWAY_UNREACHABLE_READINESS: AgentReadiness = {
  state: "error",
  reason: "moss-gateway-unreachable",
};

function resolveComposerModelPickerProviderTabsReachable(input: {
  options: ReadonlyArray<{ value: ProviderKind; label: string }>;
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance> | undefined;
  lockedInstanceId?: ProviderInstanceId | null | undefined;
  lockedInstanceProvider?: ProviderKind | null | undefined;
  /** The account the composer runs on: its tab always stays listed. */
  activeInstanceId?: ProviderInstanceId | null | undefined;
}): ComposerModelPickerProviderTab[] {
  const signedInToMoss = (input.providerInstances ?? []).some(
    (instance) => instance.enabled && isMossManagedSourceInstanceId(instance.instanceId),
  );
  return input.options.flatMap((option) => {
    const lockedToSibling = (instanceId: ProviderInstanceId) =>
      input.lockedInstanceId != null &&
      instanceId !== input.lockedInstanceId &&
      (input.lockedInstanceProvider == null || option.value === input.lockedInstanceProvider);
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
        ? accounts.map((account) => {
            const accountName = composerAccountName(account);
            return {
              instanceId: account.instanceId,
              label: hasSiblingAccounts
                ? providerAccountQualifiedLabel(option.label, accountName)
                : account.isDefault
                  ? option.label
                  : accountName,
              accountLabel: accountName,
              isDefaultAccount: account.isDefault,
              name: hasSiblingAccounts ? accountName : null,
              dotted: hasSiblingAccounts && !account.isDefault,
              accentColor: account.accentColor,
            };
          })
        : [
            {
              instanceId: option.value,
              label: option.label,
              accountLabel: option.label,
              isDefaultAccount: true,
              name: null,
              dotted: false,
              accentColor: undefined,
            },
          ];
    const resolved: ComposerModelPickerProviderTab[] = tabs.map((tab) => ({
      provider: option.value,
      instanceId: tab.instanceId,
      agentLabel: option.label,
      label: tab.label,
      accountLabel: tab.accountLabel,
      isDefaultAccount: tab.isDefaultAccount,
      name: tab.name,
      dotted: tab.dotted,
      accentColor: tab.accentColor,
      readiness: resolveAgentReadiness(
        findProviderStatusForInstance({
          providers: input.providers,
          provider: option.value,
          instanceId: tab.instanceId,
        }),
      ),
      mossSignIn: false,
      blocked: lockedToSibling(tab.instanceId),
    }));
    // Every agent Moss's gateway serves offers the Moss account next to the local one.
    // Moss ships Codex and Claude itself; the other agents' Moss lane still runs their
    // own CLI, so a missing CLI keeps reading as "install", not "sign in".
    const mossInstanceId = mossSourceInstanceIdForAgent(option.value);
    const cliAvailable =
      MOSS_BUNDLED_AGENTS.has(option.value) ||
      resolved.some((tab) => tab.readiness.state !== "notInstalled");
    if (
      !signedInToMoss &&
      cliAvailable &&
      mossInstanceId !== undefined &&
      !resolved.some((tab) => tab.instanceId === mossInstanceId)
    ) {
      return [mossSignInTab(option, mossInstanceId, lockedToSibling(mossInstanceId)), ...resolved];
    }
    // While the agent's Moss lane runs, its signed-out local login asks for nothing: the
    // agent is usable, so no 登录 row. The account the chat already uses always stays.
    const servedByMoss = resolved.some(
      (tab) => isMossManagedSourceInstanceId(tab.instanceId) && tab.readiness.state === "ready",
    );
    return servedByMoss
      ? resolved.filter(
          (tab) =>
            isMossManagedSourceInstanceId(tab.instanceId) ||
            tab.readiness.state !== "needsLogin" ||
            tab.instanceId === input.activeInstanceId ||
            tab.instanceId === input.lockedInstanceId,
        )
      : resolved;
  });
}

/**
 * Folds the per-account tabs into one entry per agent, in the order the tabs arrive
 * (the user's provider order). An agent reads as its most usable provider.
 */
export function groupComposerModelPickerAgents(
  tabs: ReadonlyArray<ComposerModelPickerProviderTab>,
): ComposerModelPickerAgent[] {
  const sourcesByProvider = new Map<ProviderKind, ComposerModelPickerProviderTab[]>();
  for (const tab of tabs) {
    const sources = sourcesByProvider.get(tab.provider);
    if (sources) sources.push(tab);
    else sourcesByProvider.set(tab.provider, [tab]);
  }
  return Array.from(sourcesByProvider, ([provider, sources]) => ({
    provider,
    label: sources[0]!.agentLabel,
    sources,
    readiness: sources
      .map((source) => source.readiness.state)
      .reduce((best, state) => (READINESS_RANK[state] < READINESS_RANK[best] ? state : best)),
    blocked: sources.every((source) => source.blocked),
  }));
}

/**
 * The provider an agent opens on: the one the composer already runs when it is this
 * agent, otherwise the first one that can run now, otherwise the first one listed, which
 * is Moss (signed in, or offering to sign in) for the agents Moss serves.
 */
export function preferredAgentSource(
  agent: ComposerModelPickerAgent,
  activeInstanceId: ProviderInstanceId,
): ComposerModelPickerProviderTab | null {
  const open = agent.sources.filter((source) => !source.blocked);
  return (
    open.find((source) => source.instanceId === activeInstanceId) ??
    open.find((source) => source.readiness.state === "ready") ??
    open[0] ??
    agent.sources[0] ??
    null
  );
}

/** A provider lists its models when it can run, or while its first check is still out. */
export function composerSourceListsModels(
  source: Pick<ComposerModelPickerProviderTab, "readiness" | "mossSignIn">,
): boolean {
  return (
    !source.mossSignIn &&
    (source.readiness.state === "ready" || source.readiness.state === "checking")
  );
}

/** The provider's name as the person knows it, now that the agent is named above it. */
export function composerSourceTitle(
  source: Pick<ComposerModelPickerProviderTab, "instanceId" | "isDefaultAccount" | "accountLabel">,
  localAccountLabel: string,
): string {
  if (isMossManagedSourceInstanceId(source.instanceId)) return "Moss";
  if (source.isDefaultAccount) return localAccountLabel;
  return source.accountLabel;
}

const PICKER_ROW_ICON_CLASS_NAME = "size-4 shrink-0 text-foreground";
// Every row of these lists: one height, the icon, the name, a quiet word at the end.
const PICKER_ROW_CLASS_NAME = "gap-2 px-2";

/** Marks the agent column, so the panel's arrow keys know which column has focus. */
const MODEL_PICKER_AGENT_COLUMN_ATTRIBUTE = "data-model-picker-agents";
/** On each agent row: the tab choosing it opens, so arrow keys can open the row they reach. */
export const MODEL_PICKER_AGENT_TAB_ATTRIBUTE = "data-model-picker-agent-tab";

// The one short word a row can hold: what the person does next (登录, 安装), or that it
// cannot run right now. Ready agents say nothing, and a first check lists its models.
const READINESS_WORD_KEY: Partial<Record<AgentReadiness["state"], TranslationKey>> = {
  needsLogin: "provider.readiness.signInAction",
  notInstalled: "provider.readiness.installAction",
  error: "chat.modelPicker.status.unavailable",
};

function AgentMark(props: { provider: ProviderKind | null }) {
  if (props.provider === null) {
    return <StarFilledIcon aria-hidden="true" className={PICKER_ROW_ICON_CLASS_NAME} />;
  }
  const AgentIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[props.provider];
  return <AgentIcon aria-hidden="true" className={PICKER_ROW_ICON_CLASS_NAME} />;
}

function SourceMark(props: { source: ComposerModelPickerProviderTab }) {
  const { source } = props;
  if (isMossManagedSourceInstanceId(source.instanceId)) {
    return <MossLogo className="size-4 shrink-0" />;
  }
  const AgentIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[source.provider];
  return (
    <span className="relative flex shrink-0">
      <AgentIcon aria-hidden="true" className={PICKER_ROW_ICON_CLASS_NAME} />
      <ProviderAccountDot
        accentColor={source.accentColor}
        always={source.dotted}
        className="absolute -top-0.5 -right-0.5"
      />
    </span>
  );
}

function PickerRowLabel(props: { icon: ReactNode; title: string; trailing?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {props.icon}
      <span className="min-w-0 flex-1 truncate text-foreground">{props.title}</span>
      {props.trailing ? (
        <span className="flex shrink-0 items-center gap-1 text-ui-sm text-muted-foreground">
          {props.trailing}
        </span>
      ) : null}
    </span>
  );
}

function PickerListRow(props: {
  icon: ReactNode;
  title: string;
  trailing?: string | null;
  selected?: boolean;
  disabled?: boolean;
  tooltip?: string | undefined;
  ariaLabel?: string;
  /** Agent rows: the tab this row opens. */
  agentTab?: ComposerModelPickerTab;
  onSelect: () => void;
}) {
  return (
    <MenuItem
      closeOnClick={false}
      aria-current={props.selected ? "true" : undefined}
      aria-label={props.ariaLabel ?? props.title}
      disabled={props.disabled}
      title={props.tooltip}
      className={cn(
        PICKER_ROW_CLASS_NAME,
        "shrink-0",
        props.selected && PICKER_PANEL_ROW_SELECTED_CLASS_NAME,
      )}
      onClick={props.onSelect}
      {...(props.agentTab ? { [MODEL_PICKER_AGENT_TAB_ATTRIBUTE]: props.agentTab } : {})}
    >
      <PickerRowLabel icon={props.icon} title={props.title} trailing={props.trailing} />
    </MenuItem>
  );
}

function usePickerCopy() {
  const { t, format } = useTranslation();
  return {
    t,
    format,
    agentField: t("chat.modelPicker.agent.label"),
    sourceField: t("chat.modelPicker.source.label"),
    starred: t("chat.modelPicker.source.starred"),
    localAccount: t("chat.modelPicker.source.local"),
    word: (readiness: Pick<AgentReadiness, "state" | "reason"> | undefined) => {
      if (!readiness) return null;
      if (isRestartRequiredReadiness(readiness))
        return t("chat.modelPicker.status.restartRequired");
      const key = READINESS_WORD_KEY[readiness.state];
      return key ? t(key) : null;
    },
    // The full sentence behind the word, for the row's tooltip.
    describe: (source: ComposerModelPickerProviderTab | undefined) => {
      const key = source ? providerReadinessDescriptionKey(source.readiness) : null;
      return source && key ? format(key, { provider: source.agentLabel }) : undefined;
    },
  };
}

/**
 * The panel's left column: every agent once, in the user's order. Starred presets first,
 * then the agents that can run, then the ones not on this computer yet. A row says at most
 * one word (登录, 安装, 不可用). Choosing an agent opens its providers and models in the
 * right column; this column stays where it is.
 */
export function ComposerModelPickerAgentColumn(props: {
  tab: ComposerModelPickerTab;
  providerTabs: ReadonlyArray<ComposerModelPickerProviderTab>;
  activeInstanceId: ProviderInstanceId;
  onSelectTab: (tab: ComposerModelPickerTab) => void;
  /** Omitted while the thread is locked to its provider. */
  onManageProviders?: (() => void) | undefined;
  className?: string;
}) {
  const copy = usePickerCopy();
  const agents = groupComposerModelPickerAgents(props.providerTabs);
  const activeProvider =
    props.tab === STARRED_TAB
      ? null
      : (props.providerTabs.find((providerTab) => providerTab.instanceId === props.tab)?.provider ??
        null);
  const renderAgent = (agent: ComposerModelPickerAgent) => {
    const source = preferredAgentSource(agent, props.activeInstanceId);
    return (
      <PickerListRow
        key={agent.provider}
        icon={<AgentMark provider={agent.provider} />}
        title={agent.label}
        trailing={copy.word(
          agent.sources.find((candidate) => candidate.readiness.state === agent.readiness)
            ?.readiness ?? { state: agent.readiness },
        )}
        tooltip={copy.describe(
          agent.sources.find((candidate) => candidate.readiness.state === agent.readiness),
        )}
        selected={agent.provider === activeProvider}
        disabled={agent.blocked}
        {...(source ? { agentTab: source.instanceId } : {})}
        onSelect={() => {
          if (source) props.onSelectTab(source.instanceId);
        }}
      />
    );
  };
  const installed = agents.filter((agent) => agent.readiness !== "notInstalled");
  const notInstalled = agents.filter((agent) => agent.readiness === "notInstalled");
  return (
    <div
      className={cn("flex min-h-0 flex-col", props.className)}
      {...{ [MODEL_PICKER_AGENT_COLUMN_ATTRIBUTE]: "" }}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overscroll-contain p-1",
          COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
        )}
        aria-label={copy.agentField}
        role="group"
      >
        <PickerListRow
          icon={<AgentMark provider={null} />}
          title={copy.starred}
          selected={props.tab === STARRED_TAB}
          agentTab={STARRED_TAB}
          onSelect={() => props.onSelectTab(STARRED_TAB)}
        />
        {installed.length > 0 ? <MenuSeparator className="shrink-0" /> : null}
        {installed.map(renderAgent)}
        {notInstalled.length > 0 ? <MenuSeparator className="shrink-0" /> : null}
        {notInstalled.map(renderAgent)}
      </div>
      {props.onManageProviders ? (
        <div className="shrink-0 border-t border-border p-1">
          <PickerListRow
            icon={<SettingsIcon aria-hidden="true" className="size-4 shrink-0" />}
            title={copy.t("chat.modelPicker.source.manage")}
            onSelect={props.onManageProviders}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The open agent's providers (服务商), above its models: Moss first, then the person's own
 * login on this computer, then other accounts. Always shown, so the person can see whether
 * a turn runs on Moss or on their own account.
 */
export function ComposerModelPickerProviderRows(props: {
  tab: ComposerModelPickerTab;
  providerTabs: ReadonlyArray<ComposerModelPickerProviderTab>;
  onSelectTab: (tab: ComposerModelPickerTab) => void;
}) {
  const copy = usePickerCopy();
  const activeSource = props.providerTabs.find(
    (providerTab) => providerTab.instanceId === props.tab,
  );
  if (!activeSource) return null;
  const sources = props.providerTabs.filter(
    (providerTab) => providerTab.provider === activeSource.provider,
  );
  return (
    <div
      className="flex shrink-0 flex-col gap-px border-b border-border p-1"
      aria-label={copy.sourceField}
      role="group"
    >
      {sources.map((source) => {
        const title = composerSourceTitle(source, copy.localAccount);
        return (
          <PickerListRow
            key={source.instanceId}
            icon={<SourceMark source={source} />}
            title={title}
            trailing={
              source.blocked
                ? copy.t("chat.modelPicker.status.locked")
                : copy.word(source.readiness)
            }
            selected={source.instanceId === props.tab}
            disabled={source.blocked}
            tooltip={
              source.blocked
                ? copy.format("chat.modelPicker.lockedTooltip", { name: title })
                : copy.describe(source)
            }
            onSelect={() => props.onSelectTab(source.instanceId)}
          />
        );
      })}
      {mossSourceInstanceIdForAgent(activeSource.provider) === undefined ? (
        // Every agent lists Moss next to its own account. One whose CLI can only reach its
        // vendor's backend (Devin, Cursor, …) shows it greyed out and says why.
        <PickerListRow
          icon={<MossLogo className="size-4 shrink-0 opacity-50" />}
          title="Moss"
          trailing={copy.t("chat.modelPicker.status.mossUnsupported")}
          disabled
          tooltip={copy.format("chat.modelPicker.mossUnsupportedTooltip", {
            provider: activeSource.agentLabel,
          })}
          onSelect={() => undefined}
        />
      ) : null}
    </div>
  );
}

function AgentSignInNoticeButton(props: {
  source: ComposerModelPickerProviderTab;
  status: ServerProviderStatus | null | undefined;
}) {
  const { t } = useTranslation();
  const signIn = useAgentSignIn({
    provider: props.source.provider,
    instanceId: props.source.instanceId,
    status: props.status,
  });
  const busy = signIn.state === "signingIn" || signIn.state === "verifying";
  return (
    <Button type="button" size="xs" disabled={busy} onClick={() => void signIn.start()}>
      {busy
        ? t(
            signIn.state === "verifying"
              ? "provider.signIn.verifying"
              : "provider.signIn.waitingShort",
          )
        : t("provider.readiness.signInAction")}
    </Button>
  );
}

/**
 * Shown in place of the model list while the open provider cannot run: the server's
 * reason in one plain line and one action. Server diagnostics are never shown here.
 */
export function ComposerModelPickerSourceNotice(props: {
  source: ComposerModelPickerProviderTab;
  /** The open provider's status: lets 登录 start the agent's own sign-in right here. */
  status?: ServerProviderStatus | null | undefined;
  onSignInToMoss: () => void;
  /** Settings at this agent: its sign-in, its 安装 button, or what went wrong. */
  onOpenAgentSettings: (provider: ProviderKind) => void;
}) {
  const { t, format } = useTranslation();
  const { source } = props;
  const moss = isMossManagedSourceInstanceId(source.instanceId);
  const { state } = source.readiness;
  const title = moss ? "Moss" : source.agentLabel;
  const descriptionKey = providerReadinessDescriptionKey(source.readiness);
  const body = descriptionKey ? format(descriptionKey, { provider: source.agentLabel }) : null;
  const openAgentSettings = () => props.onOpenAgentSettings(source.provider);
  // Codex and Claude sign in from here in one step: Moss runs the agent's own login and the
  // browser opens on its page. Other agents still go to their settings.
  const inAppSignIn = !moss && supportsAgentSignIn(source.provider, props.status);
  const action =
    state === "needsLogin" ? (
      inAppSignIn ? (
        <AgentSignInNoticeButton source={source} status={props.status} />
      ) : (
        <Button type="button" size="xs" onClick={moss ? props.onSignInToMoss : openAgentSettings}>
          {t("provider.readiness.signInAction")}
        </Button>
      )
    ) : state === "notInstalled" ? (
      <Button type="button" size="xs" onClick={openAgentSettings}>
        <DownloadIcon aria-hidden="true" className="size-3.5" />
        {t("provider.readiness.installAction")}
      </Button>
    ) : source.readiness.reason === "moss-gateway-unreachable" ? null : isRestartRequiredReadiness(
        source.readiness,
      ) ? (
      <Button
        type="button"
        size="xs"
        onClick={() => {
          if (!relaunchMoss()) openAgentSettings();
        }}
      >
        {t("chat.modelPicker.notice.restartMoss")}
      </Button>
    ) : (
      <Button type="button" size="xs" variant="outline" onClick={openAgentSettings}>
        <SettingsIcon aria-hidden="true" className="size-3.5" />
        {t("chat.modelPicker.notice.openSettings")}
      </Button>
    );
  return (
    <div
      className="flex flex-col items-center gap-2 px-3 py-4 text-center"
      data-model-picker-notice={source.mossSignIn ? "mossSignIn" : state}
    >
      {moss ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-muted/60 ring-1 ring-border/70">
          <MossLogo className="size-4" />
        </span>
      ) : (
        <ProviderAccountAvatar provider={source.provider} accentColor={source.accentColor} />
      )}
      <span className="text-ui font-medium text-foreground">{title}</span>
      {body ? <span className="text-ui-sm leading-snug text-muted-foreground">{body}</span> : null}
      {action}
    </div>
  );
}
