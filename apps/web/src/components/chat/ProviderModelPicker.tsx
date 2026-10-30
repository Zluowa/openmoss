// FILE: ProviderModelPicker.tsx
// Purpose: Renders the composer provider/model menu and supports controlled opening for shortcuts.
// Layer: Chat composer presentation
// Depends on: provider availability metadata, shared menu primitives, and picker trigger styling.

import {
  PROVIDER_DISPLAY_NAMES,
  type OmpModelOptions,
  isSupportedProviderKind,
  type ModelSlug,
  type ProviderInstanceId,
  ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { getDefaultModel, resolveSelectableModel } from "@synara/shared/model";
import { inferLegacyProviderKindFromInstanceId } from "@synara/shared/providerInstances";
import * as Schema from "effect/Schema";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { appHistory } from "../../appNavigation";
import {
  formatProviderModelOptionName,
  getOmpModelSelectionIssue,
} from "../../providerModelOptions";
import { compareProvidersByOrder } from "../../providerOrdering";
import { isMossActiveProvider } from "../../providerProductCatalog";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { MossLogo } from "../MossLogo";
import { cn } from "~/lib/utils";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  TriangleAlertIcon,
  UserIcon,
} from "~/lib/icons";
import { Button } from "../ui/button";
import { PickerPanelShell } from "./PickerPanelShell";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { ProviderModelOptionGroupList } from "./ProviderModelOptionGroupList";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
  COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME,
  COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
  COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME,
} from "./composerPickerStyles";
import { ShortcutKbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  groupProviderModelOptions,
  groupProviderModelOptionsWithFavorites,
  shouldUseCollapsibleModelGroups,
  type ProviderModelOption,
} from "../../providerModelOptions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  FAVORITE_MODEL_STORAGE_KEYS,
  favoriteModelStorageKey,
  normalizeFavoriteModelStorageKeys,
  supportsModelFavorites,
  type FavoriteModelProvider as StoredFavoriteModelProvider,
} from "../../lib/modelFavorites";
import { Skeleton } from "../ui/skeleton";
import { isProviderUsable } from "../../lib/providerAvailability";
import { useTranslation } from "../../localization";
import { isProtectedGenericSettingsProviderInstance } from "../../genericProviderSettingsProtection";
import {
  type ComposerAccountSourceKind,
  mossManagedSourceInstanceIdForProvider,
  resolveComposerAccountSourceKind,
  resolveProviderInstanceIdForProviderSwitch,
} from "./providerAccountSources";
import { curateProviderModelOptions } from "./curatedProviderModels";
import {
  MISSING_PROVIDER_INSTANCE_LABEL,
  providerAccountQualifiedLabel,
} from "../../lib/providerInstancePresentation";
import { ProviderAccountDot } from "../ProviderAccountMark";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

export function resolveLiveProviderAvailability(
  provider: ServerProviderStatus | undefined,
  providerStatusesResolved = false,
): {
  disabled: boolean;
  label: string | null;
} {
  if (!provider) {
    return {
      disabled: true,
      label: providerStatusesResolved ? "Unavailable" : "Checking",
    };
  }

  if (!provider.available) {
    return {
      disabled: true,
      label: provider.authStatus === "unauthenticated" ? "Sign in" : "Unavailable",
    };
  }

  if (provider.authStatus === "unauthenticated") {
    return {
      disabled: true,
      label: "Sign in",
    };
  }

  if (!isProviderUsable(provider)) {
    return {
      disabled: true,
      label: provider.status === "warning" ? "Check" : "Unavailable",
    };
  }

  return {
    disabled: false,
    label: null,
  };
}

export function isUnsupportedProviderInstanceStatus(status: ServerProviderStatus): boolean {
  return (
    status.availability === "unavailable" &&
    status.driver !== undefined &&
    !Schema.is(ProviderKind)(status.driver)
  );
}

export function isProviderLoginActive(status: ServerProviderStatus | undefined): boolean {
  return (
    status?.loginState?.status === "starting" ||
    status?.loginState?.status === "waiting_browser" ||
    status?.loginState?.status === "verifying"
  );
}

export function providerLoginActionClassName(loginActive: boolean): string {
  return cn(
    "ms-auto inline-flex min-h-5 items-center rounded-md px-2 text-ui-2xs font-medium leading-none",
    loginActive ? "bg-muted text-muted-foreground" : "bg-foreground text-background shadow-sm",
  );
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(
  (option) => isMossActiveProvider(option.value) && isAvailableProviderOption(option),
);
export const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(
  (option) => isMossActiveProvider(option.value) && !option.available,
);

// Removes user-hidden providers from a provider option list while always
// preserving any providers the caller marks as protected (the active and
// locked provider for the current thread). Without that carve-out, hiding the
// provider you're already using would erase the entry that lets you switch
// away from it.
function filterProviderOptionsByVisibility<T extends { value: ProviderKind }>(
  options: ReadonlyArray<T>,
  hiddenProviders: ReadonlySet<ProviderKind>,
  protectedProviders: ReadonlySet<ProviderKind>,
): ReadonlyArray<T> {
  if (hiddenProviders.size === 0) {
    return options;
  }
  return options.filter(
    (option) => protectedProviders.has(option.value) || !hiddenProviders.has(option.value),
  );
}

// Providers the picker may offer, in the user's order, minus hidden providers, always
// keeping the active/locked provider reachable. Codex and Claude are the built-in
// defaults, so they stay visible while their status is pending. Every other provider
// enters once the server projects a status for it: an unavailable projected status
// (not installed, probe failed, signed out) must remain visible so its tab can say why
// and offer setup, instead of silently vanishing from the picker.
export function resolveVisibleProviderOptions(input: {
  provider: ProviderKind;
  lockedProvider: ProviderKind | null;
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  hiddenProviders: ReadonlyArray<ProviderKind> | undefined;
  providerOrder: ReadonlyArray<ProviderKind> | undefined;
}) {
  const protectedProviderSet = new Set<ProviderKind>([input.provider]);
  if (input.lockedProvider !== null) {
    protectedProviderSet.add(input.lockedProvider);
  }
  return filterProviderOptionsByVisibility(
    AVAILABLE_PROVIDER_OPTIONS.toSorted((left, right) =>
      compareProvidersByOrder(input.providerOrder ?? [], left.value, right.value),
    ).filter(
      (option) =>
        option.value === "codex" ||
        option.value === "claudeAgent" ||
        input.providers?.some(
          (provider) =>
            (provider.driver ?? provider.provider) === option.value && provider.enabled !== false,
        ),
    ),
    new Set<ProviderKind>(input.hiddenProviders ?? []),
    protectedProviderSet,
  );
}

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  return provider === "claudeAgent" ||
    provider === "gemini" ||
    provider === "antigravity" ||
    provider === "pi" ||
    provider === "omp"
    ? "text-foreground"
    : fallbackClassName;
}

const SEARCHABLE_MODEL_PICKER_THRESHOLD = 15;
const CODEX_DEFAULT_MODEL_MENU_VALUE = "__codex_default__";
const FavoriteModelKeys = Schema.Array(Schema.String);
const EMPTY_FAVORITE_MODEL_KEYS: ReadonlyArray<string> = [];
type LegacyFavoriteModelProvider = StoredFavoriteModelProvider;
type FavoriteModelProvider = ProviderKind;

function supportsLegacyModelFavorites(
  provider: ProviderKind,
): provider is LegacyFavoriteModelProvider {
  return supportsModelFavorites(provider);
}

export interface ProviderModelFavorite {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

export interface ProviderModelPickerInstance {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
  readonly label: string;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

export type ProviderModelOptionsByProviderInstance = Partial<
  Record<ProviderInstanceId, ReadonlyArray<ProviderModelOption>>
>;

export function defaultProviderInstance(provider: ProviderKind): ProviderModelPickerInstance {
  return {
    instanceId: provider,
    provider,
    label: PROVIDER_DISPLAY_NAMES[provider],
    enabled: true,
    isDefault: true,
  };
}

export function disconnectedMossProviderInstance(
  provider: "codex" | "claudeAgent",
): ProviderModelPickerInstance {
  return {
    instanceId: provider === "codex" ? "codex_moss" : "claude_moss",
    provider,
    label: "Moss",
    enabled: false,
    isDefault: false,
  };
}

export function ComposerAccountSourceIcon(props: {
  readonly kind: ComposerAccountSourceKind;
  readonly provider: ProviderKind;
  readonly className?: string;
}) {
  const className = cn("size-3.5 shrink-0", props.className);
  if (props.kind === "moss") {
    return <MossLogo aria-hidden="true" className={className} />;
  }
  if (props.kind === "personal") {
    return <UserIcon aria-hidden="true" className={cn(className, "text-muted-foreground")} />;
  }
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[props.provider];
  return (
    <ProviderIcon
      aria-hidden="true"
      className={cn(className, providerIconClassName(props.provider, "text-muted-foreground"))}
    />
  );
}

export function findProviderStatusForInstance(input: {
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
}): ServerProviderStatus | undefined {
  return input.providers?.find(
    (entry) =>
      (entry.driver ?? entry.provider) === input.provider &&
      (entry.instanceId ?? entry.provider) === input.instanceId,
  );
}

function resolveModelOptionsForProviderInstance(input: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance | undefined;
}): ReadonlyArray<ProviderModelOption> {
  return (
    input.modelOptionsByProviderInstance?.[input.instanceId] ??
    input.modelOptionsByProvider[input.provider]
  );
}

function favoriteModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function normalizeFavoriteModels(
  favorites: ReadonlyArray<ProviderModelFavorite>,
): ProviderModelFavorite[] {
  const result: ProviderModelFavorite[] = [];
  const seen = new Set<string>();
  for (const favorite of favorites) {
    const model = favorite.model.trim();
    if (!model) {
      continue;
    }
    const key = favoriteModelKey(favorite.provider, model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ provider: favorite.provider, model });
  }
  return result;
}

function favoriteModelKeySetsFromSettings(
  favorites: ReadonlyArray<ProviderModelFavorite>,
  providerInstances: ReadonlyArray<ProviderModelPickerInstance> | undefined,
): Partial<Record<FavoriteModelProvider, ReadonlySet<string>>> {
  const result: Partial<Record<FavoriteModelProvider, Set<string>>> = {};
  const providerByInstanceId = new Map<ProviderInstanceId, ProviderKind>();
  for (const instance of providerInstances ?? []) {
    providerByInstanceId.set(instance.instanceId, instance.provider);
  }
  for (const favorite of normalizeFavoriteModels(favorites)) {
    const provider =
      providerByInstanceId.get(favorite.provider) ??
      inferLegacyProviderKindFromInstanceId(favorite.provider);
    if (!provider) {
      continue;
    }
    (result[provider] ??= new Set()).add(favoriteModelKey(favorite.provider, favorite.model));
  }
  return result;
}

function normalizeFavoriteModelKeys(
  provider: LegacyFavoriteModelProvider,
  entries: ReadonlyArray<string>,
): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) =>
          entry.includes(":") ? entry : favoriteModelKey(provider as ProviderInstanceId, entry),
        ),
    ),
  );
}

export function composerSourceSortOrder(instance: ProviderModelPickerInstance): number {
  const kind = resolveComposerAccountSourceKind(instance);
  if (kind === "moss") return 0;
  if (kind === "personal") return 1;
  return instance.isDefault ? 2 : 3;
}

// Keeps persisted favorite model keys compact and stable while preserving the user's order.
function toggleFavoriteModelKey(
  current: ReadonlyArray<string>,
  provider: LegacyFavoriteModelProvider,
  instanceId: ProviderInstanceId,
  slug: string,
): string[] {
  const normalizedCurrent = normalizeFavoriteModelKeys(provider, current);
  const key = favoriteModelKey(instanceId, slug);
  return normalizedCurrent.includes(key)
    ? normalizedCurrent.filter((entry) => entry !== key)
    : [...normalizedCurrent, key];
}

function favoriteModelSlugsForInstance(input: {
  provider: FavoriteModelProvider;
  instanceId: ProviderInstanceId;
  keys: ReadonlySet<string>;
}): ReadonlySet<string> {
  const prefix = `${input.instanceId}:`;
  const slugs = new Set<string>();
  for (const key of input.keys) {
    const normalizedKey = key.includes(":")
      ? key
      : favoriteModelKey(input.provider as ProviderInstanceId, key);
    if (normalizedKey.startsWith(prefix)) {
      slugs.add(normalizedKey.slice(prefix.length));
    }
  }
  return slugs;
}

function stripParameterizedModelSuffix(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/u, "");
}

function resolveSelectedModelLabel(input: {
  provider: ProviderKind;
  model: string;
  options: ReadonlyArray<ProviderModelOption>;
}): string {
  if (input.provider === "omp" && getOmpModelSelectionIssue(input.model, input.options)) {
    return "Select OMP model";
  }
  const resolvedSlug = resolveSelectableModel(input.provider, input.model, input.options);
  if (resolvedSlug) {
    const resolvedOption = input.options.find((option) => option.slug === resolvedSlug);
    if (resolvedOption) {
      return resolvedOption.name;
    }
  }
  if (input.provider === "cursor") {
    const baseModel = stripParameterizedModelSuffix(input.model);
    const baseMatch = input.options.find(
      (option) => stripParameterizedModelSuffix(option.slug) === baseModel,
    );
    if (baseMatch) {
      return baseMatch.name;
    }
  }
  return formatProviderModelOptionName({
    provider: input.provider,
    slug: input.model,
  });
}

function buildModelSearchText(option: ProviderModelOption): string {
  return [
    option.name,
    option.slug,
    option.description,
    option.upstreamProviderName,
    option.upstreamProviderId,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

type ProviderModelMenuItemsProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  providerStatusesResolved?: boolean;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  showProviderInstanceChoices?: boolean;
  separateAgentPicker?: boolean;
  /** Advanced Codex flyouts render models only; source controls stay outside. */
  modelListOnly?: boolean;
  selectionLocked?: boolean;
  favoriteModels?: ReadonlyArray<ProviderModelFavorite>;
  onFavoriteModelsChange?: (favoriteModels: ProviderModelFavorite[]) => void;
  disabled?: boolean;
  onProviderModelChange: (
    provider: ProviderKind,
    model: ModelSlug,
    instanceId?: ProviderInstanceId,
  ) => void;
  onProviderInstanceChange?: (provider: ProviderKind, instanceId: ProviderInstanceId) => void;
  onSignIn?: (provider: ProviderKind, instanceId: ProviderInstanceId) => void;
  onManageAccounts?: () => void;
  onProviderModelRoleSelect?: (
    model: ModelSlug,
    options: OmpModelOptions,
    instanceId: ProviderInstanceId,
  ) => void;
  // Invoked after a model selection commits so callers can close ancestor
  // menus and refocus the composer.
  onAfterSelection?: () => void;
};

// Renders only the popup body of the provider/model picker. Designed to be
// dropped into any shared picker popup or submenu so the same selection logic can
// be reused by the standalone picker and the combined composer trait picker.
export const ProviderModelMenuItems = function ProviderModelMenuItems(
  props: ProviderModelMenuItemsProps,
) {
  const { format, t } = useTranslation();
  const { onAfterSelection } = props;
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [sourcePanel, setSourcePanel] = useState<"models" | "sources">("models");
  const [cursorFavoriteModelSlugs, setCursorFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.cursor,
    EMPTY_FAVORITE_MODEL_KEYS,
    FavoriteModelKeys,
  );
  const [openCodeFavoriteModelSlugs, setOpenCodeFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.opencode,
    EMPTY_FAVORITE_MODEL_KEYS,
    FavoriteModelKeys,
  );
  const [piFavoriteModelSlugs, setPiFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.pi,
    EMPTY_FAVORITE_MODEL_KEYS,
    FavoriteModelKeys,
  );
  const deferredModelSearchQuery = useDeferredValue(modelSearchQuery);
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderInstanceId = props.selectedProviderInstanceId ?? props.provider;
  const providerLoginActionLabel = useCallback(
    (loginActive: boolean) =>
      loginActive ? t("chat.modelSource.cancelSignIn") : t("chat.modelSource.signIn"),
    [t],
  );
  const providerLoginAriaLabel = useCallback(
    (loginActive: boolean, provider: string) =>
      format(loginActive ? "chat.modelSource.cancelSignInFor" : "chat.modelSource.signInFor", {
        provider,
      }),
    [format],
  );
  const localizedAvailabilityLabel = useCallback(
    (label: string | null): string | null => {
      switch (label) {
        case "Checking":
          return t("chat.modelSource.checking");
        case "Sign in":
          return t("chat.modelSource.signIn");
        case "Disabled":
          return t("chat.modelSource.disabled");
        case "Check":
          return t("chat.modelSource.check");
        case "Unavailable":
          return t("chat.modelSource.unavailable");
        default:
          return label;
      }
    },
    [t],
  );
  useEffect(() => {
    setSourcePanel("models");
  }, [activeProvider, selectedProviderInstanceId]);
  const resolveSourceLabel = useCallback(
    (instance: ProviderModelPickerInstance): string => {
      const kind = resolveComposerAccountSourceKind(instance);
      if (kind === "moss") return t("chat.agent.source.managed");
      if (kind === "personal") return t("chat.agent.source.personal");
      return instance.label;
    },
    [t],
  );
  const hiddenProviders = props.hiddenProviders;
  const providerOrder = props.providerOrder;
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(hiddenProviders ?? []),
    [hiddenProviders],
  );
  const protectedProviderSet = useMemo(() => {
    const set = new Set<ProviderKind>([props.provider]);
    if (props.lockedProvider !== null) {
      set.add(props.lockedProvider);
    }
    return set;
  }, [props.provider, props.lockedProvider]);
  // Upstream visibility policy: only providers with an available projected
  // status (plus the active/locked provider) are offered; unavailable or
  // not-yet-known providers stay hidden instead of parking a sign-in row.
  const visibleAvailableProviderOptions = resolveVisibleProviderOptions({
    provider: props.provider,
    lockedProvider: props.lockedProvider,
    providers: props.providers,
    hiddenProviders: props.hiddenProviders,
    providerOrder,
  });
  const visibleUnavailableProviderOptions = useMemo(
    () =>
      filterProviderOptionsByVisibility(
        UNAVAILABLE_PROVIDER_OPTIONS.toSorted((left, right) =>
          compareProvidersByOrder(providerOrder ?? [], left.value, right.value),
        ),
        hiddenProviderSet,
        protectedProviderSet,
      ),
    [hiddenProviderSet, protectedProviderSet, providerOrder],
  );
  const visibleUnsupportedProviderInstances = useMemo(
    () => (props.providers ?? []).filter(isUnsupportedProviderInstanceStatus),
    [props.providers],
  );
  const openCodeFavoriteModelSlugSet = useMemo(
    () => new Set(openCodeFavoriteModelSlugs),
    [openCodeFavoriteModelSlugs],
  );
  const cursorFavoriteModelSlugSet = useMemo(
    () => new Set(cursorFavoriteModelSlugs),
    [cursorFavoriteModelSlugs],
  );
  const piFavoriteModelSlugSet = useMemo(
    () => new Set(piFavoriteModelSlugs),
    [piFavoriteModelSlugs],
  );
  const settingsFavoriteModelSlugSets = useMemo(
    () =>
      props.favoriteModels !== undefined
        ? favoriteModelKeySetsFromSettings(props.favoriteModels, props.providerInstances)
        : null,
    [props.favoriteModels, props.providerInstances],
  );
  const favoriteModelSlugSets = useMemo(
    (): Partial<Record<FavoriteModelProvider, ReadonlySet<string>>> =>
      settingsFavoriteModelSlugSets ?? {
        cursor: cursorFavoriteModelSlugSet,
        opencode: openCodeFavoriteModelSlugSet,
        pi: piFavoriteModelSlugSet,
      },
    [
      cursorFavoriteModelSlugSet,
      openCodeFavoriteModelSlugSet,
      piFavoriteModelSlugSet,
      settingsFavoriteModelSlugSets,
    ],
  );

  const providerInstancesByProvider = useMemo(() => {
    const map = new Map<ProviderKind, ProviderModelPickerInstance[]>();
    for (const provider of AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value)) {
      map.set(provider, []);
    }
    for (const instance of props.providerInstances ?? []) {
      // Devin is discovery-gated and therefore absent from the default Moss
      // provider catalog. Keep an explicitly supplied Devin instance available
      // for a bound/locked thread without advertising Devin as a new-provider
      // choice. Retired legacy instances follow the same inert path.
      const entries = map.get(instance.provider) ?? [];
      entries.push(instance);
      map.set(instance.provider, entries);
    }
    for (const provider of AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value)) {
      const entries = map.get(provider);
      if (!entries || entries.length === 0) {
        map.set(
          provider,
          props.separateAgentPicker && (provider === "codex" || provider === "claudeAgent")
            ? [disconnectedMossProviderInstance(provider), defaultProviderInstance(provider)]
            : [defaultProviderInstance(provider)],
        );
        continue;
      }
      if (provider === "codex" || provider === "claudeAgent") {
        if (props.separateAgentPicker) {
          const managedInstance = disconnectedMossProviderInstance(provider);
          if (!entries.some((instance) => instance.instanceId === managedInstance.instanceId)) {
            // Logged-out managed sources remain visible as a reconnect action;
            // disabled means they can never be selected as a runnable fallback.
            entries.push(managedInstance);
          }
        }
        if (!entries.some((instance) => instance.instanceId === provider)) {
          // A managed Moss account can exist before the user has ever connected
          // their own CLI account. Keep that personal connection route materialized
          // in the source panel instead of making the source UI disappear.
          entries.push(defaultProviderInstance(provider));
        }
      }
      entries.sort((left, right) => {
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });
    }
    return map;
  }, [props.providerInstances, props.separateAgentPicker]);

  const getProviderInstances = useCallback(
    (provider: ProviderKind): ReadonlyArray<ProviderModelPickerInstance> => {
      const explicit = providerInstancesByProvider.get(provider);
      if (explicit && explicit.length > 0) {
        return explicit;
      }
      // Devin is discovery-gated and retired drivers are compatibility-only;
      // never synthesize a runnable default or static picker row for them.
      if (!isSupportedProviderKind(provider) || provider === "devin") {
        return [];
      }
      return [defaultProviderInstance(provider)];
    },
    [providerInstancesByProvider],
  );

  const isInstanceSelectable = useCallback(
    (instance: ProviderModelPickerInstance): boolean => {
      if (!instance.enabled) {
        return false;
      }
      return !resolveLiveProviderAvailability(
        findProviderStatusForInstance({
          providers: props.providers,
          provider: instance.provider,
          instanceId: instance.instanceId,
        }),
        props.providerStatusesResolved,
      ).disabled;
    },
    [props.providerStatusesResolved, props.providers],
  );

  const getSelectedInstanceIdForProvider = useCallback(
    (provider: ProviderKind): ProviderInstanceId => {
      const instances = getProviderInstances(provider);
      return resolveProviderInstanceIdForProviderSwitch({
        activeProvider,
        activeInstanceId: selectedProviderInstanceId,
        targetProvider: provider,
        targetInstances: instances,
        isSelectable: (instanceId) => {
          const instance = instances.find((candidate) => candidate.instanceId === instanceId);
          return instance !== undefined && isInstanceSelectable(instance);
        },
      });
    },
    [activeProvider, getProviderInstances, isInstanceSelectable, selectedProviderInstanceId],
  );

  const getModelOptionsForProviderInstance = useCallback(
    (provider: ProviderKind, instanceId: ProviderInstanceId): ReadonlyArray<ProviderModelOption> =>
      resolveModelOptionsForProviderInstance({
        provider,
        instanceId,
        modelOptionsByProvider: props.modelOptionsByProvider,
        modelOptionsByProviderInstance: props.modelOptionsByProviderInstance,
      }),
    [props.modelOptionsByProvider, props.modelOptionsByProviderInstance],
  );

  const resolveInstanceAvailability = useCallback(
    (instance: ProviderModelPickerInstance): { disabled: boolean; label: string | null } => {
      if (!instance.enabled) {
        return { disabled: true, label: "Disabled" };
      }
      return resolveLiveProviderAvailability(
        findProviderStatusForInstance({
          providers: props.providers,
          provider: instance.provider,
          instanceId: instance.instanceId,
        }),
        props.providerStatusesResolved,
      );
    },
    [props.providerStatusesResolved, props.providers],
  );

  const resolveProviderOptionAvailability = useCallback(
    (provider: ProviderKind): { disabled: boolean; label: string | null } => {
      const managedTargetId = mossManagedSourceInstanceIdForProvider(
        selectedProviderInstanceId,
        provider,
      );
      if (managedTargetId && activeProvider !== provider) {
        const targetInstance = getProviderInstances(provider).find(
          (instance) => instance.instanceId === managedTargetId,
        );
        return targetInstance
          ? resolveInstanceAvailability(targetInstance)
          : { disabled: true, label: "Unavailable" };
      }
      const instanceAvailabilities = getProviderInstances(provider).map(
        resolveInstanceAvailability,
      );
      if (instanceAvailabilities.some((availability) => !availability.disabled)) {
        return { disabled: false, label: null };
      }
      return instanceAvailabilities[0] ?? { disabled: true, label: "Unavailable" };
    },
    [activeProvider, getProviderInstances, resolveInstanceAvailability, selectedProviderInstanceId],
  );

  const canSignInToInstance = useCallback(
    (instance: ProviderModelPickerInstance): boolean => {
      if (props.disabled || props.onSignIn === undefined || !instance.enabled) {
        return false;
      }
      if (instance.provider !== "codex" && instance.provider !== "claudeAgent") {
        return false;
      }
      if (isProtectedGenericSettingsProviderInstance(instance.instanceId)) {
        return false;
      }
      const providerStatus = findProviderStatusForInstance({
        providers: props.providers,
        provider: instance.provider,
        instanceId: instance.instanceId,
      });
      return (
        providerStatus?.authStatus === "unauthenticated" || isProviderLoginActive(providerStatus)
      );
    },
    [props.disabled, props.onSignIn, props.providers],
  );

  const handleModelChange = (
    provider: ProviderKind,
    value: string,
    instanceId = getSelectedInstanceIdForProvider(provider),
  ) => {
    if (props.disabled) return;
    if (!value) return;
    const providerOptions = getModelOptionsForProviderInstance(provider, instanceId);
    if (provider === "omp" && getOmpModelSelectionIssue(value, providerOptions)) return;
    const resolvedModel = resolveSelectableModel(provider, value, providerOptions);
    if (!resolvedModel) return;
    if (
      provider === activeProvider &&
      instanceId === selectedProviderInstanceId &&
      resolvedModel === props.model
    ) {
      return;
    }
    props.onProviderModelChange(provider, resolvedModel, instanceId);
  };
  const handleInstanceChange = (provider: ProviderKind, instanceId: ProviderInstanceId) => {
    if (props.disabled || !instanceId) return;
    if (props.onProviderInstanceChange) {
      props.onProviderInstanceChange(provider, instanceId);
      return;
    }
    const providerOptions = getModelOptionsForProviderInstance(provider, instanceId);
    const model = activeProvider === provider ? props.model : (providerOptions[0]?.slug ?? "");
    if (!model) return;
    const resolvedModel = resolveSelectableModel(provider, model, providerOptions);
    props.onProviderModelChange(
      provider,
      provider === "omp" && activeProvider === provider
        ? model
        : (resolvedModel ?? providerOptions[0]?.slug ?? model),
      instanceId,
    );
  };

  const renderProviderInstanceRadioGroup = (provider: ProviderKind) => {
    const instances = getProviderInstances(provider);
    const selectedInstanceId = getSelectedInstanceIdForProvider(provider);
    const selectedInstanceIsMissing =
      activeProvider === provider &&
      !instances.some((instance) => instance.instanceId === selectedInstanceId);
    if (
      props.showProviderInstanceChoices === false ||
      (instances.length <= 1 && !selectedInstanceIsMissing)
    ) {
      return null;
    }
    const sectionLabel =
      provider === "codex" || provider === "claudeAgent"
        ? t("chat.modelSource.accounts")
        : t("chat.modelSource.profiles");
    return (
      <>
        <div className="px-2.5 pb-1 pt-1.5 text-ui-xs font-medium text-muted-foreground uppercase tracking-[0.08em]">
          {sectionLabel}
        </div>
        <MenuRadioGroup
          value={selectedInstanceId}
          onValueChange={(value) => {
            if (props.disabled || !value) {
              return;
            }
            handleInstanceChange(provider, value);
          }}
        >
          {selectedInstanceIsMissing ? (
            <MenuRadioItem value={selectedInstanceId} disabled>
              <span className="truncate">{t("chat.provider.missingAccount")}</span>
              <span className="ms-auto text-ui-xs text-muted-foreground/80 uppercase tracking-[0.08em]">
                {t("chat.modelSource.unavailable")}
              </span>
            </MenuRadioItem>
          ) : null}
          {instances.map((instance) => {
            const availability = resolveInstanceAvailability(instance);
            const providerStatus = findProviderStatusForInstance({
              providers: props.providers,
              provider: instance.provider,
              instanceId: instance.instanceId,
            });
            const protectedInstance = isProtectedGenericSettingsProviderInstance(
              instance.instanceId,
            );
            if (canSignInToInstance(instance)) {
              const loginActive = isProviderLoginActive(providerStatus);
              return (
                <MenuItem
                  key={instance.instanceId}
                  aria-label={providerLoginAriaLabel(loginActive, instance.label)}
                  onClick={() => {
                    props.onSignIn?.(instance.provider, instance.instanceId);
                    onAfterSelection?.();
                  }}
                >
                  <span className="truncate" data-translation-skip="true">
                    {instance.label}
                  </span>
                  <span className={providerLoginActionClassName(loginActive)}>
                    {providerLoginActionLabel(loginActive)}
                  </span>
                </MenuItem>
              );
            }
            const statusLabel =
              protectedInstance && availability.label === "Sign in"
                ? "Unavailable"
                : availability.label;
            return (
              <MenuRadioItem
                key={instance.instanceId}
                value={instance.instanceId}
                disabled={availability.disabled}
              >
                <span className="truncate" data-translation-skip="true">
                  {instance.label}
                </span>
                {statusLabel ? (
                  <span className="ms-auto text-ui-xs text-muted-foreground/80 uppercase tracking-[0.08em]">
                    {localizedAvailabilityLabel(statusLabel)}
                  </span>
                ) : null}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
      </>
    );
  };

  const favoriteModels = props.favoriteModels;
  const onFavoriteModelsChange = props.onFavoriteModelsChange;
  const toggleFavoriteModel = useCallback(
    (provider: FavoriteModelProvider, instanceId: ProviderInstanceId, slug: string) => {
      if (onFavoriteModelsChange) {
        const normalizedFavorites = normalizeFavoriteModels(favoriteModels ?? []);
        const key = favoriteModelKey(instanceId, slug);
        const hasFavorite = normalizedFavorites.some(
          (favorite) => favoriteModelKey(favorite.provider, favorite.model) === key,
        );
        onFavoriteModelsChange(
          hasFavorite
            ? normalizedFavorites.filter(
                (favorite) => favoriteModelKey(favorite.provider, favorite.model) !== key,
              )
            : [...normalizedFavorites, { provider: instanceId, model: slug }],
        );
        return;
      }
      if (!supportsLegacyModelFavorites(provider)) {
        return;
      }
      const setFavoriteModelSlugs =
        provider === "cursor"
          ? setCursorFavoriteModelSlugs
          : provider === "pi"
            ? setPiFavoriteModelSlugs
            : setOpenCodeFavoriteModelSlugs;
      setFavoriteModelSlugs((current) =>
        toggleFavoriteModelKey(current, provider, instanceId, slug),
      );
    },
    [
      favoriteModels,
      onFavoriteModelsChange,
      setCursorFavoriteModelSlugs,
      setOpenCodeFavoriteModelSlugs,
      setPiFavoriteModelSlugs,
    ],
  );

  const renderModelRadioGroup = (provider: ProviderKind, instanceId?: ProviderInstanceId) => {
    if (props.loadingModelProviders?.[provider]) {
      return (
        <div className="space-y-2 px-2 py-2" aria-label="Loading models">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className={cn("h-3.5 rounded-full", index % 3 === 0 ? "w-24" : "w-32")} />
            </div>
          ))}
        </div>
      );
    }

    const fullProviderOptions = getModelOptionsForProviderInstance(
      provider,
      getSelectedInstanceIdForProvider(provider),
    );
    // Codex Desktop keeps a first-class Default row above the model list. It
    // represents Moss's recommended model (currently gpt-5.5) while retaining
    // explicit model rows below it. Only materialize the row when the active
    // account actually advertises that model, so a stale catalog can never
    // dispatch an unselectable slug.
    const defaultModel = provider === "codex" ? getDefaultModel("codex") : null;
    const defaultModelOption = defaultModel
      ? fullProviderOptions.find(
          (option) =>
            resolveSelectableModel(provider, defaultModel, fullProviderOptions) === option.slug,
        )
      : undefined;
    const defaultModelSelected =
      defaultModelOption !== undefined && activeProvider === provider
        ? props.model === defaultModelOption.slug
        : false;
    const favoriteProvider =
      props.onFavoriteModelsChange || supportsLegacyModelFavorites(provider) ? provider : null;
    const selectedInstanceId = instanceId ?? getSelectedInstanceIdForProvider(provider);
    const favoriteModelKeySet =
      favoriteProvider !== null ? favoriteModelSlugSets[favoriteProvider] : undefined;
    const favoriteModelSlugSet =
      favoriteProvider !== null && favoriteModelKeySet !== undefined
        ? favoriteModelSlugsForInstance({
            provider: favoriteProvider,
            instanceId: selectedInstanceId,
            keys: favoriteModelKeySet,
          })
        : undefined;
    const activeModel = activeProvider === provider ? props.model : null;
    const providerOptions = curateProviderModelOptions({
      provider,
      options: fullProviderOptions,
      activeModel,
      ...(favoriteModelSlugSet ? { favoriteModels: favoriteModelSlugSet } : {}),
      ...(activeModel
        ? {
            activeModelName: resolveSelectedModelLabel({
              provider,
              model: activeModel,
              options: fullProviderOptions,
            }),
          }
        : {}),
    }).filter(
      (option) =>
        provider !== "omp" || !getOmpModelSelectionIssue(option.slug, fullProviderOptions),
    );
    const shouldShowSearch =
      (provider === "opencode" || provider === "cursor" || provider === "pi") &&
      providerOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD;
    const normalizedModelSearchQuery = deferredModelSearchQuery.trim().toLowerCase();
    const filteredOptions =
      shouldShowSearch && normalizedModelSearchQuery.length > 0
        ? providerOptions.filter((option) =>
            buildModelSearchText(option).includes(normalizedModelSearchQuery),
          )
        : providerOptions;
    const isActiveAccount =
      activeProvider === provider &&
      selectedInstanceId === getSelectedInstanceIdForProvider(provider);
    const groupedOptions =
      favoriteModelSlugSet !== undefined
        ? groupProviderModelOptionsWithFavorites({
            options: filteredOptions,
            favoriteSlugs: favoriteModelSlugSet,
          })
        : groupProviderModelOptions(filteredOptions);

    const modelSelectionIssue =
      provider === "omp" && isActiveAccount
        ? getOmpModelSelectionIssue(props.model, fullProviderOptions)
        : null;
    const discoveryError = props.discoveryErrorsByProvider?.[provider];
    const discoveryErrorElement = (
      <>
        {modelSelectionIssue ? (
          <div role="status" className="px-2 py-1.5 text-ui leading-snug text-destructive">
            {modelSelectionIssue}
          </div>
        ) : null}
        {discoveryError ? (
          <div className="px-2 py-1.5 text-ui leading-snug text-destructive">{discoveryError}</div>
        ) : null}
      </>
    );

    const activeModelSlug = isActiveAccount
      ? (resolveSelectableModel(provider, props.model, providerOptions) ?? props.model)
      : props.model;

    const content =
      groupedOptions.length > 0 ? (
        <MenuRadioGroup
          value={
            activeProvider === provider
              ? defaultModelSelected
                ? CODEX_DEFAULT_MODEL_MENU_VALUE
                : props.model
              : ""
          }
          onValueChange={(value) =>
            handleModelChange(
              provider,
              value === CODEX_DEFAULT_MODEL_MENU_VALUE && defaultModelOption
                ? defaultModelOption.slug
                : value,
              instanceId,
            )
          }
        >
          {defaultModelOption && !props.separateAgentPicker ? (
            <MenuRadioItem
              value={CODEX_DEFAULT_MODEL_MENU_VALUE}
              aria-label={t("chat.modelPicker.default.label")}
              data-model-default="true"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{t("chat.modelPicker.default.label")}</span>
                <span className="truncate text-ui-2xs leading-tight text-muted-foreground/70">
                  {t("chat.modelPicker.default.description")}
                </span>
              </span>
            </MenuRadioItem>
          ) : null}
          <ProviderModelOptionGroupList
            groupedOptions={groupedOptions}
            provider={provider}
            activeModel={activeModelSlug}
            isSearching={normalizedModelSearchQuery.length > 0}
            instanceId={selectedInstanceId}
            favoriteProvider={favoriteProvider}
            favoriteModelSlugSet={favoriteModelSlugSet}
            onToggleFavorite={toggleFavoriteModel}
            {...(onAfterSelection ? { onAfterSelection } : {})}
          />
        </MenuRadioGroup>
      ) : provider === "omp" && normalizedModelSearchQuery.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          aria-label="Couldn’t load OMP models. Check that omp is installed and authenticated."
          tabIndex={-1}
          className="text-ui-sm flex items-start gap-1.5 px-2 py-2 text-amber-600 dark:text-amber-300/90"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>Couldn’t load OMP models — check that omp is installed and authenticated</span>
        </div>
      ) : (
        <div className="px-2 py-2 text-muted-foreground text-ui leading-snug">
          {provider === "pi" && normalizedModelSearchQuery.length === 0
            ? "No Pi models found"
            : "No matches"}
        </div>
      );

    const modelListHeading =
      provider === "codex" ? (
        <div
          className="px-2.5 pb-1 pt-1.5 text-ui-xs font-medium text-muted-foreground"
          data-model-picker-heading="true"
        >
          {t("chat.modelAndReasoning.model")}
        </div>
      ) : null;

    if (!shouldShowSearch) {
      const needsScrollContainer =
        filteredOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD ||
        shouldUseCollapsibleModelGroups(groupedOptions.length, false);
      if (needsScrollContainer) {
        return (
          <>
            {modelListHeading}
            {discoveryErrorElement}
            <div
              className={cn(
                "overflow-y-auto overscroll-contain py-0.5",
                COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
                COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME,
              )}
            >
              {content}
            </div>
          </>
        );
      }
      return (
        <>
          {modelListHeading}
          {discoveryErrorElement}
          {content}
        </>
      );
    }

    return (
      <PickerPanelShell
        searchPlaceholder="Search models or providers"
        query={modelSearchQuery}
        onQueryChange={setModelSearchQuery}
        stopSearchKeyPropagation
        autoFocusSearch
        widthClassName="w-full"
        bleedParentPadding
        listMaxHeightClassName={COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME}
      >
        {modelListHeading}
        {discoveryErrorElement}
        {content}
      </PickerPanelShell>
    );
  };

  if (props.separateAgentPicker) {
    const sourceInstances = [...getProviderInstances(activeProvider)].toSorted(
      (left, right) =>
        composerSourceSortOrder(left) - composerSourceSortOrder(right) ||
        left.label.localeCompare(right.label),
    );
    const selectedSource = sourceInstances.find(
      (instance) => instance.instanceId === selectedProviderInstanceId,
    );
    const sourceForPresentation = selectedSource ?? defaultProviderInstance(activeProvider);
    const selectedSourceKind = resolveComposerAccountSourceKind(sourceForPresentation);
    const selectedSourceLabel = selectedSource
      ? resolveSourceLabel(selectedSource)
      : t("chat.provider.missingAccount");
    const selectedSourceAvailability = selectedSource
      ? resolveInstanceAvailability(selectedSource)
      : { disabled: true, label: "Unavailable" };
    const selectedSourceModelOptions = selectedSource
      ? props.modelOptionsByProviderInstance?.[selectedSource.instanceId]
      : undefined;
    const selectedSourceHasModelCatalog =
      selectedSourceKind === "moss" &&
      selectedSource?.enabled === true &&
      selectedSourceModelOptions !== undefined &&
      selectedSourceModelOptions.length > 0;
    const personalSourceCount = sourceInstances.filter(
      (instance) => resolveComposerAccountSourceKind(instance) === "personal",
    ).length;

    if (sourcePanel === "sources") {
      return (
        <MenuGroup className="min-h-[84px]" data-moss-model-source-panel="sources">
          <div className="flex items-center gap-1 px-1 pb-1 pt-0.5">
            <Button
              variant="chrome"
              size="icon-chip"
              className="size-5 rounded-md focus-visible:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-0"
              aria-label={t("chat.modelSource.back")}
              onClick={() => setSourcePanel("models")}
            >
              <ChevronLeftIcon className="size-3" />
            </Button>
            <span className="text-ui-sm text-muted-foreground/55">
              {t("chat.modelSource.sources")}
            </span>
          </div>
          {props.onManageAccounts ? (
            <>
              <MenuItem
                onClick={() => {
                  props.onManageAccounts?.();
                  onAfterSelection?.();
                }}
              >
                <PlusIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/85" />
                <span>{t("chat.modelSource.addProviders")}</span>
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuRadioGroup
            value={selectedProviderInstanceId}
            onValueChange={(value) => {
              if (!value || props.selectionLocked) return;
              handleInstanceChange(activeProvider, value);
              setSourcePanel("models");
            }}
          >
            {sourceInstances.map((instance) => {
              const availability = resolveInstanceAvailability(instance);
              const kind = resolveComposerAccountSourceKind(instance);
              const lockedSibling =
                props.selectionLocked === true &&
                instance.instanceId !== selectedProviderInstanceId;
              const providerStatus = findProviderStatusForInstance({
                providers: props.providers,
                provider: instance.provider,
                instanceId: instance.instanceId,
              });
              const loginActive = isProviderLoginActive(providerStatus);
              const canSignIn = canSignInToInstance(instance);
              const sourceLabel =
                kind === "personal" && personalSourceCount > 1
                  ? `${resolveSourceLabel(instance)} · ${instance.label}`
                  : resolveSourceLabel(instance);

              if (canSignIn) {
                return (
                  <MenuItem
                    key={instance.instanceId}
                    aria-label={`${loginActive ? t("chat.modelSource.cancelConnect") : t("chat.modelSource.connectPersonal")} · ${instance.label}`}
                    onClick={() => {
                      props.onSignIn?.(instance.provider, instance.instanceId);
                      onAfterSelection?.();
                    }}
                  >
                    <ComposerAccountSourceIcon kind={kind} provider={instance.provider} />
                    <span className="truncate">
                      {loginActive
                        ? t("chat.modelSource.cancelConnect")
                        : t("chat.modelSource.connectPersonal")}
                    </span>
                  </MenuItem>
                );
              }

              if (
                kind === "moss" &&
                availability.disabled &&
                props.onManageAccounts !== undefined &&
                !lockedSibling
              ) {
                return (
                  <MenuItem
                    key={instance.instanceId}
                    aria-label={t("chat.modelSource.connectMoss")}
                    onClick={() => {
                      props.onManageAccounts?.();
                      onAfterSelection?.();
                    }}
                  >
                    <ComposerAccountSourceIcon kind={kind} provider={instance.provider} />
                    <span>{t("chat.modelSource.connectMoss")}</span>
                  </MenuItem>
                );
              }

              if (
                kind === "personal" &&
                availability.disabled &&
                props.onManageAccounts !== undefined &&
                !lockedSibling
              ) {
                return (
                  <MenuItem
                    key={instance.instanceId}
                    onClick={() => {
                      props.onManageAccounts?.();
                      onAfterSelection?.();
                    }}
                  >
                    <ComposerAccountSourceIcon kind={kind} provider={instance.provider} />
                    <span>{t("chat.modelSource.connectPersonal")}</span>
                  </MenuItem>
                );
              }

              const statusLabel = lockedSibling
                ? t("chat.modelSource.newThread")
                : availability.label === "Checking"
                  ? t("chat.modelSource.checking")
                  : availability.disabled
                    ? t("chat.modelSource.unavailable")
                    : null;
              return (
                <MenuRadioItem
                  key={instance.instanceId}
                  value={instance.instanceId}
                  disabled={availability.disabled || lockedSibling}
                  closeOnClick={false}
                >
                  <ComposerAccountSourceIcon kind={kind} provider={instance.provider} />
                  <span className="truncate" data-translation-skip={kind === "profile"}>
                    {sourceLabel}
                  </span>
                  {statusLabel ? (
                    <span className="ms-auto shrink-0 text-ui-2xs text-muted-foreground/70">
                      {statusLabel}
                    </span>
                  ) : null}
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
          {sourceInstances.length === 0 && props.onManageAccounts ? (
            <MenuItem
              onClick={() => {
                props.onManageAccounts?.();
                onAfterSelection?.();
              }}
            >
              <UserIcon className="size-3.5 text-muted-foreground" />
              {t("chat.modelSource.connectPersonal")}
            </MenuItem>
          ) : null}
        </MenuGroup>
      );
    }

    return (
      <MenuGroup className="min-h-[84px]" data-moss-model-source-panel="models">
        <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
          <span className="text-ui-sm text-muted-foreground/55">
            {t("chat.modelSource.models")}
          </span>
          <Button
            variant="chrome"
            size="chip"
            className="h-5 max-w-28 gap-1 rounded-sm px-1 font-normal text-ui-2xs text-muted-foreground/80 focus-visible:ring-0 focus-visible:underline"
            aria-label={`${t("chat.modelSource.change")}: ${selectedSourceLabel}`}
            onClick={() => setSourcePanel("sources")}
          >
            <ComposerAccountSourceIcon
              kind={selectedSourceKind}
              provider={activeProvider}
              className="size-3"
            />
            <span className="truncate">{selectedSourceLabel}</span>
            <ChevronRightIcon className="size-2.5 opacity-50" />
          </Button>
        </div>
        {selectedSourceAvailability.disabled ? (
          <>
            <div className="px-2.5 py-2 text-ui-sm text-muted-foreground">
              {selectedSourceKind === "personal"
                ? t("chat.modelSource.connectPersonal")
                : t("chat.modelSource.unavailable")}
            </div>
            {selectedSourceHasModelCatalog ? renderModelRadioGroup(activeProvider) : null}
          </>
        ) : (
          renderModelRadioGroup(activeProvider)
        )}
      </MenuGroup>
    );
  }

  if (props.lockedProvider !== null) {
    if (props.modelListOnly) {
      return renderModelRadioGroup(props.lockedProvider);
    }
    const status = findProviderStatusForInstance({
      providers: props.providers,
      provider: props.lockedProvider,
      instanceId: selectedProviderInstanceId,
    });
    if (status?.enabled === false) {
      return (
        <MenuItem onClick={() => appHistory.push("/settings?section=providers")}>
          Enable a provider in Settings
        </MenuItem>
      );
    }
    return (
      <>
        {renderProviderInstanceRadioGroup(props.lockedProvider)}
        {renderModelRadioGroup(props.lockedProvider)}
        <MenuSeparator />
        <MenuItem
          onClick={() => appHistory.push("/settings?section=providers&target=provider-picker")}
        >
          <PlusIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/85" />
          <span>{t("chat.modelSource.addProviders")}</span>
        </MenuItem>
      </>
    );
  }

  return (
    <>
      {visibleAvailableProviderOptions.map((option) => {
        const OptionIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[option.value];
        const availability = resolveProviderOptionAvailability(option.value);
        const instances = getProviderInstances(option.value);
        const signInInstance =
          instances.find((instance) => instance.isDefault && canSignInToInstance(instance)) ??
          instances.find(canSignInToInstance);
        const signInStatus = signInInstance
          ? findProviderStatusForInstance({
              providers: props.providers,
              provider: signInInstance.provider,
              instanceId: signInInstance.instanceId,
            })
          : undefined;
        if (
          signInInstance &&
          (availability.disabled || (instances.length === 1 && isProviderLoginActive(signInStatus)))
        ) {
          const loginActive = isProviderLoginActive(signInStatus);
          return (
            <MenuItem
              key={option.value}
              aria-label={providerLoginAriaLabel(loginActive, option.label)}
              onClick={() => {
                props.onSignIn?.(option.value, signInInstance.instanceId);
                onAfterSelection?.();
              }}
            >
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 opacity-80",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              <span>{option.label}</span>
              <span className={providerLoginActionClassName(loginActive)}>
                {providerLoginActionLabel(loginActive)}
              </span>
            </MenuItem>
          );
        }
        const accounts = getProviderInstances(option.value).filter((instance) => instance.enabled);
        if (props.showProviderInstanceChoices !== false && accounts.length > 1) {
          // Several accounts: each is its own entry, like another provider would be.
          return accounts.map((account) => {
            const accountAvailability = resolveInstanceAvailability(account);
            const accountLabel = providerAccountQualifiedLabel(option.label, account.label);
            const accountIcon = (
              <span className="relative flex shrink-0">
                <OptionIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0",
                    accountAvailability.disabled && "opacity-80",
                    providerIconClassName(option.value, "text-muted-foreground/85"),
                  )}
                />
                <ProviderAccountDot
                  accentColor={account.accentColor}
                  className="absolute -top-0.5 -right-1 size-1.5"
                />
              </span>
            );
            if (accountAvailability.disabled) {
              const canOpenProviderSettings = accountAvailability.label === "Sign in";
              return (
                <MenuItem
                  key={account.instanceId}
                  disabled={!canOpenProviderSettings}
                  onClick={
                    canOpenProviderSettings
                      ? () => appHistory.push("/settings?section=providers")
                      : undefined
                  }
                >
                  {accountIcon}
                  <span className="truncate">{accountLabel}</span>
                  <span className="ms-auto text-ui-sm text-muted-foreground/80">
                    {accountAvailability.label}
                  </span>
                </MenuItem>
              );
            }
            return (
              <MenuSub key={account.instanceId}>
                <MenuSubTrigger>
                  {accountIcon}
                  <span className="truncate">{accountLabel}</span>
                </MenuSubTrigger>
                <ComposerPickerMenuSubPopup
                  fixedWidth
                  className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
                >
                  {renderModelRadioGroup(option.value, account.instanceId)}
                </ComposerPickerMenuSubPopup>
              </MenuSub>
            );
          });
        }
        if (availability.disabled) {
          const hasPersonalUnauthenticatedInstance = instances.some((instance) => {
            if (
              !instance.enabled ||
              isProtectedGenericSettingsProviderInstance(instance.instanceId)
            ) {
              return false;
            }
            return (
              findProviderStatusForInstance({
                providers: props.providers,
                provider: instance.provider,
                instanceId: instance.instanceId,
              })?.authStatus === "unauthenticated"
            );
          });
          const canOpenProviderSettings = availability.label === "Sign in";
          const statusLabel =
            availability.label === "Sign in" && !hasPersonalUnauthenticatedInstance
              ? "Unavailable"
              : availability.label;
          return (
            <MenuItem
              key={option.value}
              disabled={!canOpenProviderSettings}
              onClick={
                canOpenProviderSettings
                  ? () => appHistory.push("/settings?section=providers")
                  : undefined
              }
            >
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 opacity-80",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              <span>{option.label}</span>
              <span className="ms-auto text-ui-xs text-muted-foreground/80">
                {localizedAvailabilityLabel(statusLabel)}
              </span>
            </MenuItem>
          );
        }
        return (
          <MenuSub key={option.value}>
            <MenuSubTrigger>
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              {option.label}
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup
              fixedWidth
              className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
            >
              {renderProviderInstanceRadioGroup(option.value)}
              {renderModelRadioGroup(option.value)}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
        );
      })}
      {visibleUnavailableProviderOptions.length > 0 && <MenuSeparator />}
      {visibleUnavailableProviderOptions.map((option) => {
        const OptionIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[option.value];
        return (
          <MenuItem key={option.value} disabled>
            <OptionIcon
              aria-hidden="true"
              className="size-3 shrink-0 text-muted-foreground/85 opacity-80"
            />
            <span>{option.label}</span>
            <span className="ms-auto text-ui-xs text-muted-foreground/80">
              {t("chat.modelSource.comingSoon")}
            </span>
          </MenuItem>
        );
      })}
      {visibleUnsupportedProviderInstances.length > 0 && <MenuSeparator />}
      {visibleUnsupportedProviderInstances.map((providerStatus) => (
        <MenuItem
          key={providerStatus.instanceId ?? providerStatus.driver ?? providerStatus.provider}
          disabled
        >
          <span className="truncate">
            {providerStatus.displayName ??
              providerStatus.instanceId ??
              providerStatus.driver ??
              providerStatus.provider}
          </span>
          <span className="ms-auto text-ui-xs text-muted-foreground/80 uppercase tracking-[0.08em]">
            Missing driver
          </span>
        </MenuItem>
      ))}
      {visibleAvailableProviderOptions.length > 0 ||
      visibleUnsupportedProviderInstances.length > 0 ? (
        <MenuSeparator />
      ) : null}
      <MenuItem
        onClick={() => appHistory.push("/settings?section=providers&target=provider-picker")}
      >
        <PlusIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/85" />
        <span>{t("chat.modelSource.addProviders")}</span>
      </MenuItem>
    </>
  );
};

export function resolveProviderModelLabel(input: {
  provider: ProviderKind;
  lockedProvider: ProviderKind | null;
  model: ModelSlug;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance | undefined;
  selectedProviderInstanceId?: ProviderInstanceId | undefined;
}): string {
  const activeProvider = input.lockedProvider ?? input.provider;
  const activeInstanceId = input.selectedProviderInstanceId ?? activeProvider;
  return resolveSelectedModelLabel({
    provider: activeProvider,
    model: input.model,
    options: resolveModelOptionsForProviderInstance({
      provider: activeProvider,
      instanceId: activeInstanceId,
      modelOptionsByProvider: input.modelOptionsByProvider,
      modelOptionsByProviderInstance: input.modelOptionsByProviderInstance,
    }),
  });
}

export function getProviderIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string = "text-muted-foreground/70",
): string {
  return providerIconClassName(provider, fallbackClassName);
}

type ProviderModelPickerProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  providerStatusesResolved?: boolean;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelOptionsByProviderInstance?: ProviderModelOptionsByProviderInstance;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance>;
  selectedProviderInstanceId?: ProviderInstanceId;
  showProviderInstanceChoices?: boolean;
  separateAgentPicker?: boolean;
  selectionLocked?: boolean;
  favoriteModels?: ReadonlyArray<ProviderModelFavorite>;
  onFavoriteModelsChange?: (favoriteModels: ProviderModelFavorite[]) => void;
  activeProviderIconClassName?: string;
  compact?: boolean;
  // Icon-only trigger for narrow composers; the model name moves to title/sr-only.
  hideLabel?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelectionCommitted?: () => void;
  shortcutLabel?: string | null;
  onProviderModelChange: (
    provider: ProviderKind,
    model: ModelSlug,
    instanceId?: ProviderInstanceId,
  ) => void;
  onProviderInstanceChange?: (provider: ProviderKind, instanceId: ProviderInstanceId) => void;
  onSignIn?: (provider: ProviderKind, instanceId: ProviderInstanceId) => void;
  onManageAccounts?: () => void;
  onProviderModelRoleSelect?: (
    model: ModelSlug,
    options: OmpModelOptions,
    instanceId: ProviderInstanceId,
  ) => void;
};

export const ProviderModelPicker = memo(function ProviderModelPicker(
  props: ProviderModelPickerProps,
) {
  const { t } = useTranslation();
  const { onOpenChange, onSelectionCommitted, open } = props;
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const selectionCommitTimerRef = useRef<number | null>(null);
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedModelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider: props.lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
    modelOptionsByProviderInstance: props.modelOptionsByProviderInstance,
    selectedProviderInstanceId: props.selectedProviderInstanceId,
  });
  const selectedProviderInstanceIsMissing =
    props.showProviderInstanceChoices !== false &&
    props.providerInstances !== undefined &&
    props.selectedProviderInstanceId !== undefined &&
    !props.providerInstances.some(
      (instance) =>
        instance.provider === activeProvider &&
        instance.instanceId === props.selectedProviderInstanceId,
    );
  const selectedSourceInstance = props.providerInstances?.find(
    (instance) =>
      instance.provider === activeProvider &&
      instance.instanceId === props.selectedProviderInstanceId,
  );
  const selectedSourceKind = resolveComposerAccountSourceKind(
    selectedSourceInstance ?? defaultProviderInstance(activeProvider),
  );
  // Upstream trigger parity: when the selected account has siblings, the trigger
  // names the account the selection runs in ("Work · GPT-5 Codex").
  const selectedAccountHasSiblings = (props.providerInstances ?? []).some(
    (instance) =>
      instance.enabled &&
      instance.provider === activeProvider &&
      instance.instanceId !== props.selectedProviderInstanceId,
  );
  const triggerLabel =
    !props.separateAgentPicker && selectedProviderInstanceIsMissing
      ? `${t("chat.provider.missingAccount")} · ${selectedModelLabel}`
      : selectedSourceInstance && selectedAccountHasSiblings
        ? providerAccountQualifiedLabel(selectedSourceInstance.label, selectedModelLabel)
        : selectedModelLabel;
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[activeProvider];
  const setMenuOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledMenuOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };
  const scheduleSelectionCommitted = () => {
    if (selectionCommitTimerRef.current !== null) {
      window.clearTimeout(selectionCommitTimerRef.current);
    }
    // Base UI restores focus to the trigger while closing; refocus callers after that tick.
    selectionCommitTimerRef.current = window.setTimeout(() => {
      selectionCommitTimerRef.current = null;
      onSelectionCommitted?.();
    }, 0);
  };
  useEffect(
    () => () => {
      if (selectionCommitTimerRef.current !== null) {
        window.clearTimeout(selectionCommitTimerRef.current);
      }
    },
    [],
  );

  const handleAfterSelection = () => {
    setMenuOpen(false);
    scheduleSelectionCommitted();
  };

  const triggerButton = (
    <PickerTriggerButton
      data-translation-skip="true"
      data-moss-provider-model-picker="true"
      disabled={props.disabled ?? false}
      compact={props.compact ?? false}
      hideLabel={props.hideLabel ?? false}
      className="text-[var(--color-text-foreground)]"
      icon={
        <span className="relative flex">
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              // opacity-100 opts out of the Button base's [&_svg]:opacity-80 dimming.
              "size-3.5 shrink-0 opacity-100",
              providerIconClassName(activeProvider, "text-muted-foreground/70"),
              props.activeProviderIconClassName,
            )}
          />
          <ProviderAccountDot
            accentColor={selectedSourceInstance?.accentColor}
            className="absolute -top-0.5 -right-1 size-1.5 ring-0"
          />
        </span>
      }
      label={triggerLabel}
      data-moss-visible-model-reasoning-control="model"
    />
  );

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(nextOpen) => {
        if (props.disabled) {
          setMenuOpen(false);
          return;
        }
        setMenuOpen(nextOpen);
      }}
    >
      {props.shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            <span className="sr-only">{triggerLabel}</span>
          </TooltipTrigger>
          {!isMenuOpen ? (
            <TooltipPopup side="top" sideOffset={6} variant="picker">
              <span className="inline-flex items-center gap-2 px-1 py-0.5">
                <span>Change model</span>
                <ShortcutKbd
                  shortcutLabel={props.shortcutLabel}
                  className="h-4 min-w-4 text-ui-2xs"
                />
              </span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
      ) : (
        <MenuTrigger render={triggerButton}>
          <span className="sr-only">{triggerLabel}</span>
        </MenuTrigger>
      )}
      <ComposerPickerMenuPopup align="start" fixedWidth>
        <ProviderModelMenuItems
          provider={props.provider}
          model={props.model}
          lockedProvider={props.lockedProvider}
          {...(props.providers ? { providers: props.providers } : {})}
          {...(props.providerStatusesResolved !== undefined
            ? { providerStatusesResolved: props.providerStatusesResolved }
            : {})}
          modelOptionsByProvider={props.modelOptionsByProvider}
          {...(props.modelOptionsByProviderInstance
            ? { modelOptionsByProviderInstance: props.modelOptionsByProviderInstance }
            : {})}
          {...(props.loadingModelProviders
            ? { loadingModelProviders: props.loadingModelProviders }
            : {})}
          {...(props.discoveryErrorsByProvider
            ? { discoveryErrorsByProvider: props.discoveryErrorsByProvider }
            : {})}
          {...(props.hiddenProviders ? { hiddenProviders: props.hiddenProviders } : {})}
          {...(props.providerOrder ? { providerOrder: props.providerOrder } : {})}
          {...(props.providerInstances ? { providerInstances: props.providerInstances } : {})}
          {...(props.selectedProviderInstanceId
            ? { selectedProviderInstanceId: props.selectedProviderInstanceId }
            : {})}
          {...(props.showProviderInstanceChoices !== undefined
            ? { showProviderInstanceChoices: props.showProviderInstanceChoices }
            : {})}
          {...(props.separateAgentPicker !== undefined
            ? { separateAgentPicker: props.separateAgentPicker }
            : {})}
          {...(props.selectionLocked !== undefined
            ? { selectionLocked: props.selectionLocked }
            : {})}
          {...(props.favoriteModels ? { favoriteModels: props.favoriteModels } : {})}
          {...(props.onFavoriteModelsChange
            ? { onFavoriteModelsChange: props.onFavoriteModelsChange }
            : {})}
          {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
          onProviderModelChange={props.onProviderModelChange}
          {...(props.onProviderInstanceChange
            ? { onProviderInstanceChange: props.onProviderInstanceChange }
            : {})}
          {...(props.onSignIn ? { onSignIn: props.onSignIn } : {})}
          {...(props.onManageAccounts ? { onManageAccounts: props.onManageAccounts } : {})}
          {...(props.onProviderModelRoleSelect
            ? { onProviderModelRoleSelect: props.onProviderModelRoleSelect }
            : {})}
          onAfterSelection={handleAfterSelection}
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
