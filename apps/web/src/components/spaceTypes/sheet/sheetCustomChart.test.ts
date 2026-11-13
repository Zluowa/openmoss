import type { SheetChart } from "@moss/shared/spaceItems/sheetWorkbook";
import { describe, expect, it } from "vitest";

import { customChartDocument } from "./sheetCustomChart.logic";

const chart: SheetChart = {
  id: "cht_1",
  name: "每月花费",
  caption: "",
  kind: "custom",
  code: 'document.getElementById("chart").textContent = MOSS_CHART.rows.length; // </script><b>',
  source: { sheetId: "s1", range: { r0: 0, c0: 0, r1: 2, c1: 1 } },
  anchor: { r: 0, c: 3, dx: 0, dy: 0 },
  width: 480,
  height: 280,
};

describe("a custom chart's page", () => {
  const doc = customChartDocument({
    chart,
    rows: [
      [
        { value: "项目", text: "项目" },
        { value: "金额", text: "金额" },
      ],
      [
        { value: "</script><img src=x>", text: "</script><img src=x>" },
        { value: 1200, text: "1,200" },
      ],
    ],
    width: 480,
    height: 280,
    dark: false,
  });

  it("reaches nothing outside itself", () => {
    expect(doc).toContain(
      `content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"`,
    );
  });

  it("keeps the cells and the code from closing their script elements", () => {
    expect(doc.match(/<\/script>/gu)).toHaveLength(2);
    expect(doc).toContain("\\u003c/script>\\u003cimg src=x>");
    expect(doc).toContain("<\\/script><b>");
  });

  it("hands the code its cells, size and colours", () => {
    expect(doc).toContain('"width":480');
    expect(doc).toContain('"text":"1,200"');
    expect(doc).toContain('"colors":["#');
  });
});
