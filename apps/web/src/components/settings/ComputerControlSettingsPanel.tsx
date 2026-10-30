// FILE: ComputerControlSettingsPanel.tsx
// Purpose: Minimal Moss Computer control status for desktop permissions and helper readiness.
// Layer: Settings UI components
// Exports: ComputerControlSettingsPanel

import type { ComputerStatusResult } from "@synara/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/nativeApi";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "missing-api" }
  | {
      readonly kind: "ready";
      readonly status: ComputerStatusResult;
      readonly summary: string;
    }
  | { readonly kind: "error"; readonly message: string };

function availabilityLabel(status: ComputerStatusResult): string {
  if (status.availability.kind === "unsupported-platform") {
    return status.availability.platform === "linux"
      ? "Coming soon on Linux"
      : "Unsupported on this platform";
  }
  if (status.availability.kind === "available") {
    if (!status.health.captureAvailable || !status.capabilities.capture) {
      return `Available on macOS (${status.availability.backend}); waiting for native capture helper`;
    }
    return `Available on macOS (${status.availability.backend})`;
  }
  if (status.availability.kind === "backend-unavailable") {
    return status.availability.message ?? "Backend unavailable";
  }
  if (status.availability.kind === "permission-required") {
    return status.availability.message;
  }
  return "Unavailable";
}

function helperLabel(status: ComputerStatusResult, summary: string): string {
  const parts: string[] = [];
  parts.push(status.capabilities.input ? "Input helper ready" : "Input helper not ready");
  parts.push(status.health.captureAvailable ? "Capture attached" : "Capture not attached");
  if (/cliclick/i.test(summary)) {
    parts.push("cliclick mentioned in host status");
  }
  return parts.join(" · ");
}

const ACCESSIBILITY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const SCREEN_CAPTURE_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

async function openMacPrivacyPane(url: string): Promise<boolean> {
  const bridge = window.desktopBridge;
  if (!bridge?.openExternal) return false;
  try {
    return await bridge.openExternal(url);
  } catch {
    return false;
  }
}

export function ComputerControlSettingsPanel() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    const computer = readNativeApi()?.computer;
    if (!computer) {
      setState({ kind: "missing-api" });
      return;
    }
    try {
      const status = await computer.getStatus({});
      let summary = "";
      try {
        const provision = await computer.provision({});
        summary = provision.summary?.trim() ?? "";
      } catch {
        summary = "";
      }
      setState({ kind: "ready", status, summary });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not read Computer control status.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="Computer control">
        {state.kind === "loading" ? (
          <SettingsRow
            title="Checking status…"
            description="Asking the desktop helper for Computer control availability."
          />
        ) : null}

        {state.kind === "missing-api" ? (
          <SettingsRow
            title="Desktop only"
            description="Open Moss on macOS to review Computer control. Linux support is coming soon."
          />
        ) : null}

        {state.kind === "error" ? (
          <SettingsRow
            title="Status unavailable"
            description={state.message}
            control={
              <Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        ) : null}

        {state.kind === "ready" ? (
          <>
            <SettingsRow title="Availability" description={availabilityLabel(state.status)} />
            <SettingsRow
              title="Permissions & helper"
              description={
                state.summary
                  ? `${state.summary} (${helperLabel(state.status, state.summary)})`
                  : helperLabel(state.status, state.summary)
              }
              control={
                <Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>
                  Refresh
                </Button>
              }
            />
            <SettingsRow
              title="Desktop capture"
              description={
                state.status.health.captureAvailable && state.status.capabilities.capture
                  ? "Desktop capture is ready for a Computer Use thread. Run /computer-use in chat to enable capture for the current thread; this panel does not render a live desktop preview."
                  : "Desktop capture becomes ready after Screen Recording permission and the native capture helper are ready; this panel does not render a live desktop preview."
              }
            />
          </>
        ) : null}
      </SettingsSection>

      {state.kind === "ready" && state.status.availability.kind !== "unsupported-platform" ? (
        <SettingsSection title="macOS permissions">
          <SettingsRow
            title="Privacy panes"
            description="Grant Accessibility and Screen Recording to Moss, then refresh. In chat, run /computer-use to enable control for the current thread."
            control={
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    void openMacPrivacyPane(ACCESSIBILITY_PANE).then((opened) => {
                      if (!opened) {
                        toastManager.add({
                          type: "info",
                          title: "Open System Settings",
                          description:
                            "System Settings → Privacy & Security → Accessibility → allow Moss.",
                        });
                      }
                    });
                  }}
                >
                  Accessibility
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    void openMacPrivacyPane(SCREEN_CAPTURE_PANE).then((opened) => {
                      if (!opened) {
                        toastManager.add({
                          type: "info",
                          title: "Open System Settings",
                          description:
                            "System Settings → Privacy & Security → Screen & System Audio Recording → allow Moss.",
                        });
                      }
                    });
                  }}
                >
                  Screen Recording
                </Button>
              </div>
            }
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}
