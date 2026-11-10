// FILE: pageAppThumbnailRuntime.test.ts
// Purpose: Resource rejection happens before html-to-image can clone DOM nodes.
// Layer: Shared generated-runtime tests

import { runInNewContext } from "node:vm";

import { afterEach, expect, it, vi } from "vitest";

import {
  buildPageAppThumbnailRuntime,
  PAGE_APP_THUMBNAIL_PROTOCOL,
} from "./pageAppThumbnailRuntime";

afterEach(() => vi.useRealTimers());

function fixture(resource: "none" | "image" | "css" | "srcset") {
  vi.useFakeTimers();
  const listeners: ((event: unknown) => void)[] = [];
  const posted: { thumbnail?: unknown }[] = [];
  const parent = { postMessage: (message: { thumbnail?: unknown }) => posted.push(message) };
  const node = {
    tagName: resource === "image" || resource === "srcset" ? "IMG" : "DIV",
    getAttribute: () =>
      resource === "image" ? "https://outside.invalid/image.png" : "data:image/png;base64,AA==",
    hasAttribute: (name: string) => name === "srcset" && resource === "srcset",
  };
  const window = {
    parent,
    innerWidth: 720,
    rendered: 0,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener);
    },
    getComputedStyle: () => ({
      getPropertyValue: (name: string) =>
        resource === "css" && name === "background-image"
          ? 'url("https://outside.invalid/background.png")'
          : "none",
    }),
  };
  const context = {
    window,
    document: { body: { ...node, outerHTML: "<div></div>", querySelectorAll: () => [node] } },
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
  };
  runInNewContext(buildPageAppThumbnailRuntime("https://shell.invalid"), context);
  const request = {
    protocol: PAGE_APP_THUMBNAIL_PROTOCOL,
    kind: "capture",
    nonce: "fixture",
    renderer:
      'exports.toJpeg = function () { window.rendered++; return Promise.resolve("data:image/jpeg;base64,fixture"); };',
  };
  const deliver = (origin = "https://shell.invalid", source: unknown = parent) =>
    listeners.forEach((listener) => listener({ origin, source, data: request }));
  return { deliver, posted, window };
}

it.each(["image", "css", "srcset"] as const)(
  "refuses %s before any renderer clone can load resources",
  async (resource) => {
    const test = fixture(resource);
    test.deliver();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.window.rendered).toBe(0);
    expect(test.posted).toEqual([expect.objectContaining({ thumbnail: null })]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("requires the exact parent origin and window and renders only once", async () => {
  const test = fixture("none");
  test.deliver("https://other.invalid");
  test.deliver("https://shell.invalid", {});
  await vi.advanceTimersByTimeAsync(0);
  expect(test.window.rendered).toBe(0);
  test.deliver();
  test.deliver();
  await vi.advanceTimersByTimeAsync(0);
  expect(test.window.rendered).toBe(1);
  expect(test.posted).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
