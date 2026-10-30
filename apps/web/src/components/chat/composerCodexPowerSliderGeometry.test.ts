import { describe, expect, it } from "vitest";

import {
  clampPowerIndex,
  consumePowerWheel,
  createPowerWheelAccumulator,
  powerIndexFromPointer,
  powerIndexToPercent,
  powerRangeClipPath,
  powerRangeTransform,
  powerThumbInsetPx,
  powerThumbLeft,
} from "./composerCodexPowerSliderGeometry";

describe("composerCodexPowerSliderGeometry", () => {
  it("keeps the 28px thumb 1px past the 24px track at both ends", () => {
    expect(powerThumbInsetPx(0)).toBe(13);
    expect(powerThumbInsetPx(50)).toBe(0);
    expect(powerThumbInsetPx(100)).toBe(-13);
    expect(powerThumbLeft(0)).toBe("calc(0% + 13px)");
    expect(powerThumbLeft(100)).toBe("calc(100% + -13px)");
  });

  it("maps indices to evenly spaced percents", () => {
    expect(powerIndexToPercent(0, 6)).toBe(0);
    expect(powerIndexToPercent(3, 6)).toBe(60);
    expect(powerIndexToPercent(5, 6)).toBe(100);
    expect(powerIndexToPercent(0, 1)).toBe(0);
    expect(clampPowerIndex(-2, 6)).toBe(0);
    expect(clampPowerIndex(9, 6)).toBe(5);
    expect(clampPowerIndex(2.6, 6)).toBe(3);
  });

  it("translates the full-width range so its edge sits under the thumb center", () => {
    expect(powerRangeTransform(0, 5)).toBe("translateX(calc(-100% + 0px))");
    expect(powerRangeTransform(20, 5)).toBe("translateX(calc(-80% + 7.8px))");
    expect(powerRangeTransform(100, 5)).toBe("translateX(calc(0% + 0px))");
    expect(powerRangeTransform(50, 0)).toBe("translateX(-100%)");
    expect(powerRangeClipPath(100, 5)).toBe("inset(0 calc(0% - 0px) 0 0)");
  });

  it("maps pointer positions across the thumb travel, not the raw root width", () => {
    // Root is 228px wide: travel spans 14px..214px for six stops.
    expect(powerIndexFromPointer(0, 0, 228, 6)).toBe(0);
    expect(powerIndexFromPointer(14, 0, 228, 6)).toBe(0);
    expect(powerIndexFromPointer(214, 0, 228, 6)).toBe(5);
    expect(powerIndexFromPointer(114, 0, 228, 6)).toBe(3);
    expect(powerIndexFromPointer(500, 0, 228, 6)).toBe(5);
    expect(powerIndexFromPointer(40, 0, 228, 1)).toBe(0);
  });

  it("steps once per 30px of wheel travel and resets on idle or reversal", () => {
    const accumulator = createPowerWheelAccumulator();
    const base = { deltaX: 0, pixelDelta: true, invertedFromDevice: false };
    expect(consumePowerWheel(accumulator, { ...base, deltaY: 10, timeStamp: 0 })).toBe(0);
    expect(consumePowerWheel(accumulator, { ...base, deltaY: 20, timeStamp: 10 })).toBe(-1);
    // A large delta still moves one step per event; the remainder carries over.
    expect(consumePowerWheel(accumulator, { ...base, deltaY: -60, timeStamp: 20 })).toBe(1);
    expect(consumePowerWheel(accumulator, { ...base, deltaY: -20, timeStamp: 30 })).toBe(1);
    expect(consumePowerWheel(accumulator, { ...base, deltaY: -5, timeStamp: 40 })).toBe(0);
    // Idle gap resets the partial accumulation.
    expect(consumePowerWheel(accumulator, { ...base, deltaY: -20, timeStamp: 400 })).toBe(0);
    expect(
      consumePowerWheel(accumulator, {
        ...base,
        deltaY: 30,
        timeStamp: 410,
        invertedFromDevice: true,
      }),
    ).toBe(1);
    expect(
      consumePowerWheel(accumulator, {
        ...base,
        deltaX: 40,
        deltaY: 5,
        timeStamp: 420,
      }),
    ).toBe(1);
    expect(
      consumePowerWheel(createPowerWheelAccumulator(), {
        ...base,
        deltaY: 1,
        timeStamp: 0,
        pixelDelta: false,
      }),
    ).toBe(-1);
  });
});
