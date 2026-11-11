import type { ProviderInstanceId } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  isMossGatewayUnreachableState,
  resolveMossAccountGatewayState,
} from "../auth/useMossGatewayUnreachable";
import { providerReadinessDescriptionKey } from "~/lib/providerReadinessCopy";
import { resolveComposerModelPickerProviderTabs } from "./ComposerModelPickerTabs";

const id = (value: string) => value as ProviderInstanceId;

const options = [
  { value: "codex" as const, label: "Codex" },
  { value: "grok" as const, label: "Grok" },
];

describe("Moss gateway unreachable", () => {
  it("is the gateway's own state, never an answer about the account", () => {
    expect(
      isMossGatewayUnreachableState({
        authenticated: true,
        modelGatewayStatus: "transport-degraded",
      }),
    ).toBe(true);
    expect(
      isMossGatewayUnreachableState({ authenticated: true, modelGatewayStatus: "ready" }),
    ).toBe(false);
    expect(
      isMossGatewayUnreachableState({ authenticated: true, modelGatewayStatus: "auth-denied" }),
    ).toBe(false);
    expect(
      isMossGatewayUnreachableState({
        authenticated: false,
        modelGatewayStatus: "transport-degraded",
      }),
    ).toBe(false);
    expect(isMossGatewayUnreachableState(undefined)).toBe(false);
  });

  it("shows Moss rows as can't-reach, not 登录, and leaves local accounts alone", () => {
    const instances = [
      {
        instanceId: id("codex_moss"),
        provider: "codex" as const,
        label: "Moss",
        enabled: true,
        isDefault: false,
      },
      {
        instanceId: id("codex"),
        provider: "codex" as const,
        label: "Codex",
        enabled: true,
        isDefault: true,
      },
    ];
    const tabs = resolveComposerModelPickerProviderTabs({
      options,
      providers: [],
      providerInstances: instances,
      mossGatewayUnreachable: true,
    });
    const moss = tabs.find((tab) => tab.instanceId === "codex_moss");
    expect(moss?.readiness).toEqual({ state: "error", reason: "moss-gateway-unreachable" });
    expect(moss?.mossSignIn).toBe(false);
    expect(providerReadinessDescriptionKey(moss?.readiness)).toBe(
      "provider.readiness.reason.moss-gateway-unreachable",
    );
    expect(tabs.find((tab) => tab.instanceId === "codex")?.readiness.reason).not.toBe(
      "moss-gateway-unreachable",
    );
  });

  it("does not offer Moss sign-in while the account is signed in but the gateway is down", () => {
    // No Moss lane exists (an older server tore them down): the Moss row would read 登录.
    const tabs = resolveComposerModelPickerProviderTabs({
      options,
      providers: [],
      providerInstances: [],
      mossGatewayUnreachable: true,
    });
    const mossRows = tabs.filter((tab) => tab.accountLabel === "Moss");
    expect(mossRows.length).toBeGreaterThan(0);
    for (const row of mossRows) {
      expect(row.mossSignIn).toBe(false);
      expect(row.readiness.reason).toBe("moss-gateway-unreachable");
    }
  });
});

describe("Moss row in Settings → 模型账号", () => {
  const signedIn = (modelGatewayStatus?: string) => ({ authenticated: true, modelGatewayStatus });
  const signedOut = { authenticated: false };

  it("says connected, can't be reached, or unavailable from the gateway's answer", () => {
    expect(resolveMossAccountGatewayState({ accounts: [signedIn("ready")], loading: false })).toBe(
      "connected",
    );
    expect(
      resolveMossAccountGatewayState({
        accounts: [signedIn("transport-degraded"), signedOut],
        loading: false,
      }),
    ).toBe("unreachable");
    expect(
      resolveMossAccountGatewayState({ accounts: [signedIn("no-entitlement")], loading: false }),
    ).toBe("unavailable");
    // A gateway that hasn't answered yet reads like the lanes the account already has.
    expect(resolveMossAccountGatewayState({ accounts: [signedIn()], loading: false })).toBe(
      "connected",
    );
  });

  it("says signed out only once every way to sign in has answered", () => {
    expect(
      resolveMossAccountGatewayState({ accounts: [signedOut, undefined], loading: true }),
    ).toBe("checking");
    expect(
      resolveMossAccountGatewayState({ accounts: [signedOut, signedOut], loading: false }),
    ).toBe("signed-out");
  });
});
