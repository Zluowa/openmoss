// FILE: DesignEditorCore.browser.tsx
// Purpose: Exercises the 设计 editor core in a real browser: artboards render from their source
//          with the design system's variables, clicking an artboard element selects it, panel
//          fields and commands patch the source, undo/redo restore it, artboards move by their
//          name strip, and exports keep links between artboards.
// Layer: Browser tests (headless Chromium)

import "../../../index.css";

import { parseDesignCanvas, type DesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { findDesignTemplate } from "@moss/shared/spaceItems/designTemplates";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DesignCanvasView } from "./DesignCanvasView";
import { boardSrcdoc } from "./designDocument";
import { exportBoardPng, exportBoardsPdf, standaloneBoardHtml } from "./designExport";
import { DesignInspector, type DesignPanelTab } from "./DesignInspector";
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
      interactive: true,
      html: '<div style="position: relative; width: 400px; height: 300px; display: flex; flex-direction: column; gap: 12px; padding: 24px; box-sizing: border-box; background: var(--ds-paper)"><h1 style="margin: 0; font-size: 28px; color: var(--ds-ink)">你好</h1><p style="margin: 0">第二行</p><a href="board:next" style="color: var(--ds-accent)">下一页</a></div>',
    },
    {
      id: "next",
      name: "第二页",
      x: 480,
      y: 0,
      w: 400,
      h: 300,
      html: '<div style="width: 400px; height: 300px"><p>第二页</p></div>',
    },
  ],
  notes: [{ id: "n1", kind: "sticky", x: 0, y: 360, w: 240, text: "备注", color: "yellow" }],
  system: (() => {
    const template = findDesignTemplate("builtin:design-social")!;
    return template.canvas.system;
  })(),
});

let mounted: { unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function Harness(props: {
  canvas: DesignCanvas;
  onEditor: (editor: DesignEditorState) => void;
  onChange: (canvas: DesignCanvas) => void;
}) {
  const editor = useDesignEditor({
    initial: props.canvas,
    epoch: 0,
    readOnly: false,
    onChange: props.onChange,
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
      <div style={{ width: 300, display: "flex" }}>
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
  const state: { editor: DesignEditorState | null; saved: DesignCanvas[] } = {
    editor: null,
    saved: [],
  };
  const client = new QueryClient();
  mounted = await render(
    <QueryClientProvider client={client}>
      <Harness
        canvas={canvas}
        onEditor={(editor) => (state.editor = editor)}
        onChange={(next) => state.saved.push(next)}
      />
    </QueryClientProvider>,
  );
  await expect.poll(() => document.querySelectorAll("iframe[data-design-frame]").length).toBe(2);
  // Both frames loaded their documents.
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-design-frame]")].every(
        (frame) =>
          frame.contentDocument?.body?.firstElementChild !== null &&
          frame.contentDocument?.readyState === "complete",
      ),
    )
    .toBe(true);
  return state;
}

const frame = (id: string) =>
  document.querySelector<HTMLIFrameElement>(`iframe[data-design-frame="${id}"]`)!;
const html = (state: { editor: DesignEditorState | null }, id: string) =>
  state.editor!.latest.current.boards.find((board) => board.id === id)!.html;

/** Clicks the canvas at an artboard-local point (the view is at 40,40 and 100%). */
function clickBoard(local: { x: number; y: number }, options: { shiftKey?: boolean } = {}) {
  const canvas = document.querySelector<HTMLElement>("[data-design-canvas]")!;
  const rect = canvas.getBoundingClientRect();
  const init = {
    bubbles: true,
    clientX: rect.left + 40 + local.x,
    clientY: rect.top + 40 + local.y,
    button: 0,
    pointerId: 1,
    ...options,
  };
  canvas.dispatchEvent(new PointerEvent("pointerdown", init));
  canvas.dispatchEvent(new PointerEvent("pointerup", init));
}

describe("设计 editor core", () => {
  it("renders artboards from their source with the design system's variables and sandboxes them", async () => {
    await mount();
    const home = frame("home");
    expect(home.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(home.contentDocument!.querySelector("h1")!.textContent).toBe("你好");
    const styles = home.contentDocument!.querySelector("style[data-moss-design]")!.textContent!;
    expect(styles).toContain("--ds-ink:");
    expect(
      home
        .contentDocument!.querySelector('meta[http-equiv="Content-Security-Policy"]')!
        .getAttribute("content"),
    ).toContain("default-src 'none'");
    expect(document.querySelector('[data-design-strip="home"]')!.textContent).toContain("首页");
    expect(document.querySelector('[data-design-note="n1"]')!.textContent).toBe("备注");
    // Scripts never run while editing.
    expect(boardSrcdoc(fixture.boards[0]!, fixture, "edit")).not.toContain("moss-design-nav");
  });

  it("selects an element by clicking it, edits it from the panel, and undoes the edit", async () => {
    const state = await mount();
    const heading = frame("home").contentDocument!.querySelector("h1")!.getBoundingClientRect();
    clickBoard({ x: heading.x + 5, y: heading.y + 5 });
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.0"]);
    await expect.poll(() => document.querySelector('[data-design-selected="0.0"]')).not.toBeNull();
    await expect
      .poll(() => document.querySelector("[data-design-inspector]")!.textContent)
      .toContain("文字");
    await page.getByRole("textbox", { name: "字号", exact: true }).fill("40");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => html(state, "home")).toContain("font-size: 40px");
    expect(frame("home").contentDocument!.querySelector("h1")!.style.fontSize).toBe("40px");
    state.editor!.undo();
    await expect.poll(() => html(state, "home")).toContain("font-size: 28px");
    // The frame reloads from the restored source.
    await expect
      .poll(() => frame("home").contentDocument?.querySelector("h1")?.style.fontSize)
      .toBe("28px");
    state.editor!.redo();
    await expect.poll(() => html(state, "home")).toContain("font-size: 40px");
    expect(state.saved.length).toBeGreaterThan(0);
  });

  it("groups, ungroups, duplicates, reorders and deletes elements in the source", async () => {
    const state = await mount();
    const doc = () => frame("home").contentDocument!;
    const at = (selector: string) => doc().querySelector(selector)!.getBoundingClientRect();
    clickBoard({ x: at("h1").x + 3, y: at("h1").y + 3 });
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.0"]);
    clickBoard({ x: at("p").x + 3, y: at("p").y + 3 }, { shiftKey: true });
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.0", "0.1"]);
    state.editor!.wrapSelection("flex-row");
    await expect
      .poll(() => html(state, "home"))
      .toMatch(
        /<div style="display: flex; flex-direction: row; align-items: center; gap: 12px;?"><h1/u,
      );
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.0"]);
    state.editor!.ungroupSelection();
    await expect.poll(() => doc().querySelector("h1")!.parentElement!.children.length).toBe(3);
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.0", "0.1"]);
    state.editor!.setSelection({
      boards: [],
      notes: [],
      element: { boardId: "home", paths: ["0.1"] },
    });
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.1"]);
    state.editor!.duplicateSelection();
    await expect.poll(() => doc().querySelectorAll("p").length).toBe(2);
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.2"]);
    state.editor!.reorderSelection("back");
    await expect.poll(() => doc().querySelector("div")!.firstElementChild!.tagName).toBe("P");
    await expect.poll(() => state.editor!.selection.element?.paths).toEqual(["0.0"]);
    state.editor!.deleteSelection();
    await expect.poll(() => doc().querySelectorAll("p").length).toBe(1);
    expect(html(state, "home")).not.toContain("contenteditable");
  });

  it("inserts a shape where the tool clicks and moves artboards by their name strip", async () => {
    const state = await mount();
    state.editor!.setTool("rect");
    await expect.poll(() => state.editor!.tool).toBe("rect");
    clickBoard({ x: 200, y: 150 });
    await expect
      .poll(() => html(state, "home"))
      .toMatch(
        /position: absolute; left: 200px; top: 150px; box-sizing: border-box; width: 120px; height: 120px/u,
      );
    expect(state.editor!.tool).toBe("select");

    const strip = document.querySelector<HTMLElement>('[data-design-strip="next"]')!;
    const box = strip.getBoundingClientRect();
    const start = {
      bubbles: true,
      clientX: box.left + 4,
      clientY: box.top + 4,
      button: 0,
      pointerId: 2,
    };
    strip.dispatchEvent(new PointerEvent("pointerdown", start));
    strip.dispatchEvent(
      new PointerEvent("pointermove", {
        ...start,
        clientX: start.clientX + 100,
        clientY: start.clientY + 50,
      }),
    );
    strip.dispatchEvent(
      new PointerEvent("pointerup", {
        ...start,
        clientX: start.clientX + 100,
        clientY: start.clientY + 50,
      }),
    );
    await expect
      .poll(() => state.editor!.latest.current.boards.find((board) => board.id === "next"))
      .toMatchObject({ x: 580, y: 50 });
    state.editor!.undo();
    await expect
      .poll(() => state.editor!.latest.current.boards.find((board) => board.id === "next"))
      .toMatchObject({ x: 480, y: 0 });
  });

  it("adds, renames and deletes pages; deleting is undoable", async () => {
    const state = await mount();
    state.editor!.addPage();
    await expect.poll(() => state.editor!.latest.current.pages.length).toBe(2);
    await expect.poll(() => document.querySelectorAll("iframe[data-design-frame]").length).toBe(0);
    state.editor!.addBoard({ x: 0, y: 0, w: 390, h: 844 }, "手机");
    await expect.poll(() => document.querySelectorAll("iframe[data-design-frame]").length).toBe(1);
    const second = state.editor!.pageId;
    state.editor!.renamePage(second, "流程");
    await expect.poll(() => state.editor!.latest.current.pages[1]!.name).toBe("流程");
    state.editor!.deletePage(second);
    await expect.poll(() => state.editor!.latest.current.pages.length).toBe(1);
    expect(state.editor!.latest.current.boards.map((board) => board.id)).toEqual(["home", "next"]);
    state.editor!.undo();
    await expect.poll(() => state.editor!.latest.current.pages.length).toBe(2);
  });

  it("exports standalone HTML whose board links point at sibling files", () => {
    const files = new Map([
      ["home", "首页.html"],
      ["next", "第二页.html"],
    ]);
    const page = standaloneBoardHtml(fixture.boards[0]!, fixture, files);
    expect(page).toContain(`href="${encodeURI("第二页.html")}"`);
    expect(page).toContain("--ds-ink:");
    expect(page).not.toContain("Content-Security-Policy");
  });

  it("paints artboards to PNG at the chosen scale and to a PDF with one page per artboard", async () => {
    const png = await exportBoardPng(fixture.boards[0]!, fixture, 2);
    expect(png.filename).toBe("首页.png");
    expect(png.blob.type).toBe("image/png");
    const bitmap = await createImageBitmap(png.blob);
    expect([bitmap.width, bitmap.height]).toEqual([800, 600]);
    const pdf = await exportBoardsPdf(fixture.boards, fixture, "测试设计");
    const text = new TextDecoder("latin1").decode(new Uint8Array(await pdf.blob.arrayBuffer()));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.match(/\/Type \/Page /gu)?.length).toBe(2);
    expect(text).toContain("/MediaBox [0 0 300 225]");
  });
});
