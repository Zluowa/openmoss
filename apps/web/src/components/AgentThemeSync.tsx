// FILE: AgentThemeSync.tsx
// Purpose: Applies a theme an agent published with `moss_theme_set` to this client's theme store,
//          so every connected Moss window (desktop and web) repaints when an agent sets one.
// Layer: Web root coordinator (renders nothing)

import type { MossPublishedTheme } from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { adoptPublishedTheme } from "~/hooks/useTheme";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { readNativeApi } from "~/nativeApi";

export function AgentThemeSync() {
  // Server settings arrive on connect and again on every `server.settingsUpdated` push, which
  // is how a theme the agent just set reaches this window.
  const published: MossPublishedTheme | null | undefined = useQuery(serverSettingsQueryOptions())
    .data?.agentTheme;
  useEffect(() => {
    if (published) adoptPublishedTheme(published);
  }, [published]);
  return null;
}

/**
 * Forget the theme an agent published, so a window that has not applied it yet does not apply
 * it later. Part of restoring the default look; a failure leaves this window's reset in place.
 */
export async function clearPublishedAgentTheme(
  current: MossPublishedTheme | null | undefined,
): Promise<void> {
  if (!current) return;
  await readNativeApi()
    ?.server.updateSettings({ agentTheme: null })
    .catch(() => undefined);
}
