import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify, type TomlTable } from "smol-toml";

import { readRegularFileNoFollow } from "../workspaceImport/safeFile.ts";
import { MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME } from "./mossBundledPluginMarketplace.ts";
import { assertMossManagedPluginHome } from "./mossBundledPluginBootstrap.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 16_384 && !value.includes("\0")
  );
}

function checkedTable(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`The native ${label} setting is invalid or unsupported.`);
  }
  return value;
}

function checkOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`The native ${label} setting is invalid.`);
}

function checkApproval(value: unknown): void {
  if (value !== undefined && !["auto", "prompt", "writes", "approve"].includes(value as string)) {
    throw new Error("The native plugin approval setting is invalid.");
  }
}

function validatePluginConfig(value: unknown, isDefault: boolean): TomlTable {
  const plugin = checkedTable(
    value,
    isDefault ? ["enabled"] : ["enabled", "mcp_servers"],
    "plugin",
  );
  checkOptionalBoolean(plugin.enabled, "plugin enabled");
  if (plugin.mcp_servers !== undefined) {
    if (!record(plugin.mcp_servers)) throw new Error("The native plugin MCP settings are invalid.");
    for (const [name, value] of Object.entries(plugin.mcp_servers)) {
      if (!validText(name)) throw new Error("The native plugin MCP server name is invalid.");
      const server = checkedTable(
        value,
        ["enabled", "enabled_tools", "disabled_tools", "default_tools_approval_mode", "tools"],
        "plugin MCP",
      );
      checkOptionalBoolean(server.enabled, "plugin MCP enabled");
      checkApproval(server.default_tools_approval_mode);
      for (const field of ["enabled_tools", "disabled_tools"] as const) {
        if (
          server[field] !== undefined &&
          (!Array.isArray(server[field]) || !server[field].every(validText))
        ) {
          throw new Error("The native plugin tool selection is invalid.");
        }
      }
      if (server.tools !== undefined) {
        if (!record(server.tools)) throw new Error("The native plugin tool settings are invalid.");
        for (const [name, value] of Object.entries(server.tools)) {
          if (!validText(name)) throw new Error("The native plugin tool name is invalid.");
          const tool = checkedTable(value, ["approval_mode", "output_token_limit"], "plugin tool");
          checkApproval(tool.approval_mode);
          if (
            tool.output_token_limit !== undefined &&
            (!Number.isSafeInteger(tool.output_token_limit) || Number(tool.output_token_limit) < 1)
          ) {
            throw new Error("The native plugin output token limit is invalid.");
          }
        }
      }
    }
  }
  return plugin as TomlTable;
}

/**
 * Keep native install/toggle/marketplace choices when regenerating managed model
 * routing. Only these namespaces are copied; credentials, provider definitions,
 * environment policies and permissions remain owned by the managed service.
 * The service must verify managed-home ownership before invoking this helper.
 */
export async function readMossManagedPluginConfig(input: {
  readonly managedHomePath: string;
  readonly configPath: string;
}): Promise<string> {
  const home = path.resolve(input.managedHomePath);
  if (path.resolve(input.configPath) !== path.join(home, "config.toml")) {
    throw new Error("The native plugin config must belong to the verified managed home.");
  }
  const homeStat = await lstat(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error("The managed plugin config home must be a real directory.");
  }
  const canonicalHome = await realpath(home);
  let contents: Buffer;
  try {
    contents = await readRegularFileNoFollow(path.join(canonicalHome, "config.toml"), 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const parsed = parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  const plugins: Record<string, TomlTable> = Object.create(null);
  if (parsed.plugins !== undefined && !record(parsed.plugins)) {
    throw new Error("The native plugins config must be a table.");
  }
  for (const [id, entry] of Object.entries(parsed.plugins ?? {})) {
    if (!validText(id)) throw new Error("The native plugin name is invalid.");
    plugins[id] = validatePluginConfig(entry, id === "_default");
  }

  const marketplaces: Record<string, TomlTable> = Object.create(null);
  if (parsed.marketplaces !== undefined && !record(parsed.marketplaces)) {
    throw new Error("The native marketplaces config must be a table.");
  }
  for (const [name, entry] of Object.entries(parsed.marketplaces ?? {})) {
    if (name === MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME) continue;
    if (!validText(name)) throw new Error("The native marketplace name is invalid.");
    const marketplace = checkedTable(
      entry,
      ["source_type", "source", "ref", "sparse_paths", "last_revision", "last_updated"],
      "marketplace",
    );
    if (
      marketplace.source_type !== undefined &&
      marketplace.source_type !== "local" &&
      marketplace.source_type !== "git"
    ) {
      throw new Error("The native marketplace source type is invalid.");
    }
    for (const field of ["source", "ref", "last_revision", "last_updated"] as const) {
      if (marketplace[field] !== undefined && !validText(marketplace[field])) {
        throw new Error(`The native marketplace ${field} is invalid.`);
      }
    }
    if (marketplace.sparse_paths !== undefined) {
      if (!Array.isArray(marketplace.sparse_paths) || !marketplace.sparse_paths.every(validText)) {
        throw new Error("The native marketplace sparse paths are invalid.");
      }
    }
    marketplaces[name] = marketplace as TomlTable;
  }
  if (Object.keys(plugins).length === 0 && Object.keys(marketplaces).length === 0) return "";
  return `\n${stringify({
    ...(Object.keys(plugins).length ? { plugins } : {}),
    ...(Object.keys(marketplaces).length ? { marketplaces } : {}),
  })}`;
}

const configSyncs = new Map<string, Promise<void>>();
const pluginStorePreparations = new Map<string, Promise<void>>();

async function withManagedPluginConfigLock(
  home: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = configSyncs.get(home) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(operation);
  configSyncs.set(home, work);
  try {
    await work;
  } finally {
    if (configSyncs.get(home) === work) configSyncs.delete(home);
  }
}

/** Regenerate managed routing without racing native plugin preference writes. */
export async function writeMossManagedPluginConfig(input: {
  readonly managedHomePath: string;
  readonly configPath: string;
  readonly generatedConfig: string;
  /** Service-proven inactive provisioning crash or migrated credential-free tombstone. */
  readonly recoverStagedConfig?: boolean;
  /** Revalidate persisted ownership nonce/location at each commit boundary. */
  readonly assertCurrent?: () => void;
  /** Keep the service's filesystem abstraction and atomic write guarantees. */
  readonly writeAtomically?: (input: { filePath: string; contents: string }) => Promise<void>;
}): Promise<void> {
  input.assertCurrent?.();
  const home = await assertMossManagedPluginHome(input.managedHomePath);
  if (
    path.resolve(input.configPath) !== path.join(path.resolve(input.managedHomePath), "config.toml")
  ) {
    throw new Error("The native plugin config must belong to the verified managed home.");
  }
  await withManagedPluginConfigLock(home, async () => {
    input.assertCurrent?.();
    const configPath = path.join(home, "config.toml");
    const before = await readRegularFileNoFollow(configPath, 1024 * 1024).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    let recoverEmptyStaging = false;
    if (input.recoverStagedConfig && before) {
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(before);
      try {
        parse(contents);
      } catch (error) {
        // A known inactive crash may have left an incomplete generated routing
        // file. Never discard anything that could contain native preferences or
        // belong to an installation that has already bootstrapped plugins.
        if (/\b(?:plugins|marketplaces)\b/i.test(contents)) throw error;
        for (const entry of [
          "plugins",
          ".moss-imagegen-bootstrap-v1",
          ".moss-plugin-creator-bootstrap-v1",
        ]) {
          const exists = await lstat(path.join(home, entry)).catch(
            (cause: NodeJS.ErrnoException) => {
              if (cause.code === "ENOENT") return undefined;
              throw cause;
            },
          );
          if (exists) throw error;
        }
        recoverEmptyStaging = true;
      }
    }
    const preserved = recoverEmptyStaging
      ? ""
      : await readMossManagedPluginConfig({ managedHomePath: home, configPath });
    const contents = input.generatedConfig + preserved;
    // Fail before replacing the live config if the generated and preserved
    // namespaces conflict or the server-generated TOML is malformed.
    parse(contents);
    const assertUnchanged = async () => {
      const latest = await readRegularFileNoFollow(configPath, 1024 * 1024).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (
        (before === undefined) !== (latest === undefined) ||
        (before && !before.equals(latest!))
      ) {
        throw new Error("Managed Codex config changed during refresh; retry.");
      }
      input.assertCurrent?.();
    };
    if (input.writeAtomically) {
      await assertUnchanged();
      await input.writeAtomically({ filePath: configPath, contents });
      input.assertCurrent?.();
      return;
    }
    const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertUnchanged();
      await rename(temporaryPath, configPath);
      input.assertCurrent?.();
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
}

/** Compose runtime policy in the verified canonical home under the routing/plugin lock. */
export async function updateMossManagedRuntimeConfig(input: {
  readonly managedHomePath: string;
  readonly assertCurrent: () => Promise<void>;
  readonly transform: (contents: string) => string;
  readonly commit: (
    filePath: string,
    contents: string,
    assertUnchanged: () => Promise<void>,
  ) => Promise<void>;
}): Promise<void> {
  await input.assertCurrent();
  const home = await assertMossManagedPluginHome(input.managedHomePath);
  await withManagedPluginConfigLock(home, async () => {
    await input.assertCurrent();
    const configPath = path.join(home, "config.toml");
    const read = () =>
      readRegularFileNoFollow(configPath, 1024 * 1024).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    const before = await read();
    const contents = input.transform(
      before ? new TextDecoder("utf-8", { fatal: true }).decode(before) : "",
    );
    parse(contents);
    const assertUnchanged = async () => {
      await input.assertCurrent();
      const latest = await read();
      if (
        (before === undefined) !== (latest === undefined) ||
        (before && !before.equals(latest!))
      ) {
        throw new Error("Managed Codex config changed during runtime preparation; retry.");
      }
    };
    await assertUnchanged();
    if (!before || !before.equals(Buffer.from(contents, "utf8"))) {
      await input.commit(configPath, contents, assertUnchanged);
    }
    await input.assertCurrent();
  });
}

/** Ensure future overlays link the account's native plugin cache instead of owning it. */
export async function prepareMossManagedPluginStore(input: {
  readonly managedHomePath: string;
  readonly runtimeHomePath: string;
  readonly assertCurrent?: () => Promise<void>;
  readonly reconcileLegacyConfig?: boolean;
  readonly legacyOwnershipMarker?: string;
}): Promise<void> {
  await input.assertCurrent?.();
  const home = await assertMossManagedPluginHome(input.managedHomePath);
  const previous = pluginStorePreparations.get(home) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      await input.assertCurrent?.();
      let commitLegacyConfigReceipt = async () => {};
      if (
        input.reconcileLegacyConfig &&
        path.resolve(home) !== path.resolve(input.runtimeHomePath)
      ) {
        const oldPath = path.join(input.runtimeHomePath, "config.toml");
        const oldBytes = await readRegularFileNoFollow(oldPath, 1024 * 1024).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (oldBytes) {
          const receiptPath = path.join(home, ".moss-legacy-plugin-config-v1.json");
          if (!input.legacyOwnershipMarker)
            throw new Error("Legacy plugin reconciliation requires verified ownership.");
          const receipt = JSON.stringify({
            version: 1,
            canonicalSource: home,
            ownershipMarkerSha256: createHash("sha256")
              .update(input.legacyOwnershipMarker)
              .digest("hex"),
            runtimeHomePath: await realpath(input.runtimeHomePath),
            configSha256: createHash("sha256").update(oldBytes).digest("hex"),
          });
          const saved = await readRegularFileNoFollow(receiptPath, 16 * 1024).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          if (saved && saved.toString("utf8") !== receipt) {
            throw new Error(
              "Legacy managed plugin settings changed after migration; reconciliation is required.",
            );
          }
          if (!saved) {
            const current = await readMossManagedPluginConfig({
              managedHomePath: home,
              configPath: path.join(home, "config.toml"),
            });
            const previous = await readMossManagedPluginConfig({
              managedHomePath: input.runtimeHomePath,
              configPath: oldPath,
            });
            if (current && previous && !isDeepStrictEqual(parse(current), parse(previous))) {
              throw new Error(
                "Managed and legacy runtime plugin settings conflict; migration requires reconciliation.",
              );
            }
            if (!current && previous)
              await syncMossManagedPluginConfig({
                managedHomePath: home,
                expectedSourcePluginConfig: current,
                runtimeHomePath: input.runtimeHomePath,
                assertCurrent: input.assertCurrent ?? (() => undefined),
              });
            commitLegacyConfigReceipt = async () => {
              await input.assertCurrent?.();
              if (!(await readRegularFileNoFollow(oldPath, 1024 * 1024)).equals(oldBytes)) {
                throw new Error("Legacy managed plugin settings changed during migration; retry.");
              }
              const handle = await open(receiptPath, "wx", 0o600);
              try {
                await handle.writeFile(receipt, "utf8");
                await handle.sync();
              } finally {
                await handle.close();
              }
              await input.assertCurrent?.();
            };
          }
        }
      }
      const source = path.join(home, "plugins");
      const runtime = path.join(input.runtimeHomePath, "plugins");
      const sourceStat = await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (sourceStat && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())) {
        throw new Error("The managed plugin store must be a real directory.");
      }
      if (path.resolve(source) !== path.resolve(runtime)) {
        const runtimeStat = await lstat(runtime).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (runtimeStat?.isSymbolicLink()) {
          if (!sourceStat || (await realpath(runtime)) !== (await realpath(source))) {
            throw new Error("The native plugin store links to a different account.");
          }
        } else if (runtimeStat) {
          if (!runtimeStat.isDirectory())
            throw new Error("The native plugin store must be a directory.");
          // A failed older Windows startup can leave an empty overlay store.
          // It contains no state to migrate and must not conflict with defaults.
          if (input.reconcileLegacyConfig && (await readdir(runtime)).length === 0) {
            await commitLegacyConfigReceipt();
            if (!sourceStat) {
              await input.assertCurrent?.();
              await mkdir(source, { mode: 0o700 });
            }
            return;
          }
          if (sourceStat && (await readdir(source)).length > 0) {
            throw new Error(
              "Managed and runtime plugin stores both contain data; migration requires reconciliation.",
            );
          }
          const runtimeConfig = await lstat(path.join(input.runtimeHomePath, "config.toml")).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          if (runtimeConfig && !input.reconcileLegacyConfig) {
            // Older builds kept activation settings only in the overlay too.
            // Preserve them before the launch rebuilds its generated config.
            await syncMossManagedPluginConfig({
              managedHomePath: home,
              runtimeHomePath: input.runtimeHomePath,
              assertCurrent: input.assertCurrent ?? (() => undefined),
            });
          }
          // Move the legacy cache rather than erasing installed plugin content.
          await input.assertCurrent?.();
          if (sourceStat) await rmdir(source);
          await rename(runtime, source);
          await commitLegacyConfigReceipt();
          return;
        }
      }
      await input.assertCurrent?.();
      if (!sourceStat) await mkdir(source, { mode: 0o700 });
      await commitLegacyConfigReceipt();
    });
  pluginStorePreparations.set(home, work);
  try {
    await work;
  } finally {
    if (pluginStorePreparations.get(home) === work) pluginStorePreparations.delete(home);
  }
}

/** Persist native mutations from the verified launch overlay to the managed source. */
export async function syncMossManagedPluginConfig(input: {
  readonly managedHomePath: string;
  readonly runtimeHomePath: string;
  readonly expectedSourcePluginConfig?: string;
  readonly assertCurrent: () => void | Promise<void>;
}): Promise<void> {
  await input.assertCurrent();
  const source = await assertMossManagedPluginHome(input.managedHomePath);
  const runtime = await realpath(input.runtimeHomePath);
  if (source === runtime) return;
  await withManagedPluginConfigLock(source, async () => {
    await input.assertCurrent();
    const sections = parse(
      await readMossManagedPluginConfig({
        managedHomePath: runtime,
        configPath: path.join(runtime, "config.toml"),
      }),
    );
    const sourcePath = path.join(source, "config.toml");
    const sourceContents = await readRegularFileNoFollow(sourcePath, 1024 * 1024);
    const sourceConfig = parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceContents));
    if (input.expectedSourcePluginConfig !== undefined) {
      const current = await readMossManagedPluginConfig({
        managedHomePath: source,
        configPath: sourcePath,
      });
      if (!isDeepStrictEqual(parse(current), parse(input.expectedSourcePluginConfig))) {
        throw new Error("Managed plugin choices changed during legacy migration; retry.");
      }
    }
    // The bundled marketplace and all routing/auth settings remain server-owned.
    const bundled = record(sourceConfig.marketplaces)
      ? sourceConfig.marketplaces[MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME]
      : undefined;
    delete sourceConfig.plugins;
    delete sourceConfig.marketplaces;
    if (sections.plugins !== undefined) sourceConfig.plugins = sections.plugins;
    if (bundled !== undefined || sections.marketplaces !== undefined) {
      sourceConfig.marketplaces = {
        ...(record(sections.marketplaces) ? sections.marketplaces : {}),
        ...(bundled !== undefined ? { [MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME]: bundled } : {}),
      } as TomlTable;
    }
    const temporaryPath = `${sourcePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(stringify(sourceConfig), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await input.assertCurrent();
      // Detect managed routing refreshes that happened during the read/write.
      const latest = await readRegularFileNoFollow(sourcePath, 1024 * 1024);
      if (!latest.equals(sourceContents)) {
        throw new Error(
          "Managed Codex config changed during plugin persistence; refresh and retry.",
        );
      }
      await rename(temporaryPath, sourcePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  });
}
