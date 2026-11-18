// The time-aware shard split of the component browser tests (durationShardSequencer.ts).
import { describe, expect, it } from "vitest";

import {
  parseFileDurations,
  partitionByDuration,
  readFileDurations,
} from "./durationShardSequencer";

const durations = (seconds: Record<string, number>, extra = 0) => ({
  perFileOverheadSeconds: 1,
  shardOneExtraSeconds: extra,
  seconds,
});

describe("partitionByDuration", () => {
  it("puts the heaviest files on different shards and balances the rest", () => {
    const shards = partitionByDuration(
      ["a", "b", "c", "d", "e", "f"],
      3,
      durations({ a: 96, b: 86, c: 62, d: 30, e: 30, f: 30 }),
    );
    expect(shards).toEqual([["a"], ["b", "e"], ["c", "d", "f"]]);
  });

  it("assigns every file exactly once, unknown files at the median time, shard 1 preloaded", () => {
    const keys = Array.from({ length: 40 }, (_, index) => `f${index}`);
    const known = Object.fromEntries(keys.slice(0, 30).map((key, index) => [key, index + 1]));
    const shards = partitionByDuration(keys, 4, durations(known, 50));
    expect(shards.flat().toSorted()).toEqual(keys.toSorted());
    const load = shards.map(
      (shard, index) =>
        shard.reduce((sum, key) => sum + (known[key] ?? 16) + 1, 0) + (index === 0 ? 50 : 0),
    );
    expect(Math.max(...load) - Math.min(...load)).toBeLessThanOrEqual(31);
    // Same input, same split: every CI shard computes the same partition.
    expect(partitionByDuration(keys.toReversed(), 4, durations(known, 50))).toEqual(shards);
  });

  it("splits the recorded component files into four shards within 2% of each other", () => {
    const recorded = readFileDurations();
    const keys = Object.keys(recorded.seconds);
    const shards = partitionByDuration(keys, 4, recorded);
    const load = shards.map(
      (shard, index) =>
        shard.reduce((sum, key) => sum + recorded.seconds[key]! + 1, 0) +
        (index === 0 ? recorded.shardOneExtraSeconds : 0),
    );
    expect(Math.max(...load) / Math.min(...load)).toBeLessThan(1.02);
  });
});

describe("parseFileDurations", () => {
  it("reads the per-file lines of the default reporter, colours included", () => {
    const log = [
      "2026-11-18T07:30:00Z  ✓  components (chromium)  src/components/EventRouter.browser.tsx (44 tests) 85712ms",
      "\u001b[32m✓\u001b[39m components (chromium)  src/lib/themeCss.browser.ts (4 tests) 4.7s",
      " ❯  components (chromium)  src/components/Foo.browser.tsx (3 tests | 1 failed) 1203ms",
    ].join("\n");
    expect(parseFileDurations(log)).toEqual({
      "src/components/EventRouter.browser.tsx": 85.7,
      "src/lib/themeCss.browser.ts": 4.7,
      "src/components/Foo.browser.tsx": 1.2,
    });
  });
});
