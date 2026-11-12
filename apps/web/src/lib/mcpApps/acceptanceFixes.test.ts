import { afterEach, describe, expect, it, vi } from "vitest";

import { isMcpAppApprovalForBinding } from "./awaitingApproval";
import { computeMcpAppFrameClip } from "./frameTracker";
import {
  acquireMcpAppWidget,
  peekMcpAppWidget,
  releaseMcpAppWidget,
  resetMcpAppLiveWidgetsForTests,
} from "./liveWidgets";
import { readMcpAppResourceOnce, resetMcpAppResourceCacheForTests } from "./resourceCache";
import type { McpAppResourceRead } from "./contracts";
import type { McpAppHostController } from "../mcpAppHost";

afterEach(() => {
  resetMcpAppLiveWidgetsForTests();
  resetMcpAppResourceCacheForTests();
  vi.useRealTimers();
});

const ready: McpAppResourceRead = {
  state: "ready",
  resourceUri: "ui://fixture/widget",
  html: "<p>x</p>",
  csp: {
    baseUriDomains: [],
    connectDomains: [],
    frameDomains: [],
    includeDefaultDomains: false,
    isTrusted: false,
    resourceDomains: [],
  },
  permissions: {},
  prefersBorder: true,
  domain: null,
  stableOrigin: false,
  isCollapsible: true,
};

describe("computeMcpAppFrameClip", () => {
  const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };

  it("clips to the scroller and stops above an overlapping composer", () => {
    const slot = { left: 100, top: 500, right: 700, bottom: 900 };
    expect(
      computeMcpAppFrameClip({
        slot,
        viewport,
        clippers: [{ left: 80, top: 60, right: 720, bottom: 780 }],
        composer: { left: 120, top: 700, right: 680, bottom: 770 },
      }),
    ).toEqual({ left: 100, top: 500, right: 700, bottom: 700 });
  });

  it("is empty once the slot scrolled out of the transcript", () => {
    const clip = computeMcpAppFrameClip({
      slot: { left: 100, top: -500, right: 700, bottom: -100 },
      viewport,
      clippers: [{ left: 80, top: 60, right: 720, bottom: 780 }],
      composer: null,
    });
    expect(clip.bottom).toBeLessThanOrEqual(clip.top);
  });
});

describe("live widgets", () => {
  function fakeController() {
    return {} as McpAppHostController;
  }

  it("shares one widget across remounts and tears it down only after the grace period", () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const create = vi.fn(() => ({ controller: fakeController(), dispose }));
    const first = acquireMcpAppWidget("w", { n: 1 }, create);
    releaseMcpAppWidget("w", 1_000);
    const second = acquireMcpAppWidget("w", { n: 2 }, create);
    expect(second).toBe(first);
    expect(second.context).toEqual({ n: 2 });
    expect(create).toHaveBeenCalledTimes(1);
    releaseMcpAppWidget("w", 1_000);
    vi.advanceTimersByTime(999);
    expect(dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(peekMcpAppWidget("w")).toBeUndefined();
  });
});

describe("readMcpAppResourceOnce", () => {
  it("shares one request between concurrent mounts and keeps the settled HTML", async () => {
    const read = vi.fn(async () => ready);
    const [a, b] = await Promise.all([
      readMcpAppResourceOnce("k", read),
      readMcpAppResourceOnce("k", read),
    ]);
    await readMcpAppResourceOnce("k", read);
    expect(a).toBe(b);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not keep failures or empty answers", async () => {
    const read = vi
      .fn<() => Promise<McpAppResourceRead>>()
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValueOnce({ state: "no_content", resourceUri: "ui://x" })
      .mockResolvedValueOnce(ready);
    await expect(readMcpAppResourceOnce("k", read)).rejects.toThrow("502");
    await expect(readMcpAppResourceOnce("k", read)).resolves.toMatchObject({ state: "no_content" });
    await expect(readMcpAppResourceOnce("k", read)).resolves.toBe(ready);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("isMcpAppApprovalForBinding", () => {
  const binding = { server: "fixture", toolName: "fixture_show_widget" };

  it("matches the provider spellings of this widget's tool", () => {
    for (const toolName of [
      "fixture_show_widget",
      "fixture/fixture_show_widget",
      "mcp__fixture__fixture_show_widget",
    ]) {
      expect(isMcpAppApprovalForBinding({ toolName }, binding)).toBe(true);
    }
    expect(isMcpAppApprovalForBinding({ toolName: "fixture_other" }, binding)).toBe(false);
    expect(
      isMcpAppApprovalForBinding(
        { toolName: "fixture_show_widget", toolServerName: "elsewhere" },
        binding,
      ),
    ).toBe(false);
    expect(isMcpAppApprovalForBinding({}, binding)).toBe(false);
  });
});

describe("fetchMcpAppToolResult", () => {
  it("reads the server's failed and missing answers", async () => {
    const { fetchMcpAppToolResult } = await import("./serverApi");
    const answer = (body: unknown) =>
      (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;
    await expect(
      fetchMcpAppToolResult(
        { threadId: "t", callId: "c" },
        { fetchImpl: answer({ status: "failed", message: "schema validation" }) },
      ),
    ).resolves.toEqual({ status: "failed", message: "schema validation" });
    await expect(
      fetchMcpAppToolResult(
        { threadId: "t", callId: "c" },
        { fetchImpl: answer({ status: "missing" }) },
      ),
    ).resolves.toEqual({ status: "missing" });
  });
});
