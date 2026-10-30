#!/usr/bin/env bun
/**
 * gemini-acp-mock-agent - Minimal Gemini `--acp` stand-in for SY9 injection tests.
 *
 * The real `GeminiAdapter` speaks a bespoke newline-delimited JSON-RPC dialect
 * (see {@link file://../src/provider/Layers/GeminiAdapter.ts}) rather than going
 * through `AcpSessionRuntime`. This agent replies to exactly the handshake
 * methods that `bootstrapSessionContext` sends — `initialize`, `session/new`,
 * `session/load`, `session/set_mode`, `session/set_model` — so the real
 * `startSession` path can complete end to end while the test observes the
 * `session/new` / `session/load` request payloads written to the agent's stdin.
 *
 * When `T3_GEMINI_ACP_REQUEST_LOG_PATH` is set, every incoming raw JSON-RPC
 * line is appended to that file (mirroring `acp-mock-agent.ts`), which is how
 * the test reads back `params.mcpServers` for the SY9 acceptance assertions.
 *
 * This is a dedicated agent (not a shared one) so the SY8 `acp-mock-agent.ts`
 * suite stays untouched.
 */
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

import * as OfficialAcp from "@agentclientprotocol/sdk";
import type * as AcpSchema from "@agentclientprotocol/sdk";

const requestLogPath = process.env.T3_GEMINI_ACP_REQUEST_LOG_PATH;
const supportsHttpMcp = process.env.T3_GEMINI_ACP_HTTP_MCP === "1";
const sessionId = "gemini-mock-session-1";
const hangPrompt = process.env.T3_GEMINI_ACP_PROMPT_HANG === "1";
const exitDuringPrompt = process.env.T3_GEMINI_ACP_EXIT_DURING_PROMPT === "1";

let releasePrompt: ((response: AcpSchema.PromptResponse) => void) | undefined;

const availableModes: Array<AcpSchema.SessionMode> = [
  { id: "default", name: "Default", description: "Ask before changes" },
  { id: "yolo", name: "Yolo", description: "Full access" },
];

let currentModeId = "default";
let currentModelId = "gemini-mock-model";

function modeState(): AcpSchema.SessionModeState {
  return { currentModeId, availableModes };
}

interface GeminiModelState {
  readonly currentModelId: string;
  readonly availableModels: ReadonlyArray<{
    readonly modelId: string;
    readonly name: string;
  }>;
}

function modelState(): GeminiModelState {
  return {
    currentModelId,
    availableModels: [{ modelId: currentModelId, name: "Gemini Mock" }],
  };
}

function requestInput(): ReadableStream<Uint8Array> {
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  if (!requestLogPath) return input;

  const decoder = new TextDecoder();
  let pending = "";
  const logLines = (chunk: Uint8Array, final: boolean) => {
    pending += decoder.decode(chunk, { stream: !final });
    const lines = pending.split("\n");
    // Keep an incomplete tail buffered between chunks. On final flush it stays
    // in `lines`, so an unterminated final request is logged below as well.
    pending = final ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.length > 0) appendFileSync(requestLogPath, `${line}\n`, "utf8");
    }
  };

  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        logLines(chunk, false);
        controller.enqueue(chunk);
      },
      flush() {
        logLines(new Uint8Array(), true);
      },
    }),
  );
}

type GeminiNewSessionResponse = AcpSchema.NewSessionResponse & {
  readonly models: GeminiModelState;
};

type GeminiLoadSessionResponse = AcpSchema.LoadSessionResponse & {
  readonly models: GeminiModelState;
};

const app = OfficialAcp.agent({ name: "moss-gemini-acp-mock" });

app.onRequest(OfficialAcp.methods.agent.initialize, () => ({
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    ...(supportsHttpMcp ? { mcpCapabilities: { http: true } } : {}),
  },
}));

app.onRequest(OfficialAcp.methods.agent.authenticate, () => ({}));

app.onRequest(OfficialAcp.methods.agent.session.new, (): GeminiNewSessionResponse => {
  if (process.env.T3_GEMINI_ACP_FAIL_NEW === "1") {
    throw new Error("simulated session/new unavailable");
  }
  return {
    sessionId,
    modes: modeState(),
    models: modelState(),
  };
});

app.onRequest(OfficialAcp.methods.agent.session.load, (): GeminiLoadSessionResponse => {
  if (process.env.T3_GEMINI_ACP_FAIL_LOAD === "1") {
    throw new Error("simulated session/load unavailable");
  }
  return {
    modes: modeState(),
    models: modelState(),
  };
});

app.onNotification(OfficialAcp.methods.agent.session.cancel, () => {
  const resolve = releasePrompt;
  releasePrompt = undefined;
  resolve?.({ stopReason: "cancelled" });
});

app.onRequest(OfficialAcp.methods.agent.session.prompt, () => {
  if (exitDuringPrompt) {
    // Keep the request pending long enough for the adapter to observe a real
    // active turn, then simulate an unexpected provider process exit.
    setTimeout(() => process.exit(17), 25);
    return new Promise<AcpSchema.PromptResponse>(() => undefined);
  }
  if (hangPrompt) {
    // The cancel notification above resolves this promise with the native
    // cancelled result. This keeps the interrupt path deterministic while
    // still exercising the real ACP request/notification transport.
    return new Promise<AcpSchema.PromptResponse>((resolve) => {
      releasePrompt = resolve;
    });
  }
  return { stopReason: "end_turn" };
});

app.onRequest(OfficialAcp.methods.agent.session.setMode, ({ params }) => {
  if (
    process.env.T3_GEMINI_ACP_REQUIRE_TRUST_FOR_PRIVILEGED === "1" &&
    params.modeId === "yolo" &&
    process.env.GEMINI_CLI_TRUST_WORKSPACE !== "true"
  ) {
    throw new Error("Cannot enable privileged approval modes in an untrusted folder.");
  }
  currentModeId = params.modeId;
  return {};
});

app.onRequest("session/set_model", { parse: (params: unknown) => params }, ({ params }) => {
  if (
    typeof params === "object" &&
    params !== null &&
    "modelId" in params &&
    typeof params.modelId === "string"
  ) {
    currentModelId = params.modelId;
  }
  return {};
});

const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const connection = app.connect(OfficialAcp.ndJsonStream(output, requestInput()));
await connection.closed;
