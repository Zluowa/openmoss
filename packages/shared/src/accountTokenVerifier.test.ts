import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bearerToken,
  DevInsecureAccountVerifier,
  RemoteAccountVerifier,
} from "./accountTokenVerifier";

function fakeFetch(handler: (authorization: string | null) => Response) {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    return handler(headers.get("authorization"));
  });
}

describe("bearerToken", () => {
  it("accepts a printable token and nothing else", () => {
    expect(bearerToken(new Headers({ authorization: "Bearer abc.def" }))).toBe("abc.def");
    expect(bearerToken(new Headers({ authorization: "Basic abc" }))).toBeNull();
    expect(bearerToken(new Headers({ authorization: "Bearer " }))).toBeNull();
    expect(bearerToken(new Headers())).toBeNull();
  });
});

describe("RemoteAccountVerifier", () => {
  it("verifies against the auth service with the publishable key and caches by token", async () => {
    let now = 0;
    const fetch = fakeFetch((authorization) =>
      authorization === "Bearer good"
        ? Response.json({ id: "user-1", email: "x@example.com" })
        : new Response("{}", { status: 401 }),
    );
    const verifier = new RemoteAccountVerifier({
      url: "https://auth.example",
      publishableKey: "pk",
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
      ttlMs: 1_000,
      negativeTtlMs: 100,
    });
    expect(await verifier.verify("good")).toEqual({ ok: true, accountId: "user-1" });
    expect(await verifier.verify("good")).toEqual({ ok: true, accountId: "user-1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.example/auth/v1/user");
    expect(new Headers(init.headers).get("apikey")).toBe("pk");

    expect(await verifier.verify("bad")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await verifier.verify("bad")).toEqual({ ok: false, reason: "unauthorized" });
    expect(fetch).toHaveBeenCalledTimes(2);

    now = 1_001;
    expect(await verifier.verify("good")).toEqual({ ok: true, accountId: "user-1" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not cache an unavailable auth service and shares one in-flight lookup", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      // A real lookup takes a round trip; both verifications below must overlap it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (calls === 1) throw new Error("network");
      return new Response("oops", { status: 502 });
    });
    const verifier = new RemoteAccountVerifier({
      url: "https://auth.example",
      publishableKey: "pk",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const [first, second] = await Promise.all([verifier.verify("t"), verifier.verify("t")]);
    expect(first).toEqual({ ok: false, reason: "unavailable" });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(await verifier.verify("t")).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toBe(2);
  });

  it("treats a malformed user document as unavailable", async () => {
    const verifier = new RemoteAccountVerifier({
      url: "https://auth.example",
      publishableKey: "pk",
      fetch: (async () => Response.json({ email: "no id" })) as unknown as typeof globalThis.fetch,
    });
    expect(await verifier.verify("t")).toEqual({ ok: false, reason: "unavailable" });
  });

  describe("with the platform fetch", () => {
    afterEach(() => vi.unstubAllGlobals());

    // Workers reject a host method called with any other `this`, while Node accepts it. This stub
    // applies the Worker's rule, so the default fetch path fails here the way it fails there.
    function stubWorkerFetch(response: () => Response) {
      vi.stubGlobal("fetch", function workerFetch(this: unknown) {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError(
            "Illegal invocation: function called with incorrect `this` reference",
          );
        }
        return Promise.resolve(response());
      });
    }

    it("accepts a valid session", async () => {
      stubWorkerFetch(() => Response.json({ id: "user-1" }));
      const verifier = new RemoteAccountVerifier({
        url: "https://auth.example",
        publishableKey: "pk",
      });
      expect(await verifier.verify("good")).toEqual({ ok: true, accountId: "user-1" });
    });

    it("rejects a token the auth service refuses instead of reporting an outage", async () => {
      stubWorkerFetch(() => Response.json({ error_code: "bad_jwt" }, { status: 403 }));
      const verifier = new RemoteAccountVerifier({
        url: "https://auth.example",
        publishableKey: "pk",
      });
      expect(await verifier.verify("bad")).toEqual({ ok: false, reason: "unauthorized" });
    });
  });
});

describe("DevInsecureAccountVerifier", () => {
  it("derives a stable account from the token digest", async () => {
    const verifier = new DevInsecureAccountVerifier();
    const first = await verifier.verify("token");
    expect(first).toEqual(await verifier.verify("token"));
    expect(first.ok && first.accountId).toMatch(/^dev:[A-Za-z0-9_-]{16}$/);
    expect(await verifier.verify("other")).not.toEqual(first);
  });
});

describe("accountTokenVerifier module", () => {
  it("never logs tokens", () => {
    const source = readFileSync(new URL("./accountTokenVerifier.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/console\./);
  });
});
