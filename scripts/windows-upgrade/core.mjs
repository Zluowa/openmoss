// FILE: scripts/windows-upgrade/core.mjs
// Purpose: Fail closed around untrusted runner capabilities and bounded RPCs.
// Layer: release validation tooling
// Exports: runnerContract, bounded, preflight, cleanEnvironment, sameProcess
import path from "node:path";

export function runnerContract(env, platform) {
  if (
    platform !== "win32" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    env.ImageOS !== "win22" ||
    env.GITHUB_REPOSITORY !== "Zluowa/openmoss"
  ) {
    throw new Error("Only the public mirror's hosted windows-2022 VM is allowed");
  }
}

// Host facts must come from the native adapter, never from environment variables.
export function windowsPath(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z]:[\\/]/i.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[<>"|?*]/.test(value) ||
    value.slice(2).includes(":")
  ) {
    throw new Error("Ordinary drive-absolute Windows path required");
  }
  const segments = value.slice(3).split(/[\\/]/);
  if (segments.some((part) => part === "." || part === ".." || /[. ]$/.test(part))) {
    throw new Error("Noncanonical Windows path rejected");
  }
  return path.win32.resolve(value).toLowerCase();
}

export function containedPath(parent, child) {
  const base = windowsPath(parent);
  const candidate = windowsPath(child);
  const relative = path.win32.relative(base, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.win32.isAbsolute(relative);
}

export function installationContract({ optIn, host, root, profile }) {
  if (optIn !== "allow-ephemeral-nsis-install") throw new Error("Explicit install opt-in required");
  return fixtureContract({ optIn: "allow-ephemeral-fixtures", host, root, profile });
}

export function fixtureContract({ optIn, host, root, profile }) {
  if (optIn !== "allow-ephemeral-fixtures") throw new Error("Explicit fixture opt-in required");
  if (
    host.manufacturer !== "Microsoft Corporation" ||
    host.model !== "Virtual Machine" ||
    host.userName?.toLowerCase() !== "runneradmin" ||
    host.osBuild !== "20348" ||
    host.osProductType !== 3 ||
    !Number.isInteger(host.sessionId) ||
    host.sessionId <= 0 ||
    !host.runnerImageVersion ||
    !host.runnerServicePath?.toLowerCase().startsWith("c:\\actions\\")
  ) {
    throw new Error("Native hosted Windows Server 2022 identity required");
  }
  const base = windowsPath(host.runnerTemp);
  if (
    !/^d:\\a\\_temp$/.test(base) ||
    !containedPath(base, root) ||
    path.win32.dirname(windowsPath(root)) !== base ||
    !/^moss-upgrade-[a-z0-9-]+$/.test(path.win32.basename(windowsPath(root))) ||
    !containedPath(root, profile) ||
    /\\\.moss(?:\\|$)/i.test(`${root} ${profile}`)
  ) {
    throw new Error("Isolated runner temporary paths required");
  }
}

export async function bounded(label, milliseconds, operation) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label}: timeout`));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function cleanEnvironment(env, isolated) {
  const result = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
  ]) {
    const actual = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
    if (actual) result[name] = env[actual];
  }
  const required = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "MOSS_HOME",
    "MOSS_DESKTOP_USER_DATA_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ];
  for (const key of required) windowsPath(isolated[key]);
  const profile = windowsPath(isolated.USERPROFILE);
  for (const key of required) {
    if (windowsPath(isolated[key]) !== profile && !containedPath(profile, isolated[key])) {
      throw new Error("All child profile paths must stay inside the isolated profile");
    }
  }
  const system = windowsPath(result.SystemRoot);
  if (system !== "c:\\windows") throw new Error("Unexpected system root");
  // Explicit executables are required for everything beyond native system tools.
  return {
    ...result,
    PATH: `${system}\\System32;${system};${system}\\System32\\Wbem`,
    ...Object.fromEntries(required.map((key) => [key, isolated[key]])),
    MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION: "1",
    MOSS_DISABLE_SHELL_ENVIRONMENT_SYNC: "1",
    MOSS_DISABLE_SHORTCUT_ICON_SYNC: "1",
    MOSS_DISABLE_PROVIDER_UPDATES: "1",
  };
}

export function sameProcess(recorded, observed) {
  return (
    Number.isInteger(recorded.pid) &&
    recorded.pid > 0 &&
    recorded.pid === observed?.pid &&
    Boolean(recorded.createdAt) &&
    recorded.createdAt === observed.createdAt &&
    Boolean(recorded.executable) &&
    recorded.executable.toLowerCase() === observed.executable?.toLowerCase()
  );
}

export async function preflight(driver, { timeoutMs = 30_000 } = {}) {
  const results = [];
  try {
    for (const capability of ["host", "window", "nsis"]) {
      const result = await bounded(capability, timeoutMs, (signal) =>
        driver.probe(capability, signal),
      );
      if (result?.status !== "passed") throw new Error(`${capability}: capability unavailable`);
      results.push({ capability, status: "passed" });
    }
    return { status: "passed", scope: "runner-capabilities-only", results };
  } finally {
    await bounded("owned-process-cleanup", timeoutMs, (signal) => driver.cleanup(signal));
  }
}

export async function installedCdp(driver, installation, { timeoutMs = 30_000 } = {}) {
  if (installation?.status !== "installed" || !installation.originalBytesVerified) {
    throw new Error("Original initial installation must be verified before CDP");
  }
  const result = await bounded("installed-cdp", timeoutMs, (signal) => driver.probe("cdp", signal));
  if (result?.status !== "passed") throw new Error("installed-cdp: capability unavailable");
  return { status: "passed", scope: "installed-original-cdp-only" };
}
