import { describe, expect, it, vi } from "vitest";
import type { MossAppConnection } from "@moss/contracts";
import type { MossLoginCredential } from "../account/mossLoginAuthority";
import type { AgentGatewayConnectorRegistration } from "../agentGateway/Services/AgentGatewayCredentials";
import { appsAuthorityKey, MossAppsFailure, type MossAppsGateway } from "./gatewayClient";
import { MossAppsRuntime } from "./runtime";

const credential = (id = "a", accessToken = "fake-a"): MossLoginCredential => ({
  realm: "supabase-google",
  accessToken,
  gatewayBaseUrl: "https://fake.supabase.co/functions/v1/moss-model-gateway",
  account: { id, realm: "supabase-google" },
});
const connection = (id = "ca_a"): MossAppConnection => ({
  connectionId: id,
  toolkitSlug: "github",
  status: "active",
  createdAt: "2026-11-06T00:00:00Z",
});
const catalog = {
  toolkits: [
    {
      slug: "github",
      name: "GitHub",
      description: "",
      logoUrl: null,
      categories: [],
      toolsCount: 1,
      signIn: "managed" as const,
    },
  ],
  nextCursor: null,
  totalItems: 1,
};
const result = {
  status: 200,
  sessionId: "opaque",
  body: { kind: "json" as const, value: { jsonrpc: "2.0", id: 2, result: { safe: true } } },
};
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(overrides: Partial<MossAppsGateway> = {}) {
  let selected: MossLoginCredential | null = credential();
  let time = 0;
  const client: MossAppsGateway = {
    authority: async () => {
      if (!selected) throw MossAppsFailure.fromCode("authentication_required");
      return selected;
    },
    status: vi.fn(async () => "ready" as const),
    listConnections: vi.fn(async () => [connection()]),
    listToolkits: vi.fn(async () => catalog),
    connectFields: vi.fn(async () => ({ scheme: "API_KEY" as const, fields: [], helpUrl: null })),
    connect: vi.fn(async () => ({
      connection: { ...connection("ca_pending"), status: "pending" as const },
      signInUrl: "https://connect.composio.dev/link/fake",
      callbackState: "signed-state",
    })),
    complete: vi.fn(async () => true),
    disconnect: vi.fn(async () => true),
    forward: vi.fn(async () => result),
    ...overrides,
  };
  const published: Array<AgentGatewayConnectorRegistration | null> = [];
  const runtime = new MossAppsRuntime({
    client,
    callbackUrl: () => "http://127.0.0.1:53851/oauth/moss-apps/callback",
    publish: (entry) => published.push(entry),
    logWarning: () => {},
    now: () => time,
  });
  const request = () => ({
    method: "POST" as const,
    body: { jsonrpc: "2.0", id: 2, method: "tools/call" },
    authorityKey: appsAuthorityKey(credential()),
    isAuthorized: () => true,
  });
  return {
    runtime,
    client,
    published,
    request,
    select: (next: MossLoginCredential | null) => {
      selected = next;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("Moss Apps desktop account boundary", () => {
  it("requires a Moss login and never falls back to a project key or anonymous user", async () => {
    const f = fixture();
    f.select(null);
    await f.runtime.init();
    expect(await f.runtime.status()).toEqual({
      availability: "authentication-required",
      agentAccess: false,
    });
    await expect(f.runtime.listToolkits({})).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(f.client.listToolkits).not.toHaveBeenCalled();
  });
  it("publishes an identity-bound connector only while an app is active", async () => {
    const f = fixture();
    await f.runtime.init();
    expect(f.published).toEqual([
      { name: "moss_apps", connectorId: "moss_apps", authorityKey: appsAuthorityKey(credential()) },
    ]);
    expect((await f.runtime.status()).agentAccess).toBe(true);
    f.select(null);
    await f.runtime.refreshIdentity();
    expect(f.published.at(-1)).toBeNull();
  });
  it("does not give an active enterprise authority another cached login", async () => {
    const f = fixture({
      authority: async () => {
        throw MossAppsFailure.fromCode("apps_login_account_required");
      },
    });
    expect((await f.runtime.status()).availability).toBe("login-account-required");
    expect(f.client.status).not.toHaveBeenCalled();
  });
  it("shares concurrent full-catalog work and retains the public catalog cache", async () => {
    const done = deferred<typeof catalog>();
    const started = deferred<void>();
    const f = fixture({
      listToolkits: vi.fn(() => {
        started.resolve();
        return done.promise;
      }),
    });
    const first = f.runtime.listToolkits({ all: true });
    await started.promise;
    const second = f.runtime.listToolkits({ all: true });
    await Promise.resolve();
    done.resolve(catalog);
    expect(await Promise.all([first, second])).toEqual([catalog, catalog]);
    await f.runtime.listToolkits({ all: true });
    expect(f.client.listToolkits).toHaveBeenCalledTimes(1);
    expect(f.runtime.cachedToolkit("github")?.name).toBe("GitHub");
  });
  it.each(["logout", "switch"])(
    "rejects a late private response after %s and does not publish it",
    async (mode) => {
      const done = deferred<readonly MossAppConnection[]>();
      const started = deferred<AbortSignal>();
      const f = fixture({
        listConnections: vi.fn((_c, signal) => {
          started.resolve(signal);
          return done.promise;
        }),
      });
      const pending = f.runtime.listConnections();
      const rejected = expect(pending).rejects.toBeInstanceOf(MossAppsFailure);
      const signal = await started.promise;
      f.select(mode === "logout" ? null : credential("b", "fake-b"));
      await f.runtime.refreshIdentity();
      expect(signal.aborted).toBe(true);
      done.resolve([connection()]);
      await rejected;
      expect(f.published.filter(Boolean)).toEqual([]);
    },
  );
  it("uses a new token for the same identity without revoking its connector", async () => {
    const f = fixture();
    await f.runtime.init();
    f.select(credential("a", "refreshed-fake"));
    await f.runtime.refreshIdentity();
    await f.runtime.listConnections({ fresh: true });
    expect(f.client.listConnections).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessToken: "refreshed-fake" }),
      expect.any(AbortSignal),
    );
    expect(f.published).toHaveLength(1);
  });
  it("cannot restore A when its authority lookup resolves after a B refresh", async () => {
    const done = deferred<MossLoginCredential>();
    let first = true;
    const f = fixture({
      authority: () => (first ? ((first = false), done.promise) : Promise.resolve(credential("b"))),
    });
    const pending = f.runtime.listConnections();
    const rejected = expect(pending).rejects.toMatchObject({ code: "account_changed" });
    await f.runtime.refreshIdentity();
    await f.runtime.listConnections();
    done.resolve(credential("a"));
    await rejected;
    expect(f.published).toHaveLength(1);
    expect(f.published[0]?.authorityKey).toBe(appsAuthorityKey(credential("b")));
    expect(f.client.listConnections).toHaveBeenCalledTimes(1);
  });
  it("does not let a late A status failure overwrite B's ready status", async () => {
    let rejectA!: (error: Error) => void;
    const started = deferred<void>();
    const f = fixture({
      status: vi.fn<MossAppsGateway["status"]>((owner) =>
        owner.account.id === "a"
          ? new Promise<"ready" | "unconfigured">((_resolve, reject) => {
              rejectA = reject;
              started.resolve();
            })
          : Promise.resolve("ready"),
      ),
    });
    const pending = f.runtime.status();
    await started.promise;
    f.select(credential("b"));
    await f.runtime.refreshIdentity();
    expect((await f.runtime.status()).availability).toBe("ready");
    rejectA(new Error("late A network failure"));
    expect((await pending).availability).toBe("ready");
  });
  it("replaces private connection caches on a switch", async () => {
    const f = fixture({
      listConnections: vi.fn(async (owner) => [connection(`ca_${owner.account.id}`)]),
    });
    expect((await f.runtime.listConnections())[0]?.connectionId).toBe("ca_a");
    f.select(credential("b"));
    expect((await f.runtime.listConnections())[0]?.connectionId).toBe("ca_b");
    expect(f.published.at(-1)?.authorityKey).toBe(appsAuthorityKey(credential("b")));
  });
  it("strips callback state from renderer results and consumes it only once", async () => {
    const f = fixture();
    const connected = await f.runtime.connect("github");
    expect(connected).not.toHaveProperty("callbackState");
    expect(await f.runtime.completeAuthorization({ state: "forged" })).toBe(false);
    expect(
      await f.runtime.completeAuthorization({ state: "signed-state", connectionId: "ca_pending" }),
    ).toBe(true);
    expect(await f.runtime.completeAuthorization({ state: "signed-state" })).toBe(false);
    expect(f.client.complete).toHaveBeenCalledTimes(1);
  });
  it.each(["switch", "expired", "wrong-connection", "failed"])(
    "refuses a %s callback",
    async (mode) => {
      const f = fixture();
      await f.runtime.connect("github");
      if (mode === "switch") {
        f.select(credential("b"));
        await f.runtime.refreshIdentity();
      }
      if (mode === "expired") f.advance(600_001);
      expect(
        await f.runtime.completeAuthorization({
          state: "signed-state",
          ...(mode === "wrong-connection" ? { connectionId: "ca_other" } : {}),
          failed: mode === "failed",
        }),
      ).toBe(false);
      expect(f.client.complete).not.toHaveBeenCalled();
    },
  );
  it("keeps other active apps available after a successful disconnect", async () => {
    const f = fixture({ listConnections: vi.fn(async () => [connection("ca_remaining")]) });
    await f.runtime.init();
    expect(await f.runtime.disconnect("ca_removed")).toBe(true);
    expect(f.published.at(-1)?.connectorId).toBe("moss_apps");
    expect(f.client.disconnect).toHaveBeenCalledTimes(1);
  });
  it("does not fail or repeat a completed deletion when its follow-up read fails", async () => {
    const f = fixture({
      listConnections: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    expect(await f.runtime.disconnect("ca_removed")).toBe(true);
    expect(f.client.disconnect).toHaveBeenCalledTimes(1);
    expect((await f.runtime.status()).agentAccess).toBe(false);
  });
  it.each([404, 502])("forwards an uncertain HTTP %s exactly once", async (status) => {
    const f = fixture({ forward: vi.fn(async () => ({ ...result, status })) });
    expect((await f.runtime.forward(f.request())).status).toBe(status);
    expect(f.client.forward).toHaveBeenCalledTimes(1);
  });
  it("rejects a stale grant before forwarding and a revoked grant's late result", async () => {
    const f = fixture();
    await f.runtime.forward({ ...f.request(), authorityKey: "other-owner" });
    expect(f.client.forward).not.toHaveBeenCalled();
    const done = deferred<typeof result>();
    const started = deferred<void>();
    let authorized = true;
    const g = fixture({
      forward: vi.fn(() => {
        started.resolve();
        return done.promise;
      }),
    });
    const pending = g.runtime.forward({ ...g.request(), isAuthorized: () => authorized });
    await started.promise;
    authorized = false;
    done.resolve(result);
    const response = await pending;
    expect(JSON.stringify(response)).not.toContain('"safe":true');
    expect(g.client.forward).toHaveBeenCalledTimes(1);
  });
  it("aborts owned requests when its server scope is disposed", async () => {
    const done = deferred<readonly MossAppConnection[]>();
    const started = deferred<AbortSignal>();
    const f = fixture({
      listConnections: (_c, signal) => {
        started.resolve(signal);
        return done.promise;
      },
    });
    const pending = f.runtime.listConnections();
    const rejected = expect(pending).rejects.toBeInstanceOf(MossAppsFailure);
    const signal = await started.promise;
    f.runtime.dispose();
    expect(signal.aborted).toBe(true);
    done.resolve([connection()]);
    await rejected;
    expect(f.published.filter(Boolean)).toEqual([]);
  });
});
