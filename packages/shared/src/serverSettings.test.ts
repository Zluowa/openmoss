import { DEFAULT_SERVER_SETTINGS, ProviderSessionStartInput } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { providerStartOptionsFromServerSettings } from "./serverSettings";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);

describe("providerStartOptionsFromServerSettings", () => {
  it("omits blank launch settings from provider session input", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "",
          homePath: "",
        },
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          binaryPath: "",
          homePath: "",
        },
        cursor: {
          ...DEFAULT_SERVER_SETTINGS.providers.cursor,
          binaryPath: "",
          apiEndpoint: "",
        },
        gemini: {
          ...DEFAULT_SERVER_SETTINGS.providers.gemini,
          binaryPath: "",
        },
        antigravity: {
          ...DEFAULT_SERVER_SETTINGS.providers.antigravity,
          binaryPath: "",
        },
        grok: {
          ...DEFAULT_SERVER_SETTINGS.providers.grok,
          binaryPath: "",
        },
        droid: {
          ...DEFAULT_SERVER_SETTINGS.providers.droid,
          binaryPath: "",
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          binaryPath: "",
          serverUrl: "",
        },
        pi: {
          ...DEFAULT_SERVER_SETTINGS.providers.pi,
          binaryPath: "",
          agentDir: "",
        },
        devin: {
          ...DEFAULT_SERVER_SETTINGS.providers.devin,
          binaryPath: "",
        },
        hermes: {
          ...DEFAULT_SERVER_SETTINGS.providers.hermes,
          binaryPath: "",
          homePath: "",
        },
        omp: {
          ...DEFAULT_SERVER_SETTINGS.providers.omp,
          binaryPath: "",
          agentDir: "",
        },
        kimi: { ...DEFAULT_SERVER_SETTINGS.providers.kimi, binaryPath: "", homePath: "" },
        minimax: { ...DEFAULT_SERVER_SETTINGS.providers.minimax, binaryPath: "", homePath: "" },
        zcode: { ...DEFAULT_SERVER_SETTINGS.providers.zcode, binaryPath: "", homePath: "" },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerOptions,
        runtimeMode: "full-access",
      }),
    ).not.toThrow();
    expect(providerOptions.codex).toEqual({});
    expect(providerOptions.claudeAgent).toEqual({ enableArtifacts: false });
    expect(providerOptions.cursor).toEqual({});
    expect(providerOptions.antigravity).toEqual({});
    expect(providerOptions.grok).toEqual({});
    expect(providerOptions.droid).toEqual({});
    expect(providerOptions.opencode).toEqual({ experimentalWebSockets: false });
    expect(providerOptions.pi).toEqual({});
    expect(providerOptions.devin).toEqual({});
    expect(providerOptions.omp).toEqual({});
  });

  it("preserves configured launch settings", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/custom/bin/codex",
          homePath: "/custom/codex-home",
        },
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          binaryPath: "/custom/bin/claude",
          homePath: "/custom/claude-home",
        },
        opencode: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencode,
          binaryPath: "/custom/bin/opencode",
          serverUrl: "http://127.0.0.1:4096",
          experimentalWebSockets: true,
        },
        devin: {
          ...DEFAULT_SERVER_SETTINGS.providers.devin,
          binaryPath: "/custom/bin/devin",
        },
      },
    };

    const providerOptions = providerStartOptionsFromServerSettings(settings);

    expect(providerOptions.codex).toEqual({
      binaryPath: "/custom/bin/codex",
      homePath: "/custom/codex-home",
    });
    expect(providerOptions.claudeAgent).toEqual({
      binaryPath: "/custom/bin/claude",
      homePath: "/custom/claude-home",
      enableArtifacts: false,
    });
    expect(providerOptions.opencode).toEqual({
      binaryPath: "/custom/bin/opencode",
      serverUrl: "http://127.0.0.1:4096",
      experimentalWebSockets: true,
    });
    expect(providerOptions.devin).toEqual({ binaryPath: "/custom/bin/devin" });
  });

  it("uses the selected Codex account while preserving the shared provider binary", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/custom/bin/codex",
          homePath: "/shared/codex-home",
          accounts: [
            {
              id: "work",
              label: "Work",
              homePath: "",
              shadowHomePath: "/accounts/work",
            },
          ],
          selectedAccountId: "work",
        },
      },
    };

    expect(providerStartOptionsFromServerSettings(settings).codex).toEqual({
      binaryPath: "/custom/bin/codex",
      homePath: "/shared/codex-home",
      shadowHomePath: "/accounts/work",
      accountId: "work",
    });
  });
});
