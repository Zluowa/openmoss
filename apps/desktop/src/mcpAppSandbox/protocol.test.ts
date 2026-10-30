import {
  MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL,
  MCP_APP_SANDBOX_NAVIGATION_PORT_NAME,
  MCP_APP_SANDBOX_PORT_NAME,
  MCP_APP_SANDBOX_PORT_NAMES,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import desktopBuildConfig from "../../tsdown.config.mts";
import { McpAppSandboxRegistry } from "./registry";
import {
  MCP_APP_SANDBOX_CONTENT_HTML,
  MCP_APP_SANDBOX_SHELL_HTML,
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

describe("MCP App sandbox protocol routing", () => {
  it("serves the exact full route and keeps the partition route scoped", () => {
    const registry = new McpAppSandboxRegistry({
      createInitId: (() => {
        let count = 0;
        return () => `init-${++count}`;
      })(),
    });
    const descriptor = registry.register(1, registrationInput());

    const response = resolveMcpAppSandboxProtocolRequest(
      descriptor.src,
      registry,
      descriptor.partition,
    );
    expect(response?.statusCode).toBe(200);
    expect(response?.mimeType).toBe("text/html");
    expect(response?.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(MCP_APP_SANDBOX_SHELL_HTML).toContain("ui/notifications/sandbox-proxy-ready");
    expect(MCP_APP_SANDBOX_SHELL_HTML).not.toContain("ui/notifications/proxy-ready");
    expect(MCP_APP_SANDBOX_SHELL_HTML).toContain(
      '<html lang="en" style="width:100%;height:100%;margin:0;overflow:hidden">',
    );
    expect(MCP_APP_SANDBOX_SHELL_HTML).toContain(
      '<body style="width:100%;height:100%;margin:0;overflow:hidden;background:transparent">',
    );
    expect(MCP_APP_SANDBOX_SHELL_HTML).toContain(
      'style="display:block;width:100%;height:100%;margin:0;border:0;overflow:hidden"',
    );
    expect(MCP_APP_SANDBOX_SHELL_HTML).toContain(
      'sandbox="allow-scripts allow-same-origin allow-forms"',
    );
    expect(MCP_APP_SANDBOX_SHELL_HTML).toContain("/content?generation=");
    expect(MCP_APP_SANDBOX_SHELL_HTML).not.toContain("srcdoc");
    expect(MCP_APP_SANDBOX_SHELL_HTML).not.toContain("contentDocument.write");
    expect(MCP_APP_SANDBOX_SHELL_HTML).not.toContain("history.length");
    expect(MCP_APP_SANDBOX_SHELL_HTML).toContain("mcp-app-navigation");
    expect(MCP_APP_SANDBOX_CONTENT_HTML).toContain("document.open()");
    expect(MCP_APP_SANDBOX_CONTENT_HTML).toContain("document.write(data.html)");
    expect(MCP_APP_SANDBOX_CONTENT_HTML).toContain("moss_desktop:mcp-app-content-ready");
    expect(MCP_APP_SANDBOX_CONTENT_HTML).not.toContain("safe fixture");
    expect(
      resolveMcpAppSandboxProtocolRequest(descriptor.src, registry, "moss-mcp-other"),
    ).toBeNull();
    expect(
      resolveMcpAppSandboxProtocolRequest(
        descriptor.src.replace("/ui?", "/other?"),
        registry,
        descriptor.partition,
      ),
    ).toBeNull();
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
    expect(preloadConfig.noExternal("@synara/future-runtime", undefined)).toBe(true);
    expect(preloadConfig.noExternal("electron", undefined)).toBe(false);
    expect(preloadConfig.noExternal("electron/common", undefined)).toBe(false);
    expect(preloadConfig.noExternal("node:fs", undefined)).toBe(false);
  });

  it("shares a fragmentless route only for equivalent normalized CSP", () => {
    const registry = new McpAppSandboxRegistry({
      createInitId: (() => {
        let count = 0;
        return () => `init-${++count}`;
      })(),
    });
    const first = registry.register(1, registrationInput());
    const samePolicy = registry.register(2, registrationInput());
    const base = first.src.split("#", 1)[0]!;
    expect(samePolicy.partition).toBe(first.partition);
    expect(resolveMcpAppSandboxProtocolRequest(base, registry, first.partition)?.statusCode).toBe(
      200,
    );

    registry.register(
      3,
      registrationInput({
        csp: {
          ...registrationInput().csp,
          connectDomains: [],
        },
      }),
    );
    expect(resolveMcpAppSandboxProtocolRequest(base, registry, first.partition)).toBeNull();
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

  it("serves the exact inner content installer only in the registered partition", () => {
    const registry = new McpAppSandboxRegistry({ createInitId: () => "init-1" });
    const descriptor = registry.register(1, registrationInput());
    const contentUrl =
      "moss-mcp-sandbox://" + descriptor.sandboxId + "/content?generation=0&init=init-1";
    const response = resolveMcpAppSandboxProtocolRequest(
      contentUrl,
      registry,
      descriptor.partition,
    );
    expect(response?.statusCode).toBe(200);
    expect(response?.headers["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
    expect(response?.headers["Content-Security-Policy"]).toContain("frame-src 'self'");
    expect(response?.data).toBe(MCP_APP_SANDBOX_CONTENT_HTML);
    expect(resolveMcpAppSandboxProtocolRequest(contentUrl, registry, "moss-mcp-other")).toBeNull();
    for (const invalid of [
      `${contentUrl}&extra=1`,
      contentUrl.replace("?generation=0&init=init-1", "?init=init-1&generation=0"),
      contentUrl.replace("init=init-1", "init=stale"),
      contentUrl.replace("&init=init-1", "&init=init-1&init=duplicate"),
      `${contentUrl}#fragment`,
      contentUrl.replace(descriptor.sandboxId, "other-sandbox"),
    ]) {
      expect(
        resolveMcpAppSandboxProtocolRequest(invalid, registry, descriptor.partition),
      ).toBeNull();
    }
  });
});
