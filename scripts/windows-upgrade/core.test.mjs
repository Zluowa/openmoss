// FILE: scripts/windows-upgrade/core.test.mjs
// Purpose: Check capability failures cannot become a successful upgrade result.
// Layer: release validation tests
// Exports: none
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  bounded,
  cleanEnvironment,
  containedPath,
  installedCdp,
  installationContract,
  preflight,
  runnerContract,
  sameProcess,
  windowsPath,
} from "./core.mjs";

test("installation requires native identity, opt-in and isolated runner paths", () => {
  const fixture = {
    optIn: "allow-ephemeral-nsis-install",
    host: {
      manufacturer: "Microsoft Corporation",
      model: "Virtual Machine",
      userName: "runneradmin",
      osBuild: "20348",
      osProductType: 3,
      sessionId: 1,
      runnerImageVersion: "fixture",
      runnerServicePath: "C:\\actions\\runner.exe",
      runnerTemp: "D:\\a\\_temp",
    },
    root: "D:\\a\\_temp\\moss-upgrade-fixture",
    profile: "D:\\a\\_temp\\moss-upgrade-fixture\\profile",
  };
  assert.doesNotThrow(() => installationContract(fixture));
  for (const patch of [
    { optIn: undefined },
    { root: "C:\\Users\\owner\\test" },
    { root: "D:\\a\\_temp\\moss-upgrade-$TEMP" },
    { profile: "C:\\Users\\runneradmin\\.moss" },
    { host: { ...fixture.host, sessionId: 0 } },
    { host: { ...fixture.host, userName: "owner" } },
    { host: { ...fixture.host, osBuild: "26100" } },
  ])
    assert.throws(() => installationContract({ ...fixture, ...patch }));
});

test("refuses local, private and mismatched images before launch", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    ImageOS: "win22",
    GITHUB_REPOSITORY: "Zluowa/openmoss",
  };
  assert.doesNotThrow(() => runnerContract(env, "win32"));
  for (const changed of [
    { GITHUB_REPOSITORY: "Zluowa/moss-synara" },
    { ImageOS: "win25" },
    { RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_ACTIONS: "false" },
  ]) {
    assert.throws(() => runnerContract({ ...env, ...changed }, "win32"));
  }
  assert.throws(() => runnerContract(env, "linux"));
});

test("capability success is scoped and cleanup runs", async () => {
  const seen = [];
  const result = await preflight({
    probe: async (name) => {
      seen.push(name);
      return { status: "passed" };
    },
    cleanup: async () => seen.push("cleanup"),
  });
  assert.deepEqual(seen, ["host", "window", "nsis", "cleanup"]);
  assert.equal(result.scope, "runner-capabilities-only");
});

test("skip, missing and failure are red and always clean owned resources", async () => {
  for (const status of ["skipped", "failed", undefined]) {
    let cleaned = false;
    await assert.rejects(
      preflight({
        probe: async () => ({ status }),
        cleanup: async () => {
          cleaned = true;
        },
      }),
    );
    assert.equal(cleaned, true);
  }
});

test("RPC timeout aborts and cleanup still runs", async () => {
  let aborted = false;
  let cleaned = false;
  await assert.rejects(
    preflight(
      {
        probe: (_, signal) =>
          new Promise(() =>
            signal.addEventListener("abort", () => {
              aborted = true;
            }),
          ),
        cleanup: async () => {
          cleaned = true;
        },
      },
      { timeoutMs: 5 },
    ),
    /timeout/,
  );
  assert.equal(aborted, true);
  assert.equal(cleaned, true);
  await assert.rejects(
    bounded("closed-rpc", 20, async () => {
      throw new Error("RPC closed");
    }),
    /RPC closed/,
  );
});

test("cleanup requires PID, creation identity and executable", () => {
  const identity = { pid: 123, createdAt: "fixed", executable: "C:\\fixture.exe" };
  assert.equal(sameProcess(identity, { ...identity }), true);
  for (const changed of [{ pid: 124 }, { createdAt: "reused" }, { executable: "C:\\other.exe" }])
    assert.equal(sameProcess(identity, { ...identity, ...changed }), false);
  assert.equal(sameProcess({ ...identity, createdAt: "" }, identity), false);
});

test("child environment drops tokens, account and provider settings", () => {
  const result = cleanEnvironment(
    {
      Path: "C:\\Users\\owner\\npm;C:\\global-tools",
      SystemRoot: "C:\\Windows",
      GH_TOKEN: "synthetic",
      OPENAI_API_KEY: "synthetic",
      ELECTRON_RUN_AS_NODE: "1",
      HOME: "owner",
    },
    {
      HOME: "D:\\fixture",
      USERPROFILE: "D:\\fixture",
      APPDATA: "D:\\fixture\\Roaming",
      LOCALAPPDATA: "D:\\fixture\\Local",
      TEMP: "D:\\fixture\\Temp",
      TMP: "D:\\fixture\\Temp",
      MOSS_HOME: "D:\\fixture\\moss",
      MOSS_DESKTOP_USER_DATA_DIR: "D:\\fixture\\desktop",
      CODEX_HOME: "D:\\fixture\\codex",
      CLAUDE_CONFIG_DIR: "D:\\fixture\\claude",
    },
  );
  assert.deepEqual(result, {
    SystemRoot: "C:\\Windows",
    PATH: "c:\\windows\\System32;c:\\windows;c:\\windows\\System32\\Wbem",
    HOME: "D:\\fixture",
    USERPROFILE: "D:\\fixture",
    APPDATA: "D:\\fixture\\Roaming",
    LOCALAPPDATA: "D:\\fixture\\Local",
    TEMP: "D:\\fixture\\Temp",
    TMP: "D:\\fixture\\Temp",
    MOSS_HOME: "D:\\fixture\\moss",
    MOSS_DESKTOP_USER_DATA_DIR: "D:\\fixture\\desktop",
    CODEX_HOME: "D:\\fixture\\codex",
    CLAUDE_CONFIG_DIR: "D:\\fixture\\claude",
    MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION: "1",
    MOSS_DISABLE_SHELL_ENVIRONMENT_SYNC: "1",
    MOSS_DISABLE_SHORTCUT_ICON_SYNC: "1",
    MOSS_DISABLE_PROVIDER_UPDATES: "1",
  });
  assert.throws(() => cleanEnvironment({ SystemRoot: "C:\\Windows" }, { HOME: "D:\\fixture" }));
});

test("Windows path guard rejects traversal, device, UNC, ADS and sibling prefixes", () => {
  for (const value of [
    "D:\\a\\_temp\\moss-upgrade-x\\..\\outside",
    "D:\\a\\.\\x",
    "\\\\server\\share",
    "\\\\?\\D:\\a",
    "D:\\a:file",
    "D:a",
    "D:\\a.\\b",
    "D:\\a \\b",
  ])
    assert.throws(() => windowsPath(value));
  assert.equal(containedPath("D:\\a\\root", "D:\\a\\root-other\\file"), false);
  assert.equal(containedPath("D:\\a\\root", "E:\\a\\root\\file"), false);
  assert.equal(containedPath("D:\\a\\root", "D:\\a\\root"), false);
  assert.equal(containedPath("D:\\a\\root", "d:/a/root/child"), true);
});

test("CDP is a separate post-install stage and never part of fixture preflight", async () => {
  let calls = 0;
  const driver = {
    probe: async () => {
      calls++;
      return { status: "passed" };
    },
  };
  await assert.rejects(installedCdp(driver, { status: "installed", originalBytesVerified: false }));
  assert.equal(calls, 0);
  assert.equal(
    (await installedCdp(driver, { status: "installed", originalBytesVerified: true })).scope,
    "installed-original-cdp-only",
  );
  assert.equal(calls, 1);
});
