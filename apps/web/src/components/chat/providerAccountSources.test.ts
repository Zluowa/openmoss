import type { ProviderInstanceId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isMossManagedSourceInstanceId,
  isMossProtectedSourceInstanceId,
  resolveComposerAccountSourceKind,
  resolveComposerModelSourceProviders,
  resolveLinkedSourceProviderInstanceId,
  resolveProviderInstanceIdForProviderSwitch,
} from "./providerAccountSources";

describe("resolveComposerAccountSourceKind", () => {
  it("uses the compact Moss and personal-account source vocabulary", () => {
    expect(resolveComposerAccountSourceKind({ instanceId: "codex_moss", provider: "codex" })).toBe(
      "moss",
    );
    expect(resolveComposerAccountSourceKind({ instanceId: "codex", provider: "codex" })).toBe(
      "personal",
    );
    expect(
      resolveComposerAccountSourceKind({ instanceId: "claudeAgent", provider: "claudeAgent" }),
    ).toBe("personal");
    // The retired Moss Key id stays Moss-protected until startup cleanup removes it.
    expect(resolveComposerAccountSourceKind({ instanceId: "codex_byok", provider: "codex" })).toBe(
      "moss",
    );
    expect(
      resolveComposerAccountSourceKind({ instanceId: "opencode_moss", provider: "opencode" }),
    ).toBe("moss");
  });
});

describe("Moss source identity boundaries", () => {
  it("recognizes first-batch OpenCode as a protected managed source", () => {
    expect(isMossManagedSourceInstanceId("opencode_moss")).toBe(true);
    expect(isMossProtectedSourceInstanceId("opencode_moss")).toBe(true);
  });

  it("recognizes provisioned Pi as a protected Moss source", () => {
    expect(isMossManagedSourceInstanceId("pi_moss")).toBe(true);
    expect(isMossProtectedSourceInstanceId("pi_moss")).toBe(true);
    expect(resolveComposerAccountSourceKind({ instanceId: "pi_moss", provider: "pi" })).toBe(
      "moss",
    );
    expect(isMossProtectedSourceInstanceId("pi_personal")).toBe(false);
  });
});

const instances = [
  { instanceId: "codex_moss", provider: "codex" },
  { instanceId: "claude_moss", provider: "claudeAgent" },
  { instanceId: "opencode_moss", provider: "opencode" },
  { instanceId: "pi_moss", provider: "pi" },
  { instanceId: "grok_moss", provider: "grok" },
  { instanceId: "hermes_moss", provider: "hermes" },
  { instanceId: "kimi_moss", provider: "kimi" },
  { instanceId: "minimax_moss", provider: "minimax" },
  { instanceId: "zcode_moss", provider: "zcode" },
  { instanceId: "codex", provider: "codex" },
  { instanceId: "claudeAgent", provider: "claudeAgent" },
] as const;

describe("resolveComposerModelSourceProviders", () => {
  it("shows only managed Codex and Claude for Moss", () => {
    expect(
      resolveComposerModelSourceProviders({
        selectedProviderInstanceId: "codex_moss",
        selectedProvider: "codex",
        providerInstances: instances,
      }),
    ).toEqual(["codex", "claudeAgent"]);
  });

  it("keeps personal account model menus inside their provider", () => {
    expect(
      resolveComposerModelSourceProviders({
        selectedProviderInstanceId: "codex",
        selectedProvider: "codex",
        providerInstances: instances,
      }),
    ).toEqual(["codex"]);
    expect(
      resolveComposerModelSourceProviders({
        selectedProviderInstanceId: "claudeAgent",
        selectedProvider: "claudeAgent",
        providerInstances: instances,
      }),
    ).toEqual(["claudeAgent"]);
  });

  it("keeps a legacy OpenCode source scoped to its own provider", () => {
    expect(
      resolveComposerModelSourceProviders({
        selectedProviderInstanceId: "opencode_moss",
        selectedProvider: "opencode",
        providerInstances: instances,
      }),
    ).toEqual(["opencode"]);
  });

  it("keeps managed Pi models scoped to the Pi engine", () => {
    expect(
      resolveComposerModelSourceProviders({
        selectedProviderInstanceId: "pi_moss",
        selectedProvider: "pi",
        providerInstances: instances,
      }),
    ).toEqual(["pi"]);
  });
});

describe("resolveLinkedSourceProviderInstanceId", () => {
  it("preserves Moss when switching to Pi or back to Codex", () => {
    for (const [activeInstanceId, targetProvider, expected] of [
      ["codex_moss", "pi", "pi_moss"],
      ["pi_moss", "codex", "codex_moss"],
      ["codex_moss", "opencode", "opencode_moss"],
      ["codex_moss", "grok", "grok_moss"],
      ["grok_moss", "hermes", "hermes_moss"],
      ["hermes_moss", "codex", "codex_moss"],
      ["codex_moss", "kimi", "kimi_moss"],
      ["kimi_moss", "minimax", "minimax_moss"],
      ["minimax_moss", "zcode", "zcode_moss"],
      ["zcode_moss", "codex", "codex_moss"],
    ] as const) {
      expect(
        resolveLinkedSourceProviderInstanceId({
          activeInstanceId,
          targetProvider,
          providerInstances: instances,
          isSelectable: () => true,
        }),
      ).toBe(expected);
    }
    expect(
      resolveProviderInstanceIdForProviderSwitch({
        activeProvider: "codex",
        activeInstanceId: "codex_moss",
        targetProvider: "pi",
        targetInstances: [{ instanceId: "pi", isDefault: true }],
        isSelectable: () => true,
      }),
    ).toBe("pi_moss");
  });

  it("keeps Codex and Claude model choices inside the managed Moss source", () => {
    expect(
      resolveLinkedSourceProviderInstanceId({
        activeInstanceId: "codex_moss",
        targetProvider: "claudeAgent",
        providerInstances: instances,
        isSelectable: () => true,
      }),
    ).toBe("claude_moss");
    expect(
      resolveLinkedSourceProviderInstanceId({
        activeInstanceId: "claude_moss",
        targetProvider: "codex",
        providerInstances: instances,
        isSelectable: () => true,
      }),
    ).toBe("codex_moss");
    expect(
      resolveLinkedSourceProviderInstanceId({
        activeInstanceId: "codex_moss",
        targetProvider: "opencode",
        providerInstances: instances,
        isSelectable: () => true,
      }),
    ).toBe("opencode_moss");
  });

  it("does not silently fall back to a personal account when the linked source is unavailable", () => {
    expect(
      resolveLinkedSourceProviderInstanceId({
        activeInstanceId: "codex_moss",
        targetProvider: "claudeAgent",
        providerInstances: instances,
        isSelectable: (instanceId: ProviderInstanceId) => instanceId !== "claude_moss",
      }),
    ).toBeUndefined();

    expect(
      resolveProviderInstanceIdForProviderSwitch({
        activeProvider: "codex",
        activeInstanceId: "codex_moss",
        targetProvider: "claudeAgent",
        targetInstances: [
          { instanceId: "claudeAgent", isDefault: true },
          { instanceId: "claude_moss", isDefault: false },
        ],
        isSelectable: (instanceId: ProviderInstanceId) => instanceId === "claudeAgent",
      }),
    ).toBe("claude_moss");
  });

  it("does not group API-key or personal accounts into the managed Moss family", () => {
    for (const activeInstanceId of ["codex_byok", "codex", "claudeAgent"] as const) {
      expect(
        resolveLinkedSourceProviderInstanceId({
          activeInstanceId,
          targetProvider: "claudeAgent",
          providerInstances: instances,
          isSelectable: () => true,
        }),
      ).toBeUndefined();
    }
  });
});
