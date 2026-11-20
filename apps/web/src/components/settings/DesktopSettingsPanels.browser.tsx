// FILE: DesktopSettingsPanels.browser.tsx
// Purpose: Lock the browser/native lifecycle behavior owned by the desktop settings panels.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopAppSnapPermissionGuideState, DesktopAppSnapState } from "@moss/contracts";
import { DEFAULT_WINDOWS_APP_SNAP_SHORTCUT } from "@moss/shared/appSnapShortcut";
import type { AppSettingsBinding } from "~/appSettings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  settings: {
    appSnapPlaySound: true,
    appSnapShortcut: { kind: "both-option-keys" as const },
    enableAppSnap: false,
    enableSystemTaskCompletionNotifications: false,
    enableTaskCompletionToasts: true,
  },
  defaults: {
    appSnapPlaySound: true,
    appSnapShortcut: { kind: "both-option-keys" as const },
    enableAppSnap: false,
    enableSystemTaskCompletionNotifications: false,
    enableTaskCompletionToasts: true,
  },
  updateSettings: vi.fn(),
  readBrowserPermission: vi.fn(() => "default"),
  requestBrowserPermission: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/env", () => ({ isElectron: false }));

vi.mock("~/notifications/taskCompletion", () => ({
  buildNotificationSettingsSupportText: (permission: string) => `Permission: ${permission}`,
  readBrowserNotificationPermissionState: harness.readBrowserPermission,
  requestBrowserNotificationPermission: harness.requestBrowserPermission,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { AppSnapSettingsPanel, NotificationsSettingsPanel } from "./DesktopSettingsPanels";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function settingsBinding(): AppSettingsBinding {
  return {
    settings: harness.settings,
    defaults: harness.defaults,
    updateSettings: harness.updateSettings,
  } as unknown as AppSettingsBinding;
}

function AppSnapActivityHarness() {
  const [active, setActive] = useState(true);
  const [settings, setSettings] = useState(() => harness.settings);
  const updateSettings = (patch: Partial<typeof harness.settings>) => {
    harness.updateSettings(patch);
    setSettings((previous) => ({ ...previous, ...patch }));
  };
  return (
    <QueryClientProvider client={queryClient}>
      <button type="button" onClick={() => setActive(false)}>
        Leave AppSnap
      </button>
      <button type="button" onClick={() => setActive(true)}>
        Return to AppSnap
      </button>
      <AppSnapSettingsPanel
        active={active}
        {...({
          settings,
          defaults: harness.defaults,
          updateSettings,
        } as unknown as AppSettingsBinding)}
      />
    </QueryClientProvider>
  );
}

const READY_STATE: DesktopAppSnapState = {
  platform: "macos",
  supported: true,
  enabled: true,
  status: "ready",
  shortcut: { kind: "both-option-keys" },
  inputMonitoringPermission: "granted",
  screenRecordingPermission: "granted",
  message: null,
  appDisplayName: "Moss (Dev)",
};

const DENIED_STATE: DesktopAppSnapState = {
  ...READY_STATE,
  status: "permission-required",
  message: "Allow the required macOS permissions, then try again.",
  inputMonitoringPermission: "denied",
  screenRecordingPermission: "denied",
};

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  harness.updateSettings.mockReset();
  harness.readBrowserPermission.mockReset().mockReturnValue("default");
  harness.requestBrowserPermission.mockReset();
  harness.toastAdd.mockReset();
  queryClient.clear();
  setDesktopBridge(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  setDesktopBridge(undefined);
});

describe("NotificationsSettingsPanel", () => {
  it("keeps the preference disabled and explains a denied browser permission", async () => {
    harness.requestBrowserPermission.mockResolvedValue("denied");
    const mounted = await render(<NotificationsSettingsPanel active {...settingsBinding()} />);

    await mounted.getByLabelText("Desktop activity notifications").click();

    await vi.waitFor(() => {
      expect(harness.updateSettings).toHaveBeenCalledWith({
        enableSystemTaskCompletionNotifications: false,
      });
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Desktop notifications unavailable",
        }),
      );
    });

    await mounted.unmount();
  });
});

describe("AppSnapSettingsPanel", () => {
  it("owns the native state subscription and releases it on unmount", async () => {
    const unsubscribe = vi.fn();
    const guideUnsubscribe = vi.fn();
    const getState = vi.fn().mockResolvedValue(READY_STATE);
    const requestPermissions = vi.fn().mockResolvedValue(READY_STATE);
    const setEnabled = vi.fn().mockResolvedValue(READY_STATE);
    const checkShortcut = vi.fn().mockResolvedValue({ available: true, reason: null });
    const setShortcut = vi.fn().mockResolvedValue({
      state: READY_STATE,
      availability: { available: true, reason: null },
    });
    const onState = vi.fn(() => unsubscribe);
    const onPermissionGuideState = vi.fn(() => guideUnsubscribe);
    setDesktopBridge({
      appSnap: {
        getState,
        requestPermissions,
        setEnabled,
        checkShortcut,
        setShortcut,
        onState,
        onPermissionGuideState,
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await expect.element(mounted.getByText("On while Moss is open")).toBeVisible();
    // Both Option keys are the two Alt keys off macOS, and the keycaps say so.
    const [leftKey, rightKey] = /Mac/.test(navigator.platform)
      ? ["⌥ left", "⌥ right"]
      : ["Left Alt", "Right Alt"];
    await expect.element(mounted.getByText(leftKey, { exact: true })).toBeVisible();
    await expect.element(mounted.getByText(rightKey, { exact: true })).toBeVisible();
    expect(onState).toHaveBeenCalledOnce();
    expect(onPermissionGuideState).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(getState).toHaveBeenCalledTimes(2));
    expect(requestPermissions).not.toHaveBeenCalled();

    await mounted.getByRole("button", { name: "Leave AppSnap" }).click();
    await expect.element(mounted.getByText("On while Moss is open")).not.toBeInTheDocument();
    // Passive-effect cleanup lags the commit by a task; the focus below must
    // land after the window-return listener has actually detached.
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(getState).toHaveBeenCalledTimes(2);
    await mounted.getByRole("button", { name: "Return to AppSnap" }).click();
    await expect.element(mounted.getByText("On while Moss is open")).toBeVisible();
    expect(onState).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    await mounted.getByLabelText("Enable AppSnap").click();
    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledOnce();
      expect(setEnabled).toHaveBeenCalledWith(true);
      expect(harness.updateSettings).toHaveBeenCalledWith({ enableAppSnap: true });
    });

    await mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(guideUnsubscribe).toHaveBeenCalledOnce();
  });

  it("records two keys, checks availability, and saves the shortcut", async () => {
    const checkShortcut = vi.fn().mockResolvedValue({ available: true, reason: null });
    const nextState = {
      ...READY_STATE,
      shortcut: { kind: "key-chord", modifier: "option", key: "KeyS" } as const,
    };
    const setShortcut = vi.fn().mockResolvedValue({
      state: nextState,
      availability: { available: true, reason: null },
    });
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(READY_STATE),
        requestPermissions: vi.fn().mockResolvedValue(READY_STATE),
        setEnabled: vi.fn().mockResolvedValue(READY_STATE),
        checkShortcut,
        setShortcut,
        onState: vi.fn(() => vi.fn()),
        onPermissionGuideState: vi.fn(() => vi.fn()),
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await mounted.getByRole("button", { name: "Record AppSnap shortcut" }).click();
    const recorder = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Record AppSnap shortcut"]',
    );
    recorder?.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "AltLeft",
        key: "Alt",
        bubbles: true,
        cancelable: true,
      }),
    );
    recorder?.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyS",
        key: "s",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect.element(mounted.getByText("Available — save to apply.")).toBeVisible();
    expect(checkShortcut).toHaveBeenCalledWith({
      kind: "key-chord",
      modifier: "option",
      key: "KeyS",
    });
    await mounted.getByRole("button", { name: "Save" }).click();
    await vi.waitFor(() => {
      expect(setShortcut).toHaveBeenCalledWith({
        kind: "key-chord",
        modifier: "option",
        key: "KeyS",
      });
      expect(harness.updateSettings).toHaveBeenCalledWith({
        appSnapShortcut: { kind: "key-chord", modifier: "option", key: "KeyS" },
      });
    });

    await mounted.unmount();
  });

  it("walks through a denied permission with the guided flow", async () => {
    const pushedStateRef: { current: ((state: DesktopAppSnapState) => void) | null } = {
      current: null,
    };
    const openPermissionSettings = vi.fn().mockResolvedValue(true);
    const restartApp = vi.fn();
    const showPermissionGuide = vi.fn().mockResolvedValue(undefined);
    const hidePermissionGuide = vi.fn().mockResolvedValue(undefined);
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(DENIED_STATE),
        requestPermissions: vi.fn().mockResolvedValue(DENIED_STATE),
        setEnabled: vi.fn().mockResolvedValue(DENIED_STATE),
        checkShortcut: vi.fn().mockResolvedValue({ available: true, reason: null }),
        setShortcut: vi.fn().mockResolvedValue({
          state: DENIED_STATE,
          availability: { available: true, reason: null },
        }),
        openPermissionSettings,
        restartApp,
        showPermissionGuide,
        hidePermissionGuide,
        onState: vi.fn((listener: (state: DesktopAppSnapState) => void) => {
          pushedStateRef.current = listener;
          return vi.fn();
        }),
        onPermissionGuideState: vi.fn(() => vi.fn()),
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await expect.element(mounted.getByText("Denied").first()).toBeVisible();

    await mounted.getByRole("button", { name: "Grant" }).first().click();
    await expect
      .element(mounted.getByRole("button", { name: "Open Input Monitoring settings" }))
      .toBeVisible();
    expect(mounted.getByText("Find Moss (Dev) in the list and turn on its toggle.")).toBeTruthy();

    await vi.waitFor(() => {
      expect(openPermissionSettings).toHaveBeenCalledWith("input-monitoring");
      expect(showPermissionGuide).toHaveBeenCalledWith("input-monitoring");
    });

    await mounted.getByRole("button", { name: "Restart Moss (Dev)" }).click();
    await vi.waitFor(() => {
      expect(restartApp).toHaveBeenCalledOnce();
    });

    pushedStateRef.current?.({ ...DENIED_STATE, inputMonitoringPermission: "granted" });
    await vi.waitFor(() => {
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "Permission granted" }),
      );
      expect(hidePermissionGuide).toHaveBeenCalled();
      expect(
        mounted.getByRole("button", { name: "Open Input Monitoring settings" }),
      ).not.toBeInTheDocument();
    });

    await mounted.unmount();
  });

  it("closes the inline guide when the native coach is dismissed", async () => {
    const pushedGuideStateRef: {
      current: ((state: DesktopAppSnapPermissionGuideState) => void) | null;
    } = { current: null };
    const openPermissionSettings = vi.fn().mockResolvedValue(true);
    const showPermissionGuide = vi.fn().mockResolvedValue(undefined);
    const hidePermissionGuide = vi.fn().mockResolvedValue(undefined);
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(DENIED_STATE),
        requestPermissions: vi.fn().mockResolvedValue(DENIED_STATE),
        setEnabled: vi.fn().mockResolvedValue(DENIED_STATE),
        checkShortcut: vi.fn().mockResolvedValue({ available: true, reason: null }),
        setShortcut: vi.fn().mockResolvedValue({
          state: DENIED_STATE,
          availability: { available: true, reason: null },
        }),
        openPermissionSettings,
        restartApp: vi.fn(),
        showPermissionGuide,
        hidePermissionGuide,
        onState: vi.fn(() => vi.fn()),
        onPermissionGuideState: vi.fn(
          (listener: (state: DesktopAppSnapPermissionGuideState) => void) => {
            pushedGuideStateRef.current = listener;
            return vi.fn();
          },
        ),
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await expect.element(mounted.getByText("Denied").first()).toBeVisible();

    await mounted.getByRole("button", { name: "Grant" }).first().click();
    await expect
      .element(mounted.getByRole("button", { name: "Open Input Monitoring settings" }))
      .toBeVisible();

    await vi.waitFor(() => {
      expect(openPermissionSettings).toHaveBeenCalledWith("input-monitoring");
      expect(showPermissionGuide).toHaveBeenCalledWith("input-monitoring");
    });

    pushedGuideStateRef.current?.("closed");
    await vi.waitFor(async () => {
      expect(hidePermissionGuide).toHaveBeenCalled();
      await expect.element(mounted.getByRole("button", { name: "Grant" }).first()).toBeVisible();
    });

    await mounted.unmount();
  });

  it("shows Alt + Shift + S by default on Windows, records multi-modifier chords, resets to Windows default, and surfaces errors honestly", async () => {
    const WINDOWS_READY: DesktopAppSnapState = {
      platform: "windows",
      supported: true,
      enabled: true,
      status: "ready",
      shortcut: DEFAULT_WINDOWS_APP_SNAP_SHORTCUT,
      inputMonitoringPermission: "unknown",
      screenRecordingPermission: "unknown",
      message: null,
      appDisplayName: "Moss",
    };
    const WINDOWS_ERROR: DesktopAppSnapState = {
      ...WINDOWS_READY,
      status: "error",
      message: "The AppSnap shortcut is already used by Windows or another app.",
    };
    const pushedStateRef: { current: ((state: DesktopAppSnapState) => void) | null } = {
      current: null,
    };
    const requestPermissions = vi.fn().mockResolvedValue(WINDOWS_READY);
    const setEnabled = vi.fn().mockResolvedValue(WINDOWS_READY);
    const checkShortcut = vi.fn().mockResolvedValue({ available: true, reason: null });
    const setShortcut = vi.fn(async (shortcut) => ({
      state: { ...WINDOWS_READY, shortcut },
      availability: { available: true, reason: null },
    }));
    setDesktopBridge({
      appSnap: {
        getState: vi.fn().mockResolvedValue(WINDOWS_READY),
        requestPermissions,
        setEnabled,
        checkShortcut,
        setShortcut,
        onState: vi.fn((listener: (state: DesktopAppSnapState) => void) => {
          pushedStateRef.current = listener;
          return vi.fn();
        }),
        onPermissionGuideState: vi.fn(() => vi.fn()),
      },
    });

    const prevSettings = { ...harness.settings };
    harness.settings = {
      ...harness.settings,
      enableAppSnap: true,
      appSnapShortcut: { kind: "both-option-keys" },
    };
    try {
      const mounted = await render(<AppSnapActivityHarness />);
      // Legacy both-option-keys normalizes to Alt + Shift + S on Windows.
      await expect.element(mounted.getByText("Capture any window with a shortcut")).toBeVisible();
      await expect.element(mounted.getByText("Press this shortcut from any app")).toBeVisible();
      const recorder = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Record AppSnap shortcut"]',
      )!;
      expect(recorder.textContent).toContain("Alt");
      expect(recorder.textContent).toContain("Shift");
      expect(recorder.textContent).toContain("S");
      expect(recorder.textContent).not.toContain("⌥");
      expect(recorder.textContent).not.toContain("Left Alt");

      // Illustration reflects the real Windows default shortcut too.
      const illustration = document.querySelector('[data-testid="appsnap-illustration"]')!;
      expect(illustration.textContent).toContain("Alt");
      expect(illustration.textContent).toContain("Shift");
      expect(illustration.textContent).toContain("S");

      // Record a 2-modifier Windows chord (Ctrl + Shift + A) and verify equal-height Save button.
      await mounted.getByRole("button", { name: "Record AppSnap shortcut" }).click();
      recorder.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "ControlLeft",
          key: "Control",
          bubbles: true,
          cancelable: true,
        }),
      );
      recorder.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "ShiftLeft",
          key: "Shift",
          bubbles: true,
          cancelable: true,
        }),
      );
      recorder.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyA",
          key: "a",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await expect.element(mounted.getByText("Available — save to apply.")).toBeVisible();
      expect(checkShortcut).toHaveBeenCalledWith({
        kind: "key-chord",
        modifier: "control",
        extraModifiers: ["shift"],
        key: "KeyA",
      });
      const saveButton = mounted.getByRole("button", { name: "Save" }).element();
      expect(
        Math.abs(
          recorder.getBoundingClientRect().height - saveButton.getBoundingClientRect().height,
        ),
      ).toBeLessThanOrEqual(1);
      await mounted.getByRole("button", { name: "Save" }).click();
      await vi.waitFor(() => {
        expect(setShortcut).toHaveBeenCalledWith({
          kind: "key-chord",
          modifier: "control",
          extraModifiers: ["shift"],
          key: "KeyA",
        });
        expect(illustration.textContent).toContain("Ctrl");
        expect(illustration.textContent).toContain("A");
      });

      // Reset button restores Windows default (Alt + Shift + S), NOT both-option-keys.
      await mounted.getByRole("button", { name: "Reset", exact: true }).click();
      await vi.waitFor(() => {
        expect(setShortcut).toHaveBeenLastCalledWith(DEFAULT_WINDOWS_APP_SNAP_SHORTCUT);
        expect(illustration.textContent).toContain("Alt");
        expect(illustration.textContent).toContain("S");
      });

      // Error state on Windows shows the real conflict message, never macOS "Needs your permission".
      pushedStateRef.current?.(WINDOWS_ERROR);
      await expect
        .element(
          mounted
            .getByText("The AppSnap shortcut is already used by Windows or another app.")
            .first(),
        )
        .toBeVisible();
      expect(document.body.textContent).not.toContain("Needs your permission");

      // Toggling enable on Windows never calls macOS requestPermissions().
      await mounted.getByLabelText("Enable AppSnap").click();
      await mounted.getByLabelText("Enable AppSnap").click();
      await vi.waitFor(() => expect(setEnabled).toHaveBeenCalled());
      expect(requestPermissions).not.toHaveBeenCalled();

      await mounted.unmount();
    } finally {
      harness.settings = prevSettings;
    }
  });
});
