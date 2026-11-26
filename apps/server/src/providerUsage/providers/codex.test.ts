// FILE: providerUsage/providers/codex.test.ts
// Purpose: Covers Codex's token lifecycle — JWT-exp-gated refresh with atomic write-back of the
// rotated pair (single-use rotating refresh tokens must never be redeemed without persisting),
// adoption of out-of-band rotations on `refresh_token_reused`, and the dead-token taxonomy.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@moss/shared/outboundHttp";
import { codexUsageFetcher, parseCodexAppServerUsage } from "./codex";

const { fetchCodexResetCreditsMock, readKeychainPasswordMock } = vi.hoisted(() => ({
  fetchCodexResetCreditsMock: vi.fn().mockResolvedValue(undefined),
  readKeychainPasswordMock: vi.fn(),
}));

vi.mock("../codexResetCredits", () => ({
  fetchCodexResetCredits: fetchCodexResetCreditsMock,
}));

vi.mock("../credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials")>()),
  readKeychainPassword: readKeychainPasswordMock,
}));

const NOW_MS = 1_780_000_000_000;

const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubOutboundFetch(
  fetchMock: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  vi.spyOn(outboundHttp, "request").mockImplementation(async (input) => {
    const response = await fetchMock(input.url, {
      ...(input.method === undefined ? {} : { method: input.method }),
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
      url: String(input.url),
    };
  });
}

/** An unsigned JWT carrying only `exp`, enough for expiry-window checks. */
function makeJwt(expMs: number): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function makeCodexHome(auth: Record<string, unknown>) {
  const codexHome = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-usage-"));
  tempDirs.push(codexHome);
  mkdirSync(codexHome, { recursive: true });
  const authPath = nodePath.join(codexHome, "auth.json");
  writeFileSync(authPath, JSON.stringify(auth), "utf8");
  return { codexHome, authPath };
}

function readAuthFile(authPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
}

function makeCtx(codexHome: string, homeDir?: string) {
  return {
    homeDir: homeDir ?? nodePath.join(codexHome, "no-home"),
    env: { CODEX_HOME: codexHome },
    platform: "linux" as const,
    nowMs: NOW_MS,
    allowLegacyCodexHttpUsage: true,
  };
}

const USAGE_BODY = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 41, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 12, limit_window_seconds: 604_800 },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  fetchCodexResetCreditsMock.mockReset();
  fetchCodexResetCreditsMock.mockResolvedValue(undefined);
  readKeychainPasswordMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codexUsageFetcher", () => {
  it("uses authoritative nonstandard app-server windows and account totals", async () => {
    const readCodexAccountUsage = vi.fn(async () => ({
      accountRef: "acct_opaqueA",
      rateLimits: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 90,
            resetsAt: 1_780_005_400,
          },
          secondary: {
            usedPercent: 40,
            windowDurationMins: 4_320,
            resetsAt: 1_780_259_200,
          },
        },
        rateLimitsByLimitId: null,
      },
      tokenUsage: {
        summary: {
          lifetimeTokens: "123456",
          peakDailyTokens: "9876",
          currentStreakDays: 4,
        },
        dailyUsageBuckets: [],
      },
      planType: "plus",
      capabilities: {
        protocol: "codex-app-server-v2" as const,
        rateLimitsRead: true as const,
        accountUsageRead: true,
      },
    }));

    const snapshot = await codexUsageFetcher.fetch({
      ...makeCtx("/unused"),
      providerInstanceId: "codex_work",
      readCodexAccountUsage,
    });

    expect(snapshot).toMatchObject({
      providerInstanceId: "codex_work",
      accountRef: "acct_opaqueA",
      usageAuthority: "authoritative",
      planName: "Plus",
      limits: [
        { windowId: "codex:primary", window: "90m", windowDurationMins: 90 },
        {
          windowId: "codex:secondary",
          window: "3d",
          windowDurationMins: 4_320,
        },
      ],
    });
    expect(snapshot.usageLines).toEqual([
      { label: "Lifetime", value: "123,456 tokens" },
      { label: "Peak daily", value: "9,876 tokens" },
      { label: "Current streak", value: "4 days" },
    ]);
  });

  it("does not turn unavailable authoritative usage into zero", async () => {
    const snapshot = await codexUsageFetcher.fetch({
      ...makeCtx("/unused"),
      providerInstanceId: "codex_work",
      readCodexAccountUsage: async () => {
        throw new Error("temporary app-server transport failure");
      },
    });
    expect(snapshot.status).toBe("error");
    expect(snapshot.providerInstanceId).toBe("codex_work");
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.usageLines).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('"usedPercent":0');
  });

  it("keeps account refs opaque in the public parser result", () => {
    const serialized = JSON.stringify(
      parseCodexAppServerUsage({
        accountRef: "acct_safeReference",
        providerInstanceId: "codex_work",
        rateLimits: { rateLimits: {}, rateLimitsByLimitId: null },
        tokenUsage: null,
        planType: null,
        nowMs: NOW_MS,
      }),
    );
    expect(serialized).toContain("acct_safeReference");
    expect(serialized).not.toContain("upstream-account-id");
  });

  it("fetches Codex OAuth usage in standard mode without requiring app-server override", async () => {
    const freshJwt = makeJwt(NOW_MS + 60 * 60 * 1000);
    const { codexHome } = makeCodexHome({
      tokens: {
        access_token: freshJwt,
        refresh_token: "valid-refresh-token",
        account_id: "acct-standard",
      },
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${freshJwt}`);
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-standard");
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch({
      homeDir: nodePath.join(codexHome, "no-home"),
      env: {},
      codexHomePath: codexHome,
      platform: "win32",
      nowMs: NOW_MS,
      providerInstanceId: "codex",
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.providerInstanceId).toBe("codex");
    expect(snapshot.planName).toBe("Plus");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(41);
    expect(snapshot.limits.find((limit) => limit.window === "Weekly")?.usedPercent).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns needs-auth when no Codex credentials exist in standard mode", async () => {
    const emptyHome = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-empty-"));
    tempDirs.push(emptyHome);
    const request = vi.spyOn(outboundHttp, "request");

    const snapshot = await codexUsageFetcher.fetch({
      homeDir: emptyHome,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("needs-auth");
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a Cloudflare HTML 403 as a transient error without refreshing or signing out", async () => {
    const freshJwt = makeJwt(NOW_MS + 60 * 60 * 1000);
    const { codexHome } = makeCodexHome({
      tokens: {
        access_token: freshJwt,
        refresh_token: "keep-refresh-token",
        account_id: "acct-cf",
      },
    });
    const fetchMock = vi.fn(async () => {
      return new Response("<html><body>Just a moment...</body></html>", {
        status: 403,
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
          "cf-mitigated": "challenge",
        },
      });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch({
      homeDir: nodePath.join(codexHome, "no-home"),
      env: { CODEX_HOME: codexHome },
      platform: "win32",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries a still-valid keychain token when read-only refresh cannot rotate it", async () => {
    const codexHome = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-keychain-"));
    tempDirs.push(codexHome);
    const staleJwt = makeJwt(NOW_MS + 60_000);
    readKeychainPasswordMock.mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: staleJwt,
          refresh_token: "keychain-refresh-token",
        },
      }),
    );
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).not.toContain("auth.openai.com/oauth/token");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${staleJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch({
      homeDir: nodePath.join(codexHome, "no-home"),
      env: {
        CODEX_HOME: codexHome,
        CODEX_KEYCHAIN_ACCOUNT: "codex-test-account",
      },
      platform: "darwin",
      nowMs: NOW_MS,
      allowLegacyCodexHttpUsage: true,
    });

    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readKeychainPasswordMock).toHaveBeenCalledTimes(2);
    expect(readKeychainPasswordMock).toHaveBeenNthCalledWith(1, {
      service: "Codex Auth",
      account: "codex-test-account",
      platform: "darwin",
    });
  });

  it("refreshes an expired token form-encoded and persists the rotated pair to auth.json", async () => {
    const freshJwt = makeJwt(NOW_MS + 8 * 24 * 60 * 60 * 1000);
    const { codexHome, authPath } = makeCodexHome({
      tokens: {
        id_token: "old-id-token",
        access_token: makeJwt(NOW_MS - 60_000),
        refresh_token: "old-refresh-token",
        account_id: "acct-1",
      },
      last_refresh: "2026-07-01T00:00:00.000Z",
      custom_field: "keep-me",
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("auth.openai.com/oauth/token")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh-token");
        expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
        return jsonResponse({
          access_token: freshJwt,
          refresh_token: "rotated-refresh-token",
          id_token: "rotated-id-token",
        });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${freshJwt}`);
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Plus");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(41);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The rotation is on disk: single-use refresh tokens must survive our redemption.
    const saved = readAuthFile(authPath);
    const tokens = saved.tokens as Record<string, unknown>;
    expect(tokens.access_token).toBe(freshJwt);
    expect(tokens.refresh_token).toBe("rotated-refresh-token");
    expect(tokens.id_token).toBe("rotated-id-token");
    expect(tokens.account_id).toBe("acct-1");
    expect(saved.custom_field).toBe("keep-me");
    expect(saved.last_refresh).toBe(new Date(NOW_MS).toISOString());
  });

  it("adopts the CLI's rotation when the refresh token was already redeemed", async () => {
    const staleJwt = makeJwt(NOW_MS - 60_000);
    const cliRotatedJwt = makeJwt(NOW_MS + 8 * 24 * 60 * 60 * 1000);
    const { codexHome, authPath } = makeCodexHome({
      tokens: {
        access_token: staleJwt,
        refresh_token: "already-redeemed-refresh-token",
        account_id: "acct-1",
      },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        // The codex CLI redeemed this token first and left its rotation on disk.
        writeFileSync(
          authPath,
          JSON.stringify({
            tokens: {
              access_token: cliRotatedJwt,
              refresh_token: "cli-rotated-refresh-token",
              account_id: "acct-1",
            },
            last_refresh: new Date(NOW_MS).toISOString(),
          }),
          "utf8",
        );
        return jsonResponse({ error: { code: "refresh_token_reused" } }, 400);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${cliRotatedJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));

    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The CLI's rotation stays untouched on disk.
    const tokens = readAuthFile(authPath).tokens as Record<string, unknown>;
    expect(tokens.refresh_token).toBe("cli-rotated-refresh-token");
  });

  it("returns needs-auth without fetching usage when the refresh token is dead", async () => {
    const { codexHome } = makeCodexHome({
      tokens: {
        access_token: makeJwt(NOW_MS - 60_000),
        refresh_token: "expired-refresh-token",
      },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        return jsonResponse({ error: { code: "refresh_token_expired" } }, 400);
      }
      throw new Error("must not fetch usage with a dead credential");
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));
    expect(snapshot.status).toBe("needs-auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps using the stored token when the refresh endpoint is unavailable", async () => {
    const staleJwt = makeJwt(NOW_MS + 60_000); // inside the 5-minute refresh window, still valid
    const { codexHome, authPath } = makeCodexHome({
      tokens: { access_token: staleJwt, refresh_token: "refresh-token" },
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        return jsonResponse({ error: "server_error" }, 500);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${staleJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));
    expect(snapshot.status).toBe("ok");
    // A failed refresh must not corrupt the stored credential.
    const tokens = readAuthFile(authPath).tokens as Record<string, unknown>;
    expect(tokens.refresh_token).toBe("refresh-token");
  });

  it("refreshes and retries once when the usage endpoint rejects an unexpired token", async () => {
    const currentJwt = makeJwt(NOW_MS + 60 * 60 * 1000); // not due for proactive refresh
    const freshJwt = makeJwt(NOW_MS + 8 * 24 * 60 * 60 * 1000);
    const { codexHome, authPath } = makeCodexHome({
      tokens: { access_token: currentJwt, refresh_token: "refresh-after-401" },
    });

    let usageCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("auth.openai.com/oauth/token")) {
        return jsonResponse({
          access_token: freshJwt,
          refresh_token: "rotated-refresh-token",
        });
      }
      usageCalls += 1;
      if (usageCalls === 1) {
        return jsonResponse({ detail: "Unauthorized" }, 401);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${freshJwt}`);
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch(makeCtx(codexHome));
    expect(snapshot.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const tokens = readAuthFile(authPath).tokens as Record<string, unknown>;
    expect(tokens.access_token).toBe(freshJwt);
    expect(tokens.refresh_token).toBe("rotated-refresh-token");
  });

  it("does not fall back from an empty codexHomePath to ~/.codex, CODEX_HOME, XDG config, or Keychain", async () => {
    const isolatedHome = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-isolated-empty-"));
    const defaultHomeDir = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-default-home-"));
    const xdgConfigHome = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-xdg-"));
    tempDirs.push(isolatedHome, defaultHomeDir, xdgConfigHome);

    const defaultAuthDir = nodePath.join(defaultHomeDir, ".codex");
    mkdirSync(defaultAuthDir, { recursive: true });
    const defaultAuthPath = nodePath.join(defaultAuthDir, "auth.json");
    const defaultAuthRecord = {
      tokens: {
        access_token: makeJwt(NOW_MS - 60_000),
        refresh_token: "default-personal-refresh-token",
        account_id: "acct-default",
      },
    };
    writeFileSync(defaultAuthPath, JSON.stringify(defaultAuthRecord), "utf8");

    const defaultXdgDir = nodePath.join(defaultHomeDir, ".config", "codex");
    mkdirSync(defaultXdgDir, { recursive: true });
    writeFileSync(
      nodePath.join(defaultXdgDir, "auth.json"),
      JSON.stringify({
        tokens: { access_token: makeJwt(NOW_MS + 60 * 60 * 1000), account_id: "acct-default-xdg" },
      }),
      "utf8",
    );

    const customXdgDir = nodePath.join(xdgConfigHome, "codex");
    mkdirSync(customXdgDir, { recursive: true });
    writeFileSync(
      nodePath.join(customXdgDir, "auth.json"),
      JSON.stringify({
        tokens: { access_token: makeJwt(NOW_MS + 60 * 60 * 1000), account_id: "acct-xdg" },
      }),
      "utf8",
    );

    const { codexHome: ambientCodexHome } = makeCodexHome({
      tokens: {
        access_token: makeJwt(NOW_MS + 60 * 60 * 1000),
        refresh_token: "ambient-refresh-token",
        account_id: "acct-ambient",
      },
    });
    readKeychainPasswordMock.mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: makeJwt(NOW_MS + 60 * 60 * 1000),
          account_id: "acct-keychain",
        },
      }),
    );

    const request = vi.spyOn(outboundHttp, "request");
    const ctx = {
      homeDir: defaultHomeDir,
      codexHomePath: isolatedHome,
      providerInstanceId: "codex_work" as const,
      env: {
        CODEX_HOME: ambientCodexHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        CODEX_KEYCHAIN_ACCOUNT: "default-keychain-account",
      },
      platform: "darwin" as const,
      nowMs: NOW_MS,
    };

    const cacheKey = await codexUsageFetcher.cacheKey?.(ctx);
    const snapshot = await codexUsageFetcher.fetch(ctx);

    expect(cacheKey).toBe(`codex_work:${isolatedHome}:none`);
    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.providerInstanceId).toBe("codex_work");
    expect(request).not.toHaveBeenCalled();
    expect(readKeychainPasswordMock).not.toHaveBeenCalled();
    expect(readAuthFile(defaultAuthPath)).toEqual(defaultAuthRecord);
  });

  it("returns API-key-only status for an API-key-only codexHomePath without falling back to ~/.codex or CODEX_HOME", async () => {
    const { codexHome: isolatedHome } = makeCodexHome({
      OPENAI_API_KEY: ["test", "api", "key", "only"].join("-"),
    });
    const defaultHomeDir = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-byok-default-"));
    tempDirs.push(defaultHomeDir);

    const defaultAuthDir = nodePath.join(defaultHomeDir, ".codex");
    mkdirSync(defaultAuthDir, { recursive: true });
    const defaultAuthPath = nodePath.join(defaultAuthDir, "auth.json");
    const defaultAuthRecord = {
      tokens: {
        access_token: makeJwt(NOW_MS - 60_000),
        refresh_token: "default-refresh-must-not-rotate",
        account_id: "acct-default",
      },
    };
    writeFileSync(defaultAuthPath, JSON.stringify(defaultAuthRecord), "utf8");

    const { codexHome: ambientCodexHome } = makeCodexHome({
      tokens: {
        access_token: makeJwt(NOW_MS + 60 * 60 * 1000),
        account_id: "acct-ambient",
      },
    });
    readKeychainPasswordMock.mockResolvedValue(
      JSON.stringify({
        tokens: {
          access_token: makeJwt(NOW_MS + 60 * 60 * 1000),
          account_id: "acct-keychain",
        },
      }),
    );

    const request = vi.spyOn(outboundHttp, "request");
    const ctx = {
      homeDir: defaultHomeDir,
      codexHomePath: isolatedHome,
      providerInstanceId: "codex_byok" as const,
      env: {
        CODEX_HOME: ambientCodexHome,
        CODEX_KEYCHAIN_ACCOUNT: "default-keychain-account",
      },
      platform: "darwin" as const,
      nowMs: NOW_MS,
    };

    const cacheKey = await codexUsageFetcher.cacheKey?.(ctx);
    const snapshot = await codexUsageFetcher.fetch(ctx);

    expect(cacheKey).toBe(`codex_byok:${isolatedHome}:api-key`);
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.providerInstanceId).toBe("codex_byok");
    expect(snapshot.detail).toBe(
      "Codex API-key auth has no usage endpoint. Sign in with ChatGPT to see usage.",
    );
    expect(request).not.toHaveBeenCalled();
    expect(readKeychainPasswordMock).not.toHaveBeenCalled();
    expect(readAuthFile(defaultAuthPath)).toEqual(defaultAuthRecord);
  });

  it("uses a populated codexHomePath ahead of CODEX_HOME and ~/.codex and scopes reset-credit probing", async () => {
    const isolatedJwt = makeJwt(NOW_MS + 60 * 60 * 1000);
    const { codexHome: isolatedHome } = makeCodexHome({
      tokens: {
        access_token: isolatedJwt,
        refresh_token: "isolated-refresh-token",
        account_id: "acct-isolated",
      },
    });
    const { codexHome: ambientCodexHome } = makeCodexHome({
      tokens: {
        access_token: makeJwt(NOW_MS + 60 * 60 * 1000),
        refresh_token: "ambient-refresh-token",
        account_id: "acct-ambient",
      },
    });
    const defaultHomeDir = mkdtempSync(nodePath.join(os.tmpdir(), "moss-codex-override-default-"));
    tempDirs.push(defaultHomeDir);
    const defaultAuthDir = nodePath.join(defaultHomeDir, ".codex");
    mkdirSync(defaultAuthDir, { recursive: true });
    writeFileSync(
      nodePath.join(defaultAuthDir, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: makeJwt(NOW_MS + 60 * 60 * 1000),
          refresh_token: "default-refresh-token",
          account_id: "acct-default",
        },
      }),
      "utf8",
    );

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${isolatedJwt}`);
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-isolated");
      return jsonResponse(USAGE_BODY);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await codexUsageFetcher.fetch({
      homeDir: defaultHomeDir,
      codexHomePath: isolatedHome,
      providerInstanceId: "codex_work",
      env: { CODEX_HOME: ambientCodexHome },
      platform: "win32",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.providerInstanceId).toBe("codex_work");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCodexResetCreditsMock).toHaveBeenCalledTimes(1);
    expect(fetchCodexResetCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAccountId: "acct-isolated",
        env: expect.objectContaining({ CODEX_HOME: isolatedHome }),
      }),
    );
  });
});
