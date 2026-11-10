import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentGatewayConnectorRegistration } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import type { McpConnectorProxyResult } from "./proxy.ts";

const mocks = vi.hoisted(() => ({
  registered: vi.fn(),
  probe: vi.fn(),
  forward: vi.fn(),
  auth: vi.fn(),
  refreshAuthorization: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("./proxy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proxy.ts")>()),
  probeMcpConnector: mocks.probe,
  forwardMcpConnectorRequest: mocks.forward,
}));

vi.mock("./oauth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth.ts")>()),
  loadMcpAuth: async () => ({
    auth: mocks.auth,
    refreshAuthorization: mocks.refreshAuthorization,
    selectResourceURL: async () => new URL("https://mcp.example.com/mcp"),
  }),
  revokeConnectorTokens: mocks.revoke,
}));

const {
  decodeConnectorsDocument,
  encodeConnectorsDocument,
  MCP_CONNECTORS_MAX_COUNT,
  McpConnectorFailure,
  McpConnectorRuntime,
} = await import("./runtime.ts");

class InvalidGrant extends Error {
  get errorCode() {
    return "invalid_grant";
  }
}

class TooManyRequests extends Error {
  get errorCode() {
    return "too_many_requests";
  }
}

const ok = (value: unknown): McpConnectorProxyResult => ({
  status: 200,
  sessionId: null,
  body: { kind: "json", value },
});
const unauthorized: McpConnectorProxyResult = {
  status: 401,
  sessionId: null,
  body: { kind: "empty" },
};
const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_tables" } };

function makeRuntime(
  initial: string | null = null,
  saveHook?: (document: string) => Promise<void>,
  regionAvailable?: (region: "cn" | "global") => Promise<boolean>,
) {
  let saved = initial;
  let failSaves = false;
  let now = Date.parse("2026-10-14T10:00:00.000Z");
  const published: Array<ReadonlyArray<AgentGatewayConnectorRegistration>> = [];
  const warnings: string[] = [];
  const runtime = new McpConnectorRuntime({
    load: async () => saved,
    save: async (document) => {
      await saveHook?.(document);
      if (failSaves) throw new Error("disk full");
      saved = document;
    },
    redirectUrl: () => "http://127.0.0.1:4567/oauth/mcp/callback",
    publish: (registrations) => {
      published.push(registrations);
    },
    clientVersion: "1.0.4",
    logWarning: (message) => {
      warnings.push(message);
    },
    ...(regionAvailable ? { regionAvailable } : {}),
    now: () => now,
  });
  return {
    runtime,
    published,
    warnings,
    saved: () => saved,
    failSaves: (fail: boolean) => {
      failSaves = fail;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Drives the mocked SDK through one sign-in and returns the issued state. */
function mockSignIn(tokens: Record<string, unknown>) {
  mocks.auth.mockImplementation(async (provider, options) => {
    if (options.authorizationCode === undefined) {
      provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: { issuer: "https://auth.example.com" },
      });
      // The SDK registers a client only when none was provided.
      if (!(await provider.clientInformation())) {
        mocks.registered();
        provider.saveClientInformation({ client_id: "client-1" });
      }
      provider.saveCodeVerifier("verifier");
      provider.redirectToAuthorization(
        new URL(`https://auth.example.com/authorize?state=${await provider.state()}`),
      );
      return "REDIRECT";
    }
    if (options.authorizationCode !== "good-code") throw new Error("bad code");
    expect(provider.codeVerifier()).toBe("verifier");
    provider.saveTokens(tokens);
    return "AUTHORIZED";
  });
}

async function connectSupabase(harness: ReturnType<typeof makeRuntime>) {
  mocks.probe.mockResolvedValue({ kind: "oauth", resourceMetadataUrl: undefined, scope: "read" });
  mockSignIn({
    access_token: "access-1",
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "refresh-1",
  });
  const started = await harness.runtime.connect({ presetId: "supabase" });
  const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
  const outcome = await harness.runtime.completeAuthorization({
    state,
    code: "good-code",
    error: undefined,
    errorDescription: undefined,
  });
  expect(outcome).toEqual({ ok: true, name: "Supabase" });
  return harness.runtime.list()[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revoke.mockResolvedValue(undefined);
});

describe("McpConnectorRuntime.connect", () => {
  it("keeps a rotated refresh token usable when the disk write fails", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    harness.advance(3_600_000);
    harness.failSaves(true);
    mocks.refreshAuthorization.mockResolvedValue({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      token_type: "bearer",
      expires_in: 3600,
    });
    mocks.forward.mockResolvedValue(ok({ tools: [] }));
    await harness.runtime.forward(connector.connectorId, { method: "POST", body: call });
    await harness.runtime.forward(connector.connectorId, { method: "POST", body: call });
    expect(mocks.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(
      mocks.forward.mock.calls.every(([request]) => request.accessToken === "rotated-access"),
    ).toBe(true);
    expect(harness.warnings).toContain("Could not save refreshed connector tokens.");
  });

  it.each([false, true])(
    "does not expose or retain failed concurrent saves (both fail: %s)",
    async (bothFail) => {
      const firstSave = Promise.withResolvers<void>();
      let saves = 0;
      const harness = makeRuntime(null, async () => {
        saves += 1;
        if (saves === 1) await firstSave.promise;
        else if (bothFail) throw new Error("disk full");
      });
      mocks.probe.mockResolvedValue({ kind: "open" });
      const results = Promise.allSettled([
        harness.runtime.connect({ url: "https://first.example.com/mcp", name: "Failed" }),
        harness.runtime.connect({ url: "https://second.example.com/mcp", name: "Saved" }),
      ]);
      await vi.waitFor(() => expect(saves).toBeGreaterThan(0));
      const visibleWhileSaving = harness.runtime.list();
      firstSave.reject(new Error("disk full"));
      const outcomes = await results;
      expect(visibleWhileSaving).toEqual([]);
      expect(outcomes.map((result) => result.status)).toEqual([
        "rejected",
        bothFail ? "rejected" : "fulfilled",
      ]);
      expect(harness.runtime.list().map((entry) => entry.url)).toEqual(
        bothFail ? [] : ["https://second.example.com/mcp"],
      );
      expect(harness.published.flat().some((entry) => entry.name === "failed_connector")).toBe(
        false,
      );
      expect(
        JSON.parse(harness.saved() ?? '{"connectors":[]}').connectors.map(
          (entry: { url: string }) => entry.url,
        ),
      ).toEqual(bothFail ? [] : ["https://second.example.com/mcp"]);
    },
  );

  it("does not replace OAuth credentials when anonymous initialization succeeds on reconnect", async () => {
    const harness = makeRuntime();
    await connectSupabase(harness);
    mocks.probe.mockResolvedValue({ kind: "open" });
    const reconnect = await harness.runtime.connect({ presetId: "supabase" });
    expect(reconnect.authorizationUrl).not.toBeNull();
    expect(harness.runtime.list()[0]?.authKind).toBe("oauth");
    expect(JSON.parse(harness.saved()!).connectors[0].oauth.tokens.access_token).toBe("access-1");
  });

  it.each([false, true])(
    "keeps a disconnect authoritative over pending OAuth (exchange started: %s)",
    async (exchangeStarted) => {
      const harness = makeRuntime();
      const connector = await connectSupabase(harness);
      const reconnect = await harness.runtime.connect({ presetId: "supabase" });
      const state = new URL(reconnect.authorizationUrl!).searchParams.get("state")!;
      const exchange = Promise.withResolvers<void>();
      const originalAuth = mocks.auth.getMockImplementation()!;
      let exchanging = false;
      mocks.auth.mockImplementation(async (provider, options) => {
        exchanging = true;
        await exchange.promise;
        return originalAuth(provider, options);
      });
      const callback = () =>
        harness.runtime.completeAuthorization({
          state,
          code: "good-code",
          error: undefined,
          errorDescription: undefined,
        });
      const pending = exchangeStarted ? callback() : undefined;
      if (pending) await vi.waitFor(() => expect(exchanging).toBe(true));
      await harness.runtime.disconnect(connector.connectorId);
      exchange.resolve();
      const result = await (pending ?? callback());
      expect(result.ok).toBe(false);
      expect(harness.runtime.list()).toEqual([]);
      expect(JSON.parse(harness.saved()!).connectors).toEqual([]);
      expect(harness.published.at(-1)).toEqual([]);
    },
  );

  it("turns an anonymous connector's 401 into an MCP error instead of a gateway OAuth challenge", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({ kind: "open" });
    const { connector } = await harness.runtime.connect({ presetId: "huggingface" });
    mocks.forward.mockResolvedValue(unauthorized);
    const result = await harness.runtime.forward(connector!.connectorId, {
      method: "POST",
      body: call,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      kind: "json",
      value: { id: 1, error: { message: expect.stringContaining("reconnected") } },
    });
  });

  it("connects a server that needs no sign-in and publishes it", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue({ kind: "open" });

    const result = await harness.runtime.connect({ presetId: "huggingface" });

    expect(result.authorizationUrl).toBeNull();
    expect(result.connector).toMatchObject({
      presetId: "huggingface",
      name: "Hugging Face",
      serverName: "huggingface_connector",
      authKind: "none",
      status: "connected",
    });
    expect(harness.published.at(-1)).toEqual([
      { name: "huggingface_connector", connectorId: result.connector!.connectorId },
    ]);
    expect(JSON.parse(harness.saved()!).connectors).toHaveLength(1);
  });

  it("stores tokens only after the OAuth callback and keeps them out of the contract", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    const connector = await connectSupabase(harness);

    expect(connector).toMatchObject({ serverName: "supabase_connector", authKind: "oauth" });
    expect(JSON.stringify(connector)).not.toContain("access-1");
    const stored = JSON.parse(harness.saved()!).connectors[0];
    expect(stored.oauth.tokens.refresh_token).toBe("refresh-1");
    expect(stored.oauth.resource).toBe("https://mcp.example.com/mcp");
    expect(stored.oauth.expiresAtMs).toBe(Date.parse("2026-10-14T11:00:00.000Z"));
    expect(mocks.auth.mock.calls[0]?.[1]).toMatchObject({
      serverUrl: "https://mcp.supabase.com/mcp",
      scope: "read",
    });
  });

  it("explains vendors that refuse to register Moss", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({
      kind: "oauth",
      resourceMetadataUrl: undefined,
      scope: undefined,
    });
    mocks.auth.mockRejectedValue(new Error("HTTP 403: Forbidden"));
    await expect(harness.runtime.connect({ url: "https://mcp.vendor.com/mcp" })).rejects.toThrow(
      "vendor.com did not let Moss register as an app (HTTP 403).",
    );
  });

  it("validates the request before probing anything", async () => {
    const harness = makeRuntime();
    await expect(
      harness.runtime.connect({ presetId: "supabase", url: "https://mcp.supabase.com/mcp" }),
    ).rejects.toBeInstanceOf(McpConnectorFailure);
    await expect(harness.runtime.connect({ url: "http://insecure.example.com" })).rejects.toThrow(
      "The URL must start with https://.",
    );
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("maps a custom URL of a catalog server to its preset", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({ kind: "open" });
    const result = await harness.runtime.connect({ url: "https://huggingface.co/mcp#docs" });
    expect(result.connector).toMatchObject({ presetId: "huggingface", name: "Hugging Face" });
  });

  it("gives same-named custom servers distinct server names", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({ kind: "open" });
    const first = await harness.runtime.connect({ url: "https://a.example.com/mcp", name: "Docs" });
    const second = await harness.runtime.connect({
      url: "https://b.example.com/mcp",
      name: "Docs",
    });
    expect(first.connector?.serverName).toBe("docs_connector");
    expect(second.connector?.serverName).toBe("docs_2_connector");
  });
});

describe("McpConnectorRuntime with the user's own OAuth app", () => {
  it("asks for an app when the preset needs one", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({
      kind: "oauth",
      resourceMetadataUrl: undefined,
      scope: undefined,
    });
    await expect(harness.runtime.connect({ presetId: "slack" })).rejects.toMatchObject({
      message: "Slack needs your own OAuth app. Enter its client ID and secret.",
      code: "mcp-connector-client-required",
    });
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("asks for an app when a custom server refuses dynamic registration", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({
      kind: "oauth",
      resourceMetadataUrl: undefined,
      scope: undefined,
    });
    mocks.auth.mockRejectedValue(
      new Error("Incompatible auth server: does not support dynamic client registration"),
    );
    await expect(
      harness.runtime.connect({ url: "https://mcp.vendor.com/mcp" }),
    ).rejects.toMatchObject({ code: "mcp-connector-client-required" });
  });

  it("signs in with the user's app instead of registering, and reuses it to reconnect", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({
      kind: "oauth",
      resourceMetadataUrl: undefined,
      scope: undefined,
    });
    mockSignIn({ access_token: "xoxp-1", token_type: "user" });

    const started = await harness.runtime.connect({
      presetId: "slack",
      clientId: "123.456",
      clientSecret: "shh",
    });
    await harness.runtime.completeAuthorization({
      state: new URL(started.authorizationUrl!).searchParams.get("state")!,
      code: "good-code",
      error: undefined,
      errorDescription: undefined,
    });

    expect(mocks.registered).not.toHaveBeenCalled();
    const stored = JSON.parse(harness.saved()!).connectors[0];
    expect(stored.oauth).toMatchObject({
      clientInformation: { client_id: "123.456", client_secret: "shh" },
      userClient: true,
    });

    // Reconnecting needs no credentials: the saved app is reused.
    await expect(harness.runtime.connect({ presetId: "slack" })).resolves.toMatchObject({
      connector: null,
    });
    expect(mocks.registered).not.toHaveBeenCalled();
  });
});

describe("McpConnectorRuntime.completeAuthorization", () => {
  it("rejects an unknown or reused state", async () => {
    const harness = makeRuntime();
    await connectSupabase(harness);
    const outcome = await harness.runtime.completeAuthorization({
      state: "forged",
      code: "good-code",
      error: undefined,
      errorDescription: undefined,
    });
    expect(outcome).toMatchObject({ ok: false, title: "This sign-in link expired" });
  });

  it("reports a denied authorization without saving anything", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({
      kind: "oauth",
      resourceMetadataUrl: undefined,
      scope: undefined,
    });
    mockSignIn({ access_token: "a", token_type: "bearer" });
    const started = await harness.runtime.connect({ presetId: "linear" });
    const outcome = await harness.runtime.completeAuthorization({
      state: new URL(started.authorizationUrl!).searchParams.get("state")!,
      code: undefined,
      error: "access_denied",
      errorDescription: "The user said no",
    });
    expect(outcome).toEqual({
      ok: false,
      title: "Linear was not connected",
      message: "Linear did not authorize Moss: The user said no",
    });
    expect(harness.runtime.list()).toEqual([]);
  });

  it("expires sign-ins after ten minutes", async () => {
    const harness = makeRuntime();
    mocks.probe.mockResolvedValue({
      kind: "oauth",
      resourceMetadataUrl: undefined,
      scope: undefined,
    });
    mockSignIn({ access_token: "a", token_type: "bearer" });
    const started = await harness.runtime.connect({ presetId: "linear" });
    harness.advance(10 * 60_000 + 1);
    const outcome = await harness.runtime.completeAuthorization({
      state: new URL(started.authorizationUrl!).searchParams.get("state")!,
      code: "good-code",
      error: undefined,
      errorDescription: undefined,
    });
    expect(outcome).toMatchObject({ ok: false, title: "This sign-in link expired" });
  });
});

describe("McpConnectorRuntime.forward", () => {
  it("refreshes once on 401 and retries with the new token", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    mocks.forward.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(ok({ fine: true }));
    mocks.refreshAuthorization.mockResolvedValue({
      access_token: "access-2",
      token_type: "bearer",
      expires_in: 3600,
    });

    const result = await harness.runtime.forward(connector.connectorId, {
      method: "POST",
      body: call,
    });

    expect(result).toEqual(ok({ fine: true }));
    expect(mocks.forward.mock.calls.map(([request]) => request.accessToken)).toEqual([
      "access-1",
      "access-2",
    ]);
    expect(mocks.refreshAuthorization.mock.calls[0]?.[1]).toMatchObject({
      refreshToken: "refresh-1",
      resource: new URL("https://mcp.example.com/mcp"),
    });
    // The refresh response omitted the refresh token; the old one is kept.
    expect(JSON.parse(harness.saved()!).connectors[0].oauth.tokens).toMatchObject({
      access_token: "access-2",
      refresh_token: "refresh-1",
    });
  });

  it("shares one refresh between concurrent calls with an expired token", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    harness.advance(2 * 60 * 60_000);
    const refresh = Promise.withResolvers<unknown>();
    mocks.refreshAuthorization.mockReturnValue(refresh.promise);
    mocks.forward.mockResolvedValue(ok({}));

    const calls = [
      harness.runtime.forward(connector.connectorId, { method: "POST", body: call }),
      harness.runtime.forward(connector.connectorId, { method: "POST", body: call }),
    ];
    await Promise.resolve();
    refresh.resolve({ access_token: "access-2", token_type: "bearer", refresh_token: "refresh-2" });
    await Promise.all(calls);

    expect(mocks.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect(mocks.forward.mock.calls.map(([request]) => request.accessToken)).toEqual([
      "access-2",
      "access-2",
    ]);
  });

  it.each([true, false])(
    "does not deliver after disconnect during refresh (expired: %s)",
    async (expired) => {
      const harness = makeRuntime();
      const connector = await connectSupabase(harness);
      if (expired) harness.advance(2 * 60 * 60_000);
      const refresh = Promise.withResolvers<unknown>();
      mocks.refreshAuthorization.mockReturnValue(refresh.promise);
      mocks.forward.mockResolvedValue(unauthorized);
      const forwarded = harness.runtime.forward(connector.connectorId, {
        method: "POST",
        body: call,
      });
      await vi.waitFor(() => expect(mocks.refreshAuthorization).toHaveBeenCalled());
      await harness.runtime.disconnect(connector.connectorId);
      refresh.resolve({
        access_token: "obsolete-access",
        token_type: "bearer",
        refresh_token: "obsolete-refresh",
      });
      await forwarded;
      expect(mocks.forward).toHaveBeenCalledTimes(expired ? 0 : 1);
      expect(harness.runtime.list()).toEqual([]);
    },
  );

  it.each([true, false])(
    "uses the reconnect credential instead of an old refresh (expired: %s)",
    async (expired) => {
      const harness = makeRuntime();
      const connector = await connectSupabase(harness);
      if (expired) harness.advance(2 * 60 * 60_000);
      const refresh = Promise.withResolvers<unknown>();
      mocks.refreshAuthorization.mockReturnValue(refresh.promise);
      mocks.forward
        .mockResolvedValueOnce(expired ? ok({}) : unauthorized)
        .mockResolvedValue(ok({}));
      const forwarded = harness.runtime.forward(connector.connectorId, {
        method: "POST",
        body: call,
      });
      await vi.waitFor(() => expect(mocks.refreshAuthorization).toHaveBeenCalled());
      mocks.probe.mockResolvedValue({
        kind: "oauth",
        resourceMetadataUrl: undefined,
        scope: "read",
      });
      mockSignIn({
        access_token: "reconnect-access",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "reconnect-refresh",
      });
      const started = await harness.runtime.connect({ presetId: "supabase" });
      await harness.runtime.completeAuthorization({
        state: new URL(started.authorizationUrl!).searchParams.get("state")!,
        code: "good-code",
        error: undefined,
        errorDescription: undefined,
      });
      refresh.resolve({
        access_token: "obsolete-access",
        token_type: "bearer",
        refresh_token: "obsolete-refresh",
      });
      await forwarded;
      expect(mocks.forward.mock.calls.map(([request]) => request.accessToken)).toEqual(
        expired ? ["reconnect-access"] : ["access-1", "reconnect-access"],
      );
      expect(mocks.refreshAuthorization).toHaveBeenCalledTimes(1);
    },
  );

  it("marks the connector for reconnection when the grant is gone", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    mocks.forward.mockResolvedValue(unauthorized);
    mocks.refreshAuthorization.mockRejectedValue(new InvalidGrant("expired"));

    const result = await harness.runtime.forward(connector.connectorId, {
      method: "POST",
      body: call,
    });

    expect(result.body).toMatchObject({
      kind: "json",
      value: {
        id: 1,
        error: { message: expect.stringContaining("Supabase needs to be reconnected") },
      },
    });
    expect(harness.runtime.list()[0]?.status).toBe("needs-auth");
    expect(harness.published.at(-1)).toEqual([]);
    // Later calls fail fast without contacting the vendor.
    mocks.forward.mockClear();
    await harness.runtime.forward(connector.connectorId, { method: "POST", body: call });
    expect(mocks.forward).not.toHaveBeenCalled();
  });

  it("keeps the connector when the token endpoint rate-limits a refresh", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    mocks.forward.mockResolvedValue(unauthorized);
    mocks.refreshAuthorization.mockRejectedValue(new TooManyRequests("slow down"));

    await harness.runtime.forward(connector.connectorId, { method: "POST", body: call });

    expect(harness.runtime.list()[0]?.status).toBe("connected");
  });

  it("keeps a reconnect that finishes while an old refresh fails", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    mocks.forward.mockResolvedValue(unauthorized);
    let failRefresh!: (error: Error) => void;
    mocks.refreshAuthorization.mockReturnValue(
      new Promise((_, reject) => {
        failRefresh = reject;
      }),
    );
    const forwarded = harness.runtime.forward(connector.connectorId, {
      method: "POST",
      body: call,
    });
    await vi.waitFor(() => expect(mocks.refreshAuthorization).toHaveBeenCalled());

    // The user signs in again before the old refresh token is rejected.
    harness.advance(1_000);
    await connectSupabase(harness);
    failRefresh(new InvalidGrant("revoked"));
    await forwarded;

    expect(harness.runtime.list()[0]?.status).toBe("connected");
  });

  it("accepts notifications instead of answering 401 once sign-in is lost", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    mocks.forward.mockResolvedValue(unauthorized);
    mocks.refreshAuthorization.mockRejectedValue(new InvalidGrant("expired"));
    await harness.runtime.forward(connector.connectorId, { method: "POST", body: call });

    const notification = await harness.runtime.forward(connector.connectorId, {
      method: "POST",
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(notification).toEqual({ status: 202, sessionId: null, body: { kind: "empty" } });
    const request = await harness.runtime.forward(connector.connectorId, {
      method: "POST",
      body: call,
    });
    expect(request.status).toBe(200);
  });

  it("keeps the connector when a refresh fails for a transient reason", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    mocks.forward.mockResolvedValue(unauthorized);
    mocks.refreshAuthorization.mockRejectedValue(new Error("socket hang up"));

    const result = await harness.runtime.forward(connector.connectorId, {
      method: "POST",
      body: call,
    });

    expect(result.body).toMatchObject({
      value: {
        error: { message: "Moss could not refresh access to Supabase. Try again shortly." },
      },
    });
    expect(harness.runtime.list()[0]?.status).toBe("connected");
  });

  it("refuses a disconnected connector", async () => {
    const harness = makeRuntime();
    const result = await harness.runtime.forward("mcp_conn_missing", {
      method: "POST",
      body: call,
    });
    expect(result.body).toMatchObject({
      value: { error: { message: expect.stringContaining("disconnected") } },
    });
    expect(mocks.forward).not.toHaveBeenCalled();
  });
});

describe("McpConnectorRuntime persistence", () => {
  it("keeps a connector usable when its removal cannot be saved", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    harness.failSaves(true);

    await expect(harness.runtime.disconnect(connector.connectorId)).rejects.toThrow("disk full");

    expect(harness.runtime.list()).toEqual([connector]);
    expect(harness.published.at(-1)).toEqual([
      { name: "supabase_connector", connectorId: connector.connectorId },
    ]);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("does not move updatedAt on a background token refresh", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);
    harness.advance(2 * 60 * 60_000);
    mocks.refreshAuthorization.mockResolvedValue({
      access_token: "access-2",
      token_type: "bearer",
    });
    mocks.forward.mockResolvedValue(ok({}));

    await harness.runtime.forward(connector.connectorId, { method: "POST", body: call });

    expect(harness.runtime.list()[0]?.updatedAt).toBe(connector.updatedAt);
  });

  it("enforces the connector limit again when a sign-in returns", async () => {
    const full = {
      version: 1,
      connectors: Array.from({ length: MCP_CONNECTORS_MAX_COUNT - 1 }, (_, index) => ({
        connectorId: `c${index}`,
        presetId: null,
        name: `Server ${index}`,
        url: `https://s${index}.example.com/mcp`,
        serverName: `server_${index}_connector`,
        authKind: "none",
        status: "connected",
        createdAt: "2026-10-14T10:00:00.000Z",
        updatedAt: "2026-10-14T10:00:00.000Z",
        oauth: null,
      })),
    };
    const harness = makeRuntime(JSON.stringify(full));
    await harness.runtime.init();
    mocks.probe.mockResolvedValue({
      kind: "oauth",
      resourceMetadataUrl: undefined,
      scope: undefined,
    });
    mockSignIn({ access_token: "a", token_type: "bearer" });
    const first = await harness.runtime.connect({ presetId: "linear" });
    const second = await harness.runtime.connect({ presetId: "notion" });
    const finish = (started: { authorizationUrl: string | null }) =>
      harness.runtime.completeAuthorization({
        state: new URL(started.authorizationUrl!).searchParams.get("state")!,
        code: "good-code",
        error: undefined,
        errorDescription: undefined,
      });

    await expect(finish(first)).resolves.toMatchObject({ ok: true });
    await expect(finish(second)).resolves.toMatchObject({
      ok: false,
      message: `You can connect up to ${MCP_CONNECTORS_MAX_COUNT} connectors.`,
    });
    expect(harness.runtime.list()).toHaveLength(MCP_CONNECTORS_MAX_COUNT);
  });

  it("disconnects, unpublishes, and revokes the tokens", async () => {
    const harness = makeRuntime();
    const connector = await connectSupabase(harness);

    await expect(harness.runtime.disconnect(connector.connectorId)).resolves.toBe(true);

    expect(harness.runtime.list()).toEqual([]);
    expect(harness.published.at(-1)).toEqual([]);
    expect(mocks.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ refresh_token: "refresh-1" }) }),
    );
    await expect(harness.runtime.disconnect(connector.connectorId)).resolves.toBe(false);
  });

  it("reloads what it saved and publishes it on start", async () => {
    const first = makeRuntime();
    const connector = await connectSupabase(first);
    const second = makeRuntime(first.saved());
    await second.runtime.init();
    expect(second.runtime.list()).toEqual([connector]);
    expect(second.published.at(-1)).toEqual([
      { name: "supabase_connector", connectorId: connector.connectorId },
    ]);
  });

  it("starts empty when the saved document is unreadable, and never saves over it", async () => {
    const harness = makeRuntime(JSON.stringify({ version: 2, connectors: [] }));
    await harness.runtime.init();
    expect(harness.runtime.list()).toEqual([]);
    expect(harness.warnings).toHaveLength(1);

    mocks.probe.mockResolvedValue({ kind: "open" });
    await expect(harness.runtime.connect({ url: "https://open.example.com/mcp" })).rejects.toThrow(
      "could not read your saved connectors",
    );
    expect(harness.saved()).toBe(JSON.stringify({ version: 2, connectors: [] }));
    expect(harness.runtime.list()).toEqual([]);
  });

  it("writes unreadable entries back as they were", async () => {
    const future = { connectorId: "future", kind: "something-newer" };
    const harness = makeRuntime(JSON.stringify({ version: 1, connectors: [future] }));
    await harness.runtime.init();
    expect(harness.runtime.list()).toEqual([]);

    mocks.probe.mockResolvedValue({ kind: "open" });
    await harness.runtime.connect({ url: "https://open.example.com/mcp" });
    const saved = JSON.parse(harness.saved()!) as { connectors: unknown[] };
    expect(saved.connectors).toHaveLength(2);
    expect(saved.connectors).toContainEqual(future);
  });

  it("sets malformed entries aside but keeps valid ones", () => {
    const document = decodeConnectorsDocument(
      JSON.stringify({
        version: 1,
        connectors: [
          { connectorId: "x" },
          {
            connectorId: "c1",
            presetId: null,
            name: "Docs",
            url: "https://docs.example.com/mcp",
            serverName: "docs_connector",
            authKind: "oauth",
            status: "connected",
            createdAt: "2026-10-14T10:00:00.000Z",
            updatedAt: "2026-10-14T10:00:00.000Z",
            // An OAuth connector without tokens cannot be used.
            oauth: null,
          },
          {
            connectorId: "c2",
            presetId: null,
            name: "Open",
            url: "https://open.example.com/mcp",
            serverName: "open_connector",
            authKind: "none",
            status: "connected",
            createdAt: "2026-10-14T10:00:00.000Z",
            updatedAt: "2026-10-14T10:00:00.000Z",
            oauth: null,
          },
        ],
      }),
    );
    expect(document.connectors.map((connector) => connector.connectorId)).toEqual(["c2"]);
    expect(document.unreadable).toHaveLength(2);
    expect(
      (JSON.parse(encodeConnectorsDocument(document)) as { connectors: unknown[] }).connectors,
    ).toHaveLength(3);
  });
});

describe("McpConnectorRuntime with API keys", () => {
  const openProbe = { kind: "open" } as const;

  it("asks for a key before probing a preset that takes one", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    await expect(harness.runtime.connect({ presetId: "amap" })).rejects.toMatchObject({
      code: "mcp-connector-api-key-required",
    });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(harness.saved()).toBeNull();
  });

  it("probes with the key in the query, stores it, and keeps it out of the contract", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);

    const result = await harness.runtime.connect({ presetId: "amap", apiKey: "amap-secret" });

    expect(mocks.probe).toHaveBeenCalledWith(
      "https://mcp.amap.com/mcp?key=amap-secret",
      "高德地图",
      "1.0.4",
      undefined,
    );
    expect(result.authorizationUrl).toBeNull();
    expect(result.connector).toMatchObject({
      presetId: "amap",
      url: "https://mcp.amap.com/mcp",
      serverName: "amap_connector",
      authKind: "api-key",
      status: "connected",
    });
    expect(JSON.stringify(result.connector)).not.toContain("amap-secret");
    expect(JSON.parse(harness.saved()!).connectors[0].apiKey).toEqual({
      kind: "query",
      param: "key",
      value: "amap-secret",
    });
  });

  it("sends a bearer preset's token as a header on every call", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);
    const { connector } = await harness.runtime.connect({
      presetId: "mcdonalds_cn",
      apiKey: "mcd-token",
    });
    expect(mocks.probe).toHaveBeenCalledWith(
      "https://mcp.mcd.cn/",
      "麦当劳中国",
      "1.0.4",
      "mcd-token",
    );

    mocks.forward.mockResolvedValue(ok({ tools: [] }));
    await harness.runtime.forward(connector!.connectorId, { method: "POST", body: call });
    expect(mocks.forward).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://mcp.mcd.cn/", accessToken: "mcd-token" }),
      "麦当劳中国",
    );
  });

  it("adds a query key to each forwarded request next to the preset's own query", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);
    const { connector } = await harness.runtime.connect({
      presetId: "tencent_maps",
      apiKey: "qq-key",
    });
    mocks.forward.mockResolvedValue(ok({ tools: [] }));
    await harness.runtime.forward(connector!.connectorId, { method: "POST", body: call });
    const [request] = mocks.forward.mock.calls[0]!;
    expect(request.url).toBe("https://mcp.map.qq.com/mcp?format=0&key=qq-key");
    expect(request.accessToken).toBeUndefined();
  });

  it("explains a key the server rejects and saves nothing", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue({
      kind: "unavailable",
      message: "高德地图 did not return a valid MCP initialize response.",
    });
    await expect(
      harness.runtime.connect({ presetId: "amap", apiKey: "wrong" }),
    ).rejects.toMatchObject({
      message:
        "高德地图 did not accept this key. Check that it is correct and enabled for its MCP service.",
      code: "mcp-connector-api-key-required",
    });
    expect(harness.saved()).toBeNull();
  });

  it("reports an unreachable server as such, not as a bad key", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue({
      kind: "unavailable",
      message: "Moss could not reach 百度地图.",
      unreachable: true,
    });
    await expect(harness.runtime.connect({ presetId: "baidu_maps", apiKey: "ak" })).rejects.toThrow(
      "Moss could not reach 百度地图.",
    );
  });

  it("splits a key pasted in a custom URL and matches it to its preset", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);
    const { connector } = await harness.runtime.connect({
      url: "https://mcp.amap.com/mcp?key=pasted",
    });
    expect(connector).toMatchObject({ presetId: "amap", url: "https://mcp.amap.com/mcp" });
    expect(JSON.parse(harness.saved()!).connectors[0].apiKey.value).toBe("pasted");
  });

  it("keeps a key pasted in an unknown server's URL under its own parameter", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);
    const { connector } = await harness.runtime.connect({
      url: "https://mcp.example.cn/mcp?ak=abc&region=bj",
    });
    expect(connector).toMatchObject({
      presetId: null,
      url: "https://mcp.example.cn/mcp?region=bj",
      authKind: "api-key",
    });
    expect(mocks.probe).toHaveBeenCalledWith(
      "https://mcp.example.cn/mcp?region=bj&ak=abc",
      "example.cn",
      "1.0.4",
      undefined,
    );
  });

  it("sends a typed key for a custom server as a bearer token", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);
    await harness.runtime.connect({ url: "https://mcp.example.cn/mcp", apiKey: "tok" });
    expect(mocks.probe).toHaveBeenCalledWith(
      "https://mcp.example.cn/mcp",
      "example.cn",
      "1.0.4",
      "tok",
    );
    expect(JSON.parse(harness.saved()!).connectors[0].apiKey).toEqual({
      kind: "bearer",
      value: "tok",
    });
  });

  it("reuses the saved key on reconnect and replaces it when a new one is typed", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);
    const first = await harness.runtime.connect({ presetId: "didi", apiKey: "k1" });
    const again = await harness.runtime.connect({ presetId: "didi" });
    expect(again.connector!.connectorId).toBe(first.connector!.connectorId);
    expect(mocks.probe).toHaveBeenLastCalledWith(
      "https://mcp.didichuxing.com/mcp-servers?key=k1",
      "滴滴出行",
      "1.0.4",
      undefined,
    );
    await harness.runtime.connect({ presetId: "didi", apiKey: "k2" });
    expect(JSON.parse(harness.saved()!).connectors[0].apiKey.value).toBe("k2");
    expect(harness.runtime.list()).toHaveLength(1);
  });

  it("marks the connector for reconnection when the server rejects the saved key", async () => {
    const harness = makeRuntime();
    await harness.runtime.init();
    mocks.probe.mockResolvedValue(openProbe);
    const { connector } = await harness.runtime.connect({
      presetId: "mcdonalds_cn",
      apiKey: "expired",
    });
    mocks.forward.mockResolvedValue(unauthorized);

    const result = await harness.runtime.forward(connector!.connectorId, {
      method: "POST",
      body: call,
    });

    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain("needs to be reconnected");
    expect(harness.runtime.list()[0]!.status).toBe("needs-auth");
    expect(harness.published.at(-1)).toEqual([]);
    // A reconnect without a new key must not reuse the rejected one.
    await expect(harness.runtime.connect({ presetId: "mcdonalds_cn" })).rejects.toMatchObject({
      code: "mcp-connector-api-key-required",
    });
    await expect(
      harness.runtime.connect({ presetId: "mcdonalds_cn", apiKey: "fresh" }),
    ).resolves.toMatchObject({ connector: { status: "connected" } });
  });

  it("reads documents saved before API keys existed", () => {
    const document = decodeConnectorsDocument(
      JSON.stringify({
        version: 1,
        connectors: [
          {
            connectorId: "c1",
            presetId: "huggingface",
            name: "Hugging Face",
            url: "https://huggingface.co/mcp",
            serverName: "huggingface_connector",
            authKind: "none",
            status: "connected",
            createdAt: "2026-10-14T10:00:00.000Z",
            updatedAt: "2026-10-14T10:00:00.000Z",
            oauth: null,
          },
          {
            connectorId: "c2",
            presetId: "amap",
            name: "高德地图",
            url: "https://mcp.amap.com/mcp",
            serverName: "amap_connector",
            authKind: "api-key",
            status: "connected",
            createdAt: "2026-10-14T10:00:00.000Z",
            updatedAt: "2026-10-14T10:00:00.000Z",
            oauth: null,
            // An API-key connector without its key cannot be used.
            apiKey: null,
          },
        ],
      }),
    );
    expect(document.connectors.map((connector) => connector.connectorId)).toEqual(["c1"]);
    expect(document.unreadable).toHaveLength(1);
  });
});

describe("McpConnectorRuntime region gate", () => {
  it("refuses mainland China presets without a phone sign-in, before probing", async () => {
    const harness = makeRuntime(null, undefined, async () => false);
    await harness.runtime.init();
    await expect(harness.runtime.connect({ presetId: "amap", apiKey: "k" })).rejects.toThrow(
      "高德地图 is available only while signed in to Moss with a mainland China phone number.",
    );
    // A pasted vendor URL maps to the same preset and the same rule.
    await expect(
      harness.runtime.connect({ url: "https://mcp.amap.com/mcp?key=k" }),
    ).rejects.toThrow("mainland China phone number");
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("leaves global presets and custom servers alone", async () => {
    const region = vi.fn(async () => false);
    const harness = makeRuntime(null, undefined, region);
    await harness.runtime.init();
    mocks.probe.mockResolvedValue({ kind: "open" });
    await harness.runtime.connect({ presetId: "huggingface" });
    await harness.runtime.connect({ url: "https://mcp.example.cn/mcp", apiKey: "tok" });
    expect(region).not.toHaveBeenCalled();
  });

  it("stops forwarding to a mainland China connector after the phone sign-out", async () => {
    let signedIn = true;
    const harness = makeRuntime(null, undefined, async () => signedIn);
    await harness.runtime.init();
    mocks.probe.mockResolvedValue({ kind: "open" });
    const { connector } = await harness.runtime.connect({ presetId: "didi", apiKey: "k" });
    mocks.forward.mockResolvedValue(ok({ tools: [] }));

    signedIn = false;
    const refused = await harness.runtime.forward(connector!.connectorId, {
      method: "POST",
      body: call,
    });
    expect(JSON.stringify(refused.body)).toContain("mainland China phone number");
    expect(mocks.forward).not.toHaveBeenCalled();

    signedIn = true;
    await harness.runtime.forward(connector!.connectorId, { method: "POST", body: call });
    expect(mocks.forward).toHaveBeenCalledTimes(1);
  });
});
