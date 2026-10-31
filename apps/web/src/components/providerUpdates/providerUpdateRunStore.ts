// FILE: providerUpdateRunStore.ts
// Purpose: The rail's update run: runs confirmed agent updates one at a time, because each
//          request's watchdog would otherwise expire while it waited behind another npm install.
// Layer: Web client state.

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

interface ProviderUpdateRunState {
  /** A prompt must not rest on an advisory cached before this app session's first live check. */
  readonly liveVersionCheckCompleted: boolean;
  readonly run: ProviderUpdateRunProgress | null;
  readonly setLiveVersionCheckCompleted: (completed: boolean) => void;
}

export const useProviderUpdateRunStore = create<ProviderUpdateRunState>((set) => ({
  liveVersionCheckCompleted: false,
  run: null,
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

export async function runProviderUpdates(
  targets: ReadonlyArray<ProviderUpdateTarget>,
  queryClient: QueryClient,
  i18n: ProviderUpdateI18n,
): Promise<void> {
  const store = useProviderUpdateRunStore;
  if (targets.length === 0 || store.getState().run) return;
  const total = targets.length;
  try {
    for (const [settled, target] of targets.entries()) {
      store.setState({ run: { total, settled, currentName: target.name } });
      // A failed command is not an error here: the server reports it through the agent's update
      // state, which the status pill shows. Only a request that never finished lands in catch.
      await withProviderUpdateTimeout({
        provider: target.driver,
        request: ensureNativeApi().server.updateProvider({
          provider: target.driver,
          ...(target.instanceId ? { instanceId: target.instanceId } : {}),
        }),
      }).catch((error: unknown) => reportRequestFailure(target, error, i18n));
    }
  } finally {
    await queryClient
      .invalidateQueries({ queryKey: serverQueryKeys.config() })
      .catch(() => undefined);
    store.setState({ run: null });
  }
}
