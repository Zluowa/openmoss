// FILE: DashboardFrame.browser.tsx
// Purpose: Runs a real 数据看板 in its sandboxed frame (static host, CSP, local d3, the `dash`
//          runtime): data reaches the page, calcs and drawings run, a filter redraws, faults
//          come back, and hand editing hands back the stored words with scripts intact.
// Layer: Browser test for the 数据看板 host

import "../../../index.css";

import { createDashboard, type DashboardItem } from "@moss/shared/spaceItems/dashboard";
import { salesDashboardData } from "@moss/shared/spaceItems/dashboardTemplates";
import type { PageId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useDashboardRuntime } from "./useDashboardRuntime";

type Runtime = ReturnType<typeof useDashboardRuntime>;
let current: Runtime | null = null;
let serialized: string | null = null;

function Harness(props: { dashboard: DashboardItem; edit?: boolean; theme?: "light" | "dark" }) {
  const runtime = useDashboardRuntime({
    scopeSpaceId: null,
    pageId: "dashboard-fixture" as PageId,
    revision: 1,
    dashboard: props.dashboard,
    theme: props.theme ?? "light",
    edit: props.edit ?? false,
    pick: false,
    comment: false,
    onSerialized: (html) => {
      serialized = html;
    },
  });
  current = runtime;
  return (
    <iframe
      ref={runtime.frame}
      title="dashboard"
      sandbox="allow-scripts"
      style={{ width: 900, height: 700, border: 0 }}
      data-status={runtime.status}
    />
  );
}

const ready = () =>
  vi.waitFor(
    () => {
      expect(current?.status).toBe("ready");
    },
    { timeout: 15_000 },
  );

afterEach(() => {
  current = null;
  serialized = null;
});

describe("数据看板 frame", () => {
  it("loads the file, runs calcs and drawings, and reports the page with no faults", async () => {
    await page.viewport(1000, 800);
    render(<Harness dashboard={salesDashboardData()} />);
    await ready();
    await vi.waitFor(
      () => {
        expect(current!.sources.sales?.status).toBe("ok");
        expect(current!.sources.sales?.count).toBe(18);
        expect(current!.calcs.map((calc) => calc.id).toSorted()).toEqual(["monthly", "oct"]);
        expect(current!.pageText?.html).toContain("销售看板");
      },
      { timeout: 15_000 },
    );
    // October, all regions: 178 + 134 + 109.
    expect(current!.pageText!.html).toContain("421");
    expect(current!.pageText!.html).toContain("高于目标");
    expect(current!.calcs.find((calc) => calc.id === "oct")?.code).toContain("(monthly) =>");
    expect(current!.faults).toEqual([]);
  });

  it("redraws for a filter value without loading the file again", async () => {
    render(<Harness dashboard={salesDashboardData()} />);
    await ready();
    await vi.waitFor(() => expect(current!.pageText?.html).toContain("421"), { timeout: 15_000 });
    current!.send({ kind: "params", params: { region: "华东" } });
    // The tile's mark now names the 华东 row and shows its October revenue.
    const east = `data-where="region=${encodeURIComponent("华东")}">178<`;
    await vi.waitFor(() => expect(current!.pageText?.html).toContain(east), { timeout: 10_000 });
    expect(current!.pageText!.html).not.toContain('data-where="region=">421<');
    expect(current!.faults).toEqual([]);
  });

  it("reports scripts that throw and marks that disagree with the data", async () => {
    const broken: DashboardItem = {
      ...createDashboard("Broken"),
      datasets: {
        n: {
          title: "N",
          source: { kind: "file", name: "n.csv", text: "k,v\na,5\n" },
          updated: { at: "2026-11-13T00:00:00Z", by: "test" },
        },
      },
      files: {
        "index.html": {
          text: `<p id="x"><b data-draw="v" data-source="n" data-field="v" data-where="k=a">—</b> <b data-source="n" data-field="missing">—</b></p>
<script>dash.draw('v', (el) => { const d = dash.data('n'); el.textContent = d.status === 'ok' ? '7' : '—'; });</script>
<script>throw new Error("boom");</script>`,
        },
      },
    };
    render(<Harness dashboard={broken} />);
    await ready();
    await vi.waitFor(
      () => {
        const messages = current!.faults.map((fault) => fault.message);
        expect(messages).toContain("boom");
        expect(messages.some((message) => message.includes("页面显示 7，数据是 5"))).toBe(true);
        expect(messages.some((message) => message.includes("missing"))).toBe(true);
      },
      { timeout: 15_000 },
    );
  });

  it("hands back the stored page when editing, scripts and drawings intact", async () => {
    render(<Harness dashboard={salesDashboardData()} edit />);
    await ready();
    current!.send({ kind: "serialize" });
    await vi.waitFor(() => expect(serialized).not.toBeNull(), { timeout: 10_000 });
    expect(serialized).toContain('<meta name="dash-one-writer">');
    expect(serialized).toContain("dash.calc('monthly'");
    expect(serialized).toContain('data-draw="revenue"');
    expect(serialized).not.toContain("contenteditable");
    expect(serialized).not.toContain("data-dash-locked");
  });
});
