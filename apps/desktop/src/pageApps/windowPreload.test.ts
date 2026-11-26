import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    sendSync: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import {
  clipRectToViewport,
  parsePageAppManifestFromDocument,
  scanAppRegionElements,
} from "./windowPreload";

function makeDragRegionEl(opts: {
  region: "drag" | "no-drag";
  visibility?: string;
  display?: string;
  left?: number;
}) {
  return {
    __style: {
      display: opts.display ?? "block",
      visibility: opts.visibility ?? "visible",
      getPropertyValue: (prop: string) => (prop === "app-region" ? opts.region : ""),
    },
    getBoundingClientRect: () => ({
      left: opts.left ?? 0,
      top: 0,
      right: (opts.left ?? 0) + 10,
      bottom: 20,
    }),
  };
}

describe("windowPreload helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses and filters valid permissions from <script id='moss-app-manifest'>", () => {
    const fakeDoc = {
      getElementById: (id: string) =>
        id === "moss-app-manifest"
          ? {
              textContent: JSON.stringify({
                desktop: {
                  permissions: ["notifications", "unknown-perm", "overlay", "notifications"],
                },
              }),
            }
          : null,
    } as unknown as Document;

    expect(parsePageAppManifestFromDocument(fakeDoc)).toEqual(["notifications", "overlay"]);
  });

  it("rejects oversized manifests > 16000 chars", () => {
    const fakeDoc = {
      getElementById: () => ({
        textContent: JSON.stringify({ permissions: ["overlay"], pad: "x".repeat(16_100) }),
      }),
    } as unknown as Document;

    expect(parsePageAppManifestFromDocument(fakeDoc)).toEqual([]);
  });

  it("clips bounding rectangles to viewport bounds", () => {
    expect(clipRectToViewport({ left: -20, top: 10, right: 150, bottom: 80 }, 120, 60)).toEqual({
      x: 0,
      y: 10,
      width: 120,
      height: 50,
    });
    expect(clipRectToViewport({ left: 200, top: 10, right: 250, bottom: 50 }, 120, 60)).toBeNull();
  });

  it("scans stylesheet + inline app-region elements, skips hidden, and prioritizes no-drag within 64", () => {
    const elements = [
      ...Array.from({ length: 70 }, (_, idx) => makeDragRegionEl({ region: "drag", left: idx })),
      makeDragRegionEl({ region: "no-drag", visibility: "hidden", left: 5 }),
      makeDragRegionEl({ region: "no-drag", left: 10 }),
    ];

    const fakeDoc = {
      styleSheets: [
        {
          cssRules: [
            {
              selectorText: ".titlebar",
              style: {
                getPropertyValue: (p: string) => (p === "app-region" ? "drag" : ""),
              },
            },
          ],
        },
      ],
      querySelectorAll: () => elements,
    } as unknown as Document;

    const fakeWin = {
      innerWidth: 1000,
      innerHeight: 600,
      getComputedStyle: (el: { __style: unknown }) => el.__style,
    } as unknown as Window;

    const regions = scanAppRegionElements(fakeDoc, fakeWin);
    expect(regions).toHaveLength(64);
    expect(regions.filter((r) => !r.drag)).toHaveLength(1);
    expect(regions.find((r) => !r.drag)?.x).toBe(10);
  });
});
