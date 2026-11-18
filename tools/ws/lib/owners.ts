// Which of our sessions a running process belongs to, from the folder its command line names:
// a lease (its owner), the shared checkout, a scratch folder or the lane temp root. `ws doctor`
// lists them with their memory, so a session's leftovers (a vite build, an isolated Moss, a vitest
// worker) can be found and closed by their owner on a PC that is short of memory.
import fs from "node:fs";
import path from "node:path";

import { commandLineUsesPath, normalize } from "./paths.ts";
import type { ProcessInfo } from "./proc.ts";
import type { Profile } from "./profile.ts";
import { readRegistry } from "./registry.ts";

const HEAVY_NAMES = /^(node|bun|electron|moss|turbo|esbuild|tsgo)(\.exe)?$/i;

export interface OwnedRoot {
  readonly path: string;
  readonly owner: string;
}

export interface OwnedGroup {
  readonly owner: string;
  readonly processes: ProcessInfo[];
  readonly bytes: number;
}

/** The folders we can attribute, most specific first (a lease inside a root wins over the root). */
export function ownedRoots(profile: Profile): OwnedRoot[] {
  const roots: OwnedRoot[] = [];
  try {
    for (const lease of Object.values(readRegistry(profile).leases)) {
      roots.push({ path: lease.path, owner: `${lease.owner} (lease ${lease.name})` });
      if (lease.scratch)
        roots.push({ path: lease.scratch, owner: `${lease.owner} (scratch of ${lease.name})` });
    }
  } catch {
    // no registry
  }
  try {
    for (const entry of fs.readdirSync(profile.scratchRoot, { withFileTypes: true })) {
      if (entry.isDirectory())
        roots.push({
          path: path.join(profile.scratchRoot, entry.name),
          owner: `scratch ${entry.name}`,
        });
    }
  } catch {
    // no scratch root
  }
  roots.push({ path: profile.primaryCheckout, owner: "shared checkout" });
  if (profile.tempRoot) roots.push({ path: profile.tempRoot, owner: "lane run temp" });
  return roots.toSorted((a, b) => normalize(b.path).length - normalize(a.path).length);
}

/** Our heavy runtimes (node, bun, Electron/Moss, turbo, esbuild, tsgo) grouped by owner, largest first. */
export function processesByOwner(
  processes: readonly ProcessInfo[],
  roots: readonly OwnedRoot[],
): OwnedGroup[] {
  const groups = new Map<string, ProcessInfo[]>();
  for (const p of processes) {
    if (!HEAVY_NAMES.test(p.name)) continue;
    const root = roots.find((r) => commandLineUsesPath(p.commandLine, r.path));
    if (!root) continue;
    groups.set(root.owner, [...(groups.get(root.owner) ?? []), p]);
  }
  return [...groups.entries()]
    .map(([owner, list]) => ({
      owner,
      processes: list,
      bytes: list.reduce((sum, p) => sum + (p.memoryBytes ?? 0), 0),
    }))
    .toSorted((a, b) => b.bytes - a.bytes);
}
