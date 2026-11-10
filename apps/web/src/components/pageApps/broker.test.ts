import type { PageAppId, PageAppShellMessage, PageAppStoredConsent } from "@moss/contracts";
import type { PageAppShellPlugin } from "@moss/shared/pageAppCapabilityPlugin";
import { describe, expect, it, vi } from "vitest";

import { PageAppBroker, type PageAppBrokerDeps, type PageAppBrokerSession } from "./broker";
import { PAGE_APP_SHELL_PLUGINS } from "./capabilities";
import { TokenBucket } from "./rateLimit";

const P = "moss-app/1";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
  options: {
    capabilities?: Record<string, unknown>;
    consent?: Record<string, PageAppStoredConsent>;
    allow?: boolean;
    mode?: "full" | "embed" | "guest";
    plugins?: readonly PageAppShellPlugin[];
  } = {},
) {
  const posted: PageAppShellMessage[] = [];
  let stored: Record<string, PageAppStoredConsent> = { ...options.consent };
  const askConsent = vi.fn(async () => options.allow ?? true);
  const call = vi.fn(async (input: { method: string; args: unknown }) => ({
    value: { echoed: input.method },
  }));
  const watchCancels: (() => void)[] = [];
  const watch = vi.fn((_input: unknown, sink: { next: (v: unknown) => void; end: () => void }) => {
    sink.next({ type: "text", delta: "a" });
    const cancel = vi.fn();
    watchCancels.push(cancel);
    return cancel;
  });
  const consent = vi.fn(
    async (input: { op: string; capability?: string; state?: PageAppStoredConsent | null }) => {
      if (input.op === "set" && input.capability) {
        if (input.state === null || input.state === undefined) delete stored[input.capability];
        else stored = { ...stored, [input.capability]: input.state };
      }
      return { consent: stored };
    },
  );
  const deps: PageAppBrokerDeps = {
    post: (message) => posted.push(message),
    client: { call, watch, consent } as unknown as PageAppBrokerDeps["client"],
    plugins: options.plugins ?? PAGE_APP_SHELL_PLUGINS,
    askConsent,
    confirm: vi.fn(async () => true),
    openPermissions: vi.fn(async () => undefined),
  };
  const session: PageAppBrokerSession = {
    appId: "app-1" as PageAppId,
    revision: 3,
    title: "Tracker",
    mode: options.mode ?? "full",
    viewer: { id: "owner", name: "我", level: "owner", isOwner: true },
    capabilities: options.capabilities ?? { db: {}, ai: {} },
    consent: options.consent ?? {},
  };
  const broker = new PageAppBroker(session, deps);
  const send = (message: Record<string, unknown>) =>
    broker.handleMessage({ protocol: P, ...message });
  const result = (id: number) => posted.find((m) => m.kind === "result" && m.id === id);
  return { broker, posted, send, result, askConsent, call, watch, consent, watchCancels, deps };
}

describe("PageAppBroker", () => {
  it("answers hello with declared ∩ shipped capabilities plus permissions", () => {
    const { send, posted } = setup({ capabilities: { db: {}, downloads: {}, unknownThing: {} } });
    send({ kind: "hello" });
    expect(posted[0]).toEqual({
      protocol: P,
      kind: "init",
      served: ["db", "downloads", "permissions"],
    });
  });

  it("serves guests a reduced set", () => {
    const { send, posted } = setup({ mode: "guest", capabilities: { db: {}, ai: {}, page: {} } });
    send({ kind: "hello" });
    expect(posted[0]).toMatchObject({ served: ["db", "permissions"] });
  });

  it("drops malformed and foreign messages without answering", () => {
    const { broker, posted } = setup();
    broker.handleMessage({ protocol: "other", kind: "hello" });
    broker.handleMessage({ protocol: P, kind: "call", id: "x" });
    broker.handleMessage("nonsense");
    expect(posted).toEqual([]);
  });

  it("rejects undeclared capabilities as unavailable without prompting", async () => {
    const { send, result, askConsent, call } = setup({ capabilities: { db: {} } });
    send({ kind: "call", id: 1, capability: "page", method: "metadata", args: null });
    await flush();
    expect(result(1)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(askConsent).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("asks once on first use, remembers a grant, and relays", async () => {
    const { send, result, askConsent, call, consent } = setup();
    send({ kind: "call", id: 1, capability: "db", method: "get", args: { path: "a/b" } });
    await flush();
    await flush();
    expect(askConsent).toHaveBeenCalledTimes(1);
    expect(consent).toHaveBeenCalledWith(
      expect.objectContaining({ op: "set", capability: "db", state: "granted" }),
    );
    expect(result(1)).toMatchObject({ ok: true, value: { echoed: "get" } });
    send({ kind: "call", id: 2, capability: "db", method: "set", args: { path: "a/b", data: {} } });
    await flush();
    await flush();
    expect(askConsent).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("a declined prompt rejects not_granted and is not asked again this load", async () => {
    const { send, result, askConsent, call, broker } = setup({ allow: false });
    send({ kind: "call", id: 1, capability: "db", method: "get", args: { path: "a/b" } });
    await flush();
    await flush();
    expect(result(1)).toMatchObject({ ok: false, error: { code: "not_granted" } });
    send({ kind: "call", id: 2, capability: "db", method: "get", args: { path: "a/b" } });
    await flush();
    await flush();
    expect(askConsent).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
    expect(broker.permissionStates().db).toBe("denied");
  });

  it("does not remember a denial when the frame unmounts mid-prompt", async () => {
    let answer: (value: boolean) => void = () => undefined;
    const h = setup();
    (h.deps as { askConsent: unknown }).askConsent = () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    h.send({ kind: "call", id: 1, capability: "db", method: "get", args: {} });
    await flush();
    h.broker.dispose();
    answer(false);
    await flush();
    expect(h.consent).not.toHaveBeenCalled();
  });

  it("concurrent first uses share one dialog", async () => {
    const { send, askConsent } = setup();
    send({ kind: "call", id: 1, capability: "db", method: "get", args: {} });
    send({ kind: "call", id: 2, capability: "db", method: "get", args: {} });
    for (let i = 0; i < 4; i++) await flush();
    expect(askConsent).toHaveBeenCalledTimes(1);
  });

  it("honours a remembered denial without prompting", async () => {
    const { send, result, askConsent } = setup({ consent: { ai: "denied" } });
    send({ kind: "watch", id: 5, capability: "ai", method: "ask", args: { input: "x" } });
    await flush();
    expect(askConsent).not.toHaveBeenCalled();
    expect(result(5)).toBeUndefined();
  });

  it("streams watch events and cancels on unwatch and dispose", async () => {
    const { send, posted, watchCancels, broker } = setup({
      consent: { ai: "granted", db: "granted" },
    });
    send({ kind: "watch", id: 7, capability: "ai", method: "ask", args: { input: "x" } });
    await flush();
    expect(posted).toContainEqual({
      protocol: P,
      kind: "event",
      id: 7,
      value: { type: "text", delta: "a" },
    });
    send({ kind: "unwatch", id: 7 });
    expect(watchCancels[0]).toHaveBeenCalled();
    send({ kind: "watch", id: 8, capability: "db", method: "watchDoc", args: { path: "a/b" } });
    await flush();
    broker.dispose();
    expect(watchCancels[1]).toHaveBeenCalled();
  });

  it("permissions.state reports per capability and needs no declaration", async () => {
    const { send, result } = setup({
      capabilities: { db: {}, downloads: {} },
      consent: { db: "granted" },
    });
    send({ kind: "call", id: 1, capability: "permissions", method: "state", args: null });
    await flush();
    expect(result(1)).toMatchObject({
      ok: true,
      value: { db: "granted", downloads: "granted", permissions: "granted" },
    });
  });

  it("rate limits per capability", async () => {
    const limited: PageAppShellPlugin = {
      name: "db",
      consent: "none",
      modes: ["full"],
      label: "x",
      purpose: "x",
      rateLimit: { burst: 2, perMinute: 1 },
      call: async () => "ok",
    };
    const { send, result } = setup({ plugins: [limited], capabilities: { db: {} } });
    for (const id of [1, 2, 3])
      send({ kind: "call", id, capability: "db", method: "get", args: null });
    await flush();
    expect(result(1)).toMatchObject({ ok: true });
    expect(result(2)).toMatchObject({ ok: true });
    expect(result(3)).toMatchObject({ ok: false, error: { code: "resource_exhausted" } });
  });
});

describe("TokenBucket", () => {
  it("refills over time", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 60, () => now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now = 1_000;
    expect(bucket.take()).toBe(true);
  });
});
