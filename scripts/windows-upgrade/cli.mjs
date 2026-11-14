// FILE: scripts/windows-upgrade/cli.mjs
// Purpose: Run read-only host evidence or explicitly authorized owned UI/NSIS fixtures.
// Layer: release validation tooling
// Exports: runCapabilities; direct CLI never installs Moss
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { cleanEnvironment, fixtureContract, runnerContract, windowsPath } from "./core.mjs";
import { OwnedProcesses } from "./owned.mjs";

const script = fileURLToPath(new URL("./native-capability.ps1", import.meta.url));
const fixture = fileURLToPath(new URL("./fixture-window.ps1", import.meta.url));
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function profileEnvironment(root) {
  const profile = path.win32.join(root, "profile");
  return {
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: `${profile}\\Roaming`,
    LOCALAPPDATA: `${profile}\\Local`,
    TEMP: `${profile}\\Temp`,
    TMP: `${profile}\\Temp`,
    MOSS_HOME: `${profile}\\moss-home`,
    MOSS_DESKTOP_USER_DATA_DIR: `${profile}\\moss-desktop`,
    CODEX_HOME: `${profile}\\codex`,
    CLAUDE_CONFIG_DIR: `${profile}\\claude`,
  };
}

export async function runCapabilities({
  mode,
  root,
  optIn,
  env,
  platform,
  launch,
  timeoutMs = 15_000,
  signal,
}) {
  runnerContract(env, platform);
  if (!["host", "fixtures"].includes(mode)) throw new Error("Mode must be host or fixtures");
  root = windowsPath(root);
  const isolated = profileEnvironment(root);
  const childEnv = cleanEnvironment(env, isolated);
  for (const key of ["ImageVersion", "RUNNER_TEMP"]) if (env[key]) childEnv[key] = env[key];
  const owner = new OwnedProcesses(launch, childEnv, { timeoutMs });
  const report = {
    status: "failed",
    stage: "host",
    scope: mode === "host" ? "read-only-host-evidence" : "owned-fixtures-only",
    results: [],
  };
  report.scriptHashes = {};
  for (const name of [
    "cli.mjs",
    "core.mjs",
    "owned.mjs",
    "native-capability.ps1",
    "fixture-window.ps1",
  ]) {
    report.scriptHashes[name] = createHash("sha256")
      .update(await fs.readFile(new URL(name, import.meta.url)))
      .digest("hex");
  }
  let cleaning = false;
  async function helper(action, args = []) {
    if (!cleaning && signal?.aborted) throw new Error("Capabilities aborted");
    const record = owner.start(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Mode",
        action,
        ...args,
      ],
      { protocol: true },
    );
    const result = await owner.wait(record, timeoutMs, cleaning ? undefined : signal);
    if (!record.createdAt || !result) throw new Error("Incomplete native helper protocol");
    return result;
  }
  const inspect = async (pid) => (await helper("identity", ["-TargetPid", String(pid)])).identity;
  const ui = async (record, action, button) =>
    helper(action, [
      "-TargetPid",
      String(record.pid),
      "-CreatedAt",
      record.createdAt,
      "-Executable",
      record.executable,
      ...(button ? ["-Button", button] : []),
    ]);
  async function waitWindow(record, title) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Capabilities aborted");
      if (record.exited) throw new Error("Fixture exited before window verification");
      try {
        last = await ui(record, "window");
        if (last.status === "passed" && (!title || last.title === title)) return last;
      } catch {
        /* Retry only within the stage deadline; every helper is directly owned. */
      }
      await delay(100);
    }
    throw new Error("Owned window deadline exceeded");
  }
  async function perform() {
    const observation = await helper("host");
    if (observation.status !== "observed" || observation.scope !== "read-only-host-evidence")
      throw new Error("Invalid host evidence");
    report.host = observation.host;
    if (mode === "host") {
      report.status = "observed";
      return report;
    }
    report.stage = "fixture-gate";
    fixtureContract({ optIn, host: observation.host, root, profile: isolated.USERPROFILE });
    if (!Number.isFinite(observation.host.freeBytes) || observation.host.freeBytes < 2 * 1024 ** 3)
      throw new Error("Insufficient fixture disk space");
    report.stage = "fixture-paths";
    await helper("paths", ["-CheckPath", root]);
    // Nonrecursive mkdir fails if the selected root already exists. Never overwrite/reuse.
    await fs.mkdir(root);
    await helper("paths", ["-CheckPath", root]);
    for (const directory of new Set(Object.values(isolated))) {
      await helper("paths", ["-CheckPath", directory]);
      await fs.mkdir(directory, { recursive: true });
      await helper("paths", ["-CheckPath", directory]);
    }
    await helper("paths", ["-CheckPath", fixture]);
    report.stage = "window";
    const window = owner.start(
      powershell,
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", fixture],
      { protocol: true },
    );
    const helloDeadline = Date.now() + timeoutMs;
    while (!window.createdAt && !window.exited && Date.now() < helloDeadline) {
      if (signal?.aborted) throw new Error("Capabilities aborted");
      await delay(25);
    }
    if (!window.createdAt) throw new Error("Fixture window identity handshake unavailable");
    await waitWindow(window, "Moss fixture ready");
    await ui(window, "invoke", "Probe action");
    await waitWindow(window, "Moss fixture invoked");
    await ui(window, "close");
    await owner.wait(window, timeoutMs, signal);
    report.results.push({ capability: "window", status: "passed" });
    report.stage = "nsis-compile";
    const compiler = "C:\\Program Files (x86)\\NSIS\\makensis.exe";
    await helper("paths", ["-CheckPath", compiler]);
    const source = path.win32.join(root, "fixture.nsi");
    const binary = path.win32.join(root, "fixture.exe");
    await helper("paths", ["-CheckPath", source]);
    await helper("paths", ["-CheckPath", binary]);
    await fs.writeFile(
      source,
      `Unicode true\nName "Moss fixture"\nOutFile "${binary}"\nRequestExecutionLevel user\nPage instfiles\nSection\n DetailPrint "No application installation performed"\nSectionEnd\n`,
      { encoding: "utf8", flag: "wx" },
    );
    const compile = owner.start(compiler, ["/V1", source]);
    if (!compile.exited) owner.enroll(compile, await inspect(compile.pid));
    await owner.wait(compile, timeoutMs, signal);
    await helper("paths", ["-CheckPath", binary]);
    report.fixtureSha256 = createHash("sha256")
      .update(await fs.readFile(binary))
      .digest("hex");
    report.stage = "nsis";
    const nsis = owner.start(binary, []);
    owner.enroll(nsis, await inspect(nsis.pid));
    await waitWindow(nsis);
    await ui(nsis, "invoke", "Close");
    await owner.wait(nsis, timeoutMs, signal);
    report.results.push({ capability: "nsis", status: "passed" });
    report.status = "passed";
    report.stage = "completed";
    return report;
  }
  try {
    await perform();
  } catch {
    report.status = "failed";
    report.failedStage = report.stage;
  }
  cleaning = true;
  // Helpers do not spawn children. Every record belongs to this Node process.
  try {
    await owner.cleanup(inspect, (record) => ui(record, "close"));
    report.cleanup = "complete";
  } catch {
    report.status = "failed";
    report.cleanup = "incomplete";
    report.failedStage ??= report.stage;
    report.stage = "cleanup";
    report.liveProcesses = owner.records
      .filter((record) => !record.exited)
      .map(({ pid, createdAt, executable }) => ({ pid, createdAt, executable }));
  }
  report.ownedProcesses = owner.records.map(({ pid, createdAt, executable, exited }) => ({
    pid,
    createdAt,
    executable,
    exited,
  }));
  if (report.status === "failed")
    throw Object.assign(
      new Error(report.cleanup === "complete" ? "Capability stage failed" : "Cleanup incomplete"),
      { report },
    );
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const accepted = new Set(["--mode", "--root", "--opt-in"]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!accepted.has(args[index]) || !args[index + 1])
      throw new Error(
        "Expected --mode host|fixtures --root PATH [--opt-in allow-ephemeral-fixtures]",
      );
    options[args[index].slice(2)] = args[index + 1];
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  runCapabilities({
    mode: options.mode,
    root: options.root,
    optIn: options["opt-in"],
    env: process.env,
    platform: process.platform,
    launch: spawn,
    signal: controller.signal,
  })
    .then(
      (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
      (error) => {
        process.stderr.write(
          `${JSON.stringify(error.report ?? { status: "failed", stage: "guard", scope: "capabilities-only", detail: "Capability guard failed before native work" })}\n`,
        );
        process.exitCode = 1;
      },
    )
    .finally(() => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    });
}
