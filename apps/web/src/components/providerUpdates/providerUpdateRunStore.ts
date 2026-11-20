// FILE: providerUpdateRunStore.ts
// Purpose: The rail's update run: runs confirmed agent updates one at a time, because each
//          request's watchdog would otherwise expire while it waited behind another npm install,
//          and remembers how each agent's update ended so the dialog can show it row by row.
// Layer: Web client state.

import type { ServerProviderStatus } from "@moss/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { withProviderUpdateTimeout } from "~/providerUpdates";

import { toastManager } from "../ui/toast";
import type {
  ProviderUpdateI18n,
  ProviderUpdateRunProgress,
  ProviderUpdateTarget,
} from "./providerUpdateRail.logic";

/** How one agent's update in the latest run ended. */
export type ProviderUpdateRowOutcome =
  | { readonly status: "succeeded"; readonly message: string | null }
  | { readonly status: "failed"; readonly message: string | null };

interface ProviderUpdateRunState {
  /** A prompt must not rest on an advisory cached before this app session's first live check. */
  readonly liveVersionCheckCompleted: boolean;
  readonly run: ProviderUpdateRunProgress | null;
  /** Row key -> outcome, for the targets of the latest run; kept after the run ends. */
  readonly outcomes: Readonly<Record<string, ProviderUpdateRowOutcome>>;
  readonly setLiveVersionCheckCompleted: (completed: boolean) => void;
}

export const useProviderUpdateRunStore = create<ProviderUpdateRunState>((set) => ({
  liveVersionCheckCompleted: false,
  run: null,
  outcomes: {},
  setLiveVersionCheckCompleted: (completed) => set({ liveVersionCheckCompleted: completed }),
}));

function reportRequestFailure(
  target: ProviderUpdateTarget,
  error: unknown,
  i18n: ProviderUpdateI18n,
): void {
  toastManager.add({
    type: "error",
    title: i18n.format("providerUpdate.requestFailed.title", { name: target.name }),
    description:
      error instanceof Error ? error.message : i18n.t("providerUpdate.requestFailed.description"),
    ...(target.updateCommand ? { data: { copyText: target.updateCommand } } : {}),
  });
}

function outcomeFromResponse(
  target: ProviderUpdateTarget,
  response: unknown,
): ProviderUpdateRowOutcome {
  const providers = (response as { readonly providers?: ReadonlyArray<ServerProviderStatus> })
    ?.providers;
  const status = providers?.find(
    (provider) =>
      (provider.driver ?? provider.provider) === target.driver &&
      (target.instanceId === undefined || provider.instanceId === target.instanceId),
  );
  const state = status?.updateState;
  if (state?.status === "failed" || state?.status === "unchanged") {
    return { status: "failed", message: state.message };
  }
  return { status: "succeeded", message: state?.message ?? null };
}

export async function runProviderUpdates(
  targets: ReadonlyArray<ProviderUpdateTarget>,
  queryClient: QueryClient,
  i18n: ProviderUpdateI18n,
): Promise<void> {
  const store = useProviderUpdateRunStore;
  if (targets.length === 0 || store.getState().run) return;
  const total = targets.length;
  const keys = new Set(targets.map((target) => target.key));
  store.setState((state) => ({
    outcomes: Object.fromEntries(Object.entries(state.outcomes).filter(([key]) => !keys.has(key))),
  }));
  try {
    for (const [settled, target] of targets.entries()) {
      store.setState({
        run: { total, settled, currentName: target.name, currentKey: target.key },
      });
      // A failed command is not an error here: the server reports it through the agent's update
      // state, which the status pill shows. Only a request that never finished lands in catch.
      const outcome = await withProviderUpdateTimeout({
        provider: target.driver,
        request: ensureNativeApi().server.updateProvider({
          provider: target.driver,
          ...(target.instanceId ? { instanceId: target.instanceId } : {}),
        }),
      }).then(
        (response) => outcomeFromResponse(target, response),
        (error: unknown): ProviderUpdateRowOutcome => {
          reportRequestFailure(target, error, i18n);
          return {
            status: "failed",
            message:
              error instanceof Error
                ? error.message
                : i18n.t("providerUpdate.requestFailed.description"),
          };
        },
      );
      store.setState((state) => ({ outcomes: { ...state.outcomes, [target.key]: outcome } }));
    }
  } finally {
    await queryClient
      .invalidateQueries({ queryKey: serverQueryKeys.config() })
      .catch(() => undefined);
    store.setState({ run: null });
  }
}
