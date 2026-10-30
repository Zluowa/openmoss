import type { ServerSettings } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import {
  activateMossChatSelection,
  MOSS_CN_IMMEDIATE_MODEL_SELECTION,
} from "./activateMossChatSelection";
import { prepareMossPostAuthChatLanding } from "./mossPostAuthLanding";

export type MossPhoneAuthenticatedSurface = "login" | "preparing" | "recovery";

export function resolveMossPhoneAuthenticatedSurface(input: {
  readonly sessionAuthenticated: boolean;
  readonly currentMutationAuthenticated: boolean;
  readonly recoveryError: string | null;
}): MossPhoneAuthenticatedSurface {
  if (!input.sessionAuthenticated && !input.currentMutationAuthenticated) return "login";
  return input.recoveryError ? "recovery" : "preparing";
}

export async function completeMossPhoneLogin(input: {
  readonly authenticated: boolean;
  readonly navigate: () => void | Promise<void>;
  readonly queryClient: QueryClient;
  /** Refreshes authoritative settings in the background after navigation starts. */
  readonly synchronize: () => Promise<ServerSettings | null>;
}): Promise<boolean> {
  if (!input.authenticated) return false;

  input.queryClient.removeQueries({ queryKey: serverQueryKeys.config(), exact: true });
  input.queryClient.removeQueries({ queryKey: serverQueryKeys.settings(), exact: true });
  // OTP success is the login boundary. Select the product-owned default and
  // enter chat immediately; provider inventory and runtime startup are internal
  // background work and the first real turn starts the managed runtime on demand.
  activateMossChatSelection(input.queryClient, MOSS_CN_IMMEDIATE_MODEL_SELECTION);
  prepareMossPostAuthChatLanding();
  void Promise.resolve()
    .then(input.synchronize)
    .then((settings) => {
      if (!settings) return;
      input.queryClient.setQueryData(serverQueryKeys.settings(), settings);
      const selection = settings.textGenerationModelSelection;
      if (selection?.instanceId === "codex_moss") {
        activateMossChatSelection(input.queryClient, selection);
      }
    })
    .catch(() => undefined);

  await input.navigate();
  return true;
}
