import {
  SUPPORTED_PROVIDER_KINDS,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isUnsupportedProviderInstanceStatus,
  resolveLiveProviderAvailability,
  resolveVisibleProviderOptions,
} from "./ProviderModelPicker";

function statusFor(
  provider: ProviderKind,
  overrides: Partial<ServerProviderStatus> = {},
): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  } as ServerProviderStatus;
}

const visibleValues = (
  input: Parameters<typeof resolveVisibleProviderOptions>[0],
): ReadonlyArray<ProviderKind> =>
  resolveVisibleProviderOptions(input).map((option) => option.value);

describe("resolveVisibleProviderOptions", () => {
  it("offers all eleven enabled CLIs through the shared chat, Images and automation picker", () => {
    expect(
      visibleValues({
        provider: "codex",
        lockedProvider: null,
        providers: SUPPORTED_PROVIDER_KINDS.map((provider) => statusFor(provider)),
        hiddenProviders: [],
        providerOrder: [...SUPPORTED_PROVIDER_KINDS],
      }),
    ).toEqual([...SUPPORTED_PROVIDER_KINDS]);
  });

  it.each(SUPPORTED_PROVIDER_KINDS)(
    "keeps %s sign-in and availability failures disabled",
    (provider) => {
      expect(resolveLiveProviderAvailability(statusFor(provider), true).disabled).toBe(false);
      expect(
        resolveLiveProviderAvailability(
          statusFor(provider, {
            available: false,
            authStatus: "unauthenticated",
          }),
          true,
        ),
      ).toEqual({ disabled: true, label: "Sign in" });
    },
  );

  it("keeps an unknown ACP driver visible as a disabled missing-driver entry", () => {
    const missing: ServerProviderStatus = {
      ...statusFor("opencode"),
      provider: "privateAcp",
      driver: "privateAcp",
      instanceId: "private_acp",
      enabled: false,
      available: false,
      availability: "unavailable",
      status: "error",
      authStatus: "unknown",
    };
    expect(isUnsupportedProviderInstanceStatus(missing)).toBe(true);
    expect(resolveLiveProviderAvailability(missing, true)).toEqual({
      disabled: true,
      label: "Unavailable",
    });
    expect(
      visibleValues({
        provider: "codex",
        lockedProvider: null,
        providers: [missing],
        hiddenProviders: [],
        providerOrder: undefined,
      }),
    ).not.toContain("opencode");
  });
  it("keeps the built-in defaults visible while provider statuses are pending", () => {
    const values = visibleValues({
      provider: "opencode",
      lockedProvider: null,
      providers: undefined,
      hiddenProviders: undefined,
      providerOrder: undefined,
    });
    expect(values).toContain("codex");
    expect(values).toContain("claudeAgent");
    // Nothing else may enter before the server projects a status for it.
    expect(values).not.toContain("gemini");
    expect(values).not.toContain("grok");
  });

  it("keeps a provider visible when its projected status is unavailable", () => {
    // Regression: an installed-but-unavailable local CLI (e.g. Claude failing its
    // probe) must stay in the picker so its tab can say why and offer setup,
    // instead of silently vanishing.
    const values = visibleValues({
      provider: "codex",
      lockedProvider: null,
      providers: [
        statusFor("codex"),
        statusFor("gemini", {
          status: "error",
          available: false,
          authStatus: "unknown",
          message: "Gemini CLI is not installed or not on PATH.",
        }),
      ],
      hiddenProviders: undefined,
      providerOrder: undefined,
    });
    expect(values).toContain("gemini");
  });

  it("keeps a provider visible when its projected status is unauthenticated", () => {
    const values = visibleValues({
      provider: "codex",
      lockedProvider: null,
      providers: [
        statusFor("codex"),
        statusFor("grok", { available: false, authStatus: "unauthenticated" }),
      ],
      hiddenProviders: undefined,
      providerOrder: undefined,
    });
    expect(values).toContain("grok");
  });

  it("hides providers the server has never projected a status for", () => {
    const values = visibleValues({
      provider: "codex",
      lockedProvider: null,
      providers: [statusFor("codex")],
      hiddenProviders: undefined,
      providerOrder: undefined,
    });
    expect(values).not.toContain("gemini");
    expect(values).not.toContain("opencode");
  });

  it("hides providers whose only projected status is disabled", () => {
    const values = visibleValues({
      provider: "codex",
      lockedProvider: null,
      providers: [statusFor("codex"), statusFor("gemini", { enabled: false, available: false })],
      hiddenProviders: undefined,
      providerOrder: undefined,
    });
    expect(values).not.toContain("gemini");
  });

  it("matches statuses by driver, so a managed account's status keeps its provider visible", () => {
    // A Moss-managed instance (e.g. claude_moss) reports driver claudeAgent under its
    // own instance id; the local default instance may have no status of its own.
    const values = visibleValues({
      provider: "codex",
      lockedProvider: null,
      providers: [
        statusFor("codex"),
        statusFor("gemini", { instanceId: "gemini_moss" as ServerProviderStatus["instanceId"] }),
      ],
      hiddenProviders: undefined,
      providerOrder: undefined,
    });
    expect(values).toContain("gemini");
  });

  it("respects hidden providers except the active and locked ones", () => {
    const providers = [statusFor("codex"), statusFor("claudeAgent"), statusFor("gemini")];
    const values = visibleValues({
      provider: "claudeAgent",
      lockedProvider: "gemini",
      providers,
      hiddenProviders: ["claudeAgent", "gemini", "codex"],
      providerOrder: undefined,
    });
    expect(values).toContain("claudeAgent");
    expect(values).toContain("gemini");
    expect(values).not.toContain("codex");
  });
});
