import type { ServerProviderStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveComposerProviderSources,
  type ProviderInstancePickerProps,
} from "./ProviderInstancePicker";
import type { ProviderModelPickerInstance } from "./ProviderModelPicker";

const instances: ProviderInstancePickerProps["providerInstances"] = [
  {
    instanceId: "codex_moss",
    provider: "codex",
    label: "Moss Codex",
    enabled: true,
    isDefault: false,
  },
  {
    instanceId: "codex",
    provider: "codex",
    label: "Default",
    enabled: true,
    isDefault: true,
  },
  {
    instanceId: "codex_2",
    provider: "codex",
    label: "备用 Codex",
    enabled: false,
    isDefault: false,
  },
  {
    instanceId: "claudeAgent",
    provider: "claudeAgent",
    label: "Claude",
    enabled: true,
    isDefault: true,
  },
];

function status(
  instance: ProviderModelPickerInstance,
  authenticated: boolean,
): ServerProviderStatus {
  return {
    provider: instance.provider,
    instanceId: instance.instanceId,
    driver: instance.provider,
    displayName: instance.label,
    status: authenticated ? "ready" : "error",
    available: authenticated,
    authStatus: authenticated ? "authenticated" : "unauthenticated",
    checkedAt: "2026-07-12T12:00:00.000Z",
  };
}

describe("resolveComposerProviderSources", () => {
  const unsortedDefaultInstances: ReadonlyArray<ProviderModelPickerInstance> = [
    { instanceId: "grok_moss", provider: "grok", label: "Moss", enabled: true, isDefault: false },
    instances[1]!,
    {
      instanceId: "opencode_moss",
      provider: "opencode",
      label: "Moss",
      enabled: true,
      isDefault: false,
    },
    instances[3]!,
    instances[0]!,
  ];

  it("uses the product default agent order regardless of provider inventory order", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: unsortedDefaultInstances,
        providers: unsortedDefaultInstances.map((instance) => status(instance, true)),
        selectedProviderInstanceId: "codex_moss",
      }).map(({ instanceId }) => instanceId),
    ).toEqual(["codex_moss", "codex", "claudeAgent", "opencode_moss", "grok_moss"]);
  });

  it("respects the user's agent order while retaining source priority within each agent", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: unsortedDefaultInstances,
        providers: unsortedDefaultInstances.map((instance) => status(instance, true)),
        providerOrder: ["grok", "opencode", "claudeAgent", "codex"],
        selectedProviderInstanceId: "codex_moss",
      }).map(({ instanceId }) => instanceId),
    ).toEqual(["grok_moss", "opencode_moss", "claudeAgent", "codex_moss", "codex"]);
  });

  it("offers the provisioned Pi SDK route without requiring a separate Pi login", () => {
    const piMoss: ProviderModelPickerInstance = {
      instanceId: "pi_moss",
      provider: "pi",
      label: "Moss",
      enabled: true,
      isDefault: false,
    };
    const personalPi = { ...piMoss, instanceId: "pi" as const, isDefault: true };
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [piMoss, personalPi],
        providers: [piMoss, personalPi].map((instance) => ({
          ...status(instance, true),
          authStatus: "unknown" as const,
        })),
        selectedProviderInstanceId: "codex_moss",
      }).map(({ instanceId }) => instanceId),
    ).toEqual(["pi_moss"]);

    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [{ ...piMoss, enabled: false }],
        providers: [{ ...status(piMoss, true), authStatus: "unknown" }],
        selectedProviderInstanceId: "codex_moss",
      }),
    ).toEqual([]);
  });

  it("discovers authenticated default agents without saved provider instances", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [],
        providers: [status(instances[3]!, true), status(instances[1]!, true)],
        selectedProviderInstanceId: "codex",
      }).map(({ instanceId, provider, isDefault }) => ({ instanceId, provider, isDefault })),
    ).toEqual([
      { instanceId: "codex", provider: "codex", isDefault: true },
      { instanceId: "claudeAgent", provider: "claudeAgent", isDefault: true },
    ]);
  });

  it("recognizes a legacy default status without an instance id", () => {
    const { instanceId: _instanceId, ...claudeStatus } = status(instances[3]!, true);

    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [],
        providers: [claudeStatus as ReturnType<typeof status>],
        selectedProviderInstanceId: "codex",
      }).map(({ instanceId }) => instanceId),
    ).toEqual(["claudeAgent"]);
  });

  it.each([{ providerInstances: [] }, { providerInstances: [instances[3]!] }])(
    "respects hidden agents with saved instances %j",
    ({ providerInstances }) => {
      expect(
        resolveComposerProviderSources({
          provider: "codex",
          providerInstances,
          providers: [status(instances[1]!, true), status(instances[3]!, true)],
          hiddenProviders: ["claudeAgent"],
          selectedProviderInstanceId: "codex",
        }).map(({ instanceId }) => instanceId),
      ).toEqual(["codex"]);
    },
  );

  it("keeps the current agent visible when it is hidden from other threads", () => {
    expect(
      resolveComposerProviderSources({
        provider: "claudeAgent",
        providerInstances: [],
        providers: [status(instances[3]!, true)],
        hiddenProviders: ["claudeAgent"],
        selectedProviderInstanceId: "claudeAgent",
        selectionLocked: true,
      }).map(({ instanceId }) => instanceId),
    ).toEqual(["claudeAgent"]);
  });

  it.each([
    { available: false },
    { authStatus: "unauthenticated" as const },
    { authStatus: "unknown" as const },
    { enabled: false },
  ])("does not discover an unusable personal default: %j", (overrides) => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [],
        providers: [{ ...status(instances[3]!, true), ...overrides }],
        selectedProviderInstanceId: "codex",
      }),
    ).toEqual([]);
  });

  it("does not infer personal authentication from managed or custom account status", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [],
        providers: [
          { ...status(instances[3]!, true), instanceId: "claude_moss" },
          { ...status(instances[3]!, true), instanceId: "claude_kimi" },
        ],
        selectedProviderInstanceId: "codex",
      }),
    ).toEqual([]);
  });

  it("does not replace an explicitly disabled default with a discovered one", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [{ ...instances[3]!, enabled: false }],
        providers: [status(instances[3]!, true)],
        selectedProviderInstanceId: "codex",
      }),
    ).toEqual([]);
  });

  it("respects a disabled live status even when the saved instance is enabled", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [instances[3]!],
        providers: [{ ...status(instances[3]!, true), enabled: false }],
        selectedProviderInstanceId: "codex",
      }),
    ).toEqual([]);
  });

  it("keeps only ready managed and personal routes", () => {
    const providers = [
      { ...status(instances[0]!, true), authStatus: "unknown" as const },
      status(instances[1]!, true),
      status(instances[2]!, false),
      status(instances[3]!, false),
    ];

    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: instances,
        providers,
        selectedProviderInstanceId: "codex_moss",
      }).map(({ instanceId, label }) => ({ instanceId, label })),
    ).toEqual([
      { instanceId: "codex_moss", label: "Moss Codex" },
      { instanceId: "codex", label: "Default" },
    ]);
  });

  it("adds Claude only after its own account is authenticated", () => {
    const providers = instances.map((instance) => status(instance, instance.enabled));

    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: instances,
        providers,
        selectedProviderInstanceId: "codex_moss",
      }).map(({ label }) => label),
    ).toEqual(["Moss Codex", "Default", "Claude"]);
  });

  it("retains a managed route for each Agent instead of collapsing both into Moss", () => {
    const claudeMossInstance: ProviderModelPickerInstance = {
      instanceId: "claude_moss",
      provider: "claudeAgent",
      label: "Moss Claude",
      enabled: true,
      isDefault: false,
    };
    const providers = [
      { ...status(instances[0]!, true), authStatus: "unknown" as const },
      { ...status(claudeMossInstance, true), authStatus: "unknown" as const },
    ];

    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [instances[0]!, claudeMossInstance],
        providers,
        selectedProviderInstanceId: "codex_moss",
      }).map(({ instanceId }) => instanceId),
    ).toEqual(["codex_moss", "claude_moss"]);
  });

  it("adds the isolated Kimi channel only after its own status is authenticated", () => {
    const kimiInstance: ProviderModelPickerInstance = {
      instanceId: "claude_kimi",
      provider: "claudeAgent",
      label: "Kimi",
      enabled: true,
      isDefault: false,
    };
    const providers = [
      { ...status(instances[0]!, true), authStatus: "unknown" as const },
      status(instances[1]!, true),
      status(instances[3]!, false),
      status(kimiInstance, true),
    ];

    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [...instances, kimiInstance],
        providers,
        selectedProviderInstanceId: "codex_moss",
      }).map(({ instanceId, label }) => ({ instanceId, label })),
    ).toContainEqual({ instanceId: "claude_kimi", label: "Kimi" });
  });

  it("does not invent Moss and hides disabled inventory records", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: instances.slice(1),
        providers: [status(instances[1]!, true), status(instances[3]!, false)],
        selectedProviderInstanceId: "codex",
      }).map(({ label }) => label),
    ).toEqual(["Default"]);
  });

  it("does not keep an unavailable selected source in an unlocked draft", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: instances,
        providers: [
          { ...status(instances[0]!, true), authStatus: "unknown" },
          status(instances[1]!, true),
          status(instances[2]!, false),
          status(instances[3]!, false),
        ],
        selectedProviderInstanceId: "codex_2",
      }).map(({ instanceId }) => instanceId),
    ).toEqual(["codex_moss", "codex"]);
  });

  it("retains an unavailable selected source only for an identity-locked thread", () => {
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: instances,
        providers: [
          { ...status(instances[0]!, true), authStatus: "unknown" },
          status(instances[1]!, true),
          status(instances[2]!, false),
          status(instances[3]!, false),
        ],
        selectedProviderInstanceId: "codex_2",
        selectionLocked: true,
      }).map(({ instanceId }) => instanceId),
    ).toContain("codex_2");
  });

  it("keeps API-key access distinct from the managed Moss source", () => {
    const byokInstance: ProviderModelPickerInstance = {
      instanceId: "codex_byok",
      provider: "codex",
      label: "Moss BYOK",
      enabled: true,
      isDefault: false,
    };
    expect(
      resolveComposerProviderSources({
        provider: "codex",
        providerInstances: [...instances, byokInstance],
        providers: [
          { ...status(instances[0]!, true), authStatus: "unknown" },
          status(instances[1]!, true),
          { ...status(byokInstance, true), authStatus: "unknown" },
          status(instances[3]!, false),
        ],
        selectedProviderInstanceId: "codex_moss",
      }).map(({ instanceId, label }) => ({ instanceId, label })),
    ).toContainEqual({ instanceId: "codex_byok", label: "Moss BYOK" });
  });
});
