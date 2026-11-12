import { describe, expect, it } from "vitest";

import { createMcpAppFirstSizeSettler } from "./sizing";

function harness() {
  let clock = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextId = 1;
  const applied: number[] = [];
  const settler = createMcpAppFirstSizeSettler({
    apply: (height) => applied.push(height),
    now: () => clock,
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: clock + ms, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    clock = until;
  };
  return { settler, applied, advance };
}

describe("createMcpAppFirstSizeSettler", () => {
  it("opens once at the height a start-up burst settles on, then follows every report", () => {
    const { settler, applied, advance } = harness();
    // debug: 978 → 1961 → 1974 → 1997 → 2005, 40 ms apart.
    for (const height of [978, 1961, 1974, 1997, 2005]) {
      settler.report(height);
      advance(40);
    }
    expect(applied).toEqual([]);
    advance(80);
    expect(applied).toEqual([2005]);
    settler.report(2100);
    expect(applied).toEqual([2005, 2100]);
  });

  it("shows the first height by 300 ms even if reports keep coming", () => {
    const { settler, applied, advance } = harness();
    for (let step = 0; step < 10; step += 1) {
      settler.report(100 + step);
      advance(50);
    }
    expect(applied[0]).toBe(105);
    expect(applied.at(-1)).toBe(109);
  });

  it("drops a pending first height when cancelled", () => {
    const { settler, applied, advance } = harness();
    settler.report(400);
    settler.cancel();
    advance(500);
    expect(applied).toEqual([]);
  });
});
