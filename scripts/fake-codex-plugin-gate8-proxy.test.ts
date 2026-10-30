import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

const roots = new Set<string>();
const EXPECTED_PROMPT = "Use the lifecycle fixture to report its deterministic marker.";
const EXPECTED_MENTION = "plugin://moss-plugin-lifecycle-fixture@moss-parity-fixture";

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = read();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for Gate 8 proxy observation"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function readEvents(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeFakeCodex(path: string): void {
  writeFileSync(
    path,
    `#!${process.execPath}
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.147.0\\n");
  process.exit(0);
}
if (process.argv[2] !== "app-server") process.exit(2);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "initialize"
    ? { codexHome: process.env.CODEX_HOME ?? "/fixture/codex-home" }
    : message.method === "plugin/install"
      ? { appsNeedingAuth: [] }
      : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`,
  );
  chmodSync(path, 0o755);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

describe("Gate 8 Codex proxy", () => {
  it.runIf(process.platform === "win32")(
    "refuses an unexecutable POSIX backend without accepting a turn or emitting a marker",
    () => {
      const root = mkdtempSync(join(tmpdir(), "moss-gate8-proxy-win32-"));
      roots.add(root);
      const realCodex = join(root, "real-codex.mjs");
      const eventsPath = join(root, "events.jsonl");
      const statePath = join(root, "state.json");
      writeFakeCodex(realCodex);
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dirname, "fixtures", "fake-codex-plugin-gate8-proxy.mjs"), "app-server"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CODEX_HOME: join(root, "codex-home"),
            MOSS_BUNDLED_CODEX_PATH: realCodex,
            MOSS_GATE8_REAL_CODEX_PATH: realCodex,
            MOSS_GATE8_RUNTIME_EVENTS_PATH: eventsPath,
            MOSS_GATE8_STATE_PATH: statePath,
            MOSS_HOME: join(root, "moss-home"),
            MOSS_MODE: "desktop",
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Error: spawn EFTYPE");
      expect(result.stdout).toBe("");
      // Native Node rejects this file type before any backend-start event can be recorded.
      expect(readEvents(eventsPath)).toEqual([]);
      expect(existsSync(eventsPath)).toBe(false);
      expect(existsSync(statePath)).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "withholds settled mutations and emits a marker only for an attached real turn",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "moss-gate8-proxy-test-"));
      roots.add(root);
      const realCodex = join(root, "real-codex.mjs");
      const eventsPath = join(root, "events.jsonl");
      const statePath = join(root, "state.json");
      writeFakeCodex(realCodex);
      const bundledPathAliasRoot = join(root, "bundled-path-alias");
      mkdirSync(bundledPathAliasRoot);
      const bundledPathAlias = `${bundledPathAliasRoot}${sep}..${sep}real-codex.mjs`;

      const proxyPath = join(import.meta.dirname, "fixtures", "fake-codex-plugin-gate8-proxy.mjs");
      const child = spawn(process.execPath, [proxyPath, "app-server"], {
        env: {
          ...process.env,
          CODEX_HOME: join(root, "codex-home"),
          MOSS_BUNDLED_CODEX_PATH: bundledPathAlias,
          MOSS_GATE8_REAL_CODEX_PATH: realCodex,
          MOSS_GATE8_RUNTIME_EVENTS_PATH: eventsPath,
          MOSS_GATE8_STATE_PATH: statePath,
          MOSS_HOME: join(root, "moss-home"),
          MOSS_MODE: "desktop",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const messages: Array<Record<string, unknown>> = [];
      createInterface({ input: child.stdout }).on("line", (line) => {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const send = (message: Record<string, unknown>) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      try {
        send({ id: 1, method: "initialize", params: {} });
        await waitFor(() => messages.find((message) => message.id === 1));
        expect(
          readEvents(eventsPath).find((event) => event.kind === "app-server-start"),
        ).toMatchObject({
          backendProcessObserved: true,
          backendRuntimeEnvironmentObserved: true,
        });

        send({
          id: 2,
          method: "plugin/install",
          params: { marketplacePath: "/fixture/marketplace.json" },
        });
        await waitFor(() =>
          readEvents(eventsPath).find(
            (event) =>
              event.kind === "mutation" &&
              event.method === "plugin/install" &&
              event.responseWithheld === true,
          ),
        );
        expect(messages.some((message) => message.id === 2)).toBe(false);

        send({ id: 3, method: "thread/start", params: {} });
        const threadResponse = await waitFor(() => messages.find((message) => message.id === 3));
        const providerThreadId =
          (threadResponse.result as { thread?: { id?: string } } | undefined)?.thread?.id ?? "";
        expect(providerThreadId).toMatch(/^gate8-provider-thread-/u);

        send({
          id: 4,
          method: "turn/start",
          params: {
            threadId: providerThreadId,
            input: [
              { type: "text", text: EXPECTED_PROMPT, text_elements: [] },
              {
                type: "mention",
                name: "moss-plugin-lifecycle-fixture",
                path: EXPECTED_MENTION,
              },
            ],
          },
        });
        await waitFor(() =>
          messages.find(
            (message) =>
              message.method === "item/completed" &&
              (message.params as { item?: { text?: string } } | undefined)?.item?.text ===
                "MOSS_PLUGIN_LIFECYCLE_OK",
          ),
        );
        expect(readEvents(eventsPath).find((event) => event.kind === "try-now-turn")).toMatchObject(
          {
            accepted: true,
            markerEmitted: true,
            seededDefaultPrompt: EXPECTED_PROMPT,
            mentionResourceId: EXPECTED_MENTION,
            providerThreadMatched: true,
            installedAndEnabled: true,
          },
        );

        const markerCount = messages.filter(
          (message) =>
            message.method === "item/completed" &&
            (message.params as { item?: { text?: string } } | undefined)?.item?.text ===
              "MOSS_PLUGIN_LIFECYCLE_OK",
        ).length;
        send({ id: 5, method: "thread/start", params: {} });
        const negativeThread = await waitFor(() => messages.find((message) => message.id === 5));
        send({
          id: 6,
          method: "turn/start",
          params: {
            threadId: (negativeThread.result as { thread: { id: string } }).thread.id,
            input: [{ type: "text", text: EXPECTED_PROMPT, text_elements: [] }],
          },
        });
        const rejected = await waitFor(() => messages.find((message) => message.id === 6));
        expect(rejected.error).toBeDefined();
        expect(
          messages.filter(
            (message) =>
              message.method === "item/completed" &&
              (message.params as { item?: { text?: string } } | undefined)?.item?.text ===
                "MOSS_PLUGIN_LIFECYCLE_OK",
          ),
        ).toHaveLength(markerCount);

        send({
          id: 7,
          method: "config/batchWrite",
          params: {
            edits: [
              {
                keyPath: "plugins.moss-plugin-lifecycle-fixture@moss-parity-fixture.enabled",
                value: false,
              },
            ],
          },
        });
        send({ id: 8, method: "plugin/uninstall", params: {} });
        await waitFor(() => {
          const methods = readEvents(eventsPath)
            .filter((event) => event.kind === "mutation" && event.responseWithheld === true)
            .map((event) => event.method);
          return methods.includes("config/batchWrite") && methods.includes("plugin/uninstall")
            ? methods
            : undefined;
        });
        expect(messages.some((message) => message.id === 7 || message.id === 8)).toBe(false);
        expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
          installed: false,
          enabled: false,
          holdsConsumed: {
            "plugin/install": true,
            "config/batchWrite": true,
            "plugin/uninstall": true,
          },
        });
      } finally {
        await stop(child);
        expect(stderr).toBe("");
      }
    },
  );
});
