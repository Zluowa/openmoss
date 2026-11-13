import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerApp, ComputerWindow, ProviderKind } from "@moss/contracts";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import {
  makeAgentGatewayComputerTools,
  type AgentGatewayComputerToolsOptions,
} from "../agentGateway/computerTools.ts";
import { alwaysAllowedAppSkipsComputerPrompt } from "../agentGateway/computerToolPermission.ts";
import type { McpToolCallResult } from "../agentGateway/protocol.ts";
import type { ToolContext } from "../agentGateway/toolRuntime.ts";

const THREAD = "thread-apps";

const CHROME_WINDOW: ComputerWindow = {
  id: "win-chrome",
  title: "New Tab",
  appName: "Google Chrome",
  pid: 3_001,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: true,
  // The desktop's own front window, holding the keyboard.
  keyboardFocused: true,
  minimized: false,
  visible: true,
};

const NOTEPAD_WINDOW: ComputerWindow = {
  id: "win-notepad",
  title: "Untitled",
  appName: "Notepad",
  pid: 3_002,
  bounds: { x: 900, y: 0, width: 600, height: 500 },
  focused: false,
  minimized: false,
  visible: true,
};

const APPS: ComputerApp[] = [
  {
    pid: 3_001,
    name: "chrome",
    launchPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    running: true,
    active: true,
    windowCount: 1,
  },
  {
    pid: 3_002,
    name: "notepad",
    launchPath: "C:\\Windows\\System32\\notepad.exe",
    running: true,
    active: false,
    windowCount: 1,
  },
];

function fixture(): FakeComputerBackend {
  return new FakeComputerBackend({ windows: [CHROME_WINDOW, NOTEPAD_WINDOW], apps: APPS });
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "moss-computer-apps-"));
  tempDirs.push(dir);
  return dir;
}

describe("Settings › Computer use: turned-off apps", () => {
  it("refuses an agent's launch, click and typing in a turned-off app with a plain reason", async () => {
    const backend = fixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    manager.setAppPolicy({ blockedApps: ["Google Chrome"], alwaysAllowedApps: [] });
    try {
      await expect(manager.launchApp(THREAD, "Google Chrome")).rejects.toMatchObject({
        code: "computer_app_blocked",
      });
      await expect(
        manager.click(THREAD, { x: 100, y: 100, windowId: CHROME_WINDOW.id }),
      ).rejects.toMatchObject({ code: "computer_app_blocked" });
      const typing = manager.typeText(THREAD, "hello", CHROME_WINDOW.id);
      await expect(typing).rejects.toMatchObject({ code: "computer_app_blocked" });
      await expect(typing).rejects.toThrow(/turned off in Moss Settings › Computer use/);
      await expect(typing).rejects.toThrow(/sent no input/);
      expect(backend.callsFor("launchApp")).toHaveLength(0);
      expect(backend.callsFor("click")).toHaveLength(0);
      expect(backend.callsFor("typeText")).toHaveLength(0);
      // Another app is untouched.
      await expect(
        manager.click(THREAD, { x: 1_000, y: 100, windowId: NOTEPAD_WINDOW.id }),
      ).resolves.toMatchObject({ action: "computer_click" });
    } finally {
      await manager.dispose();
    }
  });

  it("catches the other spellings of the same app: process name and executable", async () => {
    const backend = fixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      // Notepad's window is driven once, so Moss learns "Notepad" == notepad.exe.
      await manager.click(THREAD, { x: 1_000, y: 100, windowId: NOTEPAD_WINDOW.id });
      manager.setAppPolicy({ blockedApps: ["notepad"], alwaysAllowedApps: [] });
      await expect(
        manager.click(THREAD, { x: 1_000, y: 100, windowId: NOTEPAD_WINDOW.id }),
      ).rejects.toMatchObject({ code: "computer_app_blocked" });
      await expect(
        manager.launchApp(THREAD, "C:\\Windows\\System32\\notepad.exe"),
      ).rejects.toMatchObject({ code: "computer_app_blocked" });
      await expect(manager.launchApp(THREAD, "NOTEPAD")).rejects.toMatchObject({
        code: "computer_app_blocked",
      });
      // Exact names only: blocking "notepad" does not block "Notepad++".
      await expect(manager.launchApp(THREAD, "Notepad++")).resolves.toBeDefined();
    } finally {
      await manager.dispose();
    }
  });

  it("refuses an agent's scoped read but leaves the person at the keyboard alone", async () => {
    const backend = fixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    manager.setAppPolicy({ blockedApps: ["Google Chrome"], alwaysAllowedApps: [] });
    try {
      await expect(
        withComputerTask({ threadId: THREAD }, () =>
          manager.getState({ windowId: CHROME_WINDOW.id, includeTree: true }),
        ),
      ).rejects.toMatchObject({ code: "computer_app_blocked" });
      // No agent task and no thread: the user's own pane.
      await expect(
        manager.getState({ windowId: CHROME_WINDOW.id, includeTree: true }),
      ).resolves.toBeDefined();
      await expect(
        manager.click(undefined, { x: 100, y: 100, windowId: CHROME_WINDOW.id }),
      ).resolves.toMatchObject({ action: "computer_click" });
    } finally {
      await manager.dispose();
    }
  });

  it("turning the app back on lets the agent use it again", async () => {
    const backend = fixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      manager.setAppPolicy({ blockedApps: ["Google Chrome"], alwaysAllowedApps: [] });
      await expect(
        manager.click(THREAD, { x: 100, y: 100, windowId: CHROME_WINDOW.id }),
      ).rejects.toMatchObject({ code: "computer_app_blocked" });
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: [] });
      await expect(
        manager.click(THREAD, { x: 100, y: 100, windowId: CHROME_WINDOW.id }),
      ).resolves.toMatchObject({ action: "computer_click" });
    } finally {
      await manager.dispose();
    }
  });
});

describe("Settings › Computer use: per-call policy", () => {
  it("resolves app, window and pid targets, and blocked wins over always allowed", async () => {
    const manager = new ComputerManager({ backend: fixture(), actionSettleMs: 0 });
    try {
      await manager.listWindows();
      // A bare name proves nothing until Moss has seen the app it names.
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["Google Chrome"] });
      expect(await manager.appPolicyForCall({ app: "google chrome" })).toBeUndefined();
      await manager.typeText(THREAD, "x", CHROME_WINDOW.id);
      expect(await manager.appPolicyForCall({ app: "google chrome" })).toEqual({
        kind: "always-allowed",
        app: "google chrome",
      });
      expect(await manager.appPolicyForCall({ windowIds: [CHROME_WINDOW.id] })).toMatchObject({
        kind: "always-allowed",
      });
      expect(await manager.appPolicyForCall({ windowIds: [NOTEPAD_WINDOW.id] })).toBeUndefined();
      manager.setAppPolicy({
        blockedApps: ["Google Chrome"],
        alwaysAllowedApps: ["Google Chrome"],
      });
      expect(await manager.appPolicyForCall({ windowIds: [CHROME_WINDOW.id] })).toMatchObject({
        kind: "blocked",
      });
    } finally {
      await manager.dispose();
    }
  });

  it("never skips the prompt for an unknown window or a mixed target", async () => {
    const manager = new ComputerManager({ backend: fixture(), actionSettleMs: 0 });
    try {
      // Nothing listed yet: the window id is not assumed to be anything.
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["Google Chrome"] });
      expect(await manager.appPolicyForCall({ windowIds: [CHROME_WINDOW.id] })).toBeUndefined();
      await manager.listWindows();
      // An allowed `app` cannot carry another app's window past the prompt.
      expect(
        await manager.appPolicyForCall({ app: "Google Chrome", windowIds: [NOTEPAD_WINDOW.id] }),
      ).toBeUndefined();
      expect(await manager.appPolicyForCall({ windowIds: ["no-such-window"] })).toBeUndefined();
      expect(await manager.appPolicyForCall({})).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("only a turn-scoped desktop call may skip the prompt", () => {
    const consent = { alwaysAllowedApp: "Notepad" };
    expect(
      alwaysAllowedAppSkipsComputerPrompt({ name: "computer_click", callerTurnId: "t", consent }),
    ).toBe(true);
    expect(
      alwaysAllowedAppSkipsComputerPrompt({
        name: "computer_click",
        callerTurnId: "t",
        consent: {},
      }),
    ).toBe(false);
    expect(
      alwaysAllowedAppSkipsComputerPrompt({ name: "computer_click", callerTurnId: null, consent }),
    ).toBe(false);
    expect(
      alwaysAllowedAppSkipsComputerPrompt({
        name: "computer_read_clipboard",
        callerTurnId: "t",
        consent,
      }),
    ).toBe(false);
    expect(
      alwaysAllowedAppSkipsComputerPrompt({ name: "device_tap", callerTurnId: "t", consent }),
    ).toBe(false);
  });
});

describe("Settings › Computer use: apps Moss has used", () => {
  it("lists driven apps newest first, one row per app, and keeps them across restarts", async () => {
    const dir = await stateDir();
    const controlStatePath = join(dir, "computer-control.json");
    const first = new ComputerManager({ backend: fixture(), actionSettleMs: 0, controlStatePath });
    await first.click(THREAD, { x: 1_000, y: 100, windowId: NOTEPAD_WINDOW.id });
    await first.click(THREAD, { x: 100, y: 100, windowId: CHROME_WINDOW.id });
    await first.click(THREAD, { x: 1_000, y: 100, windowId: NOTEPAD_WINDOW.id });
    // The person's own clicks are not "Moss used it".
    await first.click(undefined, { x: 100, y: 100, windowId: CHROME_WINDOW.id });
    const listed = await first.listUsedApps();
    expect(listed.map((app) => app.name)).toEqual(["Notepad", "Google Chrome"]);
    expect(listed[0]).toMatchObject({ iconPath: "C:\\Windows\\System32\\notepad.exe" });
    await first.dispose();

    const stored = JSON.parse(await readFile(join(dir, "computer-used-apps.json"), "utf8"));
    expect(JSON.stringify(stored)).not.toContain("Untitled");
    expect(JSON.stringify(stored)).not.toContain("New Tab");

    const second = new ComputerManager({ backend: fixture(), actionSettleMs: 0, controlStatePath });
    expect((await second.listUsedApps()).map((app) => app.name)).toEqual([
      "Notepad",
      "Google Chrome",
    ]);
    await second.dispose();
  });
});

function makeContext(provider: ProviderKind = "claudeAgent"): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:apps",
      threadId: THREAD,
      provider,
      turnId: "turn-apps",
    },
    callerThreadId: THREAD,
    callerThreadLabel: null,
    callerSessionKey: "gateway-session:apps",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-apps",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
}

describe("Settings › Computer use: the gateway approval hook", () => {
  async function setup() {
    const backend = fixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const authorize = vi.fn<NonNullable<AgentGatewayComputerToolsOptions["authorizeAction"]>>(
      async () => true,
    );
    const tools = makeAgentGatewayComputerTools({
      manager,
      authorizeAction: authorize,
      resolveForegroundAuthorization: async () => ({ userRequestedVisibleUse: true }),
    });
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    const call = (name: string, args: Record<string, unknown>) =>
      Effect.runPromise(byName.get(name)!.handler(args, makeContext()));
    await manager.listWindows();
    return { backend, manager, authorize, call };
  }

  it("tells the approval path a call names only an always-allowed app", async () => {
    const { manager, authorize, call } = await setup();
    try {
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["Notepad"] });
      const allowed = await call("computer_type_text", {
        window_id: NOTEPAD_WINDOW.id,
        text: "hi",
      });
      expect(allowed.isError, JSON.stringify(resultJson(allowed))).not.toBe(true);
      expect(authorize.mock.calls.at(-1)?.[4]).toEqual({ alwaysAllowedApp: "Notepad" });
      // Another app still gets the ordinary prompt, with no hint.
      await call("computer_type_text", { window_id: CHROME_WINDOW.id, text: "hi" });
      expect(authorize.mock.calls.at(-1)).toHaveLength(4);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a turned-off app before asking the user anything", async () => {
    const { backend, manager, authorize, call } = await setup();
    try {
      manager.setAppPolicy({ blockedApps: ["Google Chrome"], alwaysAllowedApps: [] });
      const refused = await call("computer_type_text", { window_id: CHROME_WINDOW.id, text: "hi" });
      expect(refused.isError).toBe(true);
      expect(resultJson(refused)).toMatchObject({ error: { code: "computer_app_blocked" } });
      expect(authorize).not.toHaveBeenCalled();
      expect(backend.callsFor("typeText")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("asks before launching a same-named executable by path, even when the name is allowed", async () => {
    const { manager, authorize, call } = await setup();
    try {
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["Notepad"] });
      await call("computer_launch_app", { app: DOWNLOADS_NOTEPAD });
      expect(authorize).toHaveBeenCalled();
      expect(authorize.mock.calls.at(-1)).toHaveLength(4);
    } finally {
      await manager.dispose();
    }
  });
});

const DOWNLOADS_NOTEPAD = String.raw`C:\Users\me\Downloads\notepad.exe`;

describe("Settings › Computer use: always allowed never over-matches", () => {
  // Windows UWP apps and Settings share ApplicationFrameHost; Control Panel and
  // File Explorer windows share explorer.exe.
  const HOST_PID = 5_001;
  const EXPLORER_PID = 5_002;
  const hostWindow = (id: string, appName: string, pid: number): ComputerWindow => ({
    id,
    title: appName,
    appName,
    pid,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    focused: false,
    minimized: false,
    visible: true,
  });
  const CALCULATOR = hostWindow("win-calc", "Calculator", HOST_PID);
  const SETTINGS = hostWindow("win-settings", "Settings", HOST_PID);
  const FILE_EXPLORER = hostWindow("win-files", "File Explorer", EXPLORER_PID);
  const CONTROL_PANEL = hostWindow("win-control", "Control Panel", EXPLORER_PID);
  const HOST_APPS: ComputerApp[] = [
    {
      pid: HOST_PID,
      name: "ApplicationFrameHost",
      launchPath: String.raw`C:\Windows\System32\ApplicationFrameHost.exe`,
      running: true,
      active: false,
    },
    {
      pid: EXPLORER_PID,
      name: "explorer",
      launchPath: String.raw`C:\Windows\explorer.exe`,
      running: true,
      active: false,
    },
  ];

  async function hostManager() {
    const manager = new ComputerManager({
      backend: new FakeComputerBackend({
        windows: [CALCULATOR, SETTINGS, FILE_EXPLORER, CONTROL_PANEL, NOTEPAD_WINDOW],
        apps: [...HOST_APPS, ...APPS],
      }),
      actionSettleMs: 0,
    });
    await manager.listWindows();
    // Drive each window once so the used-apps alias table knows all of them.
    for (const window of [CALCULATOR, SETTINGS, FILE_EXPLORER, CONTROL_PANEL, NOTEPAD_WINDOW])
      await manager.typeText(THREAD, "x", window.id);
    return manager;
  }

  it("never allows a path argument, even one whose file name is allowed", async () => {
    const manager = await hostManager();
    try {
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["Notepad"] });
      expect((await manager.appPolicyForCall({ app: "Notepad" }))?.kind).toBe("always-allowed");
      expect(await manager.appPolicyForCall({ app: DOWNLOADS_NOTEPAD })).toBeUndefined();
      expect(await manager.appPolicyForCall({ app: "/tmp/Notepad.app" })).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("does not hand a choice to another window of a shared host process", async () => {
    const manager = await hostManager();
    try {
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["Calculator", "File Explorer"] });
      // A UWP app's window is owned by ApplicationFrameHost, a protected shared
      // host, so neither Calculator nor any of its siblings can skip the prompt.
      expect(await manager.appPolicyForCall({ windowIds: [CALCULATOR.id] })).toBeUndefined();
      expect(await manager.appPolicyForCall({ windowIds: [SETTINGS.id] })).toBeUndefined();
      expect(await manager.appPolicyForCall({ windowIds: [CONTROL_PANEL.id] })).toBeUndefined();
      expect(await manager.appPolicyForCall({ pid: HOST_PID })).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("never lets Windows Settings or Control Panel skip the prompt", async () => {
    const manager = await hostManager();
    try {
      manager.setAppPolicy({
        blockedApps: [],
        alwaysAllowedApps: ["Settings", "Control Panel", "explorer", "ApplicationFrameHost"],
      });
      for (const target of [
        { windowIds: [SETTINGS.id] },
        { windowIds: [CONTROL_PANEL.id] },
        { app: "Settings" },
        { app: "control" },
        { app: "SystemSettings.exe" },
        { pid: EXPLORER_PID },
      ]) {
        expect(await manager.appPolicyForCall(target), JSON.stringify(target)).toBeUndefined();
      }
    } finally {
      await manager.dispose();
    }
  });

  it("keeps each app a shared host shows as its own row", async () => {
    const manager = await hostManager();
    try {
      const names = (await manager.listUsedApps()).map((app) => app.name);
      for (const name of ["Calculator", "Settings", "File Explorer", "Control Panel"])
        expect(names).toContain(name);
      // Blocking Calculator does not block Settings, which shares its host.
      manager.setAppPolicy({ blockedApps: ["Calculator"], alwaysAllowedApps: [] });
      expect((await manager.appPolicyForCall({ windowIds: [CALCULATOR.id] }))?.kind).toBe(
        "blocked",
      );
      expect(await manager.appPolicyForCall({ windowIds: [SETTINGS.id] })).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("still blocks every spelling: path launches and shared-host aliases", async () => {
    const manager = await hostManager();
    try {
      manager.setAppPolicy({ blockedApps: ["Notepad"], alwaysAllowedApps: [] });
      expect((await manager.appPolicyForCall({ app: DOWNLOADS_NOTEPAD }))?.kind).toBe("blocked");
      await expect(manager.launchApp(THREAD, DOWNLOADS_NOTEPAD)).rejects.toMatchObject({
        code: "computer_app_blocked",
      });
      // Blocking the host blocks every window it owns.
      manager.setAppPolicy({ blockedApps: ["ApplicationFrameHost"], alwaysAllowedApps: [] });
      expect((await manager.appPolicyForCall({ windowIds: [CALCULATOR.id] }))?.kind).toBe(
        "blocked",
      );
      expect((await manager.appPolicyForCall({ windowIds: [SETTINGS.id] }))?.kind).toBe("blocked");
    } finally {
      await manager.dispose();
    }
  });
});

describe("Settings › Computer use: keystrokes that name no window", () => {
  it("refuses typing into a turned-off app in front, and lets other typing through", async () => {
    const backend = fixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      // Chrome is the focused window in the fixture.
      manager.setAppPolicy({ blockedApps: ["Google Chrome"], alwaysAllowedApps: [] });
      await expect(manager.typeText(THREAD, "secret")).rejects.toMatchObject({
        code: "computer_app_blocked",
      });
      await expect(manager.pressKey(THREAD, "enter")).rejects.toMatchObject({
        code: "computer_app_blocked",
      });
      expect(backend.callsFor("typeText")).toHaveLength(0);
      // The person at the keyboard, and a front app that is on, are not refused.
      await expect(manager.typeText(undefined, "mine")).resolves.toBeDefined();
      manager.setAppPolicy({ blockedApps: ["Notepad"], alwaysAllowedApps: [] });
      await expect(manager.typeText(THREAD, "ok")).resolves.toBeDefined();
    } finally {
      await manager.dispose();
    }
  });
});

describe("Settings › Computer use: always allowed is decided by identity, in any language", () => {
  // A Chinese Windows reports 「设置」 for SystemSettings.exe and 「记事本」 for notepad.exe;
  // a German one reports "Einstellungen", which no name list knows.
  const SETTINGS_PID = 6_001;
  const GERMAN_SETTINGS_PID = 6_002;
  const NOTEPAD_ZH_PID = 6_003;
  const localWindow = (id: string, appName: string, pid: number): ComputerWindow => ({
    id,
    title: appName,
    appName,
    pid,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    focused: false,
    minimized: false,
    visible: true,
  });
  const ZH_SETTINGS = localWindow("win-zh-settings", "设置", SETTINGS_PID);
  const DE_SETTINGS = localWindow("win-de-settings", "Einstellungen", GERMAN_SETTINGS_PID);
  const ZH_NOTEPAD = localWindow("win-zh-notepad", "记事本", NOTEPAD_ZH_PID);
  const LOCAL_APPS: ComputerApp[] = [
    {
      pid: SETTINGS_PID,
      name: "SystemSettings",
      launchPath: String.raw`C:\Windows\ImmersiveControlPanel\SystemSettings.exe`,
      running: true,
      active: false,
    },
    {
      pid: GERMAN_SETTINGS_PID,
      name: "SystemSettings",
      launchPath: String.raw`C:\Windows\ImmersiveControlPanel\SystemSettings.exe`,
      running: true,
      active: false,
    },
    {
      pid: NOTEPAD_ZH_PID,
      name: "notepad",
      launchPath: String.raw`C:\Windows\System32\notepad.exe`,
      running: true,
      active: false,
    },
  ];

  async function localManager() {
    const manager = new ComputerManager({
      backend: new FakeComputerBackend({
        windows: [ZH_SETTINGS, DE_SETTINGS, ZH_NOTEPAD],
        apps: LOCAL_APPS,
      }),
      actionSettleMs: 0,
    });
    await manager.listWindows();
    return manager;
  }

  it("ignores a saved choice for a protected program shown under a localized name", async () => {
    const manager = await localManager();
    try {
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["设置", "Einstellungen"] });
      for (const target of [
        { windowIds: [ZH_SETTINGS.id] },
        { windowIds: [DE_SETTINGS.id] },
        { app: "设置" },
        { app: "Einstellungen" },
        { pid: SETTINGS_PID },
      ]) {
        expect(await manager.appPolicyForCall(target), JSON.stringify(target)).toBeUndefined();
      }
      // Recorded as used, the identity travels with the row, so it stays protected.
      await manager.typeText(THREAD, "x", DE_SETTINGS.id);
      const recorded = (await manager.listUsedApps()).find((app) => app.name === "Einstellungen");
      expect(recorded).toMatchObject({ processName: "SystemSettings" });
      expect(await manager.appPolicyForCall({ app: "Einstellungen" })).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("never allows a name nothing resolves", async () => {
    const manager = new ComputerManager({ backend: fixture(), actionSettleMs: 0 });
    try {
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["记事本", "Photoshop"] });
      expect(await manager.appPolicyForCall({ app: "记事本" })).toBeUndefined();
      expect(await manager.appPolicyForCall({ app: "Photoshop" })).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("still lets an ordinary app with a Chinese name skip the prompt", async () => {
    const manager = await localManager();
    try {
      manager.setAppPolicy({ blockedApps: [], alwaysAllowedApps: ["记事本"] });
      expect(await manager.appPolicyForCall({ windowIds: [ZH_NOTEPAD.id] })).toEqual({
        kind: "always-allowed",
        app: "记事本",
      });
      await manager.typeText(THREAD, "x", ZH_NOTEPAD.id);
      expect((await manager.appPolicyForCall({ app: "记事本" }))?.kind).toBe("always-allowed");
    } finally {
      await manager.dispose();
    }
  });
});
