import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.144.1\n");
  process.exit(0);
}

if (args[0] !== "app-server") {
  process.stderr.write(`unexpected command: ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const codexHome = process.env.CODEX_HOME;
if (!codexHome) {
  process.stderr.write("CODEX_HOME is required\n");
  process.exit(2);
}

const statePath = join(codexHome, "fake-plugin-state.json");
const requestsPath = process.env.MOSS_PLUGIN_LIFECYCLE_REQUESTS_PATH;
const pluginName = "moss-plugin-lifecycle-fixture";
const marketplaceName = "moss-parity-fixture";

function readState() {
  if (!existsSync(statePath)) {
    return { installed: false, enabled: false, marketplacePath: null };
  }
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state), "utf8");
}

function recordRequest(message) {
  if (!requestsPath || !message.method) return;
  mkdirSync(dirname(requestsPath), { recursive: true });
  appendFileSync(
    requestsPath,
    `${JSON.stringify({ method: message.method, params: message.params ?? null })}\n`,
    "utf8",
  );
}

function pluginSummary(state) {
  return {
    id: `${pluginName}@${marketplaceName}`,
    name: pluginName,
    version: "1.0.0",
    localVersion: state.installed ? "1.0.0" : null,
    availability: "AVAILABLE",
    source: {
      source: "local",
      path: state.marketplacePath ?? "/fixture/marketplace.json",
    },
    installed: state.installed,
    enabled: state.enabled,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    interface: {
      displayName: "Moss lifecycle fixture",
      shortDescription: "Deterministic native plugin lifecycle fixture",
    },
  };
}

function pluginReadResult(state) {
  return {
    marketplaceName,
    marketplacePath: state.marketplacePath ?? "/fixture/marketplace.json",
    summary: pluginSummary(state),
    description: "Deterministic native plugin lifecycle fixture.",
    skills:
      state.installed && state.enabled
        ? [
            {
              name: `${pluginName}:lifecycle-fixture`,
              description: "Return MOSS_PLUGIN_LIFECYCLE_OK.",
              path: "/fixture/lifecycle-fixture/SKILL.md",
              enabled: true,
            },
          ]
        : [],
    apps: [],
    mcpServers: [],
  };
}

function resultFor(message) {
  const state = readState();

  switch (message.method) {
    case "initialize":
      return {
        userAgent: "fake-codex-plugin-lifecycle/1.0",
        codexHome,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : "linux",
      };
    case "initialized":
      return {};
    case "plugin/read":
      return pluginReadResult(state);
    case "plugin/install": {
      const next = {
        installed: true,
        enabled: true,
        marketplacePath: message.params?.marketplacePath ?? null,
      };
      writeState(next);
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    }
    case "config/batchWrite": {
      const edit = message.params?.edits?.[0];
      const expectedKey = `plugins.${pluginName}@${marketplaceName}.enabled`;
      if (edit?.keyPath !== expectedKey || typeof edit?.value !== "boolean") {
        throw new Error(`unexpected config edit: ${JSON.stringify(edit)}`);
      }
      writeState({ ...state, enabled: edit.value });
      return { status: "ok" };
    }
    case "plugin/uninstall":
      writeState({ ...state, installed: false, enabled: false });
      return {};
    case "skills/list":
      return {
        data: [
          {
            cwd: message.params?.cwds?.[0] ?? message.params?.cwd,
            skills:
              state.installed && state.enabled
                ? [
                    {
                      name: `${pluginName}:lifecycle-fixture`,
                      description: "Return MOSS_PLUGIN_LIFECYCLE_OK.",
                      path: "/fixture/lifecycle-fixture/SKILL.md",
                      enabled: true,
                    },
                  ]
                : [],
          },
        ],
      };
    default:
      throw new Error(`unsupported method: ${message.method}`);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
    recordRequest(message);
    if (message.id === undefined) return;
    process.stdout.write(`${JSON.stringify({ id: message.id, result: resultFor(message) })}\n`);
  } catch (error) {
    if (message?.id === undefined) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    );
  }
});
