import { describe, expect, it } from "vitest";

import { buildPageAppFrameRuntime } from "../pageAppFrameRuntime";
import { PAGE_APP_EXTENSION_FRAME_PLUGINS } from "./extensions";

type Bridge = {
  call: (method: string, args: unknown) => Promise<unknown>;
  watch: (
    method: string,
    args: unknown,
    next: (value: unknown) => void,
    end: (error?: unknown) => void,
  ) => () => void;
  error: (code: string, message: string) => { code: string; message: string };
  use: () => Promise<null>;
};

function load(name: string, bridge: Bridge): any {
  const plugin = PAGE_APP_EXTENSION_FRAME_PLUGINS.find((candidate) => candidate.name === name)!;
  return new Function(`return (${plugin.frameSource})`)()(bridge);
}

function fakeBridge(answers: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const watches: Array<{
    method: string;
    args: unknown;
    next: (value: unknown) => void;
    end: (error?: unknown) => void;
  }> = [];
  const bridge: Bridge = {
    call: async (method, args) => {
      calls.push({ method, args });
      return answers[method] ?? null;
    },
    watch: (method, args, next, end) => {
      watches.push({ method, args, next, end });
      return () => undefined;
    },
    error: (code, message) => Object.freeze({ code, message }),
    use: async () => null,
  };
  return { bridge, calls, watches };
}

describe("extension frame plugins", () => {
  it("all parse inside the runtime script", () => {
    const runtime = buildPageAppFrameRuntime({ parentOrigin: "http://127.0.0.1:6070" });
    for (const plugin of PAGE_APP_EXTENSION_FRAME_PLUGINS)
      expect(runtime).toContain(JSON.stringify(plugin.name));
    expect(() => new Function(runtime)).not.toThrow();
  });

  it("mcp turns tool errors into tool_error and never sends approval", async () => {
    const { bridge, calls } = fakeBridge({
      call: { content: [{ type: "text", text: "nope" }], isError: true },
    });
    const mcp = load("mcp", bridge);
    await expect(
      mcp.callTool("notes", "list", { q: 1 }, { cache: { staleTime: 5 } }),
    ).rejects.toMatchObject({
      code: "tool_error",
      message: "nope",
    });
    expect(calls[0]).toEqual({
      method: "call",
      args: { server: "notes", tool: "list", args: { q: 1 }, cache: { staleTime: 5 } },
    });
    await expect(mcp.callTool("notes", "list", [1])).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("room publishes only after the welcome and tracks peers", async () => {
    const { bridge, calls, watches } = fakeBridge();
    const room = load("room", bridge).join({ state: { color: "red" } });
    const seen: unknown[] = [];
    room.on("peers", (peers: unknown[]) => seen.push(peers.length));
    const got: unknown[] = [];
    room.subscribe("cursor", (data: unknown) => got.push(data));
    const published = room.publish("cursor", { x: 1 });
    expect(calls).toHaveLength(0);
    watches[0]!.next({ type: "welcome", peerId: "p1", peers: [{ peerId: "p1" }] });
    await published;
    expect(calls[0]).toEqual({ method: "publish", args: { topic: "cursor", data: { x: 1 } } });
    watches[0]!.next({ type: "peers", peers: [{ peerId: "p1" }, { peerId: "p2" }] });
    watches[0]!.next({
      type: "event",
      topic: "cursor",
      data: { x: 2 },
      from: { peerId: "p2", name: "B" },
      at: 1,
    });
    expect(seen).toEqual([1, 2]);
    expect(got).toEqual([{ x: 2 }]);
    expect(room.self()).toBe("p1");
  });

  it("files and comments shape their calls", async () => {
    const { bridge, calls } = fakeBridge({ list: { comments: [] } });
    const files = load("files", bridge);
    await files.list({ path: "docs", recursive: true });
    await files.read("docs/a.md", { offset: 10, length: 5 });
    expect(calls).toEqual([
      { method: "list", args: { path: "docs", recursive: true } },
      { method: "read", args: { path: "docs/a.md", offset: 10, length: 5 } },
    ]);
    const comments = load("comments", bridge);
    await comments.resolve("c1");
    expect(calls.at(-1)).toEqual({ method: "resolve", args: { id: "c1", resolved: true } });
  });
});
