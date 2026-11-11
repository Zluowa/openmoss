import { describe, expect, it } from "vitest";

import { MCP_APP_SANDBOX_PENDING_TTL_MS } from "@moss/contracts";

import { mcpAppSandboxConnectorLabel, mcpAppSandboxThreadLabel } from "./origin";
import { McpAppSandboxRegistry } from "./registry";

const input = (overrides: Record<string, unknown> = {}) => ({
  callId: "call-1",
  containerDimensions: { height: 240, width: 600 },
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

describe("McpAppSandboxRegistry", () => {
  it("derives a stable source partition and consumes each init once", () => {
    let now = 100;
    let init = 0;
    const registry = new McpAppSandboxRegistry({
      now: () => now,
      createInitId: () => `init-${++init}`,
    });

    const first = registry.register(42, input());
    expect(first.partition.startsWith("persist:")).toBe(false);
    expect(first.partition).toContain(first.sandboxId);
    const attached = registry.consumeAttachment({
      ownerId: 42,
      sandboxId: first.sandboxId,
      initId: first.initId,
      generation: first.generation,
      partition: first.partition,
      src: first.src,
      origin: first.origin,
    });
    expect(attached?.descriptor).toEqual(first);
    expect(registry.pendingCount).toBe(0);
    expect(
      registry.consumeAttachment({
        ownerId: 42,
        sandboxId: first.sandboxId,
        initId: first.initId,
        generation: first.generation,
        partition: first.partition,
        src: first.src,
        origin: first.origin,
      }),
    ).toBeNull();

    const retry = registry.register(42, input({ generation: 1 }));
    expect(retry.sandboxId).toBe(first.sandboxId);
    expect(retry.partition).toBe(first.partition);
    expect(retry.initId).not.toBe(first.initId);
    expect(retry.generation).toBe(1);
    now += MCP_APP_SANDBOX_PENDING_TTL_MS;
    expect(registry.pendingCount).toBe(0);
  });

  it("gives one origin per thread x server key and keeps exact owner/generation", () => {
    let init = 0;
    const registry = new McpAppSandboxRegistry({ createInitId: () => `init-${++init}` });
    const first = registry.register(10, input());
    expect(first.sandboxId).toBe(mcpAppSandboxThreadLabel("thread-1", "server-1"));
    expect(first.origin).toBe(`moss-mcp-sandbox://${first.sandboxId}`);
    expect(first.partition).toBe(`moss-mcp-${first.sandboxId}`);
    // Another resource of the same server in the same thread shares the origin.
    const sameServer = registry.register(10, input({ resourceUri: "ui://widget/other" }));
    expect(sameServer.sandboxId).toBe(first.sandboxId);
    const otherKey = registry.register(10, input({ serverKey: "connector-9" }));
    expect(otherKey.sandboxId).toBe(mcpAppSandboxThreadLabel("thread-1", "connector-9"));
    const otherThread = registry.register(10, input({ threadId: "thread-2" }));
    expect(otherThread.sandboxId).not.toBe(first.sandboxId);
    expect(otherThread.partition).not.toBe(first.partition);
    expect(
      registry.consumeAttachment({
        ownerId: 11,
        sandboxId: first.sandboxId,
        initId: first.initId,
        generation: first.generation,
        partition: first.partition,
        src: first.src,
        origin: first.origin,
      }),
    ).toBeNull();
    expect(registry.teardownOwner(10)).toBe(4);
    expect(registry.teardownOwner(10)).toBe(0);
  });

  it("keeps same-source owners independent and routes each registration to its own policy", () => {
    let init = 0;
    const registry = new McpAppSandboxRegistry({ createInitId: () => `init-${++init}` });
    const first = registry.register(1, input());
    const otherOwner = registry.register(2, input());
    expect(otherOwner.sandboxId).toBe(first.sandboxId);
    expect(otherOwner.partition).toBe(first.partition);
    expect(registry.pendingCount).toBe(2);
    expect(
      registry.lookupByUrl(first.src, { ownerId: 1, partition: first.partition })?.descriptor,
    ).toEqual(first);
    expect(
      registry.lookupByUrl(otherOwner.src, { ownerId: 2, partition: otherOwner.partition })
        ?.descriptor,
    ).toEqual(otherOwner);
    expect(registry.lookupByUrl(first.src, { ownerId: 2 })).toBeNull();
    expect(
      registry.lookupByUrl(first.src.split("#", 1)[0]!, { partition: first.partition })?.descriptor,
    ).toEqual(first);

    const differentPolicy = registry.register(
      3,
      input({ csp: { ...input().csp, connectDomains: [] } }),
    );
    expect(differentPolicy.partition).toBe(first.partition);
    expect(
      registry.lookupByUrl(first.src.split("#", 1)[0]!, { partition: first.partition })?.descriptor,
    ).toEqual(first);
    expect(
      registry.lookupByUrl(differentPolicy.src.split("#", 1)[0]!, { partition: first.partition })
        ?.policy.connectDomains,
    ).toEqual([]);
  });

  it("uses the connector-URL origin only for the stable variant", () => {
    const registry = new McpAppSandboxRegistry();
    const stable = registry.register(
      1,
      input({ stableOrigin: true, connectorUrl: "https://Connector.example.com:443/mcp" }),
    );
    expect(stable.sandboxId).toBe(mcpAppSandboxConnectorLabel("https://connector.example.com/mcp"));
    expect(registry.lookupByUrl(stable.src)?.variant).toBe("stable");
    // Another thread with the same connector shares the stable origin.
    const otherThread = registry.register(
      1,
      input({
        threadId: "thread-9",
        stableOrigin: true,
        connectorUrl: "https://connector.example.com/mcp",
      }),
    );
    expect(otherThread.sandboxId).toBe(stable.sandboxId);
    const noUrl = registry.register(1, input({ stableOrigin: true }));
    expect(noUrl.sandboxId).toBe(mcpAppSandboxThreadLabel("thread-1", "server-1"));
    expect(registry.lookupByUrl(noUrl.src)?.variant).toBe("isolated");
  });

  it("stores the effective policy and rejects malformed policy input", () => {
    const registry = new McpAppSandboxRegistry();
    const descriptor = registry.register(
      1,
      input({
        csp: { ...input().csp, frameDomains: ["https://maps.example.com", "https://claude.ai"] },
        permissions: { camera: {}, geolocation: true },
      }),
    );
    const registration = registry.lookupByUrl(descriptor.src);
    expect(registration?.policy.frameDomains).toEqual(["https://maps.example.com"]);
    expect(registration?.policy.withholdDevicePermissions).toBe(true);
    expect(registration?.policy.permissions).toEqual({});
    expect(() => registry.register(1, input({ permissions: { usb: true } }))).toThrow();
    expect(() => registry.register(1, input({ permissions: { camera: "yes" } }))).toThrow();
    expect(() => registry.register(1, input({ connectorUrl: "javascript:alert(1)" }))).toThrow();
  });

  it("keeps the live authority limit", () => {
    const registry = new McpAppSandboxRegistry();
    for (let index = 0; index < 256; index += 1) {
      registry.register(1, input({ callId: `call-${index}` }));
    }
    expect(() => registry.register(1, input({ callId: "call-over" }))).toThrow(
      "MCP App authority limit reached.",
    );
  });

  it("replaces only one owner's pending durable-card authority", () => {
    let init = 0;
    const registry = new McpAppSandboxRegistry({ createInitId: () => `init-${++init}` });
    const first = registry.register(1, input());
    const otherOwner = registry.register(2, input());
    const replacement = registry.register(1, input({ generation: 2 }));
    const replacementRegistration = registry.lookupByUrl(replacement.src, { ownerId: 1 });
    expect(replacementRegistration).not.toBeNull();
    expect(
      registry.replacePendingForOwnerCard(
        1,
        replacementRegistration!.cardIdentityKey,
        replacementRegistration!.authorityKey,
      ),
    ).toBe(1);
    expect(
      registry.consumeAttachment({
        ownerId: 1,
        sandboxId: first.sandboxId,
        initId: first.initId,
        generation: first.generation,
        partition: first.partition,
        src: first.src,
        origin: first.origin,
      }),
    ).toBeNull();
    expect(registry.lookupByUrl(otherOwner.src, { ownerId: 2 })?.descriptor).toEqual(otherOwner);
    expect(
      registry.unregister(1, {
        sandboxId: replacement.sandboxId,
        initId: replacement.initId,
        generation: replacement.generation,
      }),
    ).toBe(true);
    expect(
      registry.unregister(1, {
        sandboxId: replacement.sandboxId,
        initId: replacement.initId,
        generation: replacement.generation,
      }),
    ).toBe(false);
  });

  it("does not consume process-lifetime source slots after sequential teardown", () => {
    const registry = new McpAppSandboxRegistry({ createInitId: () => "init-sequential" });

    for (let index = 0; index < 129; index += 1) {
      const descriptor = registry.register(
        1,
        input({
          callId: `call-sequential-${index}`,
          resourceUri: `ui://widget/sequential-${index}`,
          threadId: `thread-sequential-${index}`,
        }),
      );
      expect(
        registry.unregister(1, {
          sandboxId: descriptor.sandboxId,
          initId: descriptor.initId,
          generation: descriptor.generation,
        }),
      ).toBe(true);
    }

    expect(registry.pendingCount).toBe(0);
  });
});
