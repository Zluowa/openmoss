// FILE: openUIValidation.test.ts
// Purpose: Quality gate for model-authored `openui` blocks — a guided model must
//          produce programs whose component names all exist in openuiChatLibrary,
//          and hallucinated components must be caught by name.

import { openuiChatExamples } from "@openuidev/react-ui/genui-lib";
import { describe, expect, it } from "vitest";

import { openUIChatComponentNames } from "./openUIChatReference";
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
