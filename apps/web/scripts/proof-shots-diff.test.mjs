import { describe, expect, it } from "vitest";

import {
  CHANGED_SHARE,
  CHANNEL_TOLERANCE,
  classify,
  diffPixels,
  screenProblem,
  summarize,
} from "./proof-shots-diff.mjs";

/** A width x height RGBA picture filled with one colour. */
function picture(width, height, [r, g, b]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return data;
}

describe("diffPixels", () => {
  it("ignores channel moves within the tolerance (anti-aliasing)", () => {
    const before = picture(10, 10, [100, 100, 100]);
    const after = picture(10, 10, [100 + CHANNEL_TOLERANCE, 100, 100 - CHANNEL_TOLERANCE]);
    expect(diffPixels(before, after, 10, 10, CHANNEL_TOLERANCE).changed).toBe(0);
  });

  it("counts a pixel whose channel moved past the tolerance and paints it red", () => {
    const before = picture(10, 10, [255, 255, 255]);
    const after = picture(10, 10, [255, 255, 255]);
    after.set([0, 0, 0, 255], 4 * 13);
    after.set([255, 255, 255 - CHANNEL_TOLERANCE - 1, 255], 4 * 57);
    const result = diffPixels(before, after, 10, 10, CHANNEL_TOLERANCE);
    expect(result.changed).toBe(2);
    expect(result.share).toBe(0.02);
    expect([...result.diff.slice(4 * 13, 4 * 13 + 4)]).toEqual([255, 0, 0, 255]);
    // An unchanged white pixel stays white in the diff picture.
    expect([...result.diff.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it("closes over nothing, so it can be sent to the browser as source text", () => {
    const rebuilt = new Function(`return (${diffPixels.toString()})`)();
    const before = picture(2, 1, [0, 0, 0]);
    const after = picture(2, 1, [0, 0, 0]);
    after.set([200, 0, 0, 255], 0);
    expect(rebuilt(before, after, 2, 1, CHANNEL_TOLERANCE).changed).toBe(1);
  });
});

describe("classify", () => {
  it("calls a picture changed only above the share threshold", () => {
    expect(classify({ inBase: true, inHead: true, share: CHANGED_SHARE })).toEqual({
      status: "same",
      share: CHANGED_SHARE,
    });
    expect(classify({ inBase: true, inHead: true, share: CHANGED_SHARE * 2 }).status).toBe(
      "changed",
    );
  });

  it("counts a size change as wholly changed and names new and gone pictures", () => {
    expect(classify({ inBase: true, inHead: true, share: null })).toEqual({
      status: "changed",
      share: 1,
    });
    expect(classify({ inBase: false, inHead: true, share: null }).status).toBe("new");
    expect(classify({ inBase: true, inHead: false, share: null }).status).toBe("gone");
  });
});

describe("summarize", () => {
  it("lists only the pictures that differ, with their share", () => {
    expect(
      summarize([
        { file: "home.light.png", status: "same", share: 0 },
        { file: "home.dark.png", status: "changed", share: 0.0423 },
        { file: "studio.light.png", status: "new" },
      ]),
    ).toEqual([
      "### Proof screenshots: 2 of 3 pictures differ from main",
      "",
      "| picture | change |",
      "| --- | --- |",
      "| home.dark.png | 4.23% of pixels |",
      "| studio.light.png | new |",
    ]);
  });

  it("says so when nothing changed", () => {
    expect(summarize([{ file: "home.light.png", status: "same", share: 0 }])).toEqual([
      "### Proof screenshots: 0 of 1 pictures differ from main",
      "",
      "No screen changed.",
    ]);
  });
});

describe("screenProblem", () => {
  it("accepts a screen that ended on its address with nothing over it", () => {
    expect(screenProblem({ path: "/apps" }, { pathname: "/apps", dialogVisible: false })).toBe(
      null,
    );
    expect(
      screenProblem(
        { path: /^\/[0-9a-f-]{36}$/ },
        { pathname: "/5eef745f-2504-4c62-9e5a-d821a36e936f", dialogVisible: false },
      ),
    ).toBe(null);
  });

  it("rejects a redirect, a missing marker and a covering dialog", () => {
    expect(screenProblem({ path: "/plugins" }, { pathname: "/skills", dialogVisible: false })).toBe(
      "ended on /skills, not /plugins",
    );
    expect(
      screenProblem(
        { marker: '[data-settings-section="voice"]', dialog: true },
        { pathname: "/x", markerVisible: false, dialogVisible: true },
      ),
    ).toBe('[data-settings-section="voice"] is not visible');
    expect(screenProblem({ path: "/apps" }, { pathname: "/apps", dialogVisible: true })).toBe(
      "covered by a dialog",
    );
  });

  it("lets the settings dialog stand over the screen it opened on", () => {
    expect(
      screenProblem(
        { marker: '[data-settings-section="voice"]', dialog: true },
        { pathname: "/5eef745f", markerVisible: true, dialogVisible: true },
      ),
    ).toBe(null);
  });
});
