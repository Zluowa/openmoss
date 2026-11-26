import path from "node:path";
import { normalizePath } from "vite";
import { describe, expect, it } from "vitest";

import { assignBootBands, bootChunkGroups } from "./boot-chunk-groups";

// id -> [static imports, source length]
type Graph = Record<string, readonly [ReadonlyArray<string>, number]>;

function moduleGraph(graph: Graph) {
  return {
    getModuleInfo: (id: string) => {
      const module = graph[id];
      return module
        ? ({ importedIds: [...module[0]], code: "x".repeat(module[1]) } as never)
        : null;
    },
  };
}

// Resolve against the host platform so the test matches Vite/Rolldown IDs on both POSIX and Windows.
const ROOT = path.resolve("/app");
const mod = (file: string) => normalizePath(path.resolve(ROOT, file));

const GRAPH: Graph = {
  [mod("entry.ts")]: [[mod("shared.ts")], 10],
  [mod("shared.ts")]: [[], 10],
  [mod("main.ts")]: [[mod("a.ts"), mod("shared.ts")], 10],
  [mod("a.ts")]: [[mod("b.ts")], 100],
  [mod("b.ts")]: [[mod("a.ts"), mod("c.ts")], 100],
  [mod("c.ts")]: [[], 100],
  [mod("chat.ts")]: [[mod("a.ts"), mod("d.ts")], 10],
  [mod("d.ts")]: [[], 100],
};

const options = (bandBytes: number) => ({
  root: ROOT,
  entry: "entry.ts",
  steps: [
    { name: "main", root: "main.ts" },
    { name: "chat", root: "chat.ts" },
  ],
  bandBytes,
});

const bandIndex = (band: string | undefined) => Number(band?.split("-").at(-1));

describe("assignBootBands", () => {
  it("leaves the entry's closure out and puts a module in the first step that loads it", () => {
    const bands = assignBootBands(moduleGraph(GRAPH), options(1_000));

    expect(bands.has(mod("entry.ts"))).toBe(false);
    expect(bands.has(mod("shared.ts"))).toBe(false);
    expect(bands.get(mod("a.ts"))).toBe("main-0");
    expect(bands.get(mod("d.ts"))).toBe("chat-0");
  });

  it("keeps an import cycle in one band and never imports a later band", () => {
    const bands = assignBootBands(moduleGraph(GRAPH), options(150));

    expect(bands.get(mod("a.ts"))).toBe(bands.get(mod("b.ts")));
    expect(new Set([...bands.values()].filter((band) => band.startsWith("main-"))).size).toBe(3);
    for (const [id, band] of bands) {
      for (const dep of GRAPH[id]![0]) {
        const depBand = bands.get(dep);
        if (depBand?.startsWith(band.replace(/-\d+$/, "-"))) {
          expect(bandIndex(depBand)).toBeLessThanOrEqual(bandIndex(band));
        }
      }
    }
  });

  it("fails the build when a step root is not in the module graph", () => {
    expect(() =>
      assignBootBands(moduleGraph(GRAPH), {
        ...options(1_000),
        steps: [{ name: "gone", root: "gone.ts" }],
      }),
    ).toThrow(/gone\.ts is not in the module graph/);
  });
});

describe("bootChunkGroups", () => {
  it("gives earlier bands higher priority and folds overflow into a step's last band", () => {
    const groups = bootChunkGroups({ ...options(150), priority: 100, maxBandsPerStep: 2 });
    const ctx = moduleGraph(GRAPH);
    const nameOf = (id: string) =>
      groups
        .map((group) => (typeof group.name === "function" ? group.name(id, ctx) : group.name))
        .filter(Boolean);

    expect(groups.map((group) => group.priority)).toEqual([100, 99, 98, 97]);
    expect(nameOf(mod("c.ts"))).toEqual(["main-0"]);
    expect(nameOf(mod("a.ts"))).toEqual(["main-1"]);
    // main.ts is band 2 of main; with two bands per step it joins main-1.
    expect(nameOf(mod("main.ts"))).toEqual(["main-1"]);
    expect(nameOf(mod("entry.ts"))).toEqual([]);
  });
});
