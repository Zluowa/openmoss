import { describe, expect, it } from "vitest";

import { STREAM_FADE_MS, StreamingFadeScheduler } from "./streamingFadeScheduler";

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("StreamingFadeScheduler", () => {
  it("staggers words that arrive together, 2.5ms per character", () => {
    const time = clock();
    const scheduler = new StreamingFadeScheduler(time.now);
    scheduler.sync(30);
    const first = scheduler.reveal(0, 6);
    const sameChunk = scheduler.reveal(6, 6);
    const next = scheduler.reveal(12, 10);
    expect(first).toMatchObject({ delayMs: 15, instant: false });
    expect(scheduler.reveal(6, 6)).toBe(sameChunk);
    expect(sameChunk.delayMs).toBe(15);
    // 6 + 6 + 10 > 16 characters: a later chunk, after the queue so far.
    expect(next.delayMs).toBe(55);
    expect(STREAM_FADE_MS).toBe(200);
  });

  it("never queues a word more than 600ms out", () => {
    const time = clock();
    const scheduler = new StreamingFadeScheduler(time.now);
    scheduler.sync(4_000);
    let last = 0;
    for (let offset = 0; offset < 4_000; offset += 20) last = scheduler.reveal(offset, 20).delayMs;
    expect(last).toBe(600);
  });

  it("keeps a word shown once its fade has run, so a remount does not replay it", () => {
    const time = clock();
    const scheduler = new StreamingFadeScheduler(time.now);
    scheduler.sync(6);
    expect(scheduler.reveal(0, 6).instant).toBe(false);
    time.advance(100);
    expect(scheduler.reveal(0, 6).instant).toBe(false);
    time.advance(200);
    expect(scheduler.reveal(0, 6).instant).toBe(true);
  });

  it("drops the fade while output is very fast, and brings it back once it calms", () => {
    const time = clock();
    const scheduler = new StreamingFadeScheduler(time.now);
    let length = 0;
    for (let window = 0; window < 3; window += 1) {
      time.advance(100);
      length += 400;
      scheduler.sync(length);
    }
    expect(scheduler.reveal(length - 10, 10)).toMatchObject({ delayMs: 0, instant: true });
    time.advance(500);
    length += 5;
    scheduler.sync(length);
    expect(scheduler.reveal(length - 5, 5).instant).toBe(false);
  });
});
