import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  MossFilesystemCapability,
  MossPrivateManifest,
  MossOwnershipStore,
  MossPrivateSnapshotPublishInput,
  MossPrivateSnapshotAuthority,
  MossPrivateStage,
} from "@synara/contracts";

import {
  applyMossResourceImport as applyMossResourceImportImpl,
  getMossResourceImportStateRoot,
  inventoryMossResourceImport as inventoryMossResourceImportImpl,
  isMossResourceImportPlainRecord,
  makeNodeMossOwnershipStore,
  MossResourceImportError,
  planMossResourceImport as planMossResourceImportImpl,
  rollbackMossResourceImport as rollbackMossResourceImportImpl,
} from "./mossResourceImport.ts";
import { registerMossResourceImportPlan } from "./mossCanonicalMutationIntent.ts";
import { makeMossCanonicalFilesystemHelper } from "./mossCanonicalFilesystemHelper.ts";
import { canonicalFilesystemHelperTestArch } from "./mossCanonicalFilesystemHelperTestRuntime.ts";
import { makeMossNativeFilesystemCapability } from "./mossNativeFilesystemCapability.ts";
import { discoverMossPluginCatalog } from "./pluginsCatalog.ts";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";

const execFile = promisify(execFileCallback);
const testHelperPath = join(
  process.cwd(),
  "native/moss-canonical-filesystem-helper/build/moss-canonical-filesystem-helper-import-test",
);
const nativeIt = canonicalFilesystemHelperTestArch === null ? it.skip : it;
// These integration chains require real no-follow descriptors and directory
// fsync. Windows refusal is verified below without simulating durable writes.
const posixDurabilityIt = it.skipIf(process.platform === "win32");

beforeAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  await execFile(
    process.execPath,
    [
      "scripts/build-canonical-filesystem-helper.mjs",
      "--arch",
      canonicalFilesystemHelperTestArch,
      "--test-hooks",
      "--output",
      testHelperPath,
    ],
    { cwd: process.cwd() },
  );
});

afterAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  await rm(testHelperPath, { force: true });
  await rm(`${testHelperPath}.build.json`, { force: true });
});

function makeTestNativeFilesystemCapability(
  options: Parameters<typeof makeMossNativeFilesystemCapability>[0],
) {
  return makeMossNativeFilesystemCapability({
    ...options,
    filesystemHelper: makeMossCanonicalFilesystemHelper({
      helperPath: testHelperPath,
      timeoutMs: 5_000,
    }),
  });
}

const redNativeFilesystemCapability: MossFilesystemCapability = {
  create: async (input) => redCapabilityResult(input, "0".repeat(64)),
  publish: async (input) => redCapabilityResult(input, "0".repeat(64)),
  replace: async (input) => redCapabilityResult(input, "0".repeat(64)),
  remove: async (input) =>
    redCapabilityResult(input, createHash("sha256").update("missing").digest("hex")),
};

function redCapabilityResult(
  input: Parameters<MossFilesystemCapability["create"]>[0],
  afterHash: string,
) {
  const observed = {
    identityFingerprint: `observed:${input.operationId}`,
    hash: afterHash,
  };
  return {
    observed,
    afterHash,
    durableObservedFingerprint: observed.identityFingerprint,
    receipt: {
      canonicalRoot: input.canonicalRoot,
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      fencingToken: input.fencingToken,
      generation: input.generation,
      nonce: input.nonce,
      expected: input.expected,
      ...(input.expectedAfter ? { expectedAfter: input.expectedAfter } : {}),
      observed,
      afterHash,
      durableObservedFingerprint: observed.identityFingerprint,
      durable: true as const,
    },
  };
}

const redOwnershipStore: MossOwnershipStore = {
  acquireLock: async () => ({
    nonce: "red-lock",
    fencingToken: "red-fence",
    generation: "red-generation",
    ownerId: "test-owner",
    projectId: "test-project",
    workspaceId: "test-workspace",
    principalId: "test-principal",
    sessionId: "test-session",
    release: async () => undefined,
  }),
  assertStateBudget: async () => undefined,
  createPrivateStage: async () => ({
    id: "red-stage",
    transactionId: "red-transaction",
    operationId: "red-operation",
    kind: "skill",
    canonicalRoot: "/server/canonical-root",
    ownerId: "test-owner",
    projectId: "test-project",
    workspaceId: "test-workspace",
    principalId: "test-principal",
    sessionId: "test-session",
    fencingToken: "red-fence",
    generation: "red-generation",
    nonce: "red-stage-nonce",
    createdAt: "2026-08-06T01:02:03.000Z",
    leaseExpiresAt: "2099-08-06T01:07:03.000Z",
    opaque: {},
  }),
  appendPrivateManifest: async (input) => ({
    locator: "server-state://red",
    transactionId: input.transactionId,
    sequence: 0,
    previousHash: "0".repeat(64),
    recordHash: "1".repeat(64),
    ownerId: input.ownerId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    sessionId: input.sessionId,
    stateFingerprint: input.stateFingerprint,
    nonce: input.nonce,
    value: input.value,
  }),
  readPrivateManifest: async () => null,
  appendPrivateRecord: async (input) => ({
    locator: "server-state://red-record",
    transactionId: input.transactionId,
    sequence: 0,
    previousHash: "0".repeat(64),
    recordHash: "1".repeat(64),
    ownerId: input.ownerId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    sessionId: input.sessionId,
    stateFingerprint: input.stateFingerprint,
    nonce: input.nonce,
    value: input.value,
  }),
  readPrivateRecord: async () => null,
  listPrivateRecords: async () => [],
  publishPrivateSnapshot: async (input: MossPrivateSnapshotPublishInput) => ({
    snapshotLocator: "server-state://red-snapshot",
    snapshotPath: `/server/state/${input.kind}/${input.snapshotSha256}`,
    snapshotSha256: input.snapshotSha256,
    revision: "1".repeat(64),
    payloadBytes: 0,
    durable: true as const,
    sealed: true as const,
  }),
  recoverPrivateStages: async () => undefined,
};

void redNativeFilesystemCapability;
void redOwnershipStore;

const testBindings = {
  ownerId: "test-owner",
  issuer: "test-issuer",
  sessionId: "test-session",
};

const testLockTails = new Map<string, Promise<void>>();

function stableTestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableTestValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableTestValue(entry)]),
    );
  }
  return value;
}

function stableTestJson(value: unknown): string {
  return JSON.stringify(stableTestValue(value));
}

function testSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function testStateFingerprint(
  cwd: string,
  workspaceId: string,
  snapshotHash: string,
  stateRoot: string,
): string {
  return createHash("sha256")
    .update(stableTestJson({ cwd, workspaceId, snapshotHash, stateRoot }))
    .digest("hex");
}

function testJournalRecordHash(journal: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      stableTestJson({
        schemaVersion: 3,
        transactionId: journal.transactionId,
        sequence: journal.sequence,
        previousHash: journal.previousHash,
        value: journal,
      }),
    )
    .digest("hex");
}

function testPrivateRecordHash(input: {
  readonly transactionId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly value: unknown;
}): string {
  const record =
    input.value !== null && typeof input.value === "object" && !Array.isArray(input.value)
      ? { ...(input.value as Record<string, unknown>) }
      : input.value;
  const value =
    record !== null && typeof record === "object" && !Array.isArray(record)
      ? {
          ...(record as Record<string, unknown>),
          sequence: input.sequence,
          previousHash: input.previousHash,
        }
      : record;
  return createHash("sha256")
    .update(
      stableTestJson({
        schemaVersion: 3,
        transactionId: input.transactionId,
        sequence: input.sequence,
        previousHash: input.previousHash,
        value,
      }),
    )
    .digest("hex");
}

function testStagePath(stage: MossPrivateStage): string {
  const path = (stage.opaque as { readonly path?: unknown })?.path;
  if (typeof path !== "string") throw new Error("test stage path missing");
  return path;
}

async function testTargetHash(targetPath: string): Promise<string> {
  const target = await lstat(targetPath).catch(() => null);
  if (!target) return createHash("sha256").update("missing").digest("hex");
  if (target.isSymbolicLink())
    throw new MossResourceImportError("symlink-escape", "test target symlink");
  if (target.isFile())
    return createHash("sha256")
      .update(await readFile(targetPath))
      .digest("hex");
  if (target.isDirectory()) {
    const entries = await readdir(targetPath, { withFileTypes: true });
    const parts: string[] = [];
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      parts.push(`${entry.name}\0${await testTargetHash(join(targetPath, entry.name))}`);
    }
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  }
  return createHash("sha256").update("unsupported").digest("hex");
}

async function testPrivatePayloadHash(
  payloadPath: string,
  kind: MossPrivateSnapshotPublishInput["kind"],
): Promise<string> {
  if (kind !== "plugin") {
    return createHash("sha256")
      .update(await readFile(payloadPath))
      .digest("hex");
  }
  const entries: string[] = [];
  const walk = async (currentPath: string, relativePath: string): Promise<void> => {
    const current = await lstat(currentPath);
    if (current.isSymbolicLink()) {
      throw new MossResourceImportError("symlink-escape", "test snapshot payload symlink");
    }
    if (current.isDirectory()) {
      const children = await readdir(currentPath, { withFileTypes: true });
      for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
        await walk(join(currentPath, child.name), join(relativePath, child.name));
      }
      return;
    }
    if (!current.isFile()) {
      throw new MossResourceImportError("snapshot-invalid", "test snapshot payload invalid");
    }
    entries.push(
      `${relativePath}\0${createHash("sha256")
        .update(await readFile(currentPath))
        .digest("hex")}`,
    );
  };
  await walk(payloadPath, "");
  return createHash("sha256").update(entries.toSorted().join("\n")).digest("hex");
}

async function testPrivatePayloadBytes(payloadPath: string): Promise<number> {
  const current = await lstat(payloadPath);
  if (current.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "test snapshot payload symlink");
  }
  if (current.isFile()) return current.size;
  if (!current.isDirectory()) {
    throw new MossResourceImportError("snapshot-invalid", "test snapshot payload invalid");
  }
  let total = 0;
  for (const child of await readdir(payloadPath)) {
    total += await testPrivatePayloadBytes(join(payloadPath, child));
  }
  return total;
}

async function testPrivatePayloadIdentity(payloadPath: string): Promise<string> {
  const current = await lstat(payloadPath);
  if (current.isSymbolicLink() || (!current.isFile() && !current.isDirectory())) {
    throw new MossResourceImportError("snapshot-invalid", "test snapshot payload identity invalid");
  }
  return createHash("sha256")
    .update(
      stableTestJson({
        type: current.isDirectory() ? "directory" : "file",
        dev: current.dev,
        ino: current.ino,
        mode: current.mode,
      }),
    )
    .digest("hex");
}

function testPrivateSnapshotRevision(input: {
  readonly kind: MossPrivateSnapshotPublishInput["kind"];
  readonly snapshotSha256: string;
  readonly manifestHash: string;
  readonly payloadBytes: number;
}): string {
  return createHash("sha256")
    .update(
      stableTestJson({
        schemaVersion: 1,
        kind: input.kind,
        snapshotSha256: input.snapshotSha256,
        manifestHash: input.manifestHash,
        payloadBytes: input.payloadBytes,
      }),
    )
    .digest("hex");
}

function testSnapshotKeyForAuthority(authority: MossPrivateSnapshotAuthority): string {
  return createHash("sha256")
    .update(
      stableTestJson({
        schemaVersion: 1,
        canonicalRoot: authority.canonicalRoot,
        stateRoot: authority.stateRoot,
        ownerId: authority.ownerId,
        projectId: authority.projectId,
        workspaceId: authority.workspaceId,
        principalId: authority.principalId,
        sessionId: authority.sessionId,
        transactionId: authority.transactionId,
        operationId: authority.operationId,
        fencingToken: authority.fencingToken,
        generation: authority.generation,
        nonce: authority.nonce,
        kind: authority.kind,
        snapshotSha256: authority.snapshotSha256,
      }),
    )
    .digest("hex");
}

async function assertTestCanonicalTarget(
  input: Parameters<MossFilesystemCapability["create"]>[0],
): Promise<void> {
  const root = input.canonicalRoot.rootPath;
  const target = input.targetPath;
  if (!target.startsWith(`${root}/`))
    throw new MossResourceImportError("path-traversal", "test target escaped root");
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat?.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "test canonical root is a symlink");
  }
  let current = root;
  for (const segment of target
    .slice(root.length + 1)
    .split("/")
    .slice(0, -1)) {
    current = join(current, segment);
    const currentStat = await lstat(current).catch(() => null);
    if (currentStat?.isSymbolicLink()) {
      throw new MossResourceImportError("symlink-escape", "test canonical parent is a symlink");
    }
  }
}

function testCapabilityForState(stateDir: string): MossFilesystemCapability {
  void stateDir;
  const missingHash = createHash("sha256").update("missing").digest("hex");
  const result = (input: Parameters<MossFilesystemCapability["create"]>[0], afterHash: string) => {
    const observed = {
      identityFingerprint: `test:${input.operationId}:${afterHash}`,
      hash: afterHash,
    };
    return {
      observed,
      afterHash,
      durableObservedFingerprint: observed.identityFingerprint,
      receipt: {
        canonicalRoot: input.canonicalRoot,
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        operationId: input.operationId,
        fencingToken: input.fencingToken,
        generation: input.generation,
        nonce: input.nonce,
        expected: input.expected,
        ...(input.expectedAfter ? { expectedAfter: input.expectedAfter } : {}),
        observed,
        afterHash,
        durableObservedFingerprint: observed.identityFingerprint,
        durable: true as const,
      },
    };
  };
  const copy = async (
    input: Parameters<MossFilesystemCapability["create"]>[0],
    replace: boolean,
  ) => {
    await assertTestCanonicalTarget(input);
    if (!input.stage)
      throw new MossResourceImportError("transaction-invalid", "test stage missing");
    const beforeHash = await testTargetHash(input.targetPath);
    if (beforeHash !== input.expectedBeforeHash) {
      throw new MossResourceImportError("concurrent-modification", "test target changed");
    }
    if (!replace && beforeHash !== missingHash) {
      throw new MossResourceImportError("conflict", "test target exists");
    }
    await mkdir(join(input.canonicalRoot.rootPath, "skills"), { recursive: true });
    await mkdir(join(input.canonicalRoot.rootPath, "plugins"), { recursive: true });
    await mkdir(join(input.canonicalRoot.rootPath, "mcp"), { recursive: true });
    await mkdir(join(input.targetPath, ".."), { recursive: true });
    const stagePath = testStagePath(input.stage);
    const stageStat = await lstat(stagePath);
    const payloadPath = join(stagePath, input.kind === "plugin" ? "tree" : "payload");
    const payloadStat = stageStat.isDirectory() ? await lstat(payloadPath).catch(() => null) : null;
    const sourcePath = payloadStat ? payloadPath : stagePath;
    await cp(sourcePath, input.targetPath, {
      recursive: true,
      force: replace,
      errorOnExist: !replace,
    });
    return result(input, input.expectedAfterHash ?? missingHash);
  };
  return {
    create: (input) => copy(input, false),
    publish: (input) => copy(input, false),
    replace: (input) => copy(input, true),
    remove: async (input) => {
      await assertTestCanonicalTarget(input);
      const beforeHash = await testTargetHash(input.targetPath);
      if (beforeHash !== input.expectedBeforeHash) {
        throw new MossResourceImportError("concurrent-modification", "test target changed");
      }
      await rm(input.targetPath, { recursive: true, force: false });
      return result(input, missingHash);
    },
  };
}

function testOwnershipStore(stateDir: string): MossOwnershipStore {
  const records = new Map<string, MossPrivateManifest>();
  const appendRecord = async (input: Parameters<MossOwnershipStore["appendPrivateRecord"]>[0]) => {
    const prior = await readRecord(input);
    const sequence = prior ? prior.sequence + 1 : 0;
    const previousHash =
      prior?.recordHash ??
      createHash("sha256").update("moss-resource-import:journal:v3:genesis").digest("hex");
    const value =
      input.value !== null && typeof input.value === "object" && !Array.isArray(input.value)
        ? Object.fromEntries(
            Object.entries(input.value as Record<string, unknown>).filter(
              ([key]) => !["sequence", "previousHash", "recordHash"].includes(key),
            ),
          )
        : input.value;
    const recordHash = testPrivateRecordHash({
      transactionId: input.transactionId,
      sequence,
      previousHash,
      value,
    });
    const record: MossPrivateManifest = {
      locator: `test://${input.fileName}`,
      transactionId: input.transactionId,
      sequence,
      previousHash,
      recordHash,
      ownerId: input.ownerId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      stateFingerprint: input.stateFingerprint,
      nonce: input.nonce,
      value,
    };
    records.set(`${input.fileName}:${sequence}`, record);
    const baseName = input.fileName.replace(/\.json$/u, "");
    const persistedFileName = sequence === 0 ? input.fileName : `${baseName}.${sequence}.json`;
    await mkdir(join(stateDir, persistedFileName, ".."), { recursive: true, mode: 0o700 });
    await writeFile(
      join(stateDir, persistedFileName),
      `${JSON.stringify({
        schemaVersion: 3,
        transactionId: input.transactionId,
        sequence,
        previousHash,
        recordHash,
        ownerId: input.ownerId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        sessionId: input.sessionId,
        stateFingerprint: input.stateFingerprint,
        nonce: input.nonce,
        value,
      })}\n`,
      { mode: 0o600 },
    );
    return {
      locator: record.locator,
      transactionId: input.transactionId,
      sequence,
      previousHash,
      recordHash,
      ownerId: input.ownerId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      stateFingerprint: input.stateFingerprint,
      nonce: input.nonce,
      value,
    };
  };
  const readRecord = async (input: { readonly fileName: string }) => {
    const matches = [...records.entries()]
      .filter(([key]) => {
        const recordName = key.slice(0, key.lastIndexOf(":"));
        if (recordName === input.fileName) return true;
        const base = input.fileName.replace(/\.json$/u, "");
        return (
          recordName.startsWith(`${base}.`) &&
          /^\d+\.json$/u.test(recordName.slice(base.length + 1))
        );
      })
      .map(([, record]) => record)
      .toSorted((left, right) => left.sequence - right.sequence);
    const latest = matches.at(-1);
    if (latest) return latest;
    const directory = join(stateDir, input.fileName, "..");
    const baseName = input.fileName.split("/").at(-1) ?? input.fileName;
    const candidates = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const names = candidates
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name === baseName ||
            new RegExp(`^${baseName.replace(/\.json$/u, "")}\.\\d+\.json$`).test(entry.name)),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const diskRecords: MossPrivateManifest[] = [];
    for (const entry of names) {
      try {
        const raw = JSON.parse(await readFile(join(directory, entry.name), "utf8")) as Record<
          string,
          unknown
        >;
        const value =
          raw.schemaVersion === 3 && Object.prototype.hasOwnProperty.call(raw, "value")
            ? raw.value
            : raw;
        if (
          typeof raw.transactionId !== "string" ||
          typeof raw.sequence !== "number" ||
          typeof raw.previousHash !== "string" ||
          typeof raw.recordHash !== "string"
        ) {
          continue;
        }
        diskRecords.push({
          locator: `test://${input.fileName}`,
          transactionId: raw.transactionId,
          sequence: raw.sequence,
          previousHash: raw.previousHash,
          recordHash: raw.recordHash,
          ownerId: typeof raw.ownerId === "string" ? raw.ownerId : testBindings.ownerId,
          projectId: typeof raw.projectId === "string" ? raw.projectId : "test-project",
          workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : "test-workspace",
          principalId: typeof raw.principalId === "string" ? raw.principalId : testBindings.ownerId,
          sessionId: typeof raw.sessionId === "string" ? raw.sessionId : testBindings.sessionId,
          stateFingerprint:
            typeof raw.stateFingerprint === "string" ? raw.stateFingerprint : "0".repeat(64),
          nonce: typeof raw.nonce === "string" ? raw.nonce : "test-nonce",
          value,
        });
      } catch {
        // The test store is intentionally permissive; production decoding is strict.
      }
    }
    return diskRecords.toSorted((left, right) => left.sequence - right.sequence).at(-1) ?? null;
  };
  return {
    acquireLock: async (input) => {
      if (await lstat(join(stateDir, ".lock")).catch(() => null)) {
        throw new MossResourceImportError("concurrent-modification", "test lock is occupied");
      }
      const previous = testLockTails.get(stateDir) ?? Promise.resolve();
      let releaseCurrent!: () => void;
      const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const tail = previous.then(() => current);
      testLockTails.set(stateDir, tail);
      await previous;
      let released = false;
      return {
        ownerId: input.ownerId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        nonce: input.nonce,
        fencingToken: "test-fence",
        generation: "test-generation",
        sessionId: input.sessionId,
        release: async () => {
          if (released) return;
          released = true;
          releaseCurrent();
          if (testLockTails.get(stateDir) === tail) testLockTails.delete(stateDir);
        },
      };
    },
    assertStateBudget: async () => undefined,
    createPrivateStage: async (input) => {
      const path = join(stateDir, "stage", input.transactionId, `${input.operationId}.stage`);
      await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
      return { ...input, id: `${input.transactionId}:${input.operationId}`, opaque: { path } };
    },
    appendPrivateManifest: appendRecord,
    readPrivateManifest: readRecord,
    appendPrivateRecord: appendRecord,
    readPrivateRecord: readRecord,
    listPrivateRecords: async ({ prefix }) => {
      const directory = join(stateDir, prefix);
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => `${prefix}/${entry.name}`);
    },
    publishPrivateSnapshot: async (input) => {
      const stagePath = testStagePath(input.stage);
      const snapshotKey = testSnapshotKeyForAuthority(input.authority);
      const base = join(stateDir, "snapshots", `${input.kind}-${snapshotKey}`);
      await mkdir(join(base, ".."), { recursive: true, mode: 0o700 });
      if (await lstat(base).catch(() => null)) {
        await rm(stagePath, { recursive: true, force: true });
        const payloadPath = join(base, input.kind === "plugin" ? "tree" : "payload");
        const payloadBytes = await testPrivatePayloadBytes(payloadPath);
        const manifestHash = createHash("sha256")
          .update(stableTestJson(input.manifest))
          .digest("hex");
        return {
          snapshotLocator: `test-snapshot://${snapshotKey}`,
          snapshotPath: payloadPath,
          snapshotSha256: input.snapshotSha256,
          revision: testPrivateSnapshotRevision({
            kind: input.kind,
            snapshotSha256: input.snapshotSha256,
            manifestHash,
            payloadBytes,
          }),
          payloadBytes,
          durable: true as const,
          sealed: true as const,
        };
      }
      try {
        await rename(stagePath, base);
      } catch (cause) {
        if (
          !cause ||
          typeof cause !== "object" ||
          !(["EEXIST", "ENOTEMPTY"] as readonly unknown[]).includes(
            (cause as { readonly code?: unknown }).code,
          )
        ) {
          throw cause;
        }
        if (!(await lstat(base).catch(() => null))) {
          throw new MossResourceImportError(
            "concurrent-modification",
            "test snapshot publish lost its target race",
          );
        }
        await rm(stagePath, { recursive: true, force: true });
      }
      const payloadPath = join(base, input.kind === "plugin" ? "tree" : "payload");
      const payloadBytes = await testPrivatePayloadBytes(payloadPath);
      const manifestHash = createHash("sha256")
        .update(stableTestJson(input.manifest))
        .digest("hex");
      const payloadIdentityFingerprint = await testPrivatePayloadIdentity(payloadPath);
      const manifestIdentityFingerprint = await testPrivatePayloadIdentity(
        join(base, "manifest.json"),
      );
      const revision = testPrivateSnapshotRevision({
        kind: input.kind,
        snapshotSha256: input.snapshotSha256,
        manifestHash,
        payloadBytes,
      });
      const seal = {
        schemaVersion: 1 as const,
        kind: input.kind,
        snapshotSha256: input.snapshotSha256,
        canonicalRoot: input.authority.canonicalRoot,
        stateRoot: input.authority.stateRoot,
        manifestHash,
        manifestIdentityFingerprint,
        payloadIdentityFingerprint,
        payloadBytes,
        revision,
        transactionId: input.authority.transactionId,
        operationId: input.authority.operationId,
        ownerId: input.authority.ownerId,
        projectId: input.authority.projectId,
        workspaceId: input.authority.workspaceId,
        principalId: input.authority.principalId,
        sessionId: input.authority.sessionId,
        fencingToken: input.authority.fencingToken,
        generation: input.authority.generation,
        nonce: input.authority.nonce,
        createdAt: input.stage.createdAt,
        leaseExpiresAt: input.stage.leaseExpiresAt,
      };
      const marker = {
        ...seal,
        marker: "committed" as const,
        sealHash: createHash("sha256").update(stableTestJson(seal)).digest("hex"),
      };
      await writeFile(join(base, "sealed.json"), `${JSON.stringify(seal)}\n`, { mode: 0o600 });
      await writeFile(join(base, "published.json"), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
      return {
        snapshotLocator: `test-snapshot://${snapshotKey}`,
        snapshotPath: payloadPath,
        snapshotSha256: input.snapshotSha256,
        revision,
        payloadBytes,
        durable: true as const,
        sealed: true as const,
      };
    },
    recoverPrivateStages: async () => undefined,
  };
}

// Test-only authority injection. Production RPC wiring must pass config.stateDir;
// the importer itself intentionally fails closed when stateDir is omitted.
const testStateDir = (input: { readonly homeDir?: string; readonly stateDir?: string }): string =>
  input.stateDir ?? getMossResourceImportStateRoot(input.homeDir ? { homeDir: input.homeDir } : {});

async function privateStagePaths(stateDir: string): Promise<string[]> {
  const stageRoot = join(stateDir, "stage");
  const transactions = await readdir(stageRoot, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const transaction of transactions) {
    if (!transaction.isDirectory()) continue;
    const transactionPath = join(stageRoot, transaction.name);
    const stages = await readdir(transactionPath, { withFileTypes: true }).catch(() => []);
    for (const stage of stages) {
      if (stage.isDirectory()) paths.push(join(transactionPath, stage.name));
    }
  }
  return paths.toSorted();
}

const inventoryMossResourceImport = (
  input: Parameters<typeof inventoryMossResourceImportImpl>[0],
) =>
  inventoryMossResourceImportImpl({
    ...testBindings,
    ...input,
    stateDir: testStateDir(input),
    ownershipStore: input.ownershipStore ?? testOwnershipStore(testStateDir(input)),
  });

const planMossResourceImport = (input: Parameters<typeof planMossResourceImportImpl>[0]) =>
  planMossResourceImportImpl({
    ...testBindings,
    ...input,
    stateDir: testStateDir(input),
    ownershipStore: input.ownershipStore ?? testOwnershipStore(testStateDir(input)),
  });

const applyMossResourceImport = (input: Parameters<typeof applyMossResourceImportImpl>[0]) =>
  applyMossResourceImportImpl({
    ...testBindings,
    ...input,
    stateDir: testStateDir(input),
    ownershipStore: input.ownershipStore ?? testOwnershipStore(testStateDir(input)),
    filesystemCapability: input.filesystemCapability ?? testCapabilityForState(testStateDir(input)),
  });

const rollbackMossResourceImport = (input: Parameters<typeof rollbackMossResourceImportImpl>[0]) =>
  rollbackMossResourceImportImpl({
    ...testBindings,
    ...input,
    stateDir: testStateDir(input),
    ownershipStore: input.ownershipStore ?? testOwnershipStore(testStateDir(input)),
    filesystemCapability: input.filesystemCapability ?? testCapabilityForState(testStateDir(input)),
  });

describe("moss resource import", () => {
  let workspace: string;
  let homeDir: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "moss-import-workspace-"));
    homeDir = await mkdtemp(join(tmpdir(), "moss-import-home-"));
    outside = await mkdtemp(join(tmpdir(), "moss-import-outside-"));
  });

  afterEach(async () => {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(homeDir, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it.runIf(process.platform === "win32").each(["home skill", "browser local skill"] as const)(
    "refuses native %s planning without directory durability and preserves all workspace bytes",
    async (sourceKind) => {
      const sourcePath = join(homeDir, ".claude", "skills", "windows-refusal", "SKILL.md");
      const contents = "---\nname: Windows Refusal\n---\nKeep this source.\n";
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, contents);
      const serverState = join(outside, "native-refusal-state");
      await mkdir(serverState);
      const before = await readdir(workspace);

      await expect(
        planMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir: join(serverState, "resource-import"),
          ...(sourceKind === "browser local skill"
            ? {
                localSource: { kind: "skill" as const, sourceName: "browser.md", contents },
              }
            : {}),
        }),
      ).rejects.toMatchObject({ code: "durability-unsupported" });
      expect(await readdir(workspace)).toEqual(before);
      expect(await readFile(sourcePath, "utf8")).toBe(contents);
      await expect(lstat(join(workspace, ".moss"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps a real visible-imports junction outside authority while refusing unsupported canonical planning",
    async () => {
      const sourcePath = join(homeDir, ".claude", "skills", "visible-index", "SKILL.md");
      const contents = "---\nname: Visible Index\n---\nOriginal source.\n";
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, contents);
      const externalImports = join(outside, "visible-imports");
      await mkdir(externalImports);
      await writeFile(join(externalImports, "sentinel"), "keep-outside");
      await mkdir(join(workspace, ".moss"));
      await symlink(externalImports, join(workspace, ".moss", "imports"), "junction");
      expect(await readFile(join(workspace, ".moss", "imports", "sentinel"), "utf8")).toBe(
        "keep-outside",
      );
      const serverState = join(outside, "visible-index-server-state");
      await mkdir(serverState);

      await expect(
        planMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir: join(serverState, "resource-import"),
        }),
      ).rejects.toMatchObject({ code: "durability-unsupported" });
      expect(await readFile(sourcePath, "utf8")).toBe(contents);
      expect(await readFile(join(externalImports, "sentinel"), "utf8")).toBe("keep-outside");
      expect(await readdir(join(workspace, ".moss"))).toEqual(["imports"]);
    },
  );

  it("fails closed when production wiring omits the trusted state directory", async () => {
    await expect(planMossResourceImportImpl({ cwd: workspace, homeDir })).rejects.toMatchObject({
      code: "authorization-required",
    });
  });

  it("rejects a workspace-controlled authority directory", async () => {
    await expect(
      planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir: join(workspace, "authority"),
      }),
    ).rejects.toMatchObject({ code: "authorization-required" });
  });

  it("rejects a missing trusted authority parent instead of creating it", async () => {
    const missingParent = join(outside, "missing-server-state");
    await expect(
      planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir: join(missingParent, "resource-import"),
      }),
    ).rejects.toMatchObject({ code: "authorization-required" });
    await expect(lstat(missingParent)).rejects.toThrow();
  });

  posixDurabilityIt(
    "uses the default Node store only for a private sealed snapshot plan",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "node-private"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "node-private", "SKILL.md"),
        "---\nname: Node Private\n---\nSnapshot only.\n",
      );
      const sharedStateDir = join(outside, "node-server-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });

      const planned = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        projectId: "project-node-private",
        principalId: "principal-node-private",
      });

      expect(planned.plan.operations[0]?.snapshotPath).toBeDefined();
      await expect(stat(planned.plan.operations[0]!.snapshotPath)).resolves.toBeDefined();
      await expect(lstat(join(workspace, ".moss", "imports"))).rejects.toThrow();
    },
  );

  posixDurabilityIt(
    "stages browser local bytes privately and never returns the private source path",
    async () => {
      const sharedStateDir = join(outside, "local-source-server-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      const localSource = {
        kind: "skill" as const,
        sourceName: "review.md",
        contents: "---\nname: review\n---\nReview changed files.\n",
      };

      const inventory = await inventoryMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        projectId: "project-local-source",
        principalId: "principal-local-source",
        workspaceId: "workspace-local-source",
        localSource,
      });

      expect(inventory.resources).toHaveLength(1);
      expect(inventory.resources[0]?.sourcePath).toMatch(
        /^server-state:\/\/resource-import\/local\//u,
      );
      expect(JSON.stringify(inventory)).not.toContain(stateDir);

      const planned = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        projectId: "project-local-source",
        principalId: "principal-local-source",
        workspaceId: "workspace-local-source",
        localSource,
      });

      expect(planned.plan.operations[0]).toMatchObject({
        kind: "skill",
        name: "review",
        action: "copy",
        sourcePath: expect.stringMatching(/^server-state:\/\/resource-import\/local\//u),
      });
      await expect(stat(planned.plan.operations[0]!.snapshotPath)).resolves.toBeDefined();
    },
  );

  posixDurabilityIt(
    "does not retain an operation stage for inventory-only local sources",
    async () => {
      const sharedStateDir = join(outside, "local-inventory-only-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });

      await expect(
        inventoryMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir,
          workspaceId: "workspace-inventory-only",
          localSource: {
            kind: "skill",
            sourceName: "inventory-only.md",
            contents: "---\nname: inventory-only\n---\nInventory only.\n",
          },
        }),
      ).resolves.toMatchObject({ resources: [expect.anything()] });

      expect(await privateStagePaths(stateDir)).toEqual([]);
    },
  );

  posixDurabilityIt.each([
    ["unselected", { resourceIds: ["resource-not-selected"] }],
    ["resource-limit", { maxPlanOperations: 0 }],
  ] as const)("cleans a local-source stage when planning is %s", async (_caseName, extra) => {
    const sharedStateDir = join(outside, `local-${_caseName}-state`);
    const stateDir = join(sharedStateDir, "resource-import");
    await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });

    await planMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      workspaceId: `workspace-${_caseName}`,
      ...extra,
      localSource: {
        kind: "skill",
        sourceName: `${_caseName}.md`,
        contents: `---\nname: ${_caseName}\n---\nNot selected.\n`,
      },
    });

    expect(await privateStagePaths(stateDir)).toEqual([]);
  });

  posixDurabilityIt("cleans a local-source stage when snapshot freezing fails", async () => {
    const sharedStateDir = join(outside, "local-freeze-failure-state");
    const stateDir = join(sharedStateDir, "resource-import");
    await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });

    const failure = await planMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      workspaceId: "workspace-freeze-failure",
      beforeFilesystemMutation: () => {
        throw new Error("synthetic-freeze-failure");
      },
      localSource: {
        kind: "skill",
        sourceName: "freeze-failure.md",
        contents: "---\nname: freeze-failure\n---\nFreeze failure.\n",
      },
    }).catch((cause: unknown) => cause);
    const failureRecord = failure as unknown as Error & { readonly code?: unknown };

    expect(failureRecord.code).toBe("copy-failed");
    expect(failureRecord.message).not.toContain("synthetic-freeze-failure");
    expect(failureRecord.stack).not.toContain("synthetic-freeze-failure");

    expect(await privateStagePaths(stateDir)).toEqual([]);
  });

  posixDurabilityIt(
    "does not swallow local-source cleanup failure after a primary error",
    async () => {
      const sharedStateDir = join(outside, "local-cleanup-failure-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      const baseStore = makeNodeMossOwnershipStore(stateDir);
      const movedStage = join(outside, "local-cleanup-sentinel");
      let capturedStagePath: string | undefined;
      const ownershipStore: MossOwnershipStore = {
        ...baseStore,
        writePrivateStage: async (input) => {
          capturedStagePath = testStagePath(input.stage);
          await baseStore.writePrivateStage!(input);
          await rename(capturedStagePath, movedStage);
          await symlink(movedStage, capturedStagePath);
          throw new MossResourceImportError(
            "invalid-json",
            "Synthetic primary local-source failure.",
          );
        },
      };

      const failure = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        workspaceId: "workspace-local-cleanup-failure",
        ownershipStore,
        localSource: {
          kind: "skill",
          sourceName: "local-cleanup-failure.md",
          contents: "---\nname: local-cleanup-failure\n---\nPrimary failure.\n",
        },
      }).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as readonly unknown[];
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid-json" }),
          expect.objectContaining({ code: "durability-unsupported" }),
        ]),
      );
      expect(JSON.stringify(errors)).not.toContain(movedStage);
      expect(capturedStagePath).toBeDefined();
      await expect(lstat(capturedStagePath!)).resolves.toSatisfy((value) => value.isSymbolicLink());
      await expect(readFile(join(movedStage, "payload"), "utf8")).resolves.toContain(
        "Primary failure.",
      );
    },
  );

  posixDurabilityIt("does not swallow snapshot cleanup failure after publish fails", async () => {
    const sharedStateDir = join(outside, "snapshot-cleanup-failure-state");
    const stateDir = join(sharedStateDir, "resource-import");
    await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
    await mkdir(join(homeDir, ".claude", "skills", "snapshot-cleanup-failure"), {
      recursive: true,
    });
    await writeFile(
      join(homeDir, ".claude", "skills", "snapshot-cleanup-failure", "SKILL.md"),
      "---\nname: snapshot-cleanup-failure\n---\nSnapshot source.\n",
    );
    const baseStore = makeNodeMossOwnershipStore(stateDir);
    const movedStage = join(outside, "snapshot-cleanup-sentinel");
    let capturedStagePath: string | undefined;
    const ownershipStore: MossOwnershipStore = {
      ...baseStore,
      publishPrivateSnapshot: async (input) => {
        capturedStagePath = testStagePath(input.stage);
        await rename(capturedStagePath, movedStage);
        await symlink(movedStage, capturedStagePath);
        throw new MossResourceImportError(
          "concurrent-modification",
          "Synthetic primary snapshot publish failure.",
        );
      },
    };
    const inventory = await inventoryMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      ownershipStore,
      kinds: ["skill"],
    });
    const resource = inventory.resources.find(
      (candidate) => candidate.name === "snapshot-cleanup-failure",
    );
    const failure = await planMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      workspaceId: "workspace-snapshot-cleanup-failure",
      ownershipStore,
      kinds: ["skill"],
      resourceIds: resource ? [resource.id] : [],
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as readonly unknown[];
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "concurrent-modification" }),
        expect.objectContaining({ code: "durability-unsupported" }),
      ]),
    );
    expect(JSON.stringify(errors)).not.toContain(movedStage);
    expect(capturedStagePath).toBeDefined();
    await expect(lstat(capturedStagePath!)).resolves.toSatisfy((value) => value.isSymbolicLink());
    await expect(readFile(join(movedStage, "payload"), "utf8")).resolves.toContain(
      "Snapshot source.",
    );
  });

  posixDurabilityIt(
    "maps a local-source primary error before rethrowing after cleanup succeeds",
    async () => {
      const sharedStateDir = join(outside, "local-primary-error-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      const baseStore = makeNodeMossOwnershipStore(stateDir);
      const secret = "synthetic-local-primary-secret";
      const rawMessage = `${secret} /Users/moss/private-local-stage https://user:pass@example.test/import?token=${secret}`;
      const ownershipStore: MossOwnershipStore = {
        ...baseStore,
        writePrivateStage: async (input) => {
          await baseStore.writePrivateStage!(input);
          throw new Error(rawMessage);
        },
      };

      const failure = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        workspaceId: "workspace-local-primary-error",
        ownershipStore,
        localSource: {
          kind: "skill",
          sourceName: "local-primary-error.md",
          contents: "---\nname: local-primary-error\n---\nPrimary error.\n",
        },
      }).catch(
        (cause: unknown) =>
          cause as {
            readonly code?: unknown;
            readonly message?: unknown;
            readonly stack?: unknown;
          },
      );
      const failureRecord = failure as unknown as {
        readonly code?: unknown;
        readonly message?: unknown;
        readonly stack?: unknown;
      };

      expect(failureRecord.code).toBe("copy-failed");
      expect(typeof failureRecord.message).toBe("string");
      expect(String(failureRecord.message)).not.toContain(secret);
      expect(String(failureRecord.message)).not.toContain("/Users/moss/private-local-stage");
      expect(String(failureRecord.message)).not.toContain("https://user:pass@example.test");
      expect(String(failureRecord.stack)).not.toContain(secret);
      expect(String(failureRecord.stack)).not.toContain("/Users/moss/private-local-stage");
      expect(String(failureRecord.stack)).not.toContain("https://user:pass@example.test");
      expect(await privateStagePaths(stateDir)).toEqual([]);
    },
  );

  posixDurabilityIt(
    "maps an untrusted snapshot primary error before rethrowing after cleanup succeeds",
    async () => {
      const sharedStateDir = join(outside, "snapshot-primary-error-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      await mkdir(join(homeDir, ".claude", "skills", "snapshot-primary-error"), {
        recursive: true,
      });
      await writeFile(
        join(homeDir, ".claude", "skills", "snapshot-primary-error", "SKILL.md"),
        "---\nname: snapshot-primary-error\n---\nSnapshot primary.\n",
      );
      const baseStore = makeNodeMossOwnershipStore(stateDir);
      const secret = "synthetic-snapshot-primary-secret";
      const rawMessage = `${secret} /Users/moss/private-snapshot https://example.test/snapshot?key=${secret}`;
      const ownershipStore: MossOwnershipStore = {
        ...baseStore,
        publishPrivateSnapshot: async () => {
          throw { code: "symlink-escape", message: rawMessage, stack: rawMessage };
        },
      };
      const inventory = await inventoryMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        ownershipStore,
        kinds: ["skill"],
      });
      const resource = inventory.resources.find(
        (candidate) => candidate.name === "snapshot-primary-error",
      );
      const failure = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        workspaceId: "workspace-snapshot-primary-error",
        ownershipStore,
        kinds: ["skill"],
        resourceIds: resource ? [resource.id] : [],
      }).catch(
        (cause: unknown) =>
          cause as {
            readonly code?: unknown;
            readonly message?: unknown;
            readonly stack?: unknown;
          },
      );
      const failureRecord = failure as unknown as {
        readonly code?: unknown;
        readonly message?: unknown;
        readonly stack?: unknown;
      };

      expect(failureRecord.code).toBe("copy-failed");
      expect(typeof failureRecord.message).toBe("string");
      expect(String(failureRecord.message)).not.toContain(secret);
      expect(String(failureRecord.message)).not.toContain("/Users/moss/private-snapshot");
      expect(String(failureRecord.message)).not.toContain("https://example.test/snapshot");
      expect(String(failureRecord.stack)).not.toContain(secret);
      expect(String(failureRecord.stack)).not.toContain("/Users/moss/private-snapshot");
      expect(String(failureRecord.stack)).not.toContain("https://example.test/snapshot");
      expect(await privateStagePaths(stateDir)).toEqual([]);
    },
  );

  posixDurabilityIt(
    "releases the original local-source stage after snapshot plan and keeps apply/rollback stage-free",
    async () => {
      const sharedStateDir = join(outside, "local-selected-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      const ownershipStore = makeNodeMossOwnershipStore(stateDir);

      const planned = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        workspaceId: "workspace-selected",
        ownershipStore,
        localSource: {
          kind: "skill",
          sourceName: "selected.md",
          contents: "---\nname: selected\n---\nSelected.\n",
        },
      });

      expect(await privateStagePaths(stateDir)).toEqual([]);

      const applied = await applyMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        workspaceId: "workspace-selected",
        ownershipStore,
        filesystemCapability: testCapabilityForState(stateDir),
        plan: planned.plan,
      });
      expect(applied.status).toBe("committed");
      expect(await privateStagePaths(stateDir)).toEqual([]);

      await expect(
        rollbackMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir,
          workspaceId: "workspace-selected",
          ownershipStore,
          filesystemCapability: testCapabilityForState(stateDir),
          transactionId: applied.transactionId,
        }),
      ).resolves.toMatchObject({ status: expect.stringMatching(/rolled-back|partial/u) });
      expect(await privateStagePaths(stateDir)).toEqual([]);
    },
  );

  posixDurabilityIt("does not strand an abandoned local-source plan after it expires", async () => {
    const sharedStateDir = join(outside, "local-expired-state");
    const stateDir = join(sharedStateDir, "resource-import");
    await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const startedAt = Date.now();
    let now = new Date(startedAt);
    const planned = await planMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      workspaceId: "workspace-expired-local",
      ownershipStore,
      now: () => now,
      planTtlMillis: 1_000,
      localSource: {
        kind: "skill",
        sourceName: "expired-local.md",
        contents: "---\nname: expired-local\n---\nExpired local.\n",
      },
    });
    expect(await privateStagePaths(stateDir)).toEqual([]);
    now = new Date(startedAt + 2_000);

    await expect(
      applyMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        workspaceId: "workspace-expired-local",
        ownershipStore,
        now: () => now,
        filesystemCapability: testCapabilityForState(stateDir),
        plan: planned.plan,
      }),
    ).rejects.toMatchObject({ code: "plan-expired" });
    expect(await privateStagePaths(stateDir)).toEqual([]);
    await expect(readdir(join(stateDir, "local-source-stage-leases"))).rejects.toThrow();
  });

  posixDurabilityIt(
    "does not append a local-source lease chain across repeated plans",
    async () => {
      const sharedStateDir = join(outside, "local-repeated-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      const ownershipStore = makeNodeMossOwnershipStore(stateDir);

      for (const [index, contents] of ["one", "two", "three"].entries()) {
        await planMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir,
          workspaceId: "workspace-repeated-local",
          ownershipStore,
          localSource: {
            kind: "skill",
            sourceName: `repeated-${index}.md`,
            contents: `---\nname: repeated-${index}\n---\n${contents}.\n`,
          },
        });
      }

      await expect(readdir(join(stateDir, "local-source-stage-leases"))).rejects.toThrow();
      expect(await privateStagePaths(stateDir)).toEqual([]);
    },
  );

  posixDurabilityIt(
    "keeps mutation stages available during rollback after a final checkpoint failure",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "checkpoint-failure"), {
        recursive: true,
      });
      await writeFile(
        join(homeDir, ".claude", "skills", "checkpoint-failure", "SKILL.md"),
        "---\nname: checkpoint-failure\n---\nCheckpoint failure.\n",
      );
      const stateDir = getMossResourceImportStateRoot({ homeDir });
      const baseStore = makeNodeMossOwnershipStore(stateDir);
      let failCommittedCheckpoint = true;
      const ownershipStore: MossOwnershipStore = {
        ...baseStore,
        appendPrivateRecord: async (input) => {
          const value = input.value as { readonly state?: unknown };
          if (
            failCommittedCheckpoint &&
            input.fileName.startsWith("transactions/") &&
            value.state === "committed"
          ) {
            failCommittedCheckpoint = false;
            throw new MossResourceImportError(
              "durability-unsupported",
              "Synthetic final checkpoint failure.",
            );
          }
          return baseStore.appendPrivateRecord(input);
        },
      };
      const capability = testCapabilityForState(stateDir);
      let stageObservedDuringRollback = false;
      const rollbackCapability: MossFilesystemCapability = {
        ...capability,
        remove: async (input) => {
          stageObservedDuringRollback = (await privateStagePaths(stateDir)).length > 0;
          return capability.remove(input);
        },
      };
      const inventory = await inventoryMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        ownershipStore,
        kinds: ["skill"],
      });
      const resource = inventory.resources.find(
        (candidate) => candidate.name === "checkpoint-failure",
      );
      const planned = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        ownershipStore,
        kinds: ["skill"],
        resourceIds: resource ? [resource.id] : [],
      });

      const applied = await applyMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        ownershipStore,
        filesystemCapability: rollbackCapability,
        plan: planned.plan,
      });

      expect(applied.status).toBe("partial");
      expect(stageObservedDuringRollback).toBe(true);
      await expect(
        readFile(join(workspace, ".moss", "skills", "checkpoint-failure", "SKILL.md")),
      ).rejects.toThrow();
    },
  );

  posixDurabilityIt("retains both mutation stages when the second cleanup is unsafe", async () => {
    for (const name of ["cleanup-first", "cleanup-second"]) {
      await mkdir(join(homeDir, ".claude", "skills", name), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", name, "SKILL.md"),
        `---\nname: ${name}\n---\n${name}.\n`,
      );
    }
    const stateDir = getMossResourceImportStateRoot({ homeDir });
    const inventory = await inventoryMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      kinds: ["skill"],
    });
    const planned = await planMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      kinds: ["skill"],
      resourceIds: inventory.resources.map((resource) => resource.id),
    });
    let firstStagePath: string | undefined;
    let secondStagePath: string | undefined;
    let sabotaged = false;
    const movedStage = join(outside, "cleanup-second-stage-sentinel");
    const capability = testCapabilityForState(stateDir);
    const applied = await applyMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      filesystemCapability: capability,
      plan: planned.plan,
      checkpointHook: async ({ state, stagingPath }) => {
        if (state === "applying" && stagingPath && !firstStagePath) {
          firstStagePath = stagingPath;
          return;
        }
        if (state === "applying" && stagingPath && stagingPath !== firstStagePath) {
          secondStagePath = stagingPath;
          return;
        }
        if (state !== "committed" || !secondStagePath || sabotaged) return;
        const stageRoot = dirname(secondStagePath);
        await rename(stageRoot, movedStage);
        await symlink(movedStage, stageRoot);
        sabotaged = true;
      },
    });

    expect(sabotaged).toBe(true);
    expect({
      status: applied.status,
      issueCodes: applied.issues.map((entry) => entry.code),
      operationStatuses: applied.operations.map((entry) => entry.status),
    }).toEqual({
      status: "committed",
      issueCodes: ["durability-unsupported"],
      operationStatuses: ["created", "created"],
    });
    await expect(
      readFile(join(workspace, ".moss", "skills", "cleanup-first", "SKILL.md"), "utf8"),
    ).resolves.toContain("cleanup-first");
    await expect(
      readFile(join(workspace, ".moss", "skills", "cleanup-second", "SKILL.md"), "utf8"),
    ).resolves.toContain("cleanup-second");
    expect((await lstat(join(stateDir, "stage"))).isDirectory()).toBe(true);
    await expect(lstat(join(movedStage, "payload"))).resolves.toBeDefined();
  });

  it("rejects an authority-root symlink before it can become import state", async () => {
    const realStateRoot = join(outside, "authority-real");
    const linkedStateRoot = join(outside, "authority-link");
    await mkdir(realStateRoot, { recursive: true });
    await writeFile(join(realStateRoot, "sentinel"), "authority-outside");
    await symlink(
      realStateRoot,
      linkedStateRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(readFile(join(linkedStateRoot, "sentinel"), "utf8")).resolves.toBe(
      "authority-outside",
    );

    await expect(
      planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir: linkedStateRoot,
      }),
    ).rejects.toMatchObject({ code: "symlink-escape" });
  });

  nativeIt("replaces a local source only from a server-captured CAS plan", async () => {
    const sharedStateDir = join(outside, "local-replace-server-state");
    const stateDir = join(sharedStateDir, "resource-import");
    await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const filesystemCapability = makeTestNativeFilesystemCapability({
      ownershipStore,
      readStage: async (stage) => ownershipStore.readPrivateStage!({ stage }),
    });
    const base = {
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      projectId: "project-local-replace",
      principalId: "principal-local-replace",
      workspaceId: "workspace-local-replace",
      ownershipStore,
      filesystemCapability,
    };
    const first = await planMossResourceImportImpl({
      ...base,
      localSource: {
        kind: "skill",
        sourceName: "review.md",
        contents: "---\nname: review\n---\nFirst version.\n",
      },
    });
    await expect(applyMossResourceImportImpl({ ...base, plan: first.plan })).resolves.toMatchObject(
      { status: "committed" },
    );

    const replacement = await planMossResourceImportImpl({
      ...base,
      localSource: {
        kind: "skill",
        sourceName: "review.md",
        contents: "---\nname: review\n---\nSecond version.\n",
        replaceExisting: true,
      },
    });
    expect(replacement.plan.operations[0]).toMatchObject({
      action: "replace",
      expectedBeforeHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(
      applyMossResourceImportImpl({ ...base, plan: replacement.plan }),
    ).resolves.toMatchObject({ status: "committed" });
    await expect(
      readFile(join(workspace, ".moss", "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toContain("Second version.");
  });

  posixDurabilityIt("keeps authority state private and outside the workspace", async () => {
    await mkdir(join(homeDir, ".claude", "skills", "private-state"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "skills", "private-state", "SKILL.md"),
      "Private state.\n",
    );
    const sharedStateDir = join(outside, "server-userdata");
    const stateDir = join(sharedStateDir, "resource-import");
    await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
    await chmod(sharedStateDir, 0o755);
    const siblingStatePath = join(sharedStateDir, "state.sqlite");
    const siblingSettingsPath = join(sharedStateDir, "settings.json");
    await writeFile(siblingStatePath, "shared sqlite placeholder\n", { mode: 0o644 });
    await writeFile(siblingSettingsPath, "shared settings placeholder\n", { mode: 0o644 });
    await chmod(siblingStatePath, 0o644);
    await chmod(siblingSettingsPath, 0o644);
    const planned = await planMossResourceImport({ cwd: workspace, homeDir, stateDir });

    expect((await lstat(stateDir)).isSymbolicLink()).toBe(false);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(sharedStateDir)).mode & 0o777).toBe(0o755);
    const snapshotPath = planned.plan.operations[0]?.snapshotPath;
    expect(snapshotPath).toBeDefined();
    expect((await stat(snapshotPath!)).mode & 0o777).toBe(0o600);

    const applied = await applyMossResourceImport({
      cwd: workspace,
      homeDir,
      stateDir,
      plan: planned.plan,
    });
    expect(applied.status).toBe("committed");
    const receiptName = (await readdir(join(stateDir, "receipts"))).find((name) =>
      name.endsWith(".json"),
    );
    expect(receiptName).toBeDefined();
    expect((await stat(join(stateDir, "receipts", receiptName!))).mode & 0o777).toBe(0o600);
    await expect(readFile(siblingStatePath, "utf8")).resolves.toBe("shared sqlite placeholder\n");
    await expect(readFile(siblingSettingsPath, "utf8")).resolves.toBe(
      "shared settings placeholder\n",
    );
    expect((await stat(siblingStatePath)).mode & 0o777).toBe(0o644);
    expect((await stat(siblingSettingsPath)).mode & 0o777).toBe(0o644);
    await expect(lstat(join(workspace, ".moss", "imports"))).rejects.toThrow();
  });

  it("inventories skills, plugins, and MCP JSON/TOML across the supported roots", async () => {
    await mkdir(join(workspace, ".codex", "skills", "release"), { recursive: true });
    await writeFile(
      join(workspace, ".codex", "skills", "release", "SKILL.md"),
      "---\nname: Release\nversion: 2.1.0\n---\nWrite release notes.\n",
    );
    await mkdir(join(homeDir, ".claude", "plugins", "review", ".claude-plugin"), {
      recursive: true,
    });
    await writeFile(
      join(homeDir, ".claude", "plugins", "review", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "review", version: "1.4.0" }),
    );
    await mkdir(join(workspace, ".cursor"), { recursive: true });
    await writeFile(
      join(workspace, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "node", args: ["server.js"] } } }),
    );
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(
      join(homeDir, ".codex", "config.toml"),
      '[mcp_servers."search"]\ncommand = "search-server"\n',
    );

    const result = await inventoryMossResourceImport({ cwd: workspace, homeDir });

    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "skill", provider: "codex", name: "Release" }),
        expect.objectContaining({ kind: "plugin", provider: "claude", name: "review" }),
        expect.objectContaining({ kind: "mcp", provider: "cursor", name: "docs" }),
        expect.objectContaining({ kind: "mcp", provider: "codex", name: "search" }),
      ]),
    );
    expect(result.resources.find((resource) => resource.name === "Release")?.sourceVersion).toBe(
      "2.1.0",
    );
  });

  it("reads YAML skill frontmatter without flattening nested metadata", async () => {
    await mkdir(join(workspace, ".codex", "skills", "review"), { recursive: true });
    await writeFile(
      join(workspace, ".codex", "skills", "review", "SKILL.md"),
      '---\r\nname: Real Review\r\nversion: "2.1: stable"\r\ndescription: >-\r\n  Use when: a pull request needs review\r\n  before merging.\r\ntags:\r\n  - review\r\nallowed-tools: [Read, Grep]\r\nmetadata:\r\n  name: Nested Review\r\n  description: Nested description\r\n---\r\nBody.\r\n',
    );

    const result = await inventoryMossResourceImport({ cwd: workspace, homeDir });

    expect(result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          provider: "codex",
          name: "Real Review",
          sourceVersion: "2.1: stable",
          description: "Use when: a pull request needs review before merging.",
        }),
      ]),
    );
  });

  it("normalizes and owns MCP names before trusting selectors", async () => {
    await mkdir(join(homeDir, ".cursor"), { recursive: true });
    const mcpServers: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(mcpServers, "__proto__", {
      enumerable: true,
      value: { command: "prototype-server" },
    });
    Object.assign(mcpServers, {
      Straße: { command: "straße-server" },
      Strasse: { command: "strasse-server" },
      prototype: { command: "prototype-server" },
      constructor: { command: "constructor-server" },
      "a/b": { command: "path-server" },
      ".": { command: "dot-server" },
      "\u202Ehidden": { command: "hidden-server" },
    });
    await writeFile(join(homeDir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers }));

    const result = await inventoryMossResourceImport({ cwd: workspace, homeDir });
    const names = result.resources
      .filter((resource) => resource.kind === "mcp")
      .map((resource) => resource.name);

    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid-identity" })]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining(["prototype", "constructor", "a/b", ".", "\u202Ehidden"]),
    );
    expect(names).not.toEqual(expect.arrayContaining(["Straße", "Strasse"]));
  });

  it("rejects MCP class, boxed, array, dangerous-key, and getter records", () => {
    class McpConfig {
      command = "node";
    }
    const getterRecord: Record<string, unknown> = {};
    Object.defineProperty(getterRecord, "command", {
      enumerable: true,
      get: () => "node",
    });
    const dangerousRecord: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(dangerousRecord, "__proto__", {
      enumerable: true,
      value: { command: "node" },
    });

    expect(isMossResourceImportPlainRecord({ command: "node" })).toBe(true);
    expect(isMossResourceImportPlainRecord(Object.create(null))).toBe(true);
    expect(isMossResourceImportPlainRecord(new McpConfig())).toBe(false);
    expect(isMossResourceImportPlainRecord(new String("node"))).toBe(false);
    expect(isMossResourceImportPlainRecord([{ command: "node" }])).toBe(false);
    expect(isMossResourceImportPlainRecord(dangerousRecord)).toBe(false);
    expect(isMossResourceImportPlainRecord(getterRecord)).toBe(false);
  });

  it("reports symlink escape without reading or copying the outside file", async () => {
    await mkdir(join(workspace, ".claude", "skills"), { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "secret outside content");
    const linkedSource = join(workspace, ".claude", "skills", "escape");
    await symlink(outside, linkedSource, process.platform === "win32" ? "junction" : "dir");
    await expect(readFile(join(linkedSource, "SKILL.md"), "utf8")).resolves.toBe(
      "secret outside content",
    );

    const result = await inventoryMossResourceImport({ cwd: workspace, homeDir });

    expect(result.resources.some((resource) => resource.name === "escape")).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "symlink-escape" })]),
    );
    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe("secret outside content");
  });

  posixDurabilityIt(
    "keeps dry-run inventory and plan read-only while flagging MCP secret fields and conflicts",
    async () => {
      await mkdir(join(workspace, ".cursor"), { recursive: true });
      await writeFile(
        join(workspace, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            docs: { command: "node", args: ["server.js"], env: { API_TOKEN: "secret-value" } },
          },
        }),
      );
      await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
      await writeFile(
        join(workspace, ".moss", "mcp", "config.json"),
        JSON.stringify({ mcpServers: { docs: { command: "existing" } } }),
      );

      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const plan = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });

      expect(inventory.resources[0]?.secretFields).toContain("mcpServers.docs.env.API_TOKEN");
      expect(plan.plan.operations[0]?.action).toBe("conflict");
      expect(await readFile(join(workspace, ".moss", "mcp", "config.json"), "utf8")).toContain(
        "existing",
      );
      await expect(readdir(join(workspace, ".moss", "imports"))).rejects.toThrow();
    },
  );

  it("rejects every non-empty MCP URL query before snapshot or plan durability", async () => {
    const urls = [
      "https://example.test/mcp?foo=credential",
      "https://example.test/mcp?token%3Dsynthetic-query-secret",
      "HTTPS://example.test/mcp?ToKeN%3dsynthetic-query-secret",
      "https://user:synthetic-query-secret@example.test/mcp?safe=1",
      "https://example.test/mcp?safe=1#synthetic-query-secret",
      'https://user:"synthetic-query-secret@example.test/mcp?foo=1',
    ];

    for (const [index, url] of urls.entries()) {
      const sharedStateDir = join(outside, `mcp-query-state-${index}`);
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      await writeFile(
        join(homeDir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { query: { url } } }),
      );

      const inventory = await inventoryMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
      });
      const resource = inventory.resources.find((candidate) => candidate.name === "query");
      expect(resource?.warnings).toContain("mcp-invalid-transport");

      let failure: unknown;
      try {
        await planMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir,
          resourceIds: resource ? [resource.id] : [],
        });
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toMatchObject({ code: "mcp-invalid-transport" });
      expect(JSON.stringify(failure)).not.toContain(url);
      expect(JSON.stringify(failure)).not.toContain("synthetic-query-secret");
      await expect(lstat(stateDir)).rejects.toThrow();
      await expect(lstat(join(workspace, ".moss", "mcp", "config.json"))).rejects.toThrow();
    }
  });

  posixDurabilityIt("keeps a query-free MCP URL transport as the legal baseline", async () => {
    const sharedStateDir = join(outside, "mcp-query-free-state");
    const stateDir = join(sharedStateDir, "resource-import");
    await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
    await mkdir(join(homeDir, ".cursor"), { recursive: true });
    await writeFile(
      join(homeDir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { queryFree: { url: "https://example.test/mcp" } } }),
    );

    const inventory = await inventoryMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
    });
    const resource = inventory.resources.find((candidate) => candidate.name === "queryFree");
    expect(resource?.warnings).not.toContain("mcp-invalid-transport");
    const planned = await planMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      resourceIds: resource ? [resource.id] : [],
    });
    expect(planned.plan.operations[0]?.action).toBe("merge");
  });

  posixDurabilityIt(
    "revalidates a frozen MCP plan with a newly introduced query before apply writes",
    async () => {
      const sharedStateDir = join(outside, "mcp-query-apply-state");
      const stateDir = join(sharedStateDir, "resource-import");
      await mkdir(sharedStateDir, { recursive: true, mode: 0o755 });
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      const sourcePath = join(homeDir, ".cursor", "mcp.json");
      await writeFile(
        sourcePath,
        JSON.stringify({ mcpServers: { queryApply: { url: "https://example.test/mcp" } } }),
      );
      const ownershipStore = testOwnershipStore(stateDir);
      const inventory = await inventoryMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        ownershipStore,
      });
      const resource = inventory.resources.find((candidate) => candidate.name === "queryApply");
      const planned = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        ownershipStore,
        resourceIds: resource ? [resource.id] : [],
      });

      const operation = planned.plan.operations[0]!;
      const forgedPlanId = "plan-forged-query";
      const forgedPlanNonce = `plan-nonce-${testSha256(forgedPlanId).slice(0, 32)}`;
      const queryPayload = JSON.stringify({
        mcpServers: {
          queryApply: { url: "https://example.test/mcp?token=synthetic-query-secret" },
        },
      });
      const querySha256 = testSha256(queryPayload);
      const authority = {
        canonicalRoot: resolve(getMossSourceLayout(workspace).root),
        stateRoot: resolve(stateDir),
        ownerId: planned.plan.ownerId,
        projectId: planned.plan.projectId,
        workspaceId: planned.plan.workspaceId,
        principalId: planned.plan.principalId,
        sessionId: planned.plan.sessionId,
        transactionId: `transaction-${testSha256(forgedPlanId).slice(0, 32)}`,
        operationId: `snapshot-${testSha256(
          stableTestJson({ kind: operation.kind, snapshotSha256: querySha256 }),
        ).slice(0, 32)}`,
        fencingToken: `plan-fence-${testSha256(forgedPlanNonce).slice(0, 32)}`,
        generation: `plan-generation-${testSha256(forgedPlanNonce).slice(0, 32)}`,
        nonce: forgedPlanNonce,
        kind: "mcp" as const,
        snapshotSha256: querySha256,
      };
      const stage = await ownershipStore.createPrivateStage({
        ...authority,
        createdAt: planned.plan.createdAt,
        leaseExpiresAt: planned.plan.expiresAt,
      });
      const stagePath = testStagePath(stage);
      await mkdir(stagePath, { mode: 0o700 });
      await writeFile(join(stagePath, "payload"), queryPayload, { mode: 0o600 });
      const manifest = {
        schemaVersion: 1 as const,
        kind: "mcp" as const,
        snapshotSha256: querySha256,
        entries: [
          { path: "mcp.json", sha256: querySha256, sizeBytes: Buffer.byteLength(queryPayload) },
        ],
      };
      await writeFile(join(stagePath, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
        mode: 0o600,
      });
      const published = await ownershipStore.publishPrivateSnapshot({
        stage,
        authority,
        kind: "mcp",
        snapshotKey: testSnapshotKeyForAuthority(authority),
        snapshotSha256: querySha256,
        manifest,
      });
      const forgedOperation = {
        ...operation,
        operationId: `operation-${testSha256(
          `${forgedPlanId}:${operation.resourceId}:${operation.targetPath}`,
        ).slice(0, 32)}`,
        sourceSha256: querySha256,
        snapshotPath: published.snapshotPath,
        snapshotSha256: querySha256,
      };
      const selectionSnapshotSha256 = testSha256(
        stableTestJson([
          {
            id: forgedOperation.resourceId,
            canonicalIdentityKey: forgedOperation.canonicalIdentityKey,
            sourcePath: resolve(forgedOperation.sourcePath),
            sourceSelector: forgedOperation.sourceSelector ?? null,
            sourceSha256: querySha256,
            snapshotPath: published.snapshotPath,
            snapshotSha256: querySha256,
            sourceVersion: forgedOperation.sourceVersion ?? null,
          },
        ]),
      );
      const { planHash: _planHash, ...unsignedPlan } = planned.plan;
      const forgedUnsignedPlan = {
        ...unsignedPlan,
        planId: forgedPlanId,
        nonce: forgedPlanNonce,
        selectedResourceIds: [forgedOperation.resourceId],
        operations: [forgedOperation],
        selectionSnapshotSha256,
        stateFingerprint: testStateFingerprint(
          workspace,
          planned.plan.workspaceId,
          selectionSnapshotSha256,
          stateDir,
        ),
      };
      const forgedPlan = {
        ...forgedUnsignedPlan,
        planHash: testSha256(stableTestJson(forgedUnsignedPlan)),
      };
      await registerMossResourceImportPlan({ ownershipStore, plan: forgedPlan });

      await expect(
        applyMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir,
          ownershipStore,
          filesystemCapability: testCapabilityForState(stateDir),
          plan: forgedPlan,
        }),
      ).rejects.toMatchObject({ code: "mcp-invalid-transport" });
      await expect(lstat(join(workspace, ".moss", "mcp", "config.json"))).rejects.toThrow();
    },
  );

  posixDurabilityIt(
    "copies only safe canonical resources and records an immutable receipt",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "release"), { recursive: true });
      const sourcePath = join(homeDir, ".claude", "skills", "release", "SKILL.md");
      await writeFile(sourcePath, "---\nname: Release\n---\nShip it.\n");
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const plan = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });

      const applied = await applyMossResourceImport({ cwd: workspace, homeDir, plan: plan.plan });

      expect(applied.status).toBe("committed");
      const targetPath = join(workspace, ".moss", "skills", "release", "SKILL.md");
      expect(await readFile(targetPath, "utf8")).toContain("Ship it.");
      expect(
        await readFile(
          join(getMossResourceImportStateRoot({ homeDir }), "provenance.json"),
          "utf8",
        ),
      ).toContain(sourcePath);
      expect(await readFile(sourcePath, "utf8")).toContain("Ship it.");

      const replayed = await applyMossResourceImport({ cwd: workspace, homeDir, plan: plan.plan });
      expect(replayed).toMatchObject({
        status: "committed",
        transactionId: applied.transactionId,
        planId: plan.plan.planId,
        receipt: {
          transactionId: applied.transactionId,
          planHash: plan.plan.planHash,
        },
      });

      const rolledBack = await rollbackMossResourceImport({
        cwd: workspace,
        homeDir,
        transactionId: applied.transactionId,
      });

      expect(rolledBack.status).toBe("rolled-back");
      expect(rolledBack.issues).toEqual([]);
      await expect(readFile(targetPath, "utf8")).rejects.toThrow();
      expect(await readFile(sourcePath, "utf8")).toContain("Ship it.");
    },
  );

  posixDurabilityIt(
    "rejects forged import plan content and cross-workspace plan references before CAS",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "registry-bound"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "registry-bound", "SKILL.md"),
        "Registry bound.\n",
      );
      const planned = await planMossResourceImport({ cwd: workspace, homeDir });
      const tampered = {
        ...planned.plan,
        operations: planned.plan.operations.map((operation, index) =>
          index === 0 ? { ...operation, targetPath: join(outside, "forged-target") } : operation,
        ),
      };
      await expect(
        applyMossResourceImport({ cwd: workspace, homeDir, plan: tampered }),
      ).rejects.toMatchObject({ code: "plan-invalid" });
      await expect(
        applyMossResourceImport({
          cwd: workspace,
          homeDir,
          workspaceId: "workspace-forged",
          plan: planned.plan,
        }),
      ).rejects.toMatchObject({ code: "authorization-required" });
      const forgedOperation = {
        ...planned.plan,
        operations: planned.plan.operations.map((operation, index) =>
          index === 0 ? { ...operation, operationId: "operation-forged" } : operation,
        ),
      };
      await expect(
        applyMossResourceImport({ cwd: workspace, homeDir, plan: forgedOperation }),
      ).rejects.toMatchObject({ code: "plan-invalid" });
      await expect(
        lstat(join(workspace, ".moss", "skills", "registry-bound", "SKILL.md")),
      ).rejects.toThrow();
    },
  );

  posixDurabilityIt(
    "blocks MCP literal secret fields, preserves the source, and writes no canonical config",
    async () => {
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      const sourcePath = join(homeDir, ".cursor", "mcp.json");
      await writeFile(
        sourcePath,
        JSON.stringify({
          mcpServers: {
            docs: {
              command: "node",
              args: ["server.js"],
              env: { API_TOKEN: "secret-value", SAFE_REF: "${SAFE_REF}" },
              headers: { Authorization: "Bearer very-secret-token-value" },
            },
          },
        }),
      );
      const original = await readFile(sourcePath, "utf8");
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "docs");
      expect(resource?.secretFields).toEqual(
        expect.arrayContaining([
          "mcpServers.docs.env.API_TOKEN",
          "mcpServers.docs.headers.Authorization",
        ]),
      );
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });

      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });
      expect(applied.status).toBe("blocked");
      await expect(readFile(join(workspace, ".moss", "mcp", "config.json"))).rejects.toThrow();
      expect(await readFile(sourcePath, "utf8")).toBe(original);
    },
  );

  posixDurabilityIt(
    "imports typed MCP references disabled and keeps nested enabled=false",
    async () => {
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      const sourcePath = join(homeDir, ".cursor", "mcp.json");
      await writeFile(
        sourcePath,
        JSON.stringify({
          mcpServers: {
            typed: {
              command: "node",
              args: ["server.js"],
              env: { SAFE_REF: "${SAFE_REF}" },
              headers: { Authorization: "${MCP_AUTH}" },
              nested: { enabled: false },
            },
          },
        }),
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "typed");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      expect(planned.plan.operations[0]?.action).toBe("merge");

      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });
      expect(applied.status).toBe("committed");
      const canonical = JSON.parse(
        await readFile(join(workspace, ".moss", "mcp", "config.json"), "utf8"),
      ) as { mcpServers: Record<string, Record<string, unknown>> };
      expect(canonical.mcpServers.typed).toMatchObject({
        enabled: false,
        env: { SAFE_REF: "${SAFE_REF}" },
        headers: { Authorization: "${MCP_AUTH}" },
        nested: { enabled: false },
      });
      await expect(
        rollbackMossResourceImport({
          cwd: workspace,
          homeDir,
          transactionId: applied.transactionId,
        }),
      ).resolves.toMatchObject({ status: "partial" });
    },
  );

  posixDurabilityIt(
    "copies a plugin directory without copying a secret manifest field",
    async () => {
      const pluginRoot = join(homeDir, ".codex", "plugins", "safe-plugin");
      await mkdir(pluginRoot, { recursive: true });
      await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
      const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify({ name: "Safe Plugin", version: "3.0.0", apiKey: "secret-value" }),
      );
      await writeFile(join(pluginRoot, "README.md"), "A safe plugin.");
      const originalManifest = await readFile(manifestPath, "utf8");

      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find(
        (candidate) => candidate.kind === "plugin" && candidate.name === "Safe Plugin",
      );
      expect(resource).toBeDefined();
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });

      expect(applied.status).toBe("committed");
      const targetManifest = await readFile(
        join(workspace, ".moss", "plugins", "safe-plugin", ".codex-plugin", "plugin.json"),
        "utf8",
      );
      expect(targetManifest).toContain("Safe Plugin");
      expect(targetManifest).not.toContain("secret-value");
      expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);

      const catalog = await discoverMossPluginCatalog({ cwd: workspace });
      expect(catalog.marketplace?.plugins).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Safe Plugin" })]),
      );
      const canonicalManifest = JSON.parse(
        await readFile(join(workspace, ".moss", "plugins", "safe-plugin", "plugin.json"), "utf8"),
      ) as { committed?: boolean };
      expect(canonicalManifest.committed).toBe(true);
    },
  );

  posixDurabilityIt(
    "fails closed when the canonical plugin parent is replaced by a symlink before copy",
    async () => {
      const pluginRoot = join(homeDir, ".codex", "plugins", "fresh-plugin");
      await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "Fresh Plugin" }),
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "Fresh Plugin");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      const movedParent = join(outside, "moved-plugins");
      let sabotaged = false;
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        checkpointHook: async ({ state, kind }) => {
          if (sabotaged || state !== "applying" || kind !== "plugin") return;
          sabotaged = true;
          await mkdir(join(workspace, ".moss", "plugins"), { recursive: true });
          await rename(join(workspace, ".moss", "plugins"), movedParent);
          await symlink(movedParent, join(workspace, ".moss", "plugins"));
        },
      });

      expect(applied.status).toBe("partial");
      expect(applied.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "symlink-escape" })]),
      );
      await expect(readFile(join(movedParent, "fresh-plugin", "plugin.json"))).rejects.toThrow();
    },
  );

  posixDurabilityIt(
    "applies only the sealed snapshot after a live source parent replacement",
    async () => {
      const sourceDir = join(homeDir, ".claude", "skills", "source-race");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "SKILL.md"), "---\nname: Source Race\n---\nSource.\n");
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "Source Race");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      const movedSource = join(outside, "moved-source-race");
      let sabotaged = false;
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        checkpointHook: async ({ state, kind }) => {
          if (sabotaged || state !== "applying" || kind !== "skill") return;
          sabotaged = true;
          await rename(sourceDir, movedSource);
          await symlink(movedSource, sourceDir);
        },
      });

      expect(applied.status).toBe("committed");
      await expect(
        readFile(join(workspace, ".moss", "skills", "source-race", "SKILL.md"), "utf8"),
      ).resolves.toContain("Source.");
      expect(await readFile(join(movedSource, "SKILL.md"), "utf8")).toContain("Source.");
    },
  );

  posixDurabilityIt(
    "applies the sealed plugin snapshot after an in-place source edit",
    async () => {
      const pluginRoot = join(homeDir, ".codex", "plugins", "snapshot-race");
      await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "Snapshot Race" }),
      );
      const sourceFile = join(pluginRoot, "README.md");
      await writeFile(sourceFile, "sealed source\n");
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "Snapshot Race");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      await writeFile(sourceFile, "live source changed\n");

      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });

      expect(applied.status).toBe("committed");
      await expect(
        readFile(join(workspace, ".moss", "plugins", "snapshot-race", "README.md"), "utf8"),
      ).resolves.toBe("sealed source\n");
    },
  );

  posixDurabilityIt(
    "does not overwrite a plugin target that appears after the WAL intent",
    async () => {
      const pluginRoot = join(homeDir, ".codex", "plugins", "target-race");
      await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "Target Race" }),
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "Target Race");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      const target = join(workspace, ".moss", "plugins", "target-race");
      let injected = false;
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        checkpointHook: async ({ state, kind }) => {
          if (injected || state !== "applying" || kind !== "plugin") return;
          injected = true;
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "external.txt"), "external writer\n");
        },
      });

      expect(applied.status).toBe("partial");
      expect(applied.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "concurrent-modification" })]),
      );
      expect(await readFile(join(target, "external.txt"), "utf8")).toBe("external writer\n");
      await expect(readFile(join(target, "plugin.json"))).rejects.toThrow();
    },
  );

  posixDurabilityIt(
    "does not overwrite an MCP config written by an external writer after intent",
    async () => {
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      await writeFile(
        join(homeDir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { targetRace: { command: "node", args: ["source.js"] } } }),
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "targetRace");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      const target = join(workspace, ".moss", "mcp", "config.json");
      let injected = false;
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        checkpointHook: async ({ state, kind }) => {
          if (injected || state !== "applying" || kind !== "mcp") return;
          injected = true;
          await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
          await writeFile(
            target,
            JSON.stringify({ mcpServers: { external: { command: "external" } } }),
          );
        },
      });

      expect(applied.status).toBe("rolled-back");
      expect(applied.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "concurrent-modification" })]),
      );
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
        mcpServers: { external: { command: "external" } },
      });
    },
  );

  posixDurabilityIt(
    "fails closed when an external writer appears before JSON replacement",
    async () => {
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      await writeFile(
        join(homeDir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { imported: { command: "node", args: ["source.js"] } } }),
      );
      const target = join(workspace, ".moss", "mcp", "config.json");
      await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
      await writeFile(
        target,
        JSON.stringify({ mcpServers: { existing: { command: "existing" } } }),
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "imported");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      let injected = false;
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        beforeFilesystemMutation: async ({
          action,
          path,
        }: {
          readonly action: string;
          readonly path: string;
        }) => {
          if (injected || action !== "before-replace" || path !== target) return;
          injected = true;
          await writeFile(
            target,
            JSON.stringify({ mcpServers: { external: { command: "external" } } }),
          );
        },
      } as never);

      expect(injected).toBe(true);
      expect(applied.status).toBe("partial");
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
        mcpServers: { external: { command: "external" } },
      });
    },
  );

  posixDurabilityIt(
    "fails closed when an external writer appears before canonical removal",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "remove-race"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "remove-race", "SKILL.md"),
        "---\nname: Remove Race\n---\nOriginal.\n",
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });
      const target = join(workspace, ".moss", "skills", "remove-race", "SKILL.md");
      let injected = false;
      const rolledBack = await rollbackMossResourceImport({
        cwd: workspace,
        homeDir,
        transactionId: applied.transactionId,
        beforeFilesystemMutation: async ({
          action,
          path,
        }: {
          readonly action: string;
          readonly path: string;
        }) => {
          if (injected || action !== "before-remove" || path !== target) return;
          injected = true;
          await writeFile(target, "external writer wins\n");
        },
      } as never);

      expect(injected).toBe(true);
      expect(rolledBack.status).toBe("partial");
      expect(await readFile(target, "utf8")).toBe("external writer wins\n");
    },
  );

  posixDurabilityIt(
    "does not steal an expired workspace lock without a safe owner handoff",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "stale-lock"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "stale-lock", "SKILL.md"),
        "Stale lock.\n",
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });
      const stateRoot = getMossResourceImportStateRoot({ homeDir });
      await mkdir(stateRoot, { recursive: true });
      const lockPath = join(stateRoot, ".lock");
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 999_999_999,
          token: "stale-owner-token",
          acquiredAt: "2020-01-01T00:00:00.000Z",
          leaseExpiresAt: "2020-01-01T00:00:01.000Z",
        }),
      );

      await expect(
        applyMossResourceImport({ cwd: workspace, homeDir, plan: planned.plan }),
      ).rejects.toMatchObject({
        code: "concurrent-modification",
      });
      await expect(
        readFile(join(workspace, ".moss", "skills", "stale-lock", "SKILL.md")),
      ).rejects.toThrow();
      expect(await readFile(lockPath, "utf8")).toContain("stale-owner-token");
    },
  );

  posixDurabilityIt(
    "persists an intent before each skill, plugin, and MCP commit and recovers the fault",
    async () => {
      const cases = [
        {
          kind: "skill" as const,
          provider: "claude" as const,
          name: "Fault Skill",
          path: "fault-skill",
        },
        {
          kind: "plugin" as const,
          provider: "codex" as const,
          name: "Fault Plugin",
          path: "fault-plugin",
        },
        { kind: "mcp" as const, provider: "cursor" as const, name: "faultMcp", path: "fault-mcp" },
      ];
      await mkdir(join(homeDir, ".claude", "skills", "fault-skill"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "fault-skill", "SKILL.md"),
        "---\nname: Fault Skill\n---\nFault skill.\n",
      );
      await mkdir(join(homeDir, ".codex", "plugins", "fault-plugin", ".codex-plugin"), {
        recursive: true,
      });
      await writeFile(
        join(homeDir, ".codex", "plugins", "fault-plugin", ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "Fault Plugin" }),
      );
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      await writeFile(
        join(homeDir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { faultMcp: { command: "node", args: ["fault.js"] } } }),
      );

      for (const testCase of cases) {
        const inventory = await inventoryMossResourceImport({
          cwd: workspace,
          homeDir,
          providers: [testCase.provider],
          kinds: [testCase.kind],
        });
        const resource = inventory.resources.find((candidate) => candidate.name === testCase.name);
        const planned = await planMossResourceImport({
          cwd: workspace,
          homeDir,
          providers: [testCase.provider],
          kinds: [testCase.kind],
          resourceIds: resource ? [resource.id] : [],
        });
        let faulted = false;
        const applied = await applyMossResourceImport({
          cwd: workspace,
          homeDir,
          plan: planned.plan,
          checkpointHook: ({ state, kind }) => {
            if (!faulted && state === "applying" && kind === testCase.kind) {
              faulted = true;
              throw new Error("fault-injected-before-commit");
            }
          },
        });
        expect(applied.status).toBe("rolled-back");
        expect(faulted).toBe(true);
        const target =
          testCase.kind === "mcp"
            ? join(workspace, ".moss", "mcp", "config.json")
            : join(
                workspace,
                ".moss",
                testCase.kind === "skill" ? "skills" : "plugins",
                testCase.path,
                testCase.kind === "skill" ? "SKILL.md" : "plugin.json",
              );
        await expect(readFile(target)).rejects.toThrow();
      }
    },
  );

  posixDurabilityIt(
    "uses the sealed plugin snapshot when source content changes in place",
    async () => {
      const pluginRoot = join(homeDir, ".codex", "plugins", "content-race");
      await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "Content Race" }),
      );
      const readmePath = join(pluginRoot, "README.md");
      await writeFile(readmePath, "original content\n");
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "Content Race");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });
      let mutated = false;
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        checkpointHook: async ({ state, kind }) => {
          if (mutated || state !== "applying" || kind !== "plugin") return;
          mutated = true;
          await writeFile(readmePath, "mutated in place\n");
        },
      });

      expect(mutated).toBe(true);
      expect(applied.status).toBe("committed");
      await expect(
        readFile(join(workspace, ".moss", "plugins", "content-race", "README.md"), "utf8"),
      ).resolves.toBe("original content\n");
      expect(await readFile(readmePath, "utf8")).toBe("mutated in place\n");
    },
  );

  posixDurabilityIt(
    "does not treat user-visible provenance deletion as rollback authorization",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "provenance-delete"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "provenance-delete", "SKILL.md"),
        "---\nname: Provenance Delete\n---\nKeep.\n",
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });
      const target = join(workspace, ".moss", "skills", "provenance-delete", "SKILL.md");
      await mkdir(join(workspace, ".moss", "imports"), { recursive: true });
      const visibleProvenance = join(workspace, ".moss", "imports", "provenance.json");
      await writeFile(visibleProvenance, "user-visible index\n");
      await rm(visibleProvenance);

      const rolledBack = await rollbackMossResourceImport({
        cwd: workspace,
        homeDir,
        transactionId: applied.transactionId,
      });

      expect(rolledBack.status).toBe("rolled-back");
      expect(rolledBack.issues).toEqual([]);
      await expect(readFile(target, "utf8")).rejects.toThrow();
    },
  );

  it("counts empty plugin directories toward the tree limit", async () => {
    const pluginRoot = join(homeDir, ".codex", "plugins", "empty-tree");
    await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "Empty Tree" }),
    );
    await mkdir(join(pluginRoot, "empty-a"), { recursive: true });
    await mkdir(join(pluginRoot, "empty-b", "nested"), { recursive: true });

    const inventory = await inventoryMossResourceImport({
      cwd: workspace,
      homeDir,
      maxTreeEntries: 1,
    });

    expect(inventory.resources.some((resource) => resource.name === "Empty Tree")).toBe(false);
    expect(inventory.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "limit-exceeded" })]),
    );
  });

  posixDurabilityIt("rejects a canonical hash byte limit before creating a target", async () => {
    await mkdir(join(homeDir, ".claude", "skills", "large-hash"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "skills", "large-hash", "SKILL.md"),
      "---\nname: Large Hash\n---\nThis exceeds a one-byte hash budget.\n",
    );
    const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
    const planned = await planMossResourceImport({
      cwd: workspace,
      homeDir,
      resourceIds: inventory.resources.map((resource) => resource.id),
    });

    const applied = await applyMossResourceImport({
      cwd: workspace,
      homeDir,
      plan: planned.plan,
      maxHashBytes: 1,
    });

    expect(applied.status).toBe("rolled-back");
    expect(applied.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "limit-exceeded" })]),
    );
    await expect(
      readFile(join(workspace, ".moss", "skills", "large-hash", "SKILL.md")),
    ).rejects.toThrow();

    const pluginRoot = join(homeDir, ".codex", "plugins", "deep-hash");
    await mkdir(join(pluginRoot, ".codex-plugin", "nested"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "Deep Hash" }),
    );
    await writeFile(join(pluginRoot, ".codex-plugin", "nested", "README.md"), "nested\n");
    const pluginInventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
    const plugin = pluginInventory.resources.find((resource) => resource.name === "Deep Hash");
    const pluginPlan = await planMossResourceImport({
      cwd: workspace,
      homeDir,
      resourceIds: plugin ? [plugin.id] : [],
    });
    const pluginApplied = await applyMossResourceImport({
      cwd: workspace,
      homeDir,
      plan: pluginPlan.plan,
      maxHashDepth: 0,
    });
    expect(pluginApplied.status).toBe("rolled-back");
    expect(pluginApplied.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "limit-exceeded" })]),
    );
    await expect(
      readFile(join(workspace, ".moss", "plugins", "deep-hash", "plugin.json")),
    ).rejects.toThrow();
  });

  it("does not treat an unknown manifest as an importable or executable plugin", async () => {
    const pluginRoot = join(homeDir, ".codex", "plugins", "unknown-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, "manifest.yaml"),
      "name: unknown\ncommand: touch should-not-run\n",
    );
    await writeFile(join(pluginRoot, "run.sh"), "touch should-not-run\n");

    const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });

    expect(
      inventory.resources.some(
        (resource) => resource.kind === "plugin" && resource.name === "unknown-plugin",
      ),
    ).toBe(false);
    await expect(readFile(join(workspace, "should-not-run"))).rejects.toThrow();
  });

  it("rejects a traversal transaction id before opening a journal", async () => {
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep");

    await expect(
      rollbackMossResourceImport({
        cwd: workspace,
        homeDir,
        transactionId: "../outside/sentinel",
      }),
    ).rejects.toBeInstanceOf(MossResourceImportError);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  posixDurabilityIt(
    "does not treat a forged or symlinked workspace imports directory as authority",
    async () => {
      const sourceDir = join(homeDir, ".claude", "skills", "imports-authority");
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "SKILL.md"), "---\nname: Imports Authority\n---\nSafe.\n");
      const externalImports = join(outside, "imports-authority");
      await mkdir(externalImports, { recursive: true });
      await writeFile(join(externalImports, "sentinel"), "keep");
      await mkdir(join(workspace, ".moss"), { recursive: true });
      await symlink(externalImports, join(workspace, ".moss", "imports"));
      await writeFile(join(externalImports, "transaction-forged.json"), "not a journal");

      const planned = await planMossResourceImport({ cwd: workspace, homeDir });
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });

      expect(applied.status).toBe("committed");
      await expect(
        readFile(join(workspace, ".moss", "skills", "imports-authority", "SKILL.md"), "utf8"),
      ).resolves.toContain("Safe.");
      await expect(readFile(join(externalImports, "sentinel"), "utf8")).resolves.toBe("keep");

      await rm(join(workspace, ".moss", "imports"), { recursive: true, force: true });
      await writeFile(join(workspace, ".moss", "imports"), "forged visible index");
      const rolledBack = await rollbackMossResourceImport({
        cwd: workspace,
        homeDir,
        transactionId: applied.transactionId,
      });
      expect(rolledBack.status).toBe("rolled-back");
      await expect(
        readFile(join(workspace, ".moss", "skills", "imports-authority", "SKILL.md")),
      ).rejects.toThrow();
      await expect(readFile(join(externalImports, "sentinel"), "utf8")).resolves.toBe("keep");
      await expect(readFile(join(workspace, ".moss", "imports"), "utf8")).resolves.toBe(
        "forged visible index",
      );
    },
  );

  it("fails closed when a forged journal targets an external sentinel", async () => {
    const sentinel = join(outside, "external-sentinel.txt");
    await writeFile(sentinel, "external sentinel");
    const sentinelHash = createHash("sha256").update("external sentinel").digest("hex");
    const workspaceId = `workspace-${createHash("sha256")
      .update(workspace)
      .digest("hex")
      .slice(0, 32)}`;
    const stateRoot = getMossResourceImportStateRoot({ homeDir });
    const sourcePath = join(homeDir, ".claude", "skills", "forged", "SKILL.md");
    const journalPath = join(stateRoot, "transactions", "transaction-forged.json");
    await mkdir(join(stateRoot, "transactions"), { recursive: true, mode: 0o700 });
    const forgedJournal = {
      schemaVersion: 3,
      transactionId: "transaction-forged",
      planId: "plan-forged",
      issuer: testBindings.issuer,
      ownerId: testBindings.ownerId,
      projectId: workspaceId,
      principalId: testBindings.ownerId,
      sessionId: testBindings.sessionId,
      workspaceId,
      cwd: workspace,
      canonicalRoot: join(workspace, ".moss"),
      planHash: "a".repeat(64),
      selectionSnapshotSha256: "b".repeat(64),
      stateRoot,
      stateFingerprint: testStateFingerprint(workspace, workspaceId, "b".repeat(64), stateRoot),
      nonce: "transaction-nonce-forged",
      previousHash: createHash("sha256")
        .update("moss-resource-import:journal:v3:genesis")
        .digest("hex"),
      expiresAt: "2099-08-07T01:02:03.000Z",
      sequence: 0,
      createdAt: "2026-08-06T01:02:03.000Z",
      updatedAt: "2026-08-06T01:02:04.000Z",
      state: "committed",
      changes: [
        {
          operationId: "operation-forged",
          phase: "applied",
          kind: "skill",
          provider: "claude",
          scope: "user",
          name: "forged",
          canonicalIdentityKey: "identity-forged",
          sourcePath,
          sourceSha256: "c".repeat(64),
          snapshotPath: join(stateRoot, "blobs", "sha256", "c".repeat(64)),
          snapshotSha256: "c".repeat(64),
          targetPath: sentinel,
          beforeHash: createHash("sha256").update("missing").digest("hex"),
          expectedHash: sentinelHash,
          afterHash: sentinelHash,
        },
      ],
    };
    await writeFile(
      journalPath,
      JSON.stringify({ ...forgedJournal, recordHash: testJournalRecordHash(forgedJournal) }),
    );
    await writeFile(
      join(stateRoot, "provenance.json"),
      JSON.stringify({
        schemaVersion: 3,
        records: [
          {
            schemaVersion: 3,
            transactionId: "transaction-forged",
            planId: "plan-forged",
            planHash: "a".repeat(64),
            selectionSnapshotSha256: "b".repeat(64),
            operationId: "operation-forged",
            stateFingerprint: forgedJournal.stateFingerprint,
            stateRoot,
            issuer: testBindings.issuer,
            ownerId: testBindings.ownerId,
            projectId: workspaceId,
            principalId: testBindings.ownerId,
            workspaceId,
            sessionId: testBindings.sessionId,
            cwd: workspace,
            kind: "skill",
            provider: "claude",
            scope: "user",
            name: "forged",
            canonicalIdentityKey: "identity-forged",
            sourcePath,
            sourceSha256: "c".repeat(64),
            snapshotPath: join(stateRoot, "blobs", "sha256", "c".repeat(64)),
            snapshotSha256: "c".repeat(64),
            targetPath: sentinel,
            targetHash: sentinelHash,
            expiresAt: forgedJournal.expiresAt,
            importedAt: "2026-08-06T01:02:04.000Z",
            redactedFields: [],
          },
        ],
      }),
    );

    const rolledBack = await rollbackMossResourceImport({
      cwd: workspace,
      homeDir,
      transactionId: "transaction-forged",
    });

    expect(rolledBack.status).toBe("partial");
    expect(rolledBack.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "path-traversal" })]),
    );
    await expect(readFile(sentinel, "utf8")).resolves.toBe("external sentinel");
  });

  posixDurabilityIt(
    "quarantines imported MCP servers and rejects literal header/env values",
    async () => {
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      await writeFile(
        join(homeDir, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            docs: {
              command: "node",
              args: ["server.js"],
              env: { SAFE_REF: "${SAFE_REF}", LITERAL: "must-not-import" },
              headers: { Authorization: "${MCP_AUTH}", "X-Static": "literal" },
              nested: { enabled: false },
            },
          },
        }),
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "docs");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });

      expect(planned.plan.operations[0]?.action).toBe("blocked");
      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      });
      expect(applied.status).toBe("blocked");
      await expect(readFile(join(workspace, ".moss", "mcp", "config.json"))).rejects.toThrow();
    },
  );

  it("limits the number of MCP servers independently from file size", async () => {
    await mkdir(join(homeDir, ".cursor"), { recursive: true });
    await writeFile(
      join(homeDir, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          one: { command: "node", args: ["one.js"] },
          two: { command: "node", args: ["two.js"] },
        },
      }),
    );

    const inventory = await inventoryMossResourceImport({
      cwd: workspace,
      homeDir,
      maxMcpServers: 1,
    } as never);

    expect(inventory.resources.filter((resource) => resource.kind === "mcp")).toHaveLength(1);
    expect(inventory.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "limit-exceeded" })]),
    );
  });

  it("enforces hard total limits for skills, directories, plans, and results", async () => {
    for (const [directory, name] of [
      ["one", "One"],
      ["two", "Two"],
    ] as const) {
      await mkdir(join(homeDir, ".claude", "skills", directory, "empty"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", directory, "SKILL.md"),
        `---\nname: ${name}\n---\n${name}\n`,
      );
    }
    const inventory = await inventoryMossResourceImport({
      cwd: workspace,
      homeDir,
      maxSkills: 1,
      maxDirectories: 1,
    } as never);
    expect(inventory.resources.filter((resource) => resource.kind === "skill")).toHaveLength(1);
    expect(inventory.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "limit-exceeded" })]),
    );

    const planned = await planMossResourceImport({
      cwd: workspace,
      homeDir,
      resourceIds: inventory.resources.map((resource) => resource.id),
      maxPlanOperations: 0,
    } as never);
    expect(planned.plan.operations).toHaveLength(0);
    expect(planned.plan.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "limit-exceeded" })]),
    );
  });

  posixDurabilityIt("reserves the Moss control-plane MCP identity", async () => {
    await mkdir(join(homeDir, ".cursor"), { recursive: true });
    await writeFile(
      join(homeDir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { Moss: { command: "node", args: ["server.js"] } } }),
    );
    const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
    const resource = inventory.resources.find((candidate) => candidate.name === "Moss");
    const planned = await planMossResourceImport({
      cwd: workspace,
      homeDir,
      resourceIds: resource ? [resource.id] : [],
    });

    expect(planned.plan.operations[0]?.action).toBe("blocked");
    expect(planned.plan.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "reserved-identity" })]),
    );
  });

  posixDurabilityIt(
    "selects one canonical owner for case-folded and Unicode-confusable names",
    async () => {
      for (const [directory, name] of [
        ["foo-bar", "Foo Bar"],
        ["foo-bar-copy", "foo-bar"],
        ["pay", "Pay"],
        ["cyrillic-pay", "Рay"],
      ] as const) {
        await mkdir(join(homeDir, ".claude", "skills", directory), { recursive: true });
        await writeFile(
          join(homeDir, ".claude", "skills", directory, "SKILL.md"),
          `---\nname: ${name}\n---\n${name}\n`,
        );
      }
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });

      expect(
        planned.plan.operations.filter((operation) => operation.action === "conflict").length,
      ).toBe(2);
      expect(planned.plan.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "conflict" })]),
      );
    },
  );

  posixDurabilityIt(
    "uses the same canonical MCP identity for existing Foo and incoming foo",
    async () => {
      await mkdir(join(homeDir, ".cursor"), { recursive: true });
      await writeFile(
        join(homeDir, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { foo: { command: "node", args: ["incoming.js"] } } }),
      );
      await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
      const target = join(workspace, ".moss", "mcp", "config.json");
      await writeFile(
        target,
        JSON.stringify({ mcpServers: { Foo: { command: "node", args: ["existing.js"] } } }),
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const resource = inventory.resources.find((candidate) => candidate.name === "foo");
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: resource ? [resource.id] : [],
      });

      expect(planned.plan.operations[0]?.action).toBe("conflict");
      await expect(
        applyMossResourceImport({ cwd: workspace, homeDir, plan: planned.plan }),
      ).resolves.toMatchObject({
        status: "blocked",
      });
      expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
        mcpServers: { Foo: { command: "node", args: ["existing.js"] } },
      });
    },
  );

  posixDurabilityIt(
    "rejects a plan issued to session A when session B tries to apply it",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "session-plan"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "session-plan", "SKILL.md"),
        "Session plan.\n",
      );
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        ownerId: "same-owner",
        issuer: "moss-server",
        sessionId: "session-a",
      } as never);

      await expect(
        applyMossResourceImport({
          cwd: workspace,
          homeDir,
          plan: planned.plan,
          ownerId: "same-owner",
          issuer: "moss-server",
          sessionId: "session-b",
        } as never),
      ).rejects.toMatchObject({ code: "authorization-required" });
      await expect(
        readFile(join(workspace, ".moss", "skills", "session-plan", "SKILL.md")),
      ).rejects.toThrow();
    },
  );

  posixDurabilityIt("rejects an expired plan before any filesystem mutation", async () => {
    await mkdir(join(homeDir, ".claude", "skills", "expired-plan"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "skills", "expired-plan", "SKILL.md"),
      "Expired plan.\n",
    );
    let now = new Date("2026-08-07T00:00:00.000Z");
    const planned = await planMossResourceImport({
      cwd: workspace,
      homeDir,
      now: () => now,
      planTtlMillis: 1_000,
    } as never);
    now = new Date("2026-08-07T00:00:02.000Z");

    await expect(
      applyMossResourceImport({
        cwd: workspace,
        homeDir,
        now: () => now,
        plan: planned.plan,
      } as never),
    ).rejects.toMatchObject({ code: "plan-expired" });
    await expect(
      readFile(join(workspace, ".moss", "skills", "expired-plan", "SKILL.md")),
    ).rejects.toThrow();
  });

  posixDurabilityIt("fails closed when directory durability cannot be confirmed", async () => {
    await mkdir(join(homeDir, ".claude", "skills", "fsync-failure"), { recursive: true });
    await writeFile(
      join(homeDir, ".claude", "skills", "fsync-failure", "SKILL.md"),
      "Fsync failure.\n",
    );
    const planned = await planMossResourceImport({ cwd: workspace, homeDir });

    const applied = await applyMossResourceImport({
      cwd: workspace,
      homeDir,
      plan: planned.plan,
      directorySyncHook: async () => {
        throw new Error("fsync-injected");
      },
    } as never);

    expect(applied.status).toBe("partial");
    expect(applied.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "durability-unsupported" })]),
    );
  });

  posixDurabilityIt(
    "does not let Unicode casefold gaps or emoji-only names abort the whole plan",
    async () => {
      for (const [directory, name] of [
        ["strasse", "Straße"],
        ["strasse-ascii", "Strasse"],
        ["emoji", "😀"],
        ["safe", "Safe Name"],
      ] as const) {
        await mkdir(join(homeDir, ".claude", "skills", directory), { recursive: true });
        await writeFile(
          join(homeDir, ".claude", "skills", directory, "SKILL.md"),
          `---\nname: ${name}\n---\n${name}\n`,
        );
      }

      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });

      expect(planned.plan.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "invalid-identity" })]),
      );
      expect(
        planned.plan.operations.find((operation) => operation.name === "Safe Name")?.action,
      ).toBe("copy");
      expect(
        planned.plan.operations.filter((operation) => operation.name === "Straße").length,
      ).toBe(1);
      expect(planned.plan.operations.find((operation) => operation.name === "😀")?.action).toBe(
        "blocked",
      );
    },
  );

  it("rejects journal owner, workspace, and cwd mismatches without mutating targets", async () => {
    const workspaceId = `workspace-${createHash("sha256")
      .update(workspace)
      .digest("hex")
      .slice(0, 32)}`;
    const stateRoot = getMossResourceImportStateRoot({ homeDir });
    const base = {
      schemaVersion: 3,
      planId: "plan-binding",
      issuer: testBindings.issuer,
      workspaceId,
      sessionId: testBindings.sessionId,
      ownerId: testBindings.ownerId,
      projectId: workspaceId,
      principalId: testBindings.ownerId,
      canonicalRoot: join(workspace, ".moss"),
      planHash: "a".repeat(64),
      selectionSnapshotSha256: "b".repeat(64),
      stateRoot,
      stateFingerprint: testStateFingerprint(workspace, workspaceId, "b".repeat(64), stateRoot),
      nonce: "transaction-nonce-binding",
      previousHash: createHash("sha256")
        .update("moss-resource-import:journal:v3:genesis")
        .digest("hex"),
      expiresAt: "2099-08-07T01:02:03.000Z",
      sequence: 0,
      createdAt: "2026-08-06T01:02:03.000Z",
      updatedAt: "2026-08-06T01:02:04.000Z",
      state: "committed",
      changes: [],
    } as const;
    await mkdir(join(stateRoot, "transactions"), { recursive: true, mode: 0o700 });
    for (const [transactionId, mismatch] of [
      ["transaction-owner", { ownerId: "other-owner", workspaceId, cwd: workspace }],
      [
        "transaction-workspace",
        { ownerId: testBindings.ownerId, workspaceId: "workspace-other", cwd: workspace },
      ],
      ["transaction-cwd", { ownerId: testBindings.ownerId, workspaceId, cwd: outside }],
    ] as const) {
      const journal = {
        ...base,
        transactionId,
        ownerId: mismatch.ownerId,
        workspaceId: mismatch.workspaceId,
        cwd: mismatch.cwd,
      };
      await writeFile(
        join(stateRoot, "transactions", `${transactionId}.json`),
        JSON.stringify({ ...journal, recordHash: testJournalRecordHash(journal) }),
      );
    }

    for (const transactionId of ["transaction-owner", "transaction-workspace", "transaction-cwd"]) {
      const result = await rollbackMossResourceImport({
        cwd: workspace,
        homeDir,
        transactionId,
      });
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "authorization-required" })]),
      );
    }
  });

  posixDurabilityIt("does not lose concurrent MCP additions", async () => {
    await mkdir(join(homeDir, ".cursor"), { recursive: true });
    await writeFile(
      join(homeDir, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { command: "node", args: ["docs.js"] },
          search: { command: "node", args: ["search.js"] },
        },
      }),
    );
    const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
    const selected = inventory.resources.filter((resource) =>
      ["docs", "search"].includes(resource.name),
    );
    const plannedResults = await Promise.all(
      selected.map((resource) =>
        planMossResourceImport({ cwd: workspace, homeDir, resourceIds: [resource.id] }),
      ),
    );
    const applied = await Promise.all(
      plannedResults.map((plannedResult) =>
        applyMossResourceImport({ cwd: workspace, homeDir, plan: plannedResult.plan }),
      ),
    );

    const canonical = JSON.parse(
      await readFile(join(workspace, ".moss", "mcp", "config.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(canonical.mcpServers)).toHaveLength(2);
    expect(Object.keys(canonical.mcpServers)).toEqual(expect.arrayContaining(["docs", "search"]));
    expect(applied.every((result) => result.status === "committed")).toBe(true);
  });

  posixDurabilityIt(
    "fails closed for catalog selections without a valid short-lived ticket",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "release"), { recursive: true });
      await writeFile(join(homeDir, ".claude", "skills", "release", "SKILL.md"), "Ship it.\n");

      await expect(
        planMossResourceImport({
          cwd: workspace,
          homeDir,
          workspaceId: "project-1",
          selectionOrigin: "catalog",
          selectionTicket: "opaque-ticket",
          selectionTicketVerifier: {
            verify: async () => ({ valid: false as const, code: "ticket-expired" as const }),
          },
        }),
      ).rejects.toMatchObject({ code: "ticket-expired" });
    },
  );

  posixDurabilityIt(
    "binds ticket consumption to the private plan and does not re-consume a committed replay",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "consumed-ticket"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "consumed-ticket", "SKILL.md"),
        "Consumed ticket.\n",
      );
      let consumed = false;
      const consumeCalls: boolean[] = [];
      const selectionTicketVerifier = {
        verify: async (_context: unknown, options?: { readonly consume?: boolean }) => {
          const consume = options?.consume === true;
          consumeCalls.push(consume);
          if (consume && consumed)
            return { valid: false as const, code: "ticket-revoked" as const };
          if (consume) consumed = true;
          return {
            valid: true as const,
            securityProfile: "unknown",
            licenseState: "unknown",
          };
        },
      };
      const base = {
        cwd: workspace,
        homeDir,
        workspaceId: "workspace-ticket",
        selectionOrigin: "catalog" as const,
        selectionTicket: "ticket-consumed",
        selectionTicketVerifier,
      };
      const first = await planMossResourceImport(base);
      const second = await planMossResourceImport(base);

      const applied = await applyMossResourceImport({ ...base, plan: first.plan });
      expect(applied.status).toBe("committed");
      await expect(applyMossResourceImport({ ...base, plan: second.plan })).rejects.toMatchObject({
        code: "ticket-revoked",
      });
      await expect(applyMossResourceImport({ ...base, plan: first.plan })).resolves.toMatchObject({
        status: "committed",
        transactionId: applied.transactionId,
      });
      expect(consumeCalls.filter(Boolean)).toEqual([true, true]);
    },
  );

  posixDurabilityIt("recovers a prepared checkpoint before the next mutation", async () => {
    const sourcePath = join(homeDir, ".claude", "skills", "new-skill", "SKILL.md");
    await mkdir(join(homeDir, ".claude", "skills", "new-skill"), { recursive: true });
    await writeFile(sourcePath, "---\nname: New Skill\n---\nNew content.\n");
    const planned = await planMossResourceImport({ cwd: workspace, homeDir });

    const recoveryOperation = planned.plan.operations.find(
      (operation) => operation.kind === "skill",
    );
    expect(recoveryOperation).toBeDefined();
    const orphanTarget =
      recoveryOperation?.targetPath ?? join(workspace, ".moss", "skills", "recover", "SKILL.md");
    await mkdir(join(orphanTarget, ".."), { recursive: true });
    await writeFile(orphanTarget, "orphaned checkpoint\n");
    const stateRoot = getMossResourceImportStateRoot({ homeDir });
    await mkdir(join(stateRoot, "transactions"), { recursive: true, mode: 0o700 });
    const receiptPath = join(stateRoot, "receipts", "transaction-recover-receipt.json");
    const receiptNonce = "receipt-nonce-recover";
    await mkdir(join(stateRoot, "receipts"), { recursive: true, mode: 0o700 });
    const recoveryChange = {
      operationId: recoveryOperation?.operationId ?? "operation-recover",
      phase: "intent" as const,
      kind: recoveryOperation?.kind ?? "skill",
      provider: recoveryOperation?.provider ?? "claude",
      scope: recoveryOperation?.scope ?? "user",
      name: recoveryOperation?.name ?? "Recover",
      canonicalIdentityKey: recoveryOperation?.canonicalIdentityKey ?? "identity-recover",
      sourcePath:
        recoveryOperation?.sourcePath ?? join(homeDir, ".claude", "skills", "recover", "SKILL.md"),
      sourceSha256: recoveryOperation?.sourceSha256 ?? "c".repeat(64),
      snapshotPath:
        recoveryOperation?.snapshotPath ?? join(stateRoot, "blobs", "sha256", "c".repeat(64)),
      snapshotSha256: recoveryOperation?.snapshotSha256 ?? "c".repeat(64),
      targetPath: orphanTarget,
      beforeHash: createHash("sha256").update("missing").digest("hex"),
      receiptPath,
      receiptNonce,
    };
    const recoveryJournal = {
      schemaVersion: 3,
      transactionId: "transaction-recover",
      planId: planned.plan.planId,
      issuer: testBindings.issuer,
      ownerId: testBindings.ownerId,
      projectId: planned.plan.projectId,
      principalId: testBindings.ownerId,
      sessionId: planned.plan.sessionId,
      workspaceId: planned.plan.workspaceId,
      cwd: workspace,
      canonicalRoot: join(workspace, ".moss"),
      planHash: planned.plan.planHash,
      selectionSnapshotSha256: planned.plan.selectionSnapshotSha256,
      stateFingerprint: planned.plan.stateFingerprint,
      stateRoot,
      nonce: "transaction-nonce-recover",
      previousHash: createHash("sha256")
        .update("moss-resource-import:journal:v3:genesis")
        .digest("hex"),
      expiresAt: "2099-08-07T01:02:03.000Z",
      sequence: 0,
      createdAt: "2026-08-06T01:02:03.000Z",
      updatedAt: "2026-08-06T01:02:04.000Z",
      state: "applying" as const,
      changes: [recoveryChange],
    };
    await writeFile(
      join(stateRoot, "transactions", "transaction-recover.json"),
      JSON.stringify({
        ...recoveryJournal,
        recordHash: testJournalRecordHash(recoveryJournal),
      }),
    );
    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 3,
        transactionId: "transaction-recover",
        operationId: recoveryOperation?.operationId ?? "operation-recover",
        issuer: testBindings.issuer,
        ownerId: testBindings.ownerId,
        projectId: planned.plan.projectId,
        principalId: planned.plan.principalId,
        sessionId: planned.plan.sessionId,
        workspaceId: planned.plan.workspaceId,
        cwd: workspace,
        canonicalRoot: join(workspace, ".moss"),
        stateRoot,
        stateFingerprint: planned.plan.stateFingerprint,
        nonce: "transaction-nonce-recover",
        receiptNonce,
        expiresAt: recoveryJournal.expiresAt,
        kind: recoveryOperation?.kind ?? "skill",
        canonicalIdentityKey: recoveryOperation?.canonicalIdentityKey ?? "identity-recover",
        snapshotPath:
          recoveryOperation?.snapshotPath ?? join(stateRoot, "blobs", "sha256", "c".repeat(64)),
        snapshotSha256: recoveryOperation?.snapshotSha256 ?? "c".repeat(64),
        targetPath: orphanTarget,
        beforeHash: createHash("sha256").update("missing").digest("hex"),
      }),
    );

    await expect(
      applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
      }),
    ).rejects.toMatchObject({ code: "recovery-needed" });

    await expect(readFile(orphanTarget, "utf8")).resolves.toBe("orphaned checkpoint\n");
  });

  posixDurabilityIt("does not remove a canonical target changed after import", async () => {
    await mkdir(join(homeDir, ".claude", "skills", "release"), { recursive: true });
    const sourcePath = join(homeDir, ".claude", "skills", "release", "SKILL.md");
    await writeFile(sourcePath, "---\nname: Release\n---\nShip it.\n");
    const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
    const planned = await planMossResourceImport({
      cwd: workspace,
      homeDir,
      resourceIds: inventory.resources.map((resource) => resource.id),
    });
    const applied = await applyMossResourceImport({ cwd: workspace, homeDir, plan: planned.plan });
    const targetPath = join(workspace, ".moss", "skills", "release", "SKILL.md");
    await writeFile(targetPath, "user changed this canonical copy", "utf8");

    const rolledBack = await rollbackMossResourceImport({
      cwd: workspace,
      homeDir,
      transactionId: applied.transactionId,
    });

    expect(rolledBack.status).toBe("partial");
    expect(rolledBack.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "rollback-conflict" })]),
    );
    expect(await readFile(targetPath, "utf8")).toBe("user changed this canonical copy");
  });

  posixDurabilityIt(
    "passes the complete authority context and fenced generation to canonical capability",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "fenced"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "fenced", "SKILL.md"),
        "---\nname: Fenced\n---\nSafe copy.\n",
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });
      const seen: unknown[] = [];
      const capability = testCapabilityForState(testStateDir({ homeDir }));
      const recordingCapability: MossFilesystemCapability = {
        ...capability,
        create: async (input) => {
          seen.push(input);
          return capability.create(input);
        },
        publish: async (input) => {
          seen.push(input);
          return capability.publish(input);
        },
        replace: async (input) => {
          seen.push(input);
          return capability.replace(input);
        },
        remove: async (input) => {
          seen.push(input);
          return capability.remove(input);
        },
      };

      const applied = await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        filesystemCapability: recordingCapability,
      });
      expect(applied.status).toBe("committed");

      const rollbackSeen: unknown[] = [];
      const rollbackCapability: MossFilesystemCapability = {
        ...capability,
        remove: async (input) => {
          rollbackSeen.push(input);
          return capability.remove(input);
        },
      };
      const rolledBack = await rollbackMossResourceImport({
        cwd: workspace,
        homeDir,
        transactionId: applied.transactionId,
        filesystemCapability: rollbackCapability,
      });
      expect(rolledBack.status).toBe("rolled-back");
      expect(rollbackSeen[0]).toMatchObject({ operationId: expect.any(String) });
      expect((rollbackSeen[0] as { operationId: string }).operationId).not.toBe(
        (seen[0] as { operationId: string }).operationId,
      );

      expect(seen[0]).toMatchObject({
        projectId: expect.any(String),
        workspaceId: expect.any(String),
        principalId: "test-owner",
        sessionId: "test-session",
        operationId: expect.any(String),
        fencingToken: expect.any(String),
        generation: expect.any(String),
        nonce: expect.any(String),
        expected: {
          identityFingerprint: expect.any(String),
          hash: expect.any(String),
        },
      });
    },
  );

  posixDurabilityIt(
    "publishes the first private plugin snapshot without precreating its final target",
    async () => {
      const pluginRoot = join(homeDir, ".codex", "plugins", "first-private-publish");
      await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "First Private Publish" }),
      );
      await writeFile(join(pluginRoot, "README.md"), "private snapshot\n");

      const stateDir = join(outside, "node-private-publish");
      const planned = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        providers: ["codex"],
        kinds: ["plugin"],
      });

      expect(planned.plan.operations[0]?.snapshotPath).toContain("/snapshots/plugin-");
      expect(planned.plan.operations[0]?.snapshotPath).toContain("/tree");
      const snapshotBase = join(planned.plan.operations[0]!.snapshotPath, "..");
      const seal = JSON.parse(await readFile(join(snapshotBase, "sealed.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(seal).toEqual(
        expect.objectContaining({
          kind: "plugin",
          snapshotSha256: planned.plan.operations[0]!.snapshotSha256,
          canonicalRoot: expect.any(String),
          stateRoot: stateDir,
          manifestHash: expect.any(String),
          manifestIdentityFingerprint: expect.any(String),
          payloadIdentityFingerprint: expect.any(String),
          payloadBytes: expect.any(Number),
          transactionId: expect.any(String),
          operationId: expect.any(String),
          fencingToken: expect.any(String),
          generation: expect.any(String),
          nonce: expect.any(String),
        }),
      );
      await expect(readFile(join(snapshotBase, "published.json"), "utf8")).resolves.toContain(
        "committed",
      );
      await expect(
        readFile(join(planned.plan.operations[0]!.snapshotPath, "README.md"), "utf8"),
      ).resolves.toContain("private snapshot");
      const repeated = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        providers: ["codex"],
        kinds: ["plugin"],
      });
      expect(repeated.plan.operations[0]?.snapshotPath).not.toBe(
        planned.plan.operations[0]?.snapshotPath,
      );
    },
  );

  posixDurabilityIt("does not reuse a sealed snapshot across authorities and scopes", async () => {
    const skillRoot = join(homeDir, ".claude", "skills", "authority-scope");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: Authority Scope\n---\nsealed\n");
    const stateDir = join(outside, "node-authority-scope");
    const authorityOptions = {
      ownerId: "owner-authority-a",
      projectId: "project-authority-a",
      workspaceId: "workspace-authority-a",
      principalId: "principal-authority-a",
      sessionId: "session-authority-a",
    } as const;
    const first = await planMossResourceImportImpl({
      ...testBindings,
      ...authorityOptions,
      cwd: workspace,
      homeDir,
      stateDir,
      providers: ["claude"],
      kinds: ["skill"],
    });
    const snapshotBase = join(first.plan.operations[0]!.snapshotPath, "..");
    const sealPath = join(snapshotBase, "sealed.json");
    const publishPath = join(snapshotBase, "published.json");
    const originalSeal = JSON.parse(await readFile(sealPath, "utf8")) as Record<string, unknown>;
    const originalPublish = JSON.parse(await readFile(publishPath, "utf8")) as Record<
      string,
      unknown
    >;
    const authority: MossPrivateSnapshotAuthority = {
      canonicalRoot: originalSeal.canonicalRoot as string,
      stateRoot: originalSeal.stateRoot as string,
      ownerId: originalSeal.ownerId as string,
      projectId: originalSeal.projectId as string,
      workspaceId: originalSeal.workspaceId as string,
      principalId: originalSeal.principalId as string,
      sessionId: originalSeal.sessionId as string,
      transactionId: originalSeal.transactionId as string,
      operationId: originalSeal.operationId as string,
      fencingToken: originalSeal.fencingToken as string,
      generation: originalSeal.generation as string,
      nonce: originalSeal.nonce as string,
      kind: "skill",
      snapshotSha256: originalSeal.snapshotSha256 as string,
    };
    const manifest = await readFile(join(snapshotBase, "manifest.json"));
    const store = makeNodeMossOwnershipStore(stateDir);
    const expectedInvalidAuthorityFields = [
      ["canonicalRoot", join(workspace, ".moss-other")],
      ["stateRoot", join(outside, "other-authority-state")],
      ["ownerId", "owner-authority-b"],
      ["projectId", "project-authority-b"],
      ["workspaceId", "workspace-authority-b"],
      ["principalId", "principal-authority-b"],
      ["sessionId", "session-authority-b"],
      ["transactionId", "transaction-authority-b"],
      ["operationId", "operation-authority-b"],
      ["fencingToken", "fence-authority-b"],
      ["generation", "generation-authority-b"],
      ["nonce", "nonce-authority-b"],
      ["kind", "mcp"],
      ["snapshotSha256", "0".repeat(64)],
      ["revision", "revision-authority-b"],
      ["manifestIdentityFingerprint", "manifest-identity-authority-b"],
    ] as const;
    for (const [field, value] of expectedInvalidAuthorityFields) {
      const forgedSeal = { ...originalSeal, [field]: value };
      const forgedPublish = {
        ...forgedSeal,
        marker: "committed",
        sealHash: createHash("sha256").update(stableTestJson(forgedSeal)).digest("hex"),
      };
      await writeFile(sealPath, `${JSON.stringify(forgedSeal)}\n`);
      await writeFile(publishPath, `${JSON.stringify(forgedPublish)}\n`);
      const stage = await store.createPrivateStage({
        ...authority,
        createdAt: originalSeal.createdAt as string,
        leaseExpiresAt: originalSeal.leaseExpiresAt as string,
      });
      const stagePath = testStagePath(stage);
      await writeFile(join(stagePath, "payload"), await readFile(join(snapshotBase, "payload")));
      await writeFile(join(stagePath, "manifest.json"), manifest);
      await expect(
        store.publishPrivateSnapshot({
          stage,
          authority,
          kind: "skill",
          snapshotKey: testSnapshotKeyForAuthority(authority),
          snapshotSha256: authority.snapshotSha256,
          manifest: JSON.parse(manifest.toString("utf8")),
        }),
      ).rejects.toMatchObject({ code: "snapshot-invalid" });
      await rm(stagePath, { recursive: true, force: true });
      await writeFile(sealPath, `${JSON.stringify(originalSeal)}\n`);
      await writeFile(publishPath, `${JSON.stringify(originalPublish)}\n`);
    }

    const second = await planMossResourceImportImpl({
      ...testBindings,
      ...authorityOptions,
      cwd: workspace,
      homeDir,
      stateDir,
      providers: ["claude"],
      kinds: ["skill"],
    });
    expect(second.plan.operations[0]?.snapshotPath).not.toBe(
      first.plan.operations[0]?.snapshotPath,
    );
    const secondStateDir = join(outside, "node-authority-scope-second-root");
    const secondRoot = await planMossResourceImportImpl({
      ...testBindings,
      ...authorityOptions,
      cwd: workspace,
      homeDir,
      stateDir: secondStateDir,
      providers: ["claude"],
      kinds: ["skill"],
    });
    expect(secondRoot.plan.operations[0]?.snapshotPath).not.toBe(
      first.plan.operations[0]?.snapshotPath,
    );
  });

  posixDurabilityIt("rejects a final snapshot when its manifest inode is replaced", async () => {
    const skillRoot = join(homeDir, ".claude", "skills", "manifest-identity");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: Manifest Identity\n---\nsealed\n");
    const stateDir = join(outside, "node-manifest-identity");
    const first = await planMossResourceImportImpl({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      providers: ["claude"],
      kinds: ["skill"],
    });
    const snapshotBase = join(first.plan.operations[0]!.snapshotPath, "..");
    const manifestPath = join(snapshotBase, "manifest.json");
    const original = await readFile(manifestPath);
    await rm(manifestPath);
    await writeFile(manifestPath, original);
    const result = await applyMossResourceImport({
      ...testBindings,
      cwd: workspace,
      homeDir,
      stateDir,
      plan: first.plan,
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "snapshot-invalid" })]),
    );
  });

  posixDurabilityIt(
    "rejects a private publish when the stage canonical root differs before final state",
    async () => {
      const skillRoot = join(homeDir, ".claude", "skills", "stage-root-mismatch");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, "SKILL.md"), "---\nname: Stage Root Mismatch\n---\nsealed\n");
      const stateDir = join(outside, "node-stage-root-mismatch");
      const first = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        providers: ["claude"],
        kinds: ["skill"],
      });
      const operation = first.plan.operations[0]!;
      const snapshotBase = join(operation.snapshotPath, "..");
      const seal = JSON.parse(await readFile(join(snapshotBase, "sealed.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const field = (name: string): string => {
        const value = seal[name];
        if (typeof value !== "string") throw new Error(`stage root fixture field missing: ${name}`);
        return value;
      };
      const stageAuthority: MossPrivateSnapshotAuthority = {
        canonicalRoot: field("canonicalRoot"),
        stateRoot: field("stateRoot"),
        ownerId: field("ownerId"),
        projectId: field("projectId"),
        workspaceId: field("workspaceId"),
        principalId: field("principalId"),
        sessionId: field("sessionId"),
        transactionId: field("transactionId"),
        operationId: field("operationId"),
        fencingToken: field("fencingToken"),
        generation: field("generation"),
        nonce: field("nonce"),
        kind: "skill",
        snapshotSha256: field("snapshotSha256"),
      };
      const publishAuthority: MossPrivateSnapshotAuthority = {
        ...stageAuthority,
        canonicalRoot: join(workspace, ".moss-other"),
      };
      const store = makeNodeMossOwnershipStore(stateDir);
      const stage = await store.createPrivateStage({
        ...stageAuthority,
        createdAt: field("createdAt"),
        leaseExpiresAt: field("leaseExpiresAt"),
      });
      const stagePath = testStagePath(stage);
      await writeFile(join(stagePath, "payload"), await readFile(join(snapshotBase, "payload")));
      const manifest = await readFile(join(snapshotBase, "manifest.json"));
      await writeFile(join(stagePath, "manifest.json"), manifest);
      const finalBase = join(
        stateDir,
        "snapshots",
        `skill-${testSnapshotKeyForAuthority(publishAuthority)}`,
      );
      await expect(
        store.publishPrivateSnapshot({
          stage,
          authority: publishAuthority,
          kind: "skill",
          snapshotKey: testSnapshotKeyForAuthority(publishAuthority),
          snapshotSha256: stageAuthority.snapshotSha256,
          manifest: JSON.parse(manifest.toString("utf8")),
        }),
      ).rejects.toMatchObject({ code: "snapshot-invalid" });
      await expect(lstat(finalBase)).rejects.toThrow();
      await expect(lstat(`${finalBase}.publish`)).rejects.toThrow();
      await expect(lstat(stagePath)).resolves.toBeDefined();
    },
  );

  posixDurabilityIt(
    "fails closed when a private stage canonical root is missing or tampered on reuse",
    async () => {
      const stateDir = join(outside, "node-stage-root-reuse");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const authority: MossPrivateSnapshotAuthority = {
        canonicalRoot: join(workspace, ".moss"),
        stateRoot: stateDir,
        ownerId: "owner-stage-reuse",
        projectId: "project-stage-reuse",
        workspaceId: "workspace-stage-reuse",
        principalId: "principal-stage-reuse",
        sessionId: "session-stage-reuse",
        transactionId: "transaction-stage-reuse",
        operationId: "operation-stage-reuse",
        fencingToken: "fence-stage-reuse",
        generation: "generation-stage-reuse",
        nonce: "nonce-stage-reuse",
        kind: "skill",
        snapshotSha256: "a".repeat(64),
      };
      const input = {
        ...authority,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const store = makeNodeMossOwnershipStore(stateDir);
      const stage = await store.createPrivateStage(input);
      const stagePath = testStagePath(stage);
      const metadataPath = join(stagePath, "stage.json");
      await rm(metadataPath);
      await expect(store.createPrivateStage(input)).rejects.toMatchObject({
        code: "snapshot-invalid",
      });
      await expect(lstat(stagePath)).resolves.toBeDefined();

      await writeFile(metadataPath, `${JSON.stringify({ ...input, id: stage.id })}\n`);
      await writeFile(
        metadataPath,
        `${JSON.stringify({ ...input, id: stage.id, canonicalRoot: `${authority.canonicalRoot}-tampered` })}\n`,
      );
      await expect(store.createPrivateStage(input)).rejects.toMatchObject({
        code: "snapshot-invalid",
      });
      await expect(lstat(stagePath)).resolves.toBeDefined();
    },
  );

  posixDurabilityIt(
    "preserves snapshot-invalid when publishing over a corrupt final snapshot",
    async () => {
      const skillRoot = join(homeDir, ".claude", "skills", "publish-corrupt");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, "SKILL.md"), "---\nname: Publish Corrupt\n---\nsealed\n");
      const stateDir = join(outside, "node-publish-corrupt");
      const first = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        providers: ["claude"],
        kinds: ["skill"],
      });
      const snapshotBase = join(first.plan.operations[0]!.snapshotPath, "..");
      const seal = JSON.parse(await readFile(join(snapshotBase, "sealed.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const manifest = await readFile(join(snapshotBase, "manifest.json"));
      const authority = {
        canonicalRoot: seal.canonicalRoot as string,
        stateRoot: seal.stateRoot as string,
        ownerId: seal.ownerId as string,
        projectId: seal.projectId as string,
        workspaceId: seal.workspaceId as string,
        principalId: seal.principalId as string,
        sessionId: seal.sessionId as string,
        transactionId: seal.transactionId as string,
        operationId: seal.operationId as string,
        fencingToken: seal.fencingToken as string,
        generation: seal.generation as string,
        nonce: seal.nonce as string,
        kind: "skill" as const,
        snapshotSha256: seal.snapshotSha256 as string,
      };
      const store = makeNodeMossOwnershipStore(stateDir);
      const stage = await store.createPrivateStage({
        transactionId: seal.transactionId as string,
        operationId: seal.operationId as string,
        kind: "skill",
        canonicalRoot: seal.canonicalRoot as string,
        ownerId: seal.ownerId as string,
        projectId: seal.projectId as string,
        workspaceId: seal.workspaceId as string,
        principalId: seal.principalId as string,
        sessionId: seal.sessionId as string,
        fencingToken: seal.fencingToken as string,
        generation: seal.generation as string,
        nonce: seal.nonce as string,
        createdAt: seal.createdAt as string,
        leaseExpiresAt: seal.leaseExpiresAt as string,
      });
      const stagePath = testStagePath(stage);
      await writeFile(join(stagePath, "payload"), await readFile(join(snapshotBase, "payload")));
      await writeFile(join(stagePath, "manifest.json"), manifest);
      await writeFile(
        join(snapshotBase, "sealed.json"),
        `${JSON.stringify({ ...seal, manifestHash: "0".repeat(64) })}\n`,
      );
      await expect(
        store.publishPrivateSnapshot({
          stage,
          authority,
          kind: "skill",
          snapshotKey: testSnapshotKeyForAuthority(authority),
          snapshotSha256: seal.snapshotSha256 as string,
          manifest: JSON.parse(manifest.toString("utf8")),
        }),
      ).rejects.toMatchObject({ code: "snapshot-invalid" });
    },
  );

  posixDurabilityIt(
    "rejects a final snapshot with a missing, swapped, or missing publish seal",
    async () => {
      const skillRoot = join(homeDir, ".claude", "skills", "seal-consumption");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, "SKILL.md"), "---\nname: Seal Consumption\n---\nsealed\n");
      const stateDir = join(outside, "node-seal-consumption");
      const first = await planMossResourceImportImpl({
        ...testBindings,
        cwd: workspace,
        homeDir,
        stateDir,
        providers: ["claude"],
        kinds: ["skill"],
      });
      const snapshotBase = join(first.plan.operations[0]!.snapshotPath, "..");
      const sealPath = join(snapshotBase, "sealed.json");
      const publishPath = join(snapshotBase, "published.json");
      const originalSeal = await readFile(sealPath, "utf8");
      const expectApplySnapshotInvalid = async (): Promise<void> => {
        const result = await applyMossResourceImport({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir,
          plan: first.plan,
        });
        expect(result.issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "snapshot-invalid" })]),
        );
      };

      await rm(sealPath);
      await expectApplySnapshotInvalid();

      await writeFile(sealPath, "{not-json\n");
      await expectApplySnapshotInvalid();

      await writeFile(sealPath, originalSeal);
      const swappedSeal = JSON.parse(originalSeal) as Record<string, unknown>;
      swappedSeal.snapshotSha256 = "0".repeat(64);
      await writeFile(sealPath, `${JSON.stringify(swappedSeal)}\n`);
      await expectApplySnapshotInvalid();

      await writeFile(sealPath, originalSeal);
      await rm(publishPath);
      await expectApplySnapshotInvalid();
    },
  );

  posixDurabilityIt(
    "keeps active private stages and removes only proven expired orphan stages",
    async () => {
      const stateDir = join(outside, "node-stage-recovery");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const store = makeNodeMossOwnershipStore(stateDir);
      const now = Date.now();
      const authority = {
        canonicalRoot: join(workspace, ".moss"),
        ownerId: "owner-recovery",
        projectId: "project-recovery",
        workspaceId: "workspace-recovery",
        principalId: "principal-recovery",
        sessionId: "session-recovery",
        fencingToken: "fence-recovery",
        generation: "generation-recovery",
        nonce: "nonce-recovery",
      } as const;
      const active = await store.createPrivateStage({
        transactionId: "transaction-active-stage",
        operationId: "operation-active-stage",
        kind: "skill",
        ...authority,
        createdAt: new Date(now - 120_000).toISOString(),
        leaseExpiresAt: new Date(now + 120_000).toISOString(),
      });
      const expired = await store.createPrivateStage({
        transactionId: "transaction-expired-stage",
        operationId: "operation-expired-stage",
        kind: "skill",
        ...authority,
        createdAt: new Date(now - 120_000).toISOString(),
        leaseExpiresAt: new Date(now - 60_000).toISOString(),
      });

      await store.recoverPrivateStages({
        stateRoot: stateDir,
        canonicalRoot: authority.canonicalRoot,
      });

      const activePath = (active.opaque as { readonly path: string }).path;
      const expiredPath = (expired.opaque as { readonly path: string }).path;
      await expect(lstat(activePath)).resolves.toBeDefined();
      await expect(lstat(expiredPath)).rejects.toThrow();

      const corruptions = [
        ["missing", undefined],
        ["non-string", { bad: true }],
        ["non-normalized", `${authority.canonicalRoot}/..`],
        ["mismatched", `${authority.canonicalRoot}-other`],
      ] as const;
      for (const [label, canonicalRoot] of corruptions) {
        const corruptedStateDir = join(outside, `node-stage-recovery-root-${label}`);
        await mkdir(corruptedStateDir, { recursive: true, mode: 0o700 });
        const corruptedStore = makeNodeMossOwnershipStore(corruptedStateDir);
        const corruptedStage = await corruptedStore.createPrivateStage({
          transactionId: `transaction-expired-root-${label}`,
          operationId: `operation-expired-root-${label}`,
          kind: "skill",
          ...authority,
          createdAt: new Date(now - 120_000).toISOString(),
          leaseExpiresAt: new Date(now - 60_000).toISOString(),
        });
        const corruptedStagePath = testStagePath(corruptedStage);
        const metadataPath = join(corruptedStagePath, "stage.json");
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
          string,
          unknown
        >;
        if (canonicalRoot === undefined) {
          delete metadata.canonicalRoot;
        } else {
          metadata.canonicalRoot = canonicalRoot;
        }
        await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);

        await expect(
          corruptedStore.recoverPrivateStages({
            stateRoot: corruptedStateDir,
            canonicalRoot: authority.canonicalRoot,
          }),
        ).rejects.toMatchObject({ code: "snapshot-invalid" });
        await expect(lstat(corruptedStagePath)).resolves.toBeDefined();
      }

      const metadataMissingStateDir = join(outside, "node-stage-recovery-metadata-missing");
      await mkdir(metadataMissingStateDir, { recursive: true, mode: 0o700 });
      const metadataMissingStore = makeNodeMossOwnershipStore(metadataMissingStateDir);
      const metadataMissingStage = await metadataMissingStore.createPrivateStage({
        transactionId: "transaction-expired-metadata-missing",
        operationId: "operation-expired-metadata-missing",
        kind: "skill",
        ...authority,
        createdAt: new Date(now - 120_000).toISOString(),
        leaseExpiresAt: new Date(now - 60_000).toISOString(),
      });
      const metadataMissingStagePath = testStagePath(metadataMissingStage);
      await rm(join(metadataMissingStagePath, "stage.json"));
      await expect(
        metadataMissingStore.recoverPrivateStages({
          stateRoot: metadataMissingStateDir,
          canonicalRoot: authority.canonicalRoot,
        }),
      ).rejects.toMatchObject({ code: "snapshot-invalid" });
      await expect(lstat(metadataMissingStagePath)).resolves.toBeDefined();
    },
  );

  posixDurabilityIt(
    "retains authority-marked sealed stages and never deletes an unproven sealed stage",
    async () => {
      type TamperKind =
        | "marker"
        | "stage"
        | "stage-missing"
        | "seal"
        | "published"
        | "manifest"
        | "payload";
      const skillRoot = join(homeDir, ".claude", "skills", "recovery-proof");
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, "SKILL.md"), "---\nname: Recovery Proof\n---\nsealed\n");
      const makeExpiredStage = async (label: string, tamper?: TamperKind) => {
        const stateDir = join(outside, `node-stage-recovery-proof-${label}`);
        const expiredNow = new Date(Date.now() - 10 * 60_000);
        const planned = await planMossResourceImportImpl({
          ...testBindings,
          cwd: workspace,
          homeDir,
          stateDir,
          providers: ["claude"],
          kinds: ["skill"],
          now: () => expiredNow,
        });
        const operation = planned.plan.operations[0];
        if (!operation) throw new Error("recovery proof operation missing");
        const snapshotBase = join(operation.snapshotPath, "..");
        const seal = JSON.parse(
          await readFile(join(snapshotBase, "sealed.json"), "utf8"),
        ) as Record<string, unknown>;
        const stringField = (field: string): string => {
          const value = seal[field];
          if (typeof value !== "string") throw new Error(`recovery seal field missing: ${field}`);
          return value;
        };
        const authority: MossPrivateSnapshotAuthority = {
          canonicalRoot: stringField("canonicalRoot"),
          stateRoot: stringField("stateRoot"),
          ownerId: stringField("ownerId"),
          projectId: stringField("projectId"),
          workspaceId: stringField("workspaceId"),
          principalId: stringField("principalId"),
          sessionId: stringField("sessionId"),
          transactionId: stringField("transactionId"),
          operationId: stringField("operationId"),
          fencingToken: stringField("fencingToken"),
          generation: stringField("generation"),
          nonce: stringField("nonce"),
          kind: "skill",
          snapshotSha256: stringField("snapshotSha256"),
        };
        const store = makeNodeMossOwnershipStore(stateDir);
        const stage = await store.createPrivateStage({
          ...authority,
          createdAt: stringField("createdAt"),
          leaseExpiresAt: stringField("leaseExpiresAt"),
        });
        const stagePath = testStagePath(stage);
        for (const fileName of ["payload", "manifest.json"]) {
          await cp(join(snapshotBase, fileName), join(stagePath, fileName));
        }
        const stageManifest = JSON.parse(
          await readFile(join(stagePath, "manifest.json"), "utf8"),
        ) as Record<string, unknown>;
        const manifestHash = createHash("sha256")
          .update(stableTestJson(stageManifest))
          .digest("hex");
        const payloadBytes = await testPrivatePayloadBytes(join(stagePath, "payload"));
        const stageSeal = {
          ...seal,
          manifestHash,
          manifestIdentityFingerprint: await testPrivatePayloadIdentity(
            join(stagePath, "manifest.json"),
          ),
          payloadIdentityFingerprint: await testPrivatePayloadIdentity(join(stagePath, "payload")),
          payloadBytes,
          revision: testPrivateSnapshotRevision({
            kind: "skill",
            snapshotSha256: authority.snapshotSha256,
            manifestHash,
            payloadBytes,
          }),
        };
        await writeFile(join(stagePath, "sealed.json"), `${JSON.stringify(stageSeal)}\n`);
        await writeFile(
          join(stagePath, "published.json"),
          `${JSON.stringify({
            ...stageSeal,
            marker: "committed",
            sealHash: createHash("sha256").update(stableTestJson(stageSeal)).digest("hex"),
          })}\n`,
        );
        if (tamper === "marker") {
          await writeFile(
            join(stateDir, "snapshots", `skill-${testSnapshotKeyForAuthority(authority)}.publish`),
            "tampered marker\n",
            { mode: 0o600 },
          );
        } else if (tamper === "stage") {
          const metadata = JSON.parse(
            await readFile(join(stagePath, "stage.json"), "utf8"),
          ) as Record<string, unknown>;
          await writeFile(
            join(stagePath, "stage.json"),
            `${JSON.stringify({ ...metadata, canonicalRoot: `${authority.canonicalRoot}-tampered` })}\n`,
          );
        } else if (tamper === "stage-missing") {
          const metadata = JSON.parse(
            await readFile(join(stagePath, "stage.json"), "utf8"),
          ) as Record<string, unknown>;
          delete metadata.canonicalRoot;
          await writeFile(join(stagePath, "stage.json"), `${JSON.stringify(metadata)}\n`);
        } else if (tamper === "seal") {
          await writeFile(
            join(stagePath, "sealed.json"),
            `${JSON.stringify({ ...stageSeal, ownerId: `${authority.ownerId}-tampered` })}\n`,
          );
        } else if (tamper === "published") {
          const published = JSON.parse(
            await readFile(join(stagePath, "published.json"), "utf8"),
          ) as Record<string, unknown>;
          await writeFile(
            join(stagePath, "published.json"),
            `${JSON.stringify({ ...published, sealHash: "0".repeat(64) })}\n`,
          );
        } else if (tamper === "manifest") {
          const manifest = JSON.parse(
            await readFile(join(stagePath, "manifest.json"), "utf8"),
          ) as Record<string, unknown>;
          await writeFile(
            join(stagePath, "manifest.json"),
            `${JSON.stringify({ ...manifest, entries: [...(manifest.entries as unknown[]), { path: "tampered", sha256: "0".repeat(64), sizeBytes: 0 }] })}\n`,
          );
        } else if (tamper === "payload") {
          await writeFile(join(stagePath, "payload"), "tampered payload\n");
        }
        return { authority, seal: stageSeal, stagePath, stateDir, store };
      };

      const authorityMarked = await makeExpiredStage("authority-marker");
      const authorityMarker = join(
        authorityMarked.stateDir,
        "snapshots",
        `skill-${testSnapshotKeyForAuthority(authorityMarked.authority)}.publish`,
      );
      await writeFile(authorityMarker, "", { mode: 0o600 });
      await authorityMarked.store.recoverPrivateStages({
        stateRoot: authorityMarked.authority.stateRoot,
        canonicalRoot: authorityMarked.authority.canonicalRoot,
      });
      await expect(lstat(authorityMarked.stagePath)).resolves.toBeDefined();

      const contentOnlyMarked = await makeExpiredStage("content-only-marker");
      await writeFile(
        join(
          contentOnlyMarked.stateDir,
          "snapshots",
          `skill-${contentOnlyMarked.authority.snapshotSha256}.publish`,
        ),
        "",
        { mode: 0o600 },
      );
      await contentOnlyMarked.store.recoverPrivateStages({
        stateRoot: contentOnlyMarked.authority.stateRoot,
        canonicalRoot: contentOnlyMarked.authority.canonicalRoot,
      });
      await expect(lstat(contentOnlyMarked.stagePath)).rejects.toThrow();

      for (const tamper of [
        "marker",
        "stage",
        "stage-missing",
        "seal",
        "published",
        "manifest",
        "payload",
      ] as const) {
        const fixture = await makeExpiredStage(tamper, tamper);
        await expect(
          fixture.store.recoverPrivateStages({
            stateRoot: fixture.authority.stateRoot,
            canonicalRoot: fixture.authority.canonicalRoot,
          }),
        ).rejects.toMatchObject({
          code: "snapshot-invalid",
        });
        await expect(lstat(fixture.stagePath)).resolves.toBeDefined();
      }
    },
  );

  posixDurabilityIt(
    "turns concurrent private provenance appends into one typed CAS winner",
    async () => {
      const stateDir = join(outside, "node-provenance-race");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const store = makeNodeMossOwnershipStore(stateDir);
      const input = {
        fileName: "provenance.json",
        transactionId: "transaction-provenance-race",
        value: { schemaVersion: 3, records: [] },
        ownerId: "owner-race",
        projectId: "project-race",
        workspaceId: "workspace-race",
        principalId: "principal-race",
        sessionId: "session-race",
        stateFingerprint: "a".repeat(64),
        nonce: "nonce-race",
      } as const;
      const results = await Promise.allSettled([
        store.appendPrivateRecord(input),
        store.appendPrivateRecord(input),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ code: "concurrent-modification" }),
      });
      await expect(store.readPrivateRecord({ fileName: "provenance.json" })).resolves.toMatchObject(
        {
          sequence: 0,
          transactionId: input.transactionId,
        },
      );
    },
  );

  posixDurabilityIt(
    "appends provenance across transactions and validates the full chain after restart",
    async () => {
      const stateDir = join(outside, "node-provenance-cross-transaction");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const makeInput = (transactionId: string, nonce: string) => ({
        fileName: "provenance.json",
        transactionId,
        value: { schemaVersion: 3, records: [{ transactionId }] },
        ownerId: "owner-cross-transaction",
        projectId: "project-cross-transaction",
        workspaceId: "workspace-cross-transaction",
        principalId: "principal-cross-transaction",
        sessionId: "session-cross-transaction",
        stateFingerprint: nonce.padEnd(64, "f"),
        nonce,
      });
      const store = makeNodeMossOwnershipStore(stateDir);
      await store.appendPrivateRecord(makeInput("transaction-a", "nonce-a"));
      await store.appendPrivateRecord(makeInput("transaction-b", "nonce-b"));

      const restarted = makeNodeMossOwnershipStore(stateDir);
      await expect(
        restarted.readPrivateRecord({ fileName: "provenance.json" }),
      ).resolves.toMatchObject({
        sequence: 1,
        transactionId: "transaction-b",
      });

      const firstRecord = JSON.parse(
        await readFile(join(stateDir, "provenance.json"), "utf8"),
      ) as Record<string, unknown>;
      firstRecord.recordHash = "0".repeat(64);
      await writeFile(join(stateDir, "provenance.json"), `${JSON.stringify(firstRecord)}\n`);
      await expect(
        restarted.readPrivateRecord({ fileName: "provenance.json" }),
      ).rejects.toMatchObject({
        code: "transaction-invalid",
      });
    },
  );

  posixDurabilityIt(
    "serializes concurrent provenance appends from different transactions",
    async () => {
      const stateDir = join(outside, "node-provenance-concurrent-transactions");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const makeInput = (transactionId: string) => ({
        fileName: "provenance.json",
        transactionId,
        value: { schemaVersion: 3, records: [{ transactionId }] },
        ownerId: "owner-concurrent-transactions",
        projectId: "project-concurrent-transactions",
        workspaceId: "workspace-concurrent-transactions",
        principalId: "principal-concurrent-transactions",
        sessionId: "session-concurrent-transactions",
        stateFingerprint: "a".repeat(64),
        nonce: transactionId,
      });
      const store = makeNodeMossOwnershipStore(stateDir);
      const results = await Promise.allSettled([
        store.appendPrivateRecord(makeInput("transaction-a")),
        store.appendPrivateRecord(makeInput("transaction-b")),
      ]);

      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      await expect(store.readPrivateRecord({ fileName: "provenance.json" })).resolves.toMatchObject(
        {
          sequence: 1,
        },
      );
    },
  );

  posixDurabilityIt(
    "does not leave an incomplete final snapshot when snapshot staging fails",
    async () => {
      const pluginRoot = join(homeDir, ".codex", "plugins", "staged-plugin");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "staged-plugin" }));
      await writeFile(join(pluginRoot, "README.md"), "staged plugin\n");

      await expect(
        planMossResourceImport({
          cwd: workspace,
          homeDir,
          beforeFilesystemMutation: async ({ action }) => {
            if (action === "after-readdir-before-copy") {
              throw new MossResourceImportError(
                "copy-failed",
                "deterministic snapshot staging fault",
              );
            }
          },
        }),
      ).rejects.toMatchObject({ code: "copy-failed" });

      await expect(readdir(join(testStateDir({ homeDir }), "snapshots"))).rejects.toThrow();
    },
  );

  posixDurabilityIt(
    "routes journal and receipt persistence through the ownership store",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "store-backed"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "store-backed", "SKILL.md"),
        "---\nname: Store Backed\n---\nStore this.\n",
      );
      const stateDir = testStateDir({ homeDir });
      const baseOwnershipStore = testOwnershipStore(stateDir);
      const appended: unknown[] = [];
      const appendPrivateRecord = baseOwnershipStore.appendPrivateRecord;
      const ownershipStore: MossOwnershipStore = {
        ...baseOwnershipStore,
        appendPrivateRecord: async (
          input: Parameters<MossOwnershipStore["appendPrivateRecord"]>[0],
        ) => {
          appended.push(input);
          return appendPrivateRecord(input);
        },
      };
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
        ownershipStore,
      });

      await applyMossResourceImport({
        cwd: workspace,
        homeDir,
        plan: planned.plan,
        ownershipStore,
      });

      expect(appended).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ fileName: expect.stringContaining("transactions") }),
          expect.objectContaining({ fileName: expect.stringContaining("receipts") }),
        ]),
      );
    },
  );

  posixDurabilityIt(
    "requires an injected native filesystem capability before canonical mutation",
    async () => {
      await mkdir(join(homeDir, ".claude", "skills", "release"), { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "skills", "release", "SKILL.md"),
        "---\nname: Release\n---\nShip it.\n",
      );
      const inventory = await inventoryMossResourceImport({ cwd: workspace, homeDir });
      const planned = await planMossResourceImport({
        cwd: workspace,
        homeDir,
        resourceIds: inventory.resources.map((resource) => resource.id),
      });

      await expect(
        applyMossResourceImportImpl({
          cwd: workspace,
          homeDir,
          stateDir: testStateDir({ homeDir }),
          ownerId: "test-owner",
          issuer: "test-issuer",
          sessionId: "test-session",
          plan: planned.plan,
        }),
      ).rejects.toMatchObject({ code: "durability-unsupported" });
    },
  );
});
