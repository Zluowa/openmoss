import type { ServerSettings } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { activateMossChatSelection } from "./activateMossChatSelection";

export type MossCloudEmailLoginDestination = "/" | "/account";

export function resolveMossCloudEmailLoginDestination(
  addAccount: boolean,
): MossCloudEmailLoginDestination {
  return addAccount ? "/account" : "/";
}

export function shouldRedirectExistingMossCloudEmailSession(input: {
  readonly addAccount: boolean;
  readonly authenticated: boolean;
  readonly mutationIdle: boolean;
}): boolean {
  return input.authenticated && !input.addAccount && input.mutationIdle;
}

export async function completeMossCloudEmailLogin(input: {
  readonly addAccount: boolean;
  readonly authenticated: boolean;
  readonly navigate: (destination: MossCloudEmailLoginDestination) => void | Promise<void>;
  readonly queryClient: QueryClient;
  readonly synchronize?: (() => Promise<void>) | undefined;
}): Promise<boolean> {
  if (!input.authenticated) return false;

  if (!input.addAccount) {
    await input.synchronize?.();
    const selection = input.queryClient.getQueryData<ServerSettings>(
      serverQueryKeys.settings(),
    )?.textGenerationModelSelection;
    if (selection?.instanceId !== "codex_moss") return false;
    if (!activateMossChatSelection(input.queryClient)) return false;
  }
  await input.navigate(resolveMossCloudEmailLoginDestination(input.addAccount));
  return true;
}
