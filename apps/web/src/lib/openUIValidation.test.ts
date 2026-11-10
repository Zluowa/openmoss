// FILE: openUIValidation.test.ts
// Purpose: Quality gate for model-authored `openui` blocks — a guided model must
//          produce programs whose component names all exist in openuiChatLibrary,
//          and hallucinated components must be caught by name.

import { openuiChatExamples } from "@openuidev/react-ui/genui-lib";
import { describe, expect, it } from "vitest";

import { MOSS_DASHBOARD_EXAMPLE, openUIChatComponentNames } from "./openUIChatReference";
import { validateOpenUIProgram } from "./openUIValidation";

// Representative of what a model emits after reading the openui_reference catalog:
// legal components, positional arguments, Card root, an interactive follow-up.
const GUIDED_MODEL_OUTPUT = `root = Card([title, tbl, chart, followUps])
title = CardHeader("Top Languages", "Popularity snapshot")
tbl = Table([Col("Language", langs), Col("Users (M)", users)])
langs = ["Python", "JavaScript", "TypeScript"]
users = [15.7, 14.2, 8.5]
chart = BarChart(langs, [series], "grouped")
series = Series("Users (M)", users)
followUps = FollowUpBlock([fu1])
fu1 = FollowUpItem("Compare Python and TypeScript")
`;

// The failure mode this gate exists for: plausible-sounding but invented components.
const HALLUCINATED_MODEL_OUTPUT = `root = Card([title, grid, chart])
title = CardHeader("Sales", "Q4")
grid = DataGrid(["a", "b"], [s1])
chart = FancyChart3D(["a"], [s1])
s1 = Series("S", [1, 2])
`;

// The prompt examples of the OpenUI dashboard kit (@openuidev/dashboard-kit 0.0.1,
// packages/kits/dashboard/src/lib/prompt-options at 9f01894), verbatim. Moss keeps the
// kit's names and positional arguments, so programs written for the kit must validate.
const DASHBOARD_KIT_EXAMPLES = [
  `root = Dashboard([header, section])
header = DashboardHeader("Sales Dashboard", "Q1 2025 Overview")
section = Section([row1, row2])
row1 = CardRow([card1, card2, card3])
card1 = SmallCard("Total Revenue", "$1.2M", {direction: "up", value: 12.5})
card2 = SmallCard("Active Users", "2,847", {direction: "up", value: 8.1})
card3 = SmallCard("Churn Rate", "2.4%", {direction: "down", value: 0.3})
row2 = CardRow([chartCard])
chartCard = MediumCard([chartHeader, chart])
chartHeader = DashboardCardHeader("Revenue Trend", "Last 30 days")
chart = LineChart(["Jan", "Feb", "Mar"], [Series("Revenue", [120, 150, 180])])`,
  `root = Dashboard([header, section])
header = DashboardHeader("Platform Overview")
section = Section([row1, row2])
row1 = CardRow([overview])
overview = SmallCard(IconText(Icon("dollar-sign"), "neutral"), [MetricIndicator("$48.2K", "Monthly recurring", {direction: "up", value: 12.5})])
row2 = CardRow([tableCard])
tableCard = LargeCard([tableHeader, table])
tableHeader = DashboardCardHeader("Top Products")
table = Table([productCol, unitsCol, revenueCol])
productCol = Col("Product", ["Widget Pro", "Widget Lite"])
unitsCol = Col("Units", [842, 1205], "number")
revenueCol = Col("Revenue", ["$12,400", "$9,800"], "number")`,
  `root = Dashboard([header, section])
$region = "all"
header = DashboardHeader("Usage Analytics")
filter = FilterBar([regionFilter])
regionFilter = FilterSelect("region", "Region", [{value: "all", label: "All Regions"}, {value: "na", label: "North America"}, {value: "emea", label: "EMEA"}], $region)
data = {all: {events: "4,500", mix: [45, 35, 20], months: [1200, 1500, 1800]}, na: {events: "2,700", mix: [50, 30, 20], months: [700, 900, 1100]}, emea: {events: "1,800", mix: [38, 42, 20], months: [500, 600, 700]}}
section = Section([row1, row2], filter)
row1 = CardRow([eventsCard])
eventsCard = SmallCard("Total Events", data[$region].events)
row2 = CardRow([pieCard, barCard])
pieCard = MediumCard([pieHeader, pie])
pieHeader = DashboardCardHeader("Distribution")
pie = PieChart(["API", "Web", "Mobile"], data[$region].mix)
barCard = MediumCard([barHeader, bar])
barHeader = DashboardCardHeader("Monthly Usage")
bar = BarChart(["Jan", "Feb", "Mar"], [Series("Events", data[$region].months)])`,
];

describe("validateOpenUIProgram", () => {
  it("accepts a guided model output that only uses catalog components", () => {
    const validation = validateOpenUIProgram(GUIDED_MODEL_OUTPUT);
    expect(validation.unknownComponents).toEqual([]);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("flags hallucinated component names instead of letting them render empty", () => {
    const validation = validateOpenUIProgram(HALLUCINATED_MODEL_OUTPUT);
    expect(validation.ok).toBe(false);
    expect(validation.unknownComponents).toEqual(["DataGrid", "FancyChart3D"]);
    for (const name of validation.unknownComponents) {
      expect(openUIChatComponentNames().has(name)).toBe(false);
    }
  });

  it("accepts Moss's dashboard example and the dashboard kit's own examples unchanged", () => {
    const mossExample = MOSS_DASHBOARD_EXAMPLE.slice(MOSS_DASHBOARD_EXAMPLE.indexOf("root = "));
    for (const program of [mossExample, ...DASHBOARD_KIT_EXAMPLES]) {
      const validation = validateOpenUIProgram(program);
      expect(validation.unknownComponents, program.split("\n", 1)[0]).toEqual([]);
      expect(validation.errors, program.split("\n", 2)[1]).toEqual([]);
    }
  });

  it("every example shipped in the component reference uses only legal components", () => {
    // The catalog the openui_reference tool serves teaches by example; if an
    // example itself called an unknown component, models would faithfully
    // reproduce the mistake.
    expect(openuiChatExamples.length).toBeGreaterThan(0);
    for (const example of openuiChatExamples) {
      const validation = validateOpenUIProgram(example);
      expect(validation.unknownComponents, example.split("\n", 1)[0]).toEqual([]);
      expect(validation.ok, example.split("\n", 1)[0]).toBe(true);
    }
  });
});
