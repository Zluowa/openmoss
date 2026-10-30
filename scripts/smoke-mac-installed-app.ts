#!/usr/bin/env node
// FILE: smoke-mac-installed-app.ts
// Purpose: Exercises a packaged Moss macOS app from an isolated temporary installation.
// Layer: Release acceptance driver
// Depends on: A DMG or unpacked .app produced by build-desktop-artifact.ts.

import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

const DEFAULT_TIMEOUT_MS = 120_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 30_000;
const PROCESS_TREE_EXIT_TIMEOUT_MS = 10_000;
const MAIN_WINDOW_POLL_INTERVAL_MS = 250;
const MAIN_WINDOW_EVALUATION_TIMEOUT_MS = 2_000;
const COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const PROCESS_TABLE_SCAN_TIMEOUT_MS = 1_000;
const APP_NAME = "Moss.app";
const MOSS_PRODUCTION_BUNDLE_ID = "com.moss.desktop";

const SYSTEM_BINARIES = {
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  plutil: "/usr/bin/plutil",
  spctl: "/usr/sbin/spctl",
  stapler: "/usr/bin/xcrun",
} as const;

export interface MacInstalledAppSmokeOptions {
  readonly appPath?: string;
  readonly dmgPath?: string;
  readonly expectedAppleDeveloperIdentity?: string;
  readonly expectedAppleTeamId?: string;
  readonly expectedVersion: string;
  readonly keepWorkDir: boolean;
  readonly publish: boolean;
  readonly reportPath?: string;
  readonly timeoutMs: number;
}

interface SmokeState {
  appPid?: number;
  childExit?: ProcessExit;
  childLogs: Array<string>;
  ownedDescendants?: ReadonlyArray<CapturedProcess>;
  installedAppPath?: string;
  mainWindowEvidence?: SafeMainWindowEvidence;
  stage: string;
  workDir?: string;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface CapturedProcess {
  readonly pid: number;
  readonly command: string;
}

export interface MainWindowEvidence {
  readonly desktopWsUrl: string;
  readonly hasBody: boolean;
  readonly hasDesktopBridge: boolean;
  readonly hasDesktopBridgeGetWsUrl: boolean;
  readonly locationHref: string;
  readonly readyState: string;
}

type SafeReadyState = "loading" | "interactive" | "complete" | "other";

interface SafeMainWindowEvidence {
  readonly hasBody: boolean;
  readonly hasDesktopBridge: boolean;
  readonly hasDesktopBridgeGetWsUrl: boolean;
  readonly locationIsExpected: boolean;
  readonly readyState: SafeReadyState;
}

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

export function describeMissingMainCdpTarget(targets: ReadonlyArray<unknown>): string {
  return `No moss://app main window in CDP target list (count=${targets.length}).`;
}

export interface MainWindowProcessState {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface MainWindowReadinessControls {
  readonly exitPromise?: Promise<ProcessExit>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

class FatalMainWindowEvidenceError extends Error {}

interface CommandOptions {
  readonly env?: NodeJS.ProcessEnv;
}

interface MainWindowEvidenceWaitOptions {
  readonly evaluate?: typeof evaluateCdpTarget;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

interface MainWindowWaitOptions extends MainWindowEvidenceWaitOptions {
  readonly exitPromise?: Promise<ProcessExit>;
  readonly waitForTarget?: (
    port: number,
    child: Pick<ChildProcess, "exitCode" | "signalCode">,
    deadlineMs: number,
  ) => Promise<CdpTarget>;
}

function printHelp(): void {
  console.log(`Usage: node scripts/smoke-mac-installed-app.ts (--dmg <path> | --app <path>) [options]

Copies a packaged Moss app into a temporary installation path, verifies its
identity and code-signing structure, launches the real packaged executable
with an isolated HOME/MOSS_HOME/userData, proves the main window and loopback
backend health through CDP, and then requests a graceful SIGTERM shutdown.

Options:
  --dmg <path>                 Mount this DMG read-only and copy Moss.app from it.
  --app <path>                 Copy this unpacked .app bundle instead of a DMG.
  --expected-version <value>  Expected CFBundleShortVersionString. Defaults to ${desktopPackageJson.version}.
  --publish                    Require pinned Developer ID, Gatekeeper notarization, and stapled tickets.
  --expected-apple-team-id <id>
                               Publish-only exact TeamIdentifier (for example ABCDE12345).
  --expected-apple-developer-identity <value>
                               Publish-only exact Developer ID Application authority.
  --report <path>              Write a redacted JSON diagnostic on success or failure.
  --timeout-ms <number>        Startup timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --keep-work-dir              Preserve the isolated temporary directory for local debugging.
  --help                       Show this help.

There is intentionally no option to run from /Applications, reuse a user
profile, skip codesign verification, or bypass publish Gatekeeper checks.
`);
}

function resolveExistingInputPath(rawPath: string, expectedKind: "app" | "dmg"): string {
  const unresolvedInputPath = resolve(rawPath);
  if (lstatSync(unresolvedInputPath).isSymbolicLink()) {
    throw new Error(`Smoke input must not be a symbolic link: ${rawPath}`);
  }
  const inputPath = realpathSync.native(unresolvedInputPath);
  const inputStat = statSync(inputPath);
  if (expectedKind === "app") {
    if (!inputStat.isDirectory() || !inputPath.endsWith(".app")) {
      throw new Error(`--app must point to an existing .app directory: ${rawPath}`);
    }
  } else if (!inputStat.isFile() || !inputPath.endsWith(".dmg")) {
    throw new Error(`--dmg must point to an existing .dmg file: ${rawPath}`);
  }
  return inputPath;
}

export function parseMacInstalledAppSmokeOptions(
  argv: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): MacInstalledAppSmokeOptions | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      app: { type: "string" },
      dmg: { type: "string" },
      "expected-apple-developer-identity": { type: "string" },
      "expected-apple-team-id": { type: "string" },
      "expected-version": {
        type: "string",
        default: desktopPackageJson.version,
      },
      help: { type: "boolean", default: false },
      "keep-work-dir": { type: "boolean", default: false },
      publish: { type: "boolean", default: false },
      report: { type: "string" },
      "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return null;
  }
  if (platform !== "darwin") {
    throw new Error("The installed-app macOS smoke must run on macOS.");
  }
  if (Boolean(values.app) === Boolean(values.dmg)) {
    throw new Error("Provide exactly one input: --dmg <path> or --app <path>.");
  }

  const expectedVersion = values["expected-version"]?.trim() ?? "";
  if (!expectedVersion || /[\r\n]/.test(expectedVersion)) {
    throw new Error("--expected-version must be a non-empty single-line value.");
  }
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
    throw new Error("--timeout-ms must be an integer between 10000 and 600000.");
  }

  const expectedAppleTeamId = values["expected-apple-team-id"]?.trim();
  const expectedAppleDeveloperIdentity = values["expected-apple-developer-identity"]?.trim();
  if (values.publish) {
    if (!expectedAppleTeamId || !/^[A-Z0-9]{10}$/.test(expectedAppleTeamId)) {
      throw new Error(
        "--publish requires --expected-apple-team-id as an exact 10-character Apple Team ID.",
      );
    }
    if (
      !expectedAppleDeveloperIdentity ||
      /[\r\n]/.test(expectedAppleDeveloperIdentity) ||
      !expectedAppleDeveloperIdentity.startsWith("Developer ID Application: ")
    ) {
      throw new Error(
        "--publish requires --expected-apple-developer-identity as the exact single-line Developer ID Application authority.",
      );
    }
    if (!expectedAppleDeveloperIdentity.endsWith(`(${expectedAppleTeamId})`)) {
      throw new Error(
        "--expected-apple-developer-identity must end with the configured Apple Team ID in parentheses.",
      );
    }
  } else if (expectedAppleTeamId || expectedAppleDeveloperIdentity) {
    throw new Error("Apple identity pinning options require --publish.");
  }

  return {
    ...(values.app ? { appPath: resolveExistingInputPath(values.app, "app") } : {}),
    ...(values.dmg ? { dmgPath: resolveExistingInputPath(values.dmg, "dmg") } : {}),
    ...(expectedAppleDeveloperIdentity ? { expectedAppleDeveloperIdentity } : {}),
    ...(expectedAppleTeamId ? { expectedAppleTeamId } : {}),
    expectedVersion,
    keepWorkDir: values["keep-work-dir"],
    publish: values.publish,
    ...(values.report ? { reportPath: resolve(values.report) } : {}),
    timeoutMs,
  };
}

export function redactDiagnostic(value: string): string {
  let redacted = value
    .replace(
      /\b((?:proxy-)?authorization\s*:\s*)(?:basic|bearer)\s+[^\s,;]+/gi,
      "$1[REDACTED_CREDENTIAL]",
    )
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, "$1[REDACTED_CREDENTIAL]")
    .replace(/\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/(^|[\s("'=])(?:\/\/|\/|\.\.?\/)[^\s"'<>]*[?#][^\s"'<>]*/g, "$1[REDACTED_URL]")
    .replace(
      /\b(host(?:name)?(?:\s*[:=]\s*|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|\[(?=[^\]\s]*:)[^\]\s]+\](?::\d{1,5})?(?:[/?#]\S*)?|[^\s,;)}]+)/gi,
      "$1[REDACTED_HOST]",
    )
    .replace(
      /\b[^\s/@]+@(?:\[(?=[^\]\s]*:)[^\]\s]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)(?::\d{1,5})?(?:[/?#]\S*)?/gi,
      "[REDACTED_ENDPOINT]",
    )
    .replace(/\[(?=[^\]\s]*:)[0-9a-z:.%_-]+\](?::\d{1,5})?(?:[/?#]\S*)?/gi, "[REDACTED_ENDPOINT]")
    .replace(
      /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5}|\s+port\s+\d{1,5})?(?:[/?#]\S*)?/gi,
      "[REDACTED_ENDPOINT]",
    );

  redacted = redactUnbracketedIpv6Endpoints(redacted);

  redacted = redacted
    .replace(
      /\b(?:localhost|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)\s+port\s+\d{1,5}\b(?:[/?#]\S*)?/gi,
      "[REDACTED_ENDPOINT]",
    )
    .replace(
      /\b(?:localhost|(?=[a-z0-9_-]*[a-z_-])[a-z0-9_-]+(?:\.[a-z0-9_-]+)*):\d{1,5}\b(?:[/?#]\S*)?/gi,
      "[REDACTED_ENDPOINT]",
    )
    .replace(
      /\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z](?:[a-z0-9-]{0,62})\b(?:[/?#]\S*)?/gi,
      "[REDACTED_HOST]",
    )
    .replace(/\blocalhost\b(?:[/?#]\S*)?/gi, "[REDACTED_HOST]")
    .replace(/([^\s"'<>?#]+)?[?#][^\s"'<>]*/g, (_match, prefix: string | undefined) =>
      prefix ? `${prefix} [REDACTED_QUERY]` : "[REDACTED_QUERY]",
    )
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|secret|session(?:[_-]?id)?|password|passwd|pwd)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;)}]+)(&)?/gi,
      (_match, querySeparator: string | undefined) =>
        querySeparator ? "[REDACTED_CREDENTIAL] " : "[REDACTED_CREDENTIAL]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_CREDENTIAL]");

  return redacted;
}

function appendChildLog(lines: Array<string>, label: string, chunk: Buffer | string): void {
  for (const line of redactDiagnostic(String(chunk)).split(/\r?\n/)) {
    if (line.trim()) lines.push(`${label}${line}`);
  }
  if (lines.length > 160) lines.splice(0, lines.length - 160);
}

function commandFailureMessage(
  executable: string,
  args: ReadonlyArray<string>,
  result: SpawnSyncReturns<string>,
): string {
  const details = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  return redactDiagnostic(
    [
      `${basename(executable)} ${args.join(" ")} failed with exit code ${String(result.status)}.`,
      details,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function runCheckedCommand(
  executable: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    env: options.env,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(commandFailureMessage(executable, args, result));
  }
  return result;
}

function assertPathWithin(parentPath: string, childPath: string): void {
  const normalizedParent = `${resolve(parentPath)}${sep}`;
  const normalizedChild = resolve(childPath);
  if (!normalizedChild.startsWith(normalizedParent)) {
    throw new Error(`Refusing to operate outside isolated work directory: ${normalizedChild}`);
  }
}

export function assertDmgApplicationsLink(isSymbolicLink: boolean, target: string | null): void {
  if (!isSymbolicLink) {
    throw new Error("Mounted DMG must contain a top-level Applications symbolic link.");
  }
  if (target !== "/Applications") {
    throw new Error(
      `Mounted DMG Applications link must point exactly to /Applications, received '${target ?? "missing"}'.`,
    );
  }
}

function verifyMountedDmgLayout(mountPath: string): void {
  const applicationsPath = join(mountPath, "Applications");
  const applicationsStat = lstatSync(applicationsPath);
  assertDmgApplicationsLink(
    applicationsStat.isSymbolicLink(),
    applicationsStat.isSymbolicLink() ? readlinkSync(applicationsPath) : null,
  );
}

function findMountedMossApp(mountPath: string): string {
  const appEntries = readdirSync(mountPath, { withFileTypes: true }).filter(
    (entry) => entry.name.endsWith(".app") && entry.isDirectory(),
  );
  if (appEntries.length !== 1 || appEntries[0]?.name !== APP_NAME) {
    throw new Error(
      `Expected exactly one top-level ${APP_NAME} in the mounted DMG, found: ${
        appEntries.map((entry) => entry.name).join(", ") || "none"
      }.`,
    );
  }
  const appPath = join(mountPath, appEntries[0].name);
  if (!statSync(appPath).isDirectory()) {
    throw new Error(`Mounted ${APP_NAME} is not an application directory.`);
  }
  const realMountPath = realpathSync.native(mountPath);
  const realAppPath = realpathSync.native(appPath);
  assertPathWithin(realMountPath, realAppPath);
  return realAppPath;
}

function detachDmg(mountPath: string, env: NodeJS.ProcessEnv, force: boolean): void {
  runCheckedCommand(SYSTEM_BINARIES.hdiutil, ["detach", ...(force ? ["-force"] : []), mountPath], {
    env,
  });
}

function copyAppBundle(
  sourceAppPath: string,
  installedAppPath: string,
  env: NodeJS.ProcessEnv,
): void {
  if (existsSync(installedAppPath)) {
    throw new Error(`Temporary installation destination already exists: ${installedAppPath}`);
  }
  runCheckedCommand(
    SYSTEM_BINARIES.ditto,
    ["--rsrc", "--extattr", sourceAppPath, installedAppPath],
    { env },
  );
  if (lstatSync(installedAppPath).isSymbolicLink() || !statSync(installedAppPath).isDirectory()) {
    throw new Error("Temporary Moss.app installation is not a real application directory.");
  }
}

function prepareInstalledApp(
  options: MacInstalledAppSmokeOptions,
  workDir: string,
  env: NodeJS.ProcessEnv,
): string {
  const installationRoot = join(workDir, "Installed Applications");
  const installedAppPath = join(installationRoot, APP_NAME);
  mkdirSync(installationRoot, { recursive: true });
  assertPathWithin(workDir, installedAppPath);

  if (options.appPath) {
    copyAppBundle(options.appPath, installedAppPath, env);
    return installedAppPath;
  }

  const mountPath = join(workDir, "Read Only DMG Mount");
  mkdirSync(mountPath, { recursive: true });
  let mounted = false;
  try {
    runCheckedCommand(
      SYSTEM_BINARIES.hdiutil,
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        mountPath,
        options.dmgPath!,
      ],
      { env },
    );
    mounted = true;
    verifyMountedDmgLayout(mountPath);
    copyAppBundle(findMountedMossApp(mountPath), installedAppPath, env);
    detachDmg(mountPath, env, false);
    mounted = false;
    return installedAppPath;
  } finally {
    if (mounted) {
      try {
        detachDmg(mountPath, env, true);
      } catch (error) {
        console.error(
          `[mac-installed-smoke] forced DMG detach failed: ${redactDiagnostic(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
    }
  }
}

function readBundlePlistValue(infoPlistPath: string, key: string, env: NodeJS.ProcessEnv): string {
  const result = runCheckedCommand(
    SYSTEM_BINARIES.plutil,
    ["-extract", key, "raw", "-o", "-", infoPlistPath],
    { env },
  );
  return result.stdout.trim();
}

function verifyBundleIdentity(
  installedAppPath: string,
  expectedVersion: string,
  env: NodeJS.ProcessEnv,
): void {
  const infoPlistPath = join(installedAppPath, "Contents", "Info.plist");
  if (!statSync(infoPlistPath).isFile()) {
    throw new Error(`Packaged app Info.plist is missing: ${infoPlistPath}`);
  }
  const bundleId = readBundlePlistValue(infoPlistPath, "CFBundleIdentifier", env);
  const bundleVersion = readBundlePlistValue(infoPlistPath, "CFBundleShortVersionString", env);
  if (bundleId !== MOSS_PRODUCTION_BUNDLE_ID) {
    throw new Error(
      `Unexpected packaged bundle ID '${bundleId}', expected '${MOSS_PRODUCTION_BUNDLE_ID}'.`,
    );
  }
  if (bundleVersion !== expectedVersion) {
    throw new Error(
      `Unexpected packaged app version '${bundleVersion}', expected '${expectedVersion}'.`,
    );
  }
}

export function assertPublishCodesignDetails(
  details: string,
  expectedTeamId: string,
  expectedDeveloperIdentity: string,
  artifactLabel = "artifact",
): void {
  if (/^Signature=adhoc$/m.test(details)) {
    throw new Error(`Publish acceptance refuses an ad-hoc ${artifactLabel} signature.`);
  }
  const expectedAuthority = `Authority=${expectedDeveloperIdentity}`;
  if (!details.split(/\r?\n/).includes(expectedAuthority)) {
    throw new Error(
      `Publish acceptance requires ${artifactLabel} Authority to exactly match '${expectedDeveloperIdentity}'.`,
    );
  }
  const teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (teamIdentifier !== expectedTeamId) {
    throw new Error(
      `Publish acceptance requires ${artifactLabel} TeamIdentifier '${expectedTeamId}', received '${teamIdentifier ?? "missing"}'.`,
    );
  }
  if (!/^Timestamp=.+$/m.test(details)) {
    throw new Error(`Publish acceptance requires a trusted ${artifactLabel} signing timestamp.`);
  }
}

export function resolveDmgCodeSigningMode(
  displayExitCode: number | null,
  displayOutput: string,
  publish: boolean,
): "unsigned-internal" | "verify" {
  if (displayExitCode === 0) return "verify";
  if (isExplicitlyUnsignedCodesignDisplay(displayExitCode, displayOutput)) {
    if (publish) throw new Error("Publish acceptance requires a signed DMG container.");
    return "unsigned-internal";
  }
  throw new Error("Could not determine the DMG container signing state safely.");
}

function isExplicitlyUnsignedCodesignDisplay(
  displayExitCode: number | null,
  displayOutput: string,
): boolean {
  if (displayExitCode !== 1) return false;
  const diagnosticLines = displayOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    diagnosticLines.length === 1 &&
    /(?:^|: )code object is not signed at all$/.test(diagnosticLines[0]!)
  );
}

function hasBundleCodeSigningArtifacts(installedAppPath: string): boolean {
  return [
    join(installedAppPath, "Contents", "_CodeSignature"),
    join(installedAppPath, "Contents", "CodeResources"),
  ].some((artifactPath) => lstatSync(artifactPath, { throwIfNoEntry: false }) !== undefined);
}

export function resolveCodeSigningMode(
  installedAppPath: string,
  displayExitCode: number | null,
  displayOutput: string,
  publish: boolean,
): "unsigned-internal" | "verify" {
  if (displayExitCode === 0) return "verify";
  if (isExplicitlyUnsignedCodesignDisplay(displayExitCode, displayOutput)) {
    if (hasBundleCodeSigningArtifacts(installedAppPath)) {
      throw new Error(
        "Application bundle contains residual code-signing artifacts but codesign reports no readable signature.",
      );
    }
    if (publish) {
      throw new Error("Publish acceptance requires a signed application bundle.");
    }
    return "unsigned-internal";
  }
  throw new Error("Could not determine the application bundle signing state safely.");
}

function verifyAppCodeSigning(
  installedAppPath: string,
  options: MacInstalledAppSmokeOptions,
  env: NodeJS.ProcessEnv,
): "unsigned-internal" | "verified" {
  const displayResult = spawnSync(
    SYSTEM_BINARIES.codesign,
    ["--display", "--verbose=4", installedAppPath],
    {
      encoding: "utf8",
      env,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    },
  );
  if (displayResult.error) throw displayResult.error;
  const details = `${displayResult.stdout}\n${displayResult.stderr}`;
  const signingMode = resolveCodeSigningMode(
    installedAppPath,
    displayResult.status,
    details,
    options.publish,
  );
  if (signingMode === "unsigned-internal") return signingMode;

  runCheckedCommand(
    SYSTEM_BINARIES.codesign,
    ["--verify", "--deep", "--strict", "--verbose=4", installedAppPath],
    { env },
  );
  if (!options.publish) return "verified";

  assertPublishCodesignDetails(
    details,
    options.expectedAppleTeamId!,
    options.expectedAppleDeveloperIdentity!,
    "application",
  );
  const gatekeeperResult = runCheckedCommand(
    SYSTEM_BINARIES.spctl,
    ["--assess", "--type", "execute", "--verbose=4", installedAppPath],
    { env },
  );
  const gatekeeperDetails = `${gatekeeperResult.stdout}\n${gatekeeperResult.stderr}`;
  if (!/source=Notarized Developer ID/i.test(gatekeeperDetails)) {
    throw new Error(
      `Gatekeeper did not classify the app as a Notarized Developer ID build: ${redactDiagnostic(
        gatekeeperDetails.trim(),
      )}`,
    );
  }
  runCheckedCommand(SYSTEM_BINARIES.stapler, ["stapler", "validate", installedAppPath], { env });
  return "verified";
}

function verifyDmgCodeSigning(
  dmgPath: string,
  options: MacInstalledAppSmokeOptions,
  env: NodeJS.ProcessEnv,
): "unsigned-internal" | "verified" {
  const displayResult = spawnSync(SYSTEM_BINARIES.codesign, ["--display", "--verbose=4", dmgPath], {
    encoding: "utf8",
    env,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  if (displayResult.error) throw displayResult.error;
  const details = `${displayResult.stdout}\n${displayResult.stderr}`;
  const signingMode = resolveDmgCodeSigningMode(displayResult.status, details, options.publish);
  if (signingMode === "unsigned-internal") return signingMode;

  runCheckedCommand(SYSTEM_BINARIES.codesign, ["--verify", "--strict", "--verbose=4", dmgPath], {
    env,
  });
  if (!options.publish) return "verified";

  assertPublishCodesignDetails(
    details,
    options.expectedAppleTeamId!,
    options.expectedAppleDeveloperIdentity!,
    "DMG container",
  );
  const gatekeeperResult = runCheckedCommand(
    SYSTEM_BINARIES.spctl,
    ["-a", "-t", "open", "--context", "context:primary-signature", "-v", dmgPath],
    { env },
  );
  const gatekeeperDetails = `${gatekeeperResult.stdout}\n${gatekeeperResult.stderr}`;
  if (!/source=Notarized Developer ID/i.test(gatekeeperDetails)) {
    throw new Error(
      `Gatekeeper did not classify the DMG as a Notarized Developer ID container: ${redactDiagnostic(
        gatekeeperDetails.trim(),
      )}`,
    );
  }
  runCheckedCommand(SYSTEM_BINARIES.stapler, ["stapler", "validate", dmgPath], {
    env,
  });
  return "verified";
}

export function createIsolatedMacSmokeEnvironment(
  workDir: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const homePath = join(workDir, "Home");
  const mossHomePath = join(workDir, "Moss Home");
  const userDataPath = join(workDir, "Electron User Data");
  const tempPath = join(workDir, "Temporary Files");
  const codexHomePath = join(workDir, "Codex Home");
  const xdgConfigPath = join(workDir, "XDG Config");
  const xdgCachePath = join(workDir, "XDG Cache");
  for (const directory of [
    homePath,
    mossHomePath,
    userDataPath,
    tempPath,
    codexHomePath,
    xdgConfigPath,
    xdgCachePath,
  ]) {
    assertPathWithin(workDir, directory);
    mkdirSync(directory, { recursive: true });
  }

  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: sourceEnvironment.LANG ?? "en_US.UTF-8",
    LC_ALL: sourceEnvironment.LC_ALL ?? "en_US.UTF-8",
    SHELL: "/bin/zsh",
    HOME: homePath,
    TMPDIR: `${tempPath}${sep}`,
    MOSS_HOME: mossHomePath,
    DPCODE_HOME: mossHomePath,
    T3CODE_HOME: mossHomePath,
    CODEX_HOME: codexHomePath,
    MOSS_DESKTOP_USER_DATA_DIR: userDataPath,
    XDG_CONFIG_HOME: xdgConfigPath,
    XDG_CACHE_HOME: xdgCachePath,
    T3CODE_DISABLE_AUTO_UPDATE: "1",
    MOSS_DISABLE_AUTO_UPDATE: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback CDP port.");
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

function isProcessRunning(child: MainWindowProcessState): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForMainCdpTarget(
  port: number,
  child: MainWindowProcessState,
  deadlineMs: number,
): Promise<CdpTarget> {
  let lastError: unknown;
  while (deadlineMs - Date.now() > 0) {
    if (!isProcessRunning(child)) {
      throw new Error(
        `Packaged Moss exited before its main window opened (code=${String(child.exitCode)}, signal=${String(child.signalCode)}).`,
      );
    }
    try {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(1_500, remainingMs)),
      });
      if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}.`);
      const targets = (await response.json()) as Array<CdpTarget>;
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url?.startsWith("moss://app/") &&
          candidate.webSocketDebuggerUrl,
      );
      if (target) {
        if (!isProcessRunning(child)) {
          throw new Error(
            `Packaged Moss exited before its main window opened (code=${String(child.exitCode)}, signal=${String(child.signalCode)}).`,
          );
        }
        if (deadlineMs - Date.now() <= 0) break;
        return target;
      }
      lastError = new Error(describeMissingMainCdpTarget(targets));
    } catch (error) {
      lastError = error;
    }
    const sleepMs = Math.min(MAIN_WINDOW_POLL_INTERVAL_MS, deadlineMs - Date.now());
    if (sleepMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, sleepMs));
    }
  }
  throw new Error(
    `Timed out waiting for packaged Moss main window: ${redactDiagnostic(
      lastError instanceof Error ? lastError.message : String(lastError),
    )}`,
  );
}

function assertLoopbackUrl(url: URL, expectedProtocols: ReadonlySet<string>, label: string): void {
  if (!expectedProtocols.has(url.protocol)) {
    throw new Error(`${label} used unexpected protocol '${url.protocol}'.`);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1") {
    throw new Error(`${label} must stay on loopback, received host '${url.hostname}'.`);
  }
  if (!url.port) throw new Error(`${label} must include an explicit loopback port.`);
}

async function evaluateCdpTarget(
  webSocketDebuggerUrl: string,
  expression: string,
  timeoutMs: number,
): Promise<unknown> {
  const debuggerUrl = new URL(webSocketDebuggerUrl);
  assertLoopbackUrl(debuggerUrl, new Set(["ws:", "wss:"]), "CDP websocket");

  return await new Promise((resolveEvaluation, rejectEvaluation) => {
    const socket = new WebSocket(debuggerUrl);
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) rejectEvaluation(error);
      else resolveEvaluation(value);
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out evaluating the packaged Moss main window through CDP.")),
      Math.min(timeoutMs, 15_000),
    );

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            expression,
            returnByValue: true,
          },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          error?: { message?: string };
          result?: {
            exceptionDetails?: { text?: string };
            result?: { value?: unknown };
          };
        };
        if (message.id !== 1) return;
        if (message.error) {
          finish(new Error(`CDP Runtime.evaluate failed: ${message.error.message ?? "unknown"}`));
          return;
        }
        if (message.result?.exceptionDetails) {
          finish(
            new Error(
              `Packaged main-window evaluation failed: ${message.result.exceptionDetails.text ?? "unknown"}`,
            ),
          );
          return;
        }
        finish(undefined, message.result?.result?.value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () =>
      finish(new Error("Packaged Moss CDP websocket failed.")),
    );
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("Packaged Moss CDP websocket closed before evaluation."));
    });
  });
}

function isMainWindowEvidence(value: unknown): value is MainWindowEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Record<string, unknown>;
  return (
    typeof evidence.desktopWsUrl === "string" &&
    typeof evidence.hasBody === "boolean" &&
    typeof evidence.hasDesktopBridge === "boolean" &&
    typeof evidence.hasDesktopBridgeGetWsUrl === "boolean" &&
    typeof evidence.locationHref === "string" &&
    typeof evidence.readyState === "string"
  );
}

function toSafeReadyState(value: unknown): SafeReadyState {
  return value === "loading" || value === "interactive" || value === "complete" ? value : "other";
}

function toSafeMainWindowEvidence(value: MainWindowEvidence): SafeMainWindowEvidence {
  return {
    hasBody: value.hasBody,
    hasDesktopBridge: value.hasDesktopBridge,
    hasDesktopBridgeGetWsUrl: value.hasDesktopBridgeGetWsUrl,
    locationIsExpected: value.locationHref.startsWith("moss://app/"),
    readyState: toSafeReadyState(value.readyState),
  };
}

async function readMainWindowEvidenceSnapshot(
  target: CdpTarget,
  timeoutMs: number,
  evaluate: typeof evaluateCdpTarget = evaluateCdpTarget,
): Promise<MainWindowEvidence> {
  if (!target.webSocketDebuggerUrl) {
    throw new Error("Packaged Moss main window target did not expose a CDP websocket URL.");
  }
  const evidence = await evaluate(
    target.webSocketDebuggerUrl,
    `(() => {
      const bridge = globalThis.desktopBridge;
      return {
        desktopWsUrl: typeof bridge?.getWsUrl === "function" ? bridge.getWsUrl() : "",
        hasBody: Boolean(document.body),
        hasDesktopBridge: Boolean(bridge),
        hasDesktopBridgeGetWsUrl: typeof bridge?.getWsUrl === "function",
        locationHref: location.href,
        readyState: document.readyState,
      };
    })()`,
    timeoutMs,
  );
  if (!isMainWindowEvidence(evidence)) {
    throw new FatalMainWindowEvidenceError(
      "Packaged Moss main window returned incomplete CDP evidence.",
    );
  }
  return evidence;
}

function describeMainWindowEvidence(evidence: unknown): string {
  if (!isMainWindowEvidence(evidence)) {
    if (!evidence || typeof evidence !== "object") {
      return `invalid evidence type=${evidence === null ? "null" : typeof evidence}`;
    }
    return `incomplete evidence keys=${Object.keys(evidence).toSorted().join(",") || "none"}`;
  }
  const readyState =
    evidence.readyState === "loading" ||
    evidence.readyState === "interactive" ||
    evidence.readyState === "complete"
      ? evidence.readyState
      : "other";
  return [
    `readyState=${readyState}`,
    `hasBody=${String(evidence.hasBody)}`,
    `hasDesktopBridge=${String(evidence.hasDesktopBridge)}`,
    `hasDesktopBridgeGetWsUrl=${String(evidence.hasDesktopBridgeGetWsUrl)}`,
    `hasDesktopWsUrl=${String(Boolean(evidence.desktopWsUrl.trim()))}`,
    `hasExpectedLocation=${String(evidence.locationHref.startsWith("moss://app/"))}`,
  ].join(", ");
}

function requireReadyMainWindowEvidence(evidence: unknown): MainWindowEvidence {
  if (!isMainWindowEvidence(evidence)) {
    throw new FatalMainWindowEvidenceError(
      "Packaged Moss main window returned incomplete CDP evidence.",
    );
  }
  if (!evidence.locationHref.startsWith("moss://app/")) {
    throw new FatalMainWindowEvidenceError(
      "Unexpected packaged main-window URL; expected moss://app/.",
    );
  }
  if (
    !evidence.hasBody ||
    !evidence.hasDesktopBridge ||
    !evidence.hasDesktopBridgeGetWsUrl ||
    !evidence.desktopWsUrl.trim()
  ) {
    throw new Error(
      `Packaged Moss main window is not ready (${describeMainWindowEvidence(evidence)}).`,
    );
  }
  if (evidence.readyState !== "interactive" && evidence.readyState !== "complete") {
    throw new Error(
      `Packaged Moss main window is not ready (${describeMainWindowEvidence(evidence)}).`,
    );
  }
  return evidence;
}

type ReadinessAttempt =
  | { readonly kind: "evidence"; readonly evidence: unknown }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "exit"; readonly exit: ProcessExit };

function isIpv6AddressCharacter(character: string): boolean {
  return /^[0-9a-f:.]$/i.test(character);
}

function isIpv6ZoneCharacter(character: string): boolean {
  return /^[0-9a-z_.-]$/i.test(character);
}

function isUnbracketedIpv6Endpoint(candidate: string): boolean {
  if (isIP(candidate) === 6) {
    return true;
  }

  const portSeparator = candidate.lastIndexOf(":");
  if (portSeparator <= 0) {
    return false;
  }

  const possiblePort = candidate.slice(portSeparator + 1);
  if (!/^\d{1,5}$/.test(possiblePort) || Number(possiblePort) > 65_535) {
    return false;
  }

  return isIP(candidate.slice(0, portSeparator)) === 6;
}

function redactUnbracketedIpv6Endpoints(value: string): string {
  let cursor = 0;
  let copyStart = 0;
  let redacted = "";

  while (cursor < value.length) {
    const previousCharacter = value.charAt(cursor - 1);
    const character = value.charAt(cursor);
    const canStartCandidate =
      (character === ":" || /^[0-9a-f]$/i.test(character)) &&
      (cursor === 0 || !isIpv6ZoneCharacter(previousCharacter));

    if (!canStartCandidate) {
      cursor += 1;
      continue;
    }

    const candidateStart = cursor;
    while (cursor < value.length && isIpv6AddressCharacter(value.charAt(cursor))) {
      cursor += 1;
    }
    if (value.charAt(cursor) === "%") {
      cursor += 1;
      while (cursor < value.length && isIpv6ZoneCharacter(value.charAt(cursor))) {
        cursor += 1;
      }
      if (value.charAt(cursor) === ":") {
        let portEnd = cursor + 1;
        while (portEnd < value.length && /^\d$/.test(value.charAt(portEnd))) {
          portEnd += 1;
        }
        if (portEnd > cursor + 1) {
          cursor = portEnd;
        }
      }
    }

    const candidate = value.slice(candidateStart, cursor);
    let replacement: string | undefined;
    if (isUnbracketedIpv6Endpoint(candidate)) {
      replacement = "[REDACTED_ENDPOINT]";
    } else if (candidate.endsWith(":") && isUnbracketedIpv6Endpoint(candidate.slice(0, -1))) {
      replacement = "[REDACTED_ENDPOINT]:";
    }

    if (replacement !== undefined) {
      redacted += value.slice(copyStart, candidateStart) + replacement;
      copyStart = cursor;
    }
  }

  return redacted + value.slice(copyStart);
}

function readinessDiagnostics(
  hasLastEvidence: boolean,
  lastEvidence: unknown,
  lastError: unknown,
): string {
  const details: Array<string> = [];
  if (hasLastEvidence) {
    details.push(`last evidence: ${describeMainWindowEvidence(lastEvidence)}`);
  }
  if (lastError !== undefined) {
    details.push(
      `last error: ${redactDiagnostic(
        lastError instanceof Error ? lastError.message : String(lastError),
      ).replace(/\.+$/u, "")}`,
    );
  }
  return details.length > 0 ? `; ${details.join("; ")}` : "";
}

function exitedBeforeMainWindowReadyError(
  exit: ProcessExit,
  hasLastEvidence: boolean,
  lastEvidence: unknown,
  lastError: unknown,
): Error {
  const diagnostics = readinessDiagnostics(hasLastEvidence, lastEvidence, lastError).replace(
    /^; /u,
    " ",
  );
  return new Error(
    `Packaged Moss exited before its main window became ready (code=${String(exit.code)}, signal=${String(exit.signal)}).${diagnostics}`,
  );
}

async function runReadinessAttempt(
  probe: Promise<unknown>,
  exitPromise?: Promise<ProcessExit>,
): Promise<ReadinessAttempt> {
  const probeAttempt = probe.then<ReadinessAttempt, ReadinessAttempt>(
    (evidence) => ({ evidence, kind: "evidence" }),
    (error: unknown) => ({ error, kind: "error" }),
  );
  if (!exitPromise) return await probeAttempt;
  return await Promise.race([
    probeAttempt,
    exitPromise.then<ReadinessAttempt>((exit) => ({ exit, kind: "exit" })),
  ]);
}

async function sleepUntilNextReadinessAttempt(
  milliseconds: number,
  sleep: (milliseconds: number) => Promise<void>,
  exitPromise?: Promise<ProcessExit>,
): Promise<ProcessExit | undefined> {
  const sleeping = sleep(milliseconds).then(() => undefined);
  if (!exitPromise) return await sleeping;
  return await Promise.race([sleeping, exitPromise]);
}

async function waitForReadyMainWindowEvidenceFromProbe(
  probe: (remainingMs: number) => Promise<unknown>,
  child: MainWindowProcessState,
  deadlineMs: number,
  controls: MainWindowReadinessControls = {},
): Promise<MainWindowEvidence> {
  if (!Number.isFinite(deadlineMs)) {
    throw new Error("Main-window readiness deadline must be finite.");
  }

  const now = controls.now ?? Date.now;
  const sleep =
    controls.sleep ??
    (async (milliseconds: number) => {
      await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
    });
  let hasLastEvidence = false;
  let lastEvidence: unknown;
  let lastError: unknown;

  while (true) {
    if (!isProcessRunning(child)) {
      throw exitedBeforeMainWindowReadyError(
        { code: child.exitCode, signal: child.signalCode },
        hasLastEvidence,
        lastEvidence,
        lastError,
      );
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out waiting for packaged Moss main window readiness${readinessDiagnostics(hasLastEvidence, lastEvidence, lastError)}.`,
      );
    }

    const attempt = await runReadinessAttempt(
      Promise.resolve().then(() => probe(remainingMs)),
      controls.exitPromise,
    );
    if (attempt.kind === "exit") {
      throw exitedBeforeMainWindowReadyError(
        attempt.exit,
        hasLastEvidence,
        lastEvidence,
        lastError,
      );
    }
    if (attempt.kind === "error") {
      lastError = attempt.error;
    } else {
      hasLastEvidence = true;
      lastEvidence = attempt.evidence;
      try {
        const readyEvidence = requireReadyMainWindowEvidence(attempt.evidence);
        if (deadlineMs - now() <= 0) {
          throw new Error("Packaged Moss main-window evaluation exceeded its deadline.");
        }
        if (!isProcessRunning(child)) {
          throw exitedBeforeMainWindowReadyError(
            { code: child.exitCode, signal: child.signalCode },
            hasLastEvidence,
            lastEvidence,
            lastError,
          );
        }
        return readyEvidence;
      } catch (error) {
        lastError = error;
        if (error instanceof FatalMainWindowEvidenceError) throw error;
      }
    }

    if (!isProcessRunning(child)) {
      throw exitedBeforeMainWindowReadyError(
        { code: child.exitCode, signal: child.signalCode },
        hasLastEvidence,
        lastEvidence,
        lastError,
      );
    }
    const remainingAfterAttemptMs = deadlineMs - now();
    if (remainingAfterAttemptMs <= 0) continue;
    const exit = await sleepUntilNextReadinessAttempt(
      Math.min(MAIN_WINDOW_POLL_INTERVAL_MS, remainingAfterAttemptMs),
      sleep,
      controls.exitPromise,
    );
    if (exit) {
      throw exitedBeforeMainWindowReadyError(exit, hasLastEvidence, lastEvidence, lastError);
    }
  }
}

export async function waitForReadyMainWindowEvidence(
  probe: (remainingMs: number) => Promise<unknown>,
  child: MainWindowProcessState,
  timeoutMs: number,
  controls?: MainWindowReadinessControls,
): Promise<MainWindowEvidence>;
export async function waitForReadyMainWindowEvidence(
  target: CdpTarget,
  child: MainWindowProcessState,
  deadlineMs: number,
  state?: Pick<SmokeState, "mainWindowEvidence">,
  options?: MainWindowEvidenceWaitOptions,
): Promise<MainWindowEvidence>;
export async function waitForReadyMainWindowEvidence(
  targetOrProbe: CdpTarget | ((remainingMs: number) => Promise<unknown>),
  child: MainWindowProcessState,
  timeoutOrDeadlineMs: number,
  stateOrControls?: Pick<SmokeState, "mainWindowEvidence"> | MainWindowReadinessControls,
  options: MainWindowEvidenceWaitOptions = {},
): Promise<MainWindowEvidence> {
  if (typeof targetOrProbe === "function") {
    if (!Number.isFinite(timeoutOrDeadlineMs) || timeoutOrDeadlineMs <= 0) {
      throw new Error("Main-window readiness timeout must be a positive finite number.");
    }
    const controls = (stateOrControls ?? {}) as MainWindowReadinessControls;
    const now = controls.now ?? Date.now;
    const deadlineMs = now() + timeoutOrDeadlineMs;
    return await waitForReadyMainWindowEvidenceFromProbe(
      targetOrProbe,
      child,
      deadlineMs,
      controls,
    );
  }

  const now = options.now ?? Date.now;
  const state = stateOrControls as Pick<SmokeState, "mainWindowEvidence"> | undefined;
  return await waitForReadyMainWindowEvidenceFromProbe(
    async (remainingMs) => {
      const evidence = await readMainWindowEvidenceSnapshot(
        targetOrProbe,
        Math.min(MAIN_WINDOW_EVALUATION_TIMEOUT_MS, remainingMs),
        options.evaluate,
      );
      if (state) {
        state.mainWindowEvidence = toSafeMainWindowEvidence(evidence);
      }
      return evidence;
    },
    child,
    timeoutOrDeadlineMs,
    {
      now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    },
  );
}

export async function waitForMainWindowEvidence(
  port: number,
  child: MainWindowProcessState,
  timeoutMs: number,
  state?: Pick<SmokeState, "mainWindowEvidence">,
  options: MainWindowWaitOptions = {},
): Promise<MainWindowEvidence> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Main-window readiness timeout must be a positive finite number.");
  }
  const now = options.now ?? Date.now;
  const deadlineMs = now() + timeoutMs;
  const waitForTarget = options.waitForTarget ?? waitForMainCdpTarget;
  return await waitForReadyMainWindowEvidenceFromProbe(
    async (remainingMs) => {
      const target = await waitForTarget(port, child, deadlineMs);
      const evaluationTimeoutMs = Math.min(
        MAIN_WINDOW_EVALUATION_TIMEOUT_MS,
        remainingMs,
        deadlineMs - now(),
      );
      if (evaluationTimeoutMs <= 0) {
        throw new Error("CDP target discovery exhausted the main-window readiness timeout.");
      }
      const evidence = await readMainWindowEvidenceSnapshot(
        target,
        evaluationTimeoutMs,
        options.evaluate,
      );
      if (state) {
        state.mainWindowEvidence = toSafeMainWindowEvidence(evidence);
      }
      return evidence;
    },
    child,
    deadlineMs,
    {
      now,
      ...(options.exitPromise === undefined ? {} : { exitPromise: options.exitPromise }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    },
  );
}

export function healthUrlFromDesktopWsUrl(desktopWsUrl: string): string {
  const url = new URL(desktopWsUrl);
  assertLoopbackUrl(url, new Set(["ws:", "wss:"]), "desktop backend websocket");
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForBackendHealth(desktopWsUrl: string, timeoutMs: number): Promise<string> {
  const healthUrl = healthUrlFromDesktopWsUrl(desktopWsUrl);
  const deadline = Date.now() + Math.min(timeoutMs, 45_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return healthUrl;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `Timed out waiting for loopback backend health at ${healthUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function createExitPromise(child: ChildProcess, state: SmokeState): Promise<ProcessExit> {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      const result = { code, signal };
      state.childExit = result;
      resolveExit(result);
    });
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface OwnedProcessTree {
  readonly descendants: ReadonlyArray<CapturedProcess>;
}

function parseProcessChildrenMap(psOutput: string): Map<number, Array<CapturedProcess>> {
  const childrenByParentPid = new Map<number, Array<CapturedProcess>>();
  for (const line of psOutput.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw, ...commandParts] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const command = commandParts.join(" ").trim();
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || command.length === 0) continue;
    const siblings = childrenByParentPid.get(ppid) ?? [];
    siblings.push({ pid, command });
    childrenByParentPid.set(ppid, siblings);
  }
  return childrenByParentPid;
}

function parseProcessCommandMap(psOutput: string): ReadonlyMap<number, string> {
  const commandsByPid = new Map<number, string>();
  for (const line of psOutput.split(/\r?\n/g)) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]?.trim() ?? "";
    if (!Number.isInteger(pid) || command.length === 0) continue;
    commandsByPid.set(pid, command);
  }
  return commandsByPid;
}

function collectDescendantProcesses(
  rootPid: number,
  childrenByParentPid: ReadonlyMap<number, ReadonlyArray<CapturedProcess>>,
): ReadonlyArray<CapturedProcess> {
  const descendants: Array<CapturedProcess> = [];
  const stack = [...(childrenByParentPid.get(rootPid) ?? [])].reverse();
  const visited = new Set<number>([rootPid]);

  while (stack.length > 0) {
    const child = stack.pop();
    if (!child || visited.has(child.pid)) continue;
    visited.add(child.pid);
    descendants.push(child);
    const nestedChildren = childrenByParentPid.get(child.pid) ?? [];
    for (const nestedChild of [...nestedChildren].reverse()) {
      stack.push(nestedChild);
    }
  }
  return descendants;
}

function captureOwnedProcessTree(rootPid: number): OwnedProcessTree | null {
  try {
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      timeout: PROCESS_TABLE_SCAN_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return null;
    return {
      descendants: collectDescendantProcesses(rootPid, parseProcessChildrenMap(result.stdout)),
    };
  } catch {
    return null;
  }
}

function readCurrentProcessCommands(
  pids: ReadonlyArray<number>,
): ReadonlyMap<number, string> | null {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (uniquePids.length === 0) return new Map();
  try {
    const result = spawnSync("ps", ["-p", uniquePids.join(","), "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      timeout: PROCESS_TABLE_SCAN_TIMEOUT_MS,
    });
    if (result.error) return null;
    if (result.status !== 0) {
      // BSD ps returns 1 with no output when none of the captured PIDs still
      // exist. Any diagnostic output or different status is an inspection
      // failure and must not be mistaken for proven descendant cleanup.
      return result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === ""
        ? new Map()
        : null;
    }
    return parseProcessCommandMap(result.stdout);
  } catch {
    return null;
  }
}

export function findOwnedProcessSurvivors(
  captured: ReadonlyArray<CapturedProcess>,
  currentCommands: ReadonlyMap<number, string>,
): ReadonlyArray<CapturedProcess> {
  return captured.filter(
    (descendant) => currentCommands.get(descendant.pid) === descendant.command,
  );
}

function currentOwnedDescendants(tree: OwnedProcessTree): ReadonlyArray<CapturedProcess> | null {
  const commands = readCurrentProcessCommands(tree.descendants.map((descendant) => descendant.pid));
  if (commands === null) return null;
  return findOwnedProcessSurvivors(tree.descendants, commands);
}

async function waitForOwnedDescendantsExit(
  tree: OwnedProcessTree,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let survivors: ReadonlyArray<CapturedProcess> | null = null;
  while (Date.now() < deadline) {
    survivors = currentOwnedDescendants(tree);
    if (survivors === null) {
      throw new Error("Could not verify packaged Moss provider descendant cleanup.");
    }
    if (survivors.length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Packaged Moss retained ${String(survivors?.length ?? 0)} owned provider descendant(s) after graceful exit.`,
  );
}

async function requestGracefulExit(
  child: ChildProcess,
  exitPromise: Promise<ProcessExit>,
  state: SmokeState,
): Promise<ProcessExit> {
  if (!isProcessRunning(child)) {
    throw new Error("Packaged Moss exited before the graceful shutdown check.");
  }
  const pid = child.pid;
  if (!pid) throw new Error("Packaged Moss process did not expose a PID.");
  const ownedProcessTree = captureOwnedProcessTree(pid);
  if (!ownedProcessTree) {
    throw new Error("Could not capture packaged Moss provider descendants before SIGTERM.");
  }
  state.ownedDescendants = ownedProcessTree.descendants;
  if (!child.kill("SIGTERM")) {
    throw new Error("Could not deliver SIGTERM to packaged Moss.");
  }
  const result = await withTimeout(
    exitPromise,
    GRACEFUL_EXIT_TIMEOUT_MS,
    "Packaged Moss did not complete its graceful SIGTERM shutdown in time.",
  );
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `Packaged Moss did not exit cleanly (code=${String(result.code)}, signal=${String(result.signal)}).`,
    );
  }
  await waitForOwnedDescendantsExit(ownedProcessTree, PROCESS_TREE_EXIT_TIMEOUT_MS);
  return result;
}

function signalOwnedDescendants(tree: OwnedProcessTree, signal: NodeJS.Signals): void {
  const survivors = currentOwnedDescendants(tree);
  if (survivors === null) return;
  for (const descendant of [...survivors].toReversed()) {
    try {
      process.kill(descendant.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        // Cleanup is best effort, but never broadens a signal to an unverified
        // PID or process group.
      }
    }
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isProcessRunning(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function forceStopProcessTree(
  child: ChildProcess | undefined,
  capturedDescendants: ReadonlyArray<CapturedProcess> = [],
): Promise<void> {
  if (!child || !child.pid) return;
  const pid = child.pid;
  const ownedProcessTree: OwnedProcessTree = {
    descendants:
      capturedDescendants.length > 0
        ? capturedDescendants
        : (captureOwnedProcessTree(pid)?.descendants ?? []),
  };
  if (isProcessRunning(child)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The exact ChildProcess handle is already the ownership boundary.
    }
  }
  signalOwnedDescendants(ownedProcessTree, "SIGTERM");
  await waitForChildExit(child, 5_000);
  if (isProcessRunning(child)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The exact ChildProcess handle may have exited between checks.
    }
  }
  signalOwnedDescendants(ownedProcessTree, "SIGKILL");
  try {
    await waitForOwnedDescendantsExit(ownedProcessTree, 2_000);
  } catch {
    // Preserve the original smoke failure while keeping cleanup identity-safe.
  }
}

export function writeDiagnostic(
  options: MacInstalledAppSmokeOptions,
  state: SmokeState,
  status: "passed" | "failed",
  error?: unknown,
): void {
  if (!options.reportPath) return;
  mkdirSync(dirname(options.reportPath), { recursive: true });
  const inputPath = options.dmgPath ?? options.appPath!;
  const mainWindowEvidence = state.mainWindowEvidence
    ? {
        hasBody: state.mainWindowEvidence.hasBody === true,
        hasDesktopBridge: state.mainWindowEvidence.hasDesktopBridge === true,
        hasDesktopBridgeGetWsUrl: state.mainWindowEvidence.hasDesktopBridgeGetWsUrl === true,
        locationIsExpected: state.mainWindowEvidence.locationIsExpected === true,
        readyState: toSafeReadyState(state.mainWindowEvidence.readyState),
      }
    : null;
  const payload = {
    schemaVersion: 1,
    status,
    stage: redactDiagnostic(state.stage),
    publish: options.publish,
    inputArtifact: redactDiagnostic(basename(inputPath)),
    expectedBundleId: MOSS_PRODUCTION_BUNDLE_ID,
    expectedVersion: redactDiagnostic(options.expectedVersion),
    appPid: state.appPid ?? null,
    childExit: state.childExit ?? null,
    error: error ? redactDiagnostic(error instanceof Error ? error.message : String(error)) : null,
    mainWindowEvidence,
    capturedChildLogLineCount: state.childLogs.length,
  };
  writeFileSync(options.reportPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function formatMacInstalledAppFailure(error: unknown): string {
  return `[mac-installed-smoke] FAIL ${redactDiagnostic(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  )}`;
}

function logPass(label: string): void {
  console.log(redactDiagnostic(`PASS ${label}`));
}

async function runMacInstalledAppSmoke(options: MacInstalledAppSmokeOptions): Promise<void> {
  const state: SmokeState = { childLogs: [], stage: "create-isolated-workdir" };
  const workDir = mkdtempSync(join(realpathSync.native(tmpdir()), "Moss Installed App Smoke "));
  state.workDir = workDir;
  const isolatedEnvironment = createIsolatedMacSmokeEnvironment(workDir);
  let child: ChildProcess | undefined;
  try {
    if (options.dmgPath) {
      state.stage = "dmg-container-codesign";
      const dmgSigningResult = verifyDmgCodeSigning(options.dmgPath, options, isolatedEnvironment);
      logPass(
        dmgSigningResult === "verified"
          ? "dmg-container-codesign-strict"
          : "unsigned-internal-dmg-container-explicitly-detected",
      );
      if (options.publish) {
        logPass("dmg-container-pinned-developer-id-gatekeeper-and-stapled-notarization");
      }
    }

    state.stage = "mount-and-copy";
    const installedAppPath = prepareInstalledApp(options, workDir, isolatedEnvironment);
    state.installedAppPath = installedAppPath;
    logPass(options.dmgPath ? "dmg-mounted-readonly-and-app-copied" : "artifact-app-copied");

    state.stage = "bundle-identity";
    verifyBundleIdentity(installedAppPath, options.expectedVersion, isolatedEnvironment);
    logPass("bundle-id-and-version");

    state.stage = "codesign";
    const signingResult = verifyAppCodeSigning(installedAppPath, options, isolatedEnvironment);
    logPass(
      signingResult === "verified"
        ? "codesign-deep-strict"
        : "unsigned-internal-build-explicitly-detected",
    );
    if (options.publish) logPass("developer-id-gatekeeper-and-stapled-notarization");

    const executablePath = join(installedAppPath, "Contents", "MacOS", "Moss");
    if (!statSync(executablePath).isFile()) {
      throw new Error(`Packaged Moss executable is missing: ${executablePath}`);
    }
    const cdpPort = await reserveLoopbackPort();
    state.stage = "launch-packaged-app";
    const launchedChild = spawn(
      executablePath,
      [
        `--user-data-dir=${isolatedEnvironment.MOSS_DESKTOP_USER_DATA_DIR}`,
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${cdpPort}`,
      ],
      {
        cwd: dirname(executablePath),
        detached: true,
        env: isolatedEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child = launchedChild;
    if (launchedChild.pid) state.appPid = launchedChild.pid;
    launchedChild.stdout?.on("data", (chunk) =>
      appendChildLog(state.childLogs, "[stdout] ", chunk),
    );
    launchedChild.stderr?.on("data", (chunk) =>
      appendChildLog(state.childLogs, "[stderr] ", chunk),
    );
    const exitPromise = createExitPromise(launchedChild, state);
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      launchedChild.once("spawn", resolveSpawn);
      launchedChild.once("error", rejectSpawn);
    });
    if (!launchedChild.pid) throw new Error("Packaged Moss launch did not expose a PID.");
    logPass("real-packaged-moss-launched-with-isolated-profile");

    state.stage = "main-window";
    const mainWindow = await waitForMainWindowEvidence(
      cdpPort,
      launchedChild,
      options.timeoutMs,
      state,
      { exitPromise },
    );
    logPass("main-window-and-preload-bridge");

    state.stage = "backend-health";
    await waitForBackendHealth(mainWindow.desktopWsUrl, options.timeoutMs);
    logPass("loopback-backend-health");

    state.stage = "graceful-exit";
    await requestGracefulExit(launchedChild, exitPromise, state);
    logPass("graceful-packaged-app-exit");

    state.stage = "complete";
    writeDiagnostic(options, state, "passed");
  } catch (error) {
    writeDiagnostic(options, state, "failed", error);
    throw error;
  } finally {
    await forceStopProcessTree(child, state.ownedDescendants);
    if (!options.keepWorkDir) {
      assertPathWithin(realpathSync.native(tmpdir()), workDir);
      rmSync(workDir, { force: true, recursive: true });
    } else {
      console.log(
        redactDiagnostic(`[mac-installed-smoke] kept isolated work directory: ${workDir}`),
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseMacInstalledAppSmokeOptions(process.argv.slice(2));
  if (!options) return;
  await runMacInstalledAppSmoke(options);
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  main().catch((error) => {
    console.error(formatMacInstalledAppFailure(error));
    process.exitCode = 1;
  });
}
