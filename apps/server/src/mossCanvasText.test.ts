import { afterEach, describe, expect, it, vi } from "vitest";
import { mossCanvasTextModels, relayMossCanvasText } from "./mossCanvasText";
import {
  makeMossServiceEntryRouter,
  mossModelGatewayHealthUrl,
  registerMossServiceEntryRouterForTest,
  resetMossServiceEntryRoutersForTest,
} from "./account/mossServiceEntries";
import type { MossMediaCredential } from "./mossMediaJobsService";

afterEach(() => vi.unstubAllGlobals());
const credential = {
  gatewayBaseUrl: "https://gateway.example/v1",
  accessToken: "private-account-token",
} as MossMediaCredential;
const input = {
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "Write one line" }],
  max_tokens: 128,
  stream: false,
  operationId: "canvas-text-operation-1234",
};

describe("Moss Canvas shared text gateway", () => {
  it("dispatches once to the bound gateway and returns only output and usage", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "Saved text", private: "hidden" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, secret: "hidden" },
        upstreamToken: "hidden",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await relayMossCanvasText(input, credential, [input.model])).toEqual({
      status: 200,
      body: {
        choices: [{ message: { role: "assistant", content: "Saved text" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://gateway.example/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-account-token");
    expect(new Headers(init.headers).get("x-client-request-id")).toBe(input.operationId);
    expect(JSON.parse(String(init.body))).not.toHaveProperty("expectedAccount");
  });

  it("never dispatches an unentitled model or malformed request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(relayMossCanvasText(input, credential, [])).rejects.toMatchObject({
      code: "model_not_entitled",
    });
    for (const patch of [
      { stream: true },
      { max_tokens: 100000 },
      { operationId: "" },
      { messages: [] },
    ]) {
      await expect(
        relayMossCanvasText({ ...input, ...patch }, credential, [input.model]),
      ).rejects.toMatchObject({ code: "canvas_text_request_invalid" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry or claim a refund when dispatch completion is unknown", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unknown transport outcome");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(relayMossCanvasText(input, credential, [input.model])).rejects.toMatchObject({
      code: "canvas_text_billing_unconfirmed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not return an upstream error body", async () => {
    const fetchMock = vi.fn(async () => Response.json({ token: "hidden" }, { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await relayMossCanvasText(input, credential, [input.model]);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** The CN gateway entries in use: both pass their health checks, the primary is in use. */
const CN_PRIMARY = "https://moss-models.example.cn/functions/v1/moss-model-gateway/v1";
const CN_FALLBACK = "https://moss-cn-models.example.com/functions/v1/moss-model-gateway/v1";
const cnEntriesInUse = async () => {
  const router = makeMossServiceEntryRouter({
    service: "CN model gateway",
    entries: [CN_PRIMARY, CN_FALLBACK],
    healthUrl: mossModelGatewayHealthUrl,
    probe: async () => true,
  });
  await router.ensure();
  registerMossServiceEntryRouterForTest(router);
  return router;
};
const resetError = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
const onPrimary = (url: string | URL | Request) =>
  String(url instanceof Request ? url.url : url).startsWith(new URL(CN_PRIMARY).origin);

describe("Moss Canvas text across CN gateway entries", () => {
  afterEach(() => resetMossServiceEntryRoutersForTest());
  const cnCredential = {
    realm: "memfire-phone",
    account: { id: "account-cn", realm: "memfire-phone" },
    gatewayBaseUrl: CN_PRIMARY,
    accessToken: "private-account-token",
  } as MossMediaCredential;

  it("reads the model list once more on the next entry after a reset (a read)", async () => {
    const router = await cnEntriesInUse();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (onPrimary(url)) throw resetError();
      return Response.json({ data: [{ id: input.model }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(mossCanvasTextModels(cnCredential)).resolves.toEqual([input.model]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`${CN_FALLBACK}/models`);
    expect(router.current()).toBe(CN_FALLBACK);
  });

  it("never sends a text request (billed) to a second entry, but reports the reset", async () => {
    const router = await cnEntriesInUse();
    const fetchMock = vi.fn(async () => {
      throw resetError();
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(relayMossCanvasText(input, cnCredential, [input.model])).rejects.toMatchObject({
      code: "canvas_text_billing_unconfirmed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.current()).toBe(CN_FALLBACK);

    // The next request, with the same credential, goes to the entry in use.
    const answered = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    );
    vi.stubGlobal("fetch", answered);
    expect((await relayMossCanvasText(input, cnCredential, [input.model])).status).toBe(200);
    expect(String((answered.mock.calls[0] as unknown as [URL])[0])).toBe(
      `${CN_FALLBACK}/chat/completions`,
    );
  });
});
