import { describe, expect, it } from "vitest";

import {
  MCP_APP_FRAME_DEFAULT_HEIGHT,
  MCP_APP_INLINE_MAX_HEIGHT,
  MCP_APP_SANDBOX_FONT_FACE_CSS,
  MCP_APP_SANDBOX_FONT_URL,
  MCP_APP_SANDBOX_INIT_TIMEOUT_MS,
  MCP_APP_SANDBOX_INIT_TIMEOUT_SLACK_MS,
  MCP_APP_SANDBOX_PATH,
  MCP_APP_SANDBOX_PROXY_READY_RETRIES,
  MCP_APP_SANDBOX_PROXY_READY_TIMEOUT_MS,
  MCP_APP_SANDBOX_READY_FLUSH_TIMEOUT_MS,
  MCP_APP_SIZE_EMPTY_THRESHOLD,
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
  decodeMcpAppSandboxBridgeEnvelope,
  decodeMcpAppSandboxDownloadInput,
  decodeMcpAppSandboxGuestInitEnvelope,
  decodeMcpAppSandboxHostPortEnvelope,
  decodeMcpAppSandboxNavigationCommand,
  decodeMcpAppSandboxNavigationState,
  decodeMcpAppSandboxRegisterInput,
  decodeMcpAppSandboxUnregisterInput,
  normalizeMcpAppSandboxPermissions,
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

  it("clamps only the top of the inline frame height", () => {
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: null })).toBe(MCP_APP_FRAME_DEFAULT_HEIGHT);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 360, heightHint: 240 })).toBe(360);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 120, minFrameHeight: 300 })).toBe(300);
    // The old 200-720 clamp is gone: small and tall widgets keep their height.
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 40 })).toBe(40);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 2_000 })).toBe(2_000);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 151.2 })).toBe(152);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: 9_000 })).toBe(MCP_APP_INLINE_MAX_HEIGHT);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: -1 })).toBe(MCP_APP_FRAME_DEFAULT_HEIGHT);
    expect(resolveMcpAppFrameHeight({ intrinsicHeight: Number.NaN })).toBe(
      MCP_APP_FRAME_DEFAULT_HEIGHT,
    );
  });

  it("pins the host timing and size constants", () => {
    expect(MCP_APP_INLINE_MAX_HEIGHT).toBe(5_000);
    expect(MCP_APP_SIZE_EMPTY_THRESHOLD).toBe(8);
    expect(MCP_APP_SANDBOX_INIT_TIMEOUT_MS).toBe(10_000);
    expect(MCP_APP_SANDBOX_INIT_TIMEOUT_SLACK_MS).toBe(5_000);
    expect(MCP_APP_SANDBOX_PROXY_READY_TIMEOUT_MS).toBe(30_000);
    expect(MCP_APP_SANDBOX_PROXY_READY_RETRIES).toBe(1);
    expect(MCP_APP_SANDBOX_READY_FLUSH_TIMEOUT_MS).toBe(5_000);
    expect(MCP_APP_SANDBOX_PATH).toBe("/mcp_apps");
    expect(MCP_APP_SANDBOX_FONT_URL).toBe("moss-mcp-sandbox://assets/fonts/inter-latin.woff2");
    expect(MCP_APP_SANDBOX_FONT_FACE_CSS).toContain(`url("${MCP_APP_SANDBOX_FONT_URL}")`);
  });

  it("accepts the origin and permission fields of the registration", () => {
    const decoded = decodeMcpAppSandboxRegisterInput({
      ...registerInput,
      serverKey: "connector-1",
      stableOrigin: true,
      connectorUrl: "https://connector.example.test/mcp",
      permissions: { camera: {}, microphone: false, clipboardWrite: true, geolocation: null },
    });
    expect(decoded).toMatchObject({
      serverKey: "connector-1",
      stableOrigin: true,
      connectorUrl: "https://connector.example.test/mcp",
      permissions: { camera: true, clipboardWrite: true },
    });
    for (const invalid of [
      { permissions: { usb: {} } },
      { permissions: { camera: "yes" } },
      { permissions: [] },
      { connectorUrl: "javascript:alert(1)" },
      { connectorUrl: "file:///etc/passwd" },
      { connectorUrl: " https://x.test" },
      { stableOrigin: "true" },
      { serverKey: "" },
    ]) {
      expect(decodeMcpAppSandboxRegisterInput({ ...registerInput, ...invalid })).toBeNull();
    }
    expect(normalizeMcpAppSandboxPermissions({})).toEqual({});
    expect(normalizeMcpAppSandboxPermissions(null)).toBeNull();
  });

  it("decodes the shell-to-host bridge envelope exactly", () => {
    const message = { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} };
    const type = "moss:mcp-app-message";
    expect(decodeMcpAppSandboxBridgeEnvelope({ type, message, userActivation: true })).toEqual({
      type,
      message,
      userActivation: true,
    });
    for (const invalid of [
      message,
      { message, userActivation: false },
      { type: "other", message, userActivation: false },
      { type, message, userActivation: "true" },
      { type, message: [], userActivation: false },
      { type, message: null, userActivation: false },
      { type, message, userActivation: false, extra: 1 },
    ]) {
      expect(decodeMcpAppSandboxBridgeEnvelope(invalid)).toBeNull();
    }
  });

  it("decodes bounded downloads with exactly one body", () => {
    expect(
      decodeMcpAppSandboxDownloadInput({ fileName: "a.txt", mimeType: "text/plain", text: "é" }),
    ).toEqual({ fileName: "a.txt", mimeType: "text/plain", bytes: new Uint8Array([195, 169]) });
    expect(
      decodeMcpAppSandboxDownloadInput({ fileName: "a.bin", mimeType: "", base64: "AAH/" }),
    ).toEqual({ fileName: "a.bin", mimeType: "", bytes: new Uint8Array([0, 1, 255]) });
    for (const invalid of [
      { fileName: "a", mimeType: "x" },
      { fileName: "a", mimeType: "x", text: "a", base64: "AA==" },
      { fileName: "a", mimeType: "x", base64: "A" },
      { fileName: "a", mimeType: "x", base64: "@@@@" },
      { fileName: "a", mimeType: "x\r\ny", text: "a" },
      { fileName: "", mimeType: "x", text: "a" },
      { fileName: "a", mimeType: "x", text: 1 },
    ]) {
      expect(decodeMcpAppSandboxDownloadInput(invalid)).toBeNull();
    }
  });
});
