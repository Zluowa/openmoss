// FILE: mossPiExtension.ts
// Purpose: The small Pi extension Moss loads (`pi -e <file>`) into the person's own Pi CLI.
//          It registers the Moss account models, the Moss gateway tools, and two commands.
// Layer: Provider (Pi)
//
// The extension never holds a Moss gateway credential: every gateway tool call is a dialog
// request (`ctx.ui.input`) that Moss answers over Pi's RPC extension UI channel, so Moss keeps
// its per-turn lease, rotation and cancellation exactly as for in-process tools. The Moss
// account token (managed lane only) is read once and removed from the process environment
// before any tool or shell command can run.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MOSS_PI_BRIDGE_ENV_KEY = "MOSS_PI_BRIDGE";
export const MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY = "MOSS_PI_GATEWAY_TOOLS_FILE";
/** Bridge requests carry this title prefix plus the per-session nonce. */
export const MOSS_PI_BRIDGE_TITLE_PREFIX = "moss-bridge:";
export const MOSS_PI_RELOAD_COMMAND = "moss-reload";
export const MOSS_PI_GATEWAY_SYNC_COMMAND = "moss-gateway-sync";
/** Moss-internal commands; never offered in the slash menu. */
export const MOSS_PI_INTERNAL_COMMANDS: ReadonlySet<string> = new Set([
  MOSS_PI_RELOAD_COMMAND,
  MOSS_PI_GATEWAY_SYNC_COMMAND,
]);

export interface MossPiGatewayToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** One gateway call the extension asks Moss to run. */
export interface MossPiBridgeRequest {
  readonly op: "call";
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Moss's answer, sent back as the dialog value. */
export type MossPiBridgeResponse =
  | {
      readonly ok: true;
      readonly content: ReadonlyArray<
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "image"; readonly data: string; readonly mimeType: string }
      >;
      readonly details?: unknown;
    }
  | { readonly ok: false; readonly error: string };

export const MOSS_PI_EXTENSION_SOURCE = String.raw`// Moss for Pi. Written by Moss; replaced on every Moss update.
import { readFileSync } from "node:fs";

const MANAGED_CONFIG_KEY = "MOSS_PI_CONFIG_CONTENT";
const MANAGED_TOKEN_KEY = "MOSS_ACCESS_TOKEN";
const BRIDGE_KEY = "${MOSS_PI_BRIDGE_ENV_KEY}";
const TOOLS_FILE_KEY = "${MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY}";

// Read once per process and removed from the environment, so neither shell commands nor MCP
// servers Pi starts inherit them. A reload re-runs this factory and finds them here.
const STATE = Symbol.for("moss.pi.extension.state");
const state = (globalThis[STATE] ??= {});

function takeEnv(name) {
  if (!Object.hasOwn(state, name)) {
    const value = process.env[name];
    state[name] = typeof value === "string" && value.trim() ? value : undefined;
  }
  delete process.env[name];
  return state[name];
}

function readTools(file) {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((tool) => tool && typeof tool.name === "string") : [];
  } catch {
    return [];
  }
}

export default function moss(pi) {
  const managedConfig = takeEnv(MANAGED_CONFIG_KEY);
  const managedToken = takeEnv(MANAGED_TOKEN_KEY);
  if (managedConfig && managedToken) {
    const config = JSON.parse(managedConfig);
    pi.registerProvider("moss", { name: "Moss", ...config.provider, apiKey: managedToken });
  }

  const nonce = takeEnv(BRIDGE_KEY);
  const toolsFile = takeEnv(TOOLS_FILE_KEY);
  const registered = new Map();
  const register = (tool) => {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const request = { op: "call", toolCallId, name: tool.name, arguments: params ?? {} };
        const answer = await ctx.ui.input("${MOSS_PI_BRIDGE_TITLE_PREFIX}" + nonce, JSON.stringify(request), signal ? { signal } : undefined);
        if (signal && signal.aborted) throw new Error("Aborted");
        if (typeof answer !== "string") throw new Error("Moss did not answer the tool call.");
        const response = JSON.parse(answer);
        if (!response || response.ok !== true) throw new Error((response && response.error) || "Moss gateway tool failed.");
        return { content: response.content, details: response.details ?? {} };
      },
    });
    registered.set(tool.name, tool);
  };
  const sync = () => {
    const fresh = readTools(toolsFile);
    const names = new Set(fresh.map((tool) => tool.name));
    for (const tool of fresh) register(tool);
    for (const name of [...registered.keys()]) {
      if (names.has(name)) continue;
      // Tools cannot be unregistered; a hidden registration withdraws it.
      pi.registerTool({
        name,
        label: name,
        description: name,
        exposure: "hidden",
        parameters: { type: "object", properties: {} },
        async execute() {
          throw new Error("This Moss tool is no longer available.");
        },
      });
      registered.delete(name);
    }
  };
  if (nonce) {
    for (const tool of readTools(toolsFile)) register(tool);
    pi.registerCommand("${MOSS_PI_GATEWAY_SYNC_COMMAND}", {
      description: "Moss internal: refresh Moss tools",
      handler: async () => sync(),
    });
  }

  pi.registerCommand("${MOSS_PI_RELOAD_COMMAND}", {
    description: "Moss internal: reload Pi resources",
    handler: async (_args, ctx) => {
      // The command context is stale once reload starts; nothing may use it afterwards.
      await ctx.reload();
    },
  });
}
`;

const EXTENSION_HASH = createHash("sha256")
  .update(MOSS_PI_EXTENSION_SOURCE)
  .digest("hex")
  .slice(0, 16);

/** Writes the extension under Moss's state folder (content-addressed) and returns its path. */
export async function ensureMossPiExtensionFile(stateDir: string): Promise<string> {
  const directory = path.join(stateDir, "pi-extension");
  const file = path.join(directory, `moss-pi-${EXTENSION_HASH}.mjs`);
  try {
    if ((await readFile(file, "utf8")) === MOSS_PI_EXTENSION_SOURCE) return file;
  } catch {
    // Missing or unreadable: write it below.
  }
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, MOSS_PI_EXTENSION_SOURCE, "utf8");
  await rename(temporary, file).catch(async (cause) => {
    // Another session may have written the same content first.
    if ((await readFile(file, "utf8").catch(() => "")) !== MOSS_PI_EXTENSION_SOURCE) throw cause;
  });
  return file;
}

/** Writes one session's gateway tool catalog (schemas only, no credentials). */
export async function writeMossPiGatewayToolsFile(
  file: string,
  tools: ReadonlyArray<MossPiGatewayToolDescriptor>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(tools), "utf8");
  await rename(temporary, file);
}

export function parseMossPiBridgeRequest(
  title: unknown,
  payload: unknown,
  nonce: string | undefined,
): MossPiBridgeRequest | undefined {
  if (!nonce || title !== `${MOSS_PI_BRIDGE_TITLE_PREFIX}${nonce}` || typeof payload !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payload) as Partial<MossPiBridgeRequest>;
    if (
      parsed.op !== "call" ||
      typeof parsed.name !== "string" ||
      typeof parsed.toolCallId !== "string"
    ) {
      return undefined;
    }
    const args = parsed.arguments;
    return {
      op: "call",
      toolCallId: parsed.toolCallId,
      name: parsed.name,
      arguments:
        args !== null && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
    };
  } catch {
    return undefined;
  }
}

/** True for any request that carries the bridge title, valid or not: never shown to people. */
export function isMossPiBridgeTitle(title: unknown): boolean {
  return typeof title === "string" && title.startsWith(MOSS_PI_BRIDGE_TITLE_PREFIX);
}
