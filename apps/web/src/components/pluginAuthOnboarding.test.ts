// FILE: pluginAuthOnboarding.test.ts
// Purpose: Locks the frozen Codex 6234 post-install connector state machine.

import type { ProviderAppInfo, ProviderPluginInstallAppSummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  enrichRequiredPluginApps,
  reconcileRequiredPluginApps,
  retainedPluginAuthSessionId,
  resolvePluginAuthOnboarding,
} from "./pluginAuthOnboarding";

function summary(
  overrides: Partial<ProviderPluginInstallAppSummary> = {},
): ProviderPluginInstallAppSummary {
  return {
    id: "connector/github",
    name: "GitHub",
    description: "Work with repositories",
    installUrl: "https://chatgpt.com/gpts/editor",
    category: "Developer",
    ...overrides,
  };
}

function app(overrides: Partial<ProviderAppInfo> = {}): ProviderAppInfo {
  return {
    id: "connector/github",
    name: "GitHub",
    description: "Authoritative GitHub description",
    logoUrl: "https://cdn.example/github-light.png",
    logoUrlDark: "https://cdn.example/github-dark.png",
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: "https://chatgpt.com/gpts/editor?from=apps",
    isAccessible: false,
    isEnabled: true,
    pluginDisplayNames: ["GitHub"],
    ...overrides,
  };
}

describe("plugin auth onboarding", () => {
  it("joins authoritative app metadata by the raw protocol id, never by display name", () => {
    const apps = enrichRequiredPluginApps(
      [summary()],
      [app({ id: "wrong-id", name: "GitHub", logoUrl: "https://cdn.example/wrong.png" }), app()],
    );

    expect(apps).toEqual([
      expect.objectContaining({
        id: "connector/github",
        description: "Authoritative GitHub description",
        installUrl: "https://chatgpt.com/gpts/editor?from=apps",
        logoUrl: "https://cdn.example/github-light.png",
        logoUrlDark: "https://cdn.example/github-dark.png",
        status: "pending",
      }),
    ]);
  });

  it("does not open setup for ON_USE or ON_INSTALL with zero pending apps", () => {
    const pending = enrichRequiredPluginApps([summary()], []);
    const connected = enrichRequiredPluginApps([summary()], [app({ isAccessible: true })]);

    expect(resolvePluginAuthOnboarding("ON_USE", pending)).toEqual({ kind: "none" });
    expect(resolvePluginAuthOnboarding("ON_INSTALL", [])).toEqual({ kind: "none" });
    expect(resolvePluginAuthOnboarding("ON_INSTALL", connected)).toEqual({ kind: "none" });
  });

  it("routes exactly one ON_INSTALL app to the single-app flow and 2+ to onboarding", () => {
    const github = enrichRequiredPluginApps([summary()], []);
    const twoApps = enrichRequiredPluginApps(
      [summary(), summary({ id: "connector/gmail", name: "Gmail" })],
      [],
    );

    expect(resolvePluginAuthOnboarding("ON_INSTALL", github)).toEqual({
      kind: "single",
      app: github[0],
    });
    expect(resolvePluginAuthOnboarding("ON_INSTALL", twoApps)).toEqual({
      kind: "multiple",
      apps: twoApps,
    });
  });

  it("reconciles opened links against authoritative access without losing app order", () => {
    const pending = enrichRequiredPluginApps(
      [summary(), summary({ id: "connector/gmail", name: "Gmail" })],
      [],
    ).map((candidate, index) =>
      index === 0 ? Object.assign({}, candidate, { status: "opened" as const }) : candidate,
    );

    expect(
      reconcileRequiredPluginApps(pending, [
        app({ isAccessible: true }),
        app({ id: "connector/gmail", name: "Gmail", isAccessible: false }),
      ]).map(({ id, status }) => ({ id, status })),
    ).toEqual([
      { id: "connector/github", status: "connected" },
      { id: "connector/gmail", status: "pending" },
    ]);
  });

  it("retains only a single-app native OAuth session after its dialog auto-closes", () => {
    expect(
      retainedPluginAuthSessionId({
        mode: "single",
        sessionId: 7,
        redirectUrl: "https://auth.example/start?state=github-state",
      }),
    ).toBe(7);
    expect(
      retainedPluginAuthSessionId({ mode: "single", sessionId: 7, redirectUrl: null }),
    ).toBeNull();
    expect(
      retainedPluginAuthSessionId({
        mode: "multiple",
        sessionId: 7,
        redirectUrl: "https://auth.example/start?state=github-state",
      }),
    ).toBeNull();
  });
});
