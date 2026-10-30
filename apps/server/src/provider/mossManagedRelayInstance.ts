// FILE: mossManagedRelayInstance.ts
// Purpose: Shared contract for the Moss-managed CLI relay instances (Hermes, Grok, Kimi Code,
//          MiniMax Code, ZCode): catalog env round-trips, structural verification, and private
//          home materialization that never follows filesystem links.
// Layer: Provider managed environments

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ProviderInstanceConfig, ProviderKind } from "@synara/contracts";
import {
  isMossAccessLane,
  MOSS_ACCESS_LANE_SPECS,
  type MossAccessLane,
} from "@synara/shared/mossRealmCatalog";
import { isTrustedMossManagedGatewayUrlForAuthority } from "./mossManagedGatewayTrust";

export const MOSS_MANAGED_RELAY_CREDENTIAL_ENV_KEY = "MOSS_ACCESS_TOKEN";
export const MOSS_MANAGED_RELAY_DISPLAY_NAME = "Moss";

export interface MossManagedRelayCatalog {
  readonly realm: MossAccessLane;
  readonly gatewayBaseUrl: string;
}

export interface MossManagedRelayEnvironmentEntry {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
}

export interface MossManagedRelayInstanceConfig {
  readonly managed: true;
  readonly realm: MossAccessLane;
  readonly homePath: string;
  readonly gatewayBaseUrl: string;
  readonly credentialEnvKey: string;
  readonly runtimeGeneration: string;
  readonly customModels: string[];
  readonly modelAllowlist: string[];
  readonly defaultModel: string;
}

export interface MossManagedRelayProviderInstance<
  Driver extends ProviderKind = ProviderKind,
> extends ProviderInstanceConfig {
  readonly driver: Driver;
  readonly displayName: typeof MOSS_MANAGED_RELAY_DISPLAY_NAME;
  readonly enabled: true;
  readonly environment: MossManagedRelayEnvironmentEntry[];
  readonly config: MossManagedRelayInstanceConfig;
}

export interface MossManagedRelayBuildInput {
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly runtimeGeneration: string;
  readonly homePath: string;
  readonly realm: MossAccessLane;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface MossManagedRelayVerifyInput {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig | undefined;
  readonly allowDisabled?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Per-driver identity of a managed relay; every message is prefixed with `label`. */
export interface MossManagedRelayDefinition<
  Driver extends ProviderKind,
  Catalog extends MossManagedRelayCatalog,
> {
  readonly driver: Driver;
  readonly instanceId: string;
  /** Error prefix, e.g. "Managed Hermes". */
  readonly label: string;
  /** Non-sensitive JSON catalog variable. */
  readonly configEnvKey: string;
  readonly credentialEnvKey: string;
  /**
   * Canonical catalog for a trusted gateway and realm. `parsed` is the
   * persisted payload so a driver can carry extra identity (home path) through
   * the round-trip; it must throw on malformed extras.
   */
  readonly buildCatalog: (input: {
    readonly gatewayBaseUrl: string;
    readonly realm: MossAccessLane;
    readonly parsed: Readonly<Record<string, unknown>>;
  }) => Catalog;
  readonly models: (catalog: Catalog) => ReadonlyArray<string>;
  /** Non-sensitive variables stored ahead of the catalog entry (e.g. GROK_HOME). */
  readonly leadingEnvironment?: (
    catalog: Catalog,
  ) => ReadonlyArray<{ name: string; value: string }>;
  /** Extra read-time check; a returned message is thrown as the error. */
  readonly validateEnvironment?: (
    catalog: Catalog,
    environment: Readonly<Record<string, string>>,
  ) => string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCanonicalIsolatedHome(homePath: string): boolean {
  return (
    path.isAbsolute(homePath) &&
    path.resolve(homePath) === homePath &&
    homePath !== path.parse(homePath).root
  );
}

/**
 * Decodes the catalog variable, requiring a trusted gateway for the realm's
 * authority, a byte-identical canonical catalog, and a present credential.
 * Returns undefined when the variable is absent (own-login instance).
 */
export function readMossManagedRelayCatalog<Catalog extends MossManagedRelayCatalog>(
  definition: MossManagedRelayDefinition<ProviderKind, Catalog>,
  environment: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Catalog | undefined {
  const raw = environment?.[definition.configEnvKey];
  if (raw === undefined) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    !isMossAccessLane(parsed.realm) ||
    typeof parsed.gatewayBaseUrl !== "string" ||
    !isTrustedMossManagedGatewayUrlForAuthority(
      parsed.gatewayBaseUrl,
      MOSS_ACCESS_LANE_SPECS[parsed.realm].authority,
      env,
    )
  ) {
    throw new Error(`${definition.label} requires a trusted Moss gateway and realm.`);
  }
  const expected = definition.buildCatalog({
    gatewayBaseUrl: parsed.gatewayBaseUrl,
    realm: parsed.realm,
    parsed,
  });
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error(`${definition.label} model configuration does not match its realm catalog.`);
  }
  const issue = definition.validateEnvironment?.(expected, environment ?? {});
  if (issue !== undefined) throw new Error(issue);
  if (!environment?.[definition.credentialEnvKey]?.trim()) {
    throw new Error(`${definition.label} requires a Moss access token.`);
  }
  return expected;
}

/**
 * Builds the persisted instance: the catalog is stored as a non-sensitive
 * variable, the bearer as a sensitive one, and the config never carries either.
 * The environment is read back through `readMossManagedRelayCatalog` so a
 * stored record always decodes.
 */
export function buildMossManagedRelayProviderInstance<
  Driver extends ProviderKind,
  Catalog extends MossManagedRelayCatalog,
>(
  definition: MossManagedRelayDefinition<Driver, Catalog>,
  catalog: Catalog,
  input: MossManagedRelayBuildInput,
): MossManagedRelayProviderInstance<Driver> {
  const environment: MossManagedRelayEnvironmentEntry[] = [
    ...(definition.leadingEnvironment?.(catalog) ?? []).map(
      ({ name, value }): MossManagedRelayEnvironmentEntry => ({ name, value, sensitive: false }),
    ),
    { name: definition.configEnvKey, value: JSON.stringify(catalog), sensitive: false },
    { name: definition.credentialEnvKey, value: input.accessToken, sensitive: true },
  ];
  readMossManagedRelayCatalog(
    definition,
    Object.fromEntries(environment.map((entry) => [entry.name, entry.value])),
    input.env,
  );
  const models = [...definition.models(catalog)];
  const defaultModel = models[0];
  if (defaultModel === undefined) {
    throw new Error(`${definition.label} has no models in this realm.`);
  }
  const instance: MossManagedRelayProviderInstance<Driver> = {
    driver: definition.driver,
    displayName: MOSS_MANAGED_RELAY_DISPLAY_NAME,
    enabled: true,
    environment,
    config: {
      managed: true,
      realm: input.realm,
      homePath: input.homePath,
      gatewayBaseUrl: catalog.gatewayBaseUrl,
      credentialEnvKey: definition.credentialEnvKey,
      runtimeGeneration: input.runtimeGeneration,
      customModels: models,
      modelAllowlist: models,
      defaultModel,
    },
  };
  return instance;
}

/**
 * Structural proof that a stored record is exactly what `build` produces for
 * its own config: same driver, display name, canonical config, and either a
 * present/secret-referenced bearer or (when allowed) a credential-free cleanup
 * tombstone.
 */
export function isVerifiedMossManagedRelayProviderInstance<Driver extends ProviderKind>(
  definition: Pick<
    MossManagedRelayDefinition<Driver, MossManagedRelayCatalog>,
    "driver" | "instanceId"
  >,
  build: (input: MossManagedRelayBuildInput) => MossManagedRelayProviderInstance<Driver>,
  input: MossManagedRelayVerifyInput,
): boolean {
  const instance = input.instance;
  if (!instance || input.instanceId !== definition.instanceId) return false;
  const config = isRecord(instance.config) ? instance.config : undefined;
  if (
    !config ||
    instance.driver !== definition.driver ||
    instance.displayName !== MOSS_MANAGED_RELAY_DISPLAY_NAME ||
    config.managed !== true ||
    !isMossAccessLane(config.realm) ||
    typeof config.gatewayBaseUrl !== "string" ||
    typeof config.homePath !== "string" ||
    typeof config.runtimeGeneration !== "string"
  )
    return false;
  try {
    const expected = build({
      accessToken: "structural-proof",
      gatewayBaseUrl: config.gatewayBaseUrl,
      runtimeGeneration: config.runtimeGeneration,
      homePath: config.homePath,
      realm: config.realm,
      ...(input.env ? { env: input.env } : {}),
    });
    const { managedCleanupState, ...actualConfig } = config;
    if (JSON.stringify(actualConfig) !== JSON.stringify(expected.config)) return false;
    if (!instance.enabled)
      return (
        input.allowDisabled === true &&
        instance.environment?.length === 0 &&
        (managedCleanupState === undefined ||
          managedCleanupState === "pending-v1" ||
          managedCleanupState === "complete-v1")
      );
    if (
      managedCleanupState !== undefined ||
      instance.environment?.length !== expected.environment.length
    )
      return false;
    return expected.environment.every((entry, index) => {
      const current = instance.environment?.[index];
      return (
        current?.name === entry.name &&
        current.sensitive === entry.sensitive &&
        (entry.sensitive
          ? (typeof current.value === "string" &&
              current.value.trim().length > 0 &&
              !current.valueRedacted) ||
            (current.valueRedacted === true &&
              current.valueSecretRef?.startsWith("provider-secret-v2-") === true)
          : current.value === entry.value)
      );
    });
  } catch {
    return false;
  }
}

/** Secret references/redaction metadata are storage details, not runtime identity. */
export function matchesMossManagedRelayProviderInstance(
  actual: ProviderInstanceConfig | undefined,
  expected: ProviderInstanceConfig | undefined,
): boolean {
  if (!expected) return actual === undefined;
  return (
    actual?.enabled === true &&
    actual.driver === expected.driver &&
    actual.displayName === expected.displayName &&
    JSON.stringify(actual.config) === JSON.stringify(expected.config) &&
    actual.environment?.length === expected.environment?.length &&
    expected.environment?.every((entry, index) => {
      const current = actual.environment?.[index];
      return (
        current?.name === entry.name &&
        current.value === entry.value &&
        current.sensitive === entry.sensitive
      );
    }) === true
  );
}

export function managedHomeAncestors(
  homePath: string,
  label: string,
  pathApi: Pick<typeof path, "parse" | "sep" | "join" | "isAbsolute" | "resolve"> = path,
): string[] {
  if (!pathApi.isAbsolute(homePath) || pathApi.resolve(homePath) !== homePath)
    throw new Error(`${label} must be canonical and absolute.`);
  const root = pathApi.parse(homePath).root;
  let ancestor = root;
  return homePath
    .slice(root.length)
    .split(pathApi.sep)
    .filter(Boolean)
    .map((segment) => {
      ancestor = pathApi.join(ancestor, segment);
      return ancestor;
    });
}

const notFoundAsUndefined = (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};

/**
 * Creates `directory` and every missing ancestor as private (0700)
 * directories without following existing links, then proves the result is
 * canonical. `label` names the home in errors ("Managed Hermes home").
 */
export async function ensureMossManagedHome(directory: string, label: string): Promise<void> {
  for (const ancestor of managedHomeAncestors(directory, label)) {
    const existing = await lstat(ancestor).catch(notFoundAsUndefined);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error(`${label} must not traverse symlinks.`);
    if (!existing) {
      await mkdir(ancestor, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const created = await lstat(ancestor);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error(`${label} must not traverse symlinks.`);
    }
  }
  if ((await realpath(directory)) !== directory) throw new Error(`${label} is not canonical.`);
  await chmod(directory, 0o700);
}

/**
 * Atomically replaces `directory/fileName` with a 0600 regular file. The
 * target must not be a link before or after the temporary file is written.
 * `label` names the file in errors ("Managed Hermes configuration").
 */
export async function writeMossManagedFile(input: {
  readonly directory: string;
  readonly fileName: string;
  readonly content: string;
  readonly label: string;
}): Promise<void> {
  const target = path.join(input.directory, input.fileName);
  const rejectLinkedTarget = async () => {
    const existing = await lstat(target).catch(notFoundAsUndefined);
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new Error(`${input.label} must be a regular file.`);
  };
  await rejectLinkedTarget();
  const temporary = path.join(
    input.directory,
    `.moss-${input.fileName}-${crypto.randomUUID()}.tmp`,
  );
  try {
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(input.content, "utf8");
    } finally {
      await file.close();
    }
    await rejectLinkedTarget();
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
