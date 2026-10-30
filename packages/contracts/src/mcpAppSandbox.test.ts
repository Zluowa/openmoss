import { describe, expect, it } from "vitest";

import {
  MCP_APP_FRAME_DEFAULT_HEIGHT,
  MCP_APP_FRAME_MAX_HEIGHT,
  MCP_APP_FRAME_MIN_HEIGHT,
  MCP_APP_SANDBOX_ACK_TYPE,
  MCP_APP_SANDBOX_GUEST_INIT_TYPE,
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_MAX_CSP_CHARS,
  MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
  MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
  MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
  MCP_APP_SANDBOX_PENDING_TTL_MS,
  MCP_APP_SANDBOX_PORT_NAME,
  MCP_APP_SANDBOX_PORT_NAMES,
  MCP_APP_SANDBOX_SCHEME,
  decodeMcpAppSandboxGuestInitEnvelope,
  decodeMcpAppSandboxHostPortEnvelope,
  decodeMcpAppSandboxNavigationCommand,
  decodeMcpAppSandboxNavigationState,
  decodeMcpAppSandboxRegisterInput,
  decodeMcpAppSandboxUnregisterInput,
  resolveMcpAppFrameHeight,
} from "./mcpAppSandbox";

const csp = {
  baseUriDomains: [],
  connectDomains: ["https://api.example.test"],
  frameDomains: [],
  includeDefaultDomains: false,
  isTrusted: true,
  resourceDomains: ["https://cdn.example.test"],
};

const registerInput = {
  callId: "call-1",
  containerDimensions: { height: 240, width: 640 },
  csp,
  generation: 0,
  isCollapsible: true,
  prefersBorder: true,
  resourceUri: "ui://widget/main",
  server: "server-1",
  theme: "light" as const,
  threadId: "thread-1",
};

function cspWithEncodedSize(variableLength: number) {
  const fixedDomain = `https://example.test/${"a".repeat(1_975)}`;
  const variableDomain = `https://example.test/${"b".repeat(variableLength)}`;
  const fixed = Array.from({ length: 8 }, () => fixedDomain);
  return {
    baseUriDomains: [variableDomain, ...fixed.slice(0, 7)],
    connectDomains: fixed,
    frameDomains: fixed,
    includeDefaultDomains: false,
    isTrusted: true,
    resourceDomains: fixed,
  };
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("MCP App sandbox contracts", () => {
  it("keeps the dedicated scheme and bounded bridge markers stable", () => {
    expect(MCP_APP_SANDBOX_SCHEME).toBe("moss-mcp-sandbox");
    expect(MCP_APP_SANDBOX_PORT_NAME).toBe("mcp-app-host");
    expect(MCP_APP_SANDBOX_NAVIGATION_PORT_NAME).toBe("mcp-app-navigation");
    expect(MCP_APP_SANDBOX_PORT_NAMES).toEqual(["mcp-app-host", "mcp-app-navigation"]);
    expect(MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE).toBe("state");
    expect(MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE).toBe("navigate");
    expect(MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL).toContain("moss_desktop:");
    expect(MCP_APP_SANDBOX_ACK_TYPE).toContain("moss_desktop:");
    expect(MCP_APP_SANDBOX_GUEST_INIT_TYPE).toBe("init");
    expect(MCP_APP_SANDBOX_PENDING_TTL_MS).toBe(30_000);
  });

  it("accepts optional fields when present and rejects unknown fields", () => {
    expect(decodeMcpAppSandboxRegisterInput(registerInput)).toMatchObject(registerInput);
    expect(decodeMcpAppSandboxRegisterInput({ ...registerInput, unknown: "nope" })).toBeNull();
    expect(
      decodeMcpAppSandboxRegisterInput({
        ...registerInput,
        csp: { ...csp, connectDomains: ["https://api.example.test\nconnect-src *"] },
      }),
    ).toBeNull();
    expect(
      decodeMcpAppSandboxRegisterInput({
        ...registerInput,
        containerDimensions: { ...registerInput.containerDimensions, width: Infinity },
      }),
    ).toBeNull();
  });

  it("rejects HTML, credentials, persistent partitions, and malformed envelopes", () => {
    expect(
      decodeMcpAppSandboxRegisterInput({ ...registerInput, resourceUri: "<html>" }),
    ).toBeNull();
    for (const resourceUri of [
      "Bearer secret-value",
      "authorization: secret-value",
      "-----BEGIN PRIVATE KEY-----secret",
      "sk-proj-0123456789",
    ]) {
      expect(decodeMcpAppSandboxRegisterInput({ ...registerInput, resourceUri })).toBeNull();
    }
    expect(
      decodeMcpAppSandboxUnregisterInput({
        generation: 0,
        initId: "init-1",
        sandboxId: "sandbox-1",
        partition: "persist:moss-browser",
      }),
    ).toBeNull();
    expect(
      decodeMcpAppSandboxHostPortEnvelope({
        origin: "moss-mcp-sandbox://sandbox-1",
        initId: "init-1",
        portNames: [MCP_APP_SANDBOX_PORT_NAME],
        sandboxId: "sandbox-1",
        type: MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
        extra: true,
      }),
    ).toBeNull();
    expect(
      decodeMcpAppSandboxGuestInitEnvelope({
        origin: "moss-mcp-sandbox://sandbox-1",
        initId: "init-1",
        portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
        type: MCP_APP_SANDBOX_GUEST_INIT_TYPE,
      }),
    ).not.toBeNull();
    expect(
      decodeMcpAppSandboxGuestInitEnvelope({
        origin: "moss-mcp-sandbox://sandbox-1",
        initId: "init-1",
        portNames: [MCP_APP_SANDBOX_NAVIGATION_PORT_NAME, MCP_APP_SANDBOX_PORT_NAME],
        type: MCP_APP_SANDBOX_GUEST_INIT_TYPE,
      }),
    ).toBeNull();
    const envelopeCases = [
      [
        decodeMcpAppSandboxHostPortEnvelope,
        {
          origin: "moss-mcp-sandbox://sandbox-1",
          initId: "init-1",
          sandboxId: "sandbox-1",
          type: MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
        },
      ],
      [
        decodeMcpAppSandboxGuestInitEnvelope,
        {
          origin: "moss-mcp-sandbox://sandbox-1",
          initId: "init-1",
          type: MCP_APP_SANDBOX_GUEST_INIT_TYPE,
        },
      ],
    ] as const;
    for (const [decodeEnvelope, envelope] of envelopeCases) {
      expect(
        decodeEnvelope({
          portNames: [MCP_APP_SANDBOX_PORT_NAME],
          ...envelope,
        }),
      ).toBeNull();
      expect(
        decodeEnvelope({
          portNames: [MCP_APP_SANDBOX_PORT_NAME, MCP_APP_SANDBOX_NAVIGATION_PORT_NAME, "extra"],
          ...envelope,
        }),
      ).toBeNull();
    }
  });

  it("decodes only exact bounded navigation messages", () => {
    expect(
      decodeMcpAppSandboxNavigationState({
        type: MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
        canGoBack: true,
        canGoForward: false,
      }),
    ).toEqual({
      type: MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
      canGoBack: true,
      canGoForward: false,
    });
    expect(
      decodeMcpAppSandboxNavigationState({
        type: MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
        canGoBack: true,
        canGoForward: false,
        extra: true,
      }),
    ).toBeNull();
    expect(
      decodeMcpAppSandboxNavigationState({
        type: MCP_APP_SANDBOX_NAVIGATION_STATE_TYPE,
        canGoBack: 1,
        canGoForward: false,
      }),
    ).toBeNull();
    expect(
      decodeMcpAppSandboxNavigationCommand({
        type: MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
        delta: -1,
      }),
    ).toEqual({ type: MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE, delta: -1 });
    expect(
      decodeMcpAppSandboxNavigationCommand({
        type: MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
        delta: 2,
      }),
    ).toBeNull();
    expect(
      decodeMcpAppSandboxNavigationCommand({
        type: MCP_APP_SANDBOX_NAVIGATION_COMMAND_TYPE,
        delta: 1,
        ports: [],
      }),
    ).toBeNull();
  });

  it("enforces the 64 KiB UTF-8 JSON CSP boundary before registration", () => {
    const exactLength = Array.from({ length: 1_978 }, (_, length) => length).find(
      (length) => utf8Bytes(cspWithEncodedSize(length)) === MCP_APP_SANDBOX_MAX_CSP_CHARS,
    );
    expect(exactLength).toBeDefined();
    if (exactLength === undefined) return;
    expect(
      decodeMcpAppSandboxRegisterInput({
        ...registerInput,
        csp: cspWithEncodedSize(exactLength),
      }),
    ).not.toBeNull();
    expect(
      decodeMcpAppSandboxRegisterInput({
        ...registerInput,
        csp: cspWithEncodedSize(exactLength + 1),
      }),
    ).toBeNull();
  });

  it("uses the frozen bounded frame-height calculation", () => {
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: null })).toBe(MCP_APP_FRAME_DEFAULT_HEIGHT);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 360, heightHint: 240 })).toBe(360);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 120, minFrameHeight: 300 })).toBe(300);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 2_000 })).toBe(MCP_APP_FRAME_MAX_HEIGHT);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: -1 })).toBe(MCP_APP_FRAME_DEFAULT_HEIGHT);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: Number.NaN })).toBe(
      MCP_APP_FRAME_DEFAULT_HEIGHT,
    );
    expect(MCP_APP_FRAME_MIN_HEIGHT).toBe(200);
  });
});
