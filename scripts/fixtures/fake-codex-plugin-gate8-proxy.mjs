// FILE: fake-codex-plugin-gate8-proxy.mjs
// Purpose: Proxies the real packaged Codex runtime while making Gate 8 crash and Try-now checks deterministic.
// Layer: Gate 8 packaged-user fixture runtime

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const REAL_CODEX = process.env.MOSS_GATE8_REAL_CODEX_PATH;
const EVENTS_PATH = process.env.MOSS_GATE8_RUNTIME_EVENTS_PATH;
const STATE_PATH = process.env.MOSS_GATE8_STATE_PATH;
const PLUGIN_NAME = "moss-plugin-lifecycle-fixture";
const MARKETPLACE_NAME = "moss-parity-fixture";
const EXPECTED_PROMPT = "Use the lifecycle fixture to report its deterministic marker.";
const EXPECTED_MENTION_PATH = `plugin://${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const MARKER = "MOSS_PLUGIN_LIFECYCLE_OK";
const HELD_METHODS = new Set(["plugin/install", "config/batchWrite", "plugin/uninstall"]);

if (!REAL_CODEX || !EVENTS_PATH || !STATE_PATH) {
  process.stderr.write("Gate 8 proxy requires real runtime, event, and state paths.\n");
  process.exit(2);
}

function readState() {
  if (!existsSync(STATE_PATH)) {
    return {
      installed: false,
      enabled: false,
      marketplacePath: null,
      holdsConsumed: {},
      nextThread: 1,
      nextTurn: 1,
      activeProviderThreadId: null,
    };
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state)}\n`, "utf8");
}

function record(event) {
  mkdirSync(dirname(EVENTS_PATH), { recursive: true });
  appendFileSync(EVENTS_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sameRuntimePath(candidate, expected) {
  if (!candidate || !expected) return false;
  try {
    return realpathSync(candidate) === realpathSync(expected);
  } catch {
    return false;
  }
}

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function writeError(id, message) {
  process.stdout.write(
    `${JSON.stringify({ id, error: { code: -32602, message: String(message) } })}\n`,
  );
}

function writeNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

function updateMutationState(state, method, params) {
  if (method === "plugin/install") {
    state.installed = true;
    state.enabled = true;
    state.marketplacePath = params?.marketplacePath ?? null;
    return;
  }
  if (method === "config/batchWrite") {
    const edit = params?.edits?.find(
      (candidate) =>
        candidate?.keyPath === `plugins.${PLUGIN_NAME}@${MARKETPLACE_NAME}.enabled` &&
        typeof candidate?.value === "boolean",
    );
    if (edit) state.enabled = edit.value;
    return;
  }
  if (method === "plugin/uninstall") {
    state.installed = false;
    state.enabled = false;
  }
}

function validateTurn(message) {
  const state = readState();
  const input = Array.isArray(message.params?.input) ? message.params.input : [];
  const text = input.find((entry) => entry?.type === "text")?.text;
  const mention = input.find((entry) => entry?.type === "mention");
  const providerThreadId = message.params?.threadId;
  const seededDefaultPromptObserved =
    text === EXPECTED_PROMPT || text === `@${PLUGIN_NAME} ${EXPECTED_PROMPT}`;
  const observation = {
    kind: "try-now-turn",
    newProviderThreadId: state.activeProviderThreadId,
    providerThreadId,
    outboundTurnObserved: true,
    realSendObserved: true,
    outboundText: text ?? null,
    seededDefaultPrompt: seededDefaultPromptObserved ? EXPECTED_PROMPT : null,
    seededDefaultPromptObserved,
    mentionName: mention?.name ?? null,
    mentionNameObserved: mention?.name === PLUGIN_NAME,
    mentionResourceId: mention?.path ?? null,
    mentionResourceIdObserved: mention?.path === EXPECTED_MENTION_PATH,
    providerThreadMatched: providerThreadId === state.activeProviderThreadId,
    installedAndEnabled: state.installed === true && state.enabled === true,
  };
  const accepted = Object.entries(observation)
    .filter(
      ([key]) =>
        key.endsWith("Observed") ||
        key === "providerThreadMatched" ||
        key === "installedAndEnabled",
    )
    .every(([, value]) => value === true);
  record({ ...observation, accepted, markerEmitted: accepted });
  return { accepted, state };
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  const result = spawnSync(REAL_CODEX, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}

if (args[0] !== "app-server") {
  process.stderr.write(`Unexpected Gate 8 proxy command: ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const child = spawn(REAL_CODEX, args, {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
const backendMossHome = process.env.MOSS_HOME?.trim() ?? "";
record({
  kind: "app-server-start",
  backendProcessObserved: Number.isSafeInteger(child.pid) && child.pid > 0,
  backendRuntimeEnvironmentObserved:
    process.env.MOSS_MODE === "desktop" &&
    backendMossHome.length > 0 &&
    sameRuntimePath(process.env.MOSS_BUNDLED_CODEX_PATH, REAL_CODEX),
  backendMossHomeSha256: backendMossHome ? sha256Text(backendMossHome) : null,
  realCodexSha256: sha256File(REAL_CODEX),
});
child.stderr.pipe(process.stderr);

const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }
  const pendingRequest = pending.get(message.id);
  if (!pendingRequest) {
    process.stdout.write(`${line}\n`);
    return;
  }
  pending.delete(message.id);
  if (!message.error && HELD_METHODS.has(pendingRequest.method)) {
    const state = readState();
    updateMutationState(state, pendingRequest.method, pendingRequest.params);
    const firstSuccessfulMutation = state.holdsConsumed[pendingRequest.method] !== true;
    if (firstSuccessfulMutation) state.holdsConsumed[pendingRequest.method] = true;
    writeState(state);
    if (firstSuccessfulMutation) {
      record({
        kind: "mutation",
        method: pendingRequest.method,
        requestIssuedAt: pendingRequest.requestIssuedAt,
        nativeSettledAt: new Date().toISOString(),
        responseWithheld: true,
      });
      return;
    }
  }
  process.stdout.write(`${line}\n`);
});

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.stdin.write(`${line}\n`);
    return;
  }
  if (message.id !== undefined && message.method === "thread/start") {
    const state = readState();
    const providerThreadId = `gate8-provider-thread-${state.nextThread}`;
    state.nextThread += 1;
    state.activeProviderThreadId = providerThreadId;
    writeState(state);
    record({ kind: "thread-start", newProviderThreadId: providerThreadId });
    writeResponse(message.id, { thread: { id: providerThreadId } });
    return;
  }
  if (message.id !== undefined && message.method === "turn/start") {
    const validation = validateTurn(message);
    if (!validation.accepted) {
      writeError(message.id, "Gate 8 fixture rejected an incomplete Try now turn");
      return;
    }
    const state = validation.state;
    const turnId = `gate8-provider-turn-${state.nextTurn}`;
    state.nextTurn += 1;
    writeState(state);
    writeResponse(message.id, { turn: { id: turnId } });
    setTimeout(() => {
      const threadId = state.activeProviderThreadId;
      const itemId = `${turnId}-assistant`;
      writeNotification("turn/started", { threadId, turn: { id: turnId } });
      writeNotification("item/started", {
        threadId,
        turnId,
        item: { id: itemId, type: "agentMessage", text: "" },
      });
      writeNotification("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId,
        delta: MARKER,
      });
      writeNotification("item/completed", {
        threadId,
        turnId,
        item: { id: itemId, type: "agentMessage", text: MARKER },
      });
      writeNotification("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed" },
      });
    }, 25);
    return;
  }
  if (message.id !== undefined && typeof message.method === "string") {
    pending.set(message.id, {
      method: message.method,
      params: message.params,
      requestIssuedAt: new Date().toISOString(),
    });
  }
  child.stdin.write(`${line}\n`);
});

child.once("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
