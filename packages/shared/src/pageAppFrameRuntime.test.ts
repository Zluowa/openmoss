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

  it("relays media, chat, and mossbot capabilities and enriches media asset URLs", async () => {
    const listeners: ((event: unknown) => void)[] = [];
    const posted: Posted[] = [];
    const parent = {
      postMessage: (message: Posted) => posted.push(structuredClone(message)),
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
      location: { origin: "http://app-1.moss-app.localhost:3000", search: "?t=tok123" },
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
      URLSearchParams,
    };
    runInNewContext(buildPageAppFrameRuntime({ parentOrigin: PARENT }), context);
    const moss = window.moss as { use: (name: string) => Promise<Record<string, any> | null> };
    const deliver = (data: unknown) => {
      for (const listener of listeners) listener({ data, origin: PARENT, source: parent });
    };
    deliver({
      protocol: "moss-app/1",
      kind: "init",
      served: ["media", "chat", "mossbot", "voice"],
    });

    const media = (await moss.use("media"))!;
    const chat = (await moss.use("chat"))!;
    const mossbot = (await moss.use("mossbot"))!;
    const voice = (await moss.use("voice"))!;
    expect(media).not.toBeNull();
    expect(chat).not.toBeNull();
    expect(mossbot).not.toBeNull();
    expect(voice).not.toBeNull();

    const imgPromise = media.generateImage({ prompt: "a misty pine mountain" });
    await flush();
    const imgCall = posted.at(-1)!;
    expect(imgCall).toMatchObject({ kind: "call", capability: "media", method: "generateImage" });
    deliver({
      protocol: "moss-app/1",
      kind: "result",
      id: imgCall.id,
      ok: true,
      value: {
        jobId: "moss_1",
        kind: "image",
        modelId: "gpt-image-2.5-flare",
        prompt: "a misty pine mountain",
        status: "succeeded",
        url: null,
        urls: [],
        assetPaths: ["/__moss_app/asset/a1"],
        createdAt: "2026-11-27T00:00:00Z",
      },
    });
    const imgRes = await imgPromise;
    expect(imgRes.url).toBe("http://app-1.moss-app.localhost:3000/__moss_app/asset/a1?t=tok123");

    const askPromise = chat.ask({ prompt: "Explain", selectionText: "quoted passage" });
    await flush();
    const askWatch = posted.at(-1)!;
    expect(askWatch).toMatchObject({ kind: "watch", capability: "chat", method: "ask" });
    deliver({
      protocol: "moss-app/1",
      kind: "event",
      id: askWatch.id,
      value: { type: "done", text: "Explained.", model: "gpt-5" },
    });
    expect(await askPromise).toEqual({
      text: "Explained.",
      model: "gpt-5",
      selectionText: "quoted passage",
    });

    const joinPromise = mossbot.joinMeeting({ meetingId: "m-1", title: "Weekly Sync" });
    await flush();
    const joinCall = posted.at(-1)!;
    expect(joinCall).toMatchObject({
      kind: "call",
      capability: "mossbot",
      method: "joinMeeting",
    });
    deliver({
      protocol: "moss-app/1",
      kind: "result",
      id: joinCall.id,
      ok: true,
      value: {
        meetingId: "m-1",
        roomId: null,
        title: "Weekly Sync",
        joined: true,
        bots: [],
        notesCount: 0,
      },
    });
    expect(await joinPromise).toMatchObject({ meetingId: "m-1", joined: true });

    const events: unknown[] = [];
    const offTranscript = voice.onTranscript((ev: unknown) => events.push(ev));
    await flush();
    const watchReq = posted.at(-1)!;
    expect(watchReq).toMatchObject({ kind: "watch", capability: "voice", method: "events" });
    deliver({
      protocol: "moss-app/1",
      kind: "event",
      id: watchReq.id,
      value: { type: "transcript", role: "user", text: "你好 Moss", isFinal: true },
    });
    deliver({
      protocol: "moss-app/1",
      kind: "event",
      id: watchReq.id,
      value: { type: "state", phase: "active" },
    });
    expect(events).toEqual([
      { type: "transcript", role: "user", text: "你好 Moss", isFinal: true },
    ]);
    offTranscript();

    const speakPromise = voice.speak("欢迎来到 Moss");
    await flush();
    const speakCall = posted.at(-1)!;
    expect(speakCall).toMatchObject({
      kind: "call",
      capability: "voice",
      method: "speak",
      args: { text: "欢迎来到 Moss" },
    });
    deliver({
      protocol: "moss-app/1",
      kind: "result",
      id: speakCall.id,
      ok: true,
      value: { spoken: true, source: "moss", voice: "breeze" },
    });
    expect(await speakPromise).toMatchObject({ spoken: true, source: "moss" });
  });

  it("reports non-empty non-editable frame text selection bounds and clears on collapse without mutating DOM", async () => {
    const docListeners = new Map<string, Array<() => void>>();
    const posted: Array<Record<string, unknown>> = [];
    const parent = {
      postMessage: (message: Record<string, unknown>, origin: string) => {
        expect(origin).toBe(PARENT);
        posted.push(structuredClone(message));
      },
    };
    let currentSelection: {
      isCollapsed: boolean;
      rangeCount: number;
      toString: () => string;
      anchorNode: unknown;
      focusNode: unknown;
      getRangeAt: () => {
        commonAncestorContainer: unknown;
        getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
      };
    } | null = null;
    const windowObj: Record<string, unknown> = {
      parent,
      addEventListener: () => undefined,
      getSelection: () => currentSelection,
    };
    windowObj.window = windowObj;
    const context = {
      window: windowObj,
      document: {
        readyState: "complete",
        documentElement: { scrollHeight: 10 },
        body: { scrollHeight: 10 },
        addEventListener: (type: string, cb: () => void) => {
          const list = docListeners.get(type) ?? [];
          list.push(cb);
          docListeners.set(type, list);
        },
      },
      setTimeout,
      clearTimeout,
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
    currentSelection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "  写下明天需要顺延的事项  ",
      anchorNode: { nodeType: 1, tagName: "P", id: "item-3", closest: () => null },
      focusNode: { nodeType: 1, tagName: "P", id: "item-3", closest: () => null },
      getRangeAt: () => ({
        commonAncestorContainer: {
          nodeType: 1,
          tagName: "P",
          id: "item-3",
          closest: () => null,
        },
        getBoundingClientRect: () => ({ left: 120.4, top: 84.2, width: 196.1, height: 22.8 }),
      }),
    };
    for (const cb of docListeners.get("mouseup") ?? []) cb();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(posted.at(-1)).toMatchObject({
      protocol: "moss-app/1",
      kind: "selection",
      text: "写下明天需要顺延的事项",
      rect: { x: 120, y: 84, width: 196, height: 23 },
      anchor: { target: "p#item-3", label: "写下明天需要顺延的事项" },
    });

    currentSelection = {
      ...currentSelection,
      isCollapsed: true,
      toString: () => "",
    };
    for (const cb of docListeners.get("selectionchange") ?? []) cb();
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(posted.at(-1)).toMatchObject({
      protocol: "moss-app/1",
      kind: "selection",
      text: "",
      rect: null,
      anchor: null,
    });
  });

  it("handles pick-mode element capture, Escape cancellation, markers, and top heading detection", () => {
    const docListeners = new Map<string, ((event: unknown) => void)[]>();
    const winListeners = new Map<string, ((event: unknown) => void)[]>();
    const posted: Array<Record<string, unknown>> = [];
    const parent = {
      postMessage: (message: Record<string, unknown>) => {
        posted.push(structuredClone(message));
      },
    };
    const fakeTarget = {
      nodeType: 1,
      id: "chapter-card",
      tagName: "SECTION",
      textContent: "  第一章：云端阅读器  ",
      outerHTML: '<section id="chapter-card">第一章：云端阅读器</section>',
      parentElement: null,
      closest: () => null,
      getAttribute: (name: string) => (name === "role" ? "region" : null),
      getBoundingClientRect: () => ({
        left: 48,
        top: 96,
        right: 368,
        width: 320,
        height: 120,
      }),
    };
    const appended: Array<{
      attrs: Record<string, string>;
      style: Record<string, string>;
      children: unknown[];
      firstChild: unknown;
      removeChild: (child: unknown) => void;
      appendChild: (child: unknown) => void;
    }> = [];
    const makeEl = () => {
      const children: unknown[] = [];
      return {
        attrs: {} as Record<string, string>,
        style: {} as Record<string, string>,
        children,
        get firstChild() {
          return children[0] ?? null;
        },
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
        appendChild(c: unknown) {
          children.push(c);
        },
        removeChild(c: unknown) {
          const i = children.indexOf(c);
          if (i >= 0) children.splice(i, 1);
        },
      };
    };
    const headingEl = {
      textContent: "静读 · 小说阅读器",
      getBoundingClientRect: () => ({ top: 24, width: 220, height: 32 }),
    };
    const windowObj: Record<string, unknown> = {
      parent,
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: (type: string, cb: (event: unknown) => void) => {
        const list = winListeners.get(type) ?? [];
        list.push(cb);
        winListeners.set(type, list);
      },
    };
    windowObj.window = windowObj;
    const context = {
      window: windowObj,
      document: {
        readyState: "complete",
        documentElement: {
          scrollHeight: 600,
          style: {} as Record<string, string>,
          appendChild: (node: unknown) => appended.push(node as (typeof appended)[number]),
        },
        body: {
          scrollHeight: 600,
          querySelector: () => null,
          querySelectorAll: (sel: string) => (sel === "h1, h2" ? [headingEl] : []),
        },
        createElement: makeEl,
        elementFromPoint: () => fakeTarget,
        querySelectorAll: (sel: string) => (sel === "#chapter-card" ? [fakeTarget] : []),
        querySelector: (sel: string) => (sel === "#chapter-card" ? fakeTarget : null),
        addEventListener: (type: string, cb: (event: unknown) => void) => {
          const list = docListeners.get(type) ?? [];
          list.push(cb);
          docListeners.set(type, list);
        },
      },
      setTimeout,
      clearTimeout,
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

    expect(posted.some((m) => m.kind === "heading" && m.hasTopHeading === true)).toBe(true);

    const deliver = (data: unknown) => {
      for (const cb of winListeners.get("message") ?? [])
        cb({ data, origin: PARENT, source: parent });
    };
    deliver({
      protocol: "moss-app/1",
      kind: "pick-mode",
      active: true,
      theme: {
        accent: "rgb(42, 120, 214)",
        surface: "rgb(255, 255, 255)",
        text: "rgb(17, 17, 17)",
      },
    });

    for (const cb of docListeners.get("mousemove") ?? []) {
      cb({ clientX: 120, clientY: 130 });
    }
    expect(
      appended.some(
        (node) =>
          node.attrs["data-moss-pick-overlay"] === "true" &&
          String(node.style.cssText || node.style.border || "").includes("rgb(42, 120, 214)"),
      ),
    ).toBe(true);

    let prevented = false;
    for (const cb of docListeners.get("click") ?? []) {
      cb({
        clientX: 120,
        clientY: 130,
        target: fakeTarget,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => undefined,
      });
    }
    expect(prevented).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      protocol: "moss-app/1",
      kind: "element-picked",
      selector: "#chapter-card",
      tagName: "section",
      role: "region",
      text: "第一章：云端阅读器",
      rect: { x: 48, y: 96, width: 320, height: 120 },
    });

    deliver({
      protocol: "moss-app/1",
      kind: "sync-markers",
      markers: [{ ordinal: 1, selector: "#chapter-card" }],
    });
    expect(
      appended.some(
        (node) => node.attrs["data-moss-marker-layer"] === "true" && node.children.length === 1,
      ),
    ).toBe(true);

    for (const cb of docListeners.get("keydown") ?? []) {
      cb({ key: "Escape", preventDefault: () => undefined, stopPropagation: () => undefined });
    }
    expect(posted.at(-1)).toMatchObject({
      protocol: "moss-app/1",
      kind: "pick-ended",
      reason: "escape",
    });
  });
});
