import { describe, expect, it } from "vitest";

import {
  THREAD_HISTORY_PREFETCH_DISTANCE_PX,
  shouldPrefetchThreadHistory,
} from "./threadHistoryPrefetch";

describe("thread history prefetch", () => {
  it("starts within the verified 800px history-gap distance", () => {
    expect(THREAD_HISTORY_PREFETCH_DISTANCE_PX).toBe(800);
    expect(shouldPrefetchThreadHistory(800)).toBe(true);
    expect(shouldPrefetchThreadHistory(801)).toBe(false);
  });
});
