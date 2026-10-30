// FILE: moss-startup-smoke.ts
// Purpose: Run a repeatable, isolated Moss startup smoke with Sentry enabled.
// Layer: Development/release verification
// Depends on: dev:server, dev:web, and the startup regression test contract.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(fileURLToPath(import.meta.url), "../.."));
const startupTestFiles = [
  "scripts/dev-runner.test.ts",
  "scripts/verify-packaged-desktop-startup.test.ts",
  "apps/server/src/startupAccess.test.ts",
  "apps/server/src/wsRpc.startupGate.test.ts",
  "apps/server/src/orchestration/startupTurnReconciliation.test.ts",
  "apps/server/src/agentGateway/startupRecovery.test.ts",
  "packages/shared/src/observability.test.ts",
];
const startupTimeoutMs = 90_000;
const requestTimeoutMs = 5_000;
const defaultPortOffset = 237;
const proxyEnvironmentNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

type SmokeChild = ChildProcess & { readonly smokeLabel: string };

let activeChildren: SmokeChild[] | undefined;
let activeHomeDir: string | undefined;
let cleanupPromise: Promise<void> | undefined;

function log(message: string): void {
  console.log(`[moss-startup-smoke] ${message}`);
}

function parsePortOffset(): number {
  const raw = process.env.MOSS_STARTUP_PORT_OFFSET?.trim();
  const offset = raw ? Number(raw) : defaultPortOffset;
  if (!Number.isInteger(offset) || offset < 1 || offset > 3_000) {
    throw new Error("MOSS_STARTUP_PORT_OFFSET must be an integer between 1 and 3000.");
  }
  return offset;
}

async function canBind(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, host, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function selectPortOffset(startOffset: number): Promise<number> {
  for (let offset = startOffset; offset <= 3_000; offset += 1) {
    const [serverAvailable, webAvailable] = await Promise.all([
      canBind(3_773 + offset, "127.0.0.1"),
      canBind(5_733 + offset, "::1"),
    ]);
    if (serverAvailable && webAvailable) return offset;
  }
  throw new Error(`No available startup-smoke port pair from offset ${startOffset}.`);
}

function assertSentryEnvironment(): void {
  const requiredNames = [
    "MOSS_SENTRY_DSN",
    "VITE_SENTRY_DSN",
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
  ] as const;
  const missing = requiredNames.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Sentry environment is incomplete (${missing.join(", ")}). Run this command through ` +
        "bun --env-file=.env run moss:startup-smoke.",
    );
  }
  log(`Sentry configuration present: ${requiredNames.join(", ")}`);
}

function spawnSmokeChild(
  label: string,
  scriptName: "dev:server" | "dev:web",
  homeDir: string,
  portOffset: number,
  baseEnvironment: NodeJS.ProcessEnv,
): SmokeChild {
  const child = spawn(
    "bun",
    ["--env-file=.env", "run", scriptName, "--", "--home-dir", homeDir, "--no-browser"],
    {
      cwd: repoRoot,
      detached: true,
      env: {
        ...baseEnvironment,
        MOSS_HOME: homeDir,
        MOSS_NO_BROWSER: "1",
        MOSS_PORT_OFFSET: String(portOffset),
        MOSS_STARTUP_SMOKE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as SmokeChild;
  Object.defineProperty(child, "smokeLabel", { value: label });

  const forward = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString().replace(/\r/g, "");
    for (const line of text.split("\n")) {
      if (line.trim()) console[stream === "stderr" ? "error" : "log"](`[${label}] ${line}`);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => forward(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => forward(chunk, "stderr"));
  return child;
}

async function waitForExitOrTimeout(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(timeoutMs),
  ]);
}

async function stopSmokeChild(child: SmokeChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (typeof pid !== "number") return;
  try {
    process.kill(-pid, "SIGINT");
  } catch {
    child.kill("SIGINT");
  }
  await waitForExitOrTimeout(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await waitForExitOrTimeout(child, 1_000);
  }
}

function cleanupActiveSmoke(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const child of [...(activeChildren ?? [])].reverse()) await stopSmokeChild(child);
    if (activeHomeDir) rmSync(activeHomeDir, { recursive: true, force: true });
    activeChildren = undefined;
    activeHomeDir = undefined;
    log("Cleaned isolated startup state and stopped smoke processes.");
  })();
  return cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanupActiveSmoke().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

interface LocalHttpResponse {
  readonly status: number;
  readonly body: string;
}

async function requestLocalHttp(url: string): Promise<LocalHttpResponse> {
  return await new Promise<LocalHttpResponse>((resolvePromise, rejectPromise) => {
    const marker = "\n__MOSS_STARTUP_HTTP_STATUS__=";
    const child = spawn(
      "curl",
      [
        "--noproxy",
        "*",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "2",
        "--max-time",
        String(Math.ceil(requestTimeoutMs / 1_000)),
        "--write-out",
        `${marker}%{http_code}`,
        url,
      ],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      const output = Buffer.concat(stdout).toString();
      const markerIndex = output.lastIndexOf(marker);
      const status = markerIndex >= 0 ? Number(output.slice(markerIndex + marker.length)) : 0;
      const body = markerIndex >= 0 ? output.slice(0, markerIndex) : output;
      if (code !== 0 || !Number.isInteger(status) || status <= 0) {
        rejectPromise(
          new Error(
            stderr.length > 0
              ? Buffer.concat(stderr).toString().trim()
              : `curl exit ${String(code)}`,
          ),
        );
        return;
      }
      resolvePromise({ status, body });
    });
  });
}

async function waitForHttp(
  url: string,
  predicate: (response: LocalHttpResponse, body: string) => boolean,
) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await requestLocalHttp(url);
      const body = response.body;
      if (predicate(response, body)) return { response, body };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url} (${lastError}).`);
}

async function runFocusedTests(): Promise<void> {
  log(`Running ${startupTestFiles.length} startup test files with Vitest.`);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const testProcess = spawn("bunx", ["vitest", "run", ...startupTestFiles], {
      cwd: repoRoot,
      env: { ...process.env, MOSS_STARTUP_SMOKE: "1" },
      stdio: "inherit",
    });
    testProcess.once("error", rejectPromise);
    testProcess.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Startup tests exited with ${signal ?? `code ${String(code)}`}.`));
      }
    });
  });
}

async function verifyExistingDesktop(): Promise<void> {
  try {
    const { body } = await requestLocalHttp("http://127.0.0.1:9333/json/list");
    const targets = JSON.parse(body) as Array<{ title?: string; url?: string }>;
    const mossTarget = targets.find(
      (target) => target.title === "Moss (Dev)" || target.url?.startsWith("http://localhost:5733"),
    );
    if (!mossTarget) {
      throw new Error("CDP is reachable but no Moss (Dev) renderer target was found.");
    }
    log(
      `Electron renderer verified through CDP: ${mossTarget.title ?? mossTarget.url ?? "Moss (Dev)"}.`,
    );
    return;
  } catch (error) {
    if (process.platform !== "darwin") {
      log(`Electron CDP check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const electronPattern = `${repoRoot}/apps/desktop/.electron-runtime/Moss \\(Dev\\)\\.app/Contents/MacOS/Electron`;
    const pids = execFileSync("pgrep", ["-f", electronPattern], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    for (const electronPid of pids) {
      const children = execFileSync("pgrep", ["-P", String(electronPid)], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      for (const childPid of children) {
        const command = execFileSync("ps", ["-p", String(childPid), "-o", "args="], {
          encoding: "utf8",
        });
        if (!command.includes("/apps/server/dist/index.mjs")) continue;
        const listeners = execFileSync(
          "lsof",
          ["-nP", "-a", "-p", String(childPid), "-iTCP", "-sTCP:LISTEN"],
          { encoding: "utf8" },
        );
        const port = listeners.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/)?.[1];
        if (!port) continue;
        const health = await requestLocalHttp(`http://127.0.0.1:${port}/health`);
        const payload = JSON.parse(health.body) as Record<string, unknown>;
        if (
          health.status === 200 &&
          payload.status === "ok" &&
          payload.startupReady === true &&
          (payload.projection as Record<string, unknown> | undefined)?.state === "healthy"
        ) {
          log(`Electron process/server verified without CDP: PID ${electronPid}, health HTTP 200.`);
          return;
        }
      }
    }
    log(`Electron check skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  assertSentryEnvironment();
  const requestedPortOffset = parsePortOffset();
  const portOffset = await selectPortOffset(requestedPortOffset);
  const serverPort = 3_773 + portOffset;
  const webPort = 5_733 + portOffset;
  const homeDir = mkdtempSync(join(tmpdir(), "moss-startup-smoke-"));
  const childEnvironment = { ...process.env };
  // Bun's node:http adapter honors the inherited proxy even for [::1]. The
  // smoke must probe local loopback directly, while child runtimes retain the
  // normal proxy configuration they use for provider/network access.
  for (const name of proxyEnvironmentNames) delete process.env[name];
  const children: SmokeChild[] = [];
  activeChildren = children;
  activeHomeDir = homeDir;
  log(
    `Isolated home=${homeDir} serverPort=${serverPort} webPort=${webPort}` +
      (portOffset === requestedPortOffset
        ? ""
        : ` (requested offset ${requestedPortOffset} was busy)`),
  );

  try {
    children.push(spawnSmokeChild("server", "dev:server", homeDir, portOffset, childEnvironment));
    children.push(spawnSmokeChild("web", "dev:web", homeDir, portOffset, childEnvironment));

    const health = await waitForHttp(`http://127.0.0.1:${serverPort}/health`, (response, body) => {
      if (response.status !== 200) return false;
      const payload = JSON.parse(body) as Record<string, unknown>;
      return (
        payload.status === "ok" &&
        payload.startupReady === true &&
        payload.accountStartupState === "ready" &&
        payload.pushBusReady === true &&
        (payload.projection as Record<string, unknown> | undefined)?.state === "healthy"
      );
    });
    log(
      `Server health passed: HTTP ${health.response.status}, startupReady=true, projection=healthy.`,
    );

    const web = await waitForHttp(`http://[::1]:${webPort}/`, (response, body) => {
      return response.status === 200 && body.includes("<!doctype html>");
    });
    log(`Web dev server passed: HTTP ${web.response.status}, HTML shell served.`);

    // The HTML shell can be healthy while the first renderer modules are
    // blocked by dependency optimization or a transform-time exception. Probe
    // the actual bootstrap entries so the smoke catches the blank/spinner
    // failure that Electron users see, not just a listening Vite port.
    for (const modulePath of ["/src/main.tsx", "/src/bootstrap.ts"]) {
      const module = await waitForHttp(`http://[::1]:${webPort}${modulePath}`, (response, body) => {
        return (
          response.status === 200 && body.length > 100 && !body.includes("Internal server error")
        );
      });
      log(
        `Web module passed: ${modulePath} HTTP ${module.response.status}, ${module.body.length} bytes.`,
      );
    }

    await verifyExistingDesktop();
    await runFocusedTests();
    log("STARTUP_SMOKE_PASS");
  } finally {
    await cleanupActiveSmoke();
  }
}

main().catch((error) => {
  console.error(
    `[moss-startup-smoke] STARTUP_SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
