import { describe, expect, it } from "vitest";

import { pickPageAppAiModel, readChatCompletionStream } from "./aiGateway";
import {
  pageAppContentSecurityPolicy,
  pageAppFrameLocation,
  pageAppIdFromHost,
  isPageAppHost,
} from "./frameServing";

describe("page app serving", () => {
  it("gives each page its own *.moss-app.localhost origin on a loopback server", () => {
    const location = pageAppFrameLocation({
      serverUrl: new URL("http://127.0.0.1:6010/api/page-apps/open-frame"),
      appId: "3f2c6a0e-1111-4222-8333-944445555666",
      token: "a.b",
    });
    expect(location.ownOrigin).toBe(true);
    expect(location.frameOrigin).toBe(
      "http://3f2c6a0e-1111-4222-8333-944445555666.moss-app.localhost:6010",
    );
    expect(location.frameUrl).toBe(`${location.frameOrigin}/__moss_app/frame?t=a.b`);
  });

  it("falls back to an opaque origin elsewhere", () => {
    const location = pageAppFrameLocation({
      serverUrl: new URL("https://moss.example.test/api/page-apps/open-frame"),
      appId: "abc",
      token: "t",
    });
    expect(location).toEqual({
      frameUrl: "https://moss.example.test/__moss_app/isolated?t=t",
      frameOrigin: "null",
      ownOrigin: false,
    });
  });

  it("recognises page hosts", () => {
    expect(pageAppIdFromHost("abc-1.moss-app.localhost:6010")).toBe("abc-1");
    expect(pageAppIdFromHost("localhost:6010")).toBeNull();
    expect(pageAppIdFromHost("x.moss-app.localhost.evil.test")).toBeNull();
    expect(isPageAppHost("ABC.MOSS-APP.LOCALHOST")).toBe(true);
  });

  it("blocks every network path but the library CDNs", () => {
    const csp = pageAppContentSecurityPolicy({
      parentOrigin: "http://127.0.0.1:6010",
      opaque: false,
    });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors http://127.0.0.1:6010");
    expect(csp).not.toContain("sandbox");
    expect(csp).not.toMatch(/script-src[^;]*'self'/u);
    const opaque = pageAppContentSecurityPolicy({ parentOrigin: "moss://app", opaque: true });
    expect(opaque).toContain("frame-ancestors moss:");
    expect(opaque).toContain("sandbox allow-scripts");
    expect(opaque).not.toContain("allow-same-origin");
    expect(
      pageAppContentSecurityPolicy({ parentOrigin: "x; script-src *", opaque: false }),
    ).toContain("frame-ancestors 'none'");
  });
});

describe("page app ai gateway", () => {
  it("picks a model by tier", () => {
    const models = ["claude-sonnet-4-6", "gpt-5.6-mini", "claude-opus-4-7"];
    expect(pickPageAppAiModel(models, "quick")).toBe("gpt-5.6-mini");
    expect(pickPageAppAiModel(models, "default")).toBe("claude-sonnet-4-6");
    expect(pickPageAppAiModel(models, "complex")).toBe("claude-opus-4-7");
    expect(pickPageAppAiModel([], "default")).toBeNull();
  });

  it("reads OpenAI-style SSE deltas", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi'),
        );
        controller.enqueue(
          encoder.encode('ces":[{"delta":{"content":"lo"}}]}\n\n: keepalive\n\ndata: [DONE]\n\n'),
        );
        controller.close();
      },
    });
    const parts: string[] = [];
    for await (const delta of readChatCompletionStream(body)) parts.push(delta);
    expect(parts).toEqual(["Hel", "lo"]);
  });
});
