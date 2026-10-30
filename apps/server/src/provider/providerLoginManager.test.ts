import type { ProviderInstanceId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildClaudeLoginEnvironment,
  buildCodexLoginEnvironment,
  createClaudeBrowserPromptResponder,
  makeProviderLoginManager,
  ProviderLoginAlreadyRunningError,
  type ProviderLoginCompletion,
  type ProviderLoginProcessRunner,
} from "./providerLoginManager.ts";

function instanceId(value: string): ProviderInstanceId {
  return value as ProviderInstanceId;
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("providerLoginManager", () => {
  it("removes Moss and Codex direct credentials while retaining account routing", () => {
    const result = buildCodexLoginEnvironment({
      authoritativeAuthHomePath: "/accounts/codex-work",
      environment: {
        PATH: "/bin",
        HOME: "/users/moss",
        CODEX_HOME: "/overlaid/codex-home",
        OPENAI_API_KEY: "direct-openai-secret",
        OPENAI_BASE_URL: "https://relay.invalid/v1",
        CODEX_ACCESS_TOKEN: "direct-codex-token",
        CUSTOM_PROVIDER_TOKEN: "custom-direct-secret",
        MOSS_ACCESS_TOKEN: "server-session-secret",
        MOSS_MODEL_GATEWAY_API_KEY: "server-gateway-secret",
        MOSS_PRODUCTION_CONFIG_VERSION: "2",
        MOSS_MEMFIRE_PHONE_URL: "https://cn-auth.example.test",
        MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: "cn-publishable-test-key",
        MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: "https://cn-gateway.example.test",
        MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL: "https://cn-realtime.example.test",
        MOSS_SUPABASE_GOOGLE_URL: "https://global-auth.example.test",
        MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY: "global-publishable-test-key",
        MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL: "moss://auth/callback",
        MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: "https://global-gateway.example.test",
        MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL: "https://global-realtime.example.test",
      },
    });

    expect(result).toMatchObject({
      PATH: "/bin",
      HOME: "/users/moss",
      CODEX_HOME: "/accounts/codex-work",
    });
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.OPENAI_BASE_URL).toBeUndefined();
    expect(result.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(result.CUSTOM_PROVIDER_TOKEN).toBeUndefined();
    expect(result.MOSS_ACCESS_TOKEN).toBeUndefined();
    expect(result.MOSS_MODEL_GATEWAY_API_KEY).toBeUndefined();
    expect(result.MOSS_PRODUCTION_CONFIG_VERSION).toBeUndefined();
    expect(result.MOSS_MEMFIRE_PHONE_URL).toBeUndefined();
    expect(result.MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY).toBeUndefined();
    expect(result.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL).toBeUndefined();
    expect(result.MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL).toBeUndefined();
    expect(result.MOSS_SUPABASE_GOOGLE_URL).toBeUndefined();
    expect(result.MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY).toBeUndefined();
    expect(result.MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL).toBeUndefined();
    expect(result.MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL).toBeUndefined();
    expect(result.MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL).toBeUndefined();
  });

  it("removes Claude direct and external auth without changing the isolated home", () => {
    const result = buildClaudeLoginEnvironment({
      PATH: "/bin",
      HOME: "/accounts/claude-work",
      CLAUDE_CONFIG_DIR: "/accounts/claude-work/.claude",
      ANTHROPIC_API_KEY: "direct-anthropic-secret",
      ANTHROPIC_BASE_URL: "https://relay.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_ACCESS_KEY_ID: "aws-key",
      MOSS_MODEL_GATEWAY_CLAUDE_API_KEY: "server-gateway-secret",
      MOSS_MEMFIRE_PHONE_URL: "https://cn-auth.example.test",
      MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: "cn-publishable-test-key",
      MOSS_SUPABASE_GOOGLE_URL: "https://global-auth.example.test",
      MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY: "global-publishable-test-key",
    });

    expect(result).toMatchObject({
      PATH: "/bin",
      HOME: "/accounts/claude-work",
      CLAUDE_CONFIG_DIR: "/accounts/claude-work/.claude",
    });
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(result.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(result.MOSS_MODEL_GATEWAY_CLAUDE_API_KEY).toBeUndefined();
    expect(result.MOSS_MEMFIRE_PHONE_URL).toBeUndefined();
    expect(result.MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY).toBeUndefined();
    expect(result.MOSS_SUPABASE_GOOGLE_URL).toBeUndefined();
    expect(result.MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY).toBeUndefined();
  });

  it("runs the provider-specific command and enforces one active login per instance", async () => {
    const pending = deferred<ProviderLoginCompletion>();
    const cancel = vi.fn();
    const runCodex = vi.fn<ProviderLoginProcessRunner>(() => ({
      completion: pending.promise,
      cancel,
    }));
    const manager = makeProviderLoginManager({ runCodex });
    const target = {
      provider: "codex" as const,
      instanceId: instanceId("codex_work"),
      executable: "/opt/bin/codex",
      cwd: "/workspace",
      env: { CODEX_HOME: "/accounts/work" },
    };

    const handle = manager.start(target);
    expect(runCodex).toHaveBeenCalledWith({
      ...target,
      args: ["login", "-c", 'cli_auth_credentials_store="file"'],
    });
    expect(() => manager.start(target)).toThrow(ProviderLoginAlreadyRunningError);
    expect(() =>
      manager.start({
        ...target,
        provider: "claudeAgent",
        instanceId: instanceId("claude_personal"),
        executable: "claude",
      }),
    ).toThrow(ProviderLoginAlreadyRunningError);
    expect(manager.hasRunning()).toBe(true);

    manager.cancel(target);
    expect(cancel).toHaveBeenCalledOnce();
    pending.resolve({ status: "succeeded" });
    await expect(handle.completion).resolves.toEqual({ status: "cancelled" });
    expect(manager.isRunning(target)).toBe(false);
    expect(manager.hasRunning()).toBe(false);
  });

  it("uses a PTY runner for Claude and releases the single-flight slot on completion", async () => {
    const pending = deferred<ProviderLoginCompletion>();
    const runClaude = vi.fn<ProviderLoginProcessRunner>(() => ({
      completion: pending.promise,
      cancel: vi.fn(),
    }));
    const manager = makeProviderLoginManager({ runClaude });
    const target = {
      provider: "claudeAgent" as const,
      instanceId: instanceId("claude_work"),
      executable: "/opt/bin/claude",
      cwd: "/workspace",
      env: { HOME: "/accounts/claude-work" },
    };

    const handle = manager.start(target);
    expect(runClaude).toHaveBeenCalledWith({
      ...target,
      args: ["auth", "login", "--claudeai"],
    });
    pending.resolve({ status: "succeeded" });
    await expect(handle.completion).resolves.toEqual({ status: "succeeded" });

    expect(() => manager.start(target)).not.toThrow();
  });

  it("submits the Claude browser prompt exactly once, including across PTY chunks", () => {
    const write = vi.fn();
    const respond = createClaudeBrowserPromptResponder(write);

    respond("\u001b[1mPress EN");
    respond("TER to open Claude.ai in your browser\u001b[0m");
    respond("Press ENTER to open Claude.ai in your browser");

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\r");
  });
});
