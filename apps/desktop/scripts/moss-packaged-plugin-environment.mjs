// Minimal cross-runtime profile isolation helper shared by packaged Gate 8 probes.
// Keep this module free of Node-only database imports so Bun runtime probes can load it.

import {
  delimiter as nativeDelimiter,
  join as nativeJoin,
  resolve as nativeResolve,
  win32,
} from "node:path";

const UNSAFE_INHERITED_ENV_KEYS = [
  "VITE_DEV_SERVER_URL",
  "MOSS_BACKEND_NODE_PATH",
  "T3CODE_BACKEND_NODE_PATH",
  "DPCODE_BACKEND_NODE_PATH",
  "MOSS_HOME",
  "MOSS_DESKTOP_USER_DATA_DIR",
  "MOSS_BUNDLED_CODEX_PATH",
  "MOSS_BUNDLED_CODEX_ERROR",
  "ELECTRON_RUN_AS_NODE",
];

export function buildIsolatedPackagedEnvironment(
  profileRoot,
  inherited = process.env,
  { platform = process.platform } = {},
) {
  if (!new Set(["darwin", "linux", "win32"]).has(platform)) {
    throw new Error(`Unsupported packaged environment platform: ${String(platform)}`);
  }
  const pathApi =
    platform === "win32"
      ? win32
      : { delimiter: nativeDelimiter, join: nativeJoin, resolve: nativeResolve };
  const absoluteRoot = pathApi.resolve(profileRoot);
  const home = pathApi.join(absoluteRoot, "home");
  const mossHome = pathApi.join(absoluteRoot, "moss-home");
  const sourceCodexHome = pathApi.join(absoluteRoot, "source-codex-home");
  const expectedEffectiveCodexHome = pathApi.join(mossHome, "codex-home-overlay");
  const pathTrapDir = pathApi.join(absoluteRoot, "path-trap");
  const globalCodexTrapPath = pathApi.join(absoluteRoot, "global-codex-invoked.json");
  const electronUserDataPath = pathApi.join(absoluteRoot, "electron-user-data");
  const systemPathEntries =
    platform === "win32"
      ? [
          pathTrapDir,
          pathApi.join(inherited.SystemRoot ?? inherited.WINDIR ?? "C:\\Windows", "System32"),
          inherited.SystemRoot ?? inherited.WINDIR ?? "C:\\Windows",
        ]
      : [pathTrapDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env = { ...inherited };
  for (const key of UNSAFE_INHERITED_ENV_KEYS) delete env[key];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: pathApi.join(absoluteRoot, "xdg-config"),
    XDG_CACHE_HOME: pathApi.join(absoluteRoot, "xdg-cache"),
    APPDATA: pathApi.join(absoluteRoot, "appdata"),
    LOCALAPPDATA: pathApi.join(absoluteRoot, "local-appdata"),
    MOSS_HOME: mossHome,
    MOSS_DESKTOP_USER_DATA_DIR: electronUserDataPath,
    DPCODE_HOME: mossHome,
    T3CODE_HOME: mossHome,
    CODEX_HOME: sourceCodexHome,
    PATH: systemPathEntries.join(pathApi.delimiter),
    MOSS_PACKAGED_SMOKE_GLOBAL_CODEX_TRAP: globalCodexTrapPath,
    T3CODE_DISABLE_AUTO_UPDATE: "1",
    MOSS_DISABLE_AUTO_UPDATE: "1",
  });
  return {
    env,
    home,
    mossHome,
    sourceCodexHome,
    expectedEffectiveCodexHome,
    pathTrapDir,
    globalCodexTrapPath,
    databasePath: pathApi.join(mossHome, "userdata", "state.sqlite"),
    electronUserDataPath,
  };
}
