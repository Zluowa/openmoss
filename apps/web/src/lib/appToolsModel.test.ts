import type {
  DesktopConnectorOAuthCallback,
  ProviderAppInfo,
  ProviderAppTool,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  APP_CONNECTOR_OAUTH_CALLBACK_URL,
  appToolsSummary,
  buildAppComposerMention,
  buildAppManageUrl,
  createConnectorOAuthCallbackSubscription,
  groupAppTools,
  resolveStartedAppConnection,
} from "./appToolsModel";

function tool(overrides: Partial<ProviderAppTool> = {}): ProviderAppTool {
  return {
    name: "search_mail",
    description: "Search mail",
    disabledReason: null,
    visibility: null,
    accessBadges: ["READ"],
    ...overrides,
  };
}

function app(overrides: Partial<ProviderAppInfo> = {}): ProviderAppInfo {
  return {
    id: "connector/gmail",
    name: "Gmail",
    description: "Read and send mail",
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: "https://chatgpt.com/gpts/editor",
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
    ...overrides,
  };
}

describe("appToolsModel", () => {
  it("matches Codex Write-first grouping and exact action summary", () => {
    const groups = groupAppTools([
      tool({ name: "read", accessBadges: ["READ", "OPEN WORLD"] }),
      tool({ name: "write", accessBadges: ["WRITE"] }),
      tool({ name: "admin", accessBadges: ["PUBLIC WRITE"] }),
    ]);

    expect(groups.map((group) => [group.title, group.tools.map((entry) => entry.name)])).toEqual([
      ["Write", ["write", "admin"]],
      ["Read", ["read"]],
    ]);
    expect(appToolsSummary(app(), groups)).toBe(
      "The Gmail app contains 3 actions (2 write, 1 read)",
    );
  });

  it("builds the exact composer mention and connector-aware ChatGPT URLs", () => {
    expect(buildAppComposerMention(app())).toBe("[@Gmail](app://connector/gmail)");
    expect(APP_CONNECTOR_OAUTH_CALLBACK_URL).toBe("moss-connectors://connector/oauth_callback");
    expect(buildAppManageUrl(app(), false)).toBe(
      "https://chatgpt.com/gpts/editor#settings/Connectors?connector=connector%2Fgmail&product-sku=CODEX&referrer=codex",
    );
    expect(buildAppManageUrl(app(), true)).toBe(
      "https://chatgpt.com/gpts/editor#settings/Connectors?connector=connector%2Fgmail&add-connector-link=true&product-sku=CODEX&referrer=codex",
    );
    expect(buildAppManageUrl(app({ installUrl: "javascript:alert(1)" }), false)).toBeNull();
  });

  it("consumes each OAuth callback once and returns the bridge cleanup", async () => {
    let listener: ((input: DesktopConnectorOAuthCallback) => void) | undefined;
    const cleanup = vi.fn();
    const complete = vi.fn(async () => undefined);
    const unsubscribe = createConnectorOAuthCallbackSubscription(
      {
        onCallback(next) {
          listener = next;
          return cleanup;
        },
      },
      complete,
    );

    const callback = {
      fullRedirectUrl: "https://chatgpt.com/oauth/callback?code=one",
      returnTo: null,
    };
    listener?.(callback);
    listener?.(callback);
    listener?.({
      fullRedirectUrl: "https://chatgpt.com/oauth/callback?code=two",
      returnTo: "/skills",
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    unsubscribe();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("opens OAuth externally, completes NONE directly, and opens browser fallbacks", async () => {
    const openExternal = vi.fn(async () => true);
    const connected = vi.fn(async () => undefined);
    await resolveStartedAppConnection({
      result: { kind: "oauthStarted", redirectUrl: "https://auth.example/start" },
      browserFallbackUrl: "https://chatgpt.com/manage",
      openExternal,
      connected,
    });
    await resolveStartedAppConnection({
      result: { kind: "connectedDirectly" },
      browserFallbackUrl: "https://chatgpt.com/manage",
      openExternal,
      connected,
    });
    await resolveStartedAppConnection({
      result: { kind: "browserFallback", reason: "LINK_PARAMETERS_REQUIRED" },
      browserFallbackUrl: "https://chatgpt.com/manage",
      openExternal,
      connected,
    });

    expect(openExternal.mock.calls).toEqual([
      ["https://auth.example/start"],
      ["https://chatgpt.com/manage"],
    ]);
    expect(connected).toHaveBeenCalledTimes(1);
  });
});
