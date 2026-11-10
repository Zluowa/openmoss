// FILE: oiuDashboard.test.ts
// Purpose: Contract for the dashboard kit: every component its prompt groups name is
//          registered in the Moss library, the stock re-scopes keep the kit's forms
//          parseable, the row and option rules hold, and @WhereIn filters rows locally.

import { describe, expect, it } from "vitest";

import { mossOpenUILibrary } from "../mossOpenUILibrary";
import { WhereIn } from "./functions/data";
import { dashboardComponentGroups } from "./oiuDashboard";
import { normalizeOptions, normalizeRow, rowVariant } from "./oiuDashboardViews";

const element = (typeName: string, props: Record<string, unknown> = {}) => ({
  type: "element",
  typeName,
  props,
});
type ElementNode = ReturnType<typeof element>;

describe("dashboard kit catalog", () => {
  it("registers every component its prompt groups name", () => {
    const names = dashboardComponentGroups.flatMap((group) => group.components);
    expect(names).toEqual([
      "Dashboard",
      "DashboardHeader",
      "Section",
      "CardRow",
      "FilterBar",
      "FilterSelect",
      "FilterMultiSelect",
      "SmallCard",
      "MediumCard",
      "LargeCard",
      "DashboardCardHeader",
      "MetricIndicator",
      "List",
    ]);
    for (const name of names) expect(mossOpenUILibrary.components[name], name).toBeDefined();
  });

  it("keeps its notes whole in the core catalog, which cuts lines at a spaced em dash", () => {
    for (const note of dashboardComponentGroups.flatMap((group) => group.notes)) {
      expect(note).not.toMatch(/\s—/);
    }
  });

  it("re-scopes IconText so the kit's bare icon badge parses", () => {
    const iconText = mossOpenUILibrary.components.IconText;
    expect(iconText?.props.shape.title.safeParse(undefined).success).toBe(true);
  });
});

describe("dashboard rows", () => {
  it("classifies a row by the card sizes it holds", () => {
    expect(rowVariant([])).toBe("empty");
    expect(rowVariant([element("SmallCard"), element("SmallCard")])).toBe("small");
    expect(rowVariant([element("MediumCard"), element("LargeCard")])).toBe("medium-large");
    expect(rowVariant([element("LargeCard")])).toBe("large");
    expect(rowVariant([element("SmallCard"), element("MediumCard")])).toBe("mixed");
    expect(rowVariant([element("SmallCard"), "text"])).toBe("mixed");
  });

  it("never collapses LargeCards alone in a row", () => {
    const row = [element("LargeCard", { collapsed: true })];
    const [card] = normalizeRow(row, "large") as ElementNode[];
    expect(card?.props.collapsed).toBe(false);
  });

  it("draws pies as half circles in a row of three MediumCards", () => {
    const pie = element("PieChart", { labels: ["a"], values: [1] });
    const row = [
      element("MediumCard", { children: [pie] }),
      element("MediumCard"),
      element("MediumCard"),
    ];
    const [first] = normalizeRow(row, "medium") as ElementNode[];
    const [chart] = first?.props.children as ElementNode[];
    expect(chart?.props.appearance).toBe("semiCircular");
    expect(normalizeRow(row.slice(0, 2), "medium")).toEqual(row.slice(0, 2));
  });
});

describe("filter options", () => {
  it("accepts plain strings and {value, label}, dropping blank and repeated values", () => {
    const options = [
      "NA",
      { value: "emea", label: "EMEA" },
      { value: "apac" },
      { value: "" },
      "NA",
    ];
    expect(normalizeOptions(options)).toEqual([
      { value: "NA", label: "NA" },
      { value: "emea", label: "EMEA" },
      { value: "apac", label: "apac" },
    ]);
  });
});

describe("@WhereIn", () => {
  const rows = [
    { channel: "web", revenue: 1 },
    { channel: "partner", revenue: 2 },
    { channel: 3, revenue: 3 },
  ];

  it("keeps every row while nothing is picked", () => {
    expect(WhereIn.fn({ rows, field: "channel" })).toEqual(rows);
    expect(WhereIn.fn({ rows, field: "channel", values: [] })).toEqual(rows);
  });

  it("keeps the rows matching one value or any value of a list", () => {
    expect(WhereIn.fn({ rows, field: "channel", values: "web" })).toEqual([rows[0]]);
    expect(WhereIn.fn({ rows, field: "channel", values: ["web", "partner"] })).toEqual(
      rows.slice(0, 2),
    );
  });

  it("matches a number to its string form, as filter values arrive from pickers", () => {
    expect(WhereIn.fn({ rows, field: "channel", values: ["3"] })).toEqual([rows[2]]);
  });
});
