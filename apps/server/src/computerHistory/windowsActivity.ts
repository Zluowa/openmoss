// FILE: windowsActivity.ts
// Purpose: Pure Windows Computer History rules: sample parsing, privacy exclusions, capture
//          cadence (same policy as the macOS helper) and the on-device activity summary.
// Layer: Computer History Windows adapter (no I/O)

import type { ComputerHistorySemanticSummary } from "@moss/contracts";

import { normalizeComputerHistorySemanticSummary } from "./store.ts";

/** One foreground-window probe from the Windows helper. Titles stay transient. */
export interface WindowsHistoryTarget {
  readonly hwnd: number;
  readonly processName: string;
  readonly displayName: string;
  readonly windowClass: string;
  readonly title: string;
  readonly cloaked: boolean;
  readonly minimized: boolean;
  /** GetWindowDisplayAffinity: non-zero means the app asked not to be captured. */
  readonly displayAffinity: number;
  /** True, false, or null when UI Automation did not answer in time. */
  readonly passwordFocused: boolean | null;
  readonly focusedControl: string | null;
}

export interface WindowsHistoryProbe {
  readonly capturedAtMs: number;
  readonly idleSeconds: number | null;
  readonly target: WindowsHistoryTarget | null;
  /** Other visible top-level windows, only used to pause during meetings. */
  readonly others: ReadonlyArray<{ readonly processName: string; readonly title: string }>;
}

const PROCESS_NAME_PATTERN = /^[^\\/:*?"<>|\u0000-\u001f]{1,120}$/u;

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function parseTarget(value: unknown): WindowsHistoryTarget | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const processName = boundedString(record.processName, 120);
  const displayName = boundedString(record.displayName ?? "", 256);
  const windowClass = boundedString(record.windowClass ?? "", 256);
  const title = boundedString(record.title ?? "", 1024);
  if (
    !Number.isSafeInteger(record.hwnd) ||
    !processName ||
    !PROCESS_NAME_PATTERN.test(processName) ||
    displayName === null ||
    windowClass === null ||
    title === null ||
    typeof record.cloaked !== "boolean" ||
    typeof record.minimized !== "boolean" ||
    !Number.isSafeInteger(record.displayAffinity) ||
    (record.passwordFocused !== null && typeof record.passwordFocused !== "boolean")
  ) {
    return undefined;
  }
  return {
    hwnd: record.hwnd as number,
    processName,
    displayName,
    windowClass,
    title,
    cloaked: record.cloaked,
    minimized: record.minimized,
    displayAffinity: record.displayAffinity as number,
    passwordFocused: record.passwordFocused as boolean | null,
    focusedControl: boundedString(record.focusedControl, 80),
  };
}

/** Parse the helper's `probe` reply; malformed replies are dropped (fail closed). */
export function parseWindowsHistoryProbe(value: unknown): WindowsHistoryProbe | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.capturedAtMs) || (record.capturedAtMs as number) <= 0) {
    return null;
  }
  const idle = record.idleSeconds;
  if (idle !== null && (typeof idle !== "number" || !Number.isFinite(idle) || idle < 0)) {
    return null;
  }
  const target = parseTarget(record.target);
  if (target === undefined) return null;
  const others = Array.isArray(record.others)
    ? record.others.slice(0, 64).flatMap((other) => {
        if (!other || typeof other !== "object") return [];
        const item = other as Record<string, unknown>;
        const processName = boundedString(item.processName, 120);
        const title = boundedString(item.title ?? "", 1024);
        return processName && title !== null ? [{ processName, title }] : [];
      })
    : [];
  return { capturedAtMs: record.capturedAtMs as number, idleSeconds: idle, target, others };
}

/**
 * Stable application id for Windows: the lower-case executable file name, reduced to the
 * characters the encrypted store accepts (`notepad.exe`, `sublime-text.exe`).
 */
export function windowsHistoryAppId(processName: string): string | null {
  const stem = executableStem(processName);
  if (!stem) return null;
  // Executables named in other scripts keep a stable, reversible ASCII id.
  const ascii = /^[ -~]+$/u.test(stem);
  const base = ascii
    ? stem
        .replace(/[^a-z0-9.-]+/gu, "-")
        .replace(/-{2,}/gu, "-")
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "")
    : `u-${Buffer.from(stem, "utf8").toString("hex")}`;
  const id = `${base.slice(0, 195)}.exe`;
  return base.length > 0 && /^[a-z0-9][a-z0-9.-]{0,199}$/u.test(id) ? id : null;
}

function executableStem(processName: string): string {
  return processName
    .trim()
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

/** Browsers stay excluded on Windows: no locale-independent private-window signal exists. */
export const WINDOWS_HISTORY_BROWSER_EXECUTABLES = [
  "chrome",
  "chromium",
  "msedge",
  "firefox",
  "brave",
  "opera",
  "opera_gx",
  "vivaldi",
  "iexplore",
  "arc",
  "zen",
  "waterfox",
  "librewolf",
  "browser",
  "yandex",
  "sogouexplorer",
  "360chrome",
  "360se",
  "qqbrowser",
  "2345explorer",
  "ucbrowser",
  "maxthon",
  "thorium",
  "floorp",
  "safari",
] as const;
const BROWSER_SET = new Set<string>(WINDOWS_HISTORY_BROWSER_EXECUTABLES);
// Desktop apps that legitimately use a Chromium or WebView window class.
const DESKTOP_CHROMIUM_APPS = new Set([
  "moss",
  "codex",
  "claude",
  "chatgpt",
  "code",
  "code - insiders",
  "cursor",
  "windsurf",
  "trae",
  "kiro",
  "slack",
  "discord",
  "notion",
  "obsidian",
  "figma",
  "feishu",
  "lark",
  "dingtalk",
  "spotify",
  "teams",
  "ms-teams",
  "wechat",
  "weixin",
  "qq",
  "cherry studio",
  "postman",
  "typora",
  "logseq",
]);
const SECURE_SURFACES = new Set([
  "lockapp",
  "logonui",
  "consent",
  "credentialuibroker",
  "credentialenrollmentmanager",
  "securityhealthhost",
  "keepass",
  "keepassxc",
  "1password",
  "bitwarden",
  "lastpass",
  "dashlane",
]);
const VIDEO_APPS = new Set([
  "zoom",
  "teams",
  "ms-teams",
  "msteams",
  "lync",
  "skype",
  "webex",
  "ciscowebex",
  "atmgr",
  "wemeetapp",
  "voovmeeting",
  "tencentmeeting",
  "feishumeeting",
  "larkmeeting",
  "dingtalkmeeting",
  "gotomeeting",
  "bluejeans",
]);
const VIDEO_TITLE_MARKERS = [
  "google meet",
  "meet.google.com",
  "meet -",
  "zoom.us",
  "zoom meeting",
  "microsoft teams",
  "teams.microsoft.com",
  "teams.cloud.microsoft",
  "teamsmeetingwindow",
  "腾讯会议",
  "tencent meeting",
  "voov meeting",
  "飞书会议",
  "lark meeting",
  "钉钉会议",
  "webex",
];

export type WindowsHistoryExclusion =
  | "no_foreground"
  | "secure_surface"
  | "moss_helper"
  | "hidden"
  | "excluded_from_capture"
  | "password_field"
  | "browser"
  | "video_conference";

function isVideoWindow(processName: string, title: string): boolean {
  if (VIDEO_APPS.has(executableStem(processName))) return true;
  const lowered = title.toLowerCase();
  return VIDEO_TITLE_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Privacy exclusions applied before any pixel is captured. A window the app marked as
 * excluded from capture, a focused password field, a browser, a lock/consent/password-manager
 * surface or any visible meeting window means: no frame for this sample.
 */
export function assessWindowsHistoryProbe(
  probe: WindowsHistoryProbe,
):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: WindowsHistoryExclusion } {
  const target = probe.target;
  if (!target) return { allowed: false, reason: "no_foreground" };
  const stem = executableStem(target.processName);
  if (SECURE_SURFACES.has(stem)) return { allowed: false, reason: "secure_surface" };
  // The computer-use driver is Moss's own machinery.
  if (stem.startsWith("cua-")) return { allowed: false, reason: "moss_helper" };
  if (target.cloaked || target.minimized) return { allowed: false, reason: "hidden" };
  if (target.displayAffinity !== 0) return { allowed: false, reason: "excluded_from_capture" };
  if (target.passwordFocused === true) return { allowed: false, reason: "password_field" };
  if (
    BROWSER_SET.has(stem) ||
    (/chrome_widgetwin|mozillawindowclass|internet explorer_server|ieframe/iu.test(
      target.windowClass,
    ) &&
      !DESKTOP_CHROMIUM_APPS.has(stem))
  ) {
    return { allowed: false, reason: "browser" };
  }
  if (
    isVideoWindow(target.processName, target.title) ||
    probe.others.some((other) => isVideoWindow(other.processName, other.title))
  ) {
    return { allowed: false, reason: "video_conference" };
  }
  return { allowed: true };
}

// --- Capture cadence: a direct port of the macOS HistoryVisualActivityPolicy ---

export const WINDOWS_HISTORY_FINGERPRINT_BYTES = 256;
export const WINDOWS_HISTORY_CADENCE = {
  materialDifferenceThreshold: 4,
  heartbeatMs: 60_000,
  recentInputDelayMs: 1_000,
  firstUnchangedDelayMs: 5_000,
  repeatedUnchangedDelayMs: 15_000,
  settledUnchangedDelayMs: 30_000,
  slowCaptureThresholdMs: 1_500,
  failureDelayMs: 60_000,
  idlePauseSeconds: 300,
} as const;

export type WindowsHistoryEvidence =
  | "first_frame"
  | "visual_change"
  | "heartbeat"
  | "minute_bucket";

/** Decode the helper's 16x16 grayscale fingerprint (512 hex characters). */
export function parseWindowsHistoryFingerprint(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[0-9a-f]{512}$/u.test(value)) return null;
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function windowsHistoryFingerprintDistance(left: Uint8Array, right: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < WINDOWS_HISTORY_FINGERPRINT_BYTES; index += 1) {
    total += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return total / WINDOWS_HISTORY_FINGERPRINT_BYTES;
}

export class WindowsHistoryCadence {
  private previous: Uint8Array | null = null;
  private lastEvidence: Uint8Array | null = null;
  private lastEvidenceAtMs: number | null = null;
  private lastMinuteBucket: number | null = null;
  private lastTargetKey: string | null = null;
  private unchangedStreak = 0;

  static idlePaused(idleSeconds: number | null): boolean {
    // An unknown idle time fails open, as on macOS.
    return idleSeconds !== null && idleSeconds >= WINDOWS_HISTORY_CADENCE.idlePauseSeconds;
  }

  static unchangedDelayMs(streak: number): number {
    if (streak <= 0) return WINDOWS_HISTORY_CADENCE.firstUnchangedDelayMs;
    if (streak <= 2) return WINDOWS_HISTORY_CADENCE.repeatedUnchangedDelayMs;
    return WINDOWS_HISTORY_CADENCE.settledUnchangedDelayMs;
  }

  recordCapture(input: {
    readonly fingerprint: Uint8Array;
    readonly targetKey: string;
    readonly monotonicMs: number;
    readonly wallClockMs: number;
    readonly durationMs: number;
    readonly recentUserInput: boolean;
  }): { readonly evidence: WindowsHistoryEvidence | null; readonly nextDelayMs: number } {
    const threshold = WINDOWS_HISTORY_CADENCE.materialDifferenceThreshold;
    const minuteBucket = Math.floor(input.wallClockMs / 60_000);
    const targetChanged = this.lastTargetKey !== null && this.lastTargetKey !== input.targetKey;
    let evidence: WindowsHistoryEvidence | null;
    if (this.previous) {
      const changed =
        targetChanged ||
        windowsHistoryFingerprintDistance(this.previous, input.fingerprint) >= threshold;
      this.unchangedStreak = changed ? 0 : this.unchangedStreak + 1;
      if (
        targetChanged ||
        (this.lastEvidence &&
          windowsHistoryFingerprintDistance(this.lastEvidence, input.fingerprint) >= threshold)
      ) {
        evidence = "visual_change";
      } else if (
        this.lastEvidenceAtMs !== null &&
        input.monotonicMs - this.lastEvidenceAtMs >= WINDOWS_HISTORY_CADENCE.heartbeatMs
      ) {
        evidence = "heartbeat";
      } else if (this.lastMinuteBucket !== null && this.lastMinuteBucket !== minuteBucket) {
        evidence = "minute_bucket";
      } else {
        evidence = null;
      }
    } else {
      evidence = "first_frame";
      this.unchangedStreak = 0;
    }
    this.previous = input.fingerprint;
    this.lastMinuteBucket = minuteBucket;
    this.lastTargetKey = input.targetKey;
    if (evidence === "visual_change") this.unchangedStreak = 0;
    if (evidence) {
      this.lastEvidenceAtMs = input.monotonicMs;
      this.lastEvidence = input.fingerprint;
    }
    let nextDelayMs: number;
    if (input.durationMs > WINDOWS_HISTORY_CADENCE.slowCaptureThresholdMs) {
      nextDelayMs = WINDOWS_HISTORY_CADENCE.settledUnchangedDelayMs;
    } else if (input.recentUserInput) {
      nextDelayMs = WINDOWS_HISTORY_CADENCE.recentInputDelayMs;
    } else {
      nextDelayMs = WindowsHistoryCadence.unchangedDelayMs(this.unchangedStreak);
    }
    return { evidence, nextDelayMs };
  }

  recordFailure(): number {
    return WINDOWS_HISTORY_CADENCE.failureDelayMs;
  }
}

// --- On-device activity summary from OCR text ---

export const WINDOWS_HISTORY_OCR_MAX_LENGTH = 1_200;

/** Same normalization the macOS helper applies to Vision OCR output. */
export function normalizeWindowsHistoryOcr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > 0 ? text.slice(0, WINDOWS_HISTORY_OCR_MAX_LENGTH) : null;
}

type ActivityCategory =
  | "coding"
  | "terminal"
  | "messaging"
  | "email"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "design"
  | "reading"
  | "files"
  | "assistant"
  | "media"
  | "settings";

const CATEGORY_BY_EXECUTABLE: Record<string, ActivityCategory> = {};
const register = (category: ActivityCategory, names: readonly string[]) => {
  for (const name of names) CATEGORY_BY_EXECUTABLE[name] = category;
};
register("coding", [
  "code",
  "code - insiders",
  "cursor",
  "windsurf",
  "trae",
  "kiro",
  "zed",
  "devenv",
  "idea64",
  "pycharm64",
  "webstorm64",
  "clion64",
  "goland64",
  "rider64",
  "rustrover64",
  "phpstorm64",
  "studio64",
  "sublime_text",
  "notepad++",
  "eclipse",
  "hbuilderx",
]);
register("terminal", [
  "windowsterminal",
  "wt",
  "cmd",
  "conhost",
  "powershell",
  "pwsh",
  "wezterm-gui",
  "alacritty",
  "mintty",
  "conemu64",
  "tabby",
  "warp",
  "putty",
  "mobaxterm",
  "xshell",
]);
register("messaging", [
  "wechat",
  "weixin",
  "qq",
  "telegram",
  "slack",
  "discord",
  "dingtalk",
  "feishu",
  "lark",
  "whatsapp",
  "signal",
  "wxwork",
  "line",
]);
register("email", ["outlook", "olk", "hxoutlook", "thunderbird", "foxmail", "mailmaster"]);
register("document", [
  "winword",
  "wps",
  "notepad",
  "wordpad",
  "obsidian",
  "notion",
  "typora",
  "onenote",
  "evernote",
  "yinxiang",
  "logseq",
  "joplin",
  "marktext",
]);
register("spreadsheet", ["excel", "et"]);
register("presentation", ["powerpnt", "wpp"]);
register("design", [
  "figma",
  "photoshop",
  "illustrator",
  "blender",
  "mspaint",
  "gimp-2.10",
  "inkscape",
  "krita",
  "sketchup",
  "pixso",
  "mastergo",
]);
register("reading", [
  "acrord32",
  "acrobat",
  "sumatrapdf",
  "foxitpdfreader",
  "foxitphantom",
  "kindle",
]);
register("files", ["explorer", "totalcmd64", "everything", "dopus"]);
register("assistant", ["moss", "codex", "claude", "chatgpt", "cherry studio"]);
register("media", [
  "vlc",
  "potplayermini64",
  "spotify",
  "cloudmusic",
  "qqmusic",
  "kugou",
  "mpc-hc64",
  "wmplayer",
]);
register("settings", ["systemsettings", "control", "mmc", "taskmgr", "regedit"]);

const CATEGORY_TEXT: Record<ActivityCategory, { title: string; description: string }> = {
  coding: { title: "Writing code", description: "Worked on source code in {app}." },
  terminal: { title: "Using a terminal", description: "Ran commands in {app}." },
  messaging: { title: "Messaging", description: "Read or wrote messages in {app}." },
  email: { title: "Handling email", description: "Read or wrote email in {app}." },
  document: { title: "Writing a document", description: "Read or edited a document in {app}." },
  spreadsheet: {
    title: "Working on a spreadsheet",
    description: "Worked with spreadsheet data in {app}.",
  },
  presentation: {
    title: "Working on a presentation",
    description: "Edited or viewed slides in {app}.",
  },
  design: { title: "Design work", description: "Worked on visual design in {app}." },
  reading: { title: "Reading a document", description: "Read a document in {app}." },
  files: { title: "Managing files", description: "Browsed or organized files in {app}." },
  assistant: {
    title: "Working with an AI assistant",
    description: "Worked with an AI assistant in {app}.",
  },
  media: { title: "Media", description: "Played or browsed media in {app}." },
  settings: {
    title: "Changing settings",
    description: "Adjusted system or app settings in {app}.",
  },
};

const CODE_MARKERS = [
  /\bconst\s+\w+\s*=/u,
  /\bfunction\s*\w*\s*\(/u,
  /\bimport\s+[\w{*]/u,
  /=>/u,
  /\breturn\b[^.]*;/u,
  /\bdef\s+\w+\s*\(/u,
  /\bclass\s+\w+\s*[{:(]/u,
  /#include\s*</u,
  /\b(?:public|private|protected)\s+\w+/u,
  /<\/\w+>/u,
  /\binterface\s+\w+\s*\{/u,
  /\bfn\s+\w+\s*\(/u,
];

function looksLikeCode(ocr: string): boolean {
  return CODE_MARKERS.filter((marker) => marker.test(ocr)).length >= 3;
}

function safeAppName(displayName: string, processName: string): string | null {
  const candidates = [displayName.trim(), executableStem(processName)];
  for (const candidate of candidates) {
    if (!candidate || candidate.length > 60) continue;
    try {
      // The redaction rules reject names that look like hosts, paths or ids.
      normalizeComputerHistorySemanticSummary({
        title: candidate,
        description: candidate,
        source: "windows_on_device",
      });
      return candidate;
    } catch {
      // Try the next name.
    }
  }
  return null;
}

/**
 * Turn one window's OCR text into an abstract activity summary on this PC. The result names
 * an activity category and the app; it never repeats words read from the screen. Like the
 * macOS helper, a frame without readable text produces no summary.
 */
export function summarizeWindowsActivity(input: {
  readonly processName: string;
  readonly displayName: string;
  readonly focusedControl: string | null;
  readonly ocrText: string | null;
}): ComputerHistorySemanticSummary | undefined {
  const ocr = normalizeWindowsHistoryOcr(input.ocrText);
  if (!ocr) return undefined;
  const stem = executableStem(input.processName);
  const app = safeAppName(input.displayName, input.processName);
  let category: ActivityCategory | undefined = CATEGORY_BY_EXECUTABLE[stem];
  if (!category && looksLikeCode(ocr)) category = "coding";
  let title: string;
  let description: string;
  if (category) {
    const text = CATEGORY_TEXT[category];
    title = text.title;
    description = app
      ? text.description.replace("{app}", app)
      : text.description.replace(" in {app}", "");
  } else {
    const control = input.focusedControl?.toLowerCase() ?? "";
    const editing = control.includes("document") || control.includes("edit");
    title = app ? `Using ${app}` : "Using an app";
    description = editing
      ? `Read or edited content in ${app ?? "an app"}.`
      : `Worked in ${app ?? "an app"}.`;
  }
  try {
    return normalizeComputerHistorySemanticSummary({
      title,
      description,
      source: "windows_on_device",
    });
  } catch {
    return undefined;
  }
}
