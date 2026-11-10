import { describe, expect, it } from "vitest";

import { ByteAccumulator } from "./byteAccumulator";

const bytes = (value: Uint8Array): readonly number[] => Array.from(value);

describe("ByteAccumulator", () => {
  it("takes a prefix that spans several chunks and keeps the remainder", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2));
    accumulator.append(Uint8Array.of(3, 4, 5));
    accumulator.append(Uint8Array.of(6));

    expect(bytes(accumulator.take(4))).toEqual([1, 2, 3, 4]);
    expect(accumulator.byteLength).toBe(2);
    expect(bytes(accumulator.take(2))).toEqual([5, 6]);
    expect(accumulator.byteLength).toBe(0);
  });

  it("reads a u32 whose bytes straddle chunk boundaries", () => {
    const accumulator = new ByteAccumulator();
    const value = Buffer.alloc(4);
    value.writeUInt32LE(0xfedc_ba98, 0);
    accumulator.append(value.subarray(0, 1));
    accumulator.append(value.subarray(1, 3));
    accumulator.append(value.subarray(3));

    expect(accumulator.readUInt32LE(0)).toBe(0xfedc_ba98);
    expect(accumulator.byteLength).toBe(4);
  });

  it("skips without disturbing the bytes after the skipped range", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2, 3));
    accumulator.append(Uint8Array.of(4, 5));
    accumulator.skip(4);

    expect(bytes(accumulator.take(1))).toEqual([5]);
  });

  it("copies appended chunks so the caller can reuse its buffer", () => {
    const accumulator = new ByteAccumulator();
    const scratch = Uint8Array.of(9, 9);
    accumulator.append(scratch);
    scratch.fill(0);

    expect(bytes(accumulator.take(2))).toEqual([9, 9]);
  });

  it("rejects reads past the buffered bytes", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2, 3));

    expect(() => accumulator.readUInt32LE(0)).toThrow(RangeError);
    expect(() => accumulator.take(4)).toThrow(RangeError);
    expect(() => accumulator.skip(-1)).toThrow(RangeError);
    expect(accumulator.byteLength).toBe(3);
  });

  it.each([0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 2])(
    "rejects u32 offset %s the same way for split and contiguous buffers",
    (offset) => {
      const split = new ByteAccumulator();
      split.append(Uint8Array.of(1));
      split.append(Uint8Array.of(2, 3, 4, 5));
      const contiguous = new ByteAccumulator();
      contiguous.append(Uint8Array.of(1, 2, 3, 4, 5));

      expect(() => split.readUInt32LE(offset)).toThrow(RangeError);
      expect(() => contiguous.readUInt32LE(offset)).toThrow(RangeError);
      expect(split.byteLength).toBe(5);
      expect(contiguous.byteLength).toBe(5);
      expect(bytes(split.take(5))).toEqual([1, 2, 3, 4, 5]);
      expect(bytes(contiguous.take(5))).toEqual([1, 2, 3, 4, 5]);
    },
  );

  it("reads u32 values at the first and last valid offsets across chunks", () => {
    const split = new ByteAccumulator();
    split.append(Uint8Array.of(1));
    split.append(Uint8Array.of(2, 3, 4, 5));
    const contiguous = new ByteAccumulator();
    contiguous.append(Uint8Array.of(1, 2, 3, 4, 5));

    for (const accumulator of [split, contiguous]) {
      expect(accumulator.readUInt32LE(0)).toBe(0x0403_0201);
      expect(accumulator.readUInt32LE(1)).toBe(0x0504_0302);
      expect(accumulator.byteLength).toBe(5);
    }
  });

  it("rejects fractional take and skip lengths without consuming bytes", () => {
    const accumulator = new ByteAccumulator();
    accumulator.append(Uint8Array.of(1, 2, 3));

    expect(() => accumulator.take(1.5)).toThrow(RangeError);
    expect(() => accumulator.skip(0.5)).toThrow(RangeError);
    expect(() => accumulator.take(Number.NaN)).toThrow(RangeError);
    expect(accumulator.byteLength).toBe(3);
    expect(bytes(accumulator.take(3))).toEqual([1, 2, 3]);
  });
});
