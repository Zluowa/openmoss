// FILE: useRetainedManagedProviderModelOptions.test.ts
// Purpose: Locks managed-only last-known model catalog retention and removal cleanup.
// Layer: Web hook unit tests

import type { ProviderInstanceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { ProviderModelOption } from "../providerModelOptions";
import {
  reconcileManagedProviderModelOptions,
  type ManagedProviderModelCatalogCache,
  type ProviderModelCatalogInstance,
} from "./useRetainedManagedProviderModelOptions";

const CODEX_MODELS: ReadonlyArray<ProviderModelOption> = [
  { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { slug: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
];
const CLAUDE_MODELS: ReadonlyArray<ProviderModelOption> = [
  { slug: "claude-opus-4-8", name: "Claude Opus 4.8" },
];
const MANAGED_INSTANCES: ReadonlyArray<ProviderModelCatalogInstance> = [
  { instanceId: "codex_moss", provider: "codex" },
  { instanceId: "claude_moss", provider: "claudeAgent" },
];

describe("reconcileManagedProviderModelOptions", () => {
  it("retains the last committed non-empty catalog while managed instances remain", () => {
    const available = reconcileManagedProviderModelOptions({
      cache: new Map(),
      providerInstances: MANAGED_INSTANCES,
      modelOptionsByProviderInstance: {
        codex_moss: CODEX_MODELS,
        claude_moss: CLAUDE_MODELS,
      },
    });

    const unavailable = reconcileManagedProviderModelOptions({
      cache: available.cache,
      providerInstances: MANAGED_INSTANCES,
      modelOptionsByProviderInstance: {
        codex_moss: [],
        claude_moss: [],
      },
    });

    expect(unavailable.modelOptionsByProviderInstance.codex_moss).toBe(CODEX_MODELS);
    expect(unavailable.modelOptionsByProviderInstance.claude_moss).toBe(CLAUDE_MODELS);
  });

  it("replaces a retained catalog with the next non-empty managed catalog", () => {
    const first = reconcileManagedProviderModelOptions({
      cache: new Map(),
      providerInstances: MANAGED_INSTANCES,
      modelOptionsByProviderInstance: { codex_moss: CODEX_MODELS },
    });
    const refreshedModels = [{ slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" }] as const;
    const refreshed = reconcileManagedProviderModelOptions({
      cache: first.cache,
      providerInstances: MANAGED_INSTANCES,
      modelOptionsByProviderInstance: { codex_moss: refreshedModels },
    });
    const unavailable = reconcileManagedProviderModelOptions({
      cache: refreshed.cache,
      providerInstances: MANAGED_INSTANCES,
      modelOptionsByProviderInstance: { codex_moss: [] },
    });

    expect(unavailable.modelOptionsByProviderInstance.codex_moss).toBe(refreshedModels);
  });

  it("clears retention when the managed instance is removed", () => {
    const available = reconcileManagedProviderModelOptions({
      cache: new Map(),
      providerInstances: MANAGED_INSTANCES,
      modelOptionsByProviderInstance: { codex_moss: CODEX_MODELS },
    });
    const removed = reconcileManagedProviderModelOptions({
      cache: available.cache,
      providerInstances: [],
      modelOptionsByProviderInstance: {},
    });
    const readded = reconcileManagedProviderModelOptions({
      cache: removed.cache,
      providerInstances: [{ instanceId: "codex_moss", provider: "codex" }],
      modelOptionsByProviderInstance: { codex_moss: [] },
    });

    expect(removed.cache.size).toBe(0);
    expect(readded.modelOptionsByProviderInstance.codex_moss).toEqual([]);
  });

  it.each([
    ["codex", "codex"],
    ["opencode_moss", "opencode"],
  ] as const)("does not retain a non-managed %s source", (instanceId, provider) => {
    const providerInstances: ReadonlyArray<ProviderModelCatalogInstance> = [
      { instanceId: instanceId as ProviderInstanceId, provider },
    ];
    const available = reconcileManagedProviderModelOptions({
      cache: new Map(),
      providerInstances,
      modelOptionsByProviderInstance: { [instanceId]: CODEX_MODELS },
    });
    const unavailable = reconcileManagedProviderModelOptions({
      cache: available.cache,
      providerInstances,
      modelOptionsByProviderInstance: { [instanceId]: [] },
    });

    expect(available.cache.size).toBe(0);
    expect(unavailable.modelOptionsByProviderInstance[instanceId]).toEqual([]);
  });

  it("drops a cached entry when the instance id no longer has its managed provider pairing", () => {
    const staleCache: ManagedProviderModelCatalogCache = new Map([
      ["codex_moss", { provider: "codex", options: CODEX_MODELS }],
    ]);
    const reconciled = reconcileManagedProviderModelOptions({
      cache: staleCache,
      providerInstances: [{ instanceId: "codex_moss", provider: "claudeAgent" }],
      modelOptionsByProviderInstance: { codex_moss: [] },
    });

    expect(reconciled.cache.size).toBe(0);
    expect(reconciled.modelOptionsByProviderInstance.codex_moss).toEqual([]);
  });
});
