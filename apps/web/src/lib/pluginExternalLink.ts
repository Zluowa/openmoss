// FILE: pluginExternalLink.ts
// Purpose: Validates plugin/app setup links and opens them through the desktop shell only.
// Layer: Web domain helper

import { readNativeApi } from "~/nativeApi";

export function normalizePluginExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export async function openPluginExternalUrl(value: string | null | undefined): Promise<boolean> {
  const url = normalizePluginExternalUrl(value);
  const api = readNativeApi();
  if (!url || !api) return false;
  await api.shell.openExternal(url);
  return true;
}

export function createSingleFlightPluginExternalOpener(
  open: (url: string) => Promise<boolean> = openPluginExternalUrl,
): (url: string) => Promise<boolean> {
  let pending: Promise<boolean> | null = null;
  return (url) => {
    if (pending) return pending;
    pending = open(url).finally(() => {
      pending = null;
    });
    return pending;
  };
}
