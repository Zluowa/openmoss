import { describe, expect, it, vi } from "vitest";

import { waitForBootstrapPaint } from "./bootstrapPaint";

describe("bootstrap paint boundary", () => {
  it("decodes the startup image and waits across one compositor paint", async () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    let finishDecode: (() => void) | undefined;
    const image = {
      decode: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDecode = resolve;
          }),
      ),
    };
    let finishMinimumVisibility: (() => void) | undefined;
    const waitForMinimumVisibility = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishMinimumVisibility = resolve;
        }),
    );
    let resolved = false;

    const pending = waitForBootstrapPaint(requestFrame, image, waitForMinimumVisibility).then(
      () => {
        resolved = true;
      },
    );

    expect(image.decode).toHaveBeenCalledOnce();
    expect(requestFrame).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    finishDecode?.();
    await Promise.resolve();
    expect(requestFrame).toHaveBeenCalledOnce();

    callbacks.shift()?.(0);
    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(resolved).toBe(false);

    callbacks.shift()?.(16);
    await Promise.resolve();
    expect(waitForMinimumVisibility).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);

    finishMinimumVisibility?.();
    await pending;
    expect(resolved).toBe(true);
  });
});
