import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@moss/shared/outboundHttp";
import { fetchJson, resumeProviderUsageReads, stopProviderUsageReads } from "./http";

function response() {
  return {
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    body: new TextEncoder().encode('{"ok":true}'),
    url: "https://api.example.com/status",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resumeProviderUsageReads();
});

describe("fetchJson outbound policy", () => {
  it("keeps HTTPS and public-address enforcement as the default", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response());

    await fetchJson({
      service: "test-provider",
      url: "https://api.example.com/status",
      allowedOrigins: ["https://api.example.com"],
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].policy).toMatchObject({ requirePublicAddress: true });
    expect(request.mock.calls[0]?.[0].policy.allowLoopbackHttp).toBeUndefined();
  });

  it("opts in to the fake-ip benchmark range for pinned provider origins", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response());

    await fetchJson({
      service: "test-provider",
      url: "https://api.example.com/status",
      allowedOrigins: ["https://api.example.com"],
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].policy).toMatchObject({
      requirePublicAddress: true,
      allowBenchmarkAddressRange: true,
    });
  });

  it("passes through only an explicit loopback HTTP opt-in", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue({
      ...response(),
      url: "http://127.0.0.1:3000/status",
    });

    await fetchJson({
      service: "test-provider",
      url: "http://127.0.0.1:3000/status",
      allowedOrigins: ["http://127.0.0.1:3000"],
      allowLoopbackHttp: true,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0].policy).toMatchObject({
      allowLoopbackHttp: true,
      requirePublicAddress: true,
    });
  });
});

describe("usage requests around server shutdown", () => {
  const target = {
    service: "test-provider",
    url: "https://api.example.com/status",
    allowedOrigins: ["https://api.example.com"],
  };

  it("cancels an in-flight read at shutdown and refuses reads until a server starts again", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response());

    await fetchJson(target);
    const inFlight = request.mock.calls[0]?.[0].signal;
    expect(inFlight?.aborted).toBe(false);

    stopProviderUsageReads();
    expect(inFlight?.aborted).toBe(true);
    await fetchJson(target);
    expect(request.mock.calls[1]?.[0].signal?.aborted).toBe(true);

    resumeProviderUsageReads();
    await fetchJson(target);
    expect(request.mock.calls[2]?.[0].signal?.aborted).toBe(false);
  });

  it("never cancels a token refresh the provider may already have accepted", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response());

    stopProviderUsageReads();
    await fetchJson({ ...target, method: "POST", body: { refresh_token: "token" } });
    expect(request.mock.calls[0]?.[0].signal).toBeUndefined();
  });
});
