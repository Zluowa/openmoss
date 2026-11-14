// FILE: apps/server/src/account/mossManagedHomeRecovery.ts
// Purpose: Explicit offline repair of a relocated, logged-out managed profile.
// Layer: Operator tooling; never imported by application startup.
// Exports: recoverManagedHome
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ServerSettings } from "@moss/contracts";
import { syncDirectoryEntry } from "@moss/shared/filesystemPlatform";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "../persistence/DatabaseLifecycleLock.ts";
import {
  hasMossManagedReservationCollision,
  withManagedCleanupState,
} from "./Layers/MossManagedProvider.ts";
import { readManagedCodexHomeAuthority } from "./mossManagedHomeAuthority.ts";
import { MOSS_MANAGED_RELAY_PROVIDERS } from "./managedRelayProviders.ts";
import { isTrustedMossManagedGatewayUrlForAuthority } from "../provider/mossManagedGatewayTrust.ts";
import { providerEnvironmentSecretName } from "../serverSettings.ts";
import { resolveCodexPathIdentityIo } from "../codexPathIdentity.ts";
import { runCodexAuthIoAsync } from "../codexAuthIo.ts";
import {
  parseMossProductionPublicConfig,
  applyMossProductionPublicConfigEnv,
} from "@moss/shared/mossProductionPublicConfig";

type Envelope = { revision: number; migrationVersion: number; settings: ServerSettings };
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const ids = [
  "codex_moss",
  "claude_moss",
  "opencode_moss",
  "pi_moss",
  ...MOSS_MANAGED_RELAY_PROVIDERS.map((r) => r.instanceId),
];
function fail(): never {
  throw new Error("Managed recovery proof failed; no repair was committed.");
}
type RecoveryStage =
  | "input"
  | "public-config"
  | "lifecycle-locks"
  | "source-settings"
  | "target-settings"
  | "secret-proof"
  | "source-validation"
  | "target-validation"
  | "home-identities"
  | "reviewed-plan"
  | "commit-cas"
  | "commit";
type RecoveryReason =
  | "path-missing"
  | "access-denied"
  | "proof-mismatch"
  | "validation-rejected"
  | "commit-state-unknown";
export class ManagedHomeRecoveryRefusal extends Error {
  constructor(
    readonly stage: RecoveryStage,
    readonly reason: RecoveryReason,
  ) {
    super("Managed recovery was refused.");
  }
}
type RecoveryInput = {
  source: string;
  target: string;
  applyPlan?: string;
  env?: NodeJS.ProcessEnv;
  publicConfigPath?: string;
};

export async function recoverManagedHome(input: RecoveryInput) {
  const progress: { stage: RecoveryStage } = { stage: "input" };
  try {
    return await runRecovery(input, progress);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    const reason: RecoveryReason =
      progress.stage === "commit"
        ? "commit-state-unknown"
        : code === "ENOENT"
          ? "path-missing"
          : code === "EACCES" || code === "EPERM"
            ? "access-denied"
            : cause instanceof Error &&
                cause.message === "Managed recovery proof failed; no repair was committed."
              ? "proof-mismatch"
              : "validation-rejected";
    throw new ManagedHomeRecoveryRefusal(progress.stage, reason);
  }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Reject aliases in every ancestor, including a junction above the supplied root.
async function realPath(file: string, directory: boolean): Promise<void> {
  const absolute = path.resolve(file);
  if (file !== absolute) fail();
  let current = absolute;
  let leaf = true;
  while (true) {
    const stat = await fs.lstat(current);
    if (
      stat.isSymbolicLink() ||
      (leaf && directory
        ? !stat.isDirectory()
        : leaf && !directory
          ? !stat.isFile()
          : !stat.isDirectory())
    )
      fail();
    if ((await fs.realpath(current)).toLowerCase() !== current.toLowerCase()) fail();
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    leaf = false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readEnvelope(root: string) {
  const file = path.join(root, "settings.json");
  const { bytes, fingerprint } = await readStableFile(file);
  const envelope = JSON.parse(bytes.toString("utf8")) as Envelope;
  if (
    !Number.isSafeInteger(envelope.revision) ||
    envelope.revision < 0 ||
    !Number.isSafeInteger(envelope.migrationVersion) ||
    !envelope.settings?.providerInstances
  )
    fail();
  return { envelope, hash: digest(bytes), fingerprint };
}

async function directoryIdentity(root: string): Promise<string> {
  await realPath(root, true);
  const stat = await fs.lstat(root, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

async function homeIdentities(settings: ServerSettings, root: string) {
  const result: Record<string, Awaited<ReturnType<typeof homeSnapshot>>> = {};
  for (const id of ids) {
    if (!settings.providerInstances[id]) continue;
    const item = config(settings, id);
    for (const key of ["homePath", "agentDir"]) {
      if (typeof item[key] !== "string") continue;
      result[id + ":" + key] = await homeSnapshot(
        item[key] as string,
        root,
        MOSS_MANAGED_RELAY_PROVIDERS.some((relay) => relay.instanceId === id),
      );
    }
  }
  return result;
}

// The application's path identity resolver retains a missing tail below its
// nearest existing ancestor. Bind that tail and all real ancestor inodes too;
// absence is never permission to create a home or to follow a redirected parent.
async function homeSnapshot(directory: string, root: string, allowMissing: boolean) {
  const tail: string[] = [];
  let nearest = directory;
  while (!(await exists(nearest))) {
    if (!allowMissing || nearest === root) fail();
    tail.unshift(path.basename(nearest));
    const parent = path.dirname(nearest);
    if (parent === nearest) fail();
    nearest = parent;
  }
  await realPath(nearest, true);
  const ancestors: Record<string, string> = {};
  for (let current = nearest; ; current = path.dirname(current)) {
    ancestors[current] = await directoryIdentity(current);
    if (current === root) break;
    if (path.dirname(current) === current) fail();
  }
  let absent = nearest;
  for (const segment of tail) {
    absent = path.join(absent, segment);
    if (await exists(absent)) fail();
  }
  const identity = await runCodexAuthIoAsync(resolveCodexPathIdentityIo(directory));
  const expected = process.platform === "win32" ? directory.toLowerCase() : directory;
  if (identity !== expected) fail();
  return { kind: tail.length ? "missing" : "existing", tail, identity, ancestors };
}

async function markerSnapshot(root: string) {
  const { bytes, fingerprint } = await readStableFile(
    path.join(root, "moss-codex-home", ".moss-managed-home"),
  );
  return { hash: digest(bytes), fingerprint };
}

async function readStableFile(file: string) {
  await realPath(file, false);
  const before = await fs.lstat(file, { bigint: true });
  if (before.nlink !== 1n || before.size > 16n * 1024n * 1024n) fail();
  const fingerprintOf = (stat: typeof before) =>
    `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const fingerprint = fingerprintOf(before);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    if (fingerprintOf(await handle.stat({ bigint: true })) !== fingerprint) fail();
    const bytes = await handle.readFile();
    const after = await fs.lstat(file, { bigint: true });
    if (
      after.isSymbolicLink() ||
      fingerprintOf(after) !== fingerprint ||
      fingerprintOf(await handle.stat({ bigint: true })) !== fingerprint
    )
      fail();
    return { bytes, fingerprint };
  } finally {
    await handle.close();
  }
}

// Redacted references are not credentials. Validate their persisted shape without
// opening/decrypting the secret store. This copy is never persisted or launched.
function structuralSettings(settings: ServerSettings): ServerSettings {
  const result = clone(settings);
  for (const id of ids) {
    const instance = result.providerInstances[id];
    if (!instance) continue;
    result.providerInstances[id] = {
      ...instance,
      ...(instance.environment
        ? {
            environment: instance.environment.map((entry) => {
              if (entry.sensitive !== true || entry.valueRedacted !== true) return entry;
              if (!validReference(id, entry.name, entry.valueSecretRef) || entry.value) fail();
              return { ...entry, value: "offline-structural-proof-only", valueRedacted: false };
            }),
          }
        : {}),
    };
  }
  return result;
}

function config(settings: ServerSettings, id: string): Record<string, unknown> {
  const value = settings.providerInstances[id]?.config;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function validReference(id: string, name: string, reference: string | undefined): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(storedReference(id, name, reference));
}

function storedReference(id: string, name: string, reference: string | undefined): string {
  return reference ?? providerEnvironmentSecretName({ instanceId: id, name });
}

function assertCompatibleCleanup(source: ServerSettings, target: ServerSettings) {
  if (
    !same(
      source.providers.codex.accounts.filter((a) => a.id === "moss"),
      target.providers.codex.accounts.filter((a) => a.id === "moss"),
    )
  )
    fail();
  for (const id of ids) {
    const original = source.providerInstances[id];
    const current = target.providerInstances[id];
    if (same(original, current)) continue;
    if (!original || !current) fail();
    if (!["claude_moss", "opencode_moss"].includes(id)) fail();
    const pending = {
      ...withManagedCleanupState(original, "pending-v1"),
      enabled: false,
      environment: [],
    };
    if (!same(pending, current)) fail();
  }
}

function verifySecretReferences(
  settings: ServerSettings,
  source: Awaited<ReturnType<typeof secretSnapshot>>,
  target: Awaited<ReturnType<typeof secretSnapshot>>,
) {
  for (const id of ids) {
    for (const entry of settings.providerInstances[id]?.environment ?? []) {
      if (entry.valueRedacted !== true) continue;
      const reference = storedReference(id, entry.name, entry.valueSecretRef);
      if (entry.sensitive !== true || !validReference(id, entry.name, entry.valueSecretRef)) fail();
      const name = `${reference}.bin`;
      if (!source[name]?.bytes || !target[name]?.bytes || source[name].hash !== target[name].hash)
        fail();
    }
  }
}

function relocate(
  settings: ServerSettings,
  source: string,
  target: string,
  env: NodeJS.ProcessEnv,
) {
  const next = clone(settings);
  const codexHome = path.join(source, "moss-codex-home");
  const accounts = next.providers.codex.accounts.filter((a) => a.id === "moss");
  if (accounts.length !== 1 || accounts[0]!.homePath !== codexHome || accounts[0]!.shadowHomePath)
    fail();
  accounts[0]!.homePath = path.join(target, "moss-codex-home");
  const codex = config(next, "codex_moss");
  if (codex.homePath !== codexHome || codex.shadowHomePath) fail();
  codex.homePath = path.join(target, "moss-codex-home");
  for (const id of ids.filter((id) => id !== "codex_moss")) {
    if (!next.providerInstances[id]) continue;
    const item = config(next, id);
    if (id === "pi_moss") {
      if (item.agentDir !== path.join(source, "provider-homes", "pi", String(item.realm))) fail();
      item.agentDir = path.join(target, "provider-homes", "pi", String(item.realm));
    }
    const relay = MOSS_MANAGED_RELAY_PROVIDERS.find((r) => r.instanceId === id);
    if (relay) {
      if (item.homePath !== path.join(source, "provider-homes", relay.driver, String(item.realm)))
        fail();
      item.homePath = path.join(target, "provider-homes", relay.driver, String(item.realm));
      if (next.providerInstances[id]!.enabled) {
        const rebuilt = relay.build({
          accessToken: "offline-structural-proof-only",
          gatewayBaseUrl: String(item.gatewayBaseUrl),
          runtimeGeneration: String(item.runtimeGeneration),
          realm: "cn",
          homePath: item.homePath as string,
          env,
        });
        next.providerInstances[id]!.environment = (
          next.providerInstances[id]!.environment ?? []
        ).map((entry) => {
          if (entry.sensitive) return entry;
          const replacement = rebuilt.environment.find(
            (candidate) => candidate.name === entry.name && !candidate.sensitive,
          );
          if (!replacement) fail();
          return { ...entry, value: replacement.value };
        });
      }
    }
  }
  return next;
}

async function validate(settings: ServerSettings, root: string, env: NodeJS.ProcessEnv) {
  const proof = structuralSettings(settings);
  const codex = config(proof, "codex_moss");
  if (
    typeof codex.runtimeGeneration !== "string" ||
    !codex.runtimeGeneration ||
    typeof codex.gatewayBaseUrl !== "string" ||
    !isTrustedMossManagedGatewayUrlForAuthority(codex.gatewayBaseUrl, "memfire-phone", env)
  )
    fail();
  for (const id of ids) {
    if (!proof.providerInstances[id]) continue;
    const item = config(proof, id);
    if (
      item.managed !== true ||
      item.runtimeGeneration !== codex.runtimeGeneration ||
      (item.realm !== undefined && item.realm !== "cn")
    )
      fail();
    const expectedGateway =
      id === "claude_moss" ? codex.gatewayBaseUrl.replace(/\/v1$/, "") : codex.gatewayBaseUrl;
    if (item.gatewayBaseUrl !== expectedGateway) fail();
  }
  const homes = [path.join(root, "moss-codex-home"), path.join(root, "provider-homes")];
  const overlaps = (candidate: string) =>
    homes.some((home) => {
      const a = path.resolve(candidate).toLowerCase();
      const b = home.toLowerCase();
      return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
    });
  for (const account of proof.providers.codex.accounts) {
    if (
      account.id !== "moss" &&
      [account.homePath, account.shadowHomePath].some((p) => p && overlaps(p))
    )
      fail();
  }
  for (const [id, instance] of Object.entries(proof.providerInstances)) {
    if (ids.includes(id)) continue;
    const item = instance.config as Record<string, unknown> | undefined;
    for (const key of ["homePath", "shadowHomePath", "agentDir"]) {
      if (typeof item?.[key] === "string" && overlaps(item[key] as string)) fail();
    }
    for (const entry of instance.environment ?? []) {
      if (
        ["CODEX_HOME", "MOSS_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"].includes(
          entry.name.toUpperCase(),
        ) &&
        (entry.valueRedacted || (entry.value && overlaps(entry.value)))
      )
        fail();
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (
      ["CODEX_HOME", "MOSS_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"].includes(
        key.toUpperCase(),
      ) &&
      value &&
      overlaps(value)
    )
      fail();
  }
  if (hasMossManagedReservationCollision(proof, path.join(root, "moss-codex-home"), env)) fail();
  const home = path.join(root, "moss-codex-home");
  await realPath(home, true);
  await realPath(path.join(home, ".moss-managed-home"), false);
  const authority = await readManagedCodexHomeAuthority({
    stateDir: root,
    readSettings: async () => proof,
    readSettingsSync: () => proof,
    input: { accountId: "moss", homePath: home, env },
    platform: "win32",
  });
  if (!authority || typeof codex.homeOwnershipNonce !== "string") fail();
  await authority.assertCurrent();
  for (const id of ids) {
    if (!proof.providerInstances[id]) continue;
    const item = config(proof, id);
    for (const key of ["homePath", "agentDir"]) {
      if (typeof item[key] === "string")
        await homeSnapshot(
          item[key] as string,
          root,
          MOSS_MANAGED_RELAY_PROVIDERS.some((relay) => relay.instanceId === id),
        );
    }
  }
}

// Hash all secret files without interpreting their contents. Keep the complete
// fence/tombstone set, rather than naming only today's known secret filenames.
async function secretSnapshot(
  root: string,
): Promise<Record<string, { hash: string; fingerprint: string; bytes: number }>> {
  const dir = path.join(root, "secrets");
  await realPath(dir, true);
  const result: Record<string, { hash: string; fingerprint: string; bytes: number }> = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    const file = path.join(dir, name);
    const { bytes, fingerprint } = await readStableFile(file);
    result[name] = { hash: digest(bytes), fingerprint, bytes: bytes.length };
  }
  return result;
}

async function runRecovery(input: RecoveryInput, progress: { stage: RecoveryStage }) {
  if (
    ![
      input.source,
      input.target,
      ...(input.publicConfigPath ? [input.publicConfigPath] : []),
    ].every(
      (root) =>
        path.isAbsolute(root) && !root.split(/[\\/]/).some((part) => part === "." || part === ".."),
    )
  )
    fail();
  const source = path.resolve(input.source);
  const target = path.resolve(input.target);
  for (const root of [source, target]) await realPath(root, true);
  const a = source.toLowerCase();
  const b = target.toLowerCase();
  if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) fail();
  progress.stage = "public-config";
  const publicConfig = input.publicConfigPath
    ? await readStableFile(path.resolve(input.publicConfigPath))
    : undefined;
  const env = publicConfig
    ? applyMossProductionPublicConfigEnv(
        input.env ?? process.env,
        parseMossProductionPublicConfig(publicConfig.bytes.toString("utf8")),
      )
    : (input.env ?? process.env);
  const locks = [];
  try {
    progress.stage = "lifecycle-locks";
    // Same on-disk protocol as installed 1.0.5. A running app wins the lock;
    // a concurrent app cannot open this profile until the repair releases it.
    for (const root of [source, target].sort()) {
      locks.push(
        await Effect.runPromise(acquireDatabaseLifecycleLock(path.join(root, "state.sqlite"))),
      );
    }
    progress.stage = "source-settings";
    const old = await readEnvelope(source);
    progress.stage = "target-settings";
    const current = await readEnvelope(target);
    const sourceIdentity = await directoryIdentity(source);
    const targetIdentity = await directoryIdentity(target);
    progress.stage = "secret-proof";
    const secrets = await secretSnapshot(target);
    if (
      secrets["moss.phone.session.bin"] ||
      !secrets["moss.phone.logout_pending.bin"]?.bytes ||
      !secrets["moss.managed.binding.bin"]?.bytes
    )
      fail();
    const sourceSecrets = await secretSnapshot(source);
    if (
      secrets["moss.managed.binding.bin"]?.hash !== sourceSecrets["moss.managed.binding.bin"]?.hash
    )
      fail();
    progress.stage = "source-validation";
    await validate(old.envelope.settings, source, env);
    // A target marker alone never authorizes a repair: require the explicitly
    // selected original reservation and the entire matching managed group.
    progress.stage = "secret-proof";
    const already =
      config(current.envelope.settings, "codex_moss").homePath ===
      path.join(target, "moss-codex-home");
    const normalized = already
      ? relocate(current.envelope.settings, target, source, env)
      : current.envelope.settings;
    assertCompatibleCleanup(old.envelope.settings, normalized);
    verifySecretReferences(current.envelope.settings, sourceSecrets, secrets);
    const next = already
      ? current.envelope.settings
      : relocate(current.envelope.settings, source, target, env);
    progress.stage = "target-validation";
    await validate(next, target, env);
    progress.stage = "home-identities";
    const sourceMarker = await markerSnapshot(source);
    const targetMarker = await markerSnapshot(target);
    const sourceHomes = await homeIdentities(old.envelope.settings, source);
    const targetHomes = await homeIdentities(next, target);
    for (const [key, original] of Object.entries(sourceHomes)) {
      const destination = targetHomes[key];
      if (
        !destination ||
        destination.kind !== original.kind ||
        !same(destination.tail, original.tail)
      )
        fail();
    }
    const plan = digest(
      Buffer.from(
        JSON.stringify({
          source,
          target,
          sourceHash: old.hash,
          targetHash: current.hash,
          sourceFile: old.fingerprint,
          targetFile: current.fingerprint,
          sourceIdentity,
          targetIdentity,
          sourceMarker,
          targetMarker,
          sourceHomes,
          targetHomes,
          publicConfig: publicConfig
            ? { hash: digest(publicConfig.bytes), fingerprint: publicConfig.fingerprint }
            : null,
          secrets,
          sourceSecrets,
        }),
      ),
    );
    progress.stage = "reviewed-plan";
    if (!input.applyPlan) return { status: already ? "already-repaired" : "dry-run", plan };
    if (already) return { status: "already-repaired", plan };
    if (input.applyPlan !== plan) fail();
    const file = path.join(target, "settings.json");
    const temp = path.join(target, `.managed-recovery-${randomUUID()}.tmp`);
    const nextEnvelope = {
      ...current.envelope,
      revision: current.envelope.revision + 1,
      settings: next,
    };
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      progress.stage = "commit-cas";
      await handle.writeFile(`${JSON.stringify(nextEnvelope, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // Revision + whole-file/secret-set CAS under the application lifecycle lock.
      if (
        !same(await readEnvelope(source), old) ||
        !same(await readEnvelope(target), current) ||
        (await directoryIdentity(source)) !== sourceIdentity ||
        (await directoryIdentity(target)) !== targetIdentity ||
        !same(await markerSnapshot(source), sourceMarker) ||
        !same(await markerSnapshot(target), targetMarker) ||
        !same(await homeIdentities(old.envelope.settings, source), sourceHomes) ||
        !same(await homeIdentities(next, target), targetHomes) ||
        !same(await secretSnapshot(target), secrets) ||
        !same(await secretSnapshot(source), sourceSecrets)
      )
        fail();
      await validate(old.envelope.settings, source, env);
      await validate(next, target, env);
      if (input.publicConfigPath && publicConfig) {
        const latest = await readStableFile(path.resolve(input.publicConfigPath));
        if (
          latest.fingerprint !== publicConfig.fingerprint ||
          digest(latest.bytes) !== digest(publicConfig.bytes)
        )
          fail();
      }
      progress.stage = "commit";
      await fs.rename(temp, file);
      await syncDirectoryEntry(target);
    } finally {
      if (await exists(temp)) await fs.unlink(temp);
    }
    return { status: "repaired", plan };
  } finally {
    for (const lock of locks.reverse()) await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (key: string) => args[args.indexOf(key) + 1];
  const allowed = new Set(["--source", "--target", "--apply-plan", "--public-config"]);
  if (
    args.length % 2 ||
    new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2 ||
    args.some((arg, i) => i % 2 === 0 && !allowed.has(arg)) ||
    !args.includes("--source") ||
    !args.includes("--target")
  ) {
    console.error(
      "Usage: bun apps/server/src/account/mossManagedHomeRecovery.ts --source <original-state-root> --target <copied-state-root> [--public-config <installed-public-config>] [--apply-plan <dry-run-plan>]",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          await recoverManagedHome({
            source: value("--source")!,
            target: value("--target")!,
            ...(args.includes("--apply-plan") ? { applyPlan: value("--apply-plan")! } : {}),
            ...(args.includes("--public-config")
              ? { publicConfigPath: value("--public-config")! }
              : {}),
          }),
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify(
          error instanceof ManagedHomeRecoveryRefusal
            ? {
                status: error.stage === "commit" ? "needs-review" : "refused",
                stage: error.stage,
                reason: error.reason,
              }
            : { status: "refused", stage: "input", reason: "validation-rejected" },
        ),
      );
      process.exitCode = 1;
    }
  }
}
