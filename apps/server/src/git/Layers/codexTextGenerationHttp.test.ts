import { describe, expect, it, vi } from "vitest";

import {
  CodexProviderHttpError,
  codexProviderReplyText,
  extractJsonObject,
  requestCodexProviderJson,
} from "./codexTextGenerationHttp.ts";
import { buildCodexTextGenerationConfig } from "./codexTextGenerationIsolation.ts";

const MOSS_CONFIG = `
model = "deepseek-v4-flash"
model_provider = "moss"

[model_providers.moss]
name = "Moss"
base_url = "https://moss-models.example/functions/v1/moss-model-gateway/v1/"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
`;

describe("direct provider routing", () => {
  it("is offered for an endpoint reached with one bearer key", () => {
    expect(buildCodexTextGenerationConfig(MOSS_CONFIG).directHttpProvider).toEqual({
      baseUrl: "https://moss-models.example/functions/v1/moss-model-gateway/v1",
      wireApi: "responses",
    });
  });

  it("is not offered for ChatGPT sign-in, extra headers, or plain-http remote endpoints", () => {
    expect(buildCodexTextGenerationConfig('model = "gpt-5.5"').directHttpProvider).toBeUndefined();
    expect(
      buildCodexTextGenerationConfig(
        `${MOSS_CONFIG}\n[model_providers.moss.http_headers]\nx = "1"\n`,
      ).directHttpProvider,
    ).toBeUndefined();
    expect(
      buildCodexTextGenerationConfig(
        MOSS_CONFIG.replace("https://moss-models.example", "http://moss-models.example"),
      ).directHttpProvider,
    ).toBeUndefined();
    expect(
      buildCodexTextGenerationConfig(
        MOSS_CONFIG.replace("https://moss-models.example", "http://127.0.0.1:58841"),
      ).directHttpProvider?.baseUrl,
    ).toBe("http://127.0.0.1:58841/functions/v1/moss-model-gateway/v1");
  });
});

describe("requestCodexProviderJson", () => {
  const schema = { type: "object", properties: { title: { type: "string" } } };

  it("asks the Responses endpoint for one JSON object and returns it", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: '```json\n{"title":"展示 T3 Code 的能力"}\n```' },
            ],
          },
        ],
      }),
    );
    const json = await requestCodexProviderJson({
      baseUrl: "https://moss-models.example/v1",
      wireApi: "responses",
      credential: "moss_sk_test",
      model: "deepseek-v4-flash",
      prompt: "展示一下t3 code的能力",
      jsonSchema: schema,
      reasoningEffort: "low",
      timeoutMs: 5_000,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(JSON.parse(json)).toEqual({ title: "展示 T3 Code 的能力" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://moss-models.example/v1/responses");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer moss_sk_test");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: false,
      store: false,
      reasoning: { effort: "low" },
    });
    expect(body.instructions).toContain(JSON.stringify(schema));
    expect(body).not.toHaveProperty("tools");
  });

  it("reports only the status when the service refuses", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ error: { message: "secret echo" } }, { status: 402 }),
    );
    const failure = await requestCodexProviderJson({
      baseUrl: "https://moss-models.example/v1",
      wireApi: "chat",
      credential: "k",
      model: "m",
      prompt: "p",
      jsonSchema: schema,
      reasoningEffort: "low",
      timeoutMs: 5_000,
      fetch: fetchMock as unknown as typeof fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CodexProviderHttpError);
    expect((failure as Error).message).toBe("The model service refused the request (HTTP 402).");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://moss-models.example/v1/chat/completions");
  });
});

describe("reply parsing", () => {
  it("reads both wire protocols", () => {
    expect(codexProviderReplyText("chat", { choices: [{ message: { content: '{"a":1}' } }] })).toBe(
      '{"a":1}',
    );
    expect(codexProviderReplyText("responses", { output_text: '{"a":2}' })).toBe('{"a":2}');
  });

  it("finds the first complete object, braces inside strings included", () => {
    expect(extractJsonObject('Sure: {"title":"a {b} \\"c\\""} done')).toBe(
      '{"title":"a {b} \\"c\\""}',
    );
    expect(extractJsonObject("no json")).toBeNull();
  });
});
