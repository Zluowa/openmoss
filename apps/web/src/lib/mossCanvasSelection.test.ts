import { describe, expect, it } from "vitest";
import { parseMossCanvasComposeContext, parseMossCanvasSelection } from "./mossCanvasSelection";
const selection = {
  type: "moss-canvas-selection",
  version: 1,
  threadId: "thread-a",
  sequence: 1,
  documentEpoch: 1,
  items: [
    {
      shapeId: "shape:moss-image",
      assetId: `moss-canvas-asset:${"a".repeat(64)}.png`,
      title: "Selected image",
    },
  ],
};
describe("Canvas selection protocol", () => {
  it("accepts a bounded owned selection and explicit deselection", () => {
    expect(parseMossCanvasSelection(selection, "thread-a")).toEqual(selection);
    expect(parseMossCanvasSelection({ ...selection, items: [] }, "thread-a")?.items).toEqual([]);
  });
  it("rejects another thread, invalid epochs and duplicate shapes", () => {
    expect(parseMossCanvasSelection(selection, "thread-b")).toBeNull();
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        parseMossCanvasSelection({ ...selection, documentEpoch: value }, "thread-a"),
      ).toBeNull();
      expect(parseMossCanvasSelection({ ...selection, sequence: value }, "thread-a")).toBeNull();
    }
    expect(
      parseMossCanvasSelection(
        { ...selection, items: [selection.items[0], selection.items[0]] },
        "thread-a",
      ),
    ).toBeNull();
  });
  it("rejects arbitrary URLs and invalid shape identities", () => {
    for (const patch of [
      { assetId: "file:///private.png" },
      { assetId: "https://remote.test/image.png" },
      { shapeId: "" },
      { shapeId: "shape:bad/path" },
    ]) {
      expect(
        parseMossCanvasSelection(
          { ...selection, items: [{ ...selection.items[0], ...patch }] },
          "thread-a",
        ),
      ).toBeNull();
    }
  });
});

const ownedAnnotationAsset = `moss-canvas-asset:${"b".repeat(64)}.png`;
const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const contextItem = {
  ...selection.items[0]!,
  context: {
    annotations: [{ kind: "draw", ...region }],
    comments: [{ text: "请修改这一区域", region }],
    annotationAssetId: ownedAnnotationAsset,
    truncated: false,
  },
};
const contextResult = {
  type: "moss-canvas-compose-context-result",
  version: 1,
  threadId: "thread-a",
  requestId: "request-1",
  documentEpoch: 1,
  selectionSequence: 1,
  ok: true,
  items: [contextItem],
};

describe("Canvas compose context protocol", () => {
  it("accepts complete owned context, an unannotated selection and explicit deselection", () => {
    expect(parseMossCanvasComposeContext(contextResult, "thread-a")).toEqual(contextResult);
    expect(
      parseMossCanvasComposeContext({ ...contextResult, items: selection.items }, "thread-a")
        ?.items,
    ).toEqual(selection.items);
    expect(
      parseMossCanvasComposeContext({ ...contextResult, items: [] }, "thread-a")?.items,
    ).toEqual([]);
  });

  it("drops author identities, raw props and URLs from accepted context", () => {
    const result = parseMossCanvasComposeContext(
      {
        ...contextResult,
        items: [
          {
            ...contextItem,
            url: "file:///private.png",
            context: {
              ...contextItem.context,
              author: "private-user",
              snapshot: "private-snapshot",
              comments: [
                {
                  ...contextItem.context.comments[0],
                  author: "private-user",
                  raw: "private-state",
                },
              ],
            },
          },
        ],
      },
      "thread-a",
    );
    expect(result).toEqual(contextResult);
  });

  it("rejects another thread, a failure envelope and invalid document or selection leases", () => {
    expect(parseMossCanvasComposeContext(contextResult, "thread-b")).toBeNull();
    expect(parseMossCanvasComposeContext({ ...contextResult, ok: false }, "thread-a")).toBeNull();
    for (const invalid of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        parseMossCanvasComposeContext({ ...contextResult, documentEpoch: invalid }, "thread-a"),
      ).toBeNull();
      expect(
        parseMossCanvasComposeContext({ ...contextResult, selectionSequence: invalid }, "thread-a"),
      ).toBeNull();
    }
  });

  it("requires a complete registered annotation image and bounded normalized geometry", () => {
    const parseContext = (context: unknown) =>
      parseMossCanvasComposeContext(
        { ...contextResult, items: [{ ...contextItem, context }] },
        "thread-a",
      );
    expect(parseContext({ ...contextItem.context, annotationAssetId: undefined })).toBeNull();
    expect(
      parseContext({
        ...contextItem.context,
        annotationAssetId: "https://remote.test/private.png",
      }),
    ).toBeNull();
    for (const invalid of [
      { x: -1 },
      { width: Infinity },
      { height: NaN },
      { y: 0.9 },
      { kind: "script" },
      { text: "" },
      { text: "a".repeat(501) },
    ]) {
      expect(
        parseContext({
          ...contextItem.context,
          annotations: [{ ...contextItem.context.annotations[0], ...invalid }],
        }),
      ).toBeNull();
    }
    expect(
      parseContext({
        ...contextItem.context,
        comments: [{ text: "comment", region: { ...region, x: 0.9 } }],
      }),
    ).toBeNull();
    expect(parseContext({ ...contextItem.context, comments: [{ text: "", region }] })).toBeNull();
    expect(parseContext({ ...contextItem.context, truncated: undefined })).toBeNull();
  });

  it("limits aggregate annotations, comments, text and the combined original/guide attachment count", () => {
    const item = (index: number, count: number, comments = 0, text = "note") => ({
      ...contextItem,
      shapeId: `shape:item-${index}`,
      context: {
        ...contextItem.context,
        annotations: Array.from({ length: count }, () => ({ kind: "text", ...region, text })),
        comments: Array.from({ length: comments }, () => ({ text, region })),
      },
    });
    const parse = (items: unknown[]) =>
      parseMossCanvasComposeContext({ ...contextResult, items }, "thread-a");
    expect(parse([item(0, 33)])).toBeNull();
    expect(parse([item(0, 0, 17)])).toBeNull();
    expect(parse([item(0, 32), item(1, 32), item(2, 1)])).toBeNull();
    expect(parse([item(0, 0, 16), item(1, 0, 16), item(2, 0, 1)])).toBeNull();
    expect(parse([item(0, 17, 0, "a".repeat(500))])).toBeNull();
    expect(parse(Array.from({ length: 9 }, (_, index) => item(index, 1)))).toBeNull();
    expect(parse(Array.from({ length: 8 }, (_, index) => item(index, 1)))?.items).toHaveLength(8);
  });
});
