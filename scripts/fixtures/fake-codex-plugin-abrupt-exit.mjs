import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

const pluginName = "abrupt-reconcile-fixture";
const marketplaceName = "abrupt-reconcile-marketplace";
const pluginId = `${pluginName}@${marketplaceName}`;
const marketplacePath = "/fixtures/abrupt-reconcile-marketplace.json";
const statePath = join(codexHome, "fake-plugin-authoritative-state.json");
const requestsPath = process.env.PLUGIN_RECONCILE_TEST_REQUESTS_PATH;
const observationPath = process.env.PLUGIN_RECONCILE_TEST_OBSERVATION_PATH;
const crashPath = process.env.PLUGIN_RECONCILE_TEST_CRASH_PATH;

function readState() {
  if (!existsSync(statePath)) {
    return { installed: false, enabled: false };
  }
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state), "utf8");
  if (observationPath) {
    mkdirSync(dirname(observationPath), { recursive: true });
    writeFileSync(observationPath, JSON.stringify({ codexHome, statePath, state }), "utf8");
  }
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

function killBeforeMutationResponse(method) {
  if (!crashPath || !existsSync(crashPath)) return false;
  if (readFileSync(crashPath, "utf8").trim() !== method) return false;
  unlinkSync(crashPath);
  return true;
}

function pluginSummary(state) {
  return {
    id: pluginId,
    remotePluginId: null,
    name: pluginName,
    version: "1.0.0",
    localVersion: state.installed ? "1.0.0" : null,
    shareContext: null,
    availability: "AVAILABLE",
    keywords: [],
    source: { type: "local", path: join(codexHome, "plugins", pluginName) },
    installed: state.installed,
    enabled: state.enabled,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    authPolicy: "ON_USE",
    interface: {
      displayName: "Abrupt reconcile fixture",
      shortDescription: "Persists before dropping the app-server transport",
      longDescription: null,
      developerName: null,
      category: null,
      capabilities: [],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: null,
      brandColor: null,
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: null,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
    },
  };
}

function pluginDetail(state) {
  return {
    marketplaceName,
    marketplacePath,
    summary: pluginSummary(state),
    shareUrl: null,
    description: "Authoritative Codex-home mutation fixture.",
    skills: [],
    hooks: [],
    apps: [],
    appTemplates: [],
    mcpServers: [],
  };
}

function resultFor(message) {
  const state = readState();
  switch (message.method) {
    case "initialize":
      return {
        userAgent: "fake-codex-plugin-abrupt-exit/1.0",
        codexHome,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs:
          process.platform === "darwin"
            ? "macos"
            : process.platform === "win32"
              ? "windows"
              : "linux",
      };
    case "account/read":
      return { account: null };
    case "plugin/list":
      return {
        marketplaces: [
          {
            name: marketplaceName,
            path: marketplacePath,
            interface: null,
            plugins: [pluginSummary(state)],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
        remoteSyncError: null,
      };
    case "plugin/read":
      return pluginDetail(state);
    case "plugin/install":
      writeState({ installed: true, enabled: true });
      return { authPolicy: "ON_USE", appsNeedingAuth: [] };
    case "config/batchWrite": {
      const edit = message.params?.edits?.[0];
      if (edit?.keyPath !== `plugins.${pluginId}.enabled` || typeof edit?.value !== "boolean") {
        throw new Error(`unexpected config edit: ${JSON.stringify(edit)}`);
      }
      writeState({ ...state, enabled: edit.value });
      return { status: "ok" };
    }
    case "plugin/uninstall":
      if (message.params?.pluginId !== pluginId) {
        throw new Error(`unexpected plugin id: ${JSON.stringify(message.params?.pluginId)}`);
      }
      writeState({ installed: false, enabled: false });
      return {};
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
    const result = resultFor(message);
    if (killBeforeMutationResponse(message.method)) {
      process.kill(process.pid, "SIGKILL");
      return;
    }
    process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
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
