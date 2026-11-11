import {
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
  MCP_APP_SANDBOX_PORT_NAME,
  MCP_APP_SANDBOX_PORT_NAMES,
} from "@moss/contracts";
import { describe, expect, it } from "vitest";

import desktopBuildConfig from "../../tsdown.config.mts";
import { McpAppSandboxRegistry } from "./registry";
import {
  buildMcpAppSandboxShellHtml,
  isMcpAppSandboxAssetUrl,
  resolveMcpAppSandboxProtocolRequest,
} from "./protocol";
import {
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL as PRELOAD_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_PORT_NAMES as PRELOAD_PORT_NAMES,
  decodeMcpAppSandboxHostPortEnvelope as decodePreloadHostPortEnvelope,
} from "./preloadProtocol";

const registrationInput = (overrides: Record<string, unknown> = {}) => ({
  callId: "call-1",
  containerDimensions: { height: 240, width: 640 },
  csp: {
    baseUriDomains: [],
    connectDomains: ["https://api.example.test"],
    frameDomains: [],
    includeDefaultDomains: false,
    isTrusted: true,
    resourceDomains: ["https://cdn.example.test"],
  },
  generation: 0,
  isCollapsible: true,
  prefersBorder: true,
  resourceUri: "ui://widget/main",
  server: "server-1",
  theme: "light",
  threadId: "thread-1",
  ...overrides,
});

function counter(prefix: string, width = 0) {
  let count = 0;
  return () => {
    count += 1;
    return width > 0 ? count.toString(16).padStart(width, "0") : `${prefix}${count}`;
  };
}

function shellScript(html: string): string {
  const match = /<script>([\s\S]*)<\/script>\s*<\/body>/u.exec(html);
  if (!match?.[1]) throw new Error("proxy page has no script");
  return match[1];
}

describe("MCP App sandbox protocol routing", () => {
  it("serves the proxy page at /mcp_apps for the exact registration", () => {
    const registry = new McpAppSandboxRegistry({
      createInitId: counter("init-"),
      createRouteId: counter("", 16),
    });
    const descriptor = registry.register(1, registrationInput());
    expect(descriptor.src).toBe(
      `moss-mcp-sandbox://${descriptor.sandboxId}/mcp_apps?generation=0&route=0000000000000001#init=init-1`,
    );

    const response = resolveMcpAppSandboxProtocolRequest(
      descriptor.src,
      registry,
      descriptor.partition,
    );
    if (response?.kind !== "shell") throw new Error("expected the proxy page");
    expect(response.statusCode).toBe(200);
    expect(response.mimeType).toBe("text/html");
    expect(response.headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(response.headers["Content-Security-Policy"]).toContain(
      "connect-src 'self' blob: data: https://api.example.test",
    );
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.data).toContain("ui/notifications/sandbox-proxy-ready");
    expect(response.data).toContain('"variant":"isolated"');
    expect(response.data).toContain('"innerSandbox":"allow-scripts allow-forms"');
    expect(
      resolveMcpAppSandboxProtocolRequest(descriptor.src, registry, "moss-mcp-other"),
    ).toBeNull();
    expect(
      resolveMcpAppSandboxProtocolRequest(
        descriptor.src.replace("/mcp_apps?", "/ui?"),
        registry,
        descriptor.partition,
      ),
    ).toBeNull();
    expect(
      resolveMcpAppSandboxProtocolRequest(descriptor.src, registry, descriptor.partition, "POST"),
    ).toBeNull();
  });

  it("bakes the variant and delegable permissions into the page", () => {
    const registry = new McpAppSandboxRegistry({ createInitId: counter("init-") });
    const stable = registry.register(
      1,
      registrationInput({
        stableOrigin: true,
        connectorUrl: "https://connector.example.com/mcp",
        permissions: { camera: {}, microphone: false },
      }),
    );
    const response = resolveMcpAppSandboxProtocolRequest(stable.src, registry, stable.partition);
    if (response?.kind !== "shell") throw new Error("expected the proxy page");
    expect(response.data).toContain('"variant":"stable"');
    expect(response.data).toContain('"innerSandbox":"allow-scripts allow-same-origin allow-forms"');
    expect(response.data).toContain('"permissions":{"camera":true}');
    expect(response.headers["Permissions-Policy"]).toContain("camera=*");
    expect(response.headers["Permissions-Policy"]).toContain("microphone=()");
  });

  it("produces a proxy script that parses, inlines the receiver safely and uses Moss names", () => {
    for (const variant of ["isolated", "stable"] as const) {
      const html = buildMcpAppSandboxShellHtml({
        variant,
        permissions: { geolocation: true },
        allowFullscreen: true,
      });
      const script = shellScript(html);
      expect(() => new Function(script)).not.toThrow();
      // Exactly one script element: the receiver's markup is escaped inside the config.
      expect(html.match(/<script>/gu)).toHaveLength(1);
      expect(html.match(/<\/script>/gu)).toHaveLength(1);
      expect(script).toContain("moss:print-theme");
      expect(script).toContain("createMossJsonHealer");
      expect(script).not.toMatch(/anthropic|claude/iu);
      expect(html).toContain("<title>Moss widget</title>");
    }
  });

  it("serves the font asset from the fixed asset origin only", () => {
    const registry = new McpAppSandboxRegistry();
    const font = resolveMcpAppSandboxProtocolRequest(
      "moss-mcp-sandbox://assets/fonts/inter-latin.woff2",
      registry,
      "moss-mcp-anything",
    );
    expect(font?.kind).toBe("font");
    expect(font?.headers).toMatchObject({
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "font/woff2",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    expect(isMcpAppSandboxAssetUrl("moss-mcp-sandbox://assets/fonts/inter-latin.woff2")).toBe(true);
    for (const invalid of [
      "moss-mcp-sandbox://assets/fonts/inter-latin.woff2?v=1",
      "moss-mcp-sandbox://assets/mcp_apps",
      "moss-mcp-sandbox://0123456789abcdef0123456789abcdef/fonts/inter-latin.woff2",
      "https://assets/fonts/inter-latin.woff2",
    ]) {
      expect(isMcpAppSandboxAssetUrl(invalid), invalid).toBe(false);
      expect(resolveMcpAppSandboxProtocolRequest(invalid, registry, "moss-mcp-x")?.kind).not.toBe(
        "font",
      );
    }
  });

  it("keeps the trusted preload decoder dependency-free and contract-aligned", () => {
    const envelope = {
      origin: "moss-mcp-sandbox://sandbox-1",
      initId: "init-1",
      portNames: [...MCP_APP_SANDBOX_PORT_NAMES],
      sandboxId: "sandbox-1",
      type: MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
    };

    expect(PRELOAD_MAIN_TO_TRUSTED_CHANNEL).toBe(MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL);
    expect(PRELOAD_PORT_NAMES).toEqual(MCP_APP_SANDBOX_PORT_NAMES);
    expect(decodePreloadHostPortEnvelope(envelope)).toEqual(envelope);
    expect(decodePreloadHostPortEnvelope({ ...envelope, extra: true })).toBeNull();
    expect(
      decodePreloadHostPortEnvelope({
        ...envelope,
        portNames: [MCP_APP_SANDBOX_NAVIGATION_PORT_NAME, MCP_APP_SANDBOX_PORT_NAME],
      }),
    ).toBeNull();
    expect(decodePreloadHostPortEnvelope({ ...envelope, initId: " init-1 " })).toMatchObject({
      ...envelope,
      initId: "init-1",
    });
    expect(decodePreloadHostPortEnvelope({ ...envelope, initId: "   " })).toBeNull();
  });

  it("bundles every non-Electron preload dependency", () => {
    const preloadConfig = desktopBuildConfig[1]!;
    if (typeof preloadConfig.noExternal !== "function") {
      throw new Error("The desktop preload must define a dependency bundling policy.");
    }

    expect(preloadConfig.noExternal("effect", undefined)).toBe(true);
    expect(preloadConfig.noExternal("@moss/future-runtime", undefined)).toBe(true);
    expect(preloadConfig.noExternal("electron", undefined)).toBe(false);
    expect(preloadConfig.noExternal("electron/common", undefined)).toBe(false);
    expect(preloadConfig.noExternal("node:fs", undefined)).toBe(false);
  });

  it("keeps fragmentless routes unique per registration in a shared partition", () => {
    const registry = new McpAppSandboxRegistry({ createInitId: counter("init-") });
    const first = registry.register(1, registrationInput());
    const narrower = registry.register(
      1,
      registrationInput({
        callId: "call-2",
        csp: { ...registrationInput().csp, connectDomains: [] },
      }),
    );
    expect(narrower.partition).toBe(first.partition);
    const firstBase = first.src.split("#", 1)[0]!;
    const narrowerBase = narrower.src.split("#", 1)[0]!;
    expect(firstBase).not.toBe(narrowerBase);
    const firstResponse = resolveMcpAppSandboxProtocolRequest(firstBase, registry, first.partition);
    const narrowerResponse = resolveMcpAppSandboxProtocolRequest(
      narrowerBase,
      registry,
      first.partition,
    );
    expect(firstResponse?.headers["Content-Security-Policy"]).toContain("https://api.example.test");
    expect(narrowerResponse?.headers["Content-Security-Policy"]).not.toContain(
      "https://api.example.test",
    );
  });

  it("keeps a consumed exact authority routable without making stale fragments valid", () => {
    const registry = new McpAppSandboxRegistry({ createInitId: () => "init-1" });
    const descriptor = registry.register(1, registrationInput());
    expect(
      registry.consumeAttachment({
        ownerId: 1,
        sandboxId: descriptor.sandboxId,
        initId: descriptor.initId,
        generation: descriptor.generation,
        partition: descriptor.partition,
        src: descriptor.src,
        origin: descriptor.origin,
      }),
    ).not.toBeNull();
    expect(
      resolveMcpAppSandboxProtocolRequest(descriptor.src, registry, descriptor.partition),
    ).not.toBeNull();
    expect(
      resolveMcpAppSandboxProtocolRequest(
        descriptor.src.replace(descriptor.initId, "stale-init"),
        registry,
        descriptor.partition,
      ),
    ).toBeNull();
  });
});
