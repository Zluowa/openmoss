// FILE: layoutReport.browser.tsx
// Purpose: `layout_report` finds what a person would see broken, from real layout in Chromium:
//          clipped and spilling content, cut text, popups off the window, controls on top of
//          each other or under the window's own buttons. A healthy screen reports nothing.

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { layoutReport, type LayoutFinding } from "./layoutReport";

const WIDTH = 1000;
const HEIGHT = 700;

beforeEach(async () => {
  await page.viewport(WIDTH, HEIGHT);
  document.body.style.margin = "0";
});
afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): void {
  document.body.innerHTML = `<div id="fixture" style="position:relative;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden">${html}</div>`;
}

/** The finding points at the element a person sees, with its real box. */
function expectFinding(finding: LayoutFinding | undefined, element: Element) {
  expect(finding).toBeDefined();
  expect(document.querySelector(finding!.selector)).toBe(element);
  const box = element.getBoundingClientRect();
  expect(finding!.rect.x).toBeCloseTo(box.left, 0);
  expect(finding!.rect.y).toBeCloseTo(box.top, 0);
  expect(finding!.rect.width).toBeCloseTo(box.width, 0);
  expect(finding!.rect.height).toBeCloseTo(box.height, 0);
}

const of = (kind: LayoutFinding["kind"]) =>
  layoutReport({ windowControls: "none" }).findings.filter((finding) => finding.kind === kind);

describe("layout_report", () => {
  it("reports a control cut off by its container, against that container", () => {
    mount(`
      <div id="card" style="position:absolute;left:20px;top:20px;width:200px;height:60px;overflow:hidden">
        <button id="cut" style="position:absolute;left:150px;top:10px;width:100px;height:30px">Send</button>
      </div>`);
    const [finding] = of("clipped");
    expectFinding(finding, document.getElementById("cut")!);
    expect(document.querySelector(finding!.against.selector)).toBe(document.getElementById("card"));
    expect(finding!.against.rect).toMatchObject({ x: 20, y: 20, width: 200, height: 60 });
  });

  it("does not report rows scrolled out of a scrolling list", () => {
    mount(`
      <div style="position:absolute;left:0;top:0;width:300px;height:120px;overflow:auto">
        ${Array.from({ length: 30 }, (_, i) => `<button style="display:block;width:280px;height:30px">Row ${i}</button>`).join("")}
      </div>`);
    expect(layoutReport({ windowControls: "none" }).findings).toEqual([]);
  });

  it("reports content that spills out of a box that does not clip it", () => {
    mount(`
      <div id="box" style="position:absolute;left:10px;top:200px;width:120px;height:40px;background:#eee">
        <div id="wide" style="width:300px;height:20px;background:#ccc"></div>
      </div>`);
    const [finding] = of("overflow");
    expectFinding(finding, document.getElementById("wide")!);
    expect(document.querySelector(finding!.against.selector)).toBe(document.getElementById("box"));
  });

  it("reports text cut off without an ellipsis, and not text that ends in one", () => {
    mount(`
      <div id="cut" style="position:absolute;left:10px;top:300px;width:90px;white-space:nowrap;overflow:hidden">A very long project name that cannot fit</div>
      <div id="ellipsis" style="position:absolute;left:10px;top:340px;width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A very long project name that cannot fit</div>`);
    const findings = of("truncated-text");
    expect(findings).toHaveLength(1);
    expectFinding(findings[0], document.getElementById("cut")!);
  });

  it("reports a popup that sits partly outside the window, against the window", () => {
    mount(`<div id="menu" role="menu" style="position:fixed;left:${WIDTH - 60}px;top:100px;width:200px;height:120px;background:#fff">
      <div role="menuitem">Rename</div></div>`);
    const [finding] = of("popup-outside-window");
    expectFinding(finding, document.getElementById("menu")!);
    expect(finding!.against).toEqual({
      selector: "window",
      rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
  });

  it("reports two controls drawn on top of each other, and not two side by side", () => {
    mount(`
      <button id="a" style="position:absolute;left:400px;top:400px;width:80px;height:30px">Stop</button>
      <button id="b" style="position:absolute;left:440px;top:410px;width:80px;height:30px">Send</button>
      <button style="position:absolute;left:600px;top:400px;width:80px;height:30px">Left</button>
      <button style="position:absolute;left:690px;top:400px;width:80px;height:30px">Right</button>`);
    const findings = of("overlapping-controls");
    expect(findings).toHaveLength(1);
    const ids = [findings[0]!.selector, findings[0]!.against.selector].map(
      (selector) => document.querySelector(selector)?.id,
    );
    expect(ids.toSorted()).toEqual(["a", "b"]);
  });

  it("reports a control under the desktop window's own buttons (Windows right, macOS left)", () => {
    mount(`
      <button id="right" style="position:absolute;right:20px;top:6px;width:60px;height:28px">Skip</button>
      <button id="left" style="position:absolute;left:12px;top:6px;width:60px;height:28px">Back</button>
      <button id="clear" style="position:absolute;left:400px;top:6px;width:60px;height:28px">Title</button>`);
    const windows = layoutReport({ windowControls: "windows" });
    expect(windows.windowControls).toEqual({ x: WIDTH - 138, y: 0, width: 138, height: 44 });
    const underWindows = windows.findings.filter((f) => f.kind === "under-window-controls");
    expect(underWindows.map((f) => document.querySelector(f.selector)?.id)).toEqual(["right"]);
    expect(underWindows[0]!.against.selector).toBe("window-controls");

    const mac = layoutReport({ windowControls: "mac" });
    const underMac = mac.findings.filter((f) => f.kind === "under-window-controls");
    expect(underMac.map((f) => document.querySelector(f.selector)?.id)).toEqual(["left"]);

    expect(layoutReport({ windowControls: "none" }).windowControls).toBeNull();
  });

  it("takes the window's buttons from the page when Moss draws them, and never reports them", () => {
    mount(`
      <div data-desktop-window-controls aria-hidden="true" style="position:fixed;top:0;right:0;height:44px;display:flex;z-index:10">
        <button aria-label="Minimize" style="width:46px;height:44px"></button>
        <button aria-label="Maximize" style="width:46px;height:44px"></button>
        <button aria-label="Close" style="width:46px;height:44px"></button>
      </div>
      <button id="under" style="position:absolute;right:100px;top:6px;width:60px;height:28px">Skip</button>
      <button id="covered" style="position:absolute;right:20px;top:6px;width:60px;height:28px">Skip too</button>`);
    const report = layoutReport({ windowControls: "auto" });
    expect(report.windowControls).toEqual({ x: WIDTH - 138, y: 0, width: 138, height: 44 });
    // Also the one the buttons are drawn over, which no click reaches: that is the defect.
    expect(report.findings.map((f) => [f.kind, document.querySelector(f.selector)?.id])).toEqual([
      ["under-window-controls", "under"],
      ["under-window-controls", "covered"],
    ]);
  });

  it("leaves out what a person cannot see: screen-reader text, an icon's small halo", () => {
    mount(`
      <button style="position:absolute;left:20px;top:100px;width:120px;height:32px">
        <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Toggle the sidebar for keyboard users</span>
        Menu
      </button>
      <div style="position:absolute;left:20px;top:200px;width:16px;height:16px">
        <div style="width:22px;height:22px;margin:-3px"></div>
      </div>`);
    expect(layoutReport({ windowControls: "none" }).findings).toEqual([]);
  });

  it("reports nothing for a healthy screen", () => {
    mount(`
      <header style="display:flex;gap:8px;height:44px;align-items:center;padding:0 150px 0 100px">
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A long chat title that ends in an ellipsis when it has to</span>
        <button style="width:60px;height:28px">Share</button>
      </header>
      <main style="display:flex;gap:12px;padding:16px">
        <button style="width:80px;height:30px">One</button>
        <button style="width:80px;height:30px">Two</button>
        <input aria-label="Message" style="width:300px;height:30px" value="A draft">
      </main>`);
    expect(layoutReport({ windowControls: "windows" }).findings).toEqual([]);
  });

  it("keeps to `root` and to `max`", () => {
    mount(`
      <section id="one">${Array.from({ length: 5 }, (_, i) => `<div style="width:60px;white-space:nowrap;overflow:hidden">Cut text number ${i} that is long</div>`).join("")}</section>
      <section id="two"><div style="width:60px;white-space:nowrap;overflow:hidden">Other cut text that is long</div></section>`);
    const scoped = layoutReport({ root: "#two", windowControls: "none" });
    expect(scoped.findings).toHaveLength(1);
    const bounded = layoutReport({ max: 2, windowControls: "none" });
    expect(bounded.findings).toHaveLength(2);
    expect(bounded.more).toBe(4);
  });
});
