// FILE: update-mirror-stores.ts
// Purpose: Which download stores the release tools write (Tencent COS, Cloudflare R2, …) and the
//          settings of each, read from the environment and the operator's settings folders. One
//          resolver for the mirror sync, the catalog upload, the runtime upload and the publish
//          check, so they can never disagree about the stores.
// Layer: Release tooling. Lives in scripts/lib because scripts/lib/desktop-feed-release.ts needs it
//        and other projects compile this folder; it imports nothing outside it.

import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** The settings files the sync reads from each settings folder. */
export const LOCAL_SETTINGS_FILES: ReadonlyArray<string> = [
  "update-mirror.env",
  "update-mirror-signing.env",
  "update-mirror-upload.env",
];

/** `KEY=VALUE` lines; blank lines and `#` comments are skipped. */
export function parseSettingsFile(text: string): ReadonlyArray<readonly [string, string]> {
  return text.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    return match?.[1] && match[2] ? [[match[1], match[2]]] : [];
  });
}

/**
 * Settings that belong to one store: its public feed and catalog URLs and its storage account.
 * With several settings folders each store takes these from its own folder only.
 */
export const UPDATE_MIRROR_STORE_SETTING_NAMES: ReadonlyArray<string> = [
  "MOSS_UPDATE_MIRROR_FEED_URL",
  "MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID",
  "MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY",
  "MOSS_UPDATE_MIRROR_S3_BUCKET",
  "MOSS_UPDATE_MIRROR_S3_ENDPOINT",
  "MOSS_UPDATE_MIRROR_S3_REGION",
  "MOSS_UPDATE_MIRROR_S3_PATH_STYLE",
  "MOSS_UPDATE_MIRROR_S3_PREFIX",
  "MOSS_PLUGIN_CATALOG_S3_PREFIX",
  "MOSS_PLUGIN_CATALOG_URL",
];

export interface UpdateMirrorStoreSettings {
  /** The settings folder, for messages. */
  readonly label: string;
  /** What one store's run sees: the process environment plus that store's own folder. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * `MOSS_UPDATE_MIRROR_SETTINGS_DIRS` lists one settings folder per store, separated by the
 * platform's path-list separator (`;` on Windows, `:` elsewhere), as in PATH.
 */
export function splitUpdateMirrorSettingsDirs(
  value: string,
  separator: string = delimiter,
): ReadonlyArray<string> {
  return value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Names that say where the settings folders are; never a setting of a store. */
const SETTINGS_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "MOSS_UPDATE_MIRROR_SETTINGS_DIRS",
  "MOSS_UPDATE_MIRROR_SETTINGS_DIR",
]);

export interface UpdateMirrorStoreResolution {
  readonly stores: ReadonlyArray<UpdateMirrorStoreSettings>;
  /**
   * True when the stores come from a folder list (even a list of one): then every folder must
   * name its own feed URL, and nothing falls back to the single-store defaults.
   */
  readonly severalStores: boolean;
  /** The settings folder whose files listed the store folders; null for the variable or one store. */
  readonly listedIn: string | null;
}

/**
 * The stores to write and the settings of each, for every tool that writes the stores.
 *
 * - `MOSS_UPDATE_MIRROR_SETTINGS_DIRS` in the environment: one store per listed folder.
 * - Otherwise the settings folder is `MOSS_UPDATE_MIRROR_SETTINGS_DIR` (default `~/.moss-release`).
 *   If its files hold a `MOSS_UPDATE_MIRROR_SETTINGS_DIRS=` line, that line lists the store
 *   folders instead (relative entries resolve against that folder). The listing folder's own store
 *   settings apply to no store; its other settings (the signing key, for example) are shared by
 *   every store, below the environment.
 * - No list: one store from that folder, where values already in the environment win, as before.
 *
 * With a list each store's settings come only from its own folder: a store setting already in the
 * process environment is refused, since it would apply to every store at once. A listed folder
 * may not list folders itself.
 */
export async function resolveUpdateMirrorStores(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly files: ReadonlyArray<string>;
  readonly separator?: string;
}): Promise<UpdateMirrorStoreResolution> {
  const { env } = input;
  const readFolder = async (directory: string): Promise<Record<string, string>> => {
    const values: Record<string, string> = {};
    for (const fileName of input.files) {
      const text = await readFile(join(directory, fileName), "utf8").catch(() => "");
      for (const [name, value] of parseSettingsFile(text)) values[name] ??= value;
    }
    return values;
  };
  const definedEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );

  const listedStores = async (
    directories: ReadonlyArray<string>,
    source: string,
    shared: Readonly<Record<string, string>>,
  ): Promise<ReadonlyArray<UpdateMirrorStoreSettings>> => {
    const leaking = UPDATE_MIRROR_STORE_SETTING_NAMES.filter((name) => definedEnv[name]);
    if (leaking.length > 0) {
      throw new Error(
        `${leaking.join(", ")} ${leaking.length === 1 ? "is" : "are"} set in the environment; with ${source} every store's settings must come from its own folder.`,
      );
    }
    if (directories.length === 0) throw new Error(`${source} lists no folder.`);
    if (new Set(directories.map((directory) => resolve(directory))).size !== directories.length) {
      throw new Error(`${source} names a folder twice.`);
    }
    const stores: UpdateMirrorStoreSettings[] = [];
    for (const directory of directories) {
      const values = await readFolder(directory);
      if (values.MOSS_UPDATE_MIRROR_SETTINGS_DIRS?.trim()) {
        throw new Error(
          `${directory} is a store folder listed in ${source}, but it lists store folders itself (MOSS_UPDATE_MIRROR_SETTINGS_DIRS); remove that line from it.`,
        );
      }
      const own = Object.fromEntries(
        Object.entries(values).filter(([name]) => !SETTINGS_FOLDER_NAMES.has(name)),
      );
      stores.push({ label: directory, env: { ...shared, ...definedEnv, ...own } });
    }
    return stores;
  };

  const dirsValue = env.MOSS_UPDATE_MIRROR_SETTINGS_DIRS?.trim();
  if (dirsValue) {
    if (env.MOSS_UPDATE_MIRROR_SETTINGS_DIR?.trim()) {
      throw new Error(
        "Set MOSS_UPDATE_MIRROR_SETTINGS_DIRS or MOSS_UPDATE_MIRROR_SETTINGS_DIR, not both.",
      );
    }
    return {
      stores: await listedStores(
        splitUpdateMirrorSettingsDirs(dirsValue, input.separator),
        "MOSS_UPDATE_MIRROR_SETTINGS_DIRS",
        {},
      ),
      severalStores: true,
      listedIn: null,
    };
  }

  const directory =
    env.MOSS_UPDATE_MIRROR_SETTINGS_DIR?.trim() || join(input.homeDirectory, ".moss-release");
  const values = await readFolder(directory);
  const listValue = values.MOSS_UPDATE_MIRROR_SETTINGS_DIRS?.trim();
  if (!listValue) {
    return {
      stores: [{ label: directory, env: { ...values, ...definedEnv } }],
      severalStores: false,
      listedIn: null,
    };
  }
  const shared = Object.fromEntries(
    Object.entries(values).filter(
      ([name]) =>
        !UPDATE_MIRROR_STORE_SETTING_NAMES.includes(name) && !SETTINGS_FOLDER_NAMES.has(name),
    ),
  );
  return {
    stores: await listedStores(
      splitUpdateMirrorSettingsDirs(listValue, input.separator).map((entry) =>
        isAbsolute(entry) ? entry : resolve(directory, entry),
      ),
      `MOSS_UPDATE_MIRROR_SETTINGS_DIRS in ${directory}`,
      shared,
    ),
    severalStores: true,
    listedIn: directory,
  };
}

/** The stores only; see resolveUpdateMirrorStores. */
export async function readUpdateMirrorStoreSettings(
  input: Parameters<typeof resolveUpdateMirrorStores>[0],
): Promise<ReadonlyArray<UpdateMirrorStoreSettings>> {
  return (await resolveUpdateMirrorStores(input)).stores;
}

/** One line for the log when a settings file listed the stores; names folders, never values. */
export function describeUpdateMirrorStoreList(
  resolution: UpdateMirrorStoreResolution,
): string | null {
  if (resolution.listedIn === null) return null;
  return `Store folders listed in ${resolution.listedIn}: ${resolution.stores.map((store) => store.label).join(", ")}`;
}
