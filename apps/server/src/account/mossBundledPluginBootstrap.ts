import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { readRegularFileNoFollow } from "../workspaceImport/safeFile.ts";
import {
  MOSS_BUNDLED_IMAGEGEN_PLUGIN_NAME,
  MOSS_BUNDLED_PLUGIN_CREATOR_NAME,
  mossBundledPluginMarketplaceRoot,
} from "./mossBundledPluginMarketplace.ts";

const DEFAULT_PLUGINS = [
  {
    name: MOSS_BUNDLED_IMAGEGEN_PLUGIN_NAME,
    marker: ".moss-imagegen-bootstrap-v1",
    content: "moss-bundled-imagegen-v1\n",
  },
  {
    name: MOSS_BUNDLED_PLUGIN_CREATOR_NAME,
    marker: ".moss-plugin-creator-bootstrap-v1",
    content: "moss-bundled-plugin-creator-v1\n",
  },
] as const;
const MANAGED_OWNERSHIP_PATTERN =
  /^moss-managed-codex-home-v2:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/i;
const bootstraps = new Map<string, Promise<void>>();

export async function assertMossManagedPluginHome(homePath: string): Promise<string> {
  const home = path.resolve(homePath);
  const homeStat = await lstat(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error("The managed plugin home must be a real directory.");
  }
  const ownership = await readRegularFileNoFollow(path.join(home, ".moss-managed-home"), 256);
  const marker = ownership.toString("utf8");
  // The managed provider still validates persisted v1 reservations on upgrade.
  // The caller binds this marker to its server-configured managed source path.
  if (marker !== "moss-managed-codex-home-v1\n" && !MANAGED_OWNERSHIP_PATTERN.test(marker)) {
    throw new Error("The plugin bootstrap requires a verified managed Moss home.");
  }
  return realpath(home);
}

export interface MossBundledPluginBootstrapInput {
  /** Server-configured managed home, never supplied by a client. */
  readonly expectedHomePath?: string;
  readonly homePath?: string;
  readonly initializedHomePath: string;
  /** Effective CODEX_HOME from the server-created launch environment. */
  readonly expectedRuntimeHomePath?: string;
  readonly accountId?: string;
  readonly shadowHomePath?: string;
  /** Must resolve only after native installation and its installed-state read-back succeed. */
  readonly install: (input: { marketplacePath: string; pluginName: string }) => Promise<void>;
}

/** Install each official default once; explicit later uninstalls remain durable independently. */
export async function bootstrapMossBundledPlugins(
  input: MossBundledPluginBootstrapInput,
): Promise<void> {
  if (
    !input.expectedHomePath ||
    !input.homePath ||
    input.accountId !== "moss" ||
    input.shadowHomePath ||
    path.resolve(input.homePath) !== path.resolve(input.expectedHomePath)
  )
    return;

  const home = path.resolve(input.expectedHomePath);
  const canonicalHome = await assertMossManagedPluginHome(home);
  const expectedRuntime = input.expectedRuntimeHomePath ?? home;
  if ((await realpath(input.initializedHomePath)) !== (await realpath(expectedRuntime))) {
    throw new Error("The native plugin runtime is using a different Codex home.");
  }

  const pending = bootstraps.get(canonicalHome);
  if (pending) return pending;
  const work = (async () => {
    for (const plugin of DEFAULT_PLUGINS) {
      const markerPath = path.join(home, plugin.marker);
      try {
        const marker = await readRegularFileNoFollow(markerPath, 256);
        if (marker.toString("utf8") !== plugin.content) {
          throw new Error("The managed plugin bootstrap marker is invalid.");
        }
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      await input.install({
        marketplacePath: path.join(
          mossBundledPluginMarketplaceRoot(home),
          ".agents",
          "plugins",
          "marketplace.json",
        ),
        pluginName: plugin.name,
      });
      const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(plugin.content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, markerPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    }
  })();
  bootstraps.set(canonicalHome, work);
  try {
    await work;
  } finally {
    if (bootstraps.get(canonicalHome) === work) bootstraps.delete(canonicalHome);
  }
}
