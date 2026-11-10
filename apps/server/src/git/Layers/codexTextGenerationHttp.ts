// FILE: codexTextGenerationHttp.ts
// Purpose: Runs one structured text-generation request straight against a Codex
//          provider's endpoint, without the Codex CLI.
// Layer: Git text generation (transport)
// Exports: requestCodexProviderJson
//
// Windows cannot contain the descendants of an auxiliary `codex exec`, so Moss
// does not start one there. Titles, commit messages and the other short
// generations still have to work for people on Windows, and a provider that is
// only an endpoint plus a bearer key (Moss's own gateway, for one) needs no
// process at all: one HTTP request does what the CLI would have sent.

const MAX_OUTPUT_TOKENS = 2_048;

export interface CodexProviderJsonRequest {
  readonly baseUrl: string;
  readonly wireApi: "responses" | "chat";
  readonly credential: string;
  readonly model: string;
  readonly prompt: string;
  /** JSON Schema of the one object the reply must be. */
  readonly jsonSchema: unknown;
  readonly reasoningEffort: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

export class CodexProviderHttpError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CodexProviderHttpError";
    this.status = status;
  }
}

function instructions(jsonSchema: unknown): string {
  return [
    "Reply with exactly one JSON object and nothing else: no prose, no code fence.",
    "It must match this JSON Schema:",
    JSON.stringify(jsonSchema),
  ].join("\n");
}

function requestBody(input: CodexProviderJsonRequest): Record<string, unknown> {
  if (input.wireApi === "responses") {
    return {
      model: input.model,
      instructions: instructions(input.jsonSchema),
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: input.prompt }] },
      ],
      stream: false,
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      reasoning: { effort: input.reasoningEffort },
    };
  }
  return {
    model: input.model,
    messages: [
      { role: "system", content: instructions(input.jsonSchema) },
      { role: "user", content: input.prompt },
    ],
    stream: false,
    max_tokens: MAX_OUTPUT_TOKENS,
    reasoning_effort: input.reasoningEffort,
  };
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The reply's visible text, from either wire protocol. */
export function codexProviderReplyText(wireApi: "responses" | "chat", payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (wireApi === "chat") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    return typeof message?.content === "string" ? message.content : "";
  }
  if (typeof payload.output_text === "string" && payload.output_text.length > 0) {
    return payload.output_text;
  }
  const parts: string[] = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!isRecord(item) || item.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

/**
 * The first complete JSON object in a reply. Models asked for bare JSON still
 * sometimes wrap it in a fence or a sentence; the object itself is what counts.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Sends the request and returns the reply's JSON object as text. */
export async function requestCodexProviderJson(input: CodexProviderJsonRequest): Promise<string> {
  const doFetch = input.fetch ?? fetch;
  const url = `${input.baseUrl.replace(/\/+$/u, "")}/${input.wireApi === "responses" ? "responses" : "chat/completions"}`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.credential}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(requestBody(input)),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (cause) {
    throw new CodexProviderHttpError(
      cause instanceof Error && cause.name === "TimeoutError"
        ? "The model service timed out."
        : "The model service could not be reached.",
    );
  }
  if (!response.ok) {
    // The body may echo the request; only the status leaves this function.
    throw new CodexProviderHttpError(
      `The model service refused the request (HTTP ${response.status}).`,
      response.status,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CodexProviderHttpError("The model service returned an unreadable reply.");
  }
  const json = extractJsonObject(codexProviderReplyText(input.wireApi, payload));
  if (json === null) {
    throw new CodexProviderHttpError("The model service reply held no JSON object.");
  }
  return json;
}
