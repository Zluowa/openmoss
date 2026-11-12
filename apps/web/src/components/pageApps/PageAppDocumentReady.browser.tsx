// FILE: PageAppDocumentReady.browser.tsx
// Purpose: An agent-written 应用页 renders in a real browser whether its code waits for the
//          document or not, and a page whose code throws shows a plain message, not a blank frame.
// Layer: Web browser tests

import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// The 可视化 bar chart the way an agent wrote it in acceptance round 9: code in <head> that
// fills #root at top level.
const barChart = (theme: "light" | "dark") => `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root{color-scheme:${theme};--fg:${theme === "dark" ? "#ececec" : "#1f1f1f"};--muted:${theme === "dark" ? "#9a9a9a" : "#6b6b6b"};--bar:${theme === "dark" ? "#7aa2f7" : "#3b6fd8"};--bg:${theme === "dark" ? "#1e1e1e" : "#ffffff"}}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
  #root{padding:24px}.chart{display:flex;align-items:flex-end;gap:24px;height:180px;border-bottom:1px solid var(--muted)}
  .col{display:flex;flex-direction:column;align-items:center;gap:6px}.bar{width:48px;background:var(--bar);border-radius:6px 6px 0 0}
  .label{color:var(--muted)}
</style>
<script>
  var data = [["甲", 3], ["乙", 5], ["丙", 2]];
  document.getElementById("root").innerHTML = '<h2>柱状图</h2><div class="chart">' + data.map(function (d) {
    return '<div class="col"><span>' + d[1] + '</span><div class="bar" style="height:' + d[1] * 30 + 'px"></div><span class="label">' + d[0] + '</span></div>';
  }).join("") + '</div>';
</script></head><body><div id="root"></div></body></html>`;

async function mount(source: string) {
  const html = injectPageAppFrameRuntime(
    source,
    buildPageAppFrameRuntime({ parentOrigin: window.location.origin, plugins: [] }),
  );
  const mounted = await render(
    <iframe title="app" srcDoc={html} style={{ width: 480, height: 300, border: 0 }} />,
  );
  const frame = mounted.container.querySelector("iframe")!;
  const doc = () => frame.contentDocument!;
  await vi.waitFor(() => expect(doc().readyState).toBe("complete"));
  return { mounted, doc };
}

describe("应用页 document readiness", () => {
  it("renders code that fills #root at top level from <head>", async () => {
    for (const theme of ["light", "dark"] as const) {
      const { mounted, doc } = await mount(barChart(theme));
      await vi.waitFor(() => expect(doc().querySelectorAll(".bar")).toHaveLength(3));
      expect(doc().body.innerText).toContain("乙");
      await mounted.unmount();
    }
  });

  it("renders code that waits for DOMContentLoaded", async () => {
    const { mounted, doc } = await mount(
      `<!doctype html><html><head><script>document.addEventListener("DOMContentLoaded", function () { document.getElementById("root").textContent = "ready"; });</script></head><body><div id="root"></div></body></html>`,
    );
    await vi.waitFor(() => expect(doc().getElementById("root")!.textContent).toBe("ready"));
    await mounted.unmount();
  });

  it("shows a plain message when the page's code throws and nothing is drawn", async () => {
    const { mounted, doc } = await mount(
      `<!doctype html><html><head><script>throw new Error("boom");</script></head><body><div id="root"></div></body></html>`,
    );
    await vi.waitFor(() => expect(doc().querySelector('[role="alert"]')).not.toBeNull(), {
      timeout: 3_000,
    });
    expect(doc().body.innerText).not.toContain("boom");
    await mounted.unmount();
  });

  it("keeps a page that drew something even if its code also threw", async () => {
    const { mounted, doc } = await mount(
      `<!doctype html><html><head><script>document.getElementById("root").textContent = "drawn"; throw new Error("late");</script></head><body><div id="root"></div></body></html>`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(doc().querySelector('[role="alert"]')).toBeNull();
    expect(doc().body.innerText).toContain("drawn");
    await mounted.unmount();
  });
});
