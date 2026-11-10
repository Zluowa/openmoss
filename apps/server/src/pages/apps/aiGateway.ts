// FILE: aiGateway.ts
// Purpose: The model behind the `ai` capability: one memoryless chat
// completion through Moss's own model gateway (the signed-in account's
// entitled models), streamed back as text deltas.
// Layer: Server pages/apps

import type { PageAppAiEvent, PageAppAiRequest } from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";

export interface PageAppAiEndpoint {
  /** OpenAI-compatible base URL, with or without a trailing `/v1`. */
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly models: ReadonlyArray<string>;
}

export interface PageAppAiGateway {
  readonly ask: (request: PageAppAiRequest, signal: AbortSignal) => AsyncIterable<PageAppAiEvent>;
}

const SYSTEM_PREAMBLE =
  "You answer requests from an interactive page inside Moss. Each request stands alone; you have no memory of earlier ones.";
const JSON_INSTRUCTION =
  "Reply with one JSON value only: no prose, no explanation, no Markdown fences.";

const TIER_PATTERNS: Record<NonNullable<PageAppAiRequest["tier"]>, readonly RegExp[]> = {
  quick: [/mini|flash|haiku|lite|turbo|small/iu],
  default: [/sonnet|gpt-5(?![\w.-]*mini)|deepseek|qwen|glm|kimi/iu],
  complex: [/opus|pro|max|reason|thinking/iu, /sonnet|gpt-5/iu],
};

export function pickPageAppAiModel(
  models: ReadonlyArray<string>,
  tier: PageAppAiRequest["tier"] = "default",
): string | null {
  if (models.length === 0) return null;
  for (const pattern of TIER_PATTERNS[tier]) {
    const found = models.find((model) => pattern.test(model));
    if (found) return found;
  }
  return models[0]!;
}

function messagesFor(request: PageAppAiRequest) {
  const system = [SYSTEM_PREAMBLE, request.system ?? "", request.json ? JSON_INSTRUCTION : ""]
    .filter(Boolean)
    .join("\n\n");
  const turns =
    typeof request.input === "string"
      ? [{ role: "user" as const, content: request.input }]
      : request.input.map((message) => ({ role: message.role, content: message.content }));
  return [{ role: "system" as const, content: system }, ...turns];
}

/** Parses an SSE body of OpenAI-style `chat.completion.chunk` events. */
export async function* readChatCompletionStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) yield delta;
        } catch {
          // Keep-alive comments and partial frames are skipped.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function makePageAppAiGateway(options: {
  readonly resolveEndpoint: () => Promise<PageAppAiEndpoint>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): PageAppAiGateway {
  const doFetch = options.fetch ?? fetch;
  return {
    async *ask(request, signal) {
      const endpoint = await options.resolveEndpoint();
      const model = pickPageAppAiModel(endpoint.models, request.tier);
      if (!model)
        throw new PageAppCapabilityError("unavailable", "No model is available for this account.");
      const target = new URL(endpoint.baseUrl);
      target.pathname = `${target.pathname.replace(/\/+$/u, "").replace(/(?:\/v1)+$/u, "")}/v1/chat/completions`;
      target.search = "";
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
      let response: Response;
      try {
        response = await doFetch(target, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([signal, timeout]),
          headers: {
            authorization: `Bearer ${endpoint.accessToken}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            model,
            stream: true,
            max_tokens: request.maxTokens ?? 2_048,
            messages: messagesFor(request),
          }),
        });
      } catch {
        if (signal.aborted) throw new PageAppCapabilityError("cancelled", "Aborted.");
        throw new PageAppCapabilityError("unavailable", "The model gateway could not be reached.");
      }
      if (response.status === 401 || response.status === 403)
        throw new PageAppCapabilityError(
          "authentication_required",
          "Sign in to Moss to use AI on this page.",
        );
      if (response.status === 402)
        throw new PageAppCapabilityError("quota_exceeded", "Your Moss credits are used up.");
      if (response.status === 429)
        throw new PageAppCapabilityError(
          "resource_exhausted",
          "The model is busy; try again shortly.",
        );
      if (!response.ok || !response.body)
        throw new PageAppCapabilityError(
          "upstream_error",
          `The model gateway answered ${response.status}.`,
        );
      let text = "";
      for await (const delta of readChatCompletionStream(response.body)) {
        text += delta;
        yield { type: "text", delta };
      }
      yield { type: "done", text, model };
    },
  };
}

/** Loopback-only test endpoint for isolated instances and tests (never a real key). */
export function pageAppAiStubEndpoint(env: NodeJS.ProcessEnv): PageAppAiEndpoint | null {
  const raw = env.MOSS_PAGE_APPS_AI_STUB_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return null;
    return {
      baseUrl: url.toString(),
      accessToken: "moss-page-apps-stub",
      models: ["moss-stub-model"],
    };
  } catch {
    return null;
  }
}
