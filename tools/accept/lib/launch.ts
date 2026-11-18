// FILE: launch.ts
// Purpose: Start a Moss build for acceptance the way a person would get it (the packaged app,
//          not a development build), but in a profile of its own: every home, app-data and Moss
//          folder points inside the run folder (scripts/verify-packaged-desktop-startup.ts), so the
//          owner's profile, sign-ins and data are never read or written. MOSS_SELF_REPORT=1 plus
//          that isolated profile is what turns Moss's self-report tools on in a packaged build.
//          The debugging port listens on 127.0.0.1 only. The window is moved off-screen unless
//          asked otherwise, so a tour never covers what the owner is doing.
// Layer: tools/accept

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { createPackagedDesktopSmokeEnvironment } from "../../../scripts/verify-packaged-desktop-startup.ts";
import { KNOWN_SELF_REPORT_VERSIONS } from "./tour.ts";
import { startWindowMover, windowsOf } from "./window.ts";

/** Switches every acceptance run passes (CalculateNativeWinOcclusion: keep painting off-screen). */
export const APP_ARGS = (port: number) => [
  `--remote-debugging-port=${port}`,
  "--remote-debugging-address=127.0.0.1",
  "--no-proxy-server",
  "--disable-features=CalculateNativeWinOcclusion",
];

export interface LaunchOptions {
  /** The packaged executable (Moss.exe, or the binary inside Moss.app/Contents/MacOS). */
  readonly app: string;
  /** The run's folder; the isolated profile goes in `<runDir>/profile`. */
  readonly runDir: string;
  readonly onScreen?: boolean;
  readonly startTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface LaunchedMoss {
  readonly child: ChildProcess;
  readonly browser: Browser;
  readonly page: Page;
  readonly port: number;
  readonly selfReportVersion: number;
  readonly profileRoot: string;
  /** Throws when a window of this run intersects a display (and moves it off). */
  assertOffScreen(when: string): void;
  close(): Promise<void>;
}

export class LaunchError extends Error {}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function platform(): "win" | "mac" | "linux" {
  return process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
}

/** Environment of the isolated run: the packaged-startup smoke's isolation plus the self-report switch. */
/**
 * The only names a test copy inherits from the session: the OS basics a Windows or POSIX process
 * needs. Never the rest: a session's environment can hold CLAUDE_*, ANTHROPIC_*, OPENAI_*, GH_* and
 * GITHUB_* values, provider keys and proxy settings, and a "signed-out" copy must not run with them.
 */
export const INHERITED_NAMES = [
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PATHEXT",
] as const;

const MINIMAL_PATH =
  process.platform === "win32" ? "C:/Windows/System32;C:/Windows" : "/usr/bin:/bin";

/** Environment of the isolated run: an allow-list, the packaged-startup isolation and the switches. */
export function acceptanceEnvironment(
  profileRoot: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { PATH: MINIMAL_PATH };
  for (const name of INHERITED_NAMES)
    if (inherited[name] !== undefined) base[name] = inherited[name];
  const env = createPackagedDesktopSmokeEnvironment(
    profileRoot,
    { platform: platform(), version: "acceptance", executableName: "moss" },
    base,
  );
  env.MOSS_SELF_REPORT = "1";
  // Nothing outside the run folder may change (incident 2026-11-18: without the first switch each
  // packaged run pointed the owner's moss:// and moss-connectors:// handlers at the test copy).
  env.MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION = "1";
  // Builds with #704 create every window off-screen themselves; older builds ignore it and the
  // Win32 mover (window.ts) keeps guarding either way.
  env.MOSS_SELF_REPORT_WINDOW = "offscreen";
  env.MOSS_DISABLE_SHORTCUT_ICON_SYNC = "1";
  env.MOSS_DISABLE_PROVIDER_UPDATES = "1";
  env.CLAUDE_CONFIG_DIR = path.join(profileRoot, "claude");
  env.CODEX_SQLITE_HOME = env.CODEX_HOME;
  env.TEMP = path.join(profileRoot, "tmp");
  env.TMP = env.TEMP;
  env.NO_PROXY = "*";
  env.NODE_USE_ENV_PROXY = "0";
  for (const dir of [env.CLAUDE_CONFIG_DIR, env.TEMP]) fs.mkdirSync(dir, { recursive: true });
  if (!env.MOSS_DESKTOP_USER_DATA_DIR) throw new LaunchError("no isolated user data folder");
  return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(port: number, deadline: number): Promise<Browser> {
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    } catch (error) {
      last = error;
      await sleep(500);
    }
  }
  throw new LaunchError(`could not reach the debugging port ${port}: ${String(last)}`);
}

/** The app window: the page that installs `window.mossSelfReport` (moss:// in packaged builds). */
async function appPage(
  browser: Browser,
  deadline: number,
): Promise<{ page: Page; version: number }> {
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const version = await page
          .evaluate(
            () => (window as { mossSelfReport?: { version: number } }).mossSelfReport?.version,
          )
          .catch(() => undefined);
        if (typeof version === "number") return { page, version };
      }
    }
    await sleep(500);
  }
  throw new LaunchError(
    "no Moss window offered the self-report tools in time (is this build older than #692, or not started with an isolated profile?)",
  );
}

/** Resolves with the promise's value, or with `fallback` once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

const firstLine = (error: unknown) =>
  error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);

/** PIDs of processes whose command line names `dir` (this run's own profile folder). */
export function processesUsing(dir: string): number[] {
  if (process.platform === "win32") {
    const needle = dir.replace(/'/g, "''");
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    return (r.stdout ?? "")
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  }
  const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 30_000 });
  return (r.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(dir))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

function stopPid(pid: number): void {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { timeout: 15_000 });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function launchMoss(options: LaunchOptions): Promise<LaunchedMoss> {
  const log = options.log ?? (() => {});
  if (!fs.existsSync(options.app)) throw new LaunchError(`no app at ${options.app}`);
  if (options.onScreen && process.env.MOSS_ACCEPT_ON_SCREEN !== "owner-approved")
    throw new LaunchError(
      "--on-screen needs MOSS_ACCEPT_ON_SCREEN=owner-approved, which only the lead sets for an acceptance the owner agreed to",
    );
  const profileRoot = path.join(options.runDir, "profile");
  fs.mkdirSync(profileRoot, { recursive: true });
  const env = acceptanceEnvironment(profileRoot);
  const port = await freePort();
  const logFile = fs.openSync(path.join(options.runDir, "app-output.log"), "a");
  // The mover runs before the app exists, so not even its first window reaches the screen for long.
  const mover = options.onScreen ? undefined : await startWindowMover(options.runDir, log);
  const child = spawn(options.app, APP_ARGS(port), {
    env,
    stdio: ["ignore", logFile, logFile],
    windowsHide: false,
    detached: false,
  });
  if (child.pid) mover?.attach(child.pid);
  log(
    `started ${path.basename(options.app)} pid ${child.pid}, profile ${profileRoot}, port ${port}`,
  );
  const deadline = Date.now() + (options.startTimeoutMs ?? 90_000);
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? -1;
  });
  const close = async () => {
    // Disconnecting does not quit Electron. Ask it to close its windows (Moss then quits and
    // stops its backend itself), wait, and only then stop our own PID, never a process tree.
    if (browserRef && exited === null) {
      // Not awaited to the end: a quitting app never answers Browser.close (measured 11-18: the
      // run waited until its hard limit after Moss had shut down cleanly).
      const ask = (async () => {
        const session = await browserRef!.newBrowserCDPSession();
        await session.send("Browser.close");
      })().catch(() => {
        // the connection may already be gone
      });
      await within(ask, 3_000, undefined);
      // Moss stops its backend first (5-7 s measured on 11-18), then quits.
      for (let i = 0; i < 120 && exited === null; i += 1) await sleep(250);
    }
    // Playwright's close can wait forever on a connection whose browser has already gone.
    if (browserRef)
      await within(
        browserRef.close().catch(() => {}),
        5_000,
        undefined,
      );
    if (exited === null && child.pid) {
      log(`the app did not quit in 30 s; stopping pid ${child.pid}`);
      child.kill();
      for (let i = 0; i < 40 && exited === null; i += 1) await sleep(250);
    }
    // Electron's helpers (renderer, GPU, utility) can outlive the main process for a moment; each
    // carries this run's own --user-data-dir, so only they match. Give them 10 s, then stop each
    // one by its PID (never a tree: other programs may have reused a parent PID).
    const userData = env.MOSS_DESKTOP_USER_DATA_DIR!;
    let left = processesUsing(userData);
    for (let i = 0; i < 20 && left.length > 0; i += 1) {
      await sleep(500);
      left = processesUsing(userData);
    }
    for (const pid of left) {
      log(`stopping helper pid ${pid} (still using this run's profile)`);
      stopPid(pid);
    }
    mover?.stop();
    fs.closeSync(logFile);
  };
  const assertOffScreen = (when: string) => {
    if (options.onScreen || !child.pid) return;
    const visible = windowsOf(child.pid, true).filter((w) => w.onScreen);
    if (visible.length > 0)
      throw new LaunchError(
        `a Moss window was on the screen ${when}: ${visible.map((w) => `pid ${w.pid} at ${w.left},${w.top}`).join("; ")}`,
      );
  };
  let browserRef: Browser | undefined;
  try {
    const browser = await connect(port, deadline);
    browserRef = browser;
    if (exited !== null) throw new LaunchError(`the app exited with ${exited} during start`);
    const { page, version } = await appPage(browser, deadline);
    if (!(KNOWN_SELF_REPORT_VERSIONS as readonly number[]).includes(version))
      throw new LaunchError(
        `self-report version ${version} is not one this kit knows (${KNOWN_SELF_REPORT_VERSIONS.join(", ")})`,
      );
    if (options.onScreen)
      log(`connected: self-report version ${version}; window on-screen as asked`);
    else {
      assertOffScreen("after start");
      const where = windowsOf(child.pid!)
        .map((w) => `${w.left},${w.top}`)
        .join(" ");
      log(
        `connected: self-report version ${version}; windows off every display (${where || "none visible"})`,
      );
    }
    return {
      child,
      browser,
      page,
      port,
      selfReportVersion: version,
      profileRoot,
      assertOffScreen,
      close,
    };
  } catch (error) {
    log(`start failed: ${firstLine(error)}`);
    await close();
    throw error;
  }
}
