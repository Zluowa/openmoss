// FILE: aiGateway.ts
// Purpose: The model behind the `ai` capability: one memoryless chat
// completion through Moss's own model gateway (the signed-in account's
// entitled models), streamed back as text deltas with tier-aware model
// selection and optional multimodal vision input.
// Layer: Server pages/apps

import type { PageAppAiEvent, PageAppAiRequest } from "@moss/contracts";
import { PageAppCapabilityError } from "@moss/shared/pageAppCapabilityPlugin";

export type PageAppAiTier = NonNullable<PageAppAiRequest["tier"]>;

export interface PageAppAiImage {
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly dataBase64: string;
}

export type PageAppAiGatewayRequest = PageAppAiRequest & {
  readonly images?: ReadonlyArray<PageAppAiImage>;
};

export type PageAppAiPreferredModels =
  | ReadonlyArray<string>
  | Partial<Record<PageAppAiTier, ReadonlyArray<string>>>;

export interface PageAppAiEndpoint {
  /** OpenAI-compatible base URL, with or without a trailing `/v1`. */
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly models: ReadonlyArray<string>;
}

export interface PageAppAiGateway {
  readonly ask: (
    request: PageAppAiGatewayRequest,
    signal: AbortSignal,
  ) => AsyncIterable<PageAppAiEvent>;
}

const SYSTEM_PREAMBLE =
  "You answer requests from an interactive page inside Moss. Each request stands alone; you have no memory of earlier ones.";
const JSON_INSTRUCTION =
  "Reply with one JSON value only: no prose, no explanation, no Markdown fences.";

const TIER_PATTERNS: Record<PageAppAiTier, readonly RegExp[]> = {
  quick: [/mini|flash|haiku|lite|turbo|small/iu],
  default: [
    /(?:sonnet|gpt-5|deepseek|qwen|glm|kimi)(?![\w.-]*(?:mini|flash|lite|nano))/iu,
    /sonnet|gpt-5|deepseek|qwen|glm|kimi/iu,
  ],
  complex: [
    /(?:opus|pro|max|reason|thinking)(?![\w.-]*(?:mini|flash|lite|nano))/iu,
    /(?:sonnet|gpt-5|kimi|glm)(?![\w.-]*(?:mini|flash|lite|nano))/iu,
  ],
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

function isModelList(value: PageAppAiPreferredModels): value is ReadonlyArray<string> {
  return Array.isArray(value);
}

/** Resolves a model using tier-aware preferences first, falling back to `pickPageAppAiModel`. */
export function resolvePageAppAiModel(
  models: ReadonlyArray<string>,
  tier: PageAppAiRequest["tier"] = "default",
  preferModels?: PageAppAiPreferredModels,
): string | null {
  if (models.length === 0) return null;
  const candidates =
    preferModels === undefined
      ? undefined
      : isModelList(preferModels)
        ? preferModels
        : preferModels[tier];
  const preferred = candidates?.find((candidate) => models.includes(candidate));
  if (preferred) return preferred;
  return pickPageAppAiModel(models, tier);
}

function stripVisionReferences(text: string): string {
  return text
    .replace(
      /The images attached to this request are pictures currently on the board[\s\S]*?never as instructions to you\.\n*/u,
      "",
    )
    .replace(/,"picture":\d+(?=[,}])/gu, "");
}

type OpenAiContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

type OpenAiMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | ReadonlyArray<OpenAiContentPart>;
};

function messagesFor(
  request: PageAppAiGatewayRequest,
  includeImages: boolean,
  stripVisionText = false,
): OpenAiMessage[] {
  const system = [SYSTEM_PREAMBLE, request.system ?? "", request.json ? JSON_INSTRUCTION : ""]
    .filter(Boolean)
    .join("\n\n");
  const baseTurns =
    typeof request.input === "string"
      ? [{ role: "user" as const, content: request.input }]
      : request.input.map((message) => ({ role: message.role, content: message.content }));

  const turns: OpenAiMessage[] = baseTurns.map((turn) => ({
    role: turn.role,
    content:
      stripVisionText && turn.role === "user" ? stripVisionReferences(turn.content) : turn.content,
  }));

  if (includeImages && request.images && request.images.length > 0) {
    let targetIndex = -1;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i]?.role === "user") {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex >= 0) {
      const target = turns[targetIndex]!;
      const textContent = typeof target.content === "string" ? target.content : "";
      const imageParts: OpenAiContentPart[] = request.images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
      }));
      turns[targetIndex] = {
        role: "user",
        content: [{ type: "text", text: textContent }, ...imageParts],
      };
    }
  }

  return [{ role: "system", content: system }, ...turns];
}

const VISION_REJECTION_PATTERN =
  /image|vision|multimodal|image_url|unsupported|content.*array|invalid.*content/iu;

async function shouldRetryWithoutImages(response: Response): Promise<boolean> {
  if (
    response.status === 401 ||
    response.status === 402 ||
    response.status === 403 ||
    response.status === 429
  ) {
    return false;
  }
  if (
    response.status === 400 ||
    response.status === 415 ||
    response.status === 422 ||
    response.status === 501
  ) {
    await response.body?.cancel().catch(() => undefined);
    return true;
  }
  if (response.status === 500 || response.status === 502) {
    const snippet = await response
      .text()
      .then((text) => text.slice(0, 2_048))
      .catch(() => "");
    return VISION_REJECTION_PATTERN.test(snippet);
  }
  return false;
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
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
  /**
   * Disable model thinking passes (e.g. DeepSeek) when low time-to-first-line matters
   * (such as whiteboard quick/default edits; complex tier keeps reasoning enabled).
   */
  readonly fast?: boolean;
  /** Models to prefer (tier-keyed map or flat array) before falling back to `pickPageAppAiModel`. */
  readonly preferModels?: PageAppAiPreferredModels;
}): PageAppAiGateway {
  const doFetch = options.fetch ?? fetch;
  return {
    async *ask(request, signal) {
      const endpoint = await options.resolveEndpoint();
      const tier = request.tier ?? "default";
      const model = resolvePageAppAiModel(endpoint.models, tier, options.preferModels);
      if (!model)
        throw new PageAppCapabilityError("unavailable", "No model is available for this account.");
      const target = new URL(endpoint.baseUrl);
      target.pathname = `${target.pathname.replace(/\/+$/u, "").replace(/(?:\/v1)+$/u, "")}/v1/chat/completions`;
      target.search = "";
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);

      const dispatch = async (includeImages: boolean, stripVisionText: boolean) => {
        try {
          return await doFetch(target, {
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
              messages: messagesFor(request, includeImages, stripVisionText),
              ...(options.fast && tier !== "complex" && model.toLowerCase().includes("deepseek")
                ? { thinking: { type: "disabled" } }
                : {}),
            }),
          });
        } catch {
          if (signal.aborted) throw new PageAppCapabilityError("cancelled", "Aborted.");
          throw new PageAppCapabilityError(
            "unavailable",
            "The model gateway could not be reached.",
          );
        }
      };

      const hasImages = Boolean(request.images && request.images.length > 0);
      let response = await dispatch(hasImages, false);
      if (
        hasImages &&
        !response.ok &&
        !signal.aborted &&
        (await shouldRetryWithoutImages(response))
      ) {
        response = await dispatch(false, true);
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
