// FILE: windowPreload.ts
// Purpose: Self-contained sandbox preload for standalone Page App windows.
//          Exposes `mossDesktopAppPane` and `desktopBridge` on the top shell frame (plus the
//          draggable-region overlay host) and `mossDesktop` / `mossApps` strictly to the direct
//          child iframe (`self !== top && parent === top`) inside secure contexts.
// Layer: Desktop pageApps (sandboxed preload)

import { contextBridge, ipcRenderer } from "electron";

const NODE_APIS_CALL_CHANNEL = "moss-app:node-apis-call";
const NODE_APIS_EVENT_CHANNEL = "moss-app:node-apis-event";
const DRAG_REGIONS_CHANNEL = "moss-app:drag-regions";
const PERMISSIONS_DECLARE_CHANNEL = "moss-app:permissions-declare";

const MAX_DRAG_REGIONS = 64;
const MAX_MANIFEST_CHARS = 16_000;
const MAX_MANIFEST_PERMISSIONS = 32;
const MAX_PERMISSION_NAME_CHARS = 64;
const EVENT_BACKLOG_LIMIT = 2000;

const ALLOWED_DESKTOP_PERMISSIONS = new Set([
  "notifications",
  "shortcuts",
  "overlay",
  "menu-bar",
  "full-access",
]);

export interface DragRegionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly drag: boolean;
}

export interface NodeApiEventMessage {
  readonly appId?: string;
  readonly namespace?: string;
  readonly event?: string;
  readonly targetId?: string;
  readonly streamId?: string;
  readonly payload?: Record<string, unknown>;
}

type EventListenerFn = (event: unknown) => void;
type StreamListenerFn = (payload: Record<string, unknown>) => void;

const globalEventListeners = new Set<EventListenerFn>();
const eventBacklog: NodeApiEventMessage[] = [];
const streamListeners = new Map<string, Map<string, Set<StreamListenerFn>>>();
const menuClickCallbacks = new Map<string, (id: string) => void>();
const trayCallbacks: {
  onClick?: (() => void) | undefined;
  onMenuClick?: ((id: string) => void) | undefined;
} = {};
const shortcutCallbacks = new Map<string, () => void>();

let manifestDeclarePromise: Promise<void> | null = null;
let streamCounter = 1;

function nextClientStreamId(prefix: string): string {
  const id = `${prefix}-${streamCounter}`;
  streamCounter += 1;
  return id;
}

function pushBacklogEvent(message: NodeApiEventMessage): void {
  eventBacklog.push(message);
  if (eventBacklog.length > EVENT_BACKLOG_LIMIT) {
    eventBacklog.splice(0, eventBacklog.length - EVENT_BACKLOG_LIMIT);
  }
}

function getStreamKey(message: NodeApiEventMessage): string | null {
  if (typeof message.streamId === "string" && message.streamId) return message.streamId;
  if (typeof message.targetId === "string" && message.targetId) return message.targetId;
  const payloadId = message.payload?.id;
  return typeof payloadId === "string" && payloadId ? payloadId : null;
}

function dispatchIncomingEvent(rawMessage: unknown): void {
  if (!rawMessage || typeof rawMessage !== "object") return;
  const message = rawMessage as NodeApiEventMessage;
  pushBacklogEvent(message);

  for (const listener of globalEventListeners) {
    try {
      listener(message);
    } catch {
      // Isolate listener errors.
    }
  }

  const namespace = message.namespace;
  const eventName = message.event;
  const payload =
    message.payload && typeof message.payload === "object"
      ? message.payload
      : ({} as Record<string, unknown>);

  if (namespace === "menu" && eventName === "click") {
    const id = typeof message.targetId === "string" ? message.targetId : String(payload.id ?? "");
    const cb = menuClickCallbacks.get(id) ?? menuClickCallbacks.get("*");
    cb?.(id);
    return;
  }

  if (namespace === "tray") {
    if (eventName === "click") trayCallbacks.onClick?.();
    else if (eventName === "menu-click") {
      const id = typeof message.targetId === "string" ? message.targetId : String(payload.id ?? "");
      trayCallbacks.onMenuClick?.(id);
    }
    return;
  }

  if (namespace === "globalShortcut" && eventName === "triggered") {
    const acc =
      typeof message.targetId === "string"
        ? message.targetId
        : typeof payload.accelerator === "string"
          ? payload.accelerator
          : "";
    shortcutCallbacks.get(acc)?.();
    return;
  }

  const streamKey = getStreamKey(message);
  if (!streamKey || !eventName) return;
  const listenersByEvent = streamListeners.get(streamKey);
  const set = listenersByEvent?.get(eventName);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch {
      // Isolate stream listener errors.
    }
  }
}

function addStreamListener(
  streamId: string,
  eventName: string,
  listener: StreamListenerFn,
): () => void {
  let byEvent = streamListeners.get(streamId);
  if (!byEvent) {
    byEvent = new Map();
    streamListeners.set(streamId, byEvent);
  }
  let set = byEvent.get(eventName);
  if (!set) {
    set = new Set();
    byEvent.set(eventName, set);
  }
  set.add(listener);

  for (const cached of eventBacklog) {
    if (getStreamKey(cached) === streamId && cached.event === eventName) {
      try {
        listener(cached.payload ?? {});
      } catch {
        // Ignore replay errors.
      }
    }
  }

  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      byEvent?.delete(eventName);
      if (byEvent && byEvent.size === 0) {
        streamListeners.delete(streamId);
      }
    }
  };
}

/** Parses `<script id="moss-app-manifest" type="application/json">` permissions safely. */
export function parsePageAppManifestFromDocument(doc: Document | undefined): string[] {
  if (!doc) return [];
  const el = doc.getElementById("moss-app-manifest");
  if (!el) return [];
  const rawText = typeof el.textContent === "string" ? el.textContent.trim() : "";
  if (!rawText || rawText.length > MAX_MANIFEST_CHARS) return [];

  try {
    const parsed = JSON.parse(rawText) as {
      desktop?: { permissions?: unknown };
      permissions?: unknown;
    } | null;
    if (!parsed || typeof parsed !== "object") return [];
    const candidate = Array.isArray(parsed.desktop?.permissions)
      ? parsed.desktop.permissions
      : Array.isArray(parsed.permissions)
        ? parsed.permissions
        : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of candidate.slice(0, MAX_MANIFEST_PERMISSIONS)) {
      if (typeof item !== "string") continue;
      const normalized = item.trim();
      if (
        normalized.length === 0 ||
        normalized.length > MAX_PERMISSION_NAME_CHARS ||
        !ALLOWED_DESKTOP_PERMISSIONS.has(normalized) ||
        seen.has(normalized)
      ) {
        continue;
      }
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  } catch {
    return [];
  }
}

function ensureManifestDeclared(): Promise<void> {
  if (manifestDeclarePromise) return manifestDeclarePromise;
  manifestDeclarePromise = new Promise<void>((resolve) => {
    const run = () => {
      const permissions = parsePageAppManifestFromDocument(
        typeof document !== "undefined" ? document : undefined,
      );
      if (permissions.length === 0) {
        resolve();
        return;
      }
      void ipcRenderer
        .invoke(PERMISSIONS_DECLARE_CHANNEL, { permissions })
        .catch(() =>
          ipcRenderer.invoke(NODE_APIS_CALL_CHANNEL, {
            namespace: "permissions",
            method: "declare",
            args: { permissions },
          }),
        )
        .catch(() => undefined)
        .finally(() => resolve());
    };

    if (typeof document === "undefined" || document.readyState !== "loading") {
      run();
      return;
    }
    const onReady = () => {
      document.removeEventListener("DOMContentLoaded", onReady);
      run();
    };
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
    setTimeout(() => {
      document.removeEventListener("DOMContentLoaded", onReady);
      run();
    }, 1500);
  });
  return manifestDeclarePromise;
}

async function invokeNamespace(
  namespace: string,
  method: string,
  args: unknown = null,
): Promise<unknown> {
  if (!(namespace === "permissions" && method === "declare")) {
    await ensureManifestDeclared();
  }
  return ipcRenderer.invoke(NODE_APIS_CALL_CHANNEL, { namespace, method, args });
}

function subscribeAllEvents(listener: EventListenerFn): () => void {
  if (typeof listener !== "function") return () => {};
  globalEventListeners.add(listener);
  return () => {
    globalEventListeners.delete(listener);
  };
}

function registerMenuHandlers(items: unknown, onClick?: ((id: string) => void) | undefined): void {
  if (!Array.isArray(items)) return;
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as {
      id?: unknown;
      label?: unknown;
      click?: unknown;
      submenu?: unknown;
    };
    const id =
      typeof item.id === "string" && item.id
        ? item.id
        : typeof item.label === "string"
          ? item.label
          : "";
    if (typeof item.click === "function" && id) {
      const fn = item.click as (id: string) => void;
      menuClickCallbacks.set(id, fn);
    } else if (onClick && id) {
      menuClickCallbacks.set(id, onClick);
    }
    if (Array.isArray(item.submenu)) {
      registerMenuHandlers(item.submenu, onClick);
    }
  }
}

function createChildProcessHandle(initial: { id: string; pid: number | null; streamId: string }) {
  const dispose = () => {
    streamListeners.delete(initial.streamId);
    streamListeners.delete(initial.id);
  };
  return Object.freeze({
    id: initial.id,
    pid: initial.pid,
    streamId: initial.streamId,
    write: (data: string) => invokeNamespace("childProcess", "write", { id: initial.id, data }),
    end: () => invokeNamespace("childProcess", "endStdin", { id: initial.id }),
    endStdin: () => invokeNamespace("childProcess", "endStdin", { id: initial.id }),
    kill: (signal?: string) => invokeNamespace("childProcess", "kill", { id: initial.id, signal }),
    on: (event: "stdout" | "stderr" | "exit" | "error", cb: StreamListenerFn) =>
      addStreamListener(initial.streamId, event, cb),
    onStdout: (cb: StreamListenerFn) => addStreamListener(initial.streamId, "stdout", cb),
    onStderr: (cb: StreamListenerFn) => addStreamListener(initial.streamId, "stderr", cb),
    onExit: (cb: StreamListenerFn) => addStreamListener(initial.streamId, "exit", cb),
    onError: (cb: StreamListenerFn) => addStreamListener(initial.streamId, "error", cb),
    dispose,
  });
}

function createPtyHandle(initial: {
  id: string;
  pid: number | null;
  cols: number;
  rows: number;
  streamId: string;
}) {
  const dispose = () => {
    streamListeners.delete(initial.streamId);
    streamListeners.delete(initial.id);
  };
  return Object.freeze({
    id: initial.id,
    pid: initial.pid,
    cols: initial.cols,
    rows: initial.rows,
    streamId: initial.streamId,
    write: (data: string) => invokeNamespace("pty", "write", { id: initial.id, data }),
    resize: (cols: number, rows: number) =>
      invokeNamespace("pty", "resize", { id: initial.id, cols, rows }),
    kill: (signal?: string) => invokeNamespace("pty", "kill", { id: initial.id, signal }),
    on: (event: "data" | "exit" | "error", cb: StreamListenerFn) =>
      addStreamListener(initial.streamId, event, cb),
    onData: (cb: StreamListenerFn) => addStreamListener(initial.streamId, "data", cb),
    onExit: (cb: StreamListenerFn) => addStreamListener(initial.streamId, "exit", cb),
    dispose,
  });
}

function createDesktopNativeGlobal() {
  return Object.freeze({
    isDesktopApp: true,
    invoke: (namespace: string, method: string, args?: unknown) =>
      invokeNamespace(namespace, method, args === undefined ? null : args),
    subscribe: subscribeAllEvents,
    onEvent: subscribeAllEvents,
    window: Object.freeze({
      setOptions: (options: unknown) => invokeNamespace("window", "setOptions", options),
      getOptions: () => invokeNamespace("window", "getOptions", null),
      place: (options: unknown) => invokeNamespace("window", "place", options),
      show: () => invokeNamespace("window", "show", null),
      hide: () => invokeNamespace("window", "hide", null),
      focus: () => invokeNamespace("window", "focus", null),
      close: () => invokeNamespace("window", "close", null),
      getBounds: () => invokeNamespace("window", "getBounds", null),
      setBounds: (bounds: unknown) => invokeNamespace("window", "setBounds", bounds),
      setDraggableRegions: (regions: unknown) =>
        invokeNamespace("window", "setDraggableRegions", { regions }),
      setIgnoreMouseEvents: (ignore: boolean, options?: unknown) =>
        invokeNamespace("window", "setIgnoreMouseEvents", {
          ignore: Boolean(ignore),
          forward: Boolean(
            options && typeof options === "object" && (options as { forward?: unknown }).forward,
          ),
        }),
      setVisibleOnAllWorkspaces: (visible: boolean, options?: unknown) =>
        invokeNamespace("window", "setVisibleOnAllWorkspaces", {
          visible: Boolean(visible),
          visibleOnFullScreen: Boolean(
            options &&
            typeof options === "object" &&
            (options as { visibleOnFullScreen?: unknown }).visibleOnFullScreen,
          ),
        }),
      print: (options?: unknown) => invokeNamespace("window", "print", options ?? null),
    }),
    Menu: Object.freeze({
      setApplicationMenu: (template: unknown, onClick?: (id: string) => void) => {
        menuClickCallbacks.clear();
        if (onClick) menuClickCallbacks.set("*", onClick);
        registerMenuHandlers(template, onClick);
        return invokeNamespace("Menu", "setApplicationMenu", { template });
      },
      popup: async (
        template: unknown,
        options?: unknown,
        onClick?: (id: string) => void,
      ): Promise<string | null> => {
        const selected = (await invokeNamespace("Menu", "popup", {
          template,
          ...(options && typeof options === "object" ? options : {}),
        })) as string | null;
        if (selected && onClick) onClick(selected);
        return selected;
      },
    }),
    app: Object.freeze({
      dock: Object.freeze({
        setIcon: (icon: string | null) => invokeNamespace("app", "dock.setIcon", { icon }),
        setBadge: (text: string) => invokeNamespace("app", "dock.setBadge", { text }),
        setProgress: () => Promise.resolve(false),
        setMenu: () => Promise.resolve(false),
      }),
    }),
    tray: Object.freeze({
      set: (
        options: unknown,
        callbacks?: { onClick?: () => void; onMenuClick?: (id: string) => void },
      ) => {
        if (callbacks) {
          trayCallbacks.onClick = callbacks.onClick;
          trayCallbacks.onMenuClick = callbacks.onMenuClick;
        }
        return invokeNamespace("tray", "set", options);
      },
      remove: () => {
        trayCallbacks.onClick = undefined;
        trayCallbacks.onMenuClick = undefined;
        return invokeNamespace("tray", "remove", null);
      },
    }),
    notification: Object.freeze({
      show: (options: unknown) => invokeNamespace("notification", "show", options),
    }),
    globalShortcut: Object.freeze({
      register: async (accelerator: string, callback?: () => void) => {
        if (typeof callback === "function") {
          shortcutCallbacks.set(accelerator, callback);
        }
        const ok = await invokeNamespace("globalShortcut", "register", { accelerator });
        if (!ok) shortcutCallbacks.delete(accelerator);
        return ok;
      },
      unregister: (accelerator: string) => {
        shortcutCallbacks.delete(accelerator);
        return invokeNamespace("globalShortcut", "unregister", { accelerator });
      },
      unregisterAll: () => {
        shortcutCallbacks.clear();
        return invokeNamespace("globalShortcut", "unregisterAll", null);
      },
      isRegistered: (accelerator: string) =>
        invokeNamespace("globalShortcut", "isRegistered", { accelerator }),
    }),
    screen: Object.freeze({
      getPrimaryDisplay: () => invokeNamespace("screen", "getPrimaryDisplay", null),
      getAllDisplays: () => invokeNamespace("screen", "getAllDisplays", null),
      getCursorScreenPoint: () => invokeNamespace("screen", "getCursorScreenPoint", null),
      getDisplayNearestPoint: (point: unknown) =>
        invokeNamespace("screen", "getDisplayNearestPoint", point),
      getDisplayMatching: (rect: unknown) => invokeNamespace("screen", "getDisplayMatching", rect),
    }),
    os: Object.freeze({
      platform: () => invokeNamespace("os", "platform", null),
      arch: () => invokeNamespace("os", "arch", null),
      info: () => invokeNamespace("os", "info", null),
    }),
    fs: Object.freeze({
      readFile: (path: string, options?: unknown) =>
        invokeNamespace("fs", "readFile", {
          path,
          encoding:
            typeof options === "string"
              ? options
              : options && typeof options === "object"
                ? ((options as { encoding?: unknown }).encoding ?? null)
                : null,
        }),
      writeFile: (path: string, data: unknown) =>
        invokeNamespace("fs", "writeFile", { path, data }),
      appendFile: (path: string, data: unknown) =>
        invokeNamespace("fs", "appendFile", { path, data }),
      unlink: (path: string) => invokeNamespace("fs", "unlink", { path }),
      mkdir: (path: string, options?: unknown) =>
        invokeNamespace("fs", "mkdir", {
          path,
          ...(options && typeof options === "object" ? options : {}),
        }),
      rmdir: (path: string, options?: unknown) =>
        invokeNamespace("fs", "rmdir", {
          path,
          ...(options && typeof options === "object" ? options : {}),
        }),
      rm: (path: string, options?: unknown) =>
        invokeNamespace("fs", "rm", {
          path,
          ...(options && typeof options === "object" ? options : {}),
        }),
      readdir: (path: string, options?: unknown) =>
        invokeNamespace("fs", "readdir", {
          path,
          ...(options && typeof options === "object" ? options : {}),
        }),
      stat: (path: string) => invokeNamespace("fs", "stat", { path }),
      lstat: (path: string) => invokeNamespace("fs", "lstat", { path }),
      rename: (oldPath: string, newPath: string) =>
        invokeNamespace("fs", "rename", { oldPath, newPath }),
      copyFile: (src: string, dest: string, mode?: number) =>
        invokeNamespace("fs", "copyFile", { src, dest, mode }),
      access: (path: string, mode?: number) => invokeNamespace("fs", "access", { path, mode }),
      exists: (path: string) => invokeNamespace("fs", "exists", { path }),
      realpath: (path: string) => invokeNamespace("fs", "realpath", { path }),
    }),
    shell: Object.freeze({
      openPath: (path: string) => invokeNamespace("shell", "openPath", { path }),
      showItemInFolder: (path: string) => invokeNamespace("shell", "showItemInFolder", { path }),
      trashItem: (path: string) => invokeNamespace("shell", "trashItem", { path }),
      openExternal: (url: string) => invokeNamespace("shell", "openExternal", { url }),
    }),
    childProcess: Object.freeze({
      exec: (command: string, options?: unknown) =>
        invokeNamespace("childProcess", "exec", { command, options }),
      spawn: async (command: string, args?: unknown, options?: unknown) => {
        const streamId = nextClientStreamId("cp");
        const result = (await invokeNamespace("childProcess", "spawn", {
          command,
          args,
          options,
          clientId: streamId,
        })) as { id: string; pid: number | null; streamId?: string };
        return createChildProcessHandle({
          id: result.id,
          pid: result.pid ?? null,
          streamId: result.streamId ?? streamId,
        });
      },
      write: (id: string, data: string) => invokeNamespace("childProcess", "write", { id, data }),
      end: (id: string) => invokeNamespace("childProcess", "endStdin", { id }),
      endStdin: (id: string) => invokeNamespace("childProcess", "endStdin", { id }),
      kill: (id: string, signal?: string) =>
        invokeNamespace("childProcess", "kill", { id, signal }),
    }),
    pty: Object.freeze({
      spawn: async (file: string, args?: unknown, options?: unknown) => {
        const streamId = nextClientStreamId("pty");
        const result = (await invokeNamespace("pty", "spawn", {
          file,
          args,
          options,
          clientId: streamId,
        })) as { id: string; pid: number | null; cols: number; rows: number; streamId?: string };
        return createPtyHandle({
          id: result.id,
          pid: result.pid ?? null,
          cols: result.cols ?? 80,
          rows: result.rows ?? 24,
          streamId: result.streamId ?? streamId,
        });
      },
      write: (id: string, data: string) => invokeNamespace("pty", "write", { id, data }),
      resize: (id: string, cols: number, rows: number) =>
        invokeNamespace("pty", "resize", { id, cols, rows }),
      kill: (id: string, signal?: string) => invokeNamespace("pty", "kill", { id, signal }),
    }),
    install: Object.freeze({
      state: () => invokeNamespace("install", "state", null),
      request: () => invokeNamespace("install", "request", null),
    }),
    permissions: Object.freeze({
      declare: (permissions: readonly string[]) =>
        invokeNamespace("permissions", "declare", { permissions }),
      state: (name?: string) =>
        invokeNamespace("permissions", "state", name === undefined ? null : { name }),
      request: (names?: readonly string[]) =>
        invokeNamespace("permissions", "request", names === undefined ? null : { names }),
      manage: () => invokeNamespace("permissions", "manage", null),
    }),
  });
}

/** Clips a bounding rect to the visible viewport `[0..viewportW, 0..viewportH]`. */
export function clipRectToViewport(
  rect: { left: number; top: number; right: number; bottom: number },
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number; width: number; height: number } | null {
  const x1 = Math.max(0, Math.min(viewportWidth, Math.round(rect.left)));
  const y1 = Math.max(0, Math.min(viewportHeight, Math.round(rect.top)));
  const x2 = Math.max(0, Math.min(viewportWidth, Math.round(rect.right)));
  const y2 = Math.max(0, Math.min(viewportHeight, Math.round(rect.bottom)));
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) return null;
  return { x: x1, y: y1, width, height };
}

function collectAppRegionSelectors(doc: Document): string[] {
  const selectors = new Set<string>(['[style*="app-region"]']);
  const sheets = doc.styleSheets;
  if (!sheets) return [...selectors];
  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i];
    if (!sheet) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (let j = 0; j < rules.length; j += 1) {
      const rule = rules[j] as { selectorText?: unknown; style?: CSSStyleDeclaration } | undefined;
      if (!rule || typeof rule.selectorText !== "string" || !rule.style) continue;
      const appRegion =
        rule.style.getPropertyValue("app-region").trim() ||
        rule.style.getPropertyValue("-webkit-app-region").trim();
      if (appRegion === "drag" || appRegion === "no-drag") {
        selectors.add(rule.selectorText);
      }
    }
  }
  return [...selectors];
}

/**
 * Scans CSS-rule and inline `[style*="app-region"]` elements in DOM order, skipping hidden
 * elements, clipping to viewport, and limiting to `MAX_DRAG_REGIONS` with `no-drag` priority.
 */
export function scanAppRegionElements(
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
): DragRegionRect[] {
  if (!doc || !win) return [];
  const selectors = collectAppRegionSelectors(doc);
  let matched: NodeListOf<Element>;
  try {
    matched = doc.querySelectorAll(selectors.join(", "));
  } catch {
    matched = doc.querySelectorAll('[style*="app-region"]');
  }

  const vw = Math.max(0, win.innerWidth || doc.documentElement?.clientWidth || 0);
  const vh = Math.max(0, win.innerHeight || doc.documentElement?.clientHeight || 0);
  const collected: DragRegionRect[] = [];
  let noDragCount = 0;

  for (let i = 0; i < matched.length; i += 1) {
    const el = matched[i];
    if (!el) continue;
    const style = win.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    ) {
      continue;
    }
    const region =
      style.getPropertyValue("app-region").trim() ||
      style.getPropertyValue("-webkit-app-region").trim();
    if (region !== "drag" && region !== "no-drag") continue;

    const clipped = clipRectToViewport(el.getBoundingClientRect(), vw, vh);
    if (!clipped) continue;
    const drag = region === "drag";
    if (!drag) noDragCount += 1;
    collected.push({ ...clipped, drag });
  }

  if (collected.length <= MAX_DRAG_REGIONS) {
    return collected;
  }

  // Keep DOM order while ensuring up to MAX_DRAG_REGIONS slots prioritize `no-drag` regions.
  let remainingDragSlots = Math.max(0, MAX_DRAG_REGIONS - Math.min(noDragCount, MAX_DRAG_REGIONS));
  const bounded: DragRegionRect[] = [];
  for (const item of collected) {
    if (!item.drag) {
      bounded.push(item);
    } else if (remainingDragSlots > 0) {
      bounded.push(item);
      remainingDragSlots -= 1;
    }
    if (bounded.length >= MAX_DRAG_REGIONS) break;
  }
  return bounded;
}

function startAppRegionScanner(): void {
  let scheduled = false;
  let lastSignature = "";

  const flush = () => {
    scheduled = false;
    const regions = scanAppRegionElements();
    const signature = JSON.stringify(regions);
    if (signature === lastSignature) return;
    lastSignature = signature;
    void invokeNamespace("window", "setDraggableRegions", { regions }).catch(() => undefined);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 16);
    }
  };

  window.addEventListener("DOMContentLoaded", () => {
    flush();
    if (typeof MutationObserver === "function" && document.body) {
      new MutationObserver(schedule).observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["style", "class"],
      });
    }
  });
  window.addEventListener("resize", schedule);
}

/** Installs or updates the top-shell `app-region` overlay container for child iframe drag regions. */
export function renderTopFrameDragRegionsOverlay(
  doc: Document,
  regions: readonly DragRegionRect[],
): void {
  const OVERLAY_ID = "__moss_app_drag_regions_overlay__";
  let overlay = doc.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = doc.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "2147483647";
    (doc.body ?? doc.documentElement)?.appendChild(overlay);
  }
  overlay.replaceChildren();

  const frameHost = doc.querySelector<HTMLElement>("#frame-content, iframe");
  const frameRect = frameHost?.getBoundingClientRect() ?? { left: 0, top: 0 };

  for (const region of regions.slice(0, MAX_DRAG_REGIONS)) {
    const marker = doc.createElement("div");
    marker.style.position = "fixed";
    marker.style.left = `${Math.round(frameRect.left + region.x)}px`;
    marker.style.top = `${Math.round(frameRect.top + region.y)}px`;
    marker.style.width = `${Math.max(0, Math.round(region.width))}px`;
    marker.style.height = `${Math.max(0, Math.round(region.height))}px`;
    marker.style.pointerEvents = "auto";
    marker.style.setProperty("-webkit-app-region", region.drag ? "drag" : "no-drag");
    marker.style.setProperty("app-region", region.drag ? "drag" : "no-drag");
    overlay.appendChild(marker);
  }
}

function subscribeIpcChannel(channel: string, listener: EventListenerFn): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

function createTopFrameDesktopBridge() {
  return Object.freeze({
    getWsUrl: () => {
      try {
        const value: unknown = ipcRenderer.sendSync("desktop:get-ws-url");
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    pageApps: Object.freeze({
      isAvailable: () => ipcRenderer.invoke("desktop:page-apps-is-available"),
      getPolicyState: () => ipcRenderer.invoke("desktop:page-apps-get-policy-state"),
      installFromPage: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-install-from-page", input),
      requestInstall: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-request-install", input),
      isInstalled: (appId: string) => ipcRenderer.invoke("desktop:page-apps-is-installed", appId),
      getInstalled: (appId: string) => ipcRenderer.invoke("desktop:page-apps-get-installed", appId),
      listInstalled: () => ipcRenderer.invoke("desktop:page-apps-list-installed"),
      openInstalled: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-open-installed", input),
      uninstall: (input: unknown) => ipcRenderer.invoke("desktop:page-apps-uninstall", input),
      setDesktopShortcut: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-set-desktop-shortcut", input),
      showInFolder: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-show-in-folder", input),
      openPermissions: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-open-permissions", input),
      getPermissions: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-get-permissions", input),
      requestPermissions: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-request-permissions", input),
      setPermission: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-set-permission", input),
      syncAppVersion: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-sync-app-version", input),
      reportAppGone: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-report-app-gone", input),
      offerInMenu: (offers: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-offer-in-menu", offers),
      onPickedInMenu: (listener: EventListenerFn) =>
        subscribeIpcChannel("desktop:page-apps-picked-in-menu", listener),
      onInstalledChanged: (listener: EventListenerFn) =>
        subscribeIpcChannel("desktop:page-apps-installed-changed", listener),
      onPermissionsChanged: (listener: EventListenerFn) =>
        subscribeIpcChannel("desktop:page-apps-permissions-changed", listener),
      invokeDesktopApi: (input: unknown) =>
        ipcRenderer.invoke("desktop:page-apps-invoke-desktop-api", input),
      onDesktopApiEvent: (listener: EventListenerFn) =>
        subscribeIpcChannel("desktop:page-apps-desktop-api-event", listener),
    }),
  });
}

if (typeof window !== "undefined" && window.isSecureContext) {
  if (window.self === window.top) {
    contextBridge.exposeInMainWorld(
      "mossDesktopAppPane",
      Object.freeze({
        embedded: true,
        platform: "desktop",
        chrome: "none",
      }),
    );
    contextBridge.exposeInMainWorld("desktopBridge", createTopFrameDesktopBridge());
    ipcRenderer.on(DRAG_REGIONS_CHANNEL, (_event, payload: unknown) => {
      if (typeof document === "undefined") return;
      const regions = Array.isArray(payload)
        ? (payload as DragRegionRect[])
        : payload &&
            typeof payload === "object" &&
            Array.isArray((payload as { regions?: unknown }).regions)
          ? (payload as { regions: DragRegionRect[] }).regions
          : [];
      renderTopFrameDragRegionsOverlay(document, regions);
    });
  } else if (window.self !== window.top && window.parent === window.top) {
    ipcRenderer.on(NODE_APIS_EVENT_CHANNEL, (_event, message: unknown) => {
      dispatchIncomingEvent(message);
    });

    void ensureManifestDeclared();
    const api = createDesktopNativeGlobal();
    contextBridge.exposeInMainWorld("mossDesktop", api);
    contextBridge.exposeInMainWorld("mossApps", api);
    startAppRegionScanner();
  }
}
