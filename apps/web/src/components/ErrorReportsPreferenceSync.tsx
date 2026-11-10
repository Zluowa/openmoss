// FILE: ErrorReportsPreferenceSync.tsx
// Purpose: Applies the saved error-report setting to the renderer and Electron main, including live changes.
// Layer: Web runtime observability
// Depends on: Server settings. The server applies the same setting to itself.

import { useEffect } from "react";

import { useAppSettings } from "../appSettings";
import { setWebErrorReportsEnabled } from "../observability";

export function applyErrorReportsPreference(enabled: boolean): void {
  setWebErrorReportsEnabled(enabled);
  void window.desktopBridge?.setErrorReportsEnabled?.(enabled)?.catch(() => undefined);
}

export function ErrorReportsPreferenceSync() {
  const { serverSettings } = useAppSettings();
  // Waits for the server's answer: the local default mustn't briefly turn on reports
  // for someone who turned them off.
  const enabled = serverSettings?.errorReportsEnabled;

  useEffect(() => {
    if (enabled !== undefined) applyErrorReportsPreference(enabled);
  }, [enabled]);

  return null;
}
