import type { ProviderInstanceId } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  isMossGatewayUnreachableState,
  resolveMossAccountGatewayState,
} from "../auth/useMossGatewayUnreachable";
import { providerReadinessDescriptionKey } from "~/lib/providerReadinessCopy";
import { translateMoss } from "~/localization";
import {
  composerAccountName,
  composerSourceListsModels,
  composerSourceTitle,
  resolveComposerModelPickerProviderTabs,
} from "./ComposerModelPickerTabs";
import { providersServedByMoss } from "./providerAccountSources";

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

describe("Claude over Moss", () => {
  const claudeOptions = [{ value: "claudeAgent" as const, label: "Claude" }];
  const instances = [
    {
      instanceId: id("claudeAgent"),
      provider: "claudeAgent" as const,
      label: "Claude",
      enabled: true,
      isDefault: true,
    },
    {
      instanceId: id("claude_moss"),
      provider: "claudeAgent" as const,
      label: "Moss Claude",
      enabled: true,
      isDefault: false,
    },
  ];
  const status = (instanceId: string, signedIn: boolean) =>
    ({
      provider: "claudeAgent",
      instanceId,
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: null,
      status: signedIn ? "ready" : "warning",
      available: true,
      authStatus: signedIn ? "authenticated" : "unauthenticated",
      checkedAt: "2026-11-11T00:00:00.000Z",
      models: [],
      ...(signedIn ? {} : { readiness: { state: "needsLogin", reason: "agent-sign-in" } }),
    }) as unknown as Parameters<typeof providersServedByMoss>[0][number];
  const providers = [status("claudeAgent", false), status("claude_moss", true)];

  it("names the Moss lane Moss, like every other agent's", () => {
    expect(composerAccountName(instances[1]!)).toBe("Moss");
    expect(composerAccountName(instances[0]!)).toBe("Claude");
  });

  it("lists no 登录 row for the local login while Moss runs Claude", () => {
    const tabs = resolveComposerModelPickerProviderTabs({
      options: claudeOptions,
      providers,
      providerInstances: instances,
    });
    expect(tabs.map((tab) => tab.instanceId)).toEqual(["claude_moss"]);
    expect(tabs[0]?.name).toBe("Moss");
    expect(tabs[0]?.label).not.toContain("Moss Claude");
    expect(providersServedByMoss(providers).has("claudeAgent")).toBe(true);
  });

  // The four cases of 本机账号 next to Moss: the picker lists what can run now, plus the
  // Moss sign-in while signed out of Moss. Signing in to the own account is in Settings.
  const rows = (providerStatuses: ReturnType<typeof status>[], signedInToMoss: boolean) =>
    resolveComposerModelPickerProviderTabs({
      options: claudeOptions,
      providers: providerStatuses,
      providerInstances: signedInToMoss ? instances : instances.slice(0, 1),
    }).map((tab) => [tab.instanceId, tab.name, tab.readiness.state, tab.mossSignIn]);

  it("lists Moss and 本机账号 once the own Claude account is signed in too", () => {
    expect(rows([status("claudeAgent", true), status("claude_moss", true)], true)).toEqual([
      ["claude_moss", "Moss", "ready", false],
      ["claudeAgent", "Claude", "ready", false],
    ]);
    // The provider rows read Moss, then 本机账号, and both list models.
    const tabs = resolveComposerModelPickerProviderTabs({
      options: claudeOptions,
      providers: [status("claudeAgent", true), status("claude_moss", true)],
      providerInstances: instances,
    });
    const localAccount = translateMoss("zh-CN", "chat.modelPicker.source.local");
    expect(tabs.map((tab) => composerSourceTitle(tab, localAccount))).toEqual(["Moss", "本机账号"]);
    expect(tabs.every(composerSourceListsModels)).toBe(true);
  });

  it("lists only Moss while the own account is signed out and Moss runs Claude", () => {
    expect(rows([status("claudeAgent", false), status("claude_moss", true)], true)).toEqual([
      ["claude_moss", "Moss", "ready", false],
    ]);
  });

  it("lists the own account next to Moss's sign-in when only the own account is signed in", () => {
    expect(rows([status("claudeAgent", true)], false)).toEqual([
      ["claude_moss", "Moss", "needsLogin", true],
      ["claudeAgent", null, "ready", false],
    ]);
  });

  it("keeps both sign-ins when neither Moss nor the own account is signed in", () => {
    expect(rows([status("claudeAgent", false)], false)).toEqual([
      ["claude_moss", "Moss", "needsLogin", true],
      ["claudeAgent", null, "needsLogin", false],
    ]);
  });

  it("keeps the local login listed while the chat runs on it", () => {
    const tabs = resolveComposerModelPickerProviderTabs({
      options: claudeOptions,
      providers,
      providerInstances: instances,
      activeInstanceId: id("claudeAgent"),
    });
    expect(tabs.map((tab) => tab.instanceId).toSorted()).toEqual(["claudeAgent", "claude_moss"]);
    // Two accounts, so each names itself: the Moss one as Moss, never "Moss Claude".
    expect(tabs.find((tab) => tab.instanceId === "claude_moss")?.name).toBe("Moss");
  });
});
