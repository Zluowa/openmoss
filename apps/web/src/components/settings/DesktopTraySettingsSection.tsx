// FILE: DesktopTraySettingsSection.tsx
// Purpose: Settings controls for desktop close-to-tray behavior and launch at login.
// Layer: Settings UI component
// Exports: DesktopTraySettingsSection

import type { DesktopBehaviorState } from "@moss/contracts";
import { useEffect, useState } from "react";

import { Switch } from "~/components/ui/switch";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

type PendingBehaviorToggle = "closeToTray" | "openAtLogin" | null;

export function DesktopTraySettingsSection() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.desktopBehavior;
  const [state, setState] = useState<DesktopBehaviorState | null>(null);
  const [pendingKey, setPendingKey] = useState<PendingBehaviorToggle>(null);

  useEffect(() => {
    if (!bridge) {
      setState(null);
      return;
    }

    let cancelled = false;
    void bridge
      .getState()
      .then((nextState) => {
        if (!cancelled) {
          setState(nextState);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge || !state) {
    return null;
  }

  if (!state.closeToTraySupported && !state.openAtLoginSupported) {
    return null;
  }

  const handleToggle = async (key: Exclude<PendingBehaviorToggle, null>, checked: boolean) => {
    if (pendingKey !== null) {
      return;
    }

    const previousState = state;
    setPendingKey(key);
    setState(
      key === "closeToTray"
        ? { ...state, closeToTray: checked }
        : { ...state, openAtLogin: checked },
    );

    try {
      const nextState =
        key === "closeToTray"
          ? await bridge.setCloseToTray(checked)
          : await bridge.setOpenAtLogin(checked);
      setState(nextState);
    } catch {
      setState(previousState);
    } finally {
      setPendingKey(null);
    }
  };

  return (
    <SettingsSection title="Desktop">
      {state.closeToTraySupported ? (
        <SettingsRow
          title="Close to system tray and keep running"
          control={
            <Switch
              checked={state.closeToTray}
              disabled={pendingKey === "closeToTray"}
              onCheckedChange={(checked) => {
                void handleToggle("closeToTray", checked);
              }}
              aria-label="Close to system tray and keep running"
            />
          }
        />
      ) : null}
      {state.openAtLoginSupported ? (
        <SettingsRow
          title="Launch at login"
          control={
            <Switch
              checked={state.openAtLogin}
              disabled={pendingKey === "openAtLogin"}
              onCheckedChange={(checked) => {
                void handleToggle("openAtLogin", checked);
              }}
              aria-label="Launch at login"
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
