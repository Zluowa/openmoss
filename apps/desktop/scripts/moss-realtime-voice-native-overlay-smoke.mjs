import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const MAIN_JS = join(DESKTOP_ROOT, "dist-electron", "main.js");
const PRELOAD_JS = join(DESKTOP_ROOT, "dist-electron", "preload.js");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "server", "dist", "index.mjs");
const WEB_INDEX = join(WEB_ROOT, "dist", "index.html");
const OVERLAY_TITLE = "Moss Realtime Voice";
const OVERLAY_SIZE = Object.freeze({ width: 356, height: 320 });
const OVERLAY_ORB_CENTER = Object.freeze({ x: 76, y: 232 });
const DEFAULT_TIMEOUT_MS = 90_000;

function parseArgs(argv) {
  const options = {
    reportPath: undefined,
    screenshotPath: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--report" && next) {
      options.reportPath = resolve(next);
      index += 1;
      continue;
    }
    if (argument === "--screenshot" && next) {
      options.screenshotPath = resolve(next);
      index += 1;
      continue;
    }
    if (argument === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown native overlay smoke option: ${String(argument)}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${String(options.timeoutMs)}`);
  }
  return options;
}

function assertBuiltFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path}. Run the corresponding build first.`);
  }
}

function requireFromPackage(packageJsonPath) {
  return createRequire(resolve(REPO_ROOT, packageJsonPath));
}

function resolveElectronPath() {
  return requireFromPackage("apps/desktop/package.json")("electron");
}

function resolvePlaywrightModuleUrl() {
  const requireFromWeb = requireFromPackage("apps/web/package.json");
  return pathToFileURL(requireFromWeb.resolve("playwright", { paths: [WEB_ROOT] })).href;
}

async function importPlaywrightElectron() {
  const imported = await import(resolvePlaywrightModuleUrl());
  const electron =
    Reflect.get(imported, "_electron") ??
    (imported.default ? Reflect.get(imported.default, "_electron") : undefined);
  if (!electron) {
    throw new Error("Playwright _electron launcher is unavailable from apps/web.");
  }
  return electron;
}

function boundedPush(lines, value, prefix = "") {
  for (const line of String(value).split(/\r?\n/u)) {
    if (line.trim()) lines.push(`${prefix}${line}`);
  }
  if (lines.length > 120) lines.splice(0, lines.length - 120);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function waitForMainWindow(electronApp, timeoutMs) {
  return waitFor(
    async () =>
      electronApp.windows().find((candidate) => candidate.url().startsWith("moss://app/")) ?? null,
    timeoutMs,
    "the Moss main renderer",
  );
}

async function waitForOverlayWindow(electronApp, timeoutMs) {
  return waitFor(
    async () => {
      for (const candidate of electronApp.windows()) {
        if (!candidate.url().startsWith("data:text/html")) continue;
        const title = await candidate.title().catch(() => "");
        if (title === OVERLAY_TITLE) return candidate;
      }
      return null;
    },
    timeoutMs,
    "the native Realtime Voice overlay renderer",
  );
}

async function readNativeOverlayState(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const marker = globalThis["__mossRealtimeVoiceNativeOverlaySmoke"];
    const overlay = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === "Moss Realtime Voice",
    );
    return {
      marker: marker
        ? {
            destroyCalls: [...marker.destroyCalls],
            dragIpcCalls: [...marker.dragIpcCalls],
            ignoreMouseCalls: [...marker.ignoreMouseCalls],
            pointerIpcCalls: [...marker.pointerIpcCalls],
            sendInputCalls: [...marker.sendInputCalls],
            setBoundsCalls: [...marker.setBoundsCalls],
            showInactiveCalls: [...marker.showInactiveCalls],
          }
        : null,
      overlay: overlay
        ? {
            alwaysOnTop: overlay.isAlwaysOnTop(),
            bounds: overlay.getBounds(),
            contentBounds: overlay.getContentBounds(),
            destroyed: overlay.isDestroyed(),
            focusable: overlay.isFocusable(),
            focused: overlay.isFocused(),
            hasShadow: overlay.hasShadow(),
            maximizable: overlay.isMaximizable(),
            minimizable: overlay.isMinimizable(),
            movable: overlay.isMovable(),
            resizable: overlay.isResizable(),
            title: overlay.getTitle(),
            visible: overlay.isVisible(),
            webContentsDestroyed: overlay.webContents.isDestroyed(),
          }
        : null,
    };
  });
}

async function publish(mainPage, publication) {
  await mainPage.evaluate(async (nextPublication) => {
    const overlay = window.desktopBridge?.realtimeVoice?.overlay;
    if (!overlay) throw new Error("Desktop Realtime Voice overlay bridge is unavailable.");
    await overlay.publish(nextPublication);
  }, publication);
}

function activePublication(overrides = {}) {
  return {
    mediaOwnerActive: true,
    handoff: null,
    snapshot: {
      phase: "active",
      activity: "listening",
      inputMuted: false,
      outputMuted: false,
      error: null,
      ...overrides,
    },
  };
}

async function closeElectronApp(electronApp) {
  if (!electronApp) return;
  const processRef = electronApp.process();
  try {
    await Promise.race([
      electronApp.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out closing Electron")), 5_000),
      ),
    ]);
    return;
  } catch {
    try {
      processRef.kill("SIGTERM");
    } catch {
      // The isolated Electron process may already have exited.
    }
  }
}

async function runSmoke(options) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "moss-native-voice-overlay-smoke-"));
  const electronLogs = [];
  const browserLogs = [];
  let electronApp;
  try {
    const electron = await importPlaywrightElectron();
    const electronEnv = { ...process.env };
    delete electronEnv.VITE_DEV_SERVER_URL;
    electronApp = await electron.launch({
      executablePath: resolveElectronPath(),
      args: [`--user-data-dir=${join(runtimeDir, "electron-user-data")}`, MAIN_JS],
      cwd: DESKTOP_ROOT,
      env: {
        ...electronEnv,
        ELECTRON_ENABLE_LOGGING: "1",
        MOSS_HOME: join(runtimeDir, "moss-home"),
        DPCODE_HOME: join(runtimeDir, "moss-home"),
        T3CODE_HOME: join(runtimeDir, "moss-home"),
        T3CODE_DISABLE_AUTO_UPDATE: "1",
        HOME: runtimeDir,
        XDG_CONFIG_HOME: join(runtimeDir, "xdg-config"),
        APPDATA: join(runtimeDir, "appdata"),
        LOCALAPPDATA: join(runtimeDir, "local-appdata"),
      },
      timeout: options.timeoutMs,
    });
    const electronProcess = electronApp.process();
    electronProcess.stdout?.on("data", (chunk) => boundedPush(electronLogs, chunk, "[electron] "));
    electronProcess.stderr?.on("data", (chunk) =>
      boundedPush(electronLogs, chunk, "[electron:err] "),
    );

    await electronApp.firstWindow({ timeout: options.timeoutMs });
    const mainPage = await waitForMainWindow(electronApp, options.timeoutMs);
    mainPage.on("console", (message) =>
      boundedPush(browserLogs, message.text(), "[main:console] "),
    );
    mainPage.on("pageerror", (error) => boundedPush(browserLogs, error.message, "[main:error] "));
    await mainPage.waitForFunction(
      () => Boolean(window.desktopBridge?.realtimeVoice?.overlay),
      undefined,
      { timeout: options.timeoutMs },
    );

    const instrumentation = await electronApp.evaluate(({ BrowserWindow, ipcMain, screen }) => {
      const marker = {
        destroyCalls: [],
        dragIpcCalls: [],
        ignoreMouseCalls: [],
        pointerIpcCalls: [],
        sendInputCalls: [],
        setBoundsCalls: [],
        showInactiveCalls: [],
      };
      globalThis["__mossRealtimeVoiceNativeOverlaySmoke"] = marker;

      const browserWindowPrototype = BrowserWindow.prototype;
      const originalIgnoreMouse = browserWindowPrototype.setIgnoreMouseEvents;
      const originalShowInactive = browserWindowPrototype.showInactive;
      const originalDestroy = browserWindowPrototype.destroy;
      const originalSetBounds = browserWindowPrototype.setBounds;
      browserWindowPrototype.setIgnoreMouseEvents = function (ignore, options) {
        if (this.getTitle() === "Moss Realtime Voice") {
          marker.ignoreMouseCalls.push({
            ignore,
            forward: options?.forward === true,
            visible: this.isVisible(),
          });
        }
        return originalIgnoreMouse.call(this, ignore, options);
      };
      browserWindowPrototype.showInactive = function () {
        if (this.getTitle() === "Moss Realtime Voice") {
          marker.showInactiveCalls.push({
            focusedBefore: this.isFocused(),
            visibleBefore: this.isVisible(),
          });
        }
        return originalShowInactive.call(this);
      };
      browserWindowPrototype.destroy = function () {
        if (this.getTitle() === "Moss Realtime Voice") {
          marker.destroyCalls.push({ visibleBefore: this.isVisible() });
        }
        return originalDestroy.call(this);
      };
      browserWindowPrototype.setBounds = function (bounds, animate) {
        if (this.getTitle() === "Moss Realtime Voice") {
          marker.setBoundsCalls.push({ bounds: { ...bounds }, animate: animate === true });
        }
        return originalSetBounds.call(this, bounds, animate);
      };

      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() !== "Moss Realtime Voice",
      );
      if (!mainWindow)
        throw new Error("Moss main BrowserWindow is unavailable for instrumentation.");
      const webContentsPrototype = Object.getPrototypeOf(mainWindow.webContents);
      const originalSendInputEvent = webContentsPrototype.sendInputEvent;
      webContentsPrototype.sendInputEvent = function (event) {
        const owner = BrowserWindow.fromWebContents(this);
        if (owner?.getTitle() === "Moss Realtime Voice") {
          marker.sendInputCalls.push({
            type: event.type,
            x: event.x ?? null,
            y: event.y ?? null,
          });
        }
        return originalSendInputEvent.call(this, event);
      };
      ipcMain.on("desktop:realtime-voice-overlay-pointer-interactivity", (event, interactive) => {
        const overlay = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.getTitle() === "Moss Realtime Voice",
        );
        marker.pointerIpcCalls.push({
          interactive,
          senderId: event.sender.id,
          overlayWebContentsId: overlay?.webContents.id ?? null,
          overlayVisible: overlay?.isVisible() ?? false,
          listenerCount: ipcMain.listenerCount(
            "desktop:realtime-voice-overlay-pointer-interactivity",
          ),
        });
      });
      ipcMain.on("desktop:realtime-voice-overlay-pointer-drag", (_event, pointerDragEvent) => {
        marker.dragIpcCalls.push({
          ...pointerDragEvent,
          setBoundsCallCount: marker.setBoundsCalls.length,
        });
      });
      const actualCursor = screen.getCursorScreenPoint();
      const workArea = screen.getDisplayNearestPoint(actualCursor).workArea;
      const expectedBounds = {
        x: workArea.x + workArea.width - 16 - 356,
        y: workArea.y + workArea.height - 16 - 320,
        width: 356,
        height: 320,
      };
      const staticCursor = {
        x: expectedBounds.x + 76,
        y: expectedBounds.y + 232,
      };
      screen.getCursorScreenPoint = () => ({ ...staticCursor });
      return {
        actualCursor,
        expectedBounds,
        patched: true,
        staticCursor,
        staticCursorLocal: { x: 76, y: 232 },
        workArea,
      };
    });
    if (instrumentation.patched !== true) throw new Error("Native overlay instrumentation failed.");

    await mainPage.evaluate(() => {
      window["__mossNativeOverlayCommands"] = [];
      window["__mossNativeOverlayDisposeCommandSubscription"] =
        window.desktopBridge.realtimeVoice.overlay.onCommand((command, handoff) => {
          window["__mossNativeOverlayCommands"].push({ command, handoff });
        });
    });

    await publish(mainPage, activePublication());
    const overlayPage = await waitForOverlayWindow(electronApp, options.timeoutMs);
    overlayPage.on("console", (message) =>
      boundedPush(browserLogs, message.text(), "[overlay:console] "),
    );
    overlayPage.on("pageerror", (error) =>
      boundedPush(browserLogs, error.message, "[overlay:error] "),
    );
    await overlayPage.waitForFunction(
      () => document.body.dataset.phase === "active" && Boolean(window.realtimeVoiceOverlay),
      undefined,
      { timeout: options.timeoutMs },
    );
    // The real app renderer publishes its own inactive baseline during first
    // mount. Publish once more after that renderer is ready so the QA state is
    // the last production IPC revision, rather than racing the mount effect.
    await publish(mainPage, activePublication());
    const initialNativeState = await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        return state.overlay?.visible === true ? state : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "the visible native overlay after renderer initialization",
    );
    if (!initialNativeState.overlay)
      throw new Error("Native overlay BrowserWindow was not created.");
    if (
      initialNativeState.overlay.contentBounds.width !== OVERLAY_SIZE.width ||
      initialNativeState.overlay.contentBounds.height !== OVERLAY_SIZE.height
    ) {
      throw new Error(
        `Unexpected native content bounds: ${JSON.stringify(initialNativeState.overlay.contentBounds)}`,
      );
    }

    const stationaryCursor = {
      actualCursor: instrumentation.actualCursor,
      bounds: instrumentation.expectedBounds,
      cursor: instrumentation.staticCursor,
      local: instrumentation.staticCursorLocal,
      source: "instrumented screen.getCursorScreenPoint in isolated Electron process",
    };
    await publish(
      mainPage,
      activePublication({
        audioSignal: { low: 0.1, mid: 0.2, high: 0.3, overall: 0.2 },
      }),
    );
    await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        const enabled = state.marker?.ignoreMouseCalls.some((call) => call.ignore === false);
        const cursorInjected = state.marker?.sendInputCalls.some(
          (call) =>
            call.type === "mouseMove" &&
            call.x === OVERLAY_ORB_CENTER.x &&
            call.y === OVERLAY_ORB_CENTER.y,
        );
        return enabled && cursorInjected ? state : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "stationary-cursor native hit synchronization",
    );
    await overlayPage.waitForFunction(() => document.body.dataset.pointerInteractive === "true");
    const stationaryCursorState = await readNativeOverlayState(electronApp);

    // The first real pointer click must work without a preliminary physical
    // mousemove; the main process injected the stationary-cursor mouseMove above.
    await overlayPage.mouse.click(OVERLAY_ORB_CENTER.x, OVERLAY_ORB_CENTER.y);
    const stationaryClickReceipt = await waitFor(
      () =>
        mainPage.evaluate(() => {
          const commands = window["__mossNativeOverlayCommands"] ?? [];
          return commands.some((entry) => entry.command === "handoff") ? commands : null;
        }),
      Math.min(options.timeoutMs, 10_000),
      "the first stationary orb click returning to the media owner",
    );
    const handoffCountBeforeDrag = stationaryClickReceipt.filter(
      (entry) => entry.command === "handoff",
    ).length;
    const stationaryClickHiddenState = await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        return state.overlay?.visible === false ? state : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "the owner consuming the stationary click and hiding the overlay",
    );
    await publish(mainPage, activePublication());
    const stationaryClickReactivatedState = await waitFor(
      async () => {
        // The production owner publishes its inactive teardown concurrently
        // with this harness. Reassert the synthetic active owner until that
        // one-time teardown settles, then keep the final accepted revision.
        await publish(mainPage, activePublication());
        const state = await readNativeOverlayState(electronApp);
        return state.overlay?.visible === true ? state : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "overlay reactivation before pointer drag",
    );
    await overlayPage.waitForFunction(() => document.body.dataset.phase === "active");
    // Win the same one-time renderer publication race as initial mount after
    // the real owner consumes the handoff and tears its controller down.
    await publish(mainPage, activePublication());
    const beforeDragState = await readNativeOverlayState(electronApp);
    if (!beforeDragState.overlay) throw new Error("Overlay disappeared before pointer drag.");
    const dragCallFloor = beforeDragState.marker?.dragIpcCalls.length ?? 0;
    await overlayPage.evaluate(
      async ({ pointerScreenX, pointerScreenY }) => {
        const orb = document.querySelector(".orb-button");
        if (!(orb instanceof HTMLElement)) throw new Error("Realtime Voice orb is unavailable.");
        const emit = (type, screenX, screenY, clientX, clientY, buttons) => {
          orb.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              buttons,
              clientX,
              clientY,
              composed: true,
              isPrimary: true,
              pointerId: 41,
              pointerType: "mouse",
              screenX,
              screenY,
            }),
          );
        };
        emit("pointerdown", pointerScreenX, pointerScreenY, 76, 232, 1);
        await new Promise((resolveWait) => setTimeout(resolveWait, 35));
        emit("pointermove", pointerScreenX + 80, pointerScreenY - 40, 156, 192, 1);
        await new Promise((resolveWait) => setTimeout(resolveWait, 35));
        emit("pointerup", pointerScreenX + 80, pointerScreenY - 40, 156, 192, 0);
      },
      {
        pointerScreenX: beforeDragState.overlay.bounds.x + OVERLAY_ORB_CENTER.x,
        pointerScreenY: beforeDragState.overlay.bounds.y + OVERLAY_ORB_CENTER.y,
      },
    );
    const afterDragState = await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        const lifecycle = (state.marker?.dragIpcCalls ?? []).slice(dragCallFloor);
        const moved =
          state.overlay &&
          (state.overlay.bounds.x !== beforeDragState.overlay.bounds.x ||
            state.overlay.bounds.y !== beforeDragState.overlay.bounds.y);
        return moved &&
          lifecycle.some((entry) => entry.type === "avatar-overlay-drag-start") &&
          lifecycle.some((entry) => entry.type === "avatar-overlay-drag-move") &&
          lifecycle.some((entry) => entry.type === "avatar-overlay-drag-end") &&
          lifecycle.some((entry) => entry.type === "avatar-overlay-drag-release")
          ? state
          : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "orb pointer drag and bounded release crossing the native BrowserWindow",
    );
    const releaseReceipt = afterDragState.marker.dragIpcCalls
      .slice(dragCallFloor)
      .find((entry) => entry.type === "avatar-overlay-drag-release");
    if (!releaseReceipt)
      throw new Error("Pointer release did not reach the Electron main process.");
    const momentumState = await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        return state.marker.setBoundsCalls.length > releaseReceipt.setBoundsCallCount
          ? state
          : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "release momentum moving BrowserWindow after drag-end",
    );
    await overlayPage.waitForTimeout(1_000);
    const settledDragState = await readNativeOverlayState(electronApp);
    if (!settledDragState.overlay) throw new Error("Overlay disappeared during release momentum.");
    const commandsAfterDrag = await mainPage.evaluate(
      () => window["__mossNativeOverlayCommands"] ?? [],
    );
    const handoffCountAfterDrag = commandsAfterDrag.filter(
      (entry) => entry.command === "handoff",
    ).length;
    const dragLayout = await overlayPage.evaluate(() => ({
      placement: document.body.dataset.placement ?? null,
      slot: (() => {
        const bounds = document.querySelector(".orb-slot")?.getBoundingClientRect();
        return bounds
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
          : null;
      })(),
    }));

    const callsBeforeTransparentRegion = stationaryCursorState.marker?.ignoreMouseCalls.length ?? 0;
    await overlayPage.mouse.move(178, 160);
    await overlayPage.waitForFunction(() => document.body.dataset.pointerInteractive === "false");
    const transparentState = await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        const last = state.marker?.ignoreMouseCalls.at(-1);
        return (state.marker?.ignoreMouseCalls.length ?? 0) > callsBeforeTransparentRegion &&
          last?.ignore === true &&
          last.forward === true
          ? state
          : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "transparent native click-through",
    );
    if (options.screenshotPath) {
      // Capture the same non-hover active state as the official runtime probe;
      // otherwise the attached controls expand the alpha bounds and make the
      // orb-position comparison meaningless.
      await overlayPage.waitForTimeout(320);
      mkdirSync(dirname(options.screenshotPath), { recursive: true });
      await overlayPage.screenshot({ path: options.screenshotPath, omitBackground: true });
    }
    const stopBox = await overlayPage.locator('button[data-command="stop"]').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    // Use the shared maximum controls hit region, not the currently animated
    // pill bounds: a hidden pill has opacity 0 but its hover reveal region must
    // still restore native input before the first click.
    const callsBeforeControlsRegion = transparentState.marker?.ignoreMouseCalls.length ?? 0;
    await overlayPage.mouse.move(stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2);
    await overlayPage.waitForFunction(() => document.body.dataset.pointerInteractive === "true");
    let controlsInteractiveState;
    try {
      controlsInteractiveState = await waitFor(
        async () => {
          const state = await readNativeOverlayState(electronApp);
          return (state.marker?.ignoreMouseCalls.length ?? 0) > callsBeforeControlsRegion &&
            state.marker?.ignoreMouseCalls.at(-1)?.ignore === false
            ? state
            : null;
        },
        Math.min(options.timeoutMs, 10_000),
        "controls native hit enablement",
      );
    } catch (error) {
      const state = await readNativeOverlayState(electronApp);
      const renderer = await overlayPage.evaluate(async () => ({
        pointerInteractive: document.body.dataset.pointerInteractive ?? null,
        overlayState: await window.realtimeVoiceOverlay.getState(),
        pointElement:
          document
            .elementFromPoint(
              document.querySelector('button[data-command="stop"]')?.getBoundingClientRect().x ?? 0,
              document.querySelector('button[data-command="stop"]')?.getBoundingClientRect().y ?? 0,
            )
            ?.outerHTML.slice(0, 500) ?? null,
      }));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Diagnostics: ${JSON.stringify({
          callsBeforeControlsRegion,
          marker: state.marker,
          renderer,
        })}`,
        { cause: error },
      );
    }
    await overlayPage.mouse.click(stopBox.x + stopBox.width / 2, stopBox.y + stopBox.height / 2);
    const commandReceipt = await waitFor(
      () =>
        mainPage.evaluate(() => {
          const commands = window["__mossNativeOverlayCommands"] ?? [];
          return commands.some((entry) => entry.command === "stop") ? commands : null;
        }),
      Math.min(options.timeoutMs, 10_000),
      "the stop command crossing overlay preload and main IPC",
    );

    await publish(mainPage, { snapshot: null, mediaOwnerActive: false, handoff: null });
    const hiddenState = await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        const last = state.marker?.ignoreMouseCalls.at(-1);
        return state.overlay?.visible === false && last?.ignore === true ? state : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "overlay hide and click-through cleanup",
    );

    await publish(mainPage, activePublication({ activity: "thinking" }));
    const reactivatedState = await waitFor(
      async () => {
        const state = await readNativeOverlayState(electronApp);
        return state.overlay?.visible === true ? state : null;
      },
      Math.min(options.timeoutMs, 10_000),
      "overlay reactivation before owner cleanup",
    );
    const destructionReceipt = await electronApp.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() !== "Moss Realtime Voice",
      );
      if (!main) throw new Error("Moss main BrowserWindow disappeared before cleanup assertion.");
      main.destroy();
      const marker = globalThis["__mossRealtimeVoiceNativeOverlaySmoke"];
      return {
        destroyCalls: marker ? [...marker.destroyCalls] : [],
        remainingOverlayWindows: BrowserWindow.getAllWindows().filter(
          (candidate) => candidate.getTitle() === "Moss Realtime Voice",
        ).length,
      };
    });
    if (
      destructionReceipt.destroyCalls.length === 0 ||
      destructionReceipt.remainingOverlayWindows !== 0
    ) {
      throw new Error(
        `Owner cleanup did not destroy the overlay: ${JSON.stringify(destructionReceipt)}`,
      );
    }

    const checks = {
      compactNativeContentBounds:
        initialNativeState.overlay.contentBounds.width === 356 &&
        initialNativeState.overlay.contentBounds.height === 320 &&
        initialNativeState.overlay.visible,
      nativeWindowPolicy:
        initialNativeState.overlay.alwaysOnTop &&
        initialNativeState.overlay.focusable &&
        !initialNativeState.overlay.hasShadow &&
        !initialNativeState.overlay.maximizable &&
        !initialNativeState.overlay.minimizable &&
        initialNativeState.overlay.movable &&
        !initialNativeState.overlay.resizable,
      showInactiveWithoutFocus: initialNativeState.marker.showInactiveCalls.length > 0,
      stationaryCursorEnablesNativeHit:
        stationaryCursorState.marker.ignoreMouseCalls.some((call) => call.ignore === false) &&
        stationaryCursorState.marker.sendInputCalls.some(
          (call) =>
            call.type === "mouseMove" &&
            call.x === OVERLAY_ORB_CENTER.x &&
            call.y === OVERLAY_ORB_CENTER.y,
        ),
      firstStationaryClickReturnsToOwner:
        stationaryClickReceipt.some((entry) => entry.command === "handoff") &&
        stationaryClickReceipt.some(
          (entry) =>
            entry.command === "handoff" &&
            entry.handoff?.from === "global-overlay" &&
            entry.handoff.origin !== null,
        ),
      stationaryClickOwnerHandoffHidesAndCanReactivate:
        stationaryClickHiddenState.overlay.visible === false &&
        stationaryClickReactivatedState.overlay.visible === true,
      pointerDragMovesNativeBrowserWindow:
        Boolean(afterDragState.overlay) &&
        (afterDragState.overlay.bounds.x !== beforeDragState.overlay.bounds.x ||
          afterDragState.overlay.bounds.y !== beforeDragState.overlay.bounds.y),
      pointerDragUsesProductionPreloadAndMainIpc:
        afterDragState.marker.dragIpcCalls
          .slice(dragCallFloor)
          .some((entry) => entry.type === "avatar-overlay-drag-start") &&
        afterDragState.marker.dragIpcCalls
          .slice(dragCallFloor)
          .some((entry) => entry.type === "avatar-overlay-drag-move") &&
        afterDragState.marker.dragIpcCalls
          .slice(dragCallFloor)
          .some((entry) => entry.type === "avatar-overlay-drag-end") &&
        afterDragState.marker.dragIpcCalls
          .slice(dragCallFloor)
          .some((entry) => entry.type === "avatar-overlay-drag-release"),
      releaseMomentumMovesBrowserWindowAfterDragEnd:
        momentumState.marker.setBoundsCalls.length > releaseReceipt.setBoundsCallCount,
      pointerDragDoesNotTriggerHandoff: handoffCountAfterDrag === handoffCountBeforeDrag,
      fullBrowserWindowRemainsInsideWorkArea:
        settledDragState.overlay.bounds.x >= instrumentation.workArea.x &&
        settledDragState.overlay.bounds.y >= instrumentation.workArea.y &&
        settledDragState.overlay.bounds.x + settledDragState.overlay.bounds.width <=
          instrumentation.workArea.x + instrumentation.workArea.width &&
        settledDragState.overlay.bounds.y + settledDragState.overlay.bounds.height <=
          instrumentation.workArea.y + instrumentation.workArea.height,
      rendererConsumesPlacementLayout:
        ["top-start", "top-end", "bottom-start", "bottom-end"].includes(dragLayout.placement) &&
        dragLayout.slot?.width === 112 &&
        dragLayout.slot?.height === 121,
      transparentRegionRestoresForwardedClickThrough:
        transparentState.marker.ignoreMouseCalls.at(-1)?.ignore === true &&
        transparentState.marker.ignoreMouseCalls.at(-1)?.forward === true,
      controlsRegionEnablesNativeInput:
        controlsInteractiveState.marker.ignoreMouseCalls.at(-1)?.ignore === false,
      stopCrossesProductionPreloadAndIpc: commandReceipt.some((entry) => entry.command === "stop"),
      stopPublicationHidesAndDisablesHitTesting:
        hiddenState.overlay.visible === false &&
        hiddenState.marker.ignoreMouseCalls.at(-1)?.ignore === true,
      draggedPositionSurvivesHideShow:
        reactivatedState.overlay.bounds.x === settledDragState.overlay.bounds.x &&
        reactivatedState.overlay.bounds.y === settledDragState.overlay.bounds.y,
      ownerDestructionCleansOverlay:
        destructionReceipt.destroyCalls.length > 0 &&
        destructionReceipt.remainingOverlayWindows === 0,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, pass]) => !pass)
      .map(([name]) => name);
    return {
      version: 2,
      createdAt: new Date().toISOString(),
      status: failedChecks.length === 0 ? "pass" : "fail",
      runtime: "production Electron main + production preload + production overlay document",
      checks,
      failedChecks,
      nativeWindow: initialNativeState.overlay,
      pointerEvidence: {
        initial: initialNativeState.marker,
        stationaryCursor,
        afterStationarySync: stationaryCursorState.marker,
        afterTransparentRegion: transparentState.marker,
        afterControlsRegion: controlsInteractiveState.marker,
        stationaryClickReceipt,
        stationaryClickHiddenState,
        stationaryClickReactivatedState,
        beforeDrag: beforeDragState,
        afterDrag: afterDragState,
        releaseReceipt,
        momentumState,
        settledDragState,
        commandsAfterDrag,
        dragLayout,
      },
      commandReceipt,
      hiddenState: hiddenState.overlay,
      reactivatedState: reactivatedState.overlay,
      destructionReceipt,
      inputAutomationBoundary: {
        browserWindowAndPreload: "actual",
        nativeSetIgnoreMouseEvents: "actual invocation observed around the real BrowserWindow",
        pointerAndClickSource:
          "Playwright CDP stationary click + controlled renderer PointerEvents with screen coordinates",
        physicalMacOsClickInjected: false,
        statement:
          "This proves the production BrowserWindow, preload, renderer hit regions, native ignoreMouseEvents calls, pointer drag/release IPC, momentum, and command path. It does not claim a CGEvent-level physical mouse drag.",
      },
      runtimeDir,
      runtimeDirRetained: true,
      ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
      logs: { browser: browserLogs, electron: electronLogs },
    };
  } finally {
    await closeElectronApp(electronApp);
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  assertBuiltFile(MAIN_JS, "desktop main bundle");
  assertBuiltFile(PRELOAD_JS, "desktop preload bundle");
  assertBuiltFile(SERVER_ENTRY, "server backend bundle");
  assertBuiltFile(WEB_INDEX, "web bundle");
  const report = await runSmoke(options);
  if (options.reportPath) {
    mkdirSync(dirname(options.reportPath), { recursive: true });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "pass" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
