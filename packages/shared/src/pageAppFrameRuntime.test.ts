import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { buildPageAppFrameRuntime, injectPageAppFrameRuntime } from "./pageAppFrameRuntime";

const PARENT = "http://127.0.0.1:6010";

interface Posted {
  readonly protocol: string;
  readonly kind: string;
  readonly id?: number;
  readonly capability?: string;
  readonly method?: string;
  readonly args?: unknown;
}

function boot() {
  const listeners: ((event: unknown) => void)[] = [];
  const posted: Posted[] = [];
  const parent = {
    postMessage: (message: Posted, origin: string) => {
      expect(origin).toBe(PARENT);
      posted.push(structuredClone(message));
    },
  };
  const window: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener);
    },
  };
  window.window = window;
  const context = {
    window,
    document: {
      readyState: "complete",
      documentElement: { scrollHeight: 10 },
      body: { scrollHeight: 10 },
    },
    setTimeout,
    crypto: webcrypto,
    Promise,
    Map,
    Object,
    JSON,
    Math,
    Uint8Array,
    Array,
    String,
    TypeError,
  };
  runInNewContext(buildPageAppFrameRuntime({ parentOrigin: PARENT }), context);
  const moss = window.moss as { use: (name: string) => Promise<unknown> };
  const deliver = (data: unknown, origin = PARENT, source: unknown = parent) => {
    for (const listener of listeners) listener({ data, origin, source });
  };
  return { moss, posted, deliver, window };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("frame runtime", () => {
  it("says hello, then serves only the names the shell lists", async () => {
    const { moss, posted, deliver } = boot();
    expect(posted[0]).toMatchObject({ protocol: "moss-app/1", kind: "hello" });
    const db = moss.use("db");
    const ai = moss.use("ai");
    const unknown = await moss.use("nope");
    expect(unknown).toBeNull();
    deliver({ protocol: "moss-app/1", kind: "init", served: ["db"] });
    expect(await db).not.toBeNull();
    expect(await ai).toBeNull();
    expect(moss.use("db")).toBe(moss.use("db"));
  });

  it("ignores messages from other origins or windows", async () => {
    const { moss, deliver } = boot();
    const db = moss.use("db");
    deliver({ protocol: "moss-app/1", kind: "init", served: ["db"] }, "http://evil.test");
    deliver({ protocol: "moss-app/1", kind: "init", served: ["db"] }, PARENT, {});
    const raced = await Promise.race([db, flush().then(() => "pending")]);
    expect(raced).toBe("pending");
  });

  it("freezes namespaces and the moss global", async () => {
    const { moss, deliver, window } = boot();
    deliver({ protocol: "moss-app/1", kind: "init", served: ["db"] });
    const db = (await moss.use("db")) as Record<string, unknown>;
    expect(Object.isFrozen(db)).toBe(true);
    expect(Object.isFrozen(moss)).toBe(true);
    expect(() => {
      "use strict";
      (window as { moss: unknown }).moss = {};
    }).toThrow();
  });

  it("relays db calls and resolves their results", async () => {
    const { moss, posted, deliver } = boot();
    deliver({ protocol: "moss-app/1", kind: "init", served: ["db"] });
    const db = (await moss.use("db")) as {
      doc: (path: string) => {
        get: () => Promise<{ exists: boolean; data: () => unknown }>;
        set: (v: unknown) => Promise<void>;
      };
      collection: (path: string) => unknown;
    };
    expect(() => db.doc("tasks")).toThrow(TypeError);
    const pending = db.doc("tasks/t1").get();
    await flush();
    const call = posted.at(-1)!;
    expect(call).toMatchObject({
      kind: "call",
      capability: "db",
      method: "get",
      args: { path: "tasks/t1" },
    });
    deliver({
      protocol: "moss-app/1",
      kind: "result",
      id: call.id,
      ok: true,
      value: { id: "t1", path: "tasks/t1", exists: true, data: { title: "a" }, updatedAt: "x" },
    });
    const snap = await pending;
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ title: "a" });
    const failing = db.doc("tasks/t1").set({ n: 1 });
    await flush();
    deliver({
      protocol: "moss-app/1",
      kind: "result",
      id: posted.at(-1)!.id,
      ok: false,
      error: { code: "not_granted", message: "no" },
    });
    await expect(failing).rejects.toMatchObject({ code: "not_granted" });
  });

  it("streams ai text and rejects on end without done", async () => {
    const { moss, posted, deliver } = boot();
    deliver({ protocol: "moss-app/1", kind: "init", served: ["ai"] });
    const ai = (await moss.use("ai")) as {
      ask: (
        input: string,
        options?: { onText?: (d: string, full: string) => void },
      ) => Promise<{ text: string }>;
    };
    const onText = vi.fn();
    const answer = ai.ask("hi", { onText });
    await flush();
    const watch = posted.at(-1)!;
    expect(watch).toMatchObject({ kind: "watch", capability: "ai", method: "ask" });
    deliver({
      protocol: "moss-app/1",
      kind: "event",
      id: watch.id,
      value: { type: "text", delta: "Hel" },
    });
    deliver({
      protocol: "moss-app/1",
      kind: "event",
      id: watch.id,
      value: { type: "text", delta: "lo" },
    });
    deliver({
      protocol: "moss-app/1",
      kind: "event",
      id: watch.id,
      value: { type: "done", text: "Hello", model: "m" },
    });
    expect(await answer).toEqual({ text: "Hello", model: "m" });
    expect(onText).toHaveBeenLastCalledWith("lo", "Hello");

    const broken = ai.ask("again");
    await flush();
    deliver({
      protocol: "moss-app/1",
      kind: "end",
      id: posted.at(-1)!.id,
      error: { code: "authentication_required", message: "x" },
    });
    await expect(broken).rejects.toMatchObject({ code: "authentication_required" });
  });

  it("cannot be closed early by the page's markup", () => {
    const runtime = buildPageAppFrameRuntime({ parentOrigin: "http://a</script><script>alert(1)" });
    expect(runtime).not.toContain("</script>");
    const html = injectPageAppFrameRuntime(
      "<!doctype html><html><head><title>x</title></head></html>",
      runtime,
    );
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<title>"));
    expect(injectPageAppFrameRuntime("<p>frag</p>", "1").startsWith("<script>1</script>")).toBe(
      true,
    );
  });
});
