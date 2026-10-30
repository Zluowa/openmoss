/**
 * Moss hook trust store (ported from 1code `moss-source/hook-trust.ts`).
 *
 * Hooks are user-editable commands, so the runtime hook executor (SY5) only
 * runs hooks whose current content hash matches a recorded trust decision.
 * The store lives at `.moss/hooks/.trust.json`, resolved through
 * {@link getMossSourceLayout} so the path stays single-sourced.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMossSourceLayout } from "./mossSourceLayout";

/**
 * Trust state for a single Moss hook.
 *
 * - `untrusted`: the hook has never been trusted (newly discovered).
 * - `changed`: the hook was trusted before but its command hash no longer
 *   matches the value recorded when it was trusted.
 * - `trusted`: the current command hash matches the recorded trusted hash.
 *
 * Only `trusted` hooks are allowed to spawn a child process at runtime; the
 * hook executor treats `untrusted` and `changed` as skip conditions: a hook is
 * "Disabled until hook is trusted" and returns to review when it is "changed
 * since last trusted".
 */
export type MossHookTrustState = "untrusted" | "trusted" | "changed";

export interface MossHookTrustEntry {
  readonly trustedHash: string;
  readonly trustedAt: string;
}

export interface MossHookTrustStore {
  version: 1;
  hooks: Record<string, MossHookTrustEntry>;
}

const TRUST_STORE_VERSION = 1 as const;
const TRUST_STORE_FILE = ".trust.json";

/**
 * Compute the content hash used to decide whether a hook can run.
 *
 * The hash covers the security-relevant parts of a hook (the command it would
 * spawn and the event it fires on). Changing the command invalidates a prior
 * trust decision so the runtime gate re-skips the hook until it is re-trusted.
 */
export function computeHookTrustHash(params: { command?: string; event?: string }): string {
  const command = (params.command ?? "").trim();
  const event = (params.event ?? "").trim();
  return createHash("sha256").update(`event:${event}\ncommand:${command}`).digest("hex");
}

export function resolveHookTrustState(params: {
  currentHash: string;
  entry: MossHookTrustEntry | undefined;
}): MossHookTrustState {
  if (!params.entry) return "untrusted";
  return params.entry.trustedHash === params.currentHash ? "trusted" : "changed";
}

export function getHookTrustStorePath(projectPath: string): string {
  return join(getMossSourceLayout(projectPath).hooksRoot, TRUST_STORE_FILE);
}

function normalizeTrustStore(value: unknown): MossHookTrustStore {
  const empty: MossHookTrustStore = { version: TRUST_STORE_VERSION, hooks: {} };
  if (!value || typeof value !== "object") return empty;
  const raw = value as { hooks?: unknown };
  if (!raw.hooks || typeof raw.hooks !== "object") return empty;

  const hooks: Record<string, MossHookTrustEntry> = {};
  for (const [name, entry] of Object.entries(raw.hooks as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as { trustedHash?: unknown; trustedAt?: unknown };
    if (typeof typed.trustedHash !== "string" || !typed.trustedHash) continue;
    hooks[name] = {
      trustedHash: typed.trustedHash,
      trustedAt:
        typeof typed.trustedAt === "string" && typed.trustedAt
          ? typed.trustedAt
          : new Date(0).toISOString(),
    };
  }
  return { version: TRUST_STORE_VERSION, hooks };
}

export async function readHookTrustStore(projectPath: string): Promise<MossHookTrustStore> {
  try {
    const raw = await readFile(getHookTrustStorePath(projectPath), "utf8");
    return normalizeTrustStore(JSON.parse(raw));
  } catch {
    return { version: TRUST_STORE_VERSION, hooks: {} };
  }
}

async function writeHookTrustStore(projectPath: string, store: MossHookTrustStore): Promise<void> {
  const storePath = getHookTrustStorePath(projectPath);
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/**
 * Record that `hookName` is trusted at its current content hash. Subsequent
 * discovery reports the hook as `trusted`; editing its command changes the
 * hash and returns it to `changed`.
 */
export async function trustHook(params: {
  projectPath: string;
  hookName: string;
  trustedHash: string;
}): Promise<MossHookTrustStore> {
  const store = await readHookTrustStore(params.projectPath);
  store.hooks[params.hookName] = {
    trustedHash: params.trustedHash,
    trustedAt: new Date().toISOString(),
  };
  await writeHookTrustStore(params.projectPath, store);
  return store;
}

export async function trustAllHooks(params: {
  projectPath: string;
  hooks: ReadonlyArray<{ name: string; trustedHash: string }>;
}): Promise<MossHookTrustStore> {
  const store = await readHookTrustStore(params.projectPath);
  const trustedAt = new Date().toISOString();
  for (const hook of params.hooks) {
    store.hooks[hook.name] = { trustedHash: hook.trustedHash, trustedAt };
  }
  await writeHookTrustStore(params.projectPath, store);
  return store;
}

export async function forgetHookTrust(params: {
  projectPath: string;
  hookName: string;
}): Promise<MossHookTrustStore> {
  const store = await readHookTrustStore(params.projectPath);
  if (params.hookName in store.hooks) {
    delete store.hooks[params.hookName];
    await writeHookTrustStore(params.projectPath, store);
  }
  return store;
}
