import { PROVIDER_OPTIONS } from "../../session-logic";
// FILE: ComposerModelPicker.tsx
// Purpose: Single composer picker — the agent column on the left, and beside it the open
//   agent's providers, searchable model rows, starred model + trait presets, and per-trait
//   rows (effort, speed, …), all visible at once.
// Layer: Chat composer presentation
// Depends on: the picker's tabs/row/trait-row pieces, composer trait helpers, starred
//   model storage, and shared menu primitives.

import {
  type ModelSlug,
  type ProviderAgentDescriptor,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
  type ServerProviderStatus,
  type ThreadId,
} from "@moss/contracts";
import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { appHistory } from "../../appNavigation";
import { agentSettingsHref } from "../../lib/agentInstall";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStarredModels } from "../../hooks/useStarredModels";
import type { ProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { useTranslation } from "../../localization";
import {
  buildNextProviderOptions,
  getOmpModelSelectionIssue,
  type ProviderModelOption,
  type ProviderOptions,
} from "../../providerModelOptions";
import { SearchIcon } from "~/lib/icons";
import { starredModelInstanceId, starredModelSlotKey } from "~/lib/starredModels";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuGroupLabel } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { ComposerModelMenuTrigger } from "./ComposerModelMenuTrigger";
import { ModelCatalogRefresh } from "./ModelCatalogRefresh";
import { ModelPickerEmptyCatalog } from "./ModelPickerEmptyCatalog";
import {
  buildProviderTabRows,
  buildStarredModelOptionsPatch,
  buildStarredTabRows,
  type ComposerModelPickerRow as PickerRow,
  type ComposerModelPickerTab,
  composerModelDisplayName,
  MODEL_PICKER_POPUP_ATTRIBUTE,
  MODEL_PICKER_SHORTCUT_ROW_LIMIT,
  modelPickerShortcutRowIndex,
  resolveDefaultRowModel,
  resolveStarredTraits,
  STARRED_TAB,
} from "./ComposerModelPicker.logic";
import { ComposerModelPickerRow } from "./ComposerModelPickerRow";
import {
  ComposerModelPickerAgentColumn,
  ComposerModelPickerProviderRows,
  ComposerModelPickerSourceNotice,
  composerSourceListsModels,
  MODEL_PICKER_AGENT_TAB_ATTRIBUTE,
  resolveComposerModelPickerProviderTabs,
} from "./ComposerModelPickerTabs";
import {
  type ComposerEffortControl,
  ComposerModelPickerTraitRows,
} from "./ComposerModelPickerTraitRows";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME } from "./composerPickerStyles";
import {
  getComposerTraitSelection,
  planComposerEffortChange,
  resolveComposerTraitStatusLabel,
  showsComposerFastModeBadge,
} from "./composerTraits";
import type { FastModeNotice } from "~/lib/fastModeState";
import { MENU_NAVIGATION_KEYS } from "./PickerPanelShell";
import {
  PICKER_PANEL_GROUP_LABEL_CLASS_NAME,
  PICKER_PANEL_PLAIN_SEARCH_ICON_CLASS_NAME,
  PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME,
} from "./pickerPanelStyles";
import {
  findProviderStatusForInstance,
  type ProviderModelOptionsByProviderInstance,
  type ProviderModelPickerInstance,
  resolveProviderModelLabel,
  resolveVisibleProviderOptions,
} from "./ProviderModelPicker";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";

/** Marks the right column: the open agent's providers, search, models and traits. */
const MODEL_PICKER_MODELS_ATTRIBUTE = "data-model-picker-models";
// Keys that move within one column; Left and Right move between the columns.
const MENU_COLUMN_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

function focusRow(row: HTMLElement | undefined): boolean {
  if (!row) return false;
  row.focus();
  row.scrollIntoView({ block: "nearest" });
  return true;
}

function rowsOf(column: HTMLElement | null | undefined): HTMLElement[] {
  return Array.from(
    column?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])') ?? [],
  );
}

export type ComposerModelSelectionOptions = {
  /** Provider options to commit together with the model (starred presets, row effort). */
  modelOptions?: ProviderOptions;
  /** Provider instance (account) the model is committed for. */
  instanceId?: ProviderInstanceId;
};

type ComposerModelPickerProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  // Set when other providers are open for a same-thread handoff: the thread's
  // own provider still cannot switch to a sibling account.
  boundProviderInstance?: {
    readonly provider: ProviderKind;
    readonly instanceId: ProviderInstanceId;
  } | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  onRefreshModels?: ProviderModelCatalog["refreshModels"];
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  /** Each account's own configured default model (from its CLI config). */
  defaultModelByProviderInstance?: Partial<Record<ProviderInstanceId, string>>;
  /** Accounts whose model list has not answered yet. */
  modelDiscoveryPendingByProviderInstance?: Partial<Record<ProviderInstanceId, boolean>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance;
  // Narrow-composer degradation: drop the model name (provider icon stays)
  // and/or the effort/status label; both remain available to assistive tech.
  hideModelLabel?: boolean;
  hideStatusLabel?: boolean;
  contextWindowLabel?: string | null;
  /** Signed in, but Moss's gateway can't be reached: Moss rows say so instead of 登录. */
  mossGatewayUnreachable?: boolean | undefined;
  // Set when the thread's provider reported that the requested fast mode is not serving.
  fastModeNotice?: FastModeNotice | null;
  disabled?: boolean;
  // "menu" (default) lists effort as a footer row; "slider" renders the ladder as a
  // stepped slider card in the footer instead.
  effortControl?: ComposerEffortControl;
  onProviderModelChange: (
    provider: ProviderKind,
    model: ModelSlug,
    options?: ComposerModelSelectionOptions,
  ) => void;
  onSelectionCommitted?: () => void;

  threadId: ThreadId;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModelsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor> | null | undefined>
  >;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;

  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
};

// Rows arrive ordered by group; wrap each run of equal labels in one labelled menu group.
function groupRowElements(
  rows: ReadonlyArray<PickerRow>,
  renderRow: (row: PickerRow, index: number) => ReactNode,
): ReactNode[] {
  const groups: Array<{ key: string; label: string | null; items: ReactNode[] }> = [];
  rows.forEach((row, index) => {
    const lastGroup = groups.at(-1);
    const group =
      lastGroup && lastGroup.label === row.groupLabel
        ? lastGroup
        : { key: row.key, label: row.groupLabel, items: [] };
    if (group !== lastGroup) groups.push(group);
    group.items.push(renderRow(row, index));
  });
  return groups.map((group) => (
    <MenuGroup key={group.key} className="flex flex-col gap-px">
      {group.label !== null ? (
        <MenuGroupLabel className={PICKER_PANEL_GROUP_LABEL_CLASS_NAME}>
          {group.label}
        </MenuGroupLabel>
      ) : null}
      {group.items}
    </MenuGroup>
  ));
}

export function ComposerModelPicker(props: ComposerModelPickerProps) {
  const { onOpenChange, open, lockedProvider, threadId } = props;
  const { t } = useTranslation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isMenuOpen = open ?? uncontrolledOpen;
  const activeProvider = lockedProvider ?? props.provider;
  const effortControl = props.effortControl ?? "menu";
  const usesEffortSlider = effortControl === "slider";

  const { starredModels, toggleStarredModel, unstarModel } = useStarredModels();
  const instancesFor = (provider: ProviderKind): ReadonlyArray<ProviderModelPickerInstance> =>
    (props.providerInstances ?? []).filter((instance) => instance.provider === provider);
  const selectedInstanceIdFor = (provider: ProviderKind): ProviderInstanceId => {
    const instances = instancesFor(provider);
    if (
      provider === props.provider &&
      props.selectedProviderInstanceId !== undefined &&
      instances.some((instance) => instance.instanceId === props.selectedProviderInstanceId)
    ) {
      return props.selectedProviderInstanceId;
    }
    return (
      instances.find((instance) => instance.isDefault)?.instanceId ??
      instances[0]?.instanceId ??
      provider
    );
  };
  const activeInstanceId = selectedInstanceIdFor(activeProvider);

  // A locked thread can only ever run its own account's presets, and a preset of a
  // removed or disabled account cannot run at all.
  const knownInstances = props.providerInstances;
  const usableStarredModels = starredModels.filter((entry) => {
    if (lockedProvider !== null && entry.provider !== lockedProvider) return false;
    const instanceId = starredModelInstanceId(entry);
    const status = findProviderStatusForInstance({
      providers: props.providers,
      provider: entry.provider,
      instanceId,
    });
    if (status?.enabled === false) return false;
    if (knownInstances?.some((instance) => instance.instanceId === instanceId && !instance.enabled))
      return false;
    if (lockedProvider !== null && instanceId !== activeInstanceId) return false;
    const bound = props.boundProviderInstance;
    if (bound && entry.provider === bound.provider && instanceId !== bound.instanceId) {
      return false;
    }
    return (
      instanceId === entry.provider ||
      knownInstances === undefined ||
      knownInstances.some(
        (instance) => instance.instanceId === instanceId && instance.enabled !== false,
      )
    );
  });

  const [tab, setTab] = useState<ComposerModelPickerTab>(activeInstanceId);
  const [query, setQuery] = useState("");
  const normalizedQuery = useDeferredValue(query).trim().toLowerCase();
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // A model picked while the panel stays open (slider mode) still owes the composer its
  // focus hand-off; it is paid when the panel finally closes.
  const selectionCommittedWhileOpenRef = useRef(false);
  const setMenuOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
    if (!nextOpen && selectionCommittedWhileOpenRef.current) {
      selectionCommittedWhileOpenRef.current = false;
      props.onSelectionCommitted?.();
    }
  };

  const popupBodyRef = useRef<HTMLDivElement | null>(null);
  const agentColumnRef = useRef<HTMLDivElement | null>(null);
  // Where focus goes once a newly chosen tab has rendered: the search field (opening the
  // panel, a click, Tab), or nowhere while arrow keys walk the agent column.
  const focusAfterTabChangeRef = useRef<"search" | "stay">("search");
  useEffect(() => {
    if (!isMenuOpen) return;
    const target = focusAfterTabChangeRef.current;
    focusAfterTabChangeRef.current = "search";
    if (target === "stay") return;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isMenuOpen, tab]);

  // Options a provider's models would run with: the composer's own for the selected
  // provider, otherwise that provider's draft / sticky selection.
  const draftSelectionByProvider = useComposerDraftStore(
    (store) => store.draftsByThreadId[threadId]?.modelSelectionByProvider,
  );
  const stickySelectionByProvider = useComposerDraftStore(
    (store) => store.stickyModelSelectionByProvider,
  );
  const providerOptionsFor = (provider: ProviderKind): ProviderOptions | undefined =>
    provider === props.provider
      ? props.modelOptions
      : (draftSelectionByProvider?.[provider]?.options ??
        stickySelectionByProvider[provider]?.options);
  const promptFor = (provider: ProviderKind) => (provider === props.provider ? props.prompt : "");
  const traitSelectionFor = (provider: ProviderKind, model: string) =>
    getComposerTraitSelection(
      provider,
      model,
      promptFor(provider),
      providerOptionsFor(provider),
      resolveRuntimeModelDescriptor({
        provider,
        model,
        runtimeModels: props.runtimeModelsByProvider?.[provider],
      }),
    );

  const modelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
    modelOptionsByProviderInstance: props.modelOptionsByProviderInstance,
    selectedProviderInstanceId: props.selectedProviderInstanceId,
  });
  const modelSelectionIssue =
    activeProvider === "omp"
      ? getOmpModelSelectionIssue(
          props.model,
          props.modelOptionsByProviderInstance?.[activeInstanceId] ??
            props.modelOptionsByProvider.omp,
        )
      : null;
  const currentTraitSelection = getComposerTraitSelection(
    props.provider,
    props.model,
    props.prompt,
    props.modelOptions,
    props.runtimeModel,
  );

  const visibleProviderOptions = resolveVisibleProviderOptions({
    provider: props.provider,
    lockedProvider,
    providers: props.providers,
    hiddenProviders: props.hiddenProviders,
    providerOrder: props.providerOrder,
  }).filter((option) => lockedProvider === null || option.value === lockedProvider);
  // An enabled provider awaiting setup keeps its tab; a disabled provider is
  // managed through the recovery list in Settings instead.
  const activeProviderStatus = findProviderStatusForInstance({
    providers: props.providers,
    provider: activeProvider,
    instanceId: activeInstanceId,
  });
  const activeProviderOption =
    activeProviderStatus?.enabled === false
      ? undefined
      : // Preserve an existing saved provider even if Moss does not offer it for new chats.
        PROVIDER_OPTIONS.find((option) => option.available && option.value === activeProvider);
  const providerTabs = resolveComposerModelPickerProviderTabs({
    options:
      activeProviderOption &&
      !visibleProviderOptions.some((option) => option.value === activeProvider)
        ? [activeProviderOption, ...visibleProviderOptions]
        : visibleProviderOptions,
    providers: props.providers,
    providerInstances: props.providerInstances,
    lockedInstanceId:
      lockedProvider !== null
        ? activeInstanceId
        : (props.boundProviderInstance?.instanceId ?? null),
    lockedInstanceProvider:
      lockedProvider === null ? (props.boundProviderInstance?.provider ?? null) : null,
    mossGatewayUnreachable: props.mossGatewayUnreachable === true,
  });
  const activeProviderTab = providerTabs.find(
    (providerTab) => providerTab.instanceId === activeInstanceId,
  );
  // Without the composer's own account, open on the first provider that lists models.
  const fallbackProviderTab =
    providerTabs.find((providerTab) => composerSourceListsModels(providerTab)) ??
    providerTabs[0] ??
    null;
  // Reset to the fastest starting point on every open: presets when the user has any,
  // unless the composer's own account is waiting to be set up.
  const [wasMenuOpen, setWasMenuOpen] = useState(isMenuOpen);
  if (wasMenuOpen !== isMenuOpen) {
    setWasMenuOpen(isMenuOpen);
    if (isMenuOpen) {
      setTab(
        usableStarredModels.length > 0 &&
          (activeProviderTab === undefined || composerSourceListsModels(activeProviderTab))
          ? STARRED_TAB
          : (activeProviderTab?.instanceId ?? fallbackProviderTab?.instanceId ?? STARRED_TAB),
      );
      setQuery("");
    }
  }

  // A tab that is no longer offered falls back to the first visible account.
  const openProviderTab = providerTabs.find((providerTab) => providerTab.instanceId === tab);
  const tabAccount = tab === STARRED_TAB ? null : (openProviderTab ?? fallbackProviderTab);
  const openTab: ComposerModelPickerTab =
    tab === STARRED_TAB ? STARRED_TAB : (tabAccount?.instanceId ?? STARRED_TAB);
  // A provider that cannot run yet explains itself with one action instead of a model list.
  const noticeSource =
    tabAccount === null || composerSourceListsModels(tabAccount) ? null : tabAccount;
  const openProviderSettings = () => {
    setMenuOpen(false);
    appHistory.push("/settings?section=providers");
  };
  const signInToMoss = () => {
    setMenuOpen(false);
    appHistory.push("/login");
  };
  const openAgentSettings = (provider: ProviderKind) => {
    setMenuOpen(false);
    appHistory.push(agentSettingsHref(provider));
  };
  const chooseTab = (nextTab: ComposerModelPickerTab, focus: "search" | "stay" = "search") => {
    focusAfterTabChangeRef.current = focus;
    setTab(nextTab);
    // The same tab renders nothing new, so the effect above would not move focus.
    if (nextTab === tab && focus === "search") {
      focusAfterTabChangeRef.current = "search";
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  };

  const modelOptionsFor = (
    provider: ProviderKind,
    instanceId: string,
  ): ReadonlyArray<ProviderModelOption> =>
    props.modelOptionsByProviderInstance?.[instanceId as ProviderInstanceId] ??
    props.modelOptionsByProvider[provider];

  // Starred presets mix accounts, so each names its own once a provider has several.
  const accountLabelFor = (instanceId: string) => {
    const account = (props.providerInstances ?? []).find(
      (instance) => instance.instanceId === instanceId,
    );
    if (!account) return undefined;
    const hasSiblingAccounts = instancesFor(account.provider).some(
      (instance) => instance.instanceId !== instanceId && instance.enabled,
    );
    return hasSiblingAccounts || !account.isDefault ? account.label : undefined;
  };

  // Codex parity: a first-class Default row (recommended model set) leads the codex model
  // list, as undecorated as every other row; the explicit model row it aliases yields its
  // checkmark so exactly one row reads as current.
  const buildProviderTabRowsWithDefault = (input: {
    provider: ProviderKind;
    instanceId: ProviderInstanceId;
    options: ReadonlyArray<ProviderModelOption>;
    query: string;
    selectedModel: string | null;
  }): PickerRow[] => {
    const defaultModel = resolveDefaultRowModel({
      provider: input.provider,
      options: input.options,
      configuredDefault: props.defaultModelByProviderInstance?.[input.instanceId],
    });
    const defaultName = t("chat.modelPicker.default.label");
    const defaultMatchesQuery =
      input.query.length === 0 ||
      defaultName.toLowerCase().includes(input.query) ||
      "default".includes(input.query);
    const defaultSelected = defaultModel !== null && input.selectedModel === defaultModel;
    const providerRows = buildProviderTabRows({
      provider: input.provider,
      instanceId: input.instanceId,
      options: input.options,
      query: input.query,
      selectedModel: defaultSelected ? null : input.selectedModel,
    });
    if (defaultModel === null || !defaultMatchesQuery) return providerRows;
    return [
      {
        key: `${input.instanceId}:__default__`,
        provider: input.provider,
        ...(input.instanceId !== input.provider ? { instanceId: input.instanceId } : {}),
        model: defaultModel,
        selectableModel: defaultModel,
        name: defaultName,
        detail: t("chat.modelPicker.default.description"),
        selected: defaultSelected,
        groupLabel: null,
        preset: null,
        isDefaultRow: true,
      },
      ...providerRows,
    ];
  };

  const rows =
    noticeSource !== null
      ? []
      : tabAccount === null
        ? buildStarredTabRows({
            starredModels: usableStarredModels,
            modelOptionsFor,
            accountLabelFor,
            query: normalizedQuery,
            current: {
              provider: activeProvider,
              instanceId: activeInstanceId,
              model: props.model,
              ...resolveStarredTraits(currentTraitSelection),
            },
            effortLevelsFor: (provider, model) => traitSelectionFor(provider, model).effortLevels,
          })
        : buildProviderTabRowsWithDefault({
            provider: tabAccount.provider,
            instanceId: tabAccount.instanceId,
            options: modelOptionsFor(tabAccount.provider, tabAccount.instanceId),
            query: normalizedQuery,
            // Another account's tab marks the model it starts on: its own configured default.
            selectedModel:
              tabAccount.instanceId === activeInstanceId
                ? props.model
                : (props.defaultModelByProviderInstance?.[tabAccount.instanceId] ?? null),
          });
  const starredModelSlots = new Set(starredModels.map(starredModelSlotKey));

  // Commit a row: `patch` carries the traits to apply on top of the provider's options.
  // `keepOpen` leaves the panel up so the footer slider can tune the model just picked.
  const commitRow = (
    row: PickerRow,
    model: ModelSlug,
    patch: Record<string, unknown>,
    keepOpen = false,
  ) => {
    // A starred preset restores its own account; other rows run in their tab's account.
    const instanceId = (
      row.preset ? starredModelInstanceId(row.preset) : (row.instanceId ?? row.provider)
    ) as ProviderInstanceId;
    if (Object.keys(patch).length > 0) {
      props.onProviderModelChange(row.provider, model, {
        modelOptions: buildNextProviderOptions(
          row.provider,
          providerOptionsFor(row.provider),
          patch,
        ),
        instanceId,
      });
    } else {
      props.onProviderModelChange(row.provider, model, { instanceId });
    }
    if (keepOpen) {
      selectionCommittedWhileOpenRef.current = true;
      setMenuOpen(true);
      return;
    }
    selectionCommittedWhileOpenRef.current = false;
    setMenuOpen(false);
    props.onSelectionCommitted?.();
  };

  const selectRow = (row: PickerRow) => {
    if (props.disabled) return;
    const model = row.selectableModel;
    if (model === null) return;

    const selection = traitSelectionFor(row.provider, model);
    // Slider mode: switching to a model with an effort ladder keeps the panel open so the
    // footer slider can set its effort. Presets already carry their effort, and picking
    // the current model again is the "done" gesture, so both close.
    const keepOpen =
      usesEffortSlider && row.preset === null && !row.selected && selection.effortLevels.length > 0;
    commitRow(
      row,
      model,
      row.preset
        ? buildStarredModelOptionsPatch({ provider: row.provider, selection, starred: row.preset })
        : {},
      keepOpen,
    );
  };

  // Pick a model and its effort in one gesture from the row's side block.
  const selectRowWithEffort = (row: PickerRow, value: string) => {
    const model = row.selectableModel;
    if (props.disabled || model === null) return;
    const plan = planComposerEffortChange({
      provider: row.provider,
      selection: traitSelectionFor(row.provider, model),
      prompt: promptFor(row.provider),
      value,
    });
    if (!plan) return;
    if (plan.kind === "options") {
      commitRow(row, model, plan.patch);
      return;
    }
    // Prompt-injected levels (Ultrathink) only make sense for the composer's own prompt.
    if (row.provider !== props.provider) return;
    props.onPromptChange(plan.prompt);
    commitRow(row, model, {});
  };

  const openTabs: ComposerModelPickerTab[] = [
    STARRED_TAB,
    ...providerTabs
      .filter((providerTab) => !providerTab.blocked)
      .map((providerTab) => providerTab.instanceId),
  ];
  const cycleTab = (direction: 1 | -1) => {
    const index = openTabs.indexOf(tab);
    setTab(openTabs[(index + direction + openTabs.length) % openTabs.length] ?? STARRED_TAB);
  };

  // mod+1…9 picks a visible row. Registered on window capture because thread-jump
  // owns the same chord globally (the sidebar yields while this picker is open).
  const onShortcutKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const rowIndex = modelPickerShortcutRowIndex(event);
    if (rowIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    const row = rows[rowIndex];
    if (row) selectRow(row);
  });
  useEffect(() => {
    if (!isMenuOpen) return;
    const listener = (event: KeyboardEvent) => onShortcutKeyDown(event);
    window.addEventListener("keydown", listener, { capture: true });
    return () => window.removeEventListener("keydown", listener, { capture: true });
  }, [isMenuOpen]);

  // Arrow keys stay inside a column: up and down walk it, right goes from the agents to
  // the models, left comes back. Walking the agent column opens each agent it reaches.
  const onColumnKeyDown = (event: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const body = popupBodyRef.current;
    const target = event.target;
    // Effort side menus are portaled: their own keys are theirs.
    if (!body || !(target instanceof HTMLElement) || !body.contains(target)) return false;
    // Only rows and the search field move between columns. The effort slider and the
    // other controls below the models keep their own arrow keys.
    if (target !== searchInputRef.current && target.closest('[role="menuitem"]') === null) {
      return false;
    }
    const agentColumn = agentColumnRef.current;
    const inAgents = agentColumn?.contains(target) ?? false;
    const modelsColumn = body.querySelector<HTMLElement>(`[${MODEL_PICKER_MODELS_ATTRIBUTE}]`);
    if (event.key === "ArrowRight") {
      if (!inAgents) return false;
      searchInputRef.current?.focus();
      return true;
    }
    if (event.key === "ArrowLeft") {
      if (inAgents) return false;
      const input = searchInputRef.current;
      // In the search field, Left first moves the caret.
      if (target === input && (input.selectionStart !== 0 || input.selectionEnd !== 0)) {
        return false;
      }
      const agentRows = rowsOf(agentColumn);
      return focusRow(
        agentRows.find((row) => row.getAttribute("aria-current") === "true") ?? agentRows[0],
      );
    }
    if (!MENU_COLUMN_KEYS.has(event.key)) return false;
    const column = inAgents ? agentColumn : modelsColumn;
    const columnRows = rowsOf(column);
    if (columnRows.length === 0) return false;
    let index = columnRows.findIndex((row) => row === target || row.contains(target));
    if (index === -1) {
      // From the search field: down to the first row below it, up to the last above it.
      const below = columnRows.findIndex(
        (row) => (target.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
      index = event.key === "ArrowDown" ? (below === -1 ? 0 : below) - 1 : below;
      if (index < 0 && event.key === "ArrowUp") index = 0;
    }
    const last = columnRows.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? index >= last
              ? 0
              : index + 1
            : index <= 0
              ? last
              : index - 1;
    const next = columnRows[nextIndex];
    if (!focusRow(next)) return false;
    const agentTab = inAgents ? next?.getAttribute(MODEL_PICKER_AGENT_TAB_ATTRIBUTE) : null;
    if (agentTab) chooseTab(agentTab as ComposerModelPickerTab, "stay");
    return true;
  };

  const shortcutModifierLabel = isMacNavigatorPlatform() ? "⌘" : "Ctrl ";
  const isTabLoading =
    tabAccount !== null &&
    rows.length === 0 &&
    ((props.loadingModelProviders?.[tabAccount.provider] ?? false) ||
      (props.modelDiscoveryPendingByProviderInstance?.[tabAccount.instanceId] ?? false));
  const discoveryError =
    tabAccount === null ? undefined : props.discoveryErrorsByProvider?.[tabAccount.provider];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(nextOpen) => setMenuOpen(props.disabled ? false : nextOpen)}
    >
      <ComposerModelMenuTrigger
        provider={activeProvider}
        accountLabel={activeProviderTab?.name ? activeProviderTab.label : null}
        // The default account is implied; only another one is worth the room.
        accountName={activeProviderTab?.dotted ? activeProviderTab.name : null}
        accountAccentColor={activeProviderTab?.accentColor}
        modelLabel={composerModelDisplayName(activeProvider, modelLabel)}
        statusLabel={resolveComposerTraitStatusLabel(currentTraitSelection)}
        contextWindowLabel={activeProvider === "claudeAgent" ? props.contextWindowLabel : null}
        showsFastBadge={showsComposerFastModeBadge(currentTraitSelection)}
        fastModeNotice={activeProvider === "claudeAgent" ? props.fastModeNotice : null}
        hideModelLabel={props.hideModelLabel}
        hideStatusLabel={props.hideStatusLabel}
        disabled={props.disabled}
        isMenuOpen={isMenuOpen}
        // Only the footer slider retunes effort inside the open panel, so only then does the
        // pill hold its open-time size while still showing the current choice.
        freezesSizeWhileOpen={usesEffortSlider && currentTraitSelection.effortLevels.length > 0}
        shortcutLabel={props.shortcutLabel}
      />
      <ComposerPickerMenuPopup
        align="start"
        // The agent column sits left of the trigger, so the models stay where they open.
        alignOffset={() => -(agentColumnRef.current?.offsetWidth ?? 0)}
        side="top"
        // Glassier than the stock picker shell: thinner fill over a deeper, more saturated blur.
        className="w-[min(28.5rem,92vw)] bg-popover/55 [--picker-option-min-h:1.75rem] before:backdrop-blur-3xl before:backdrop-saturate-200"
        {...{ [MODEL_PICKER_POPUP_ATTRIBUTE]: "" }}
        onKeyDownCapture={(event) => {
          if (onColumnKeyDown(event)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          // Tab walks the provider tabs instead of leaving (and closing) the menu.
          if (event.key !== "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          cycleTab(event.shiftKey ? -1 : 1);
        }}
      >
        {/* -m-1 bleeds over the popup body padding so dividers run edge to edge. Both
            columns share one fixed height, so switching agents never resizes the panel. */}
        <div
          ref={popupBodyRef}
          className="-m-1 flex h-[min(24rem,calc(var(--available-height)-0.5rem))] min-h-0"
        >
          <div ref={agentColumnRef} className="flex w-40 shrink-0 border-e border-border">
            <ComposerModelPickerAgentColumn
              className="w-full"
              tab={openTab}
              providerTabs={providerTabs}
              activeInstanceId={activeInstanceId}
              onSelectTab={chooseTab}
              onManageProviders={lockedProvider === null ? openProviderSettings : undefined}
            />
          </div>
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            {...{ [MODEL_PICKER_MODELS_ATTRIBUTE]: "" }}
          >
            <ComposerModelPickerProviderRows
              tab={openTab}
              providerTabs={providerTabs}
              onSelectTab={chooseTab}
            />
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 *:min-w-0">
              <SearchIcon
                aria-hidden="true"
                className={PICKER_PANEL_PLAIN_SEARCH_ICON_CLASS_NAME}
              />
              <Input
                className={PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME}
                nativeInput
                unstyled
                ref={searchInputRef}
                size="sm"
                type="search"
                aria-label="Search models"
                placeholder={tab === STARRED_TAB ? "Search starred…" : "Search models…"}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDownCapture={(event) => {
                  if (event.key === "Enter") {
                    // Focus is still in the field, so no row is highlighted: take the top hit.
                    event.preventDefault();
                    event.stopPropagation();
                    const firstRow = rows[0];
                    if (firstRow) selectRow(firstRow);
                    return;
                  }
                  if (event.key === "Tab" || MENU_NAVIGATION_KEYS.has(event.key)) return;
                  // Keep typing out of the menu's typeahead.
                  event.stopPropagation();
                }}
              />
            </div>
            <div
              role="tabpanel"
              className={cn(
                "flex min-h-20 flex-1 flex-col overflow-y-auto overscroll-contain p-1",
                COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
              )}
            >
              {modelSelectionIssue ? (
                <div role="status" className="px-2 py-1.5 text-ui leading-snug text-destructive">
                  {modelSelectionIssue}
                </div>
              ) : null}
              {noticeSource !== null ? (
                <div className="my-auto">
                  <ComposerModelPickerSourceNotice
                    source={noticeSource}
                    status={findProviderStatusForInstance({
                      providers: props.providers,
                      provider: noticeSource.provider,
                      instanceId: noticeSource.instanceId,
                    })}
                    onSignInToMoss={signInToMoss}
                    onOpenAgentSettings={openAgentSettings}
                  />
                </div>
              ) : null}
              {noticeSource !== null ? null : isTabLoading ? (
                <div className="space-y-2 px-2 py-2" aria-label="Loading models">
                  {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton
                      key={index}
                      className={cn("h-3.5 rounded-full", index % 3 === 0 ? "w-32" : "w-44")}
                    />
                  ))}
                </div>
              ) : rows.length > 0 ? (
                <div className="flex flex-col gap-px">
                  {groupRowElements(rows, (row, index) => (
                    <ComposerModelPickerRow
                      key={row.key}
                      row={row}
                      shortcutHint={
                        row.selectableModel !== null && index < MODEL_PICKER_SHORTCUT_ROW_LIMIT
                          ? `${shortcutModifierLabel}${index + 1}`
                          : null
                      }
                      providerOptions={providerOptionsFor(row.provider)}
                      runtimeModels={props.runtimeModelsByProvider?.[row.provider]}
                      prompt={promptFor(row.provider)}
                      starredModelSlots={starredModelSlots}
                      onSelect={selectRow}
                      // The footer slider owns effort in slider mode; rows stay plain.
                      onSelectEffort={usesEffortSlider ? null : selectRowWithEffort}
                      onToggleStar={toggleStarredModel}
                      onUnstarModel={unstarModel}
                    />
                  ))}
                </div>
              ) : tabAccount !== null && normalizedQuery.length === 0 ? (
                // An agent that runs but listed nothing (or could not be read) says so in
                // one plain sentence with a retry.
                <ModelPickerEmptyCatalog
                  key={tabAccount.instanceId}
                  provider={tabAccount.provider}
                  instanceId={tabAccount.instanceId}
                  agentLabel={tabAccount.agentLabel}
                  failure={discoveryError}
                  onRefresh={props.onRefreshModels}
                />
              ) : (
                <div className="px-2 py-3 text-muted-foreground text-ui leading-relaxed">
                  {normalizedQuery.length > 0
                    ? "No matches"
                    : "Star a model to pin it here together with its effort and speed, then pick it in one click."}
                </div>
              )}
            </div>
            {/* The model list gives up height first; the rows under it keep theirs. */}
            <div className="flex shrink-0 flex-col">
              {isMenuOpen && tabAccount && noticeSource === null && props.onRefreshModels ? (
                <ModelCatalogRefresh
                  key={tabAccount.instanceId}
                  provider={tabAccount.provider}
                  instanceId={tabAccount.instanceId}
                  // With models listed, a failed discovery is one quiet footer line with a
                  // retry (detail in its tooltip), never a second red notice above the list.
                  failure={rows.length > 0 ? discoveryError : null}
                  onRefresh={props.onRefreshModels}
                />
              ) : null}
              <ComposerModelPickerTraitRows
                provider={props.provider}
                providerInstanceId={props.selectedProviderInstanceId}
                threadId={threadId}
                model={props.model}
                runtimeModel={props.runtimeModel}
                runtimeAgents={props.runtimeAgents}
                modelOptions={props.modelOptions}
                prompt={props.prompt}
                onPromptChange={props.onPromptChange}
                effortControl={effortControl}
                fastModeNotice={props.provider === "claudeAgent" ? props.fastModeNotice : null}
              />
            </div>
          </div>
        </div>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
