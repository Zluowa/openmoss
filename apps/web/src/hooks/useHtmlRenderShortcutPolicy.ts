// FILE: useHtmlRenderShortcutPolicy.ts
// Purpose: The app shortcuts an agent HTML render may forward, from the live keybindings.
// Layer: Web keyboard hook

import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { htmlRenderShortcutPolicy } from "~/lib/htmlRenderShortcuts";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/** Stable until the keybindings change, so frames are only told again when they do. */
export function useHtmlRenderShortcutPolicy() {
  const keybindings = useQuery(serverConfigQueryOptions()).data?.keybindings ?? EMPTY_KEYBINDINGS;
  return useMemo(() => htmlRenderShortcutPolicy(keybindings, navigator.platform), [keybindings]);
}
