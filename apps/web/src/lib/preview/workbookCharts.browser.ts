import { expect, it } from "vitest";
import JSZip from "jszip";

import { workbookFixture } from "./workbookFixtures";
import { parseWorkbookChart } from "./workbookCharts";
import { readXlsxWorkbook } from "./workbookXlsx";

const chartXml = (kind: string, grouping = "standard") =>
  `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:${kind}><c:barDir val="col"/><c:grouping val="${grouping}"/><c:ser><c:tx><c:v>Actual</c:v></c:tx><c:cat><c:strLit><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>18</c:v></c:pt></c:numLit></c:val></c:ser></c:${kind}></c:plotArea><c:legend/></c:chart></c:chartSpace>`;

it.each(["barChart", "lineChart", "pieChart", "doughnutChart", "areaChart"])(
  "reads OOXML %s cached series and category semantics",
  (kind) => {
    const chart = parseWorkbookChart(
      new DOMParser().parseFromString(chartXml(kind, "stacked"), "application/xml"),
      [],
    );
    expect(chart).toMatchObject({
      title: "Revenue",
      kind: kind.replace("Chart", ""),
      categories: ["Q1", "Q2"],
      grouping: "stacked",
      series: [{ name: "Actual", values: [12, 18] }],
    });
  },
);

it("follows workbook to sheet to drawing to chart relationships and preserves chart anchors", async () => {
  const zip = await JSZip.loadAsync(await workbookFixture());
  // The fixture contains one image drawing. Attach a real chart to that same worksheet drawing.
  const drawing = zip.file("xl/drawings/drawing1.xml")!;
  const text = await drawing.async("text");
  zip.file(
    drawing.name,
    text.replace(
      "</xdr:wsDr>",
      `<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>19</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="chartRel"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
    ),
  );
  const relations = zip.file("xl/drawings/_rels/drawing1.xml.rels")!;
  zip.file(
    relations.name,
    (await relations.async("text")).replace(
      "</Relationships>",
      '<Relationship Id="chartRel" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
    ),
  );
  zip.file("xl/charts/chart1.xml", chartXml("barChart"));
  const workbook = await readXlsxWorkbook(await zip.generateAsync({ type: "arraybuffer" }));
  expect(workbook.sheets[0]?.charts).toHaveLength(1);
  expect(workbook.sheets[0]?.charts[0]).toMatchObject({
    from: { row: 7, col: 1 },
    to: { row: 19, col: 7 },
    title: "Revenue",
    series: [{ values: [12, 18] }],
  });
  expect(workbook.warnings).toEqual([]);
});
