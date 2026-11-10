import type {
  ProviderKind,
  ServerProviderStatus,
  ServerProviderVersionAdvisory,
} from "@moss/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { executableCandidates, hasPathSeparator } from "../executableLookup.ts";
import {
  CLI_VERSION_PATTERN,
  compareParsedCliVersions,
  normalizeCliVersion,
  splitPrerelease,
  type ParsedCliVersion,
} from "./cliVersion.ts";
import {
  CN_HOMEBREW_API_DOMAIN,
  CN_NPM_MIRROR_REGISTRY,
  HOMEBREW_OFFICIAL_API_DOMAIN,
  NPM_OFFICIAL_REGISTRY,
  type ProviderPackageChannel,
} from "./providerPackageChannel.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
// A failed lookup must not hide an update for the next hour.
const LATEST_VERSION_FAILURE_CACHE_TTL_MS = 5 * 60 * 1_000;
const LATEST_VERSION_TIMEOUT_MS = 4_000;
// The mirror can take a few seconds on a package it has not cached recently.
const LATEST_VERSION_MIRROR_TIMEOUT_MS = 10_000;
const PROVIDER_UPDATE_ACTION_MESSAGE = "Install the update now or review provider settings.";

type ProviderInstallSource =
  | "npm"
  | "bun"
  | "pnpm"
  | "homebrew"
  | "native"
  /** A project's own dependency, e.g. a repo's `node_modules/.bin` that `bun run` puts on PATH. */
  | "project"
  | "unknown";

export interface ProviderLatestVersionSource {
  readonly kind: "npm" | "homebrew";
  readonly name: string;
  readonly homebrewKind?: "formula" | "cask";
}

export interface ProviderHomebrewPackageDefinition {
  readonly name: string;
  readonly kind: "formula" | "cask";
  readonly isCommandPath?: (commandPath: string) => boolean;
}

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderKind;
  readonly packageName: string | null;
  readonly latestVersionSource: ProviderLatestVersionSource | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /** Set only when packages come from somewhere other than the official sources. */
  readonly packageChannel?: ProviderPackageChannel;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** Exact package release whose installation must be confirmed after the command. */
  readonly targetVersion?: string;
  /** Put the selected provider binary's directory first so its package manager matches. */
  readonly pathPrepend?: string;
}

export interface ProviderMaintenanceCapabilityResolutionOptions {
  readonly binaryPath?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly realCommandPath?: string | null;
  readonly commandDirectory?: string | null;
  /** npm prefix that holds the package beside a Windows command shim. */
  readonly npmGlobalPrefix?: string | null;
  readonly packageChannel?: ProviderPackageChannel;
}

export interface PackageManagedProviderMaintenanceDefinition {
  readonly provider: ProviderKind;
  readonly binaryName: string;
  readonly npmPackageName: string | null;
  /** Extra `npm install -g` flags the package needs, e.g. install-script allowlists. */
  readonly npmInstallArgs?: ReadonlyArray<string>;
  readonly homebrew:
    | (ProviderHomebrewPackageDefinition & {
        readonly variants?: ReadonlyArray<ProviderHomebrewPackageDefinition>;
      })
    | null;
  readonly latestVersionSource?: ProviderLatestVersionSource | null;
  readonly nativeUpdate: {
    readonly executable: string;
    readonly args: (installSource: ProviderInstallSource) => ReadonlyArray<string>;
    readonly lockKey: string;
    readonly strategy: "always" | "matching-path";
    /** Explicit source for native installs. Null delegates update truth to the provider CLI. */
    readonly latestVersionSource?: ProviderLatestVersionSource | null;
    readonly excludedInstallSources?: ReadonlyArray<ProviderInstallSource>;
    readonly isCommandPath?: (commandPath: string) => boolean;
  } | null;
}

interface ProviderLatestVersionResult {
  readonly version: string | null;
  readonly mirrorVersion: string | null;
  /** A mirror can prove an available update, but cannot prove that no update exists. */
  readonly authoritative: boolean;
}

const latestVersionCache = new Map<
  string,
  ProviderLatestVersionResult & { readonly expiresAt: number }
>();

/** V2 ships under different packages; never suggest a V1 package for a V2 binary. */
export function withOpenCodeMaintenanceVersion(
  definition: PackageManagedProviderMaintenanceDefinition,
  version: string | null | undefined,
): PackageManagedProviderMaintenanceDefinition {
  if (definition.provider !== "opencode" || !version?.startsWith("2.")) return definition;
  return {
    ...definition,
    npmPackageName: "@opencode/cli",
    latestVersionSource: { kind: "npm", name: "@opencode/cli" },
    homebrew: { name: "anomalyco/tap/opencode-v2", kind: "formula" },
  };
}
const SEMVER_NUMBER_SEGMENT = /^\d+$/;
// Remote release metadata must be a complete SemVer, never a loosely parsed CLI banner.
const REMOTE_RELEASE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSemverVersion(version: string): string {
  return normalizeCliVersion(version.trim().replace(/^v/, ""));
}

function parseSemver(value: string): ParsedCliVersion | null {
  // Build metadata identifies a distribution of the same release, not its precedence.
  const normalized = normalizeSemverVersion(value).split("+")[0] ?? "";
  const { main, prerelease } = splitPrerelease(normalized);
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (
    majorSegment === undefined ||
    minorSegment === undefined ||
    patchSegment === undefined ||
    !SEMVER_NUMBER_SEGMENT.test(majorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(minorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  return {
    major: Number.parseInt(majorSegment, 10),
    minor: Number.parseInt(minorSegment, 10),
    patch: Number.parseInt(patchSegment, 10),
    prerelease:
      prerelease
        ?.split(".")
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

export function compareSemverVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  return compareParsedCliVersions(parsedLeft, parsedRight);
}

export function parseGenericCliVersion(output: string): string | null {
  const match = CLI_VERSION_PATTERN.exec(output);
  return match?.[1] ? normalizeSemverVersion(match[1]) : null;
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

/**
 * npm resolves its global prefix from the `node` binary that runs it, not from
 * npm's own location, so a bare `npm install -g` can write to a different
 * install tree than the one the detected provider binary lives in (e.g. a
 * Homebrew-prefix install checked by Moss while nvm's node makes npm install
 * into nvm's prefix). Derive the prefix that owns the detected binary so the
 * update can pin it explicitly.
 */
export function deriveNpmGlobalPrefix(commandPath: string): string | null {
  // normalizeCommandPath preserves length, so indices map back onto the
  // original string, keeping its casing and separators intact.
  const normalized = normalizeCommandPath(commandPath);
  const unixIndex = normalized.indexOf("/lib/node_modules/");
  if (unixIndex > 0) {
    return commandPath.slice(0, unixIndex);
  }
  const windowsIndex = normalized.indexOf("/npm/node_modules/");
  if (windowsIndex > 0) {
    return commandPath.slice(0, windowsIndex + "/npm".length);
  }
  return null;
}

const UPDATE_FAILURE_REASON_MAX_CHARS = 300;
const UPDATE_FAILURE_LINE_REGEX = /\b(?:error|failed|cannot|denied|not permitted)\b|\bERR!/i;

/**
 * The line of a failed update's output that says why, so the failure reads as more than an
 * exit code. Updaters print their reason on stderr, as the first line that reads as an error:
 * npm's last line only points at its log file, and Pi's names where it is installed.
 */
export function providerUpdateFailureReason(output: {
  readonly stderr: string;
  readonly stdout: string;
}): string | null {
  for (const stream of [output.stderr, output.stdout]) {
    const lines = stripVTControlCharacters(stream)
      .split(/\r\n|\r|\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0);
    const reason = lines.find((line) => UPDATE_FAILURE_LINE_REGEX.test(line)) ?? lines.at(-1);
    if (reason) {
      return reason.length <= UPDATE_FAILURE_REASON_MAX_CHARS
        ? reason
        : `${reason.slice(0, UPDATE_FAILURE_REASON_MAX_CHARS - 1)}…`;
    }
  }
  return null;
}

function providerMaintenanceCommand(executable: string, args: ReadonlyArray<string>): string {
  return [executable, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

export function makeProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderKind;
  readonly packageName: string | null;
  readonly latestVersionSource?: ProviderLatestVersionSource | null;
  readonly updateExecutable: string | null;
  readonly updateArgs: ReadonlyArray<string>;
  readonly updateLockKey: string | null;
  readonly updatePathPrepend?: string | null;
  readonly packageChannel?: ProviderPackageChannel | undefined;
}): ProviderMaintenanceCapabilities {
  const update =
    input.updateExecutable === null || input.updateLockKey === null
      ? null
      : {
          command: providerMaintenanceCommand(input.updateExecutable, input.updateArgs),
          executable: input.updateExecutable,
          args: input.updateArgs,
          lockKey: input.updateLockKey,
          ...(nonEmptyString(input.updatePathPrepend)
            ? { pathPrepend: nonEmptyString(input.updatePathPrepend)! }
            : {}),
        };
  return {
    provider: input.provider,
    packageName: input.packageName,
    latestVersionSource:
      input.latestVersionSource !== undefined
        ? input.latestVersionSource
        : input.packageName
          ? { kind: "npm", name: input.packageName }
          : null,
    update,
    ...(input.packageChannel === "cn-mirror" ? { packageChannel: input.packageChannel } : {}),
  };
}

function makeManualOnlyProviderMaintenanceCapabilities(input: {
  readonly provider: ProviderKind;
  readonly packageName: string | null;
  readonly packageChannel?: ProviderPackageChannel | undefined;
}): ProviderMaintenanceCapabilities {
  return makeProviderMaintenanceCapabilities({
    provider: input.provider,
    packageName: input.packageName,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
    packageChannel: input.packageChannel,
  });
}

function registryArgs(channel: ProviderPackageChannel | undefined): ReadonlyArray<string> {
  return channel === "cn-mirror" ? [`--registry=${CN_NPM_MIRROR_REGISTRY}`] : [];
}

function makeNpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  options: {
    readonly pathPrepend?: string | null | undefined;
    readonly commandPath?: string | null | undefined;
    readonly npmGlobalPrefix?: string | null | undefined;
    readonly packageChannel?: ProviderPackageChannel | undefined;
  },
): ProviderMaintenanceCapabilities {
  const { pathPrepend, commandPath, npmGlobalPrefix, packageChannel } = options;
  if (!definition.npmPackageName) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: null,
      packageChannel,
    });
  }
  const globalPrefix = npmGlobalPrefix ?? (commandPath ? deriveNpmGlobalPrefix(commandPath) : null);
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "npm",
    updateArgs: [
      "install",
      "-g",
      ...(globalPrefix ? ["--prefix", globalPrefix] : []),
      ...registryArgs(packageChannel),
      ...(definition.npmInstallArgs ?? []),
      `${definition.npmPackageName}@latest`,
    ],
    updateLockKey: "npm-global",
    packageChannel,
    ...(pathPrepend === undefined ? {} : { updatePathPrepend: pathPrepend }),
  });
}

function makeBunGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  pathPrepend?: string | null,
  packageChannel?: ProviderPackageChannel,
): ProviderMaintenanceCapabilities {
  if (!definition.npmPackageName) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: null,
      packageChannel,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "bun",
    updateArgs: ["i", "-g", ...registryArgs(packageChannel), `${definition.npmPackageName}@latest`],
    updateLockKey: "bun-global",
    packageChannel,
    ...(pathPrepend === undefined ? {} : { updatePathPrepend: pathPrepend }),
  });
}

function makePnpmGlobalProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  pathPrepend?: string | null,
  packageChannel?: ProviderPackageChannel,
): ProviderMaintenanceCapabilities {
  if (!definition.npmPackageName) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: null,
      packageChannel,
    });
  }
  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    updateExecutable: "pnpm",
    updateArgs: [
      "add",
      "-g",
      ...registryArgs(packageChannel),
      `${definition.npmPackageName}@latest`,
    ],
    updateLockKey: "pnpm-global",
    packageChannel,
    ...(pathPrepend === undefined ? {} : { updatePathPrepend: pathPrepend }),
  });
}

function makeHomebrewProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  homebrewPackage: ProviderHomebrewPackageDefinition | null,
  pathPrepend?: string | null,
  packageChannel?: ProviderPackageChannel,
): ProviderMaintenanceCapabilities {
  if (!homebrewPackage) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      packageChannel,
    });
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: null,
    latestVersionSource: resolveLatestVersionSourceForInstallSource(
      definition,
      "homebrew",
      homebrewPackage,
    ),
    updateExecutable: "brew",
    updateArgs:
      homebrewPackage.kind === "cask"
        ? ["upgrade", "--cask", homebrewPackage.name]
        : ["upgrade", homebrewPackage.name],
    updateLockKey: "homebrew",
    packageChannel,
    ...(pathPrepend === undefined ? {} : { updatePathPrepend: pathPrepend }),
  });
}

function resolveLatestVersionSourceForInstallSource(
  definition: PackageManagedProviderMaintenanceDefinition,
  installSource: ProviderInstallSource,
  homebrewPackage?: ProviderHomebrewPackageDefinition | null,
): ProviderLatestVersionSource | null {
  if (definition.latestVersionSource) {
    return definition.latestVersionSource;
  }
  if (
    installSource === "native" &&
    definition.nativeUpdate &&
    definition.nativeUpdate.latestVersionSource !== undefined
  ) {
    return definition.nativeUpdate.latestVersionSource;
  }
  if (installSource === "homebrew" && homebrewPackage) {
    return {
      kind: "homebrew",
      name: homebrewPackage.name,
      homebrewKind: homebrewPackage.kind,
    };
  }
  return definition.npmPackageName ? { kind: "npm", name: definition.npmPackageName } : null;
}

function makeNativeProviderMaintenanceCapabilities(
  definition: PackageManagedProviderMaintenanceDefinition,
  installSource: ProviderInstallSource,
  executable?: string | null,
  pathPrepend?: string | null,
  packageChannel?: ProviderPackageChannel,
): ProviderMaintenanceCapabilities | null {
  if (!definition.nativeUpdate) {
    return null;
  }

  return makeProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: installSource === "homebrew" ? null : definition.npmPackageName,
    // Prefer explicit upstream metadata for channels like third-party Homebrew taps,
    // then fall back to the package manager channel when its public API is usable.
    latestVersionSource: resolveLatestVersionSourceForInstallSource(definition, installSource),
    updateExecutable: executable ?? definition.nativeUpdate.executable,
    updateArgs: definition.nativeUpdate.args(installSource),
    updateLockKey: definition.nativeUpdate.lockKey,
    packageChannel,
    ...(pathPrepend === undefined ? {} : { updatePathPrepend: pathPrepend }),
  });
}

function detectInstallSource(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
): ProviderInstallSource {
  if (definition.nativeUpdate?.isCommandPath?.(commandPath)) {
    return "native";
  }
  if (isBunGlobalCommandPath(commandPath)) {
    return "bun";
  }
  if (isPnpmGlobalCommandPath(commandPath)) {
    return "pnpm";
  }
  if (isNpmGlobalCommandPath(commandPath)) {
    return "npm";
  }
  if (isHomebrewCommandPath(commandPath)) {
    return "homebrew";
  }
  if (normalizeCommandPath(commandPath).includes("/node_modules/")) {
    return "project";
  }
  return "unknown";
}

function makeProviderMaintenanceForInstallSource(input: {
  readonly definition: PackageManagedProviderMaintenanceDefinition;
  readonly installSource: ProviderInstallSource;
  readonly homebrewPackage?: ProviderHomebrewPackageDefinition | null;
  readonly executable?: string | null;
  readonly pathPrepend?: string | null;
  /** Path that matched install-source detection, used to pin the install tree. */
  readonly commandPath?: string | null;
  readonly npmGlobalPrefix?: string | null;
  readonly packageChannel?: ProviderPackageChannel | undefined;
}): ProviderMaintenanceCapabilities {
  const {
    definition,
    installSource,
    homebrewPackage,
    executable,
    pathPrepend,
    commandPath,
    npmGlobalPrefix,
    packageChannel,
  } = input;
  // A global install or the CLI's own updater would not touch the project's copy, and an
  // unpinned `npm install -g` would write to whatever global prefix npm resolves instead.
  if (installSource === "project") {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      packageChannel,
    });
  }
  // A CLI's own updater hides which registry it downloads from, so the mirror channel talks to
  // the package manager that owns the install instead.
  const mirrorsThroughPackageManager =
    packageChannel === "cn-mirror" &&
    definition.npmPackageName !== null &&
    (installSource === "npm" || installSource === "bun" || installSource === "pnpm");
  if (
    !mirrorsThroughPackageManager &&
    definition.nativeUpdate?.strategy === "always" &&
    !definition.nativeUpdate.excludedInstallSources?.includes(installSource)
  ) {
    return (
      makeNativeProviderMaintenanceCapabilities(
        definition,
        installSource,
        executable,
        pathPrepend,
        packageChannel,
      ) ??
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        packageChannel,
      })
    );
  }
  if (installSource === "native") {
    return (
      makeNativeProviderMaintenanceCapabilities(
        definition,
        installSource,
        executable,
        pathPrepend,
        packageChannel,
      ) ??
      makeManualOnlyProviderMaintenanceCapabilities({
        provider: definition.provider,
        packageName: definition.npmPackageName,
        packageChannel,
      })
    );
  }
  if (installSource === "bun") {
    return makeBunGlobalProviderMaintenanceCapabilities(definition, pathPrepend, packageChannel);
  }
  if (installSource === "pnpm") {
    return makePnpmGlobalProviderMaintenanceCapabilities(definition, pathPrepend, packageChannel);
  }
  if (installSource === "npm") {
    return makeNpmGlobalProviderMaintenanceCapabilities(definition, {
      pathPrepend,
      commandPath,
      npmGlobalPrefix,
      packageChannel,
    });
  }
  if (installSource === "homebrew") {
    return makeHomebrewProviderMaintenanceCapabilities(
      definition,
      homebrewPackage ?? definition.homebrew,
      pathPrepend,
      packageChannel,
    );
  }
  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    packageChannel,
  });
}

function resolveHomebrewPackageForCommandPath(
  definition: PackageManagedProviderMaintenanceDefinition,
  commandPath: string,
): ProviderHomebrewPackageDefinition | null {
  const homebrew = definition.homebrew;
  if (!homebrew) {
    return null;
  }
  return homebrew.variants?.find((variant) => variant.isCommandPath?.(commandPath)) ?? homebrew;
}

function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

function isNpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return normalized.includes("/lib/node_modules/") || normalized.includes("/npm/node_modules/");
}

function isHomebrewCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/opt/homebrew/caskroom/") ||
    normalized.includes("/usr/local/caskroom/") ||
    normalized.includes("/opt/homebrew/cellar/") ||
    normalized.includes("/usr/local/cellar/") ||
    normalized.includes("/homebrew/cellar/") ||
    normalized.startsWith("/opt/homebrew/bin/") ||
    normalized.startsWith("/usr/local/bin/")
  );
}

export function resolvePackageManagedProviderMaintenance(
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
): ProviderMaintenanceCapabilities {
  const packageChannel = options?.packageChannel;
  const binaryPath = nonEmptyString(options?.binaryPath);
  if (!binaryPath) {
    return makeManualOnlyProviderMaintenanceCapabilities({
      provider: definition.provider,
      packageName: definition.npmPackageName,
      packageChannel,
    });
  }

  const commandPaths = [options?.realCommandPath, binaryPath]
    .map(nonEmptyString)
    .filter((value): value is string => value !== null);

  for (const commandPath of commandPaths) {
    const installSource = detectInstallSource(definition, commandPath);
    if (installSource !== "unknown") {
      return makeProviderMaintenanceForInstallSource({
        definition,
        installSource,
        ...(installSource === "homebrew"
          ? { homebrewPackage: resolveHomebrewPackageForCommandPath(definition, commandPath) }
          : {}),
        executable: binaryPath,
        commandPath,
        packageChannel,
        ...(options?.commandDirectory === undefined
          ? {}
          : { pathPrepend: options.commandDirectory }),
      });
    }
  }

  const npmGlobalPrefix = nonEmptyString(options?.npmGlobalPrefix);
  if (npmGlobalPrefix) {
    return makeProviderMaintenanceForInstallSource({
      definition,
      installSource: "npm",
      executable: binaryPath,
      npmGlobalPrefix,
      packageChannel,
      ...(options?.commandDirectory === undefined ? {} : { pathPrepend: options.commandDirectory }),
    });
  }

  if (!hasPathSeparator(binaryPath)) {
    return makeProviderMaintenanceForInstallSource({
      definition,
      installSource: "unknown",
      executable: binaryPath,
      packageChannel,
      ...(options?.commandDirectory === undefined ? {} : { pathPrepend: options.commandDirectory }),
    });
  }

  return makeManualOnlyProviderMaintenanceCapabilities({
    provider: definition.provider,
    packageName: definition.npmPackageName,
    packageChannel,
  });
}

/**
 * npm's Windows shims are plain `.cmd` files beside `node_modules`, not symlinks, so the command
 * path never reveals the package manager. The package sitting next to the shim does.
 */
const resolveWindowsNpmGlobalPrefix = Effect.fn("resolveWindowsNpmGlobalPrefix")(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  commandDirectory: string,
  platform: NodeJS.Platform | undefined,
) {
  if (platform !== "win32" || !definition.npmPackageName) {
    return null;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const manifestPath = path.win32.join(
    commandDirectory,
    "node_modules",
    ...definition.npmPackageName.split("/"),
    "package.json",
  );
  const exists = yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
  return exists ? commandDirectory : null;
});

export const resolveProviderMaintenanceCapabilitiesEffect = Effect.fn(
  "resolveProviderMaintenanceCapabilitiesEffect",
)(function* (
  definition: PackageManagedProviderMaintenanceDefinition,
  options?: ProviderMaintenanceCapabilityResolutionOptions,
) {
  const binaryPath = nonEmptyString(options?.binaryPath) ?? definition.binaryName;
  const fileSystem = yield* FileSystem.FileSystem;
  if (hasPathSeparator(binaryPath)) {
    const realCommandPath =
      nonEmptyString(options?.realCommandPath) ??
      (yield* fileSystem.realPath(binaryPath).pipe(Effect.catch(() => Effect.succeed(binaryPath))));
    const npmGlobalPrefix = yield* resolveWindowsNpmGlobalPrefix(
      definition,
      path.win32.dirname(binaryPath),
      options?.platform,
    );
    return resolvePackageManagedProviderMaintenance(definition, {
      ...options,
      binaryPath,
      realCommandPath,
      npmGlobalPrefix,
    });
  }

  // Use the same candidate order as launch. An extensionless Windows shell shim can
  // remain in an old prefix after its runnable shim is gone; selecting it here would
  // update a different installation from the CLI Moss actually runs.
  //
  // `options.env` is used whole, with no per-key fallback to `process.env`. An earlier version
  // read `options.env.PATH ?? process.env.PATH`, which could report a provider as installed
  // because *this* process can see it while the child environment we were asked about cannot.
  // The production caller passes `buildProviderChildEnvironment(...)`, which always carries PATH.
  for (const candidate of executableCandidates(binaryPath, {
    ...(options?.platform === undefined ? {} : { platform: options.platform }),
    ...(options?.env === undefined ? {} : { env: options.env }),
  })) {
    const exists = yield* fileSystem.exists(candidate.path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      continue;
    }
    const realCommandPath = yield* fileSystem
      .realPath(candidate.path)
      .pipe(Effect.catch(() => Effect.succeed(candidate.path)));
    const npmGlobalPrefix = yield* resolveWindowsNpmGlobalPrefix(
      definition,
      candidate.directory,
      options?.platform,
    );
    return resolvePackageManagedProviderMaintenance(definition, {
      ...options,
      binaryPath,
      realCommandPath,
      commandDirectory: candidate.directory,
      npmGlobalPrefix,
    });
  }

  return resolvePackageManagedProviderMaintenance(definition, {
    ...options,
    binaryPath,
  });
});

function deriveVersionAdvisory(input: {
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly latestVersionIsAuthoritative?: boolean;
}): Pick<ServerProviderVersionAdvisory, "status" | "message"> {
  if (!input.currentVersion || !input.latestVersion) {
    return { status: "unknown", message: null };
  }
  const current = parseSemver(input.currentVersion);
  const latest = parseSemver(input.latestVersion);
  if (!current || !latest) return { status: "unknown", message: null };
  if (compareParsedCliVersions(current, latest) < 0) {
    return {
      status: "behind_latest",
      message: PROVIDER_UPDATE_ACTION_MESSAGE,
    };
  }
  if (input.latestVersionIsAuthoritative === false) {
    return { status: "unknown", message: null };
  }
  return { status: "current", message: null };
}

export function createProviderVersionAdvisory(input: {
  readonly provider: ProviderKind;
  readonly currentVersion: string | null;
  readonly latestVersion?: string | null;
  readonly latestVersionIsAuthoritative?: boolean;
  readonly checkedAt?: string | null;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
}): ServerProviderVersionAdvisory {
  const capabilities =
    input.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({ provider: input.provider, packageName: null });
  const latestVersion = input.latestVersion ?? null;
  const advisory = deriveVersionAdvisory({
    currentVersion: input.currentVersion,
    latestVersion,
    ...(input.latestVersionIsAuthoritative === undefined
      ? {}
      : { latestVersionIsAuthoritative: input.latestVersionIsAuthoritative }),
  });

  return {
    status: advisory.status,
    currentVersion: input.currentVersion,
    latestVersion,
    // Knowable when a registry can be queried, or when a latest version was already
    // resolved. Self-updating CLIs satisfy neither, so their status is pinned to
    // "unknown" and must not be presented as "an update is waiting".
    latestVersionKnowable: capabilities.latestVersionSource !== null || latestVersion !== null,
    updateCommand: capabilities.update?.command ?? null,
    canUpdate: capabilities.update !== null,
    checkedAt: input.checkedAt ?? null,
    message: advisory.message,
    ...(capabilities.packageChannel ? { packageChannel: capabilities.packageChannel } : {}),
  };
}

function latestVersionTimeoutMs(channel: ProviderPackageChannel | undefined): number {
  return channel === "cn-mirror" ? LATEST_VERSION_MIRROR_TIMEOUT_MS : LATEST_VERSION_TIMEOUT_MS;
}

function releaseVersionFromMetadata(value: unknown): string | null {
  // JS `$` also matches before a trailing newline; require the entire payload value.
  return typeof value === "string" && REMOTE_RELEASE_VERSION.exec(value)?.[0] === value
    ? value
    : null;
}

const fetchNpmLatestVersion = Effect.fn("fetchNpmLatestVersion")(function* (
  packageName: string,
  channel: ProviderPackageChannel | undefined,
) {
  const registry = channel === "cn-mirror" ? CN_NPM_MIRROR_REGISTRY : NPM_OFFICIAL_REGISTRY;
  return yield* Effect.tryPromise(async (signal) => {
    const response = await fetch(`${registry}/${encodeURIComponent(packageName)}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(latestVersionTimeoutMs(channel))]),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { version?: unknown };
    return releaseVersionFromMetadata(payload.version);
  }).pipe(Effect.catch(() => Effect.succeed(null)));
});

const fetchHomebrewLatestVersion = Effect.fn("fetchHomebrewLatestVersion")(function* (
  source: ProviderLatestVersionSource,
  channel: ProviderPackageChannel | undefined,
) {
  if (source.kind !== "homebrew" || !source.homebrewKind) {
    return null;
  }
  const apiDomain = channel === "cn-mirror" ? CN_HOMEBREW_API_DOMAIN : HOMEBREW_OFFICIAL_API_DOMAIN;
  return yield* Effect.tryPromise(async (signal) => {
    const response = await fetch(
      `${apiDomain}/${source.homebrewKind}/${encodeURIComponent(source.name)}.json`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(latestVersionTimeoutMs(channel))]),
      },
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      version?: unknown;
      versions?: { stable?: unknown };
    };
    return releaseVersionFromMetadata(
      source.homebrewKind === "cask" ? payload.version : payload.versions?.stable,
    );
  }).pipe(Effect.catch(() => Effect.succeed(null)));
});

const resolveLatestProviderVersionResult = Effect.fn("resolveLatestProviderVersionResult")(
  function* (maintenanceCapabilities: ProviderMaintenanceCapabilities, forceRefresh = false) {
    const source = maintenanceCapabilities.latestVersionSource;
    if (!source) {
      return {
        version: null,
        mirrorVersion: null,
        authoritative: false,
      } satisfies ProviderLatestVersionResult;
    }

    const channel = maintenanceCapabilities.packageChannel;
    // The mirror can lag the official registry, and an account can change lanes mid-session.
    const cacheKey = `${channel ?? "official"}:${
      source.kind === "homebrew"
        ? `homebrew:${source.homebrewKind ?? "unknown"}:${source.name}`
        : `npm:${source.name}`
    }`;
    const cached = latestVersionCache.get(cacheKey);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (!forceRefresh && cached && cached.expiresAt > now) {
      return cached;
    }

    const fetchVersion = (lookupChannel: ProviderPackageChannel | undefined) =>
      source.kind === "homebrew"
        ? fetchHomebrewLatestVersion(source, lookupChannel)
        : fetchNpmLatestVersion(source.name, lookupChannel);
    // Installation still uses the selected channel. Release truth comes from the
    // official metadata: a lagging mirror must never make an old CLI look current.
    // Start both bounded requests together so fallback costs at most the slower
    // timeout, and interruption aborts both HTTP requests with the owning refresh.
    const { officialVersion, mirrorVersion } =
      channel === "cn-mirror"
        ? yield* Effect.all(
            { officialVersion: fetchVersion("official"), mirrorVersion: fetchVersion("cn-mirror") },
            { concurrency: "unbounded" },
          )
        : { officialVersion: yield* fetchVersion(channel), mirrorVersion: null };
    const result = {
      version: officialVersion ?? mirrorVersion,
      mirrorVersion,
      authoritative: officialVersion !== null,
    } satisfies ProviderLatestVersionResult;
    latestVersionCache.set(cacheKey, {
      expiresAt:
        now +
        (result.authoritative ? LATEST_VERSION_CACHE_TTL_MS : LATEST_VERSION_FAILURE_CACHE_TTL_MS),
      ...result,
    });
    return result;
  },
);

export const resolveLatestProviderVersion = Effect.fn("resolveLatestProviderVersion")(function* (
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  return (yield* resolveLatestProviderVersionResult(maintenanceCapabilities)).version;
});

const PACKAGE_UPDATE_LOCK_KEYS = new Set(["npm-global", "bun-global", "pnpm-global"]);

function withVerifiedProviderUpdateTarget(
  capabilities: ProviderMaintenanceCapabilities,
  currentVersion: string | null,
  latest: ProviderLatestVersionResult,
): ProviderMaintenanceCapabilities {
  const update = capabilities.update;
  if (!update) return capabilities;
  const current = currentVersion ? parseSemver(currentVersion) : null;
  const target = latest.version ? parseSemver(latest.version) : null;
  if (PACKAGE_UPDATE_LOCK_KEYS.has(update.lockKey)) {
    // Never let the install registry's mutable @latest tag choose an older release
    // than the one shown to the user, or update without a verified installed floor.
    const packageArgument = capabilities.packageName ? `${capabilities.packageName}@latest` : null;
    if (
      !current ||
      !target ||
      !latest.version ||
      compareParsedCliVersions(target, current) < 0 ||
      !packageArgument ||
      !update.args.includes(packageArgument)
    ) {
      return { ...capabilities, update: null };
    }
    const args = update.args.map((argument) =>
      argument === packageArgument ? `${capabilities.packageName}@${latest.version}` : argument,
    );
    return {
      ...capabilities,
      update: {
        ...update,
        args,
        targetVersion: latest.version,
        command: providerMaintenanceCommand(update.executable, args),
      },
    };
  }
  // Native updaters and brew own their command syntax. Do not invent a version
  // flag: with conflicting mirror metadata there is no safe one-click action.
  if (
    capabilities.packageChannel === "cn-mirror" &&
    capabilities.latestVersionSource !== null &&
    (!current ||
      !target ||
      !latest.mirrorVersion ||
      compareParsedCliVersions(target, current) < 0 ||
      compareSemverVersions(latest.version!, latest.mirrorVersion) !== 0)
  ) {
    return { ...capabilities, update: null };
  }
  return capabilities;
}

export const PROVIDER_UPDATE_SETTINGS_CHANGED_MESSAGE =
  "Provider settings changed while the update was being prepared. Try again.";
export const PROVIDER_UPDATE_INSTALLATION_CHANGED_MESSAGE =
  "This provider's installation changed while the update was being prepared. Try again.";
export const PROVIDER_UPDATE_VERSION_UNCONFIRMED_MESSAGE =
  "Moss could not confirm which version to install. Check your network and try again.";

/**
 * Why a queued one-click update cannot start after its final recheck, or null.
 * Each cause gets its own message: none of them means updates are unsupported.
 */
export function providerUpdatePreparationFailure(input: {
  readonly settingsChanged: boolean;
  readonly expectedLockKey: string;
  readonly verifiedUpdate: { readonly lockKey: string } | null;
}): string | null {
  if (input.settingsChanged) return PROVIDER_UPDATE_SETTINGS_CHANGED_MESSAGE;
  if (!input.verifiedUpdate) return PROVIDER_UPDATE_VERSION_UNCONFIRMED_MESSAGE;
  if (input.verifiedUpdate.lockKey !== input.expectedLockKey)
    return PROVIDER_UPDATE_INSTALLATION_CHANGED_MESSAGE;
  return null;
}

/** The execution boundary rechecks metadata; UI enrichment uses the same target selection. */
export const prepareProviderMaintenanceUpdate = Effect.fn("prepareProviderMaintenanceUpdate")(
  function* (capabilities: ProviderMaintenanceCapabilities, currentVersion: string | null) {
    const latest = yield* resolveLatestProviderVersionResult(capabilities, true);
    return withVerifiedProviderUpdateTarget(capabilities, currentVersion, latest);
  },
);

export const enrichProviderStatusWithVersionAdvisory = Effect.fn(
  "enrichProviderStatusWithVersionAdvisory",
)(function* (
  status: ServerProviderStatus,
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
) {
  if (!status.available || !status.version) {
    const verifiedCapabilities = withVerifiedProviderUpdateTarget(
      maintenanceCapabilities,
      status.version ?? null,
      { version: null, mirrorVersion: null, authoritative: false },
    );
    return {
      ...status,
      versionAdvisory: createProviderVersionAdvisory({
        provider: maintenanceCapabilities.provider,
        currentVersion: status.version ?? null,
        checkedAt: status.checkedAt,
        maintenanceCapabilities: verifiedCapabilities,
      }),
    };
  }

  const latestVersion = yield* resolveLatestProviderVersionResult(maintenanceCapabilities);
  const verifiedCapabilities = withVerifiedProviderUpdateTarget(
    maintenanceCapabilities,
    status.version,
    latestVersion,
  );
  return {
    ...status,
    versionAdvisory: createProviderVersionAdvisory({
      provider: maintenanceCapabilities.provider,
      currentVersion: status.version,
      latestVersion: latestVersion.version,
      latestVersionIsAuthoritative: latestVersion.authoritative,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      maintenanceCapabilities: verifiedCapabilities,
    }),
  };
});
