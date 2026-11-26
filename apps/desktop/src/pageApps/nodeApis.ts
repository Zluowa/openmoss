// FILE: nodeApis.ts
// Purpose: Sandboxed IPC executor for `moss-app:node-apis-call` and `moss-app:node-apis-event`
//          covering all 14 desktop Page App capability domains with strict caller verification.
// Layer: Desktop pageApps

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs/promises";
import { createRequire } from "node:module";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL,
  PAGE_APP_DESKTOP_IPC_CHANNELS,
  PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL,
  PAGE_APP_DESKTOP_NODE_API_EVENT_CHANNEL,
  PAGE_APP_DESKTOP_PERMISSIONS,
  sanitizeDesktopScreenDisplay,
  type DesktopPageAppInstallState,
  type DesktopPageAppNodeApiCallInput,
  type DesktopPageAppNodeApiEvent,
  type DesktopPageAppScreenDisplay,
  type DesktopPageAppWindowGetOptionsResult,
  type DesktopPageAppWindowOptions,
  type DesktopPageAppWindowSetOptionsResult,
} from "@moss/contracts";
import { execProcessFile } from "@moss/shared/processRuntime";
import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebFrameMain,
} from "electron";

import { type PageAppDialogHost } from "./dialogs";
import { DesktopPageAppPermissionEngine, isDesktopPageAppPermission } from "./permissions";
import { DesktopPageAppStore } from "./store";
import {
  PAGE_APP_MAX_CHILD_PROCESSES,
  PAGE_APP_MAX_DRAG_REGIONS,
  PAGE_APP_MAX_EXEC_BUFFER_BYTES,
  PAGE_APP_MAX_FS_READ_BYTES,
  PAGE_APP_MAX_MENU_DEPTH,
  PAGE_APP_MAX_MENU_ITEMS,
  PAGE_APP_TRAY_FOLD_THRESHOLD,
  type DesktopPageAppPermission,
  type DesktopPageAppTrustKind,
  type StoredDesktopPageAppWindowStyle,
} from "./types";

export const PAGE_APP_NODE_APIS_CALL_CHANNEL = PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL;
export const PAGE_APP_NODE_APIS_EVENT_CHANNEL = PAGE_APP_DESKTOP_NODE_API_EVENT_CHANNEL;

const DRAG_REGIONS_TTL_MS = 6_000;
const NOTIFICATION_RAW_MAX_CHARS = 2_000;
const NOTIFICATION_BODY_MAX_CODEPOINTS = 300;
const SHORTCUT_MAX_CHARS = 64;
const PROCESS_STREAM_BATCH_MS = 16;
const GESTURE_WINDOW_MS = 5_000;

const FORBIDDEN_OPEN_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".msp",
  ".ps1",
  ".psm1",
  ".psd1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".mjs",
  ".cjs",
  ".wsf",
  ".wsh",
  ".scr",
  ".pif",
  ".py",
  ".pyw",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".app",
  ".command",
  ".jar",
  ".hta",
  ".cpl",
  ".reg",
  ".lnk",
  ".url",
  ".dll",
  ".sys",
  ".drv",
  ".ocx",
]);

const SHELL_SHADOW_EXTENSIONS = [
  ".exe",
  ".cmd",
  ".bat",
  ".com",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".msi",
  ".scr",
  ".pif",
];

const BANNED_SHORTCUT_PRIMARY_KEYS = new Set([
  "esc",
  "escape",
  "tab",
  "capslock",
  "insert",
  "printscreen",
  "prtsc",
  "numlock",
  "scrolllock",
  "pause",
]);

const BANNED_MODIFIERS = new Set(["super", "meta", "win", "windows"]);
const CMD_MODIFIERS = new Set(["cmd", "command", "cmdorctrl", "commandorcontrol"]);
const ALLOWED_MODIFIERS = new Set(["ctrl", "control", "shift", "alt", "option", "altgr"]);
const ALLOWED_SIGNALS = new Set<NodeJS.Signals>([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
]);

const DANGEROUS_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
]);

const ALLOWED_VIBRANCY_VALUES = new Set([
  "under-window",
  "under-page",
  "sidebar",
  "content",
  "hud",
  "popover",
  "window",
  "titlebar",
  "header",
  "menu",
  "sheet",
  "selection",
  "tooltip",
  "fullscreen-ui",
]);

const ALLOWED_VISUAL_EFFECT_STATES = new Set(["followWindow", "active", "inactive"]);
const ALLOWED_TITLE_BAR_STYLES = new Set(["default", "hidden", "hiddenInset"]);

const GLOBAL_SHORTCUT_OWNERS = new Map<string, string>();
const HOOKED_WEB_CONTENTS = new WeakSet<WebContents>();
const HOOKED_MAIN_BRIDGE_WC = new WeakSet<WebContents>();

interface NodePtyProcess {
  readonly pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void } | void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): NodePtyProcess;
}

let cachedNodePty: NodePtyModule | null | undefined;

function loadNodePtyModule(): NodePtyModule | null {
  if (cachedNodePty !== undefined) return cachedNodePty;
  const candidatePackageJsons = [
    Path.resolve(process.cwd(), "apps/server/package.json"),
    Path.resolve(process.cwd(), "../server/package.json"),
    Path.resolve(process.cwd(), "../../apps/server/package.json"),
  ];
  try {
    if (typeof import.meta?.url === "string" && import.meta.url.startsWith("file:")) {
      const here = Path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
      candidatePackageJsons.unshift(
        Path.resolve(here, "../../../../apps/server/package.json"),
        Path.resolve(here, "../../../server/package.json"),
      );
    }
  } catch {
    // Best-effort URL resolution.
  }

  for (const pkgPath of candidatePackageJsons) {
    try {
      const req = createRequire(pkgPath);
      const mod = req("node-pty") as Partial<NodePtyModule> | null;
      if (mod && typeof mod.spawn === "function") {
        cachedNodePty = mod as NodePtyModule;
        return cachedNodePty;
      }
    } catch {
      // Try next candidate path.
    }
  }
  cachedNodePty = null;
  return null;
}

export interface DraggableRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly drag: boolean;
}

export interface NodeApiWindowSession {
  readonly appId: string;
  readonly installId: string | null;
  readonly accountId: string;
  readonly orgId: string;
  readonly appName: string;
  readonly isInstalled: boolean;
  readonly revision: number;
  readonly contentHash: string | null;
  readonly declaredPermissions: readonly DesktopPageAppPermission[];
  readonly trustKind: DesktopPageAppTrustKind;
  readonly hasMixedVersions: boolean;
  readonly expectedFrameOrigin: string;
  readonly browserWindow: BrowserWindow;
  readonly contentWebContents: WebContents;
  readonly iconPath: string | null;
  readonly referenceText: string;
  tray?: Tray | null | undefined;
  readonly registeredShortcuts: Set<string>;
  readonly childProcesses: Map<string, ChildProcess.ChildProcess>;
  readonly ptyProcesses: Map<
    string,
    {
      pid?: number | null;
      kill: (sig?: string) => void;
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
    }
  >;
  powerBlockerId?: number | null;
  lastShellOpenAt: number;
  lastShellExternalAt?: number | undefined;
  draggableRegions: DraggableRegion[];
  activeFrame?: WebFrameMain | null | undefined;
  activeNotification?: Notification | null | undefined;
  dragRegionsTtlTimer?: ReturnType<typeof setTimeout> | null | undefined;
  hasActiveDialog?: boolean | undefined;
  isMainBridge?: boolean | undefined;
  takeGesture?: (() => boolean) | undefined;
  onTriggerInstall?: (() => Promise<unknown>) | undefined;
  onOpenPermissionsWindow?: (() => Promise<void>) | undefined;
  onRequestExitApp?: (() => void) | undefined;
  onShowAppWindow?: (() => void) | undefined;
  onOverlayChanged?: ((options: StoredDesktopPageAppWindowStyle) => void) | undefined;
  onRebuildWindowForStyle?: ((options: StoredDesktopPageAppWindowStyle) => void) | undefined;
}

export class PageAppNodeApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PageAppNodeApiError";
    this.code = code;
  }
}

/** Tracks single-use user-gesture timestamps within a short window (default 5 seconds). */
export function createGestureTracker(windowMs = GESTURE_WINDOW_MS): {
  recordGesture: () => void;
  takeGesture: () => boolean;
} {
  let lastGestureAt = 0;
  return {
    recordGesture: () => {
      lastGestureAt = Date.now();
    },
    takeGesture: () => {
      const valid = lastGestureAt > 0 && Date.now() - lastGestureAt <= windowMs;
      lastGestureAt = 0;
      return valid;
    },
  };
}

/** Validates global shortcut syntax and rejects unsafe / reserved combinations. */
export function validateGlobalShortcutAccelerator(
  accelerator: string,
  platform: NodeJS.Platform = process.platform,
): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  if (typeof accelerator !== "string" || accelerator.trim().length === 0) {
    return { ok: false, reason: "快捷键不能为空。" };
  }
  const trimmed = accelerator.trim();
  if (trimmed.length > SHORTCUT_MAX_CHARS) {
    return { ok: false, reason: `快捷键长度不能超过 ${SHORTCUT_MAX_CHARS} 个字符。` };
  }
  const tokens = trimmed
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tokens.length < 3) {
    return { ok: false, reason: "全局快捷键至少需要 2 个修饰键和 1 个主键。" };
  }

  const modifiers: string[] = [];
  const primaryKeys: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (BANNED_MODIFIERS.has(lower)) {
      return { ok: false, reason: `禁止使用系统保留修饰键: ${token}` };
    }
    if (CMD_MODIFIERS.has(lower)) {
      if (platform !== "darwin") {
        return { ok: false, reason: `当前平台禁止使用系统保留修饰键: ${token}` };
      }
      if (!modifiers.includes("command")) modifiers.push("command");
      continue;
    }
    if (ALLOWED_MODIFIERS.has(lower)) {
      const canonical = lower === "ctrl" ? "control" : lower === "option" ? "alt" : lower;
      if (!modifiers.includes(canonical)) modifiers.push(canonical);
    } else {
      primaryKeys.push(token);
    }
  }

  if (modifiers.length < 2 || primaryKeys.length !== 1) {
    return { ok: false, reason: "全局快捷键必须包含至少 2 个修饰键和 1 个主键。" };
  }
  if (modifiers.includes("control") && modifiers.includes("alt")) {
    return { ok: false, reason: "禁止注册 Ctrl+Alt+* 组合快捷键。" };
  }

  const primaryLower = primaryKeys[0]!.toLowerCase();
  if (BANNED_SHORTCUT_PRIMARY_KEYS.has(primaryLower)) {
    return { ok: false, reason: `禁止使用系统保留主键: ${primaryKeys[0]}` };
  }

  return { ok: true };
}

/** Sanitizes notification body to 1..300 Unicode code points without control sequences. */
export function sanitizeNotificationBody(rawBody: unknown): string {
  if (typeof rawBody !== "string") {
    throw new PageAppNodeApiError("invalid_argument", "通知内容必须是字符串。");
  }
  if (rawBody.length > NOTIFICATION_RAW_MAX_CHARS) {
    throw new PageAppNodeApiError(
      "invalid_argument",
      `通知原始内容不能超过 ${NOTIFICATION_RAW_MAX_CHARS} 个字符。`,
    );
  }
  let stripped = "";
  for (let i = 0; i < rawBody.length; i += 1) {
    const code = rawBody.charCodeAt(i);
    stripped += code <= 0x1f || code === 0x7f ? " " : rawBody[i]!;
  }
  const cleaned = stripped.replace(/\s+/gu, " ").trim();
  const codepoints = Array.from(cleaned);
  if (codepoints.length === 0) {
    throw new PageAppNodeApiError("invalid_argument", "通知内容不能为空。");
  }
  return codepoints.slice(0, NOTIFICATION_BODY_MAX_CODEPOINTS).join("");
}

/** Validates tray icon PNG DataURL (16-1024px square, <=256KB, >=4% alpha>=128 pixels at 36px). */
export function validateTrayPngDataUrl(dataUrl: string): {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
} {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new PageAppNodeApiError("invalid_argument", "托盘图标必须是 PNG DataURL。");
  }
  const base64 = dataUrl.slice("data:image/png;base64,".length);
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0 || buffer.length > 256 * 1024) {
    throw new PageAppNodeApiError("invalid_argument", "托盘图标大小不能超过 256 KB。");
  }
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    throw new PageAppNodeApiError("invalid_argument", "无效的 PNG 图标数据。");
  }
  const { width, height } = image.getSize();
  if (width !== height || width < 16 || width > 1024) {
    throw new PageAppNodeApiError("invalid_argument", "托盘图标必须是 16–1024px 的正方形 PNG。");
  }
  const maybeResized =
    typeof (image as { resize?: unknown }).resize === "function"
      ? image.resize({ width: 36, height: 36 })
      : image;
  const sampledSize = maybeResized.getSize();
  const bitmap = maybeResized.toBitmap();
  const totalPixels = sampledSize.width * sampledSize.height;
  let opaquePixels = 0;
  for (let i = 3; i < bitmap.length; i += 4) {
    if ((bitmap[i] ?? 0) >= 128) opaquePixels += 1;
  }
  if (totalPixels > 0 && opaquePixels / totalPixels < 0.04) {
    throw new PageAppNodeApiError("invalid_argument", "托盘图标可见像素比例需不少于 4%。");
  }
  return { buffer, width, height };
}

function isForbiddenMenuAccelerator(accelerator: string): boolean {
  const parts = accelerator
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const hasCmd = parts.some(
    (p) => p === "cmd" || p === "command" || p === "cmdorctrl" || p === "commandorcontrol",
  );
  const hasOpt = parts.some((p) => /^(?:opt|option|alt)$/.test(p));
  const primary = parts[parts.length - 1];
  if (hasCmd && primary === "q") return true;
  if (hasCmd && hasOpt && (primary === "esc" || primary === "escape")) return true;
  return false;
}

/** Validates and converts an app Menu template (forbids `role` & Cmd+Q/Opt+Cmd+Esc, depth<=4, <=500). */
export function sanitizePageAppMenuTemplate(
  rawItems: unknown,
  onClick: (id: string) => void,
  depth = 1,
  counter = { count: 0 },
): MenuItemConstructorOptions[] {
  if (!Array.isArray(rawItems)) {
    throw new PageAppNodeApiError("invalid_argument", "菜单模板必须是数组。");
  }
  if (depth > PAGE_APP_MAX_MENU_DEPTH) {
    throw new PageAppNodeApiError(
      "invalid_argument",
      `菜单嵌套深度不能超过 ${PAGE_APP_MAX_MENU_DEPTH} 层。`,
    );
  }
  const result: MenuItemConstructorOptions[] = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (item.role !== undefined) {
      throw new PageAppNodeApiError("invalid_argument", "应用菜单禁止指定系统 role。");
    }
    counter.count += 1;
    if (counter.count > PAGE_APP_MAX_MENU_ITEMS) {
      throw new PageAppNodeApiError(
        "invalid_argument",
        `菜单项总数不能超过 ${PAGE_APP_MAX_MENU_ITEMS}。`,
      );
    }
    if (item.type === "separator") {
      result.push({ type: "separator" });
      continue;
    }
    const label = typeof item.label === "string" ? item.label.slice(0, 128) : "";
    const id = typeof item.id === "string" && item.id ? item.id : label;
    const enabled = item.enabled !== false;
    const type =
      item.type === "checkbox" || item.type === "radio" ? item.type : ("normal" as const);
    const checked = typeof item.checked === "boolean" ? item.checked : undefined;
    const accelerator = typeof item.accelerator === "string" ? item.accelerator : undefined;
    if (accelerator && isForbiddenMenuAccelerator(accelerator)) {
      throw new PageAppNodeApiError("invalid_argument", `菜单项禁止使用系统快捷键: ${accelerator}`);
    }

    if (Array.isArray(item.submenu)) {
      result.push({
        label,
        enabled,
        submenu: sanitizePageAppMenuTemplate(item.submenu, onClick, depth + 1, counter),
      });
    } else {
      result.push({
        id,
        label,
        type,
        enabled,
        ...(checked !== undefined ? { checked } : {}),
        ...(accelerator ? { accelerator } : {}),
        click: () => onClick(id),
      });
    }
  }
  return result;
}

/** Clamps bounds to nearest display workArea with minimum width/height constraints. */
export function clampBoundsToWorkArea(
  bounds: {
    readonly x?: number;
    readonly y?: number;
    readonly width: number;
    readonly height: number;
  },
  minWidth: number,
  minHeight: number,
  workAreas: readonly Electron.Rectangle[],
): Electron.Rectangle {
  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1280, height: 800 };
  const targetWidth = Math.max(minWidth, Math.min(Math.round(bounds.width), primary.width));
  const targetHeight = Math.max(minHeight, Math.min(Math.round(bounds.height), primary.height));
  const rawX =
    typeof bounds.x === "number" && Number.isFinite(bounds.x)
      ? Math.round(bounds.x)
      : primary.x + Math.round((primary.width - targetWidth) / 2);
  const rawY =
    typeof bounds.y === "number" && Number.isFinite(bounds.y)
      ? Math.round(bounds.y)
      : primary.y + Math.round((primary.height - targetHeight) / 2);

  const cx = rawX + targetWidth / 2;
  const cy = rawY + targetHeight / 2;
  let chosen = primary;
  for (const area of workAreas) {
    if (cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height) {
      chosen = area;
      break;
    }
  }

  const width = Math.max(minWidth, Math.min(targetWidth, chosen.width));
  const height = Math.max(minHeight, Math.min(targetHeight, chosen.height));
  const x = Math.max(chosen.x, Math.min(rawX, chosen.x + chosen.width - width));
  const y = Math.max(chosen.y, Math.min(rawY, chosen.y + chosen.height - height));
  return { x, y, width, height };
}

/** Truncates draggable regions to max 64, prioritizing `no-drag` entries first. */
export function normalizeDraggableRegions(rawRegions: unknown): DraggableRegion[] {
  if (!Array.isArray(rawRegions)) return [];
  const noDrag: DraggableRegion[] = [];
  const drag: DraggableRegion[] = [];
  for (const item of rawRegions) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const x = typeof r.x === "number" && Number.isFinite(r.x) ? r.x : 0;
    const y = typeof r.y === "number" && Number.isFinite(r.y) ? r.y : 0;
    const width =
      typeof r.width === "number" && Number.isFinite(r.width) ? Math.max(0, r.width) : 0;
    const height =
      typeof r.height === "number" && Number.isFinite(r.height) ? Math.max(0, r.height) : 0;
    if (width <= 0 || height <= 0) continue;
    const entry: DraggableRegion = { x, y, width, height, drag: r.drag !== false };
    if (entry.drag) drag.push(entry);
    else noDrag.push(entry);
  }
  return [...noDrag, ...drag].slice(0, PAGE_APP_MAX_DRAG_REGIONS);
}

/** Resolves and validates a user filesystem path (rejects control chars, expands `~`, anchors to homedir). */
export function resolveSafeFsPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new PageAppNodeApiError("invalid_argument", "路径不能为空。");
  }
  for (let i = 0; i < rawPath.length; i += 1) {
    const code = rawPath.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new PageAppNodeApiError("invalid_argument", "路径包含非法控制字符。");
    }
  }
  const home = OS.homedir();
  let expanded = rawPath;
  if (rawPath === "~") {
    expanded = home;
  } else if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    expanded = Path.join(home, rawPath.slice(2));
  }
  return Path.resolve(home, expanded);
}

/** Checks whether a path is blocked by `shell.openPath` executable safety rules. */
export function isForbiddenShellOpenTarget(resolvedPath: string, isFile: boolean): boolean {
  const ext = Path.extname(resolvedPath).toLowerCase();
  if (FORBIDDEN_OPEN_EXTENSIONS.has(ext)) {
    return true;
  }
  if (isFile && ext === "") {
    return true;
  }
  return false;
}

/** Checks if an extensionless directory has a sibling executable file (`dir.exe`, `dir.cmd`, etc.). */
export async function hasShadowingExecutableSibling(resolvedPath: string): Promise<boolean> {
  if (Path.extname(resolvedPath) !== "") return false;
  for (const ext of SHELL_SHADOW_EXTENSIONS) {
    try {
      await FS.access(`${resolvedPath}${ext}`);
      return true;
    } catch {
      // Continue checking remaining sibling extensions.
    }
  }
  return false;
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeSpawnEnv(rawEnv: unknown): NodeJS.ProcessEnv | undefined {
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return undefined;
  }
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== "string") continue;
    if (DANGEROUS_ENV_KEYS.has(key.toUpperCase())) continue;
    merged[key] = value;
  }
  return merged;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(
  pid: number | null | undefined,
  fallbackKill: (sig?: NodeJS.Signals) => void,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32" && typeof pid === "number" && pid > 0) {
    if (!isProcessAlive(pid)) return;
    try {
      execProcessFile("taskkill", ["/PID", String(pid), "/T", "/F"], {}, () => undefined);
    } catch {
      // Fallback below.
    }
  }
  try {
    fallbackKill(signal);
  } catch {
    // Process already exited.
  }
}

function sendSessionEvent(
  explicitFrame: WebFrameMain | null | undefined,
  session: NodeApiWindowSession,
  event: DesktopPageAppNodeApiEvent,
): void {
  if (session.isMainBridge) {
    const wc = session.browserWindow?.webContents;
    if (!wc || wc.isDestroyed?.()) return;
    try {
      wc.send(PAGE_APP_DESKTOP_IPC_CHANNELS.desktopApiEvent, event);
    } catch {
      // Main window closed.
    }
    return;
  }
  const wc = session.contentWebContents;
  if (!wc || wc.isDestroyed?.()) return;
  const targetFrame =
    session.activeFrame && !session.activeFrame.isDestroyed?.()
      ? session.activeFrame
      : explicitFrame;
  if (targetFrame && !targetFrame.isDestroyed?.()) {
    try {
      targetFrame.send(PAGE_APP_NODE_APIS_EVENT_CHANNEL, event);
    } catch {
      // Frame gone.
    }
  }
}

function holdBackgroundPower(session: NodeApiWindowSession): void {
  if (typeof session.powerBlockerId === "number") return;
  try {
    session.powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  } catch {
    // Ignore in environments without powerSaveBlocker.
  }
}

function releaseBackgroundPowerIfIdle(session: NodeApiWindowSession): void {
  if (session.registeredShortcuts.size > 0 || (session.tray && !session.tray.isDestroyed())) {
    return;
  }
  if (typeof session.powerBlockerId !== "number") return;
  try {
    if (powerSaveBlocker.isStarted(session.powerBlockerId)) {
      powerSaveBlocker.stop(session.powerBlockerId);
    }
  } catch {
    // Ignore.
  }
  session.powerBlockerId = null;
}

/** Unregisters all global shortcuts held by a session and updates the global owner registry. */
export function teardownShortcutsForSession(session: NodeApiWindowSession): void {
  for (const accelerator of session.registeredShortcuts) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Ignore unregistered shortcut.
    }
    if (GLOBAL_SHORTCUT_OWNERS.get(accelerator) === session.appId) {
      GLOBAL_SHORTCUT_OWNERS.delete(accelerator);
    }
  }
  session.registeredShortcuts.clear();
  releaseBackgroundPowerIfIdle(session);
}

/** Destroys the tray item held by a session and releases background power blocker if idle. */
export function teardownTrayForSession(session: NodeApiWindowSession): void {
  if (session.tray && !session.tray.isDestroyed()) {
    try {
      session.tray.destroy();
    } catch {
      // Ignore.
    }
  }
  session.tray = null;
  releaseBackgroundPowerIfIdle(session);
}

/** Kills all child processes and PTYs spawned by a session. */
export function teardownProcessesForSession(session: NodeApiWindowSession): void {
  for (const [id, child] of session.childProcesses) {
    killProcessTree(child.pid, (sig) => child.kill(sig), "SIGKILL");
    session.childProcesses.delete(id);
  }
  for (const [id, ptyProc] of session.ptyProcesses) {
    killProcessTree(ptyProc.pid, () => ptyProc.kill("SIGKILL"), "SIGKILL");
    session.ptyProcesses.delete(id);
  }
}

/** Clears draggable region TTL timer, overlay regions, and mouse-passthrough state for a session. */
export function teardownOverlayForSession(session: NodeApiWindowSession): void {
  if (session.dragRegionsTtlTimer) {
    clearTimeout(session.dragRegionsTtlTimer);
    session.dragRegionsTtlTimer = null;
  }
  session.draggableRegions = [];
  if (!session.browserWindow.isDestroyed?.()) {
    try {
      session.browserWindow.setIgnoreMouseEvents?.(false);
    } catch {
      // Ignore if window doesn't support ignoreMouseEvents.
    }
    try {
      const topFrame = session.browserWindow.webContents?.mainFrame;
      if (topFrame && !topFrame.isDestroyed?.()) {
        topFrame.send(PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL, { regions: [] });
      }
    } catch {
      // Ignore closed frame.
    }
  }
}

/** Tears down all privileged resources (processes, shortcuts, tray, overlay, notification) for a session. */
export function teardownSessionPrivilegedResources(session: NodeApiWindowSession): void {
  teardownProcessesForSession(session);
  teardownShortcutsForSession(session);
  teardownTrayForSession(session);
  teardownOverlayForSession(session);
  if (session.activeNotification) {
    try {
      session.activeNotification.close();
    } catch {
      // Ignore.
    }
    session.activeNotification = null;
  }
}

export class PageAppNodeApiExecutor {
  private readonly store: DesktopPageAppStore;
  private readonly permissions: DesktopPageAppPermissionEngine;
  private readonly dialogs: PageAppDialogHost;
  private readonly sessionsByWebContentsId = new Map<number, NodeApiWindowSession>();
  private readonly mainBridgeSessions = new Map<string, NodeApiWindowSession>();
  private processIdCounter = 1;

  constructor(options: {
    readonly store: DesktopPageAppStore;
    readonly permissions: DesktopPageAppPermissionEngine;
    readonly dialogs: PageAppDialogHost;
  }) {
    this.store = options.store;
    this.permissions = options.permissions;
    this.dialogs = options.dialogs;
  }

  registerSession(session: NodeApiWindowSession): void {
    const wc = session.contentWebContents;
    this.sessionsByWebContentsId.set(wc.id, session);
    if (!HOOKED_WEB_CONTENTS.has(wc) && typeof (wc as { on?: unknown }).on === "function") {
      HOOKED_WEB_CONTENTS.add(wc);
      wc.on("did-navigate", () => {
        const current = this.sessionsByWebContentsId.get(wc.id);
        if (current) teardownOverlayForSession(current);
      });
      wc.once("destroyed", () => {
        this.unregisterSession(wc.id);
      });
    }
  }

  unregisterSession(webContentsId: number): void {
    const existing = this.sessionsByWebContentsId.get(webContentsId);
    if (existing) {
      teardownSessionPrivilegedResources(existing);
      this.sessionsByWebContentsId.delete(webContentsId);
    }
  }

  getSession(webContentsId: number): NodeApiWindowSession | null {
    return this.sessionsByWebContentsId.get(webContentsId) ?? null;
  }

  /** Verifies that the IPC sender is a live, non-detached direct child iframe matching expected origin. */
  verifyCaller(event: IpcMainInvokeEvent): NodeApiWindowSession {
    if (event.sender.isDestroyed?.() === true) {
      throw new PageAppNodeApiError("unavailable", "调用方窗口已销毁。");
    }
    const session = this.sessionsByWebContentsId.get(event.sender.id);
    if (!session) {
      throw new PageAppNodeApiError("unavailable", "当前上下文不是独立桌面应用窗口。");
    }
    const frame = event.senderFrame as (WebFrameMain & { detached?: boolean }) | null;
    if (
      !frame ||
      frame.isDestroyed?.() === true ||
      frame.detached === true ||
      frame.parent !== event.sender.mainFrame
    ) {
      throw new PageAppNodeApiError(
        "not_granted",
        "仅允许独立应用顶层壳的直接子框架调用桌面接口。",
      );
    }
    if (
      !session.expectedFrameOrigin ||
      session.expectedFrameOrigin === "null" ||
      frame.origin !== session.expectedFrameOrigin
    ) {
      throw new PageAppNodeApiError("not_granted", "调用来源域与已登记应用页不匹配。");
    }
    if (session.hasMixedVersions) {
      teardownSessionPrivilegedResources(session);
      throw new PageAppNodeApiError(
        "version_mismatch",
        "应用页运行期间发生版本更新混跑，特权桌面能力已立即冻结。",
      );
    }
    session.activeFrame = frame;
    return session;
  }

  /** Updates the session's declared permissions list from validated manifest output. */
  declarePermissionsForSession(session: NodeApiWindowSession, rawPermissions: unknown): string[] {
    if (!Array.isArray(rawPermissions)) return [...session.declaredPermissions];
    const next: DesktopPageAppPermission[] = [];
    const seen = new Set<string>();
    for (const item of rawPermissions.slice(0, 32)) {
      if (typeof item !== "string" || item.length > 64) continue;
      if (!isDesktopPageAppPermission(item) || seen.has(item)) continue;
      seen.add(item);
      next.push(item);
    }
    (session as { declaredPermissions: readonly DesktopPageAppPermission[] }).declaredPermissions =
      next;
    return [...next];
  }

  private async ensurePermission(
    session: NodeApiWindowSession,
    permission: DesktopPageAppPermission,
    promptIfNeeded: boolean,
  ): Promise<void> {
    const evalResult = this.permissions.evaluate({
      accountId: session.accountId,
      orgId: session.orgId,
      appId: session.appId,
      permission,
      declaredPermissions: session.declaredPermissions,
      currentRevision: session.revision,
      currentContentHash: session.contentHash,
      hasMixedVersions: session.hasMixedVersions,
      trustKind: session.trustKind,
    });
    if (evalResult.state === "granted") return;
    if (evalResult.state === "unavailable") {
      throw new PageAppNodeApiError("unavailable", `权限 ${permission} 不可用。`);
    }
    if (evalResult.state === "denied" || !promptIfNeeded) {
      throw new PageAppNodeApiError("not_granted", `权限 ${permission} 未被授予。`);
    }
    session.hasActiveDialog = true;
    let granted = false;
    try {
      granted = await this.dialogs.confirmPermission(
        {
          appName: session.appName,
          permission,
          isReapproval: evalResult.isReapproval,
          trustKind: session.trustKind,
        },
        session.browserWindow,
      );
    } finally {
      session.hasActiveDialog = false;
    }
    this.permissions.setPermission({
      accountId: session.accountId,
      orgId: session.orgId,
      appId: session.appId,
      permission,
      answer: granted ? "granted" : "denied",
      revision: session.revision,
      contentHash: session.contentHash,
      declaredPermissions: session.declaredPermissions,
    });
    if (!granted) {
      throw new PageAppNodeApiError("not_granted", `用户拒绝授予权限 ${permission}。`);
    }
  }

  async execute(
    event: IpcMainInvokeEvent,
    payload: {
      readonly namespace?: unknown;
      readonly domain?: unknown;
      readonly method?: unknown;
      readonly args?: unknown;
    },
  ): Promise<unknown> {
    const session = this.verifyCaller(event);
    const frame = event.senderFrame;
    const namespace =
      typeof payload?.namespace === "string"
        ? payload.namespace
        : typeof payload?.domain === "string"
          ? payload.domain
          : "";
    const method = typeof payload?.method === "string" ? payload.method : "";
    const args = Array.isArray(payload?.args) ? payload.args[0] : payload?.args;

    return this.dispatch(session, frame, namespace, method, args);
  }

  /**
   * Executes desktop APIs from the main-window preview broker using a persistent session keyed
   * by `(mainWindow.webContents.id, appId)` so processes, shortcuts, tray, and events persist.
   */
  async executeFromMainBridge(
    input: DesktopPageAppNodeApiCallInput,
    mainWindow: BrowserWindow | null,
    defaults: {
      readonly accountId: string;
      readonly orgId: string;
      readonly appName: string;
      readonly declaredPermissions: readonly DesktopPageAppPermission[];
      readonly trustKind: DesktopPageAppTrustKind;
      readonly takeGesture?: () => boolean;
      readonly onTriggerInstall?: () => Promise<unknown>;
      readonly onOpenPermissionsWindow?: () => Promise<void>;
    },
  ): Promise<unknown> {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new PageAppNodeApiError("unavailable", "主窗口不可用。");
    }
    const wc = mainWindow.webContents;
    const key = `${wc.id}|${input.appId}`;
    const installed = this.store.findInstalledByAppId(input.appId);
    let session = this.mainBridgeSessions.get(key);

    if (!session) {
      session = {
        appId: input.appId,
        installId: installed?.installId ?? input.installId ?? null,
        accountId: defaults.accountId,
        orgId: defaults.orgId,
        appName: defaults.appName,
        isInstalled: installed !== null,
        revision: input.revision,
        contentHash: input.contentHash ?? null,
        declaredPermissions: defaults.declaredPermissions,
        trustKind: defaults.trustKind,
        hasMixedVersions: false,
        expectedFrameOrigin: "",
        browserWindow: mainWindow,
        contentWebContents: wc,
        iconPath: installed?.iconPath ?? null,
        referenceText: installed?.sourceUrl ?? `moss://apps/${input.appId}`,
        registeredShortcuts: new Set(),
        childProcesses: new Map(),
        ptyProcesses: new Map(),
        lastShellOpenAt: 0,
        draggableRegions: [],
        isMainBridge: true,
        takeGesture: defaults.takeGesture,
        onTriggerInstall: defaults.onTriggerInstall,
        onOpenPermissionsWindow: defaults.onOpenPermissionsWindow,
      };
      this.mainBridgeSessions.set(key, session);

      if (!HOOKED_MAIN_BRIDGE_WC.has(wc) && typeof (wc as { once?: unknown }).once === "function") {
        HOOKED_MAIN_BRIDGE_WC.add(wc);
        wc.once("destroyed", () => {
          const prefix = `${wc.id}|`;
          for (const [sessKey, sess] of this.mainBridgeSessions) {
            if (sessKey.startsWith(prefix)) {
              teardownSessionPrivilegedResources(sess);
              this.mainBridgeSessions.delete(sessKey);
            }
          }
        });
      }
    } else {
      const mutable = session as unknown as {
        revision: number;
        contentHash: string | null;
        appName: string;
        isInstalled: boolean;
        installId: string | null;
        declaredPermissions: readonly DesktopPageAppPermission[];
        trustKind: DesktopPageAppTrustKind;
        takeGesture?: (() => boolean) | undefined;
        onTriggerInstall?: (() => Promise<unknown>) | undefined;
        onOpenPermissionsWindow?: (() => Promise<void>) | undefined;
      };
      mutable.revision = input.revision;
      mutable.contentHash = input.contentHash ?? null;
      mutable.appName = defaults.appName;
      mutable.isInstalled = installed !== null;
      mutable.installId = installed?.installId ?? input.installId ?? null;
      if (defaults.declaredPermissions.length > 0) {
        mutable.declaredPermissions = defaults.declaredPermissions;
      }
      mutable.trustKind = defaults.trustKind;
      mutable.takeGesture = defaults.takeGesture;
      mutable.onTriggerInstall = defaults.onTriggerInstall;
      mutable.onOpenPermissionsWindow = defaults.onOpenPermissionsWindow;
    }

    return this.dispatch(session, null, input.namespace, input.method, input.args);
  }

  private async dispatch(
    session: NodeApiWindowSession,
    frame: WebFrameMain | null,
    namespace: string,
    method: string,
    args: unknown,
  ): Promise<unknown> {
    const policy = this.permissions.getPolicyState();
    if (!policy.enabled) {
      throw new PageAppNodeApiError("policy_blocked", "当前组织策略已禁用独立桌面应用功能。");
    }

    switch (namespace) {
      case "window":
        return this.handleWindow(session, frame, method, args);
      case "Menu":
        return this.handleMenu(session, frame, method, args);
      case "app":
        return this.handleDock(
          method.startsWith("dock.") ? method.slice("dock.".length) : method,
          args,
        );
      case "app.dock":
        return this.handleDock(method, args);
      case "tray":
        return this.handleTray(session, frame, method, args);
      case "notification":
        return this.handleNotification(session, method, args);
      case "globalShortcut":
        return this.handleGlobalShortcut(session, frame, method, args);
      case "screen":
        return this.handleScreen(session, method, args);
      case "os":
        return this.handleOs(session, method);
      case "fs":
        return this.handleFs(session, method, args);
      case "shell":
        return this.handleShell(session, method, args);
      case "childProcess":
        return this.handleChildProcess(session, frame, method, args);
      case "pty":
        return this.handlePty(session, frame, method, args);
      case "install":
        return this.handleInstall(session, method);
      case "permissions":
        return this.handlePermissions(session, method, args);
      default:
        throw new PageAppNodeApiError("invalid_argument", `未知桌面能力域: ${namespace}`);
    }
  }

  private async handleWindow(
    session: NodeApiWindowSession,
    frame: WebFrameMain | null,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    const win = session.browserWindow;
    if (win.isDestroyed()) throw new PageAppNodeApiError("unavailable", "窗口已关闭。");
    const opts = asObj(rawArgs);
    const styleKey = session.installId ?? session.appId;

    switch (method) {
      case "getOptions": {
        const bounds = win.getBounds();
        const stored = this.store.getWindowStyle(styleKey);
        const applied: DesktopPageAppWindowOptions = {
          width: bounds.width,
          height: bounds.height,
          x: bounds.x,
          y: bounds.y,
          ...(typeof stored?.minWidth === "number" ? { minWidth: stored.minWidth } : {}),
          ...(typeof stored?.minHeight === "number" ? { minHeight: stored.minHeight } : {}),
          ...(typeof stored?.maxWidth === "number" ? { maxWidth: stored.maxWidth } : {}),
          ...(typeof stored?.maxHeight === "number" ? { maxHeight: stored.maxHeight } : {}),
          resizable: win.isResizable(),
          minimizable: stored?.minimizable ?? win.isMinimizable?.() ?? true,
          maximizable: stored?.maximizable ?? win.isMaximizable?.() ?? true,
          fullscreenable: stored?.fullscreenable ?? win.isFullScreenable?.() ?? true,
          movable: stored?.movable ?? win.isMovable?.() ?? true,
          alwaysOnTop: win.isAlwaysOnTop(),
          frame: stored?.frame ?? true,
          transparent: stored?.transparent ?? false,
          hasShadow: stored?.hasShadow ?? true,
          roundedCorners: stored?.roundedCorners ?? true,
          ...(stored?.backgroundColor ? { backgroundColor: stored.backgroundColor } : {}),
          title: win.getTitle(),
          ...(stored?.titleBarStyle ? { titleBarStyle: stored.titleBarStyle } : {}),
          ...(stored?.vibrancy !== undefined ? { vibrancy: stored.vibrancy } : {}),
          visibleOnAllWorkspaces: stored?.visibleOnAllWorkspaces ?? false,
          ignoreMouseEvents: stored?.ignoreMouseEvents ?? false,
        };
        const result: DesktopPageAppWindowGetOptionsResult = {
          options: applied,
          applied,
        };
        return result;
      }
      case "setOptions": {
        if (opts.opacity !== undefined) {
          throw new PageAppNodeApiError("invalid_argument", "不支持设置整体窗口透明度 opacity。");
        }
        if (
          typeof opts.alwaysOnTopLevel === "string" &&
          opts.alwaysOnTopLevel !== "normal" &&
          opts.alwaysOnTopLevel !== "floating"
        ) {
          throw new PageAppNodeApiError("invalid_argument", "置顶层级不得高于 floating。");
        }
        if (
          opts.backgroundColor !== undefined &&
          (typeof opts.backgroundColor !== "string" ||
            !/^#[0-9a-fA-F]{6}$/u.test(opts.backgroundColor))
        ) {
          throw new PageAppNodeApiError(
            "invalid_argument",
            "backgroundColor 必须是 #RRGGBB 格式。",
          );
        }
        if (
          opts.titleBarStyle !== undefined &&
          (typeof opts.titleBarStyle !== "string" ||
            !ALLOWED_TITLE_BAR_STYLES.has(opts.titleBarStyle))
        ) {
          throw new PageAppNodeApiError("invalid_argument", "无效的 titleBarStyle。");
        }
        if (
          opts.vibrancy !== undefined &&
          (typeof opts.vibrancy !== "string" || !ALLOWED_VIBRANCY_VALUES.has(opts.vibrancy))
        ) {
          throw new PageAppNodeApiError("invalid_argument", "无效的 vibrancy 值。");
        }
        if (
          opts.visualEffectState !== undefined &&
          (typeof opts.visualEffectState !== "string" ||
            !ALLOWED_VISUAL_EFFECT_STATES.has(opts.visualEffectState))
        ) {
          throw new PageAppNodeApiError("invalid_argument", "无效的 visualEffectState 值。");
        }

        const existingStyle = this.store.getWindowStyle(styleKey);
        const effectiveFrame =
          typeof opts.frame === "boolean" ? opts.frame : (existingStyle?.frame ?? true);
        if (opts.transparent === true && effectiveFrame !== false) {
          throw new PageAppNodeApiError(
            "invalid_argument",
            "启用透明窗口 transparent 时必须设置 frame: false。",
          );
        }
        if (
          opts.visualEffectState !== undefined &&
          opts.vibrancy === undefined &&
          !existingStyle?.vibrancy
        ) {
          throw new PageAppNodeApiError(
            "invalid_argument",
            "设置 visualEffectState 需同时指定 vibrancy。",
          );
        }

        if (
          process.platform === "win32" &&
          !session.isInstalled &&
          (opts.frame === false ||
            opts.transparent === true ||
            opts.titleBarStyle !== undefined ||
            opts.vibrancy !== undefined)
        ) {
          throw new PageAppNodeApiError(
            "ENOTSUP",
            "Windows 平台需先安装为独立应用后方可使用无边框、透明或毛玻璃窗口。",
          );
        }

        const needsOverlay =
          opts.frame === false ||
          opts.transparent === true ||
          opts.alwaysOnTop === true ||
          opts.visibleOnAllWorkspaces === true ||
          opts.titleBarStyle !== undefined ||
          opts.trafficLightPosition !== undefined ||
          opts.vibrancy !== undefined ||
          opts.hasShadow === false ||
          opts.roundedCorners === false;
        if (needsOverlay) {
          await this.ensurePermission(session, "overlay", true);
        }

        if (typeof opts.title === "string" && opts.title.trim()) {
          win.setTitle(opts.title.trim().slice(0, 128));
        }
        if (typeof opts.resizable === "boolean") win.setResizable(opts.resizable);
        if (typeof opts.minimizable === "boolean") win.setMinimizable(opts.minimizable);
        if (typeof opts.fullscreenable === "boolean") {
          win.setFullScreenable?.(opts.transparent === true ? false : opts.fullscreenable);
        }
        if (typeof opts.movable === "boolean") win.setMovable?.(opts.movable);
        if (typeof opts.hasShadow === "boolean") win.setHasShadow?.(opts.hasShadow);
        if (typeof opts.closable === "boolean") win.setClosable(opts.closable);
        if (typeof opts.skipTaskbar === "boolean") win.setSkipTaskbar(opts.skipTaskbar);
        if (typeof opts.backgroundColor === "string") {
          win.setBackgroundColor?.(opts.backgroundColor);
        }
        if (typeof opts.alwaysOnTop === "boolean") {
          win.setAlwaysOnTop(opts.alwaysOnTop, "floating");
        }
        if (typeof opts.visibleOnAllWorkspaces === "boolean") {
          win.setVisibleOnAllWorkspaces(opts.visibleOnAllWorkspaces, {
            visibleOnFullScreen: true,
          });
        }
        if (opts.transparent === true) {
          win.setMaximizable(false);
          win.setFullScreenable(false);
        } else if (typeof opts.maximizable === "boolean") {
          win.setMaximizable(opts.maximizable);
        }

        const nextMinW =
          typeof opts.minWidth === "number" && Number.isFinite(opts.minWidth)
            ? Math.max(200, Math.round(opts.minWidth))
            : existingStyle?.minWidth;
        const nextMinH =
          typeof opts.minHeight === "number" && Number.isFinite(opts.minHeight)
            ? Math.max(120, Math.round(opts.minHeight))
            : existingStyle?.minHeight;
        if (typeof nextMinW === "number" && typeof nextMinH === "number") {
          win.setMinimumSize?.(nextMinW, nextMinH);
        }
        const nextMaxW =
          typeof opts.maxWidth === "number" && Number.isFinite(opts.maxWidth)
            ? Math.max(200, Math.round(opts.maxWidth))
            : existingStyle?.maxWidth;
        const nextMaxH =
          typeof opts.maxHeight === "number" && Number.isFinite(opts.maxHeight)
            ? Math.max(120, Math.round(opts.maxHeight))
            : existingStyle?.maxHeight;
        if (typeof nextMaxW === "number" && typeof nextMaxH === "number") {
          win.setMaximumSize?.(nextMaxW, nextMaxH);
        }

        if (
          typeof opts.width === "number" ||
          typeof opts.height === "number" ||
          typeof opts.x === "number" ||
          typeof opts.y === "number"
        ) {
          const current = win.getBounds();
          const clamped = clampBoundsToWorkArea(
            {
              x: typeof opts.x === "number" ? opts.x : current.x,
              y: typeof opts.y === "number" ? opts.y : current.y,
              width: typeof opts.width === "number" ? opts.width : current.width,
              height: typeof opts.height === "number" ? opts.height : current.height,
            },
            200,
            120,
            screen.getAllDisplays().map((d) => d.workArea),
          );
          win.setBounds(clamped);
        }

        const trafficLight =
          opts.trafficLightPosition &&
          typeof opts.trafficLightPosition === "object" &&
          typeof (opts.trafficLightPosition as { x?: unknown }).x === "number" &&
          typeof (opts.trafficLightPosition as { y?: unknown }).y === "number"
            ? {
                x: Math.max(
                  8,
                  Math.min(40, Math.round((opts.trafficLightPosition as { x: number }).x)),
                ),
                y: Math.max(
                  6,
                  Math.min(40, Math.round((opts.trafficLightPosition as { y: number }).y)),
                ),
              }
            : undefined;

        const nextStyle: StoredDesktopPageAppWindowStyle = {
          ...existingStyle,
          ...(typeof opts.alwaysOnTop === "boolean" ? { alwaysOnTop: opts.alwaysOnTop } : {}),
          ...(typeof opts.frame === "boolean" ? { frame: opts.frame } : {}),
          ...(typeof opts.transparent === "boolean" ? { transparent: opts.transparent } : {}),
          ...(typeof opts.visibleOnAllWorkspaces === "boolean"
            ? { visibleOnAllWorkspaces: opts.visibleOnAllWorkspaces }
            : {}),
          ...(typeof opts.titleBarStyle === "string"
            ? { titleBarStyle: opts.titleBarStyle as DesktopPageAppWindowOptions["titleBarStyle"] }
            : {}),
          ...(trafficLight ? { trafficLightPosition: trafficLight } : {}),
          ...(typeof opts.dragHeight === "number"
            ? {
                dragHeight:
                  opts.dragHeight === 0
                    ? 0
                    : Math.max(12, Math.min(64, Math.round(opts.dragHeight))),
              }
            : {}),
          ...(typeof nextMinW === "number" ? { minWidth: nextMinW } : {}),
          ...(typeof nextMinH === "number" ? { minHeight: nextMinH } : {}),
          ...(typeof nextMaxW === "number" ? { maxWidth: nextMaxW } : {}),
          ...(typeof nextMaxH === "number" ? { maxHeight: nextMaxH } : {}),
          ...(typeof opts.resizable === "boolean" ? { resizable: opts.resizable } : {}),
          ...(typeof opts.minimizable === "boolean" ? { minimizable: opts.minimizable } : {}),
          ...(typeof opts.maximizable === "boolean" ? { maximizable: opts.maximizable } : {}),
          ...(typeof opts.fullscreenable === "boolean"
            ? { fullscreenable: opts.fullscreenable }
            : {}),
          ...(typeof opts.movable === "boolean" ? { movable: opts.movable } : {}),
          ...(typeof opts.hasShadow === "boolean" ? { hasShadow: opts.hasShadow } : {}),
          ...(typeof opts.roundedCorners === "boolean"
            ? { roundedCorners: opts.roundedCorners }
            : {}),
          ...(typeof opts.backgroundColor === "string"
            ? { backgroundColor: opts.backgroundColor }
            : {}),
          ...(typeof opts.vibrancy === "string"
            ? { vibrancy: opts.vibrancy as DesktopPageAppWindowOptions["vibrancy"] }
            : {}),
          ...(typeof opts.visualEffectState === "string"
            ? {
                visualEffectState:
                  opts.visualEffectState as StoredDesktopPageAppWindowStyle["visualEffectState"],
              }
            : {}),
          bounds: win.getBounds(),
          updatedAt: new Date().toISOString(),
        };
        this.store.setWindowStyle(styleKey, nextStyle);

        const needsRebuild =
          (typeof opts.frame === "boolean" && opts.frame !== (existingStyle?.frame ?? true)) ||
          (typeof opts.transparent === "boolean" &&
            opts.transparent !== (existingStyle?.transparent ?? false)) ||
          (typeof opts.titleBarStyle === "string" &&
            opts.titleBarStyle !== existingStyle?.titleBarStyle) ||
          (typeof opts.vibrancy === "string" && opts.vibrancy !== existingStyle?.vibrancy) ||
          (typeof opts.roundedCorners === "boolean" &&
            opts.roundedCorners !== (existingStyle?.roundedCorners ?? true));

        if (needsRebuild && session.onRebuildWindowForStyle) {
          session.onRebuildWindowForStyle(nextStyle);
        } else {
          session.onOverlayChanged?.(nextStyle);
        }

        const currentOpts = (await this.handleWindow(
          session,
          frame,
          "getOptions",
          null,
        )) as DesktopPageAppWindowGetOptionsResult;
        const result: DesktopPageAppWindowSetOptionsResult = {
          applied: needsRebuild && !session.onRebuildWindowForStyle ? "next_open" : "now",
          reloading: Boolean(needsRebuild && session.onRebuildWindowForStyle),
          options: currentOpts.applied,
        };
        return result;
      }
      case "place": {
        if (win.isMinimized?.() || win.isFullScreen?.() || session.hasActiveDialog) {
          throw new PageAppNodeApiError(
            "unavailable",
            "当前窗口处于最小化、全屏或模态对话框状态，无法重定位。",
          );
        }
        const position = (
          typeof rawArgs === "string"
            ? rawArgs
            : typeof opts.anchor === "string"
              ? opts.anchor
              : typeof opts.pin === "string"
                ? opts.pin
                : typeof opts.position === "string"
                  ? opts.position
                  : "center"
        ).replace(/_/gu, "-");
        const margin =
          typeof opts.margin === "number" && Number.isFinite(opts.margin) && opts.margin >= 0
            ? Math.round(opts.margin)
            : 16;
        const current = win.getBounds();
        const targetW = typeof opts.width === "number" ? opts.width : current.width;
        const targetH = typeof opts.height === "number" ? opts.height : current.height;
        const displays = screen.getAllDisplays();
        const cursorPoint = position === "cursor" ? screen.getCursorScreenPoint() : null;
        const display =
          (typeof opts.displayId === "number"
            ? displays.find((d) => d.id === opts.displayId)
            : undefined) ??
          (cursorPoint
            ? screen.getDisplayNearestPoint(cursorPoint)
            : screen.getDisplayMatching(current));
        const area = display?.workArea ?? { x: 0, y: 0, width: 1280, height: 800 };

        let x =
          typeof opts.x === "number"
            ? opts.x
            : cursorPoint
              ? Math.round(cursorPoint.x - targetW / 2)
              : area.x + Math.round((area.width - targetW) / 2);
        let y =
          typeof opts.y === "number"
            ? opts.y
            : cursorPoint
              ? Math.round(cursorPoint.y - targetH / 2)
              : area.y + Math.round((area.height - targetH) / 2);

        if (position === "top-left") {
          x = area.x + margin;
          y = area.y + margin;
        } else if (position === "top-right") {
          x = area.x + area.width - targetW - margin;
          y = area.y + margin;
        } else if (position === "bottom-left") {
          x = area.x + margin;
          y = area.y + area.height - targetH - margin;
        } else if (position === "bottom-right") {
          x = area.x + area.width - targetW - margin;
          y = area.y + area.height - targetH - margin;
        } else if (position === "left") {
          x = area.x + margin;
        } else if (position === "right") {
          x = area.x + area.width - targetW - margin;
        } else if (position === "top") {
          y = area.y + margin;
        } else if (position === "bottom") {
          y = area.y + area.height - targetH - margin;
        }

        const clamped = clampBoundsToWorkArea({ x, y, width: targetW, height: targetH }, 200, 120, [
          area,
        ]);
        win.setBounds(clamped);
        return clamped;
      }
      case "show":
        win.show();
        return true;
      case "hide":
        win.hide();
        return true;
      case "focus":
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return true;
      case "close":
        win.close();
        return true;
      case "getBounds":
        return win.getBounds();
      case "setBounds": {
        if (win.isMinimized?.() || win.isFullScreen?.()) {
          throw new PageAppNodeApiError("EBUSY", "窗口处于最小化或全屏动画状态，暂不可修改边界。");
        }
        const current = win.getBounds();
        const clamped = clampBoundsToWorkArea(
          {
            x: typeof opts.x === "number" ? opts.x : current.x,
            y: typeof opts.y === "number" ? opts.y : current.y,
            width: typeof opts.width === "number" ? opts.width : current.width,
            height: typeof opts.height === "number" ? opts.height : current.height,
          },
          200,
          120,
          screen.getAllDisplays().map((d) => d.workArea),
        );
        win.setBounds(clamped);
        return clamped;
      }
      case "setDraggableRegions": {
        const regionsInput = Array.isArray(rawArgs) ? rawArgs : opts.regions;
        session.draggableRegions = normalizeDraggableRegions(regionsInput);
        if (session.dragRegionsTtlTimer) {
          clearTimeout(session.dragRegionsTtlTimer);
          session.dragRegionsTtlTimer = null;
        }
        const topFrame = win.webContents?.mainFrame;
        if (topFrame && !topFrame.isDestroyed?.()) {
          try {
            topFrame.send(PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL, {
              regions: session.draggableRegions,
            });
          } catch {
            // Top shell frame gone.
          }
        }
        if (session.draggableRegions.length > 0) {
          session.dragRegionsTtlTimer = setTimeout(() => {
            session.dragRegionsTtlTimer = null;
            session.draggableRegions = [];
            if (!win.isDestroyed?.()) {
              const tf = win.webContents?.mainFrame;
              if (tf && !tf.isDestroyed?.()) {
                try {
                  tf.send(PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL, { regions: [] });
                } catch {
                  // Ignore.
                }
              }
            }
          }, DRAG_REGIONS_TTL_MS);
        }
        return session.draggableRegions.length;
      }
      case "setIgnoreMouseEvents": {
        await this.ensurePermission(session, "overlay", true);
        if (process.platform === "win32" && !session.isInstalled) {
          throw new PageAppNodeApiError(
            "ENOTSUP",
            "Windows 平台需先安装为独立应用后方可使用鼠标穿透。",
          );
        }
        const ignore = Boolean(opts.ignore);
        win.setIgnoreMouseEvents(ignore, opts.forward === true ? { forward: true } : undefined);
        const existingStyle = this.store.getWindowStyle(styleKey);
        this.store.setWindowStyle(styleKey, {
          ...existingStyle,
          ignoreMouseEvents: ignore,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
      case "setVisibleOnAllWorkspaces": {
        await this.ensurePermission(session, "overlay", true);
        const visible = Boolean(opts.visible);
        win.setVisibleOnAllWorkspaces(visible, {
          visibleOnFullScreen: opts.visibleOnFullScreen !== false,
        });
        const existingStyle = this.store.getWindowStyle(styleKey);
        this.store.setWindowStyle(styleKey, {
          ...existingStyle,
          visibleOnAllWorkspaces: visible,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }
      case "print": {
        const wc = session.contentWebContents as WebContents & {
          print?: (
            options: Electron.WebContentsPrintOptions,
            callback?: (success: boolean, failureReason: string) => void,
          ) => void;
        };
        if (typeof wc.print === "function") {
          return await new Promise<boolean>((resolve) => {
            wc.print!(
              {
                silent: opts.silent === true,
                printBackground: opts.printBackground !== false,
                ...(typeof opts.deviceName === "string" ? { deviceName: opts.deviceName } : {}),
              },
              (success) => resolve(Boolean(success)),
            );
          });
        }
        if (frame && !frame.isDestroyed()) {
          await frame.executeJavaScript("window.print()").catch(() => undefined);
          return true;
        }
        return false;
      }
      default:
        throw new PageAppNodeApiError("invalid_argument", `未知 window 方法: ${method}`);
    }
  }

  private async handleMenu(
    session: NodeApiWindowSession,
    frame: WebFrameMain | null,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    const win = session.browserWindow;
    if (win.isDestroyed()) return null;
    const opts = asObj(rawArgs);

    if (method === "setApplicationMenu") {
      if (opts.template === null) {
        if (process.platform === "darwin") Menu.setApplicationMenu(null);
        else win.setMenu(null);
        return true;
      }
      const template = sanitizePageAppMenuTemplate(opts.template, (id) =>
        sendSessionEvent(frame, session, {
          appId: session.appId,
          namespace: "menu",
          event: "click",
          targetId: id,
          payload: { id },
        }),
      );
      const menu = Menu.buildFromTemplate(template);
      if (process.platform === "darwin") {
        Menu.setApplicationMenu(menu);
      } else {
        win.setMenu(menu);
      }
      return true;
    }

    if (method === "popup") {
      if (session.hasActiveDialog) {
        throw new PageAppNodeApiError("unavailable", "模态对话框打开期间无法弹出上下文菜单。");
      }
      if (typeof win.isFocused === "function" && !win.isFocused()) {
        throw new PageAppNodeApiError("unavailable", "仅当应用窗口处于聚焦状态时才可弹出菜单。");
      }
      let selectedId: string | null = null;
      const template = sanitizePageAppMenuTemplate(opts.template, (id) => {
        selectedId = id;
      });
      const menu = Menu.buildFromTemplate(template);
      const bounds = win.getBounds();
      const clampedX =
        typeof opts.x === "number" && Number.isFinite(opts.x)
          ? Math.max(0, Math.min(bounds.width, Math.round(opts.x)))
          : undefined;
      const clampedY =
        typeof opts.y === "number" && Number.isFinite(opts.y)
          ? Math.max(0, Math.min(bounds.height, Math.round(opts.y)))
          : undefined;
      await new Promise<void>((resolve) => {
        menu.popup({
          window: win,
          ...(clampedX !== undefined ? { x: clampedX } : {}),
          ...(clampedY !== undefined ? { y: clampedY } : {}),
          callback: () => resolve(),
        });
      });
      return selectedId;
    }

    throw new PageAppNodeApiError("invalid_argument", `未知 Menu 方法: ${method}`);
  }

  private handleDock(method: string, rawArgs: unknown): unknown {
    if (method === "setProgress" || method === "setMenu") {
      return false;
    }
    if (process.platform !== "darwin" || !app.dock) {
      return false;
    }
    const opts = asObj(rawArgs);
    if (method === "setBadge") {
      const text = typeof opts.text === "string" ? opts.text.slice(0, 24) : "";
      app.dock.setBadge(text);
      return true;
    }
    if (method === "setIcon") {
      const dataUrl = typeof opts.icon === "string" ? opts.icon : "";
      if (!dataUrl) return false;
      const { buffer } = validateTrayPngDataUrl(dataUrl);
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) return false;
      app.dock.setIcon(image);
      return true;
    }
    throw new PageAppNodeApiError("invalid_argument", `未知 app.dock 方法: ${method}`);
  }

  private async handleTray(
    session: NodeApiWindowSession,
    frame: WebFrameMain | null,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    if (method === "remove") {
      teardownTrayForSession(session);
      return true;
    }
    if (method !== "set") {
      throw new PageAppNodeApiError("invalid_argument", `未知 tray 方法: ${method}`);
    }

    await this.ensurePermission(session, "menu-bar", true);
    const opts = asObj(rawArgs);
    const iconDataUrl = typeof opts.icon === "string" ? opts.icon : "";
    const rawTitle = typeof opts.title === "string" ? opts.title.trim().slice(0, 64) : "";
    const rawTooltip = typeof opts.toolTip === "string" ? opts.toolTip.trim().slice(0, 128) : "";

    let icon: Electron.NativeImage;
    if (iconDataUrl) {
      const { buffer } = validateTrayPngDataUrl(iconDataUrl);
      icon = nativeImage.createFromBuffer(buffer);
      if (opts.iconIsTemplate === true) {
        icon.setTemplateImage?.(true);
      }
    } else if (session.iconPath && typeof nativeImage.createFromPath === "function") {
      const fallback = nativeImage.createFromPath(session.iconPath);
      icon = fallback.isEmpty() ? nativeImage.createEmpty() : fallback;
    } else if (rawTitle && process.platform === "darwin") {
      icon = nativeImage.createEmpty();
    } else {
      throw new PageAppNodeApiError(
        "invalid_argument",
        "托盘设置需提供有效 PNG 图标或 macOS 标题。",
      );
    }

    if (!session.tray || session.tray.isDestroyed()) {
      session.tray = new Tray(icon);
      session.tray.on("click", () => {
        sendSessionEvent(session.activeFrame ?? frame, session, {
          appId: session.appId,
          namespace: "tray",
          event: "click",
          payload: {},
        });
      });
    } else {
      session.tray.setImage(icon);
    }

    holdBackgroundPower(session);
    if (process.platform === "darwin" && rawTitle) {
      session.tray.setTitle(rawTitle);
    }
    const tooltipLines = [
      process.platform === "win32" && rawTitle
        ? `${session.appName} — ${rawTitle}`
        : session.appName,
      ...(rawTooltip && rawTooltip !== session.appName ? [rawTooltip] : []),
    ];
    session.tray.setToolTip(tooltipLines.join("\n"));

    let customItems: MenuItemConstructorOptions[] = [];
    if (Array.isArray(opts.menu)) {
      const sanitized = sanitizePageAppMenuTemplate(opts.menu, (id) =>
        sendSessionEvent(session.activeFrame ?? frame, session, {
          appId: session.appId,
          namespace: "tray",
          event: "menu-click",
          targetId: id,
          payload: { id },
        }),
      );
      if (sanitized.length > PAGE_APP_TRAY_FOLD_THRESHOLD) {
        customItems = [
          ...sanitized.slice(0, PAGE_APP_TRAY_FOLD_THRESHOLD),
          {
            label: session.appName || "更多",
            submenu: sanitized.slice(PAGE_APP_TRAY_FOLD_THRESHOLD),
          },
        ];
      } else {
        customItems = sanitized;
      }
    }

    const hostFooter: MenuItemConstructorOptions[] = [
      ...(customItems.length > 0 ? [{ type: "separator" as const }] : []),
      {
        label: "显示应用",
        click: () => {
          if (session.onShowAppWindow) session.onShowAppWindow();
          else if (!session.browserWindow.isDestroyed()) {
            session.browserWindow.show();
            session.browserWindow.focus();
          }
        },
      },
      {
        label: "权限…",
        click: () => {
          void session.onOpenPermissionsWindow?.();
        },
      },
      {
        label: "退出",
        click: () => {
          if (session.onRequestExitApp) session.onRequestExitApp();
          else if (!session.browserWindow.isDestroyed()) session.browserWindow.destroy();
        },
      },
    ];
    session.tray.setContextMenu(Menu.buildFromTemplate([...customItems, ...hostFooter]));
    return true;
  }

  private async handleNotification(
    session: NodeApiWindowSession,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    if (method !== "show") {
      throw new PageAppNodeApiError("invalid_argument", `未知 notification 方法: ${method}`);
    }
    await this.ensurePermission(session, "notifications", true);
    const input = asObj(rawArgs);
    const body = sanitizeNotificationBody(input.body);
    if (!Notification.isSupported()) {
      return false;
    }

    // Merge/replace active toast for the same app so spam collapses into one notification.
    if (session.activeNotification) {
      try {
        session.activeNotification.close();
      } catch {
        // Ignore already dismissed notification.
      }
      session.activeNotification = null;
    }

    const toast = new Notification({
      title: session.appName,
      body,
      ...(session.iconPath ? { icon: session.iconPath } : {}),
    });
    session.activeNotification = toast;
    toast.on("close", () => {
      if (session.activeNotification === toast) {
        session.activeNotification = null;
      }
    });
    toast.on("click", () => {
      if (!session.browserWindow.isDestroyed()) {
        if (session.browserWindow.isMinimized()) session.browserWindow.restore();
        session.browserWindow.show();
        session.browserWindow.focus();
      }
    });
    toast.show();
    return true;
  }

  private async handleGlobalShortcut(
    session: NodeApiWindowSession,
    frame: WebFrameMain | null,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    const opts = asObj(rawArgs);
    if (method === "isRegistered") {
      const acc = typeof opts.accelerator === "string" ? opts.accelerator.trim() : "";
      return session.registeredShortcuts.has(acc) && globalShortcut.isRegistered(acc);
    }
    if (method === "unregisterAll") {
      teardownShortcutsForSession(session);
      return true;
    }
    if (method === "unregister") {
      const acc = typeof opts.accelerator === "string" ? opts.accelerator.trim() : "";
      if (session.registeredShortcuts.has(acc)) {
        globalShortcut.unregister(acc);
        session.registeredShortcuts.delete(acc);
        if (GLOBAL_SHORTCUT_OWNERS.get(acc) === session.appId) {
          GLOBAL_SHORTCUT_OWNERS.delete(acc);
        }
      }
      releaseBackgroundPowerIfIdle(session);
      return true;
    }
    if (method !== "register") {
      throw new PageAppNodeApiError("invalid_argument", `未知 globalShortcut 方法: ${method}`);
    }

    await this.ensurePermission(session, "shortcuts", true);
    const accelerator = typeof opts.accelerator === "string" ? opts.accelerator.trim() : "";
    const validation = validateGlobalShortcutAccelerator(accelerator);
    if (!validation.ok) {
      throw new PageAppNodeApiError("invalid_argument", validation.reason ?? "无效的全局快捷键。");
    }

    const currentOwner = GLOBAL_SHORTCUT_OWNERS.get(accelerator);
    if (currentOwner && currentOwner !== session.appId) {
      throw new PageAppNodeApiError(
        "resource_exhausted",
        `快捷键 ${accelerator} 已被其他桌面应用占用。`,
      );
    }

    const ok = globalShortcut.register(accelerator, () => {
      try {
        if (powerMonitor.getSystemIdleState(1) === "locked") return;
      } catch {
        // Best-effort lock-state check.
      }
      sendSessionEvent(session.activeFrame ?? frame, session, {
        appId: session.appId,
        namespace: "globalShortcut",
        event: "triggered",
        targetId: accelerator,
        payload: { accelerator },
      });
    });
    if (ok) {
      session.registeredShortcuts.add(accelerator);
      GLOBAL_SHORTCUT_OWNERS.set(accelerator, session.appId);
      holdBackgroundPower(session);
    }
    return ok;
  }

  private async handleScreen(
    session: NodeApiWindowSession,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    await this.ensurePermission(session, "overlay", true);
    const opts = asObj(rawArgs);
    switch (method) {
      case "getPrimaryDisplay":
        return sanitizeDesktopScreenDisplay(
          screen.getPrimaryDisplay() as unknown as DesktopPageAppScreenDisplay,
        );
      case "getAllDisplays":
        return screen
          .getAllDisplays()
          .map((d) => sanitizeDesktopScreenDisplay(d as unknown as DesktopPageAppScreenDisplay));
      case "getCursorScreenPoint":
        return screen.getCursorScreenPoint();
      case "getDisplayNearestPoint":
        return sanitizeDesktopScreenDisplay(
          screen.getDisplayNearestPoint({
            x: Number(opts.x) || 0,
            y: Number(opts.y) || 0,
          }) as unknown as DesktopPageAppScreenDisplay,
        );
      case "getDisplayMatching":
        return sanitizeDesktopScreenDisplay(
          screen.getDisplayMatching({
            x: Number(opts.x) || 0,
            y: Number(opts.y) || 0,
            width: Math.max(1, Number(opts.width) || 1),
            height: Math.max(1, Number(opts.height) || 1),
          }) as unknown as DesktopPageAppScreenDisplay,
        );
      default:
        throw new PageAppNodeApiError("invalid_argument", `未知 screen 方法: ${method}`);
    }
  }

  private async handleOs(session: NodeApiWindowSession, method: string): Promise<unknown> {
    if (method === "platform") return process.platform;
    if (method === "arch") return process.arch;
    if (method !== "info") {
      throw new PageAppNodeApiError("invalid_argument", `未知 os 方法: ${method}`);
    }
    await this.ensurePermission(session, "full-access", true);
    return {
      platform: process.platform,
      arch: process.arch,
      release: OS.release(),
      hostname: OS.hostname(),
      homedir: OS.homedir(),
      tmpdir: OS.tmpdir(),
      cpus: OS.cpus().length,
      totalmem: OS.totalmem(),
      freemem: OS.freemem(),
      username: OS.userInfo().username,
      uptime: OS.uptime(),
    };
  }

  private async handleFs(
    session: NodeApiWindowSession,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    await this.ensurePermission(session, "full-access", true);
    const opts = asObj(rawArgs);

    switch (method) {
      case "readFile": {
        const target = resolveSafeFsPath(opts.path);
        const stat = await FS.stat(target);
        if (!stat.isFile()) {
          throw new PageAppNodeApiError("invalid_argument", "目标路径不是普通文件。");
        }
        if (stat.size > PAGE_APP_MAX_FS_READ_BYTES) {
          throw new PageAppNodeApiError("too_large", "单次读取文件不能超过 256 MB。");
        }
        const encoding = typeof opts.encoding === "string" ? opts.encoding : null;
        const buf = await FS.readFile(target);
        if (buf.length > PAGE_APP_MAX_FS_READ_BYTES) {
          throw new PageAppNodeApiError("too_large", "单次读取文件不能超过 256 MB。");
        }
        return encoding
          ? buf.toString(encoding as BufferEncoding)
          : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      case "writeFile":
      case "appendFile": {
        const target = resolveSafeFsPath(opts.path);
        let payload: string | Buffer;
        if (typeof opts.base64 === "string") {
          payload = Buffer.from(opts.base64, "base64");
        } else if (typeof opts.data === "string") {
          payload = opts.data;
        } else if (opts.data instanceof Uint8Array) {
          payload = Buffer.from(opts.data);
        } else if (opts.data instanceof ArrayBuffer) {
          payload = Buffer.from(opts.data);
        } else {
          payload = "";
        }
        if (method === "writeFile") await FS.writeFile(target, payload);
        else await FS.appendFile(target, payload);
        return true;
      }
      case "unlink":
        await FS.unlink(resolveSafeFsPath(opts.path));
        return true;
      case "mkdir":
        return FS.mkdir(resolveSafeFsPath(opts.path), { recursive: Boolean(opts.recursive) });
      case "rmdir":
        await FS.rmdir(resolveSafeFsPath(opts.path));
        return true;
      case "rm":
        await FS.rm(resolveSafeFsPath(opts.path), {
          recursive: Boolean(opts.recursive),
          force: Boolean(opts.force),
        });
        return true;
      case "readdir": {
        const target = resolveSafeFsPath(opts.path);
        if (opts.withFileTypes) {
          const entries = await FS.readdir(target, { withFileTypes: true });
          return entries.map((e) => ({
            name: e.name,
            isFile: e.isFile(),
            isDirectory: e.isDirectory(),
            isSymbolicLink: e.isSymbolicLink(),
          }));
        }
        return FS.readdir(target);
      }
      case "stat":
      case "lstat": {
        const target = resolveSafeFsPath(opts.path);
        const st = method === "lstat" ? await FS.lstat(target) : await FS.stat(target);
        return {
          size: st.size,
          mode: st.mode,
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          isSymbolicLink: st.isSymbolicLink(),
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          birthtimeMs: st.birthtimeMs,
        };
      }
      case "rename": {
        await FS.rename(resolveSafeFsPath(opts.oldPath), resolveSafeFsPath(opts.newPath));
        return true;
      }
      case "copyFile": {
        await FS.copyFile(
          resolveSafeFsPath(opts.src),
          resolveSafeFsPath(opts.dest),
          typeof opts.mode === "number" ? opts.mode : 0,
        );
        return true;
      }
      case "access":
        await FS.access(
          resolveSafeFsPath(opts.path),
          typeof opts.mode === "number" ? opts.mode : undefined,
        );
        return true;
      case "exists":
        try {
          await FS.access(resolveSafeFsPath(opts.path));
          return true;
        } catch {
          return false;
        }
      case "realpath":
        return FS.realpath(resolveSafeFsPath(opts.path));
      default:
        throw new PageAppNodeApiError("invalid_argument", `未知 fs 方法: ${method}`);
    }
  }

  private async handleShell(
    session: NodeApiWindowSession,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    await this.ensurePermission(session, "full-access", true);
    const opts = asObj(rawArgs);

    if (method === "openExternal") {
      const now = Date.now();
      if (now - (session.lastShellExternalAt ?? 0) < 1_000) {
        throw new PageAppNodeApiError(
          "resource_exhausted",
          "shell.openExternal 调用过于频繁，每秒最多 1 次。",
        );
      }
      const rawUrl = typeof opts.url === "string" ? opts.url.trim() : "";
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new PageAppNodeApiError("invalid_argument", "无效的外部链接。");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new PageAppNodeApiError("not_granted", "仅允许打开 http/https 外部链接。");
      }
      session.lastShellExternalAt = now;
      await shell.openExternal(parsed.toString());
      return true;
    }

    const resolved = resolveSafeFsPath(opts.path);

    if (method === "openPath") {
      const now = Date.now();
      if (now - session.lastShellOpenAt < 1_000) {
        throw new PageAppNodeApiError(
          "resource_exhausted",
          "shell.openPath 调用过于频繁，每秒最多 1 次。",
        );
      }
      session.lastShellOpenAt = now;

      let real: string;
      let stBefore: Awaited<ReturnType<typeof FS.lstat>>;
      try {
        real = await FS.realpath(resolved);
        stBefore = await FS.lstat(real);
      } catch {
        throw new PageAppNodeApiError("invalid_argument", "目标路径不存在或无法解析真实路径。");
      }
      const isFile = stBefore.isFile();
      if (
        stBefore.isSymbolicLink() ||
        isForbiddenShellOpenTarget(real, isFile) ||
        (!isFile && (await hasShadowingExecutableSibling(real)))
      ) {
        throw new PageAppNodeApiError(
          "not_granted",
          "出于安全限制，禁止通过 shell.openPath 打开可执行、符号链接、无后缀文件或存在同名可执行影子的目录。",
        );
      }

      // Re-stat immediately before launch to guard against TOCTOU swaps.
      const stCheck = await FS.lstat(real);
      if (
        stCheck.isSymbolicLink() ||
        stCheck.dev !== stBefore.dev ||
        stCheck.ino !== stBefore.ino
      ) {
        throw new PageAppNodeApiError("not_granted", "目标路径在打开前发生变更，已拦截。");
      }

      const err = await shell.openPath(real);
      if (err) throw new PageAppNodeApiError("upstream_error", err);
      return true;
    }
    if (method === "showItemInFolder") {
      shell.showItemInFolder(resolved);
      return true;
    }
    if (method === "trashItem") {
      await shell.trashItem(resolved);
      return true;
    }
    throw new PageAppNodeApiError("invalid_argument", `未知 shell 方法: ${method}`);
  }

  private activeProcessCount(session: NodeApiWindowSession): number {
    return session.childProcesses.size + session.ptyProcesses.size;
  }

  private async handleChildProcess(
    session: NodeApiWindowSession,
    frame: WebFrameMain | null,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    await this.ensurePermission(session, "full-access", true);
    const input = asObj(rawArgs);

    if (method === "exec") {
      if (this.activeProcessCount(session) >= PAGE_APP_MAX_CHILD_PROCESSES) {
        throw new PageAppNodeApiError(
          "process_limit",
          `并发进程数量已达上限 (${PAGE_APP_MAX_CHILD_PROCESSES})。`,
        );
      }
      const command = typeof input.command === "string" ? input.command : "";
      if (!command) throw new PageAppNodeApiError("invalid_argument", "命令不能为空。");
      const opts = asObj(input.options);
      const cwd = typeof opts.cwd === "string" ? opts.cwd : undefined;
      const env = sanitizeSpawnEnv(opts.env);
      const stdinInput = typeof opts.input === "string" ? opts.input : undefined;
      const timeout =
        typeof opts.timeout === "number" && Number.isFinite(opts.timeout) && opts.timeout > 0
          ? Math.min(opts.timeout, 120_000)
          : 30_000;

      const procId = `exec-${this.processIdCounter++}`;
      return new Promise((resolve) => {
        const child = ChildProcess.spawn(command, {
          cwd,
          env,
          shell: true,
          windowsHide: true,
        });
        session.childProcesses.set(procId, child);
        child.stdin?.on("error", () => undefined);
        if (stdinInput !== undefined && child.stdin?.writable) {
          child.stdin.write(stdinInput);
          child.stdin.end();
        }

        let stdout = "";
        let stderr = "";
        let totalBytes = 0;
        let truncated = false;
        let finished = false;

        const timer = setTimeout(() => {
          truncated = true;
          killProcessTree(child.pid, (sig) => child.kill(sig), "SIGKILL");
        }, timeout);

        const appendChunk = (target: "stdout" | "stderr", chunk: Buffer) => {
          if (truncated) return;
          if (totalBytes + chunk.length > PAGE_APP_MAX_EXEC_BUFFER_BYTES) {
            const remaining = Math.max(0, PAGE_APP_MAX_EXEC_BUFFER_BYTES - totalBytes);
            if (remaining > 0) {
              const part = chunk.subarray(0, remaining).toString("utf8");
              if (target === "stdout") stdout += part;
              else stderr += part;
            }
            totalBytes = PAGE_APP_MAX_EXEC_BUFFER_BYTES;
            truncated = true;
            killProcessTree(child.pid, (sig) => child.kill(sig), "SIGKILL");
            return;
          }
          totalBytes += chunk.length;
          const text = chunk.toString("utf8");
          if (target === "stdout") stdout += text;
          else stderr += text;
        };

        child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));

        const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          session.childProcesses.delete(procId);
          resolve({
            stdout,
            stderr,
            code,
            exitCode: typeof code === "number" ? code : 1,
            signal,
            truncated,
          });
        };

        child.on("close", (code, signal) => finalize(code, signal));
        child.on("error", (err) => {
          stderr = stderr || err.message;
          finalize(1, null);
        });
      });
    }

    if (method === "spawn") {
      if (this.activeProcessCount(session) >= PAGE_APP_MAX_CHILD_PROCESSES) {
        throw new PageAppNodeApiError(
          "process_limit",
          `并发进程数量已达上限 (${PAGE_APP_MAX_CHILD_PROCESSES})。`,
        );
      }
      const command = typeof input.command === "string" ? input.command : "";
      if (!command) throw new PageAppNodeApiError("invalid_argument", "命令不能为空。");
      const spawnArgs = Array.isArray(input.args) ? input.args.map(String) : [];
      const opts = asObj(input.options);
      const id =
        typeof input.clientId === "string" && input.clientId
          ? input.clientId
          : `proc-${this.processIdCounter++}`;
      const child = ChildProcess.spawn(command, spawnArgs, {
        cwd: typeof opts.cwd === "string" ? opts.cwd : undefined,
        env: sanitizeSpawnEnv(opts.env),
        shell: Boolean(opts.shell),
        windowsHide: true,
      });
      session.childProcesses.set(id, child);
      child.stdin?.on("error", () => undefined);
      if (typeof opts.input === "string" && child.stdin?.writable) {
        child.stdin.write(opts.input);
        child.stdin.end();
      }

      let stdoutBuf = "";
      let stderrBuf = "";
      let batchTimer: ReturnType<typeof setTimeout> | null = null;
      const flushOutput = () => {
        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        if (stdoutBuf) {
          const data = stdoutBuf;
          stdoutBuf = "";
          sendSessionEvent(frame, session, {
            appId: session.appId,
            namespace: "childProcess",
            event: "stdout",
            targetId: id,
            payload: { id, streamId: id, data },
          });
        }
        if (stderrBuf) {
          const data = stderrBuf;
          stderrBuf = "";
          sendSessionEvent(frame, session, {
            appId: session.appId,
            namespace: "childProcess",
            event: "stderr",
            targetId: id,
            payload: { id, streamId: id, data },
          });
        }
      };
      const scheduleFlush = () => {
        if (!batchTimer) {
          batchTimer = setTimeout(flushOutput, PROCESS_STREAM_BATCH_MS);
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        scheduleFlush();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
        scheduleFlush();
      });
      child.on("close", (code, signal) => {
        flushOutput();
        session.childProcesses.delete(id);
        sendSessionEvent(frame, session, {
          appId: session.appId,
          namespace: "childProcess",
          event: "exit",
          targetId: id,
          payload: { id, streamId: id, code, signal },
        });
      });
      child.on("error", (err) => {
        flushOutput();
        session.childProcesses.delete(id);
        sendSessionEvent(frame, session, {
          appId: session.appId,
          namespace: "childProcess",
          event: "error",
          targetId: id,
          payload: { id, streamId: id, message: err.message },
        });
      });
      return { id, pid: child.pid ?? null, streamId: id };
    }

    if (method === "write") {
      const id = typeof input.id === "string" ? input.id : "";
      const data = typeof input.data === "string" ? input.data : "";
      const child = session.childProcesses.get(id);
      if (!child || !child.stdin?.writable) return false;
      child.stdin.write(data);
      return true;
    }

    if (method === "endStdin" || method === "end") {
      const id = typeof input.id === "string" ? input.id : "";
      const child = session.childProcesses.get(id);
      if (!child || !child.stdin) return false;
      child.stdin.end();
      return true;
    }

    if (method === "kill") {
      const id = typeof input.id === "string" ? input.id : "";
      const rawSig = typeof input.signal === "string" ? input.signal : "SIGTERM";
      if (!ALLOWED_SIGNALS.has(rawSig as NodeJS.Signals)) {
        throw new PageAppNodeApiError("invalid_argument", `不支持的进程信号: ${rawSig}`);
      }
      const sig = rawSig as NodeJS.Signals;
      const child = session.childProcesses.get(id);
      if (!child) return false;
      killProcessTree(child.pid, (s) => child.kill(s), sig);
      if (sig === "SIGKILL") session.childProcesses.delete(id);
      return true;
    }

    throw new PageAppNodeApiError("invalid_argument", `未知 childProcess 方法: ${method}`);
  }

  private async handlePty(
    session: NodeApiWindowSession,
    frame: WebFrameMain | null,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    await this.ensurePermission(session, "full-access", true);
    const input = asObj(rawArgs);

    if (method === "spawn") {
      if (this.activeProcessCount(session) >= PAGE_APP_MAX_CHILD_PROCESSES) {
        throw new PageAppNodeApiError(
          "process_limit",
          `并发终端/进程数量已达上限 (${PAGE_APP_MAX_CHILD_PROCESSES})。`,
        );
      }
      const defaultShell =
        process.platform === "win32"
          ? process.env.COMSPEC || "cmd.exe"
          : process.env.SHELL || "/bin/sh";
      const command =
        typeof input.file === "string" && input.file
          ? input.file
          : typeof input.command === "string" && input.command
            ? input.command
            : defaultShell;
      const spawnArgs = Array.isArray(input.args) ? input.args.map(String) : [];
      const opts = asObj(input.options);
      const cols =
        typeof opts.cols === "number" ? Math.max(2, Math.min(500, Math.round(opts.cols))) : 80;
      const rows =
        typeof opts.rows === "number" ? Math.max(1, Math.min(300, Math.round(opts.rows))) : 24;
      const cwd = typeof opts.cwd === "string" ? opts.cwd : OS.homedir();
      const env = {
        ...(sanitizeSpawnEnv(opts.env) ?? process.env),
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
      } as Record<string, string>;
      const id =
        typeof input.clientId === "string" && input.clientId
          ? input.clientId
          : `pty-${this.processIdCounter++}`;

      const nodePty = loadNodePtyModule();
      if (nodePty) {
        const term = nodePty.spawn(command, spawnArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env,
        });
        const pid = typeof term.pid === "number" ? term.pid : null;
        session.ptyProcesses.set(id, {
          pid,
          write: (data: string) => term.write(data),
          resize: (c: number, r: number) =>
            term.resize(Math.max(2, Math.min(500, c)), Math.max(1, Math.min(300, r))),
          kill: (sig?: string) => {
            if (process.platform === "win32" && typeof pid === "number" && !isProcessAlive(pid)) {
              return;
            }
            try {
              term.kill(sig);
            } catch {
              // Avoid Windows ConPTY AttachConsole failure race on dead shell.
            }
          },
        });
        term.onData((data) => {
          sendSessionEvent(frame, session, {
            appId: session.appId,
            namespace: "pty",
            event: "data",
            targetId: id,
            payload: { id, streamId: id, data },
          });
        });
        term.onExit(({ exitCode, signal }) => {
          session.ptyProcesses.delete(id);
          sendSessionEvent(frame, session, {
            appId: session.appId,
            namespace: "pty",
            event: "exit",
            targetId: id,
            payload: { id, streamId: id, exitCode, signal: signal ?? null },
          });
        });
        return { id, pid, cols, rows, streamId: id };
      }

      const child = ChildProcess.spawn(command, spawnArgs, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.on("error", () => undefined);
      session.ptyProcesses.set(id, {
        pid: child.pid ?? null,
        write: (data: string) => {
          if (!child.killed && child.stdin?.writable) child.stdin.write(data);
        },
        resize: () => {
          // Fallback pipe PTY tracks resize bounds without native TIOCSWINSZ.
        },
        kill: (sig?: string) => {
          const safeSig = ALLOWED_SIGNALS.has(sig as NodeJS.Signals)
            ? (sig as NodeJS.Signals)
            : "SIGTERM";
          killProcessTree(child.pid, (s) => child.kill(s), safeSig);
        },
      });
      const emitOutput = (chunk: Buffer) => {
        sendSessionEvent(frame, session, {
          appId: session.appId,
          namespace: "pty",
          event: "data",
          targetId: id,
          payload: { id, streamId: id, data: chunk.toString("utf8") },
        });
      };
      child.stdout?.on("data", emitOutput);
      child.stderr?.on("data", emitOutput);
      child.on("close", (exitCode, signal) => {
        session.ptyProcesses.delete(id);
        sendSessionEvent(frame, session, {
          appId: session.appId,
          namespace: "pty",
          event: "exit",
          targetId: id,
          payload: { id, streamId: id, exitCode: exitCode ?? 0, signal: signal ?? null },
        });
      });
      return { id, pid: child.pid ?? null, cols, rows, streamId: id };
    }

    if (method === "write") {
      const id = typeof input.id === "string" ? input.id : "";
      const data = typeof input.data === "string" ? input.data : "";
      const proc = session.ptyProcesses.get(id);
      if (!proc) return false;
      proc.write(data);
      return true;
    }

    if (method === "resize") {
      const id = typeof input.id === "string" ? input.id : "";
      const cols =
        typeof input.cols === "number" ? Math.max(2, Math.min(500, Math.round(input.cols))) : 80;
      const rows =
        typeof input.rows === "number" ? Math.max(1, Math.min(300, Math.round(input.rows))) : 24;
      const proc = session.ptyProcesses.get(id);
      if (!proc) return false;
      proc.resize(cols, rows);
      return true;
    }

    if (method === "kill") {
      const id = typeof input.id === "string" ? input.id : "";
      const sig = typeof input.signal === "string" ? input.signal : "SIGTERM";
      if (!ALLOWED_SIGNALS.has(sig as NodeJS.Signals)) {
        throw new PageAppNodeApiError("invalid_argument", `不支持的进程信号: ${sig}`);
      }
      const proc = session.ptyProcesses.get(id);
      if (!proc) return false;
      proc.kill(sig);
      if (sig === "SIGKILL") session.ptyProcesses.delete(id);
      return true;
    }

    throw new PageAppNodeApiError("invalid_argument", `未知 pty 方法: ${method}`);
  }

  private async handleInstall(session: NodeApiWindowSession, method: string): Promise<unknown> {
    if (method === "state" || method === "status") {
      const existing = this.store.findInstalledByAppId(session.appId);
      const policy = this.permissions.getPolicyState();
      const state: DesktopPageAppInstallState = {
        installed: existing !== null,
        available: policy.enabled,
        installId: existing?.installId ?? null,
        name: existing?.name ?? session.appName,
        places: existing ? [...existing.places] : [],
        app: existing ?? null,
        policy,
      };
      return state;
    }
    if (method === "request") {
      if (!session.takeGesture || !session.takeGesture()) {
        throw new PageAppNodeApiError("not_granted", "安装请求必须由 5 秒内的用户点击手势触发。");
      }
      if (!session.onTriggerInstall) {
        throw new PageAppNodeApiError("unavailable", "当前视图不支持发起桌面安装。");
      }
      return session.onTriggerInstall();
    }
    throw new PageAppNodeApiError("invalid_argument", `未知 install 方法: ${method}`);
  }

  private async handlePermissions(
    session: NodeApiWindowSession,
    method: string,
    rawArgs: unknown,
  ): Promise<unknown> {
    const opts = asObj(rawArgs);
    const evalAll = () =>
      this.permissions.evaluateAll({
        accountId: session.accountId,
        orgId: session.orgId,
        appId: session.appId,
        declaredPermissions: session.declaredPermissions,
        currentRevision: session.revision,
        currentContentHash: session.contentHash,
        hasMixedVersions: session.hasMixedVersions,
        trustKind: session.trustKind,
      });

    if (method === "declare") {
      return this.declarePermissionsForSession(session, opts.permissions ?? rawArgs);
    }

    if (method === "state") {
      const single =
        typeof rawArgs === "string"
          ? rawArgs
          : typeof opts.name === "string"
            ? opts.name
            : undefined;
      const states = evalAll();
      if (single !== undefined) {
        if (!isDesktopPageAppPermission(single)) return "unavailable";
        return states[single].state;
      }
      const out: Record<string, string> = {};
      for (const perm of PAGE_APP_DESKTOP_PERMISSIONS) {
        out[perm] = states[perm].state;
      }
      return out;
    }

    if (method === "request") {
      const rawNames = Array.isArray(rawArgs) ? rawArgs : opts.names;
      const filtered = Array.isArray(rawNames)
        ? rawNames.filter(isDesktopPageAppPermission)
        : [...session.declaredPermissions];
      // Prompt `"full-access"` first so cascading Tier 2 permissions avoid duplicate prompts.
      const ordered = [...filtered].toSorted((a, b) =>
        a === b ? 0 : a === "full-access" ? -1 : b === "full-access" ? 1 : 0,
      );

      for (const perm of ordered) {
        const entry = evalAll()[perm];
        if (!entry || entry.state !== "prompt") continue;
        session.hasActiveDialog = true;
        let allowed = false;
        try {
          allowed = await this.dialogs.confirmPermission(
            {
              appName: session.appName,
              permission: perm,
              isReapproval: entry.isReapproval,
              trustKind: session.trustKind,
            },
            session.browserWindow,
          );
        } finally {
          session.hasActiveDialog = false;
        }
        this.permissions.setPermission({
          accountId: session.accountId,
          orgId: session.orgId,
          appId: session.appId,
          permission: perm,
          answer: allowed ? "granted" : "denied",
          revision: session.revision,
          contentHash: session.contentHash,
          declaredPermissions: session.declaredPermissions,
        });
      }
      const updated = evalAll();
      const out: Record<string, string> = {};
      for (const perm of PAGE_APP_DESKTOP_PERMISSIONS) {
        out[perm] = updated[perm].state;
      }
      return out;
    }

    if (method === "manage") {
      if (!session.takeGesture || !session.takeGesture()) {
        throw new PageAppNodeApiError(
          "not_granted",
          "打开权限设置必须由 5 秒内的用户点击手势触发。",
        );
      }
      if (session.onOpenPermissionsWindow) {
        await session.onOpenPermissionsWindow();
      } else {
        session.hasActiveDialog = true;
        try {
          await this.dialogs.showAbout(
            {
              appName: session.appName,
              appId: session.appId,
              revision: session.revision,
              referenceText: session.referenceText,
            },
            session.browserWindow,
          );
        } finally {
          session.hasActiveDialog = false;
        }
      }
      return true;
    }

    throw new PageAppNodeApiError("invalid_argument", `未知 permissions 方法: ${method}`);
  }
}
