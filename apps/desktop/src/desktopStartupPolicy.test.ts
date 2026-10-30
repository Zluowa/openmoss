import { describe, expect, it, vi } from "vitest";

import {
  handleDesktopSecondInstance,
  isBackgroundDesktopLaunch,
  showDesktopQuitConfirmationWindow,
  showDesktopStartupWindow,
} from "./desktopStartupPolicy";
import { openInitialBackendWindow } from "./initialBackendWindowOpen";

function createWindow(options: { focused?: boolean; minimized?: boolean } = {}) {
  const events: string[] = [];
  let focused = options.focused ?? false;
  return {
    events,
    isFocused: vi.fn(() => focused),
    isMinimized: vi.fn(() => options.minimized ?? false),
    restore: vi.fn(() => events.push("restore")),
    center: vi.fn(() => events.push("center")),
    maximize: vi.fn(() => events.push("maximize")),
    show: vi.fn(() => events.push("show-and-focus")),
    showInactive: vi.fn(() => events.push("show-inactive")),
    focus: vi.fn(() => {
      focused = true;
      events.push("focus-existing-window");
    }),
  };
}

describe("desktop background startup", () => {
  it("requires the standalone background switch", () => {
    expect(isBackgroundDesktopLaunch(["Moss.exe", "--background"])).toBe(true);
    expect(isBackgroundDesktopLaunch(["Moss.exe"])).toBe(false);
    expect(isBackgroundDesktopLaunch(["Moss.exe", "--background=false"])).toBe(false);
    expect(isBackgroundDesktopLaunch(["Moss.exe", "moss://auth/callback?background=1"])).toBe(
      false,
    );
  });

  it("keeps normal ready-to-show focus and saved maximized geometry", () => {
    const window = createWindow();

    showDesktopStartupWindow(window, { maximized: true });

    expect(window.events).toEqual(["maximize", "show-and-focus"]);
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it("keeps the existing foreground focus callback for the renderer-load fallback", () => {
    const window = createWindow();

    showDesktopStartupWindow(window, { center: true, focus: window.focus });

    expect(window.events).toEqual(["center", "focus-existing-window"]);
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it("restores background maximized geometry before the inactive reveal", () => {
    const window = createWindow();

    showDesktopStartupWindow(window, {
      background: true,
      maximized: true,
      focus: window.focus,
    });

    expect(window.events).toEqual(["maximize", "show-inactive"]);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("uses an inactive reveal for the background renderer-load fallback", () => {
    const window = createWindow();

    showDesktopStartupWindow(window, { background: true, center: true, focus: window.focus });

    expect(window.events).toEqual(["center", "show-inactive"]);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("continues normal backend readiness and renderer loading for a background launch", async () => {
    const window = createWindow();
    const order: string[] = [];
    let finishBackend!: () => void;
    const backendReady = new Promise<"listening">((resolve) => {
      finishBackend = () => resolve("listening");
    });
    let readinessInFlight: Promise<void> | null = null;
    const loadWindowApp = vi.fn(() => {
      order.push("load-renderer");
      showDesktopStartupWindow(window, { background: true, center: true, focus: window.focus });
    });

    openInitialBackendWindow({
      isDevelopment: false,
      baseUrl: "http://127.0.0.1:49152",
      hasExistingWindow: () => false,
      createWindow: () => {
        order.push("create-normal-window");
        showDesktopStartupWindow(window, { background: true });
      },
      loadWindowApp,
      getReadinessInFlight: () => readinessInFlight,
      setReadinessInFlight: (promise) => {
        readinessInFlight = promise;
      },
      waitForBackendWindowReady: () => backendReady,
      writeLog: () => {},
      isReadinessAborted: () => false,
      formatErrorMessage: String,
      warn: () => {},
    });

    expect(order).toEqual(["create-normal-window"]);
    expect(loadWindowApp).not.toHaveBeenCalled();
    finishBackend();
    await readinessInFlight;

    expect(order).toEqual(["create-normal-window", "load-renderer"]);
    expect(loadWindowApp).toHaveBeenCalledTimes(1);
    expect(window.showInactive).toHaveBeenCalledTimes(2);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
});

describe("desktop quit confirmation presentation", () => {
  it("keeps an unfocused background launch inactive", () => {
    const window = createWindow();

    showDesktopQuitConfirmationWindow(window, { background: true });

    expect(window.events).toEqual(["show-inactive"]);
    expect(window.isFocused).not.toHaveBeenCalled();
    expect(window.isFocused()).toBe(false);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("does not restore a minimized background launch to present its confirmation", () => {
    const window = createWindow({ minimized: true });

    showDesktopQuitConfirmationWindow(window, { background: true });

    expect(window.events).toEqual(["show-inactive"]);
    expect(window.isMinimized).not.toHaveBeenCalled();
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("preserves an already focused background window without a focus-state race", () => {
    const window = createWindow({ focused: true });

    showDesktopQuitConfirmationWindow(window, { background: true });

    expect(window.events).toEqual(["show-inactive"]);
    expect(window.isFocused).not.toHaveBeenCalled();
    expect(window.isFocused()).toBe(true);
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("keeps the default confirmation show and focus order", () => {
    const window = createWindow();

    showDesktopQuitConfirmationWindow(window);

    expect(window.events).toEqual(["show-and-focus", "focus-existing-window"]);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it("keeps restore, show and focus for a minimized ordinary launch", () => {
    const window = createWindow({ minimized: true });

    showDesktopQuitConfirmationWindow(window, { background: false });

    expect(window.events).toEqual(["restore", "show-and-focus", "focus-existing-window"]);
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it("does not treat a background option value as the standalone switch", () => {
    const window = createWindow({ minimized: true });

    showDesktopQuitConfirmationWindow(window, {
      background: isBackgroundDesktopLaunch(["Moss.exe", "--background=false"]),
    });

    expect(window.events).toEqual(["restore", "show-and-focus", "focus-existing-window"]);
    expect(window.showInactive).not.toHaveBeenCalled();
  });
});

describe("desktop second-instance visibility", () => {
  it("keeps ordinary activation after callback delivery", () => {
    const events: string[] = [];
    const argv = ["Moss.exe", "moss://auth/callback?code=fixture"];
    const queueAuthCallback = vi.fn(() => events.push("queue-callback"));
    const focusWindow = vi.fn(() => events.push("focus"));

    handleDesktopSecondInstance(argv, { queueAuthCallback, focusWindow });

    expect(queueAuthCallback).toHaveBeenCalledWith(argv);
    expect(events).toEqual(["queue-callback", "focus"]);
  });

  it("does not raise an existing window for a background second instance", () => {
    const argv = ["Moss.exe", "--background"];
    const queueAuthCallback = vi.fn();
    const focusWindow = vi.fn();

    handleDesktopSecondInstance(argv, { queueAuthCallback, focusWindow });

    expect(queueAuthCallback).toHaveBeenCalledWith(argv);
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it("still allows an explicit authentication callback to perform its own activation", () => {
    const argv = ["Moss.exe", "--background", "moss://auth/callback?code=fixture"];
    const callbackActivation = vi.fn();
    const focusWindow = vi.fn();

    handleDesktopSecondInstance(argv, {
      queueAuthCallback: () => callbackActivation(),
      focusWindow,
    });

    expect(callbackActivation).toHaveBeenCalledTimes(1);
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it("retains ordinary focus for a value that is not the standalone switch", () => {
    const focusWindow = vi.fn();

    handleDesktopSecondInstance(["Moss.exe", "--background=false"], {
      queueAuthCallback: vi.fn(),
      focusWindow,
    });

    expect(focusWindow).toHaveBeenCalledTimes(1);
  });
});
