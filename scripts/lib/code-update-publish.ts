// Publishing code updates to the download stores, and pruning old packages from them.
//
// Upload order (domains session, 2026-11-18; CODE-UPDATES.md §11): the package goes to EVERY store
// and is read back through every public base (full GET, streamed sha256) before ANY store's
// manifest names it, because a client may read the manifest from one source and fetch the package
// from another. Only then the manifest and its signature go to every store, read back with a
// cache-busting query. An unsigned manifest is never uploaded: signing is the lead's step.
//
// Prune: deleting from a production store is permanent, so it is a dry run unless asked, and it
// never deletes a package any served manifest names, nor one stored in the last `keepHours`
// (a client may still be downloading a package three publishes old).

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import {
  CODE_UPDATE_CHANNELS,
  CODE_UPDATE_PACKAGE_PREFIX,
  codeUpdateManifestPath,
  parseCodeUpdateManifest,
  sha256OfPath,
  type CodeUpdateChannel,
  type CodeUpdateManifest,
} from "@moss/shared/codeUpdate";
import {
  MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";

export interface CodeUpdateStoredObject {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

/** One store's storage API (S3-compatible); reads go to storage, never through the CDN. */
export interface CodeUpdateStore {
  upload(key: string, localPath: string, contentType: string): Promise<void>;
  sizeOf(key: string): Promise<number | null>;
  list(prefix: string): Promise<ReadonlyArray<CodeUpdateStoredObject>>;
  delete(key: string): Promise<void>;
}

export interface CodeUpdateStoreTarget {
  readonly label: string;
  readonly store: CodeUpdateStore;
  /** The store's public base URL (ends with `/`); an object is served at `<base><key>`. */
  readonly publicBaseUrl: string;
}

export interface LocalCodeUpdate {
  readonly channel: CodeUpdateChannel;
  readonly manifest: CodeUpdateManifest;
  readonly manifestFile: string;
  readonly signatureFile: string;
  readonly packageFile: string;
}

/**
 * Reads a build-code-update output folder; refuses one whose signature does not verify with the
 * release key (what every client checks), or whose package does not match its manifest.
 */
export async function readLocalCodeUpdate(
  outDirectory: string,
  channel: CodeUpdateChannel,
  publicKey: string = MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
): Promise<LocalCodeUpdate> {
  if (!CODE_UPDATE_CHANNELS.includes(channel)) throw new Error(`unknown channel ${channel}`);
  const manifestFile = path.join(outDirectory, codeUpdateManifestPath(channel));
  const signatureFile = `${manifestFile}.sig`;
  const manifestText = await readFile(manifestFile, "utf8");
  const manifest = parseCodeUpdateManifest(manifestText);
  if (!manifest) throw new Error(`${manifestFile} is not a valid code update manifest`);
  if (manifest.channel !== channel) {
    throw new Error(`${manifestFile} is for channel ${manifest.channel}, not ${channel}`);
  }
  let signature: string;
  try {
    signature = await readFile(signatureFile, "utf8");
  } catch {
    throw new Error(`${signatureFile} is missing: the manifest must be signed before upload`);
  }
  if (
    !verifyMossUpdateManifest({
      channelFile: codeUpdateManifestPath(channel),
      manifest: manifestText,
      signature,
      manifestPublicKey: publicKey,
    })
  ) {
    throw new Error(
      `${signatureFile} does not verify with the release key: clients would refuse it`,
    );
  }
  const packageFile = path.join(outDirectory, manifest.package.path);
  const size = (await stat(packageFile)).size;
  if (
    size !== manifest.package.size ||
    (await sha256OfPath(packageFile)) !== manifest.package.sha256
  ) {
    throw new Error(`${packageFile} does not match its manifest`);
  }
  return { channel, manifest, manifestFile, signatureFile, packageFile };
}

type Served = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/** A full GET through the public URL; "not yet" is retried, wrong bytes are not. */
export async function checkServedBytes(input: {
  readonly url: string;
  readonly expected: { readonly size: number; readonly sha256: string };
  readonly fetchImpl: typeof fetch;
  readonly attempts: number;
  readonly retryDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<Served> {
  let lastProblem = "not checked";
  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    if (attempt > 0) await input.sleep(input.retryDelayMs);
    const response = await input.fetchImpl(input.url, { method: "GET" }).catch((error: unknown) => {
      lastProblem = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (!response) continue;
    if (response.status !== 200 || !response.body) {
      lastProblem = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== input.expected.size) {
      return { ok: false, problem: `served ${size} bytes, expected ${input.expected.size}` };
    }
    if (hash.digest("hex") !== input.expected.sha256) {
      return { ok: false, problem: "served bytes differ from the expected sha256" };
    }
    return { ok: true };
  }
  return { ok: false, problem: `not served (${lastProblem})` };
}

export interface CodeUpdateUploadLine {
  readonly store: string;
  readonly key: string;
  readonly action: "uploaded" | "already stored" | "would upload" | "conflict" | "failed";
  readonly served: boolean | null;
  readonly problem: string | null;
}

export interface CodeUpdateUploadResult {
  readonly lines: ReadonlyArray<CodeUpdateUploadLine>;
  /** True when the manifest went to every store (never in a dry run). */
  readonly published: boolean;
}

/**
 * Package to every store and read back everywhere; only then manifest + signature to every store
 * and read back. Without `publish` nothing is written: the plan is printed.
 */
export async function uploadCodeUpdate(input: {
  readonly local: LocalCodeUpdate;
  readonly targets: ReadonlyArray<CodeUpdateStoreTarget>;
  readonly publish: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): Promise<CodeUpdateUploadResult> {
  const log = input.log ?? ((line: string) => console.log(line));
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const attempts = input.attempts ?? 6;
  const retryDelayMs = input.retryDelayMs ?? 15_000;
  const { local } = input;
  const pkg = local.manifest.package;
  const lines: CodeUpdateUploadLine[] = [];
  const record = (line: CodeUpdateUploadLine) => {
    lines.push(line);
    log(
      `${line.problem ? "FAIL" : "ok  "} ${line.store} ${line.key} (${line.action}${line.served ? ", served" : ""})${line.problem ? `: ${line.problem}` : ""}`,
    );
  };

  // Phase 1: the package, to every store, read back everywhere.
  const states: Array<{ target: CodeUpdateStoreTarget; stored: number | null }> = [];
  for (const target of input.targets) {
    states.push({ target, stored: await target.store.sizeOf(pkg.path).catch(() => null) });
  }
  const conflict = states.find((state) => state.stored !== null && state.stored !== pkg.size);
  if (conflict) {
    record({
      store: conflict.target.label,
      key: pkg.path,
      action: "conflict",
      served: null,
      problem: `already stored with ${conflict.stored} bytes, expected ${pkg.size}; nothing written anywhere`,
    });
    return { lines, published: false };
  }
  let packageEverywhere = true;
  for (const { target, stored } of states) {
    if (!input.publish) {
      record({
        store: target.label,
        key: pkg.path,
        action: stored === null ? "would upload" : "already stored",
        served: null,
        problem: null,
      });
      continue;
    }
    let action: CodeUpdateUploadLine["action"] = stored === null ? "uploaded" : "already stored";
    let problem: string | null = null;
    if (stored === null) {
      try {
        await target.store.upload(pkg.path, local.packageFile, "application/zstd");
      } catch (error) {
        action = "failed";
        problem = `upload failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const served = problem
      ? null
      : await checkServedBytes({
          url: new URL(pkg.path, target.publicBaseUrl).toString(),
          expected: { size: pkg.size, sha256: pkg.sha256 },
          fetchImpl,
          attempts,
          retryDelayMs,
          sleep,
        });
    if (served && !served.ok) problem = served.problem;
    if (problem) packageEverywhere = false;
    record({ store: target.label, key: pkg.path, action, served: served?.ok ?? false, problem });
  }
  if (!input.publish) {
    for (const target of input.targets) {
      for (const key of [
        codeUpdateManifestPath(local.channel),
        `${codeUpdateManifestPath(local.channel)}.sig`,
      ]) {
        record({ store: target.label, key, action: "would upload", served: null, problem: null });
      }
    }
    log("dry run: nothing was written (pass --publish to upload)");
    return { lines, published: false };
  }
  if (!packageEverywhere) {
    log("the package is not served by every store: no manifest was uploaded anywhere");
    return { lines, published: false };
  }

  // Phase 2: manifest and signature, to every store, read back past any edge cache.
  const manifestKey = codeUpdateManifestPath(local.channel);
  const files = [
    { key: manifestKey, file: local.manifestFile, type: "application/json" },
    { key: `${manifestKey}.sig`, file: local.signatureFile, type: "text/plain" },
  ];
  let published = true;
  for (const target of input.targets) {
    for (const entry of files) {
      const bytes = await readFile(entry.file);
      let problem: string | null = null;
      try {
        await target.store.upload(entry.key, entry.file, entry.type);
      } catch (error) {
        problem = `upload failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const served = problem
        ? null
        : await checkServedBytes({
            url: `${new URL(entry.key, target.publicBaseUrl).toString()}?noCache=${(input.now ?? Date.now)()}`,
            expected: {
              size: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            fetchImpl,
            attempts,
            retryDelayMs,
            sleep,
          });
      if (served && !served.ok) problem = served.problem;
      if (problem) published = false;
      record({
        store: target.label,
        key: entry.key,
        action: problem && !served ? "failed" : "uploaded",
        served: served?.ok ?? false,
        problem,
      });
    }
  }
  return { lines, published };
}

export interface CodeUpdatePrunePlan {
  readonly keep: ReadonlyArray<{ readonly key: string; readonly why: string }>;
  readonly remove: ReadonlyArray<string>;
}

/**
 * Which packages under the package prefix may go: not named by any served manifest, and stored
 * longer ago than `keepHours`. Anything else under the prefix (not a package name) is kept.
 */
export function planCodeUpdatePrune(input: {
  readonly objects: ReadonlyArray<CodeUpdateStoredObject>;
  /** Package paths named by the manifests the store serves now (every channel). */
  readonly named: ReadonlySet<string>;
  readonly now: Date;
  readonly keepHours: number;
}): CodeUpdatePrunePlan {
  const keep: Array<{ key: string; why: string }> = [];
  const remove: string[] = [];
  const cutoff = input.now.getTime() - input.keepHours * 3_600_000;
  for (const object of input.objects) {
    if (!object.key.startsWith(CODE_UPDATE_PACKAGE_PREFIX) || !object.key.endsWith(".asar.zst")) {
      keep.push({ key: object.key, why: "not a package" });
    } else if (input.named.has(object.key)) {
      keep.push({ key: object.key, why: "named by a served manifest" });
    } else if (object.lastModified.getTime() > cutoff) {
      keep.push({ key: object.key, why: `stored within the last ${input.keepHours} h` });
    } else {
      remove.push(object.key);
    }
  }
  return { keep, remove };
}

/** The package paths the store's served manifests name; a manifest that cannot be read is fatal. */
export async function readNamedPackages(input: {
  readonly publicBaseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly now: number;
}): Promise<Set<string>> {
  const named = new Set<string>();
  for (const channel of CODE_UPDATE_CHANNELS) {
    const url = `${new URL(codeUpdateManifestPath(channel), input.publicBaseUrl).toString()}?noCache=${input.now}`;
    const response = await input.fetchImpl(url, { method: "GET" });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (response.status !== 200) {
      throw new Error(
        `${url}: HTTP ${response.status}; prune stops rather than guess what is in use`,
      );
    }
    const manifest = parseCodeUpdateManifest(await response.text());
    if (!manifest) throw new Error(`${url} is not a valid manifest; prune stops`);
    named.add(manifest.package.path);
  }
  return named;
}

/** Prunes one store: a dry run unless `apply`. */
export async function pruneCodeUpdateStore(input: {
  readonly target: CodeUpdateStoreTarget;
  readonly apply: boolean;
  readonly keepHours: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}): Promise<CodeUpdatePrunePlan> {
  const log = input.log ?? ((line: string) => console.log(line));
  const now = (input.now ?? (() => new Date()))();
  const named = await readNamedPackages({
    publicBaseUrl: input.target.publicBaseUrl,
    fetchImpl: input.fetchImpl ?? fetch,
    now: now.getTime(),
  });
  const plan = planCodeUpdatePrune({
    objects: await input.target.store.list(CODE_UPDATE_PACKAGE_PREFIX),
    named,
    now,
    keepHours: input.keepHours,
  });
  for (const { key, why } of plan.keep) log(`keep   ${input.target.label} ${key} (${why})`);
  for (const key of plan.remove) {
    if (input.apply) await input.target.store.delete(key);
    log(`${input.apply ? "delete" : "would delete"} ${input.target.label} ${key}`);
  }
  if (!input.apply) log("dry run: nothing was deleted (pass --apply, with the owner's yes)");
  return plan;
}
