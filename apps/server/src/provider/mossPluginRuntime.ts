/**
 * Moss unified plugin runtime boundary.
 *
 * This module imports the shared plugin IR and turns it into a provider-aware
 * plan. It intentionally does not spawn plugin processes, invoke connector
 * apps, or treat catalog metadata as execution. A caller must register an
 * explicit native/adapter executor before `executeMossPluginComponent` can
 * return an executed result.
 */
import { chmod, mkdir, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { ProviderKind } from "@synara/contracts";
import {
  MOSS_PLUGIN_CAPABILITY_MATRIX,
  MOSS_ENGINE_NATIVE_TARGETS,
  getMossPluginCapability,
  type MossPluginExecutionMode,
  type MossPluginProviderCapability,
  type MossPluginProjectionMode,
} from "@synara/shared/mossProjectionGovernance";
import {
  materializeMossProjection,
  mossProjectionContentHash,
  reconcileMossProjectionResources,
  type MossProjectionMaterializeResult,
  type MossProjectionOwnershipStore,
} from "@synara/shared/mossProjectionMaterializer";
import type { MossAcpMcpServer } from "@synara/shared/mossAcpMcpServers";
import {
  discoverMossSourceResources,
  readMossPluginManifest,
  isSafeMossPluginComponentName,
  validateMossPluginMarketplace,
  type MossPluginComponent,
  type MossPluginComponentKind,
  type MossPluginIR,
  type MossPluginValidation,
} from "@synara/shared/mossResourceRegistry";

export type MossPluginRuntimeComponentStatus = "ready" | "degraded" | "display-only" | "blocked";

/**
 * Honest provider-facing runtime state. This is deliberately separate from
 * the capability matrix: a matrix row is only a promise of a possible
 * surface, while this state is produced by an actual projection or session
 * injection operation.
 */
export type MossPluginRuntimeSupportStatus = "native" | "projected" | "injected" | "unsupported";

export interface MossPluginRuntimeComponentPlan {
  readonly id: string;
  readonly kind: MossPluginComponentKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly sourcePath?: string | undefined;
  readonly projection: MossPluginProjectionMode;
  readonly execution: MossPluginExecutionMode;
  readonly target?: string | undefined;
  readonly status: MossPluginRuntimeComponentStatus;
  /** Matrix intent only; never evidence of a successful provider operation. */
  readonly plannedSupportStatus: MossPluginRuntimeSupportStatus;
  readonly supportStatus: MossPluginRuntimeSupportStatus;
  readonly reason: string;
  readonly capability: MossPluginProviderCapability;
}

export interface MossPluginRuntimePlan {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly provider: ProviderKind;
  readonly validation: MossPluginValidation;
  readonly components: ReadonlyArray<MossPluginRuntimeComponentPlan>;
  /** True only when the provider matrix has a non-none execution surface. */
  readonly executionReady: boolean;
  readonly warnings: ReadonlyArray<string>;
}

export interface MossPluginRuntimeSnapshot {
  readonly cwd: string;
  readonly plugins: ReadonlyArray<MossPluginIR>;
  readonly errors: ReadonlyArray<string>;
}

/**
 * Explicit server-owned approval required before a plugin component can be
 * injected, spawned, or projected into a provider runtime. The manifest cannot
 * manufacture this value: callers must bind it to the discovered IR hash and
 * the exact selected component ids.
 */
export interface MossPluginRuntimeApproval {
  readonly authority: "moss-server";
  readonly provenance: "server-owned-import";
  readonly pluginId: string;
  /** Digest of the manifest, selected component bytes, and file identities. */
  readonly contentHash: string;
  readonly componentIds: ReadonlyArray<string>;
  /** Opaque server-issued token identity; callers cannot manufacture authority. */
  readonly tokenId: string;
  /** Short-lived approvals cannot be replayed indefinitely. */
  readonly expiresAt: number;
  /** Only a server-owned local-development policy may use HTTP/private hosts. */
  readonly allowLocalDevelopment?: boolean | undefined;
}

export interface MossPluginApprovalStore {
  readonly get: (input: {
    readonly cwd: string;
    readonly plugin: MossPluginIR;
  }) => Promise<MossPluginRuntimeApproval | undefined>;
}

export interface MossPluginApprovalIssuer {
  readonly approve: (input: {
    readonly cwd: string;
    readonly plugin: MossPluginIR;
    readonly componentIds: ReadonlyArray<string>;
    readonly allowLocalDevelopment?: boolean | undefined;
    readonly ttlMs?: number | undefined;
  }) => Promise<MossPluginRuntimeApproval>;
  readonly revoke: (input: { readonly cwd: string; readonly pluginId: string }) => void;
}

interface MossPluginApprovalAuthority {
  readonly tokens: Map<string, MossPluginRuntimeApproval>;
  readonly denyAll?: boolean;
}

const APPROVAL_STORE_REGISTRY = new WeakMap<object, MossPluginApprovalAuthority>();
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_APPROVAL_DIGEST_FILES = 1024;
const MAX_APPROVAL_DIGEST_BYTES = 16 * 1024 * 1024;
const MAX_APPROVAL_DIRECTORY_DEPTH = 32;

interface MossPluginApprovalSourceDescriptor {
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly contentHash: string;
  readonly identity: {
    readonly dev: string;
    readonly ino: string;
    readonly mode: number;
    readonly size: string;
    readonly mtimeMs: number;
  };
}

interface MossPluginApprovalSnapshot {
  readonly root: string;
  readonly manifestRelativePath: string;
  readonly contentHash: string;
  readonly plugin: MossPluginIR;
  readonly selectedComponentIds: ReadonlyArray<string>;
  readonly selectedComponentSources: Readonly<Record<string, MossPluginApprovalSourceDescriptor>>;
}

const APPROVAL_SNAPSHOT_BY_TOKEN = new WeakMap<object, MossPluginApprovalSnapshot>();

async function readMossPluginFileNoFollow(
  filePath: string,
  maxBytes = MAX_APPROVAL_DIGEST_BYTES,
): Promise<Buffer> {
  const pathStat = await lstat(filePath);
  if (pathStat.isSymbolicLink()) throw new Error("plugin source may not be a symbolic link");
  if (pathStat.isFile() && pathStat.size > maxBytes) {
    throw new Error("plugin approval digest exceeds the byte limit");
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("plugin source is not a regular file");
    if (fileStat.size > maxBytes) {
      throw new Error("plugin approval digest exceeds the byte limit");
    }
    const size = Number(fileStat.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(bytes, offset, size - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const afterStat = await handle.stat();
    if (
      afterStat.dev !== fileStat.dev ||
      afterStat.ino !== fileStat.ino ||
      afterStat.size !== fileStat.size ||
      afterStat.mtimeMs !== fileStat.mtimeMs
    ) {
      throw new Error("plugin source changed while it was being read");
    }
    if (offset !== size) throw new Error("plugin source could not be read completely");
    return bytes;
  } finally {
    await handle.close();
  }
}

function approvalKey(cwd: string, pluginId: string): string {
  return `${resolve(cwd)}\u0000${pluginId}`;
}

async function assertNoSymlinkPathWithin(rootPath: string, candidatePath: string): Promise<void> {
  const rootLexical = resolve(rootPath);
  const candidateLexical = resolve(candidatePath);
  const root = await realpath(rootLexical);
  const candidate = await realpath(candidateLexical);
  const candidateRelative = relative(root, candidate);
  if (candidateRelative.startsWith("..") || candidateRelative.startsWith(sep)) {
    throw new Error("plugin source path escaped the plugin root");
  }
  const lexicalRelative = relative(rootLexical, candidateLexical);
  const walkRoot =
    lexicalRelative === "" ||
    (!lexicalRelative.startsWith("..") && !lexicalRelative.startsWith(sep))
      ? rootLexical
      : root;
  const walkCandidate = walkRoot === rootLexical ? candidateLexical : candidate;
  let current = walkRoot;
  const rootStat = await lstat(current);
  if (rootStat.isSymbolicLink()) throw new Error("plugin root symlinks are not allowed");
  const walkRelative = relative(walkRoot, walkCandidate);
  for (const segment of walkRelative ? walkRelative.split(sep) : []) {
    current = join(current, segment);
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) {
      throw new Error("plugin source symlink parents are not allowed");
    }
  }
}

function stableApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableApprovalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableApprovalValue(entry)]),
  );
}

function immutableApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableApprovalValue));
  if (!isRecord(value)) return value;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, immutableApprovalValue(entry)]),
    ),
  );
}

function immutablePluginApprovalSnapshot(
  plugin: MossPluginIR,
  root: string,
  manifestPath: string,
): MossPluginIR {
  return immutableApprovalValue({
    ...plugin,
    absolutePluginRoot: root,
    absoluteManifestPath: manifestPath,
  }) as MossPluginIR;
}

async function appendApprovalDigestPath(input: {
  readonly pluginRoot: string;
  readonly path: string;
  readonly label: string;
  readonly entries: Array<Record<string, unknown>>;
  readonly byteCount: { value: number };
  readonly depth: number;
}): Promise<void> {
  if (input.depth > MAX_APPROVAL_DIRECTORY_DEPTH) {
    throw new Error("plugin approval digest directory nesting exceeds the safety limit");
  }
  await assertNoSymlinkPathWithin(input.pluginRoot, input.path);
  const rootReal = await realpath(input.pluginRoot);
  const candidateReal = await realpath(input.path);
  const candidateRelative = relative(rootReal, candidateReal);
  if (
    candidateRelative !== "" &&
    (candidateRelative.startsWith("..") || candidateRelative.startsWith(sep))
  ) {
    throw new Error("plugin approval digest source escaped the plugin root");
  }
  const linkStat = await lstat(input.path);
  const identityStat = await stat(input.path);
  input.entries.push({
    label: input.label,
    path: candidateRelative,
    realpath: candidateReal,
    identity: {
      dev: String(identityStat.dev),
      ino: String(identityStat.ino),
      size: String(identityStat.size),
      mtimeMs: identityStat.mtimeMs,
      linkMode: linkStat.mode,
    },
  });
  if (linkStat.isDirectory()) {
    const children: Array<{ readonly name: string }> = [];
    const directory = await opendir(input.path);
    try {
      for await (const child of directory) {
        if (input.entries.length + children.length >= MAX_APPROVAL_DIGEST_FILES) {
          throw new Error("plugin approval digest contains too many files");
        }
        children.push(child);
      }
    } finally {
      await directory.close?.()?.catch(() => undefined);
    }
    for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
      await appendApprovalDigestPath({
        ...input,
        path: join(input.path, child.name),
        label: `${input.label}/${child.name}`,
        depth: input.depth + 1,
      });
    }
    return;
  }
  if (!linkStat.isFile()) throw new Error("plugin approval digest source is not a regular file");
  const bytes = await readMossPluginFileNoFollow(input.path);
  input.byteCount.value += bytes.byteLength;
  if (input.byteCount.value > MAX_APPROVAL_DIGEST_BYTES) {
    throw new Error("plugin approval digest exceeds the byte limit");
  }
  input.entries.push({ label: `${input.label}:bytes`, bytes: bytes.toString("base64") });
}

async function approvalSnapshotSourceDescriptor(
  plugin: MossPluginIR,
  component: MossPluginComponent,
): Promise<MossPluginApprovalSourceDescriptor | undefined> {
  if (!component.sourcePath) return undefined;
  const source = await componentAbsolutePath(plugin, component);
  if (!source) throw new Error(`unsafe source path for component ${component.id}`);
  const sourceIdentity = await stat(source);
  const entries: Array<Record<string, unknown>> = [];
  const byteCount = { value: 0 };
  await appendApprovalDigestPath({
    pluginRoot: plugin.absolutePluginRoot,
    path: source,
    label: `component:${component.id}`,
    entries,
    byteCount,
    depth: 0,
  });
  return {
    sourcePath: component.sourcePath,
    snapshotPath: relative(plugin.absolutePluginRoot, source),
    contentHash: createHash("sha256")
      .update(JSON.stringify(stableApprovalValue(entries)))
      .digest("hex"),
    identity: {
      dev: String(sourceIdentity.dev),
      ino: String(sourceIdentity.ino),
      mode: sourceIdentity.mode,
      size: String(sourceIdentity.size),
      mtimeMs: sourceIdentity.mtimeMs,
    },
  };
}

async function copyApprovalSnapshotPath(input: {
  readonly source: string;
  readonly target: string;
  readonly counters: { files: number; bytes: number };
  readonly depth: number;
}): Promise<void> {
  if (input.depth > MAX_APPROVAL_DIRECTORY_DEPTH) {
    throw new Error("plugin approval snapshot directory nesting exceeds the safety limit");
  }
  const sourceLinkStat = await lstat(input.source);
  if (sourceLinkStat.isSymbolicLink()) {
    throw new Error("plugin approval snapshot rejects symbolic-link sources");
  }
  input.counters.files += 1;
  if (input.counters.files > MAX_APPROVAL_DIGEST_FILES) {
    throw new Error("plugin approval digest contains too many files");
  }
  if (sourceLinkStat.isDirectory()) {
    await mkdir(input.target, { recursive: true, mode: 0o700 });
    const directory = await opendir(input.source);
    try {
      for await (const child of directory) {
        await copyApprovalSnapshotPath({
          source: join(input.source, child.name),
          target: join(input.target, child.name),
          counters: input.counters,
          depth: input.depth + 1,
        });
      }
    } finally {
      await directory.close?.()?.catch(() => undefined);
    }
    await chmod(input.target, 0o500);
    return;
  }
  if (!sourceLinkStat.isFile())
    throw new Error("plugin approval snapshot source is not a regular file");
  const bytes = await readMossPluginFileNoFollow(input.source);
  input.counters.bytes += bytes.byteLength;
  if (input.counters.bytes > MAX_APPROVAL_DIGEST_BYTES) {
    throw new Error("plugin approval digest exceeds the byte limit");
  }
  await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
  await writeFile(input.target, bytes, { mode: 0o400 });
  await chmod(input.target, 0o400);
}

async function createMossPluginApprovalSnapshot(input: {
  readonly plugin: MossPluginIR;
  readonly componentIds: ReadonlyArray<string>;
}): Promise<{ readonly plugin: MossPluginIR; readonly snapshot: MossPluginApprovalSnapshot }> {
  const root = await mkdtemp(join(tmpdir(), "moss-plugin-approval-"));
  try {
    const selectedComponentIds = Object.freeze([...new Set(input.componentIds)]);
    const digestBeforeSnapshot = await mossPluginRuntimeApprovalDigest(input);
    const manifestRelativePath = relative(
      input.plugin.absolutePluginRoot,
      input.plugin.absoluteManifestPath,
    );
    if (
      manifestRelativePath === "" ||
      manifestRelativePath.startsWith("..") ||
      manifestRelativePath.startsWith(sep)
    ) {
      throw new Error("plugin approval manifest escaped the plugin root");
    }
    const counters = { files: 0, bytes: 0 };
    const snapshotPluginRoot = await realpath(input.plugin.absolutePluginRoot);
    const copiedPaths = new Set<string>([manifestRelativePath]);
    await assertNoSymlinkPathWithin(
      input.plugin.absolutePluginRoot,
      input.plugin.absoluteManifestPath,
    );
    await copyApprovalSnapshotPath({
      source: input.plugin.absoluteManifestPath,
      target: join(root, manifestRelativePath),
      counters,
      depth: 0,
    });
    const selected = new Set(selectedComponentIds);
    for (const component of input.plugin.components) {
      if (!selected.has(component.id) || !component.sourcePath) continue;
      const source = await componentAbsolutePath(input.plugin, component);
      if (!source) throw new Error(`unsafe source path for component ${component.id}`);
      await assertNoSymlinkPathWithin(input.plugin.absolutePluginRoot, source);
      const relativePath = relative(snapshotPluginRoot, source);
      if (relativePath.startsWith("..") || relativePath.startsWith(sep)) {
        throw new Error(`plugin approval component escaped the plugin root: ${component.id}`);
      }
      if (copiedPaths.has(relativePath)) continue;
      copiedPaths.add(relativePath);
      await copyApprovalSnapshotPath({
        source,
        target: join(root, relativePath),
        counters,
        depth: 0,
      });
    }
    const digestAfterSnapshot = await mossPluginRuntimeApprovalDigest(input);
    if (digestAfterSnapshot !== digestBeforeSnapshot) {
      throw new Error("plugin source changed while approval snapshot was being created");
    }
    const snapshotPlugin = immutablePluginApprovalSnapshot(
      input.plugin,
      root,
      join(root, manifestRelativePath),
    );
    const selectedComponentSources: Record<string, MossPluginApprovalSourceDescriptor> = {};
    for (const component of snapshotPlugin.components) {
      if (!selected.has(component.id)) continue;
      const descriptor = await approvalSnapshotSourceDescriptor(snapshotPlugin, component);
      if (descriptor) selectedComponentSources[component.id] = descriptor;
    }
    const snapshotContentHash = await mossPluginRuntimeApprovalDigest({
      plugin: snapshotPlugin,
      componentIds: selectedComponentIds,
    });
    await chmod(root, 0o500);
    return {
      plugin: snapshotPlugin,
      snapshot: Object.freeze({
        root,
        manifestRelativePath,
        contentHash: snapshotContentHash,
        plugin: snapshotPlugin,
        selectedComponentIds,
        selectedComponentSources: Object.freeze(selectedComponentSources),
      }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function releaseMossPluginApprovalSnapshot(
  snapshot: MossPluginApprovalSnapshot | undefined,
): Promise<void> {
  if (!snapshot) return;
  await chmod(snapshot.root, 0o700).catch(() => undefined);
  await rm(snapshot.root, { recursive: true, force: true }).catch(() => undefined);
}

function pluginForApprovalSnapshot(
  plugin: MossPluginIR,
  approval: MossPluginRuntimeApproval | undefined,
): MossPluginIR {
  if (!approval) return plugin;
  const snapshot = APPROVAL_SNAPSHOT_BY_TOKEN.get(approval);
  return snapshot?.plugin ?? plugin;
}

/**
 * Bind approval to the bytes and identities that the runtime will actually
 * read. The old IR-only hash remains available for display/cache keys, but it
 * is intentionally insufficient for execution authority.
 */
export async function mossPluginRuntimeApprovalDigest(input: {
  readonly plugin: MossPluginIR;
  readonly componentIds: ReadonlyArray<string>;
}): Promise<string> {
  const selected = new Set(input.componentIds);
  const components = input.plugin.components.filter((component) => selected.has(component.id));
  if (components.length !== selected.size)
    throw new Error("plugin approval selected an undeclared component");
  const entries: Array<Record<string, unknown>> = [
    {
      pluginId: input.plugin.id,
      manifestPath: input.plugin.absoluteManifestPath,
      manifest: stableApprovalValue(input.plugin.manifest),
      components: components.map((component) => ({
        id: component.id,
        kind: component.kind,
        name: component.name,
        enabled: component.enabled,
        sourcePath: component.sourcePath,
        metadata: stableApprovalValue(component.metadata),
      })),
    },
  ];
  const byteCount = { value: 0 };
  await appendApprovalDigestPath({
    pluginRoot: input.plugin.absolutePluginRoot,
    path: input.plugin.absoluteManifestPath,
    label: "manifest",
    entries,
    byteCount,
    depth: 0,
  });
  for (const component of components) {
    if (!component.sourcePath) continue;
    const source = await componentAbsolutePath(input.plugin, component);
    if (!source) throw new Error(`unsafe source path for component ${component.id}`);
    await appendApprovalDigestPath({
      pluginRoot: input.plugin.absolutePluginRoot,
      path: source,
      label: `component:${component.id}`,
      entries,
      byteCount,
      depth: 0,
    });
  }
  return createHash("sha256")
    .update(JSON.stringify(stableApprovalValue(entries)))
    .digest("hex");
}

/**
 * Create the server-owned approval state used by provider adapters. The
 * workspace trust file is deliberately not consulted. Production callers may
 * replace the map with a DB-backed implementation, but the provider boundary
 * only accepts a registered server store, never a caller-supplied token.
 */
export function createMossPluginApprovalStore(options: { readonly now?: () => number } = {}): {
  readonly store: MossPluginApprovalStore;
  readonly issuer: MossPluginApprovalIssuer;
} {
  const now = options.now ?? Date.now;
  const records = new Map<string, MossPluginRuntimeApproval>();
  const authority: MossPluginApprovalAuthority = { tokens: new Map() };
  const mutableStore: MossPluginApprovalStore = {
    async get(input) {
      const record = records.get(approvalKey(input.cwd, input.plugin.id));
      if (
        !record ||
        !Number.isFinite(record.expiresAt) ||
        authority.tokens.get(record.tokenId) !== record
      )
        return undefined;
      if (record.expiresAt <= now()) {
        records.delete(approvalKey(input.cwd, input.plugin.id));
        authority.tokens.delete(record.tokenId);
        void releaseMossPluginApprovalSnapshot(APPROVAL_SNAPSHOT_BY_TOKEN.get(record));
        return undefined;
      }
      const snapshot = APPROVAL_SNAPSHOT_BY_TOKEN.get(record);
      return snapshot?.plugin.id === record.pluginId && snapshot.contentHash === record.contentHash
        ? record
        : undefined;
    },
  };
  const store = Object.freeze(mutableStore);
  APPROVAL_STORE_REGISTRY.set(store, authority);
  const mutableIssuer: MossPluginApprovalIssuer = {
    async approve(input) {
      const componentIds = Object.freeze([...new Set(input.componentIds)]);
      const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error("Moss plugin approval TTL must be finite and positive.");
      }
      const staged = await createMossPluginApprovalSnapshot({
        plugin: input.plugin,
        componentIds: Object.freeze(componentIds),
      });
      const contentHash = staged.snapshot.contentHash;
      const expiresAt = now() + ttlMs;
      if (!Number.isFinite(expiresAt)) {
        throw new Error("Moss plugin approval expiry must be finite.");
      }
      const token = Object.freeze({
        authority: "moss-server" as const,
        provenance: "server-owned-import" as const,
        pluginId: input.plugin.id,
        contentHash,
        componentIds,
        tokenId: randomUUID(),
        expiresAt,
        ...(input.allowLocalDevelopment === true ? { allowLocalDevelopment: true } : {}),
      });
      const key = approvalKey(input.cwd, input.plugin.id);
      const previous = records.get(key);
      records.set(key, token);
      authority.tokens.set(token.tokenId, token);
      APPROVAL_SNAPSHOT_BY_TOKEN.set(token, staged.snapshot);
      if (previous) {
        authority.tokens.delete(previous.tokenId);
        void releaseMossPluginApprovalSnapshot(APPROVAL_SNAPSHOT_BY_TOKEN.get(previous));
      }
      return token;
    },
    revoke(input) {
      const key = approvalKey(input.cwd, input.pluginId);
      const record = records.get(key);
      records.delete(key);
      if (record) {
        authority.tokens.delete(record.tokenId);
        void releaseMossPluginApprovalSnapshot(APPROVAL_SNAPSHOT_BY_TOKEN.get(record));
      }
    },
  };
  const issuer = Object.freeze(mutableIssuer);
  return { store, issuer };
}

const DENY_ALL_APPROVALS: MossPluginApprovalStore = {
  get: async () => undefined,
};
APPROVAL_STORE_REGISTRY.set(DENY_ALL_APPROVALS, { tokens: new Map(), denyAll: true });

/** Stable display/cache hash only; never use it as execution authority. */
export function mossPluginRuntimeContentHash(plugin: MossPluginIR): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: plugin.id,
        manifestPath: plugin.manifestPath,
        manifest: plugin.manifest,
        components: plugin.components,
      }),
    )
    .digest("hex");
}

/**
 * Compatibility seam for status/import callers. Workspace trust files are
 * requests or display metadata only; execution reads the injected store.
 */
export async function readMossPluginRuntimeApproval(input: {
  readonly cwd: string;
  readonly plugin: MossPluginIR;
}): Promise<MossPluginRuntimeApproval | undefined> {
  // Kept as a read-only compatibility seam for import/status UI. It must not
  // be used as an execution authority, so a workspace file can never produce
  // a runtime approval token.
  void input;
  return undefined;
}

async function resolvePluginApproval(input: {
  readonly cwd: string;
  readonly plugin: MossPluginIR;
  readonly approvalStore?: MossPluginApprovalStore | undefined;
}): Promise<MossPluginRuntimeApproval | undefined> {
  const store = input.approvalStore ?? DENY_ALL_APPROVALS;
  const authority = APPROVAL_STORE_REGISTRY.get(store);
  if (!authority || authority.denyAll) return undefined;
  const approval = await store.get({ cwd: input.cwd, plugin: input.plugin });
  if (
    !approval ||
    authority.tokens.get(approval.tokenId) !== approval ||
    !Number.isFinite(approval.expiresAt) ||
    approval.expiresAt <= Date.now()
  ) {
    return undefined;
  }
  const snapshot = APPROVAL_SNAPSHOT_BY_TOKEN.get(approval);
  if (!snapshot || snapshot.contentHash !== approval.contentHash) return undefined;
  return approval;
}

function isApprovedPluginComponent(
  plugin: MossPluginIR,
  component: MossPluginComponent,
  approval: MossPluginRuntimeApproval | undefined,
): boolean {
  return (
    approval?.authority === "moss-server" &&
    approval.provenance === "server-owned-import" &&
    approval.tokenId.length > 0 &&
    approval.expiresAt > Date.now() &&
    approval.pluginId === plugin.id &&
    approval.componentIds.includes(component.id) &&
    plugin.marketplacePolicy.installation !== "NOT_AVAILABLE"
  );
}

export interface DiscoverMossPluginRuntimeInput {
  readonly cwd: string;
  /** Optional formal plugin roots supplied by an importer/marketplace. */
  readonly pluginRoots?: ReadonlyArray<string>;
  /** Optional plugin-creator marketplace.json to validate against. */
  readonly marketplacePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readMarketplaceEntries(
  marketplacePath: string,
): Promise<{ readonly entries: Map<string, unknown>; readonly error?: string | undefined }> {
  try {
    const raw = JSON.parse(
      await (async () => {
        const bytes = await readMossPluginFileNoFollow(marketplacePath);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) throw new Error("plugin marketplace contains a NUL byte");
        return text;
      })(),
    ) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.plugins)) {
      return { entries: new Map(), error: "marketplace.json must contain a plugins array." };
    }
    const validation = validateMossPluginMarketplace(raw);
    const entries = new Map<string, unknown>();
    for (const entry of raw.plugins) {
      if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim().length === 0) {
        continue;
      }
      entries.set(entry.name.trim(), entry);
    }
    return {
      entries,
      ...(validation.errors[0]
        ? { error: `Marketplace validation failed: ${validation.errors[0].message}` }
        : {}),
    };
  } catch (error) {
    return {
      entries: new Map(),
      error: `Could not read marketplace ${marketplacePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function pluginRootFromInput(cwd: string, value: string): string {
  const absolute = resolve(cwd, value);
  const leaf = basename(absolute);
  if (leaf === "plugin.json") {
    const manifestDirectory = dirname(absolute);
    return basename(manifestDirectory) === ".codex-plugin"
      ? dirname(manifestDirectory)
      : manifestDirectory;
  }
  if (leaf === ".codex-plugin") return dirname(absolute);
  return absolute;
}

function pluginFromResource(resource: {
  readonly metadata: Record<string, unknown>;
}): MossPluginIR | undefined {
  const plugin = resource.metadata.plugin;
  return plugin && typeof plugin === "object" && !Array.isArray(plugin)
    ? (plugin as MossPluginIR)
    : undefined;
}

/** Discover canonical `.moss` plugins and optional formal marketplace roots. */
export async function discoverMossPluginRuntime(
  input: DiscoverMossPluginRuntimeInput,
): Promise<MossPluginRuntimeSnapshot> {
  const cwd = resolve(input.cwd);
  const errors: string[] = [];
  const resources = await discoverMossSourceResources(cwd);
  for (const resource of resources) {
    if (resource.kind !== "plugin") continue;
    const sourceError = resource.metadata.sourceError;
    if (typeof sourceError === "string") errors.push(`${resource.name}: ${sourceError}`);
  }
  const plugins: MossPluginIR[] = resources
    .filter((resource) => resource.kind === "plugin")
    .flatMap((resource) => {
      const plugin = pluginFromResource(resource);
      return plugin ? [plugin] : [];
    });

  let marketplaceEntries = new Map<string, unknown>();
  if (input.marketplacePath) {
    const marketplace = await readMarketplaceEntries(resolve(cwd, input.marketplacePath));
    marketplaceEntries = marketplace.entries;
    if (marketplace.error) errors.push(marketplace.error);
  }

  const seen = new Set(plugins.map((plugin) => plugin.id));
  for (const root of input.pluginRoots ?? []) {
    const pluginRoot = pluginRootFromInput(cwd, root);
    let plugin: MossPluginIR;
    try {
      plugin = await readMossPluginManifest({
        projectPath: cwd,
        pluginRoot,
        marketplaceEntry: marketplaceEntries.get(basename(pluginRoot)),
      });
    } catch (error) {
      errors.push(
        `${root}: plugin source could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (seen.has(plugin.id)) {
      errors.push(
        `Duplicate plugin ${plugin.name} was ignored from ${root}; canonical Moss source wins.`,
      );
      continue;
    }
    seen.add(plugin.id);
    plugins.push(plugin);
  }

  for (const plugin of plugins) {
    for (const validationError of plugin.validation.errors) {
      errors.push(`${plugin.name}: ${validationError.message}`);
    }
  }

  return { cwd, plugins, errors };
}

/** Alias used by importers that treat runtime discovery as a load operation. */
export const loadMossPluginRuntime = discoverMossPluginRuntime;

function componentStatus(
  plugin: MossPluginIR,
  component: MossPluginComponent,
  capability: MossPluginProviderCapability,
): MossPluginRuntimeComponentStatus {
  if (!plugin.validation.ok) return "blocked";
  if (!plugin.enabled) return "display-only";
  if (!component.enabled) return "display-only";
  if (component.kind === "hook" && !isTrustedPluginHook(component)) return "display-only";
  if (capability.execution === "none") return "display-only";
  return capability.projection === "native" ? "ready" : "degraded";
}

function componentSupportStatus(
  provider: ProviderKind,
  component: MossPluginComponent,
  capability: MossPluginProviderCapability,
): MossPluginRuntimeSupportStatus {
  if (component.kind === "skill") {
    return provider === "codex" || provider === "claudeAgent" ? "projected" : "injected";
  }
  if (component.kind === "subagent") {
    return provider === "codex" || provider === "claudeAgent" ? "projected" : "unsupported";
  }
  if (component.kind === "mcp" && capability.execution !== "none") {
    const definition = componentDefinition(component);
    if (provider === "pi" && (typeof definition?.url !== "string" || definition.type === "sse")) {
      return "unsupported";
    }
    return "injected";
  }
  return "unsupported";
}

function isTrustedPluginHook(component: MossPluginComponent): boolean {
  // A plugin manifest is untrusted input. In particular, a nested
  // `trustState: "trusted"` field is not an authorization grant. Plugin hooks
  // stay unsupported until a server-owned hook trust record and content hash
  // are wired into this boundary.
  return component.kind !== "hook" ? true : false;
}

export function buildMossPluginRuntimePlan(input: {
  readonly plugin: MossPluginIR;
  readonly provider: ProviderKind;
}): MossPluginRuntimePlan {
  const components = input.plugin.components.map((component) => {
    const capability = getMossPluginCapability(input.provider, component.kind);
    const status = componentStatus(input.plugin, component, capability);
    const plannedSupportStatus =
      status === "blocked" || status === "display-only"
        ? "unsupported"
        : componentSupportStatus(input.provider, component, capability);
    const supportStatus: MossPluginRuntimeSupportStatus = "unsupported";
    const reason =
      status === "blocked" || status === "display-only"
        ? status === "blocked"
          ? `Plugin validation blocked execution: ${input.plugin.validation.errors.map((error) => error.code).join(", ")}.`
          : "No observed provider operation is available for this component."
        : "Planned capability only; no provider adapter has confirmed a successful operation and read-back.";
    return {
      id: component.id,
      kind: component.kind,
      name: component.name,
      enabled: component.enabled,
      ...(component.sourcePath ? { sourcePath: component.sourcePath } : {}),
      projection: capability.projection,
      execution: capability.execution,
      ...(capability.target ? { target: capability.target } : {}),
      status,
      plannedSupportStatus,
      supportStatus,
      reason,
      capability,
    } satisfies MossPluginRuntimeComponentPlan;
  });
  const warnings = [
    ...input.plugin.validation.warnings.map((warning) => warning.message),
    ...components
      .filter((component) => component.status === "degraded")
      .map(
        (component) =>
          `${component.kind}:${component.name} uses an adapter/degraded surface on ${input.provider}.`,
      ),
  ];
  return {
    pluginId: input.plugin.id,
    pluginName: input.plugin.name,
    provider: input.provider,
    validation: input.plugin.validation,
    components,
    executionReady: false,
    warnings,
  };
}

export interface MossPluginMcpServerDefinition {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly componentId: string;
  readonly serverName: string;
  readonly config: Record<string, unknown>;
  readonly allowLocalDevelopment?: boolean | undefined;
}

export interface DerivedMossPluginMcpServers {
  /** ACP-compatible servers, ready for session/new or session/load. */
  readonly servers: MossAcpMcpServer[];
  readonly serverNames: string[];
  readonly definitions: MossPluginMcpServerDefinition[];
  readonly warnings: string[];
}

export interface DerivedMossPluginProviderMcpServers {
  readonly definitions: MossPluginMcpServerDefinition[];
  readonly warnings: string[];
}

function emptyPluginMcpResult(): DerivedMossPluginMcpServers {
  return { servers: [], serverNames: [], definitions: [], warnings: [] };
}

function emptyProviderMcpResult(): DerivedMossPluginProviderMcpServers {
  return { definitions: [], warnings: [] };
}

function componentDefinition(component: MossPluginComponent): Record<string, unknown> | undefined {
  const metadataDefinition = component.metadata.definition;
  if (!isRecord(metadataDefinition)) return undefined;
  const nested = metadataDefinition.definition;
  if (isRecord(nested)) return nested;
  return metadataDefinition;
}

function mcpDefinitionDisabled(value: Record<string, unknown>): boolean {
  if (
    value.enabled === false ||
    value.quarantine === true ||
    value.quarantined === true ||
    value.quarantine === "quarantined"
  ) {
    return true;
  }
  return isRecord(value.definition) && mcpDefinitionDisabled(value.definition);
}

const MCP_SECRET_KEY =
  /(?:secret|token|password|passwd|api[-_]?key|authorization|private[-_]?key|client[-_]?secret)/i;
const MCP_SECRET_REFERENCE = /^(?:\$\{)?(?:MOSS_SECRET_[A-Z0-9_]+|env:[A-Z][A-Z0-9_]*)(?:\})?$/;

function isMcpSecretReference(value: string): boolean {
  return MCP_SECRET_REFERENCE.test(value);
}

const MCP_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const MCP_HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

function toSafeMcpStringRecord(value: unknown, keyPattern: RegExp): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      keyPattern.test(key) && typeof entry === "string" ? [[key, entry]] : [],
    ),
  );
}

function unsafeMcpConfigKey(config: Record<string, unknown>): string | undefined {
  const env = config.env;
  if (isRecord(env) && Object.keys(env).some((key) => !MCP_ENV_NAME.test(key))) {
    return "environment variable names must be uppercase shell identifiers";
  }
  for (const field of ["headers", "http_headers"]) {
    const headers = config[field];
    if (isRecord(headers) && Object.keys(headers).some((key) => !MCP_HEADER_NAME.test(key))) {
      return `${field} contains an unsafe HTTP header name`;
    }
  }
  const envHttpHeaders = config.env_http_headers;
  if (isRecord(envHttpHeaders)) {
    if (Object.keys(envHttpHeaders).some((key) => !MCP_HEADER_NAME.test(key))) {
      return "env_http_headers contains an unsafe HTTP header name";
    }
    if (
      Object.values(envHttpHeaders).some(
        (value) => typeof value !== "string" || !MCP_ENV_NAME.test(value),
      )
    ) {
      return "env_http_headers values must be uppercase shell identifiers";
    }
  }
  if (
    config.bearer_token_env_var !== undefined &&
    (typeof config.bearer_token_env_var !== "string" ||
      !MCP_ENV_NAME.test(config.bearer_token_env_var))
  ) {
    return "bearer_token_env_var must be an uppercase shell identifier";
  }
  return undefined;
}

function hasUnsafeInlineMcpSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasUnsafeInlineMcpSecret(entry));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    if (key === "headers" || key === "http_headers") {
      return hasUnsafeMcpHeaderValues(entry);
    }
    if (key === "bearer_token_env_var") {
      return typeof entry !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(entry);
    }
    if (key === "env_http_headers") {
      return (
        !isRecord(entry) ||
        Object.values(entry).some(
          (envName) => typeof envName !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(envName),
        )
      );
    }
    if (MCP_SECRET_KEY.test(key)) {
      return typeof entry !== "string" || !isMcpSecretReference(entry);
    }
    return hasUnsafeInlineMcpSecret(entry);
  });
}

/** Plugin-provided header values are never arbitrary strings. */
function hasUnsafeMcpHeaderValues(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return Object.entries(value).some(
    ([key, entry]) =>
      !MCP_HEADER_NAME.test(key) || typeof entry !== "string" || !isMcpSecretReference(entry),
  );
}

function hasUnresolvedMcpSecretReference(value: unknown): boolean {
  if (typeof value === "string") return isMcpSecretReference(value);
  if (Array.isArray(value)) return value.some(hasUnresolvedMcpSecretReference);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    // These fields are environment identities, not secret values. Providers
    // receive the identity and resolve it in their own supported auth path.
    if (key === "bearer_token_env_var" || key === "env_http_headers") return false;
    return hasUnresolvedMcpSecretReference(entry);
  });
}

function hasUnsafeMcpUrlSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    return [...parsed.searchParams.keys()].length > 0;
  } catch {
    return true;
  }
}

const MCP_SECRET_ARGUMENT =
  /^(?:--?|\/)(?:api[-_]?key|token|password|passwd|secret|authorization|auth|private[-_]?key|client[-_]?secret)(?:=|$)/i;
const MCP_SECRET_CARRIER_ARGUMENT = /^(?:--header|-H|--access-token|--cookie|--session)(?:=|$)/i;
const MCP_SECRET_CARRIER_VALUE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-access-token|session(?:-id)?):/i;

function hasUnsafeMcpCommandSecret(config: Record<string, unknown>): boolean {
  const command =
    typeof config.command === "string" ? config.command.trim().split(/\s+/).filter(Boolean) : [];
  const args = toStringArray(config.args);
  const values = [...command, ...args];
  return values.some((value, index) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (MCP_SECRET_CARRIER_VALUE.test(trimmed)) return true;
    const separator = trimmed.indexOf("=");
    if (separator > 0 && MCP_SECRET_CARRIER_ARGUMENT.test(trimmed.slice(0, separator + 1))) {
      return !isMcpSecretReference(trimmed.slice(separator + 1));
    }
    if (MCP_SECRET_CARRIER_ARGUMENT.test(trimmed)) {
      const next = values[index + 1]?.trim();
      return next === undefined || !isMcpSecretReference(next);
    }
    if (separator > 0 && MCP_SECRET_ARGUMENT.test(trimmed.slice(0, separator + 1))) {
      return !isMcpSecretReference(trimmed.slice(separator + 1));
    }
    if (!MCP_SECRET_ARGUMENT.test(trimmed)) return false;
    const next = values[index + 1]?.trim();
    return next !== undefined && !isMcpSecretReference(next);
  });
}

function canonicalMossPluginMcpName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function isBlockedMcpIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) return false;
  const values = octets.map(Number);
  if (values.some((value) => value < 0 || value > 255)) return false;
  if (values.length !== 4) return false;
  const first = values[0];
  const second = values[1];
  const third = values[2];
  if (first === undefined || second === undefined || third === undefined) return false;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseMcpIpv6(hostname: string): number[] | undefined {
  if (isIP(hostname) !== 6) return undefined;
  const halves = hostname.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] => {
    if (!half) return [];
    const parts = half.split(":");
    const groups: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const octets = part.split(".").map(Number);
        if (
          octets.length !== 4 ||
          octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
        ) {
          return [];
        }
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        groups.push(Number.parseInt(part, 16));
      } else {
        return [];
      }
    }
    return groups;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if ((halves[0] && left.length === 0) || (halves[1] && right.length === 0)) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing > 0 ? [...left, ...new Array(missing).fill(0), ...right] : undefined;
}

function isBlockedMcpIpv6(hostname: string): boolean {
  const groups = parseMcpIpv6(hostname);
  if (!groups) return false;
  const allZero = groups.every((group) => group === 0);
  const loopback = allZero || groups.slice(0, 7).every((group) => group === 0 && groups[7] === 1);
  const first = groups[0]!;
  if (
    loopback ||
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xfe80 && first <= 0xfebf) ||
    first >= 0xff00
  ) {
    return true;
  }
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6]! >>> 8}.${groups[6]! & 0xff}.${groups[7]! >>> 8}.${groups[7]! & 0xff}`;
    return isBlockedMcpIpv4(mapped);
  }
  return false;
}

function blockedMossPluginMcpUrl(value: string, allowLocalDevelopment = false): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "the URL is invalid";
  }
  if (parsed.username || parsed.password) return "embedded URL credentials are not allowed";
  if ([...parsed.searchParams.keys()].length > 0) {
    return "URL query parameters are not allowed on MCP transports";
  }
  if (parsed.protocol !== "https:") {
    if (parsed.protocol !== "http:" || !allowLocalDevelopment) {
      return "only https:// URLs are allowed without an approved local-development channel";
    }
  }
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const privateIpv4 = isBlockedMcpIpv4(hostname);
  const privateIpv6 = isBlockedMcpIpv6(hostname);
  const blockedHost =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata" ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data" ||
    /^0x[0-9a-f]+$/i.test(hostname) ||
    /^\d+$/.test(hostname) ||
    privateIpv4 ||
    privateIpv6;
  const metadataHost =
    hostname === "metadata" ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data" ||
    (privateIpv4 && hostname.startsWith("169.254."));
  if (metadataHost) return "cloud-metadata and link-local hosts are never allowed";
  if (blockedHost && !allowLocalDevelopment) {
    return "loopback, private, link-local, or cloud-metadata hosts require an approved local-development channel";
  }
  return undefined;
}

export function redactMossPluginMcpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname || "/"}`;
  } catch {
    return "[REDACTED_INVALID_URL]";
  }
}

function pluginMcpDefinitions(
  plugin: MossPluginIR,
  provider: ProviderKind,
  approval?: MossPluginRuntimeApproval,
): { definitions: MossPluginMcpServerDefinition[]; warnings: string[] } {
  const definitions: MossPluginMcpServerDefinition[] = [];
  const warnings: string[] = [];
  const capability = getMossPluginCapability(provider, "mcp");
  if (capability.execution === "none") return { definitions, warnings };

  for (const component of plugin.components) {
    if (component.kind !== "mcp") continue;
    const config = componentDefinition(component);
    if (!config) {
      warnings.push(
        `${plugin.name}:${component.name} is unsupported: its MCP declaration is not an object.`,
      );
      continue;
    }
    if (!component.enabled || mcpDefinitionDisabled(config)) {
      warnings.push(`${plugin.name}:${component.name} is disabled in its MCP declaration.`);
      continue;
    }
    if (!isApprovedPluginComponent(plugin, component, approval)) {
      warnings.push(
        `${plugin.name}:${component.name} is unsupported: server-owned explicit plugin approval and content provenance are required before MCP execution.`,
      );
      continue;
    }
    if (
      hasUnsafeInlineMcpSecret(config) ||
      hasUnresolvedMcpSecretReference(config) ||
      hasUnsafeMcpUrlSecret(config.url) ||
      hasUnsafeMcpCommandSecret(config)
    ) {
      warnings.push(
        `${plugin.name}:${component.name} is unsupported: inline MCP secrets are forbidden; use secret references or environment identities.`,
      );
      continue;
    }
    if (
      provider !== "codex" &&
      (config.bearer_token_env_var !== undefined || config.env_http_headers !== undefined)
    ) {
      warnings.push(
        `${plugin.name}:${component.name} is unsupported on ${provider}: environment-backed HTTP authentication has no verified adapter mapping.`,
      );
      continue;
    }
    const unsafeKey = unsafeMcpConfigKey(config);
    if (unsafeKey) {
      warnings.push(`${plugin.name}:${component.name} is unsupported: ${unsafeKey}.`);
      continue;
    }
    const serverName = canonicalMossPluginMcpName(component.name);
    if (!serverName || serverName === "moss") {
      warnings.push(
        `${plugin.name}:${component.name} is unsupported: '${serverName || "<empty>"}' is reserved or empty.`,
      );
      continue;
    }
    const hasCommand = typeof config.command === "string" && config.command.trim().length > 0;
    const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
    if (!hasCommand && !hasUrl) {
      warnings.push(
        `${plugin.name}:${component.name} is unsupported: MCP declaration has neither command nor url.`,
      );
      continue;
    }
    if (hasCommand && hasUrl) {
      warnings.push(
        `${plugin.name}:${component.name} is unsupported: an MCP server may declare command or url, not both.`,
      );
      continue;
    }
    if (hasUrl) {
      const blockedUrl = blockedMossPluginMcpUrl(
        String(config.url),
        approval?.allowLocalDevelopment === true,
      );
      if (blockedUrl) {
        warnings.push(`${plugin.name}:${component.name} is unsupported: ${blockedUrl}.`);
        continue;
      }
      if (approval?.allowLocalDevelopment === true && provider !== "pi") {
        warnings.push(
          `${plugin.name}:${component.name} is unsupported on ${provider}: approved local-development MCP URLs require the pinned Pi transport.`,
        );
        continue;
      }
    }
    definitions.push({
      pluginId: plugin.id,
      pluginName: plugin.name,
      componentId: component.id,
      serverName,
      config,
      ...(approval?.allowLocalDevelopment === true ? { allowLocalDevelopment: true } : {}),
    });
  }
  return { definitions, warnings };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : [];
}

function canonicalDefinitionServerName(
  definition: MossPluginMcpServerDefinition,
): string | undefined {
  if (!isSafeMossPluginComponentName(definition.serverName)) return undefined;
  const canonical = canonicalMossPluginMcpName(definition.serverName);
  return canonical && canonical !== "moss" ? canonical : undefined;
}

function toAcpPluginMcpServer(
  definition: MossPluginMcpServerDefinition,
): MossAcpMcpServer | undefined {
  const config = definition.config;
  const serverName = canonicalDefinitionServerName(definition);
  if (
    !serverName ||
    definition.allowLocalDevelopment === true ||
    unsafeMcpConfigKey(config) ||
    hasUnsafeInlineMcpSecret(config) ||
    hasUnresolvedMcpSecretReference(config) ||
    hasUnsafeMcpUrlSecret(config.url) ||
    config.bearer_token_env_var !== undefined ||
    config.env_http_headers !== undefined
  ) {
    return undefined;
  }
  if (typeof config.command === "string" && config.command.trim()) {
    return {
      name: serverName,
      command: config.command,
      args: toStringArray(config.args),
      env: Object.entries(toSafeMcpStringRecord(config.env, MCP_ENV_NAME)).map(([name, value]) => ({
        name,
        value,
      })),
    };
  }
  if (typeof config.url === "string" && config.url.trim()) {
    return {
      type: config.type === "sse" ? "sse" : "http",
      name: serverName,
      url: config.url,
      headers: Object.entries(toSafeMcpStringRecord(config.headers, MCP_HEADER_NAME)).map(
        ([name, value]) => ({ name, value }),
      ),
    };
  }
  return undefined;
}

async function resolveRuntimePlugins(input: {
  readonly cwd: string;
  readonly plugin?: MossPluginIR | undefined;
}): Promise<{ plugins: MossPluginIR[]; warnings: string[] }> {
  if (input.plugin) return { plugins: [input.plugin], warnings: [] };
  const runtime = await discoverMossPluginRuntime({ cwd: input.cwd });
  return { plugins: [...runtime.plugins], warnings: [...runtime.errors] };
}

/** Derive plugin MCP declarations for an ACP session handshake. */
export async function deriveMossPluginMcpServers(input: {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly plugin?: MossPluginIR | undefined;
  readonly approvalStore?: MossPluginApprovalStore | undefined;
}): Promise<DerivedMossPluginMcpServers> {
  const resolved = await resolveRuntimePlugins({
    cwd: input.cwd,
    ...(input.plugin ? { plugin: input.plugin } : {}),
  });
  const result = emptyPluginMcpResult();
  result.warnings.push(...resolved.warnings);
  for (const plugin of resolved.plugins) {
    const approval = await resolvePluginApproval({
      cwd: input.cwd,
      plugin,
      ...(input.approvalStore ? { approvalStore: input.approvalStore } : {}),
    });
    const approvedPlugin = pluginForApprovalSnapshot(plugin, approval);
    if (!approvedPlugin.enabled || !approvedPlugin.validation.ok) {
      result.warnings.push(
        `${approvedPlugin.name}: plugin validation or enabled gate blocks MCP injection.`,
      );
      continue;
    }
    const derived = pluginMcpDefinitions(approvedPlugin, input.provider, approval);
    result.warnings.push(...derived.warnings);
    for (const definition of derived.definitions) {
      if (result.serverNames.includes(definition.serverName)) {
        result.warnings.push(
          `${approvedPlugin.name}:${definition.serverName} is unsupported: canonical MCP name collision with an earlier server.`,
        );
        continue;
      }
      const server = toAcpPluginMcpServer(definition);
      if (!server) continue;
      result.definitions.push(definition);
      result.servers.push(server);
      result.serverNames.push(definition.serverName);
    }
  }
  return result;
}

/** Derive plugin MCP declarations for Claude/OpenCode/Pi adapters. */
export async function deriveMossPluginProviderMcpServers(input: {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly plugin?: MossPluginIR | undefined;
  readonly approvalStore?: MossPluginApprovalStore | undefined;
}): Promise<DerivedMossPluginProviderMcpServers> {
  const resolved = await resolveRuntimePlugins({
    cwd: input.cwd,
    ...(input.plugin ? { plugin: input.plugin } : {}),
  });
  const result = emptyProviderMcpResult();
  result.warnings.push(...resolved.warnings);
  const seen = new Set<string>();
  for (const plugin of resolved.plugins) {
    const approval = await resolvePluginApproval({
      cwd: input.cwd,
      plugin,
      ...(input.approvalStore ? { approvalStore: input.approvalStore } : {}),
    });
    const approvedPlugin = pluginForApprovalSnapshot(plugin, approval);
    if (!approvedPlugin.enabled || !approvedPlugin.validation.ok) {
      result.warnings.push(
        `${approvedPlugin.name}: plugin validation or enabled gate blocks MCP injection.`,
      );
      continue;
    }
    const derived = pluginMcpDefinitions(approvedPlugin, input.provider, approval);
    result.warnings.push(...derived.warnings);
    for (const definition of derived.definitions) {
      if (seen.has(definition.serverName)) {
        result.warnings.push(
          `${approvedPlugin.name}:${definition.serverName} is unsupported: canonical MCP name collision with an earlier server.`,
        );
        continue;
      }
      // Pi's SDK does not expose a native MCP registry. Its HTTP adapter is
      // wired separately; local command MCPs remain explicitly unsupported.
      if (
        input.provider === "pi" &&
        (typeof definition.config.url !== "string" || definition.config.type === "sse")
      ) {
        result.warnings.push(
          `${plugin.name}:${definition.serverName} is unsupported on Pi: the session adapter only accepts HTTP MCP servers.`,
        );
        continue;
      }
      seen.add(definition.serverName);
      result.definitions.push(definition);
    }
  }
  return result;
}

export interface MossPluginCodexMcpOverrides {
  readonly args: string[];
  readonly serverNames: string[];
  readonly warnings: string[];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Build the same `-c mcp_servers.*` launch surface as the canonical MCP reader. */
export function toMossPluginCodexMcpOverrides(
  definitions: ReadonlyArray<MossPluginMcpServerDefinition>,
  existingServerNames: ReadonlySet<string> = new Set(),
): MossPluginCodexMcpOverrides {
  const args: string[] = [];
  const serverNames: string[] = [];
  const warnings: string[] = [];
  const existingCanonicalNames = new Set(
    [...existingServerNames].map((name) => canonicalMossPluginMcpName(name)),
  );
  for (const definition of definitions) {
    const serverName = canonicalDefinitionServerName(definition);
    if (!serverName || existingCanonicalNames.has(serverName) || serverNames.includes(serverName)) {
      warnings.push(
        `${definition.pluginName}:${definition.serverName} is unsupported: the MCP server name is unsafe or already owned.`,
      );
      continue;
    }
    const prefix = `mcp_servers.${serverName}`;
    const config = definition.config;
    if (config.type === "sse") {
      warnings.push(
        `${definition.pluginName}:${definition.serverName} is unsupported: Codex MCP SSE is not mapped to HTTP.`,
      );
      continue;
    }
    if (
      hasUnsafeInlineMcpSecret(config) ||
      hasUnresolvedMcpSecretReference(config) ||
      hasUnsafeMcpUrlSecret(config.url) ||
      hasUnsafeMcpCommandSecret(config)
    ) {
      warnings.push(
        `${definition.pluginName}:${definition.serverName} is unsupported: secret values cannot be serialized into Codex argv.`,
      );
      continue;
    }
    const unsafeKey = unsafeMcpConfigKey(config);
    if (unsafeKey) {
      warnings.push(
        `${definition.pluginName}:${definition.serverName} is unsupported: ${unsafeKey}.`,
      );
      continue;
    }
    let emitted = false;
    if (typeof config.command === "string" && config.command.trim()) {
      args.push("-c", `${prefix}.command=${tomlString(config.command)}`);
      emitted = true;
    }
    if (typeof config.url === "string" && config.url.trim()) {
      args.push("-c", `${prefix}.url=${tomlString(config.url)}`);
      emitted = true;
    }
    if (Array.isArray(config.args) && config.args.every((entry) => typeof entry === "string")) {
      args.push(
        "-c",
        `${prefix}.args=[${config.args.map((entry) => tomlString(entry)).join(", ")}]`,
      );
      emitted = true;
    }
    const env = toSafeMcpStringRecord(config.env, MCP_ENV_NAME);
    if (Object.keys(env).length > 0) {
      args.push(
        "-c",
        `${prefix}.env={${Object.entries(env)
          .map(([key, value]) => `${key} = ${tomlString(value)}`)
          .join(", ")}}`,
      );
      emitted = true;
    }
    const headers = {
      ...toSafeMcpStringRecord(config.http_headers, MCP_HEADER_NAME),
      ...toSafeMcpStringRecord(config.headers, MCP_HEADER_NAME),
    };
    if (Object.keys(headers).length > 0) {
      args.push(
        "-c",
        `${prefix}.http_headers={${Object.entries(headers)
          .map(([key, value]) => `${key} = ${tomlString(value)}`)
          .join(", ")}}`,
      );
      emitted = true;
    }
    if (
      typeof config.bearer_token_env_var === "string" &&
      MCP_ENV_NAME.test(config.bearer_token_env_var)
    ) {
      args.push("-c", `${prefix}.bearer_token_env_var=${tomlString(config.bearer_token_env_var)}`);
      emitted = true;
    }
    const envHttpHeaders = toSafeMcpStringRecord(config.env_http_headers, MCP_HEADER_NAME);
    if (Object.keys(envHttpHeaders).length > 0) {
      args.push(
        "-c",
        `${prefix}.env_http_headers={${Object.entries(envHttpHeaders)
          .map(([key, value]) => `${key} = ${tomlString(value)}`)
          .join(", ")}}`,
      );
      emitted = true;
    }
    if (config.cwd !== undefined) {
      warnings.push(
        `${definition.pluginName}:${definition.serverName} Codex does not support MCP cwd in this launch surface; field ignored.`,
      );
    }
    if (config.timeout !== undefined) {
      warnings.push(
        `${definition.pluginName}:${definition.serverName} Codex does not support MCP timeout in this launch surface; field ignored.`,
      );
    }
    if (emitted) {
      serverNames.push(serverName);
    } else {
      warnings.push(
        `${definition.pluginName}:${definition.serverName} is unsupported: no Codex MCP override could be built.`,
      );
    }
  }
  return { args, serverNames, warnings };
}

export interface MossPluginOpenCodeMcpServer {
  readonly name: string;
  readonly config:
    | {
        readonly type: "local";
        readonly command: string[];
        readonly environment?: Record<string, string>;
        readonly cwd?: string;
        readonly timeout?: number;
        readonly enabled: true;
      }
    | {
        readonly type: "remote";
        readonly url: string;
        readonly enabled: true;
        readonly headers?: Record<string, string>;
        readonly timeout?: number;
        readonly oauth: false;
      };
  readonly componentId: string;
}

export function toMossPluginOpenCodeMcpServers(
  definitions: ReadonlyArray<MossPluginMcpServerDefinition>,
): MossPluginOpenCodeMcpServer[] {
  const servers: MossPluginOpenCodeMcpServer[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const config = definition.config;
    const serverName = canonicalDefinitionServerName(definition);
    if (
      !serverName ||
      definition.allowLocalDevelopment === true ||
      seen.has(serverName) ||
      unsafeMcpConfigKey(config) ||
      config.bearer_token_env_var !== undefined ||
      config.env_http_headers !== undefined
    ) {
      continue;
    }
    if (typeof config.command === "string" && config.command.trim()) {
      if (
        hasUnsafeInlineMcpSecret(config) ||
        hasUnresolvedMcpSecretReference(config) ||
        hasUnsafeMcpUrlSecret(config.url) ||
        hasUnsafeMcpCommandSecret(config)
      )
        continue;
      seen.add(serverName);
      const environment = toSafeMcpStringRecord(config.env, MCP_ENV_NAME);
      servers.push({
        name: serverName,
        config: {
          type: "local",
          command: [config.command, ...toStringArray(config.args)],
          ...(Object.keys(environment).length > 0 ? { environment } : {}),
          ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
          ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
          enabled: true,
        },
        componentId: definition.componentId,
      });
      continue;
    }
    if (
      config.type === "sse" ||
      config.bearer_token_env_var !== undefined ||
      config.env_http_headers !== undefined
    ) {
      continue;
    }
    if (typeof config.url === "string" && config.url.trim()) {
      if (
        hasUnsafeInlineMcpSecret(config) ||
        hasUnresolvedMcpSecretReference(config) ||
        hasUnsafeMcpUrlSecret(config.url) ||
        hasUnsafeMcpCommandSecret(config)
      )
        continue;
      seen.add(serverName);
      const headers = toSafeMcpStringRecord(config.headers, MCP_HEADER_NAME);
      servers.push({
        name: serverName,
        config: {
          type: "remote",
          url: config.url,
          enabled: true,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(typeof config.timeout === "number" ? { timeout: config.timeout } : {}),
          oauth: false,
        },
        componentId: definition.componentId,
      });
    }
  }
  return servers;
}

export type MossPluginClaudeMcpServerConfig =
  | {
      readonly command: string;
      readonly args: string[];
      readonly env?: Record<string, string>;
    }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers?: Record<string, string>;
    };

export function toMossPluginClaudeMcpServers(
  definitions: ReadonlyArray<MossPluginMcpServerDefinition>,
): Record<string, MossPluginClaudeMcpServerConfig> {
  const servers: Record<string, MossPluginClaudeMcpServerConfig> = {};
  for (const definition of definitions) {
    const config = definition.config;
    const serverName = canonicalDefinitionServerName(definition);
    if (
      !serverName ||
      definition.allowLocalDevelopment === true ||
      servers[serverName] ||
      unsafeMcpConfigKey(config) ||
      config.bearer_token_env_var !== undefined ||
      config.env_http_headers !== undefined
    ) {
      continue;
    }
    if (
      hasUnsafeInlineMcpSecret(config) ||
      hasUnresolvedMcpSecretReference(config) ||
      hasUnsafeMcpUrlSecret(config.url) ||
      hasUnsafeMcpCommandSecret(config)
    )
      continue;
    if (typeof config.command === "string" && config.command.trim()) {
      const env = toSafeMcpStringRecord(config.env, MCP_ENV_NAME);
      servers[serverName] = {
        command: config.command,
        args: toStringArray(config.args),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
      continue;
    }
    if (typeof config.url === "string" && config.url.trim()) {
      const headers = toSafeMcpStringRecord(config.headers, MCP_HEADER_NAME);
      servers[serverName] = {
        type: config.type === "sse" ? "sse" : "http",
        url: config.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }
  }
  return servers;
}

export type MossPluginMcpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const PINNED_MCP_FETCH_REGISTRY = new WeakSet<Function>();

/** @internal Test-only transport seam; production uses the process-pinned transport below. */
export function createMossPluginPinnedMcpFetchForTest(
  fetch: MossPluginMcpFetch,
): MossPluginMcpFetch {
  const pinned = (input: string | URL | Request, init?: RequestInit) => fetch(input, init);
  PINNED_MCP_FETCH_REGISTRY.add(pinned);
  return pinned;
}

export type MossPluginMcpResolveHost = (hostname: string) => Promise<ReadonlyArray<string>>;

function isPublicMcpAddress(address: string): boolean {
  if (isIP(address) === 4) return !isBlockedMcpIpv4(address);
  if (isIP(address) === 6) return !isBlockedMcpIpv6(address);
  return false;
}

function isAllowedLocalMcpAddress(address: string): boolean {
  if (isPublicMcpAddress(address)) return true;
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4) return false;
    const first = octets[0];
    const second = octets[1];
    if (first === undefined || second === undefined) return false;
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (isIP(address) === 6) {
    const groups = parseMcpIpv6(address);
    if (!groups) return false;
    const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
    return loopback || (groups[0]! >= 0xfc00 && groups[0]! <= 0xfdff);
  }
  return false;
}

async function resolvePublicMcpAddresses(
  hostname: string,
  allowLocalDevelopment = false,
): Promise<ReadonlyArray<string>> {
  if (isIP(hostname) !== 0) {
    return (
      allowLocalDevelopment ? isAllowedLocalMcpAddress(hostname) : isPublicMcpAddress(hostname)
    )
      ? [hostname]
      : [];
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function pinnedMcpFetch(
  url: string,
  init: RequestInit | undefined,
  addresses: ReadonlyArray<string>,
): Promise<Response> {
  const parsed = new URL(url);
  const address = addresses[0];
  if (!address) throw new Error("Moss plugin MCP transport has no pinned public address.");
  const requestFactory = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(init?.headers);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  const body =
    typeof init?.body === "string"
      ? Buffer.from(init.body)
      : init?.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : undefined;
  return new Promise<Response>((resolveResponse, reject) => {
    const request = requestFactory(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: init?.method ?? "GET",
        headers: requestHeaders,
        servername: parsed.hostname,
        lookup: (_hostname, _options, callback) => callback(null, address, isIP(address) as 4 | 6),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > PI_MCP_MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Moss plugin MCP response exceeded the 2 MiB limit."));
            return;
          }
          chunks.push(bytes);
        });
        response.once("end", () => {
          if (total > PI_MCP_MAX_RESPONSE_BYTES) return;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const responseInit: ResponseInit = {
            status: response.statusCode ?? 500,
            headers: responseHeaders,
            ...(response.statusMessage !== undefined ? { statusText: response.statusMessage } : {}),
          };
          resolveResponse(new Response(Buffer.concat(chunks), responseInit));
        });
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    if (init?.signal) {
      const abort = () => request.destroy(init.signal?.reason ?? new Error("MCP request aborted."));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort, { once: true });
      request.once("close", () => init.signal?.removeEventListener("abort", abort));
    }
    request.end(body);
  });
}

function redirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * The only HTTP transport accepted by the Pi plugin path. It performs a DNS
 * preflight for every hop, never delegates redirect handling to fetch, and
 * rejects a response whose next hop is not independently safe. A production
 * server may replace the resolver with an address-pinning implementation; a
 * caller cannot bypass these checks by supplying an ordinary fetch function.
 */
export function createMossPluginSecureMcpFetch(
  input: {
    readonly fetch?: MossPluginMcpFetch;
    readonly resolveHost?: MossPluginMcpResolveHost;
    readonly maxRedirects?: number;
    readonly allowLocalDevelopment?: boolean | undefined;
  } = {},
): MossPluginMcpFetch {
  const injectedFetch = input.fetch;
  if (injectedFetch && !PINNED_MCP_FETCH_REGISTRY.has(injectedFetch)) {
    throw new Error("Moss plugin MCP fetch overrides must use the internal pinned transport seam.");
  }
  if (input.resolveHost && !injectedFetch) {
    throw new Error(
      "Moss plugin MCP host resolvers are only available through the pinned transport seam.",
    );
  }
  const resolveHost =
    input.resolveHost ??
    ((hostname: string) =>
      resolvePublicMcpAddresses(hostname, input.allowLocalDevelopment === true));
  const maxRedirects = Math.max(0, input.maxRedirects ?? 3);
  return async (requestInput, init) => {
    let currentUrl =
      typeof requestInput === "string"
        ? requestInput
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput.url;
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const blocked = blockedMossPluginMcpUrl(currentUrl, input.allowLocalDevelopment === true);
      if (blocked) throw new Error(`Moss plugin MCP transport rejected URL: ${blocked}.`);
      const parsed = new URL(currentUrl);
      const addresses = await resolveHost(parsed.hostname);
      if (
        addresses.length === 0 ||
        addresses.some((address) =>
          input.allowLocalDevelopment === true
            ? !isAllowedLocalMcpAddress(address)
            : !isPublicMcpAddress(address),
        )
      ) {
        throw new Error("Moss plugin MCP transport could not establish a public-address binding.");
      }
      const requestInit = { ...init, redirect: "manual" as const };
      const response = injectedFetch
        ? await injectedFetch(currentUrl, requestInit)
        : await pinnedMcpFetch(currentUrl, requestInit, addresses);
      if (!redirectStatus(response.status)) return response;
      if (redirect === maxRedirects) {
        throw new Error("Moss plugin MCP transport exceeded the redirect limit.");
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("Moss plugin MCP redirect did not provide a location.");
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.origin !== parsed.origin) {
        throw new Error("Moss plugin MCP cross-origin redirects are not allowed.");
      }
      currentUrl = nextUrl.toString();
    }
    throw new Error("Moss plugin MCP transport failed to resolve a safe request hop.");
  };
}

export interface MossPluginPiToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly remoteToolName: string;
  readonly server: MossPluginMcpServerDefinition;
  readonly session: MossPluginPiMcpSession;
}

const PI_MCP_REQUEST_TIMEOUT_MS = 15_000;
const PI_MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PI_MCP_MAX_TOOLS = 256;
const PI_MCP_MAX_TOOL_NAME_BYTES = 256;
const PI_MCP_MAX_TOOL_DESCRIPTION_BYTES = 16 * 1024;
const PI_MCP_MAX_TOOL_SCHEMA_BYTES = 128 * 1024;
const PI_MCP_MAX_SCHEMA_DEPTH = 32;

export interface MossPluginPiMcpSession {
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal | undefined,
  ) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

function parseMcpResponsePayload(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // MCP HTTP servers may return an SSE stream instead of a JSON body.
    }
    const dataLine = value.split("\n").find((line) => line.trim().startsWith("data:"));
    if (dataLine) {
      try {
        const parsed = JSON.parse(dataLine.replace(/^\s*data:\s*/, "")) as unknown;
        if (isRecord(parsed)) return parsed;
      } catch {
        // Fall through to the stable invalid-response error below.
      }
    }
  }
  throw new Error("Moss plugin MCP returned an invalid JSON-RPC response.");
}

async function readBoundedMcpResponse(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > PI_MCP_MAX_RESPONSE_BYTES) {
      throw new Error("Moss plugin MCP response exceeded the 2 MiB limit.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > PI_MCP_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Moss plugin MCP response exceeded the 2 MiB limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(
    chunks.reduce((result, chunk) => {
      const next = new Uint8Array(result.byteLength + chunk.byteLength);
      next.set(result);
      next.set(chunk, result.byteLength);
      return next;
    }, new Uint8Array()),
  );
}

function validatePiMcpSchema(
  value: unknown,
  depth = 0,
): { readonly ok: boolean; readonly reason?: string } {
  if (depth > PI_MCP_MAX_SCHEMA_DEPTH) return { ok: false, reason: "schema nesting is too deep" };
  if (typeof value === "string") {
    return /\0/.test(value) ? { ok: false, reason: "schema contains NUL" } : { ok: true };
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = validatePiMcpSchema(entry, depth + 1);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (!isRecord(value)) return { ok: true };
  for (const [key, entry] of Object.entries(value)) {
    if (/\0/.test(key)) return { ok: false, reason: "schema contains NUL" };
    const result = validatePiMcpSchema(entry, depth + 1);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function createMossPluginPiMcpSession(input: {
  readonly server: MossPluginMcpServerDefinition;
  readonly fetch?: MossPluginMcpFetch;
  readonly resolveHost?: MossPluginMcpResolveHost;
  readonly signal?: AbortSignal | undefined;
}): MossPluginPiMcpSession & {
  readonly initialize: () => Promise<void>;
  readonly sessionId: () => string | undefined;
} {
  let sessionId: string | undefined;
  let closed = false;
  const secureFetch = createMossPluginSecureMcpFetch({
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.resolveHost === undefined ? {} : { resolveHost: input.resolveHost }),
    ...(input.server.allowLocalDevelopment === true ? { allowLocalDevelopment: true } : {}),
  });

  const request = async (
    method: string,
    params?: Record<string, unknown>,
    requestSignal?: AbortSignal | undefined,
  ): Promise<unknown> => {
    if (closed) throw new Error("Moss plugin MCP session is closed.");
    const url = input.server.config.url;
    if (typeof url !== "string" || !url.trim()) {
      throw new Error("Moss plugin MCP HTTP adapter requires a non-empty url.");
    }
    const controller = new AbortController();
    const signal = requestSignal ?? input.signal;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("MCP request timeout")),
      PI_MCP_REQUEST_TIMEOUT_MS,
    );
    timeout.unref?.();
    const requestId = globalThis.crypto.randomUUID();
    const isNotification = method.startsWith("notifications/");
    let onRequestAbort: (() => void) | undefined;
    let onBodyAbort: (() => void) | undefined;
    try {
      const response = await Promise.race([
        secureFetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            ...toSafeMcpStringRecord(input.server.config.headers, MCP_HEADER_NAME),
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            jsonrpc: "2.0",
            ...(isNotification ? {} : { id: requestId }),
            method,
            ...(params === undefined ? {} : { params }),
          }),
        }),
        new Promise<Response>((_, reject) => {
          const abortRequest = () =>
            reject(controller.signal.reason ?? new Error("MCP request aborted."));
          onRequestAbort = abortRequest;
          if (controller.signal.aborted) abortRequest();
          else controller.signal.addEventListener("abort", abortRequest, { once: true });
        }),
      ]);
      if (!response.ok && !(isNotification && response.status === 202)) {
        throw new Error(`Moss plugin MCP request failed with HTTP ${String(response.status)}.`);
      }
      const responseSessionId = response.headers.get("Mcp-Session-Id");
      if (responseSessionId) sessionId = responseSessionId;
      if (isNotification && response.status === 202) return undefined;
      const raw = await Promise.race([
        readBoundedMcpResponse(response),
        new Promise<string>((_, reject) => {
          const abortBody = () => {
            void response.body?.cancel();
            reject(controller.signal.reason ?? new Error("MCP response read aborted."));
          };
          onBodyAbort = abortBody;
          if (controller.signal.aborted) abortBody();
          else controller.signal.addEventListener("abort", abortBody, { once: true });
        }),
      ]);
      if (raw.trim().length === 0) return undefined;
      const payload = parseMcpResponsePayload(raw);
      if ("error" in payload) {
        const error = isRecord(payload.error) ? payload.error : undefined;
        throw new Error(
          typeof error?.message === "string" ? error.message : "Moss plugin MCP request failed.",
        );
      }
      if (!isNotification && !("result" in payload)) {
        throw new Error("Moss plugin MCP returned no JSON-RPC result.");
      }
      return payload.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      if (onRequestAbort) controller.signal.removeEventListener("abort", onRequestAbort);
      if (onBodyAbort) controller.signal.removeEventListener("abort", onBodyAbort);
    }
  };

  const initialize = async (): Promise<void> => {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "moss-plugin-runtime", version: "1" },
    });
    if (!sessionId) throw new Error("Moss plugin MCP initialize did not return Mcp-Session-Id.");
    await request("notifications/initialized", {});
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!sessionId) return;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("MCP cleanup timeout")),
      PI_MCP_REQUEST_TIMEOUT_MS,
    );
    timeout.unref?.();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        secureFetch(input.server.config.url as string, {
          method: "DELETE",
          headers: {
            ...toSafeMcpStringRecord(input.server.config.headers, MCP_HEADER_NAME),
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          },
          signal: controller.signal,
        }).then(
          (value) => value,
          () => undefined,
        ),
        new Promise<Response | undefined>((resolve) => {
          deadlineTimer = setTimeout(() => resolve(undefined), PI_MCP_REQUEST_TIMEOUT_MS);
          deadlineTimer.unref?.();
        }),
      ]);
      await response?.body?.cancel();
    } catch {
      // Cleanup is best effort after a bounded abort; execution was already stopped.
    } finally {
      clearTimeout(timeout);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  };

  return { request, close, initialize, sessionId: () => sessionId };
}

/** Discover HTTP MCP tools for the Pi custom-tool adapter. Local command MCPs stay fail-closed. */
export async function discoverMossPluginPiTools(input: {
  readonly cwd: string;
  readonly fetch?: MossPluginMcpFetch;
  readonly resolveHost?: MossPluginMcpResolveHost;
  readonly approvalStore?: MossPluginApprovalStore | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<{ tools: MossPluginPiToolDescriptor[]; warnings: string[] }> {
  const derived = await deriveMossPluginProviderMcpServers({
    cwd: input.cwd,
    provider: "pi",
    ...(input.approvalStore ? { approvalStore: input.approvalStore } : {}),
  });
  const tools: MossPluginPiToolDescriptor[] = [];
  const warnings = [...derived.warnings];
  let totalDescriptionBytes = 0;
  const sessions = new Set<MossPluginPiMcpSession>();
  const closeAllSessions = async () => {
    const activeSessions = [...sessions];
    sessions.clear();
    tools.splice(0, tools.length);
    await Promise.allSettled(activeSessions.map((session) => session.close()));
  };
  for (const server of derived.definitions) {
    const session = createMossPluginPiMcpSession({
      server,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.resolveHost === undefined ? {} : { resolveHost: input.resolveHost }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    sessions.add(session);
    try {
      await session.initialize();
      const listed = await session.request("tools/list", {});
      if (!isRecord(listed) || !Array.isArray(listed.tools)) {
        throw new Error("Moss plugin MCP tools/list returned an invalid tool catalog.");
      }
      if (listed.tools.length > PI_MCP_MAX_TOOLS) {
        throw new Error("Moss plugin MCP tool catalog exceeded the 256-tool limit.");
      }
      let acceptedTools = 0;
      const names = new Set(tools.map((tool) => tool.name));
      for (const tool of listed.tools) {
        if (!isRecord(tool) || typeof tool.name !== "string" || !isRecord(tool.inputSchema)) {
          warnings.push(
            `${server.pluginName}:${server.serverName} returned an invalid tool descriptor.`,
          );
          continue;
        }
        const nameBytes = new TextEncoder().encode(tool.name).byteLength;
        if (nameBytes === 0 || nameBytes > PI_MCP_MAX_TOOL_NAME_BYTES || /\0/.test(tool.name)) {
          warnings.push(
            `${server.pluginName}:${server.serverName} returned a tool with an unsafe name.`,
          );
          continue;
        }
        const safeName = `moss_plugin_${server.serverName.replace(/[^A-Za-z0-9_-]/g, "_")}_${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        if (names.has(safeName)) {
          warnings.push(
            `${server.pluginName}:${server.serverName}/${tool.name} is unsupported on Pi: canonical tool name collision.`,
          );
          continue;
        }
        const description =
          typeof tool.description === "string"
            ? tool.description
            : `Moss plugin MCP tool ${server.serverName}/${tool.name}.`;
        const descriptionBytes = new TextEncoder().encode(description).byteLength;
        if (descriptionBytes > PI_MCP_MAX_TOOL_DESCRIPTION_BYTES || /\0/.test(description)) {
          throw new Error("Moss plugin MCP tool description exceeded its per-tool safety budget.");
        }
        const schemaBytes = new TextEncoder().encode(
          JSON.stringify(tool.inputSchema) ?? "",
        ).byteLength;
        const schemaCheck = validatePiMcpSchema(tool.inputSchema);
        if (schemaBytes > PI_MCP_MAX_TOOL_SCHEMA_BYTES || !schemaCheck.ok) {
          throw new Error(
            `Moss plugin MCP tool schema is unsafe${schemaCheck.reason ? `: ${schemaCheck.reason}` : "."}`,
          );
        }
        totalDescriptionBytes += descriptionBytes;
        if (totalDescriptionBytes > 256 * 1024) {
          throw new Error("Moss plugin MCP tool descriptions exceeded the 256 KiB limit.");
        }
        if (tools.length >= PI_MCP_MAX_TOOLS) {
          throw new Error("Moss plugin MCP tool catalog exceeded the 256-tool limit.");
        }
        names.add(safeName);
        acceptedTools += 1;
        tools.push({
          name: safeName,
          label: safeName,
          description,
          parameters: tool.inputSchema,
          remoteToolName: tool.name,
          server,
          session,
        });
      }
      if (acceptedTools === 0) {
        await session.close();
        sessions.delete(session);
        warnings.push(
          `${server.pluginName}:${server.serverName} is unsupported on Pi: MCP returned no valid tools.`,
        );
      }
    } catch (error) {
      warnings.push(
        `${server.pluginName}:${server.serverName} is unsupported on Pi: MCP tool discovery failed (${error instanceof Error ? error.message : String(error)}).`,
      );
      await closeAllSessions();
      break;
    }
  }
  return { tools, warnings };
}

export function callMossPluginPiTool(input: {
  readonly tool: MossPluginPiToolDescriptor;
  readonly arguments: Record<string, unknown>;
  readonly fetch?: MossPluginMcpFetch;
  readonly signal?: AbortSignal | undefined;
}): Promise<unknown> {
  return input.tool.session.request(
    "tools/call",
    {
      name: input.tool.remoteToolName,
      arguments: input.arguments,
    },
    input.signal,
  );
}

export async function closeMossPluginPiTools(
  tools: ReadonlyArray<MossPluginPiToolDescriptor>,
): Promise<void> {
  const sessions = new Set(tools.map((tool) => tool.session));
  await Promise.allSettled([...sessions].map((session) => session.close()));
}

export interface MossPluginPromptInjection {
  readonly injected: boolean;
  readonly text: string;
  readonly componentIds: string[];
  readonly warnings: string[];
  readonly reason?: string | undefined;
}

const MAX_PLUGIN_SKILL_BYTES = 64 * 1024;

async function pathRealpathWithinPluginRoot(
  pluginRoot: string,
  candidate: string,
): Promise<boolean> {
  try {
    const [rootReal, candidateReal] = await Promise.all([
      realpath(pluginRoot),
      realpath(candidate),
    ]);
    const relativePath = relative(rootReal, candidateReal);
    return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(sep));
  } catch {
    return false;
  }
}

async function componentAbsolutePath(
  plugin: MossPluginIR,
  component: MossPluginComponent,
): Promise<string | undefined> {
  if (!isSafeMossPluginComponentName(component.name)) return undefined;
  if (!component.sourcePath) return undefined;
  const source = component.sourcePath.startsWith("./")
    ? component.sourcePath.slice(2)
    : component.sourcePath;
  const lexicalRoot = resolve(plugin.absolutePluginRoot);
  try {
    await assertNoSymlinkPathWithin(lexicalRoot, lexicalRoot);
  } catch {
    return undefined;
  }
  let root: string;
  try {
    root = await realpath(lexicalRoot);
  } catch {
    return undefined;
  }
  const absolute = resolve(root, source);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return undefined;
  try {
    await assertNoSymlinkPathWithin(root, absolute);
  } catch {
    return undefined;
  }
  if (!(await pathRealpathWithinPluginRoot(root, absolute))) {
    return undefined;
  }
  return absolute;
}

async function readPluginSkillText(
  plugin: MossPluginIR,
  component: MossPluginComponent,
): Promise<string | undefined> {
  const source = await componentAbsolutePath(plugin, component);
  if (!source) return undefined;
  try {
    const sourceStat = await stat(source);
    const filePath = sourceStat.isDirectory() ? join(source, "SKILL.md") : source;
    if (!(await pathRealpathWithinPluginRoot(plugin.absolutePluginRoot, filePath))) {
      return undefined;
    }
    const content = await readMossPluginFileNoFollow(filePath, MAX_PLUGIN_SKILL_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (text.includes("\0")) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** Read and inject plugin Skill instructions for providers without native skill loading. */
export async function buildMossPluginPromptInjection(input: {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly plugin?: MossPluginIR | undefined;
  /** Explicit Skill selection; absence means no prompt injection. */
  readonly selectedComponentIds?: ReadonlyArray<string> | undefined;
  /** Provider-selected Skill references; never inferred from the manifest. */
  readonly selectedSkills?:
    | ReadonlyArray<{ readonly name: string; readonly path: string }>
    | undefined;
  readonly approvalStore?: MossPluginApprovalStore | undefined;
}): Promise<MossPluginPromptInjection> {
  const result: {
    injected: boolean;
    text: string;
    componentIds: string[];
    warnings: string[];
  } = { injected: false, text: "", componentIds: [], warnings: [] };
  const planPlugins = await resolveRuntimePlugins({
    cwd: input.cwd,
    ...(input.plugin ? { plugin: input.plugin } : {}),
  });
  result.warnings.push(...planPlugins.warnings);
  const nativeSkillLoader = input.provider === "codex" || input.provider === "claudeAgent";
  if (nativeSkillLoader) return result;
  const selectedComponentIds = new Set(input.selectedComponentIds ?? []);
  const selectedSkills = input.selectedSkills ?? [];
  if (selectedComponentIds.size === 0 && selectedSkills.length === 0) {
    return {
      ...result,
      reason:
        "Skill prompt injection is disabled until a user explicitly selects an approved component.",
    };
  }
  for (const plugin of planPlugins.plugins) {
    const approval = await resolvePluginApproval({
      cwd: input.cwd,
      plugin,
      ...(input.approvalStore ? { approvalStore: input.approvalStore } : {}),
    });
    const approvedPlugin = pluginForApprovalSnapshot(plugin, approval);
    if (!approvedPlugin.enabled || !approvedPlugin.validation.ok) {
      result.warnings.push(
        `${approvedPlugin.name}: plugin validation or enabled gate blocks Skill injection.`,
      );
      continue;
    }
    for (const component of approvedPlugin.components) {
      if (component.kind !== "skill" || !component.enabled) continue;
      const explicitlySelected =
        selectedComponentIds.has(component.id) ||
        selectedSkills.some(
          (skill) =>
            skill.name === component.name &&
            (skill.path === component.sourcePath || skill.path.endsWith(`/${component.name}`)),
        );
      if (!explicitlySelected) continue;
      if (!isApprovedPluginComponent(approvedPlugin, component, approval)) {
        result.warnings.push(
          `${approvedPlugin.name}:${component.name} is unsupported: explicit server-owned Skill approval and content provenance are required.`,
        );
        continue;
      }
      const text = await readPluginSkillText(approvedPlugin, component);
      if (!text?.trim()) {
        result.warnings.push(
          `${plugin.name}:${component.name} is unsupported: Skill source could not be read for prompt injection.`,
        );
        continue;
      }
      result.injected = true;
      result.componentIds.push(component.id);
      result.text += `${result.text ? "\n\n" : ""}[source:moss-plugin id=${approvedPlugin.id} component=${component.id}]\n# Moss plugin Skill: ${approvedPlugin.name}/${component.name}\n\n${text.trim()}`;
    }
  }
  return result;
}

export interface MossPluginProjectedComponent {
  readonly pluginId: string;
  readonly componentId: string;
  readonly kind: MossPluginComponentKind;
  readonly name: string;
  readonly supportStatus: MossPluginRuntimeSupportStatus;
  readonly readBack: boolean;
  readonly results: ReadonlyArray<MossProjectionMaterializeResult>;
  readonly reason?: string | undefined;
}

export interface MaterializedMossPluginProviderComponents {
  readonly provider: ProviderKind;
  readonly components: ReadonlyArray<MossPluginProjectedComponent>;
  readonly warnings: ReadonlyArray<string>;
}

async function projectionReadBack(
  cwd: string,
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    const sourceHash = await mossProjectionContentHash(sourcePath);
    const targetAbs = resolve(cwd, targetPath);
    const targetStat = await lstat(targetAbs);
    if (targetStat.isSymbolicLink()) return false;
    return (await mossProjectionContentHash(targetAbs)) === sourceHash;
  } catch {
    return false;
  }
}

function pluginProjectionTargetName(plugin: MossPluginIR, component: MossPluginComponent): string {
  const namespace = createHash("sha256").update(plugin.id).digest("hex").slice(0, 12);
  return `moss-plugin-${namespace}-${component.name}`;
}

/** Materialize Codex/Claude plugin skills and subagents, then verify each target. */
export async function materializeMossPluginProviderComponents(input: {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly plugin?: MossPluginIR | undefined;
  readonly approvalStore?: MossPluginApprovalStore | undefined;
  readonly projectionOwnershipStore?: MossProjectionOwnershipStore | undefined;
  readonly projectionOwnershipOwnerId?: string | undefined;
  readonly projectionOwnershipGeneration?: string | undefined;
}): Promise<MaterializedMossPluginProviderComponents> {
  const result: {
    provider: ProviderKind;
    components: MossPluginProjectedComponent[];
    warnings: string[];
  } = { provider: input.provider, components: [], warnings: [] };
  const resolved = await resolveRuntimePlugins({
    cwd: input.cwd,
    ...(input.plugin ? { plugin: input.plugin } : {}),
  });
  result.warnings.push(...resolved.warnings);
  const approvalByPlugin = new Map<string, MossPluginRuntimeApproval | undefined>();
  const activeProjectionIds = new Set<string>();
  for (const plugin of resolved.plugins) {
    const approval = await resolvePluginApproval({
      cwd: input.cwd,
      plugin,
      ...(input.approvalStore ? { approvalStore: input.approvalStore } : {}),
    });
    approvalByPlugin.set(plugin.id, approval);
    const approvedPlugin = pluginForApprovalSnapshot(plugin, approval);
    if (!approvedPlugin.enabled || !approvedPlugin.validation.ok) continue;
    for (const component of approvedPlugin.components) {
      if (
        (component.kind === "skill" || component.kind === "subagent") &&
        component.enabled &&
        isApprovedPluginComponent(approvedPlugin, component, approval)
      ) {
        activeProjectionIds.add(`${approvedPlugin.id}:${component.id}`);
      }
    }
  }
  try {
    const reconciled = await reconcileMossProjectionResources({
      projectPath: input.cwd,
      engineId: input.provider,
      resourceIdPrefix: input.plugin ? `${input.plugin.id}:` : "moss:plugin:",
      keepResourceIds: activeProjectionIds,
      ...(input.projectionOwnershipStore ? { ownershipStore: input.projectionOwnershipStore } : {}),
      ...(input.projectionOwnershipOwnerId
        ? { ownershipOwnerId: input.projectionOwnershipOwnerId }
        : {}),
      ...(input.projectionOwnershipGeneration
        ? { ownershipGeneration: input.projectionOwnershipGeneration }
        : {}),
    });
    if (reconciled.removedTargets.length > 0) {
      result.warnings.push(
        `${input.provider}: removed ${reconciled.removedTargets.length} stale Moss-managed plugin projection(s).`,
      );
    }
    if (reconciled.conflictedTargets && reconciled.conflictedTargets.length > 0) {
      result.warnings.push(
        `${input.provider}: retained ${reconciled.conflictedTargets.length} stale projection(s); server-owned filesystem CAS is required before cleanup.`,
      );
    }
  } catch (error) {
    result.warnings.push(
      `${input.provider}: plugin projection reconciliation failed closed (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (input.provider !== "codex" && input.provider !== "claudeAgent") {
    for (const plugin of resolved.plugins) {
      const approval = approvalByPlugin.get(plugin.id);
      const approvedPlugin = pluginForApprovalSnapshot(plugin, approval);
      for (const component of approvedPlugin.components) {
        if (component.kind === "skill" || component.kind === "subagent") {
          result.components.push({
            pluginId: approvedPlugin.id,
            componentId: component.id,
            kind: component.kind,
            name: component.name,
            supportStatus: "unsupported",
            readBack: false,
            results: [],
            reason:
              component.kind === "skill"
                ? "Provider has no native Skill tree; explicit approved Skill selection is required for prompt injection."
                : "Provider has no subagent executor; the declaration is display-only.",
          });
        }
      }
    }
    return result;
  }
  const targets =
    input.provider === "codex"
      ? MOSS_ENGINE_NATIVE_TARGETS.codex
      : MOSS_ENGINE_NATIVE_TARGETS.claudeAgent;

  for (const plugin of resolved.plugins) {
    const approval = approvalByPlugin.get(plugin.id);
    const approvedPlugin = pluginForApprovalSnapshot(plugin, approval);
    if (!approvedPlugin.enabled || !approvedPlugin.validation.ok) {
      result.warnings.push(
        `${approvedPlugin.name}: plugin validation or enabled gate blocks projection.`,
      );
      continue;
    }
    for (const component of approvedPlugin.components) {
      if (component.kind !== "skill" && component.kind !== "subagent") continue;
      if (!component.enabled) continue;
      if (!isApprovedPluginComponent(approvedPlugin, component, approval)) {
        result.components.push({
          pluginId: approvedPlugin.id,
          componentId: component.id,
          kind: component.kind,
          name: component.name,
          supportStatus: "unsupported",
          readBack: false,
          results: [],
          reason:
            "Server-owned explicit plugin approval and content provenance are required before projection.",
        });
        continue;
      }
      const sourcePath = await componentAbsolutePath(approvedPlugin, component);
      const targetRoot = component.kind === "skill" ? targets.skillsRoot : targets.subagentsRoot;
      if (!sourcePath || !targetRoot) {
        result.components.push({
          pluginId: approvedPlugin.id,
          componentId: component.id,
          kind: component.kind,
          name: component.name,
          supportStatus: "unsupported",
          readBack: false,
          results: [],
          reason: "Plugin component has no safe source path or provider target.",
        });
        continue;
      }
      const namespace = createHash("sha256").update(approvedPlugin.id).digest("hex").slice(0, 12);
      const targetName =
        component.kind === "skill"
          ? pluginProjectionTargetName(approvedPlugin, component)
          : `moss-plugin-${namespace}-${basename(sourcePath)}`;
      const targetPath = join(targetRoot, targetName);
      const projection = {
        engineId: input.provider,
        status: "ready" as const,
        mappings: [
          {
            resourceId: `${approvedPlugin.id}:${component.id}`,
            action: "copy" as const,
            sourcePath,
            targetPath,
            reason: `Moss projects plugin ${component.kind} ${approvedPlugin.name}/${component.name} into ${targets.label}.`,
          },
        ],
        warnings: [],
      };
      try {
        const materialized = await materializeMossProjection({
          projectPath: input.cwd,
          projection,
          ...(input.projectionOwnershipStore
            ? { ownershipStore: input.projectionOwnershipStore }
            : {}),
          ...(input.projectionOwnershipOwnerId
            ? { ownershipOwnerId: input.projectionOwnershipOwnerId }
            : {}),
          ...(input.projectionOwnershipGeneration
            ? { ownershipGeneration: input.projectionOwnershipGeneration }
            : {}),
        });
        const readBack = await projectionReadBack(input.cwd, sourcePath, targetPath);
        const successful = materialized.every(
          (entry) =>
            entry.status === "created" || entry.status === "updated" || entry.status === "skipped",
        );
        result.components.push({
          pluginId: plugin.id,
          componentId: component.id,
          kind: component.kind,
          name: component.name,
          supportStatus: successful && readBack ? "projected" : "unsupported",
          readBack,
          results: materialized,
          ...(successful && readBack
            ? {}
            : {
                reason: "Provider projection did not pass target read-back; execution is disabled.",
              }),
        });
      } catch (error) {
        result.components.push({
          pluginId: plugin.id,
          componentId: component.id,
          kind: component.kind,
          name: component.name,
          supportStatus: "unsupported",
          readBack: false,
          results: [],
          reason: `Provider projection failed; execution is disabled: ${error instanceof Error ? error.message : String(error)}.`,
        });
      }
    }
  }
  return result;
}

export interface MossPluginExecutorContext {
  readonly provider: ProviderKind;
  readonly plugin: MossPluginIR;
  readonly component: MossPluginComponent;
}

export interface MossPluginExecutors {
  readonly native?: (context: MossPluginExecutorContext) => Promise<unknown> | unknown;
  readonly adapter?: (context: MossPluginExecutorContext) => Promise<unknown> | unknown;
}

export interface MossPluginExecutionResult {
  readonly status: "executed" | "executor-unavailable" | "blocked" | "failed" | "display-only";
  readonly supportStatus: MossPluginRuntimeSupportStatus;
  readonly executed: boolean;
  readonly provider: ProviderKind;
  readonly pluginId: string;
  readonly componentId: string;
  readonly reason: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * Execute only through an explicitly registered provider executor. Reading a
 * plugin for display, planning a projection, or seeing a native capability in
 * the matrix never produces an `executed` result by itself.
 */
export async function executeMossPluginComponent(input: {
  readonly cwd: string;
  readonly plugin: MossPluginIR;
  readonly provider: ProviderKind;
  readonly component: MossPluginComponent;
  readonly executors?: MossPluginExecutors;
  readonly approvalStore?: MossPluginApprovalStore | undefined;
}): Promise<MossPluginExecutionResult> {
  const base = {
    provider: input.provider,
    pluginId: input.plugin.id,
    componentId: input.component.id,
  };
  const declaredComponent = input.plugin.components.find(
    (component) => component.id === input.component.id && component.kind === input.component.kind,
  );
  if (!declaredComponent) {
    return {
      ...base,
      status: "blocked",
      supportStatus: "unsupported",
      executed: false,
      reason: "The requested component is not declared by this plugin IR.",
    };
  }
  const approval = await resolvePluginApproval({
    cwd: input.cwd,
    plugin: input.plugin,
    ...(input.approvalStore ? { approvalStore: input.approvalStore } : {}),
  });
  if (!approval) {
    if (!input.plugin.validation.ok) {
      return {
        ...base,
        status: "blocked",
        supportStatus: "unsupported",
        executed: false,
        reason: "Plugin validation failed; execution is blocked.",
      };
    }
    if (!input.plugin.enabled) {
      return {
        ...base,
        status: "display-only",
        supportStatus: "unsupported",
        executed: false,
        reason: "Plugin is disabled; no plugin component may execute.",
      };
    }
    if (!declaredComponent.enabled) {
      return {
        ...base,
        status: "display-only",
        supportStatus: "unsupported",
        executed: false,
        reason: "Plugin component is disabled.",
      };
    }
  }
  const approvedPlugin = pluginForApprovalSnapshot(input.plugin, approval);
  const approvedComponent = approvedPlugin.components.find(
    (component) =>
      component.id === declaredComponent.id && component.kind === declaredComponent.kind,
  );
  if (
    !approvedPlugin.validation.ok ||
    !approvedPlugin.enabled ||
    !approvedComponent?.enabled ||
    !isApprovedPluginComponent(approvedPlugin, approvedComponent, approval)
  ) {
    return {
      ...base,
      status: "blocked",
      supportStatus: "unsupported",
      executed: false,
      reason:
        "Server-owned explicit plugin approval and content provenance are required before execution.",
    };
  }
  // The approval snapshot is the only source that may cross the executor
  // boundary. The caller's live plugin IR remains suitable for display and
  // approval lookup, but never for execution after approval.
  if (approvedComponent.kind === "hook" && !isTrustedPluginHook(approvedComponent)) {
    return {
      ...base,
      status: "display-only",
      supportStatus: "unsupported",
      executed: false,
      reason: "Plugin hook is not explicitly trusted; execution is disabled.",
    };
  }
  const capability = getMossPluginCapability(input.provider, approvedComponent.kind);
  if (capability.execution === "none") {
    return {
      ...base,
      status: "display-only",
      supportStatus: "unsupported",
      executed: false,
      reason: capability.reason,
    };
  }
  const executor =
    capability.execution === "native" ? input.executors?.native : input.executors?.adapter;
  if (!executor) {
    return {
      ...base,
      status: "executor-unavailable",
      supportStatus: "unsupported",
      executed: false,
      reason:
        "An explicit native/adapter executor is required before Moss can execute this component.",
    };
  }
  try {
    return {
      ...base,
      status: "executed",
      supportStatus: capability.execution === "native" ? "native" : "injected",
      executed: true,
      reason: `Executed through the explicit ${capability.execution} executor.`,
      result: await executor({
        provider: input.provider,
        plugin: approvedPlugin,
        component: approvedComponent,
      }),
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      supportStatus: "unsupported",
      executed: false,
      reason: `The explicit ${capability.execution} executor failed.`,
      error,
    };
  }
}

export const runMossPluginComponent = executeMossPluginComponent;

/** Exported for importer diagnostics without exposing a second matrix. */
export const MOSS_PLUGIN_RUNTIME_CAPABILITIES = MOSS_PLUGIN_CAPABILITY_MATRIX;
