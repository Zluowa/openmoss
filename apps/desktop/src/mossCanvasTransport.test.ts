import { describe, expect, it, vi } from "vitest";

import { createMossCanvasTransport } from "./mossCanvasTransport";

const ENDPOINT = { baseUrl: "http://127.0.0.1:3773", token: "test-backend-token" };

function harness(fetchImpl?: typeof fetch) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    return Response.json({ ok: true });
  });
  const transport = createMossCanvasTransport({
    endpoint: () => ENDPOINT,
    fetchImpl: (fetchMock as unknown as typeof fetch) ?? fetchImpl,
  });
  return { transport, calls, fetchMock };
}

describe("mossCanvasTransport", () => {
  it("proxies account reads to the loopback backend with the backend token", async () => {
    const { transport, calls } = harness();
    await transport.account.getSession();
    await transport.account.getQuota();
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["GET", "/api/moss/media/canvas/account"],
      ["GET", "/api/moss/media/canvas/quota"],
    ]);
    for (const call of calls) {
      expect(new URL(call.url).searchParams.get("token")).toBe("test-backend-token");
    }
  });

  it("maps generation job create/status/open onto the Moss media routes", async () => {
    const { transport, calls } = harness();
    const body = new TextEncoder().encode(JSON.stringify({ prompt: "x" })).buffer;
    await transport.request(
      new Request("hoola-local://app/api/generation/jobs", { method: "POST", body }),
    );
    await transport.request(
      new Request("hoola-local://app/api/generation/jobs/moss_job1", { method: "GET" }),
    );
    await transport.request(
      new Request("hoola-local://app/api/generation/jobs/moss_job1/run", { method: "POST" }),
    );
    await transport.request(
      new Request("hoola-local://app/api/generation/projects/project-1/jobs/open", {
        method: "GET",
      }),
    );
    await transport.request(
      new Request("hoola-local://app/api/moss/media/assets/moss_job1/0", { method: "GET" }),
    );
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["POST", "/api/moss/media/jobs"],
      ["GET", "/api/moss/media/jobs/moss_job1"],
      ["GET", "/api/moss/media/jobs/moss_job1"],
      ["GET", "/api/moss/media/projects/project-1/jobs/open"],
      ["GET", "/api/moss/media/assets/moss_job1/0"],
    ]);
  });

  it("rejects non-canvas origins and unmapped paths without touching the backend", async () => {
    const { transport, fetchMock } = harness();
    for (const url of [
      "https://evil.example/api/generation/jobs",
      "hoola-local://other/api/generation/jobs",
      "hoola-local://app/api/user/deduct-credits",
      "hoola-local://app/api/moss/media/assets/local_job/0",
    ]) {
      const response = await transport.request(new Request(url, { method: "GET" }));
      expect(response.ok).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps account management inside Moss and never retries a lost POST", async () => {
    const { transport, fetchMock } = harness();
    await expect(transport.account.startPhoneLogin()).rejects.toMatchObject({
      code: "MOSS_CANVAS_HOST_ACCOUNT_MANAGED",
    });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const response = await transport.request(
      new Request("hoola-local://app/api/generation/jobs", {
        method: "POST",
        body: new TextEncoder().encode("{}").buffer,
      }),
    );
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the endpoint is not a loopback http URL", async () => {
    const transport = createMossCanvasTransport({
      endpoint: () => ({ baseUrl: "https://moss.example.com", token: "t" }),
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as typeof fetch,
    });
    await expect(transport.account.getSession()).rejects.toThrow("canvas_host_unavailable");
  });
});
