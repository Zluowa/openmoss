// The lease registry: one JSON file in the state folder, outside every repository.
// Writes go through a short directory lock and an atomic rename.
import fs from "node:fs";
import path from "node:path";
import { acquireLock } from "./lock.ts";
import type { Profile } from "./profile.ts";

export interface Lease {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
  readonly owner: string;
  readonly created: string;
  readonly portOffset: number;
  readonly ports: { readonly server: number; readonly web: number };
  readonly scratch: string;
}

export interface Registry {
  version: 1;
  leases: Record<string, Lease>;
}

export function registryFile(profile: Pick<Profile, "stateDir">): string {
  return path.join(profile.stateDir, "leases.json");
}

export function readRegistry(profile: Pick<Profile, "stateDir">): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(profile), "utf8")) as Registry;
    if (raw && raw.version === 1 && raw.leases && typeof raw.leases === "object") return raw;
  } catch {
    // missing or unreadable: start empty
  }
  return { version: 1, leases: {} };
}

function writeRegistry(profile: Pick<Profile, "stateDir">, registry: Registry): void {
  fs.mkdirSync(profile.stateDir, { recursive: true });
  const file = registryFile(profile);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Read-modify-write under the registry lock. */
export async function updateRegistry<T>(
  profile: Pick<Profile, "stateDir">,
  change: (registry: Registry) => T | Promise<T>,
): Promise<T> {
  const lock = await acquireLock({
    dir: path.join(profile.stateDir, "locks"),
    name: "registry",
    staleMs: 60_000,
    pollMs: 50,
    owner: { owner: "ws", lane: "registry", sha: "" },
    timeoutMs: 30_000,
  });
  try {
    const registry = readRegistry(profile);
    const result = await change(registry);
    writeRegistry(profile, registry);
    return result;
  } finally {
    lock.release();
  }
}

export const BASE_SERVER_PORT = 3773;
export const BASE_WEB_PORT = 5733;

/** Lowest offset in the profile's range that no lease holds and `isFree` accepts. */
export async function pickPortOffset(
  profile: Pick<Profile, "ports">,
  registry: Registry,
  isFree: (port: number) => Promise<boolean>,
): Promise<number> {
  const used = new Set(Object.values(registry.leases).map((l) => l.portOffset));
  const { offsetFirst, offsetLast, offsetStep } = profile.ports;
  for (let offset = offsetFirst; offset <= offsetLast; offset += offsetStep) {
    if (used.has(offset)) continue;
    if ((await isFree(BASE_SERVER_PORT + offset)) && (await isFree(BASE_WEB_PORT + offset)))
      return offset;
  }
  throw new Error(`no free port offset between ${offsetFirst} and ${offsetLast}`);
}
