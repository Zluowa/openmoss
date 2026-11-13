// FILE: DesignEditorTools.browser.tsx
// Purpose: The 设计 tools added for one-to-one parity, in a real browser: loose shapes on the bare
//          canvas, arrows and pen paths, element marquee with Ctrl, snapping while moving an
//          artboard, components (make, place, update everywhere), scale K, crop, the contrast
//          readout, flow page breaks and the live-room replica.
// Layer: Browser tests (headless Chromium)

import "../../../index.css";

import {
  applyDesignOps,
  createDesignCanvas,
  parseDesignCanvas,
  type DesignCanvas,
} from "@moss/shared/spaceItems/designCanvas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DesignCanvasView } from "./DesignCanvasView";
import { textContrast } from "./designColor";
import { flowBreaks } from "./designExport";
import { DesignInspector, type DesignPanelTab } from "./DesignInspector";
import { DesignRoomReplica } from "./designRoom";
import { snapRect } from "./designSnap";
import { cropOf, fullImageRect, readCrop, writeCrop } from "./designTransforms";
import { useDesignEditor, type DesignEditorState } from "./useDesignEditor";

const fixture: DesignCanvas = parseDesignCanvas({
  version: 1,
  pages: [{ id: "page-1", name: "页面 1" }],
  boards: [
    {
      id: "home",
      name: "首页",
      x: 0,
      y: 0,
      w: 400,
      h: 300,
      html: '<div style="position: relative; width: 400px; height: 300px; background: white"><h1 style="position: absolute; left: 20px; top: 20px; margin: 0; font-size: 28px; color: rgb(20, 20, 19)">你好</h1><p style="position: absolute; left: 20px; top: 80px; margin: 0">第二行</p></div>',
    },
    {
      id: "next",
      name: "第二页",
      x: 480,
      y: 0,
      w: 400,
      h: 300,
      html: '<div style="position: relative; width: 400px; height: 300px"></div>',
    },
  ],
  notes: [],
  system: null,
});

let mounted: { unmount: () => void } | null = null;
// The harness is 1200 px wide; a fixed window keeps every pointer inside it on any machine.
beforeEach(async () => {
  await page.viewport(1600, 900);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function Harness(props: { canvas: DesignCanvas; onEditor: (editor: DesignEditorState) => void }) {
  const editor = useDesignEditor({
    initial: props.canvas,
    epoch: 0,
    readOnly: false,
    onChange: () => undefined,
  });
  const [tab, setTab] = useState<DesignPanelTab>("properties");
  useEffect(() => {
    props.onEditor(editor);
  });
  useEffect(() => {
    editor.setView({ x: 40, y: 40, zoom: 1 });
    // Once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={{ display: "flex", width: 1200, height: 700 }}>
      <DesignCanvasView
        editor={editor}
        playing={null}
        onPlay={() => undefined}
        onNavigate={() => undefined}
        onRequestImage={() => undefined}
        onRequestVideo={() => undefined}
        onOpenLink={() => undefined}
        onComment={() => undefined}
        onContextMenu={() => undefined}
      />
      <div style={{ width: 320, display: "flex" }}>
        <DesignInspector
          editor={editor}
          tab={tab}
          onTab={setTab}
          scopeSpaceId={null}
          selfPageId="self"
          onAsk={() => undefined}
          onExportBoard={() => undefined}
          onReplaceImage={() => undefined}
          onOpenLink={() => undefined}
        />
      </div>
    </div>
  );
}

async function mount(canvas = fixture) {
  const state: { editor: DesignEditorState | null } = { editor: null };
  mounted = await render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness
        canvas={canvas}
        onEditor={(editor) => {
          state.editor = editor;
        }}
      />
    </QueryClientProvider>,
  );
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-design-frame]")].every(
        (frame) => frame.contentDocument?.readyState === "complete",
      ),
    )
    .toBe(true);
  await expect.poll(() => document.querySelectorAll("iframe[data-design-frame]").length).toBe(2);
  return state;
}

const editorOf = (state: { editor: DesignEditorState | null }) => state.editor!;
const frameDoc = (id: string) =>
  document.querySelector<HTMLIFrameElement>(`iframe[data-design-frame="${id}"]`)!.contentDocument!;

/** Pointer down, moves and up on the canvas at world points (view at 40,40, 100%). */
function dragCanvas(
  points: readonly { x: number; y: number }[],
  options: { ctrlKey?: boolean; detail?: number } = {},
) {
  const canvas = document.querySelector<HTMLElement>("[data-design-canvas]")!;
  const rect = canvas.getBoundingClientRect();
  const at = (point: { x: number; y: number }) => ({
    bubbles: true,
    clientX: rect.left + 40 + point.x,
    clientY: rect.top + 40 + point.y,
    button: 0,
    pointerId: 7,
    ...(options.ctrlKey ? { ctrlKey: true } : {}),
  });
  canvas.dispatchEvent(
    new PointerEvent("pointerdown", { ...at(points[0]!), detail: options.detail ?? 1 }),
  );
  for (const point of points.slice(1))
    canvas.dispatchEvent(new PointerEvent("pointermove", at(point)));
  canvas.dispatchEvent(new PointerEvent("pointerup", at(points.at(-1)!)));
}

describe("设计 tools", () => {
  it("draws a rectangle on the bare canvas as a loose shape", async () => {
    const state = await mount();
    editorOf(state).setTool("rect");
    await expect.poll(() => editorOf(state).tool).toBe("rect");
    dragCanvas([
      { x: 0, y: 400 },
      { x: 60, y: 450 },
      { x: 120, y: 480 },
    ]);
    await expect
      .poll(() => editorOf(state).latest.current.notes.find((note) => note.kind === "shape"))
      .toMatchObject({ shape: "rect", x: 0, y: 400, w: 120, h: 80 });
    await expect.poll(() => document.querySelector('[data-design-shape="rect"]')).not.toBeNull();
  });

  it("draws an arrow inside an artboard as an SVG element", async () => {
    const state = await mount();
    editorOf(state).setTool("arrow");
    await expect.poll(() => editorOf(state).tool).toBe("arrow");
    dragCanvas([
      { x: 40, y: 200 },
      { x: 200, y: 220 },
      { x: 300, y: 240 },
    ]);
    await expect.poll(() => editorOf(state).latest.current.boards[0]!.html).toContain("<polygon");
    expect(editorOf(state).latest.current.notes).toHaveLength(0);
  });

  it("builds a pen path from clicks and finishes it with Enter", async () => {
    const state = await mount();
    editorOf(state).setTool("pen");
    await expect.poll(() => editorOf(state).tool).toBe("pen");
    dragCanvas([{ x: 0, y: 500 }]);
    dragCanvas([{ x: 100, y: 520 }]);
    dragCanvas([{ x: 60, y: 600 }]);
    // The Enter listener attaches once the path is on screen.
    await expect
      .poll(() => document.querySelector("[data-design-pen]")?.getAttribute("data-design-pen"))
      .toBe("3");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await expect
      .poll(() => editorOf(state).latest.current.notes.find((note) => note.shape === "path")?.d)
      .toMatch(/^M0 0L100 20L60 100$/u);
  });

  it("frames elements inside an artboard with Ctrl-drag, starting outside it", async () => {
    const state = await mount();
    dragCanvas(
      [
        { x: -20, y: -30 },
        { x: 200, y: 200 },
        { x: 300, y: 140 },
      ],
      { ctrlKey: true },
    );
    await expect.poll(() => editorOf(state).selection.element?.paths.length).toBe(2);
    expect(editorOf(state).selection.element?.boardId).toBe("home");
  });

  it("snaps a moved artboard to its neighbour's top edge and shows a guide", async () => {
    const state = await mount();
    const strip = document.querySelector<HTMLElement>('[data-design-strip="next"]')!;
    const box = strip.getBoundingClientRect();
    const at = (dx: number, dy: number) => ({
      bubbles: true,
      clientX: box.left + 4 + dx,
      clientY: box.top + 4 + dy,
      button: 0,
      pointerId: 9,
    });
    strip.dispatchEvent(new PointerEvent("pointerdown", at(0, 0)));
    strip.dispatchEvent(new PointerEvent("pointermove", at(30, 4)));
    await expect.poll(() => document.querySelector("[data-design-snap]")).not.toBeNull();
    strip.dispatchEvent(new PointerEvent("pointerup", at(30, 4)));
    await expect
      .poll(() => editorOf(state).latest.current.boards.find((board) => board.id === "next"))
      .toMatchObject({ x: 510, y: 0 });
  });

  it("makes a component, places it on another artboard and updates every instance", async () => {
    const state = await mount();
    const editor = () => editorOf(state);
    editor().setSelection({ boards: [], notes: [], element: { boardId: "home", paths: ["0.0"] } });
    await expect.poll(() => editor().selectedElements()?.elements.length).toBe(1);
    const id = editor().createComponent("标题");
    expect(id).toBeTruthy();
    await expect.poll(() => editor().latest.current.components?.length).toBe(1);
    editor().placeComponent(id!, "next", { x: 10, y: 10 });
    await expect
      .poll(() => editor().latest.current.boards[1]!.html)
      .toContain(`data-design-component="${id}"`);
    // Change the instance on home, then make it the master: "next" follows.
    await expect.poll(() => frameDoc("home").querySelector("h1")?.textContent).toBe("你好");
    editor().editBoard("home", (body) => {
      body.querySelector("h1")!.textContent = "新标题";
      return undefined;
    });
    editor().setSelection({ boards: [], notes: [], element: { boardId: "home", paths: ["0.0"] } });
    await expect.poll(() => editor().selectedElements()?.elements.length).toBe(1);
    editor().pushInstanceToComponent();
    await expect.poll(() => editor().latest.current.boards[1]!.html).toContain("新标题");
    // The instance on "next" kept where it sits.
    expect(editor().latest.current.boards[1]!.html).toContain("left: 10px");
  });

  it("scales an element with its text (K)", async () => {
    const state = await mount();
    editorOf(state).setSelection({
      boards: [],
      notes: [],
      element: { boardId: "home", paths: ["0.0"] },
    });
    await expect.poll(() => editorOf(state).selectedElements()?.elements.length).toBe(1);
    editorOf(state).scaleSelection(2);
    await expect
      .poll(() => editorOf(state).latest.current.boards[0]!.html)
      .toContain("font-size: 56px");
    // Where it sits does not scale.
    expect(editorOf(state).latest.current.boards[0]!.html).toContain("left: 20px");
  });

  it("reads text contrast against what is behind it", async () => {
    await mount();
    const heading = frameDoc("home").querySelector("h1")!;
    const readout = textContrast(heading)!;
    expect(readout.ratio).toBeGreaterThan(15);
    expect(readout.verdict).toBe("good");
  });
});

describe("设计 geometry and room", () => {
  it("crops a picture without moving what stays visible, and reads the crop back", () => {
    const image = document.createElement("img");
    image.style.position = "absolute";
    const box = { x: 100, y: 100, w: 200, h: 100 };
    const full = fullImageRect(box, readCrop(image));
    const kept = { x: 150, y: 110, w: 100, h: 80 };
    const crop = cropOf(full, kept);
    writeCrop(image, crop, kept, { box, left: 100, top: 100, free: true });
    expect(image.style.left).toBe("150px");
    expect(image.style.width).toBe("100px");
    const back = readCrop(image);
    expect(back.left).toBeCloseTo(0.25, 2);
    expect(fullImageRect(kept, back)).toMatchObject({ x: 100, w: 200 });
  });

  it("breaks a tall page between blocks, not through them", () => {
    const breaks = flowBreaks(
      [
        { top: 0, bottom: 300 },
        { top: 320, bottom: 900 },
        { top: 1000, bottom: 1400 },
      ],
      1600,
      1000,
    );
    expect(breaks[0]).toBe(0);
    expect(breaks[1]).toBeLessThanOrEqual(1000);
    expect(breaks[1]).toBeGreaterThanOrEqual(900);
    expect(breaks.at(-1)).toBe(1600);
  });

  it("snaps to edges and centres, and to an equal gap", () => {
    const aligned = snapRect({ x: 0, y: 3, w: 50, h: 50 }, [{ x: 100, y: 0, w: 50, h: 50 }], 6);
    expect(aligned.dy).toBe(-3);
    expect(aligned.lines.some((line) => line.axis === "y")).toBe(true);
    const spaced = snapRect(
      { x: 118, y: 0, w: 40, h: 40 },
      [
        { x: 0, y: 0, w: 40, h: 40 },
        { x: 240, y: 0, w: 40, h: 40 },
      ],
      6,
    );
    expect(spaced.dx).toBe(2);
    expect(spaced.gaps).toHaveLength(2);
  });

  it("a replica shows its pending edits on top of everyone's confirmed order", () => {
    const base = createDesignCanvas();
    const replica = new DesignRoomReplica(base, 0);
    const mine = applyDesignOps(base, [
      { op: "upsertNote", note: { id: "mine", kind: "sticky", x: 0, y: 0, text: "我的" } },
    ]);
    const sent = replica.local(base, mine)!;
    // Someone else's op lands first on the server.
    replica.remote(1, "other", "me", "1", [
      { op: "upsertNote", note: { id: "theirs", kind: "sticky", x: 9, y: 9, text: "他的" } },
    ]);
    expect(replica.view().notes.map((note) => note.id)).toEqual(["theirs", "mine"]);
    // Then mine is confirmed: nothing pending, the same view.
    expect(replica.remote(2, "me", "me", sent.id, sent.ops)).toBe(false);
    expect(replica.pending).toHaveLength(0);
    expect(replica.view().notes.map((note) => note.id)).toEqual(["theirs", "mine"]);
  });
});
