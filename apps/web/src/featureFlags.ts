import { useSyncExternalStore } from "react";

export type FeatureFlag =
  | {
      id: "trigger-action-failed-toasts";
      kind: "action";
      label: string;
      description: string;
    }
  | {
      id: ToggleFeatureFlagId;
      kind: "toggle";
      label: string;
      description: string;
      defaultEnabled: boolean;
    };

export type ToggleFeatureFlagId =
  | "moss-product-shell-default"
  | "persist-action-failed-debug-toasts"
  | "pin-git-progress-toast-preview"
  | "show-moss-control-plane"
  | "show-debug-task-banner";

type FeatureFlagState = Record<ToggleFeatureFlagId, boolean>;

const FEATURE_FLAG_STORAGE_KEY = "moss:feature-flags";

const DEFAULT_FEATURE_FLAG_STATE: FeatureFlagState = {
  "moss-product-shell-default": false,
  "persist-action-failed-debug-toasts": false,
  "pin-git-progress-toast-preview": false,
  "show-moss-control-plane": false,
  "show-debug-task-banner": false,
};

export const FEATURE_FLAGS: readonly FeatureFlag[] = [
  {
    id: "moss-product-shell-default",
    kind: "toggle",
    label: "Moss product shell default",
    description: "Use the Moss shell as the product-default placement for normal thread routes.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["moss-product-shell-default"],
  },
  {
    id: "trigger-action-failed-toasts",
    kind: "action",
    label: "Trigger action failed toasts",
    description: "Show stacked Git action failure toasts for local UI testing.",
  },
  {
    id: "persist-action-failed-debug-toasts",
    kind: "toggle",
    label: "Keep debug error toasts open",
    description: "Disable auto-dismiss for locally triggered error toasts.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["persist-action-failed-debug-toasts"],
  },
  {
    id: "pin-git-progress-toast-preview",
    kind: "toggle",
    label: "Pin git progress toast",
    description: "Keep a looping git progress toast visible for styling.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["pin-git-progress-toast-preview"],
  },
  {
    id: "show-debug-task-banner",
    kind: "toggle",
    label: "Show debug task banner",
    description: "Render a local sample active task banner for UI testing.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["show-debug-task-banner"],
  },
  {
    id: "show-moss-control-plane",
    kind: "toggle",
    label: "Show Moss shell",
    description:
      "Enable the explicit Moss shell route with sessions, events, launch plan, and loop ledger.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["show-moss-control-plane"],
  },
];

const listeners = new Set<() => void>();
let memoryState = DEFAULT_FEATURE_FLAG_STATE;
let cachedRawFeatureFlagState: string | null | undefined;
let cachedFeatureFlagState = DEFAULT_FEATURE_FLAG_STATE;

const NON_PERSISTED_FEATURE_FLAGS: ReadonlySet<ToggleFeatureFlagId> = new Set([
  "moss-product-shell-default",
  "show-moss-control-plane",
]);

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeFeatureFlagState(value: unknown): FeatureFlagState {
  if (!value || typeof value !== "object") {
    return DEFAULT_FEATURE_FLAG_STATE;
  }

  const record = value as Partial<Record<ToggleFeatureFlagId, unknown>>;
  const persistedBoolean = (id: ToggleFeatureFlagId): boolean =>
    NON_PERSISTED_FEATURE_FLAGS.has(id)
      ? DEFAULT_FEATURE_FLAG_STATE[id]
      : typeof record[id] === "boolean"
        ? record[id]
        : DEFAULT_FEATURE_FLAG_STATE[id];

  return {
    "moss-product-shell-default": persistedBoolean("moss-product-shell-default"),
    "persist-action-failed-debug-toasts": persistedBoolean("persist-action-failed-debug-toasts"),
    "pin-git-progress-toast-preview": persistedBoolean("pin-git-progress-toast-preview"),
    "show-moss-control-plane": persistedBoolean("show-moss-control-plane"),
    "show-debug-task-banner": persistedBoolean("show-debug-task-banner"),
  };
}

function readFeatureFlagState(): FeatureFlagState {
  if (!canUseLocalStorage()) {
    return memoryState;
  }

  try {
    const raw = window.localStorage.getItem(FEATURE_FLAG_STORAGE_KEY);
    if (raw === cachedRawFeatureFlagState) {
      return cachedFeatureFlagState;
    }

    const nextState = normalizeFeatureFlagState(raw ? JSON.parse(raw) : null);
    cachedRawFeatureFlagState = raw;
    cachedFeatureFlagState = nextState;
    return nextState;
  } catch {
    // Do not cache a raw value whose parse/read failed. Otherwise a later read of
    // that same value would match the cache key and resurrect the previous state.
    cachedRawFeatureFlagState = undefined;
    cachedFeatureFlagState = DEFAULT_FEATURE_FLAG_STATE;
    return DEFAULT_FEATURE_FLAG_STATE;
  }
}

function writeFeatureFlagState(state: FeatureFlagState): void {
  memoryState = state;

  if (canUseLocalStorage()) {
    try {
      const raw = JSON.stringify(state);
      window.localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, raw);
      cachedRawFeatureFlagState = raw;
      cachedFeatureFlagState = state;
    } catch {
      // Local feature flags are best-effort developer tools.
    }
  }

  for (const listener of listeners) {
    listener();
  }
}

function subscribeFeatureFlags(listener: () => void): () => void {
  listeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === FEATURE_FLAG_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setFeatureFlagEnabled(id: ToggleFeatureFlagId, enabled: boolean): void {
  writeFeatureFlagState({
    ...readFeatureFlagState(),
    [id]: enabled,
  });
}

export function useFeatureFlags(): FeatureFlagState {
  return useSyncExternalStore(
    subscribeFeatureFlags,
    readFeatureFlagState,
    () => DEFAULT_FEATURE_FLAG_STATE,
  );
}
