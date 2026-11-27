// FILE: osInstall.ts
// Purpose: Anti-spoofing name sanitization (NFKD + homoglyphs + Windows reserved device names),
//          isolated/real OS shortcut & macOS bundle creation, MS-SHLLINK HasWorkingDir stripping,
//          AUMID binding, and stale-install pruning with `.lnk` argument verification.
// Layer: Desktop pageApps

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  applyWindowsShellAppUserModel,
  type WindowsShellAppUserModelInput,
} from "../windowsShellAppUserModel";
import {
  PAGE_APP_AUMID_PREFIX,
  PAGE_APP_LAUNCH_ARG_PREFIX,
  type DesktopPageAppInstallPlace,
  type InstalledDesktopPageApp,
} from "./types";

export const PAGE_APP_SHORTCUT_DIR_ENV = "MOSS_APPS_SHORTCUT_DIR";
const RESERVED_BRAND_NAMES = ["Moss", "Windows", "Apple", "iCloud", "macOS", "Microsoft"] as const;
const INVALID_FILENAME_CHARS_RE = /[\\/:*?"<>|]/gu;
const WINDOWS_RESERVED_DEVICE_NAME_RE =
  /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3])\s*(?:\.|$)/iu;
const MOSS_APPS_FOLDER_NAME = "Moss Apps";
const MAX_LNK_VERIFY_BYTES = 65_536;

// Homoglyph / confusable folding aligned with Claude Desktop REA `Or`/`kr` in `UJzilp8j`.
const CONFUSABLE_MAP: Readonly<Record<string, string>> = {
  "\u0430": "a",
  "\u0432": "b",
  "\u0435": "e",
  "\u043a": "k",
  "\u043c": "m",
  "\u043d": "h",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0442": "t",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "l",
  "\u0458": "j",
  "\u0455": "s",
  "\u04bb": "h",
  "\u04cf": "l",
  "\u0501": "d",
  "\u051b": "q",
  "\u051d": "w",
  "\u03b1": "a",
  "\u03b2": "b",
  "\u03b5": "e",
  "\u03b7": "n",
  "\u03b9": "l",
  "\u03ba": "k",
  "\u03bd": "v",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c4": "t",
  "\u03c5": "u",
  "\u03c7": "x",
  "\u03bc": "m",
  "\u03c2": "c",
  "\u0251": "a",
  "\uab7a": "a",
  "\uabaf": "c",
  "\ua4da": "c",
  "\ua4ee": "a",
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "|": "l",
  i: "l",
  "\u0131": "l",
};

const LEET_PUNCTUATION_MAP: Readonly<Record<string, string>> = {
  "@": "a",
  "(": "c",
  "!": "l",
  $: "s",
};

const PURE_LATIN_WORD_RE =
  /^(?=.*[A-Za-z0-9])[A-Za-z0-9\xc0-\xd6\xd8-\xf6\xf8-\u013e\u0141-\u024f_'\u2019()&+!?#%-]+$/u;
const SINGLE_SCRIPT_REs = [
  "Arabic",
  "Armenian",
  "Bengali",
  "Cyrillic",
  "Devanagari",
  "Georgian",
  "Greek",
  "Gujarati",
  "Hebrew",
  "Tamil",
  "Telugu",
  "Thai",
].map((script) => RegExp(`^(?=\\p{L})(?:(?=[\\p{L}\\p{M}])\\p{sc=${script}})+[!?)]*$`, "u"));
const CJK_WORD_RE =
  /^(?=\p{L})(?:\p{sc=Han}|\p{sc=Hiragana}|\p{sc=Katakana}|[\uac00-\ud7a3\u30fc])+[!?)]*$/u;
const EMOJI_WORD_RE =
  /^(?=.*[\p{Extended_Pictographic}\p{Regional_Indicator}])(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\u200D)+$/u;
const KNOWN_SCRIPT_RES = [PURE_LATIN_WORD_RE, ...SINGLE_SCRIPT_REs, CJK_WORD_RE, EMOJI_WORD_RE];

function isCleanScriptWord(word: string): boolean {
  return (
    word.length === 1 ||
    (!PURE_LATIN_WORD_RE.test(word) && KNOWN_SCRIPT_RES.some((re) => re.test(word)))
  );
}

function hasSuspiciousMixedScript(name: string): boolean {
  const words = name.split(/\s+/u).filter(Boolean);
  const lastNonClean = words.findLast((w) => !isCleanScriptWord(w)) ?? words.at(-1) ?? "";
  return !KNOWN_SCRIPT_RES.some((re) => re.test(lastNonClean));
}

function buildSkeletons(input: string): string[][] {
  const folded = input
    .replace(/[\u2122\u2120]/gu, "")
    .normalize("NFKD")
    .toLowerCase();
  const project = (extraMap: Readonly<Record<string, string>>) =>
    Array.from(folded, (ch) => extraMap[ch] ?? CONFUSABLE_MAP[ch] ?? ch)
      .join("")
      .replace(/[\p{M}\p{Cf}\p{P}\p{S}\s]/gu, "");

  return [folded, project(LEET_PUNCTUATION_MAP), project({})]
    .filter(Boolean)
    .map((s) => Array.from(s));
}

function skeletonsCollide(
  candidate: readonly string[],
  target: readonly string[],
  prefixMatch: boolean,
): boolean {
  if (prefixMatch ? candidate.length < target.length : candidate.length !== target.length) {
    return false;
  }
  let exactMatches = 0;
  for (let idx = 0; idx < target.length; idx += 1) {
    const ch = candidate[idx]!;
    if (ch === target[idx]) {
      exactMatches += 1;
    } else if (/^\p{ASCII}$/u.test(ch)) {
      return false;
    }
  }
  return exactMatches * 2 >= target.length;
}

const RESERVED_BRAND_SKELETONS = RESERVED_BRAND_NAMES.flatMap((brand) => buildSkeletons(brand));

function stripControlChars(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    out += code <= 0x1f || code === 0x7f ? " " : input[i]!;
  }
  return out;
}

// [MS-SHLLINK] header & LinkFlags constants
const SHLLINK_HEADER_SIZE = 0x4c;
const SHLLINK_FLAGS_OFFSET = 0x14;
const SHLLINK_FLAG_HAS_IDLIST = 0x01;
const SHLLINK_FLAG_HAS_LINK_INFO = 0x02;
const SHLLINK_FLAG_HAS_NAME = 0x04;
const SHLLINK_FLAG_HAS_RELATIVE_PATH = 0x08;
const SHLLINK_FLAG_HAS_WORKING_DIR = 0x10;
const SHLLINK_FLAG_HAS_ARGUMENTS = 0x20;
const SHLLINK_FLAG_IS_UNICODE = 0x80;

export function buildPageAppAumid(installId: string): string {
  return `${PAGE_APP_AUMID_PREFIX}${installId}`;
}

export function buildPageAppLaunchArg(installId: string): string {
  return `${PAGE_APP_LAUNCH_ARG_PREFIX}${installId}`;
}

/**
 * Extracts `--moss-app=<32hex>` from argv if present and valid.
 */
export function extractPageAppInstallIdFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    if (!arg.startsWith(PAGE_APP_LAUNCH_ARG_PREFIX)) continue;
    const candidate = arg.slice(PAGE_APP_LAUNCH_ARG_PREFIX.length).trim().toLowerCase();
    if (/^[0-9a-f]{32}$/u.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface ShortcutDirectories {
  readonly startMenuAppsDir: string;
  readonly desktopDir: string;
  readonly macApplicationsAppsDir: string;
  readonly scanDirsForCollisions: readonly string[];
  readonly isolated: boolean;
}

/**
 * Resolves Start Menu, Desktop, and macOS Applications directories.
 * When `MOSS_APPS_SHORTCUT_DIR` is set, ALL shortcut reads and writes stay strictly inside it.
 */
export function resolvePageAppShortcutDirectories(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = OS.homedir(),
): ShortcutDirectories {
  const overrideDir = env[PAGE_APP_SHORTCUT_DIR_ENV]?.trim();
  if (overrideDir) {
    const startMenuAppsDir = Path.join(overrideDir, "StartMenu", MOSS_APPS_FOLDER_NAME);
    const desktopDir = Path.join(overrideDir, "Desktop");
    const macApplicationsAppsDir = Path.join(overrideDir, "Applications", MOSS_APPS_FOLDER_NAME);
    return {
      startMenuAppsDir,
      desktopDir,
      macApplicationsAppsDir,
      scanDirsForCollisions: [
        Path.join(overrideDir, "StartMenu"),
        startMenuAppsDir,
        desktopDir,
        macApplicationsAppsDir,
      ],
      isolated: true,
    };
  }

  const appData = env.APPDATA?.trim() || Path.join(homeDir, "AppData", "Roaming");
  const programData = env.ProgramData?.trim() || Path.join(Path.parse(homeDir).root, "ProgramData");
  const userStartPrograms = Path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
  const commonStartPrograms = Path.join(
    programData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  const desktopDir = Path.join(homeDir, "Desktop");
  const macApplicationsAppsDir = Path.join(homeDir, "Applications", MOSS_APPS_FOLDER_NAME);
  return {
    startMenuAppsDir: Path.join(userStartPrograms, MOSS_APPS_FOLDER_NAME),
    desktopDir,
    macApplicationsAppsDir,
    scanDirsForCollisions: [
      userStartPrograms,
      Path.join(userStartPrograms, MOSS_APPS_FOLDER_NAME),
      commonStartPrograms,
      desktopDir,
      macApplicationsAppsDir,
    ],
    isolated: false,
  };
}

/** Collects existing program names (without `.lnk`/`.app` suffix) for anti-spoofing collision checks. */
export function collectExistingProgramNames(directories: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of directories) {
    let entries: FS.Dirent[] = [];
    try {
      entries = FS.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".lnk")) {
        names.add(entry.name.slice(0, -4).toLowerCase());
      } else if (lower.endsWith(".app")) {
        names.add(entry.name.slice(0, -4).toLowerCase());
      } else if (entry.isDirectory()) {
        try {
          for (const nested of FS.readdirSync(Path.join(dir, entry.name))) {
            const nestedLower = nested.toLowerCase();
            if (nestedLower.endsWith(".lnk") || nestedLower.endsWith(".app")) {
              names.add(nested.slice(0, -4).toLowerCase());
            }
          }
        } catch {
          // Ignore unreadable folders.
        }
      }
    }
  }
  return names;
}

/**
 * Sanitizes an app title into a safe OS shortcut name:
 * - Blocks Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`)
 * - Uses NFKD + Cyrillic/Greek/Leet homoglyph skeleton matching against protected brands and
 *   existing Start Menu/Desktop programs, plus mixed-script spoofing detection -> appends ` (应用页)`.
 */
export function sanitizePageAppInstallName(
  rawTitle: string,
  existingProgramNames: ReadonlySet<string>,
  ownExistingName?: string | null,
): string {
  const cleanedRaw = stripControlChars(rawTitle.normalize("NFC"))
    .replace(INVALID_FILENAME_CHARS_RE, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/gu, "")
    .slice(0, 64)
    .trim();
  const base = !cleanedRaw
    ? "未命名应用"
    : WINDOWS_RESERVED_DEVICE_NAME_RE.test(cleanedRaw)
      ? `应用 ${cleanedRaw}`.slice(0, 64).trim()
      : cleanedRaw;
  const ownLower = ownExistingName?.trim().toLowerCase() ?? null;

  const isDirectCollision = (candidate: string): boolean => {
    const lower = candidate.toLowerCase();
    if (ownLower && lower === ownLower) return false;
    return existingProgramNames.has(lower);
  };

  const baseSkeletons = buildSkeletons(base);
  const spoofsBrand =
    baseSkeletons.some((cand) =>
      RESERVED_BRAND_SKELETONS.some((brand) => skeletonsCollide(cand, brand, true)),
    ) || hasSuspiciousMixedScript(base);

  const spoofsExisting =
    !(ownLower && base.toLowerCase() === ownLower) &&
    (isDirectCollision(base) ||
      Array.from(existingProgramNames).some((existingName) => {
        if (ownLower && existingName === ownLower) return false;
        const targetSkeletons = buildSkeletons(existingName);
        return baseSkeletons.some((cand) =>
          targetSkeletons.some((target) => skeletonsCollide(cand, target, false)),
        );
      }));

  if (!spoofsBrand && !spoofsExisting) {
    return base;
  }

  const disambiguated = `${base} (应用页)`.slice(0, 64).trim();
  if (!isDirectCollision(disambiguated)) {
    return disambiguated;
  }

  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${base} (应用页 ${index})`.slice(0, 64).trim();
    if (!isDirectCollision(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 64);
}

interface ParsedShllinkOffsets {
  readonly flags: number;
  readonly unicode: boolean;
  readonly workingDirStart: number | null;
  readonly workingDirEnd: number | null;
  readonly argumentsText: string | null;
}

function readShllinkString(
  buf: Buffer,
  offset: number,
  unicode: boolean,
): { readonly nextOffset: number; readonly text: string } | null {
  if (offset + 2 > buf.length) return null;
  const charCount = buf.readUInt16LE(offset);
  const byteLen = charCount * (unicode ? 2 : 1);
  const start = offset + 2;
  const end = start + byteLen;
  if (end > buf.length) return null;
  const text = buf.toString(unicode ? "utf16le" : "latin1", start, end);
  return { nextOffset: end, text };
}

function parseShllinkLayout(buf: Buffer): ParsedShllinkOffsets | null {
  if (buf.length < SHLLINK_HEADER_SIZE) return null;
  if (buf.readUInt32LE(0) !== SHLLINK_HEADER_SIZE) return null;

  const flags = buf.readUInt32LE(SHLLINK_FLAGS_OFFSET);
  const unicode = (flags & SHLLINK_FLAG_IS_UNICODE) !== 0;
  let offset = SHLLINK_HEADER_SIZE;

  if ((flags & SHLLINK_FLAG_HAS_IDLIST) !== 0) {
    if (offset + 2 > buf.length) return null;
    const idListSize = buf.readUInt16LE(offset);
    offset += 2 + idListSize;
    if (offset > buf.length) return null;
  }

  if ((flags & SHLLINK_FLAG_HAS_LINK_INFO) !== 0) {
    if (offset + 4 > buf.length) return null;
    const linkInfoSize = buf.readUInt32LE(offset);
    if (linkInfoSize < 4 || offset + linkInfoSize > buf.length) return null;
    offset += linkInfoSize;
  }

  if ((flags & SHLLINK_FLAG_HAS_NAME) !== 0) {
    const parsed = readShllinkString(buf, offset, unicode);
    if (!parsed) return null;
    offset = parsed.nextOffset;
  }

  if ((flags & SHLLINK_FLAG_HAS_RELATIVE_PATH) !== 0) {
    const parsed = readShllinkString(buf, offset, unicode);
    if (!parsed) return null;
    offset = parsed.nextOffset;
  }

  let workingDirStart: number | null = null;
  let workingDirEnd: number | null = null;
  if ((flags & SHLLINK_FLAG_HAS_WORKING_DIR) !== 0) {
    workingDirStart = offset;
    const parsed = readShllinkString(buf, offset, unicode);
    if (!parsed) return null;
    workingDirEnd = parsed.nextOffset;
    offset = parsed.nextOffset;
  }

  let argumentsText: string | null = null;
  if ((flags & SHLLINK_FLAG_HAS_ARGUMENTS) !== 0) {
    const parsed = readShllinkString(buf, offset, unicode);
    if (!parsed) return null;
    argumentsText = parsed.text;
  }

  return { flags, unicode, workingDirStart, workingDirEnd, argumentsText };
}

/**
 * Clears the `HasWorkingDir` LinkFlag (`0x10`) and removes any WorkingDir StringData record
 * from an MS-SHLLINK `.lnk` file so Windows does not pin or inherit a stale working directory.
 */
export function stripWorkingDirFromLnkBuffer(lnkBuffer: Buffer): Buffer {
  const layout = parseShllinkLayout(lnkBuffer);
  if (!layout || (layout.flags & SHLLINK_FLAG_HAS_WORKING_DIR) === 0) {
    return lnkBuffer;
  }

  const nextFlags = (layout.flags & ~SHLLINK_FLAG_HAS_WORKING_DIR) >>> 0;
  if (layout.workingDirStart !== null && layout.workingDirEnd !== null) {
    const prefix = Buffer.from(lnkBuffer.subarray(0, layout.workingDirStart));
    prefix.writeUInt32LE(nextFlags, SHLLINK_FLAGS_OFFSET);
    const suffix = lnkBuffer.subarray(layout.workingDirEnd);
    return Buffer.concat([prefix, suffix]);
  }

  const out = Buffer.from(lnkBuffer);
  out.writeUInt32LE(nextFlags, SHLLINK_FLAGS_OFFSET);
  return out;
}

/** Verifies the `.lnk` binary carries UTF-16LE launch arguments containing `expectedSubstring`. */
export function verifyLnkArgumentsUtf16Le(lnkBuffer: Buffer, expectedSubstring: string): boolean {
  const layout = parseShllinkLayout(lnkBuffer);
  if (layout && layout.unicode && layout.argumentsText !== null) {
    return layout.argumentsText.includes(expectedSubstring);
  }
  return lnkBuffer.includes(Buffer.from(expectedSubstring, "utf16le"));
}

export interface ShortcutWriterOps {
  readonly writeWindowsShortcut: (
    shortcutPath: string,
    options: {
      readonly target: string;
      readonly args: string;
      readonly icon: string;
      readonly iconIndex: number;
      readonly description: string;
      readonly appUserModelId: string;
    },
  ) => boolean;
  readonly applyAumid?: (input: WindowsShellAppUserModelInput) => void;
}

function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeShellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\"'\"'");
}

export interface InstallOsArtifactsInput {
  readonly installId: string;
  readonly name: string;
  readonly description: string;
  readonly executablePath: string;
  readonly hostBundleId?: string | null;
  readonly iconPath: string;
  readonly png256?: Buffer;
  readonly places: readonly DesktopPageAppInstallPlace[];
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly aumidHelperCacheDir?: string;
  readonly ops?: ShortcutWriterOps;
}

export interface InstallOsArtifactsResult {
  readonly shortcutPaths: readonly string[];
  readonly bundlePath: string | null;
}

/** Creates OS shortcuts (Windows Start Menu / Desktop `.lnk` or macOS `.app` bundle). */
export function installOsArtifacts(input: InstallOsArtifactsInput): InstallOsArtifactsResult {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const dirs = resolvePageAppShortcutDirectories(env, input.homeDir ?? OS.homedir());
  const aumid = buildPageAppAumid(input.installId);
  const launchArg = buildPageAppLaunchArg(input.installId);
  const shortcutPaths: string[] = [];
  let bundlePath: string | null = null;

  if (platform === "win32") {
    const targetDirs: string[] = [];
    if (input.places.includes("start-menu")) {
      targetDirs.push(dirs.startMenuAppsDir);
    }
    if (input.places.includes("desktop")) {
      targetDirs.push(dirs.desktopDir);
    }
    for (const dir of targetDirs) {
      FS.mkdirSync(dir, { recursive: true });
      const lnkPath = Path.join(dir, `${input.name}.lnk`);
      const written = input.ops?.writeWindowsShortcut(lnkPath, {
        target: input.executablePath,
        args: launchArg,
        icon: input.iconPath,
        iconIndex: 0,
        description: input.description || input.name,
        appUserModelId: aumid,
      });
      if (written === false) {
        throw new Error(`Failed to write Windows shortcut at ${lnkPath}`);
      }
      if (FS.existsSync(lnkPath)) {
        const raw = FS.readFileSync(lnkPath);
        const stripped = stripWorkingDirFromLnkBuffer(raw);
        if (stripped !== raw) {
          FS.writeFileSync(lnkPath, stripped);
        }
      }
      shortcutPaths.push(lnkPath);
    }

    if (shortcutPaths.length > 0 && env.MOSS_DISABLE_SHORTCUT_ICON_SYNC !== "1") {
      const aumidInput: WindowsShellAppUserModelInput = {
        appId: aumid,
        iconPath: input.iconPath,
        relaunchCommand: `"${input.executablePath}" ${launchArg}`,
        displayName: input.name,
        shortcutPaths,
      };
      if (input.ops?.applyAumid) {
        input.ops.applyAumid(aumidInput);
      } else if (input.aumidHelperCacheDir) {
        try {
          applyWindowsShellAppUserModel(aumidInput, input.aumidHelperCacheDir);
        } catch {
          // Helper compilation/invocation is best-effort (e.g. missing csc.exe).
        }
      }
    }
    return { shortcutPaths, bundlePath: null };
  }

  if (platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${escapeXmlText(input.name)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXmlText(input.name)}</string>
  <key>CFBundleIdentifier</key>
  <string>com.moss.pageapp.${input.installId}</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>app.png</string>
  <key>LSUIElement</key>
  <true/>
  <key>MossPageAppInstallId</key>
  <string>${escapeXmlText(input.installId)}</string>
</dict>
</plist>
`;
    const hostBundleId = input.hostBundleId?.trim() || "com.moss.desktop";
    const escapedExec = escapeShellSingleQuote(input.executablePath);
    const escapedBundle = escapeShellSingleQuote(hostBundleId);
    const script = [
      "#!/bin/sh",
      `if [ -x /usr/bin/open ] && /usr/bin/open -b '${escapedBundle}' --args '${launchArg}' "$@"; then`,
      "  exit 0",
      "fi",
      `exec '${escapedExec}' '${launchArg}' "$@"`,
      "",
    ].join("\n");

    const writeDarwinBundle = (targetDir: string): string => {
      FS.mkdirSync(targetDir, { recursive: true });
      const targetAppPath = Path.join(targetDir, `${input.name}.app`);
      const contentsDir = Path.join(targetAppPath, "Contents");
      const macOsDir = Path.join(contentsDir, "MacOS");
      const resourcesDir = Path.join(contentsDir, "Resources");
      FS.mkdirSync(macOsDir, { recursive: true });
      FS.mkdirSync(resourcesDir, { recursive: true });
      FS.writeFileSync(Path.join(contentsDir, "Info.plist"), plist, "utf8");
      const launcherPath = Path.join(macOsDir, "launcher");
      FS.writeFileSync(launcherPath, script, { mode: 0o755 });
      try {
        FS.chmodSync(launcherPath, 0o755);
      } catch {
        // Best effort.
      }
      if (input.png256) {
        FS.writeFileSync(Path.join(resourcesDir, "app.png"), input.png256);
      }
      shortcutPaths.push(targetAppPath);
      return targetAppPath;
    };

    if (input.places.includes("applications")) {
      bundlePath = writeDarwinBundle(dirs.macApplicationsAppsDir);
    }
    if (input.places.includes("desktop")) {
      const desktopBundle = writeDarwinBundle(dirs.desktopDir);
      bundlePath ??= desktopBundle;
    }
    return { shortcutPaths, bundlePath };
  }

  return { shortcutPaths, bundlePath: null };
}

/** Toggles only the OS Desktop shortcut/bundle for an installed Page App, returning updated places and shortcutPaths. */
export function setDesktopShortcutArtifact(input: {
  readonly entry: InstalledDesktopPageApp;
  readonly enabled: boolean;
  readonly executablePath: string;
  readonly hostBundleId?: string | null;
  readonly png256?: Buffer;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly aumidHelperCacheDir?: string;
  readonly ops?: ShortcutWriterOps;
}): {
  readonly places: DesktopPageAppInstallPlace[];
  readonly shortcutPaths: string[];
  readonly desktopShortcutEnabled: boolean;
} {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const dirs = resolvePageAppShortcutDirectories(env, input.homeDir ?? OS.homedir());
  const normalizedDesktopDir = Path.normalize(dirs.desktopDir).toLowerCase();
  const isInDesktopDir = (filePath: string) =>
    Path.normalize(Path.dirname(filePath)).toLowerCase() === normalizedDesktopDir;

  const existingShortcuts = [...(input.entry.shortcutPaths ?? [])];
  const nonDesktopShortcuts = existingShortcuts.filter((p) => !isInDesktopDir(p));
  const desktopShortcuts = existingShortcuts.filter(isInDesktopDir);

  if (!input.enabled) {
    removeOsArtifacts({ shortcutPaths: desktopShortcuts, bundlePath: null });
    const nextPlaces = input.entry.places.filter((place) => place !== "desktop");
    return {
      places: nextPlaces,
      shortcutPaths: nonDesktopShortcuts,
      desktopShortcutEnabled: false,
    };
  }

  if (desktopShortcuts.some((p) => FS.existsSync(p))) {
    const nextPlaces = input.entry.places.includes("desktop")
      ? [...input.entry.places]
      : ([...input.entry.places, "desktop"] as DesktopPageAppInstallPlace[]);
    return {
      places: nextPlaces,
      shortcutPaths: existingShortcuts,
      desktopShortcutEnabled: true,
    };
  }

  const created = installOsArtifacts({
    installId: input.entry.installId,
    name: input.entry.name,
    description: input.entry.rawTitle ?? input.entry.name,
    executablePath: input.executablePath,
    ...(input.hostBundleId !== undefined ? { hostBundleId: input.hostBundleId } : {}),
    iconPath: input.entry.iconPath ?? "",
    ...(input.png256 ? { png256: input.png256 } : {}),
    places: ["desktop"],
    platform,
    env,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
    ...(input.aumidHelperCacheDir ? { aumidHelperCacheDir: input.aumidHelperCacheDir } : {}),
    ...(input.ops ? { ops: input.ops } : {}),
  });

  const nextShortcuts = Array.from(new Set([...nonDesktopShortcuts, ...created.shortcutPaths]));
  const nextPlaces = input.entry.places.includes("desktop")
    ? [...input.entry.places]
    : ([...input.entry.places, "desktop"] as DesktopPageAppInstallPlace[]);
  return {
    places: nextPlaces,
    shortcutPaths: nextShortcuts,
    desktopShortcutEnabled: true,
  };
}

/** Removes OS shortcuts / macOS `.app` bundle created for an installed Page App. */
export function removeOsArtifacts(
  entry: Pick<InstalledDesktopPageApp, "shortcutPaths" | "bundlePath">,
): void {
  for (const shortcutPath of entry.shortcutPaths ?? []) {
    try {
      if (FS.existsSync(shortcutPath)) {
        const stat = FS.lstatSync(shortcutPath);
        if (stat.isDirectory()) {
          FS.rmSync(shortcutPath, { recursive: true, force: true });
        } else {
          FS.unlinkSync(shortcutPath);
        }
      }
    } catch {
      // Best effort cleanup.
    }
  }
  if (entry.bundlePath) {
    try {
      if (FS.existsSync(entry.bundlePath)) {
        FS.rmSync(entry.bundlePath, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup.
    }
  }
}

function readLnkPrefixSync(filePath: string): Buffer | null {
  try {
    const stat = FS.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_LNK_VERIFY_BYTES) return null;
    return FS.readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Checks installed records against disk and marks entries stale when:
 * - Both `shortcutPaths` is empty AND `bundlePath` is null/absent
 * - None of the registered OS artifacts exist, OR on `.lnk` shortcuts, none carry `--moss-app=<installId>`.
 */
export function findStaleInstalledApps(
  apps: readonly InstalledDesktopPageApp[],
  exists: (filePath: string) => boolean = FS.existsSync,
  readLnk: (filePath: string) => Buffer | null = readLnkPrefixSync,
): {
  readonly active: InstalledDesktopPageApp[];
  readonly stale: InstalledDesktopPageApp[];
} {
  const active: InstalledDesktopPageApp[] = [];
  const stale: InstalledDesktopPageApp[] = [];
  for (const entry of apps) {
    const pathsToCheck = [
      ...(entry.shortcutPaths ?? []),
      ...(entry.bundlePath ? [entry.bundlePath] : []),
    ];
    if (pathsToCheck.length === 0) {
      stale.push(entry);
      continue;
    }
    const expectedArg = buildPageAppLaunchArg(entry.installId);
    const anyValid = pathsToCheck.some((p) => {
      try {
        if (!exists(p)) return false;
        if (p.toLowerCase().endsWith(".lnk")) {
          const bytes = readLnk(p);
          if (bytes === null) return false;
          return verifyLnkArgumentsUtf16Le(bytes, expectedArg);
        }
        return true;
      } catch {
        return false;
      }
    });
    if (anyValid) {
      active.push(entry);
    } else {
      stale.push(entry);
    }
  }
  return { active, stale };
}
