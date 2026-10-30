import { describe, expect, it } from "vitest";

import { MCP_APP_SANDBOX_PENDING_TTL_MS } from "@synara/contracts";

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

  it("isolates unrelated source identities and exact owner/generation", () => {
    let init = 0;
    const registry = new McpAppSandboxRegistry({ createInitId: () => `init-${++init}` });
    const first = registry.register(10, input());
    const other = registry.register(10, input({ resourceUri: "ui://widget/other" }));
    expect(other.sandboxId).not.toBe(first.sandboxId);
    expect(other.partition).not.toBe(first.partition);
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
    expect(registry.teardownOwner(10)).toBe(2);
    expect(registry.teardownOwner(10)).toBe(0);
  });

  it("keeps same-source owners independent and fails closed on CSP ambiguity", () => {
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
      registry.lookupByUrl(first.src.split("#", 1)[0]!, { partition: first.partition }),
    ).toBeNull();
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
