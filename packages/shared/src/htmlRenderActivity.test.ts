import { describe, expect, it } from "vitest";

import { HTML_RENDER_MAX_HEIGHT } from "./htmlRender";
import {
  HTML_RENDER_ACTIVITY_KIND,
  htmlRenderActivityPayload,
  htmlRenderFromActivity,
} from "./htmlRenderActivity";

const reference = {
  attachmentId: "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e",
  title: "Plan",
  height: 420,
};

describe("htmlRenderFromActivity", () => {
  it("reads the page a published-render activity carries", () => {
    expect(
      htmlRenderFromActivity({
        kind: HTML_RENDER_ACTIVITY_KIND,
        payload: htmlRenderActivityPayload(reference),
      }),
    ).toEqual(reference);
  });

  it("clamps the stored height like any other reference", () => {
    expect(
      htmlRenderFromActivity({
        kind: HTML_RENDER_ACTIVITY_KIND,
        payload: { htmlRender: { ...reference, height: 99_999 } },
      })?.height,
    ).toBe(HTML_RENDER_MAX_HEIGHT);
  });

  it("ignores other activities and malformed payloads", () => {
    expect(
      htmlRenderFromActivity({
        kind: "tool.completed",
        payload: htmlRenderActivityPayload(reference),
      }),
    ).toBeUndefined();
    expect(
      htmlRenderFromActivity({ kind: HTML_RENDER_ACTIVITY_KIND, payload: null }),
    ).toBeUndefined();
    expect(
      htmlRenderFromActivity({
        kind: HTML_RENDER_ACTIVITY_KIND,
        payload: { htmlRender: { ...reference, attachmentId: 7 } },
      }),
    ).toBeUndefined();
  });
});
