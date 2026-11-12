// FILE: computerAppPolicy.ts
// Purpose: One spelling rule for Settings › Computer use per-app choices, shared by the
//          server (which enforces them) and the web page (which edits them).
// Layer: Shared runtime utility
// Exports: computerAppPolicyKey, computerAppIdentityKeys, computerAppPolicyMatch,
//          computerAppAllowKeys, computerAppCanBeAlwaysAllowed, computerAppIsSharedHost,
//          withComputerApp,
//          withoutComputerApp

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
 * Apps that can never skip the approval prompt, whatever the settings say.
 * Windows Settings and Control Panel change system and privacy settings (macOS
 * System Settings is refused outright by the server denylist), and the shared
 * host processes own windows of many apps, Settings and Control Panel among
 * them, so a choice made on one of them would reach the others.
 */
const NEVER_ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  "settings",
  "windows settings",
  "systemsettings",
  "systemsettingsadminflows",
  "control panel",
  "control",
  "applicationframehost",
  "explorer",
  "file explorer",
  "windows explorer",
  "mmc",
  "regedit",
  "registry editor",
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

/** Whether this app may be put on the "always allowed" list at all. */
export function computerAppCanBeAlwaysAllowed(name: string): boolean {
  const key = computerAppPolicyKey(name);
  return key.length > 0 && !isPathSpelling(name) && !NEVER_ALWAYS_ALLOWED.has(key);
}

/**
 * The keys "always allowed" may match: the target's own name and bundle id
 * only. A path is never one — an agent naming `C:\Users\me\Downloads\notepad.exe`
 * is not naming the Notepad the user allowed — and there is no alias or
 * host-process expansion, which is safe only for blocking. An identity that
 * names a never-allowed app answers no keys.
 */
export function computerAppAllowKeys(identity: {
  readonly name?: string | undefined;
  readonly bundleId?: string | undefined;
}): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of [identity.name, identity.bundleId]) {
    if (typeof value !== "string" || isPathSpelling(value)) continue;
    const key = computerAppPolicyKey(value);
    if (key.length === 0) continue;
    if (NEVER_ALWAYS_ALLOWED.has(key)) return new Set();
    keys.add(key);
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
