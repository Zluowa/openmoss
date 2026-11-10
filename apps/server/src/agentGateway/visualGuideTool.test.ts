// FILE: visualGuideTool.test.ts
// Purpose: Contract for the `visual_guide` gateway tool.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { OPENUI_CHAT_REFERENCE } from "./openUIChatReference.generated.ts";
import { PLACE_PHOTOS_TOOL_NAME } from "./placePhotoTools.ts";
import type { ToolContext } from "./toolRuntime.ts";
import {
  makeAgentGatewayVisualGuideTool,
  VISUAL_GUIDE_SECTIONS,
  VISUAL_GUIDE_TOOL_NAME,
  visualGuideText,
} from "./visualGuideTool.ts";

const context = {} as ToolContext;

async function guide(input: Record<string, unknown>) {
  const result = await Effect.runPromise(makeAgentGatewayVisualGuideTool().handler(input, context));
  const block = result.content[0];
  return block && block.type === "text" ? block.text : "";
}

describe("visual_guide agent tool", () => {
  it("is a read-only lookup", () => {
    const tool = makeAgentGatewayVisualGuideTool();
    expect(tool.definition.name).toBe(VISUAL_GUIDE_TOOL_NAME);
    expect(tool.requiredCapability).toBe("thread:read");
    expect(tool.definition.annotations?.readOnlyHint).toBe(true);
  });

  it("serves the core guide by default and each section on request", async () => {
    expect(await guide({})).toBe(visualGuideText());
    for (const section of VISUAL_GUIDE_SECTIONS) {
      expect(await guide({ section })).toBe(visualGuideText(section));
    }
    expect(await guide({ section: "unknown" })).toBe(visualGuideText());
  });

  it("teaches one map API, which always draws a map", () => {
    const maps = visualGuideText("maps");
    expect(maps).toContain("window.mossMaps.create");
    expect(maps).toContain('coordinates: "gcj02"');
    // The account picks the map; there is no setup error to plan around.
    expect(maps).toContain("Amap (高德地图) for a mainland China account");
    expect(maps).toContain("OpenFreeMap");
    expect(maps).not.toMatch(/No map provider|mossAddBasemap|L\.map\(|MOSS_[A-Z_]+_KEY/u);
  });

  it("teaches Moss's own follow-up, photo and animator contracts", () => {
    expect(visualGuideText()).toContain("window.mossFollowUp(text)");
    const maps = visualGuideText("maps");
    expect(maps).toContain(PLACE_PHOTOS_TOOL_NAME);
    expect(maps).toContain("window.createTripAnimator");
    expect(maps).toContain("pinElements: map.pins");
    expect(visualGuideText("diagrams")).toContain("var(--chart-N)");
  });

  it("never sends a map to a script CDN or a US-only tile server", () => {
    const maps = visualGuideText("maps");
    expect(maps).not.toMatch(/jsdelivr|unpkg|cdnjs|nationalmap\.gov|tile\.openstreetmap/iu);
    expect(maps).toContain("mainland China");
  });

  it("matches the OpenUI reference: maps only when asked, SVG for diagrams", () => {
    expect(visualGuideText()).toMatch(/A map only when the reader asks for a map/u);
    expect(visualGuideText()).toContain("Diagrams are never maps.");
    expect(OPENUI_CHAT_REFERENCE).toContain("only when the reader asks for a map");
    expect(OPENUI_CHAT_REFERENCE).toContain('visual_guide, section "maps"');
    expect(OPENUI_CHAT_REFERENCE).not.toContain("use charts, SVG, tables, or local data instead");
  });
});
