// FILE: computerAppPolicy.ts
// Purpose: One spelling rule for Settings › Computer use per-app choices, shared by the
//          server (which enforces them) and the web page (which edits them).
// Layer: Shared runtime utility
// Exports: computerAppPolicyKey, computerAppIdentityKeys, computerAppPolicyMatch,
//          ComputerAppAllowIdentity, computerAppIsProtected, computerAppCanBeAlwaysAllowed,
//          computerAppAllowKeys, computerAppIsSharedHost, withComputerApp, withoutComputerApp

/**
 * The comparable form of an app identity: a display name, a bundle id, a
 * process name or an executable path all reduce to one lowercase key, so
 * `C:\Program Files\Google\Chrome\Application\chrome.exe`, `chrome.exe` and
 * `Chrome` agree, and `Notes.app` matches `Notes`. Exact keys only — never a
 * prefix — so blocking "Chrome" cannot also block "Chrome Remote Desktop".
 */
export function computerAppPolicyKey(raw: string): string {
  let name = raw.trim();
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (slash >= 0) name = name.slice(slash + 1);
  const lower = name.toLowerCase();
  if (lower.endsWith(".app") || lower.endsWith(".exe")) name = name.slice(0, -4);
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether a spelling names a file path rather than an app. */
function isPathSpelling(raw: string): boolean {
  return /[\\/]/.test(raw);
}

/**
 * Programs that can never skip the approval prompt, decided by what they are
 * (executable or process name, macOS bundle id), never by the name a window
 * shows: Windows reports 「设置」 or 「設定」 for the same SystemSettings.exe.
 *
 * - Settings, Control Panel, management consoles and the registry change
 *   system and privacy settings (macOS System Settings is refused outright by
 *   the server denylist).
 * - Shells and terminals run anything, so always allowing one is always
 *   allowing everything; Task Manager ends any process.
 * - Shared host processes own windows of many apps, Settings and Control
 *   Panel among them, so a choice made on one would reach the others.
 */
const PROTECTED_EXECUTABLES: ReadonlySet<string> = new Set([
  // Windows Settings and Control Panel
  "systemsettings",
  "systemsettingsadminflows",
  "systemsettingsbroker",
  "control",
  "mmc",
  "regedit",
  "msconfig",
  // Process control and shells
  "taskmgr",
  "cmd",
  "powershell",
  "powershell_ise",
  "pwsh",
  "windowsterminal",
  "wt",
  "openconsole",
  "conhost",
  "wsl",
  "bash",
  // Shared hosts
  "explorer",
  "applicationframehost",
  "dllhost",
  "rundll32",
  "svchost",
  "wwahost",
  // macOS process names
  "terminal",
  "iterm2",
  "activity monitor",
]);

const PROTECTED_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.apple.systempreferences",
  "com.apple.terminal",
  "com.googlecode.iterm2",
  "com.apple.activitymonitor",
  "com.microsoft.windowsterminal",
]);

/**
 * The second net: display names of the same programs, in the languages Moss
 * ships. Used only after the identity check, for a program whose identity the
 * desktop reported under a name this list knows.
 */
const PROTECTED_DISPLAY_NAMES: ReadonlySet<string> = new Set([
  // English
  "settings",
  "windows settings",
  "system settings",
  "system preferences",
  "control panel",
  "file explorer",
  "windows explorer",
  "registry editor",
  "task manager",
  "command prompt",
  "windows powershell",
  "windows terminal",
  "computer management",
  "system configuration",
  // Simplified Chinese
  "设置",
  "系统设置",
  "控制面板",
  "文件资源管理器",
  "资源管理器",
  "注册表编辑器",
  "任务管理器",
  "命令提示符",
  "终端",
  "windows 终端",
  "计算机管理",
  "系统配置",
  "活动监视器",
  // Traditional Chinese
  "設定",
  "系統設定",
  "控制台",
  "檔案總管",
  "資源管理器",
  "登錄編輯程式",
  "工作管理員",
  "命令提示字元",
  "終端機",
  "windows 終端機",
  "電腦管理",
  "系統設定公用程式",
  "活動監視器",
]);

/** Windows processes that own windows of many different apps. */
const SHARED_HOST_PROCESSES: ReadonlySet<string> = new Set([
  "applicationframehost",
  "explorer",
  "dllhost",
  "rundll32",
  "svchost",
  "wwahost",
]);

/**
 * Whether a process name is a shared host, whose identity (path, bundle id)
 * must not be attached to the app a window names: it would make every app the
 * host shows look like one app.
 */
export function computerAppIsSharedHost(processName: string): boolean {
  return SHARED_HOST_PROCESSES.has(computerAppPolicyKey(processName));
}

/**
 * What is known about an app when deciding whether it may skip the prompt.
 * `name` is what the row or the call shows; the rest is its identity, from the
 * running-app inventory or the window's owning process.
 */
export interface ComputerAppAllowIdentity {
  readonly name?: string | undefined;
  /** The owning process (Windows), e.g. `notepad` for 「记事本」. */
  readonly processName?: string | undefined;
  /** The executable or bundle path. */
  readonly path?: string | undefined;
  readonly bundleId?: string | undefined;
}

/** Whether an identity is one of the protected programs, in any language. */
export function computerAppIsProtected(identity: ComputerAppAllowIdentity): boolean {
  for (const value of [identity.processName, identity.path, identity.name]) {
    if (typeof value === "string" && PROTECTED_EXECUTABLES.has(computerAppPolicyKey(value)))
      return true;
  }
  if (
    typeof identity.bundleId === "string" &&
    (PROTECTED_BUNDLE_IDS.has(identity.bundleId.trim().toLowerCase()) ||
      PROTECTED_EXECUTABLES.has(computerAppPolicyKey(identity.bundleId)))
  )
    return true;
  return (
    typeof identity.name === "string" &&
    PROTECTED_DISPLAY_NAMES.has(computerAppPolicyKey(identity.name))
  );
}

/**
 * Whether this app may be on the "always allowed" list at all. It needs a
 * display name that is not a path, an identity the desktop resolved (process,
 * executable or bundle id — a bare name proves nothing), and that identity
 * must not be a protected program.
 */
export function computerAppCanBeAlwaysAllowed(identity: ComputerAppAllowIdentity): boolean {
  const name = identity.name?.trim() ?? "";
  if (name.length === 0 || isPathSpelling(name)) return false;
  const resolved = [identity.processName, identity.path, identity.bundleId].some(
    (value) => typeof value === "string" && computerAppPolicyKey(value).length > 0,
  );
  return resolved && !computerAppIsProtected(identity);
}

/**
 * The keys "always allowed" may match: the target's own name and bundle id
 * only, and only for an app that may be always allowed at all. A path is never
 * one — an agent naming `C:\Users\me\Downloads\notepad.exe` is not naming the
 * Notepad the user allowed — and there is no alias or host-process expansion,
 * which is safe only for blocking.
 */
export function computerAppAllowKeys(identity: ComputerAppAllowIdentity): ReadonlySet<string> {
  if (!computerAppCanBeAlwaysAllowed(identity)) return new Set();
  const keys = new Set<string>();
  for (const value of [identity.name, identity.bundleId]) {
    if (typeof value !== "string" || isPathSpelling(value)) continue;
    const key = computerAppPolicyKey(value);
    if (key.length > 0) keys.add(key);
  }
  return keys;
}

/** Every key an identity can be matched by, empty spellings dropped. */
export function computerAppIdentityKeys(identity: {
  readonly name?: string | undefined;
  readonly bundleId?: string | undefined;
  readonly path?: string | undefined;
}): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of [identity.name, identity.bundleId, identity.path]) {
    if (typeof value !== "string") continue;
    const key = computerAppPolicyKey(value);
    if (key.length > 0) keys.add(key);
  }
  return keys;
}

/** The list entry an identity matches, or `undefined`. */
export function computerAppPolicyMatch(
  list: readonly string[],
  keys: ReadonlySet<string>,
): string | undefined {
  if (keys.size === 0) return undefined;
  return list.find((entry) => keys.has(computerAppPolicyKey(entry)));
}

/** `list` with `app` added once, keeping the first spelling already stored. */
export function withComputerApp(list: readonly string[], app: string): string[] {
  const key = computerAppPolicyKey(app);
  if (key.length === 0 || list.some((entry) => computerAppPolicyKey(entry) === key)) {
    return [...list];
  }
  return [...list, app.trim()];
}

/** `list` without any spelling of `app`. */
export function withoutComputerApp(list: readonly string[], app: string): string[] {
  const key = computerAppPolicyKey(app);
  return list.filter((entry) => computerAppPolicyKey(entry) !== key);
}
