import path from "node:path";
import { lstat, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { parseDocument } from "yaml";
import { readRegularFileNoFollow } from "../workspaceImport/safeFile";
import { ensureMossManagedHome, writeMossManagedFile } from "./mossManagedRelayInstance";
import {
  MOSS_HERMES_PROBE_PLUGIN_MANIFEST,
  MOSS_HERMES_PROBE_PLUGIN_NAME,
  MOSS_HERMES_PROBE_PLUGIN_SOURCE,
} from "./mossManagedHermesProbePlugin";

const label = "Managed Hermes compatibility plugin";
const files = {
  "plugin.yaml": MOSS_HERMES_PROBE_PLUGIN_MANIFEST,
  "__init__.py": MOSS_HERMES_PROBE_PLUGIN_SOURCE,
};
const missing = (error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Preserve explicit plugin choices and opt in only this private compatibility plugin. */
export async function readMossHermesPluginConfiguration(homePath: string) {
  const bytes = await readRegularFileNoFollow(
    path.join(homePath, "config.yaml"),
    1024 * 1024,
  ).catch(missing);
  if (!bytes) return { enabled: [MOSS_HERMES_PROBE_PLUGIN_NAME] };
  let configuration: unknown;
  try {
    const document = parseDocument(bytes.toString("utf8"));
    if (document.errors.length) throw new Error("Invalid YAML");
    configuration = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("Managed Hermes plugin configuration could not be read safely.");
  }
  if (!record(configuration))
    throw new Error("Managed Hermes plugin configuration could not be read safely.");
  if (configuration.plugins === undefined) return { enabled: [MOSS_HERMES_PROBE_PLUGIN_NAME] };
  const plugins = configuration.plugins;
  if (!record(plugins))
    throw new Error("Managed Hermes plugin configuration could not be read safely.");
  for (const key of ["enabled", "disabled"]) {
    const value = plugins[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || !value.every((name) => typeof name === "string"))
    )
      throw new Error("Managed Hermes plugin configuration could not be read safely.");
  }
  if ((plugins.disabled as string[] | undefined)?.includes(MOSS_HERMES_PROBE_PLUGIN_NAME))
    throw new Error(
      "Moss Hermes compatibility is disabled in this isolated home's plugin settings.",
    );
  // ACP does not run the CLI's migration 21. Its missing allow-list enables no user plugins;
  // bundled backends/platforms load independently. Do not enable other user plugins implicitly.
  const enabled = Array.isArray(plugins.enabled) ? plugins.enabled : [];
  return {
    ...plugins,
    enabled: enabled.includes(MOSS_HERMES_PROBE_PLUGIN_NAME)
      ? enabled
      : [...enabled, MOSS_HERMES_PROBE_PLUGIN_NAME],
  };
}

async function verifyPlugin(directory: string): Promise<void> {
  await ensureMossManagedHome(directory, label);
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        !Object.hasOwn(files, entry.name) &&
        !(entry.name === "__pycache__" && entry.isDirectory() && !entry.isSymbolicLink()),
    )
  )
    throw new Error("Moss Hermes compatibility plugin conflicts with an existing plugin.");
  for (const [name, content] of Object.entries(files)) {
    const existing = await readRegularFileNoFollow(path.join(directory, name), 32 * 1024).catch(
      missing,
    );
    if (!existing?.equals(Buffer.from(content)))
      throw new Error("Moss Hermes compatibility plugin conflicts with an existing plugin.");
  }
}

/** Publish complete owned bytes, leaving any different existing plugin untouched. */
export async function prepareMossHermesProbePlugin(homePath: string): Promise<void> {
  const plugins = path.join(homePath, "plugins");
  const target = path.join(plugins, MOSS_HERMES_PROBE_PLUGIN_NAME);
  await ensureMossManagedHome(plugins, label);
  if (await lstat(target).catch(missing)) return verifyPlugin(target);
  const staging = await mkdtemp(path.join(plugins, ".moss-probe-"));
  try {
    await ensureMossManagedHome(staging, label);
    for (const [fileName, content] of Object.entries(files))
      await writeMossManagedFile({ directory: staging, fileName, content, label });
    await ensureMossManagedHome(plugins, label);
    if (await lstat(target).catch(missing)) return await verifyPlugin(target);
    try {
      await rename(staging, target);
    } catch (error) {
      // A concurrent preparation may have won. Only the exact complete owned plugin is valid.
      if (!(await lstat(target).catch(missing))) throw error;
    }
    await verifyPlugin(target);
  } finally {
    const remaining = await lstat(staging).catch(missing);
    // Delete only our canonical staging directory, never a replacement link or another home.
    if (
      remaining?.isDirectory() &&
      !remaining.isSymbolicLink() &&
      path.dirname(staging) === plugins &&
      path.basename(staging).startsWith(".moss-probe-") &&
      (await realpath(staging)) === staging
    )
      await rm(staging, { recursive: true, force: true });
  }
}
