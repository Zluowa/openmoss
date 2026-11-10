// FILE: visualGuideTool.ts
// Purpose: The `visual_guide` agent tool: how to choose and build agent visuals in Moss
//   (format choice, data honesty, follow-ups, SVG diagrams, interactive tools, live maps).
// Layer: Agent gateway tool
// Origin: The rules adapt the master-playbook, advanced-visualization and svg-diagrams
//   skills in Open Intelligent UI (https://github.com/CopilotKit/OpenIntelligentUI, MIT)
//   at 8391a94 to Moss's tools (html_render, OpenUI blocks, place_photos) and theme
//   variables. See THIRD_PARTY_NOTICES.md.

import { Effect } from "effect";

import { PLACE_PHOTOS_TOOL_NAME } from "./placePhotoTools.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "./toolRuntime.ts";

export const VISUAL_GUIDE_TOOL_NAME = "visual_guide";

export const VISUAL_GUIDE_SECTIONS = ["diagrams", "interactive", "maps"] as const;
export type VisualGuideSection = (typeof VISUAL_GUIDE_SECTIONS)[number];

export const VISUAL_GUIDE_TOOL_DESCRIPTION =
  "Return Moss's guide to agent visuals: when a table, chart, diagram, tool or map helps, data honesty, " +
  'follow-up buttons and accessibility. Pass { "section": "diagrams" | "interactive" | "maps" } for the ' +
  "detailed rules of SVG diagrams, calculators and simulations, or live maps and trip itineraries. " +
  "Call it before building one of those with html_render; the guide is static for the session.";

const CORE = `# Moss visual guide

Use a visual only when it helps the reader understand, compare or act. Plain text stays the default for code, short answers and conversation.

## Pick the format
- Exact values, records, simple comparisons: an OpenUI Table in an \`openui\` block (see openui_reference).
- Bar, line, area, scatter, pie or radial charts: OpenUI chart components.
- Dashboards (KPIs, charts and tables about one topic, with filters): an OpenUI program with root = Dashboard([header, section]) (see openui_reference). Filters bind $variables, so the page filters its own rows with @Filter and @WhereIn.
- Flowcharts, architecture and structural diagrams: an SVG page with html_render (section "diagrams"). Diagrams are never maps.
- Calculators, simulations, interactive explainers and 3D: an html_render page (section "interactive").
- A map only when the reader asks for a map, or asks about places, a route or a trip: an html_render page with a live map (section "maps"). moss_show_visual pages cannot load the network, so maps never go there.
- A page the reader will keep using (a tracker, planner, game, or a tool that saves data, asks AI or hands over files): publish it as an 应用页 with moss_app_publish, after reading moss_app_guide. It lives in 资料空间, keeps versions, and can use db, ai and downloads.

## Keeping one visual current
To keep one visual current across turns (a dashboard, test results, build progress), give html_render the same short \`surface\` name each time. Moss replaces the page where it first appeared, and later turns show a one-line note pointing to it.

## Data honesty
Use the reader's inputs or data you actually retrieved. Label sample or illustrative numbers inside the page. Never invent live data, prices, weather, routes, opening hours or sources. Show units, formulas and assumptions. When essential data is missing, ask instead of drawing.

## Follow-ups
Filters, sliders, sorting and calculation stay inside the page. A button the reader clicks can hand their choice back: call \`window.mossFollowUp(text)\` from its click handler with a short request that includes the selected values. The text lands in the reader's composer for them to send. Check \`typeof window.mossFollowUp === "function"\` first, because pages opened outside a thread do not have it, and never call it on load or on input changes.

## Accessibility and layout
Semantic headings, labels tied to inputs, keyboard-operable buttons with type="button", visible focus, readable contrast, and a role="status" element for results and errors. Layouts wrap at phone width (about 360px). Respect prefers-reduced-motion and give every animation pause and reset. Check a page with html_preview before html_render.`;

const DIAGRAMS = `# Diagrams (SVG in html_render)

- One inline \`<svg width="100%" viewBox="0 0 680 H">\` with a <title> and <desc>. Compute H as the lowest element's bottom plus 40; keep content between x 40 and 640.
- Style with classes in a <style> block on theme variables, so light and dark both work: text fill var(--foreground) or var(--muted-foreground); a node fills color-mix(in srgb, var(--chart-N) 14%, var(--background)) with stroke var(--chart-N); structure uses var(--border). Use 2-3 colors that mean something (categories, states), not a rainbow.
- Two text sizes (14px labels, 12px descriptions), weights 400 and 500, sentence case. Centre text in boxes with text-anchor="middle" and dominant-baseline="central".
- Size boxes from their text: width about max(characters x 8 at 14px, characters x 7 at 12px) + 48. A one-line box is 44px tall, a two-line box 56px. Leave at least 60px between boxes and at most 4-5 nodes per row; split a bigger system into several diagrams.
- Connectors are <path> elements with fill="none", stroke-width 1.5 and an arrow marker (\`<marker orient="auto-start-reverse">\` drawn with stroke="context-stroke"). Borders 0.5-1px; rx 8 for nodes and 20 for containers.
- Kinds: a flowchart runs top to bottom through steps, branches and decisions; a structural diagram shows containers holding components, their boundaries and data paths; an illustrative diagram shows a mechanism with labeled parts and leader lines.
- Before publishing, check with html_preview at 728 and 390 widths: no text overflowing its box, no overlapping arrows, labels readable on a phone.`;

const INTERACTIVE = `# Calculators, tools and simulations (html_render)

- The page reads well before scripts run: an explanation and a role="status" element are in the markup.
- Validate every number: read input.valueAsNumber, require Number.isFinite and the domain's limits, reject blanks and zero divisors, set aria-invalid, and never show NaN, Infinity or a stale result. HTML min and max do not validate typed values. Never eval a formula the reader typed.
- Keep full precision internally and format with Intl.NumberFormat and units. State the formula and its limits. Reset puts inputs and results back together.
- Every enabled control does real work. Sorting keeps the current filter. Render reader or retrieved strings with textContent, never as HTML.
- Grids collapse without overflow: grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)). Give charts and canvases fixed pixel heights (no vh units). Update one chart instance on input instead of recreating it.
- Charts: Chart.js or D3 from a CDN script. Read colors from getComputedStyle(document.documentElement) for --chart-1 to --chart-6. Give canvas and SVG charts a text summary or a data table.
- 3D: three.js with antialiasing, lights, orbit controls and a canvas sized to its box. Show a visible error when WebGL or the library fails. Keep one animation loop, pause it when the page is hidden, and update state on reset instead of starting a second loop. Prefer SVG when it explains the idea with less.
- Load libraries inside an async setup function and catch failures into the status element.`;

const MAPS = `# Maps and itineraries (html_render)

Draw a map only when the reader asks for a map, or asks about places, a route or a trip. Diagrams of systems and processes stay SVG (section "diagrams"). When a map is asked for, draw a real one; never swap it for an SVG sketch.

## window.mossMaps
- Inside an async setup function: \`const map = await window.mossMaps.create(container, { points, line, zoom, coordinates, onError })\`. Moss adds window.mossMaps to any page that calls it. Never load a map SDK, a map library or map tiles yourself: they break in mainland China and break the maps' terms.
- Moss picks the map when the page opens, for the reader's account: Amap (高德地图) for a mainland China account and Google Maps for everyone else. When that map cannot load, it falls back to Moss's own OpenFreeMap world map, or, for a mainland China account, the numbered stops and line on a plain background with a short note. So create always draws a map, and there is no provider to choose.
- \`points\` are [{ lat, lng, title }], 1-30 of them, in WGS-84 degrees. Pass \`coordinates: "gcj02"\` when the points came from Amap or another Chinese map service.
- It resolves to { provider, pins, setLineCount(n), setActive(i), focus(i), fit(), destroy(), native }: \`provider\` is "amap", "google", "openfreemap" or "plain", \`pins\` are the numbered dots, \`native\` the underlying map object. onError(message) reports a map that could not load (create then shows the fallback) or a key the provider rejects later; show it in the role="status" element.
- Give the container a fixed pixel height (about 300-340px). The map never zooms when the thread scrolls. Keep each map's logo and attribution visible.
- Never invent traffic, driving routes, mileage, travel times, closures, opening hours or geocoding results. Label approximate coordinates as approximate.

## Trip itineraries
- Layout: a short title and subtitle, day and stop count chips, a 300px map, then a horizontally scrolling row of stop cards (a 110px photo crop, stop number, place, day, one line of description).
- Photos: when ${PLACE_PHOTOS_TOOL_NAME} is offered, call it with the stops' Wikipedia titles (for places in China, Chinese titles with language "zh"). Use only the image_url values it returns, with the creator and license linked to credit_url on each card. An unavailable stop, or a session without the tool, gets a text card.
- Map: \`mossMaps.create(container, { points, line: true })\`, then \`map.setLineCount(0)\` so the line grows with the pins. Unless you retrieved real directions, label the line "Illustrative connections, not driving directions".
- Motion: window.createTripAnimator, which Moss adds to any page that calls it. Options are {stopCount, durationMs: 6000, pinElements, onFrame, onState}; pass map.pins as pinElements. onFrame runs at once and then on every frame with {progress, pinIndex, pinProgress, activeStop}, all zero-based; onState gets "playing", "paused" or "complete". It returns {play, pause, replay, seek(index), dispose}, shows every pin at once under reduced motion, pauses when the page is hidden and cleans up on pagehide.
  Example: \`const tour = window.createTripAnimator({ stopCount: map.pins.length, durationMs: 6000, pinElements: map.pins, onFrame(f) { map.setLineCount(f.pinIndex + (f.pinProgress >= 0.7 ? 1 : 0)); map.setActive(f.activeStop); activateCard(f.activeStop); }, onState: report });\`
- The camera stays still while playing: create fits every stop once. Start the tour after the map resolves and every control is wired. Give Pause/Resume and Replay buttons; a pin or card click calls tour.seek(index) and map.focus(index). Scroll the card row by setting its scrollLeft only when the active stop changes. Never use scrollIntoView, never scroll the thread, and never loop.`;

const SECTIONS: Readonly<Record<VisualGuideSection, string>> = {
  diagrams: DIAGRAMS,
  interactive: INTERACTIVE,
  maps: MAPS,
};

export function visualGuideText(section?: VisualGuideSection): string {
  return section === undefined ? CORE : SECTIONS[section];
}

function readSection(input: unknown): VisualGuideSection | undefined {
  const section =
    input !== null && typeof input === "object"
      ? (input as { section?: unknown }).section
      : undefined;
  return VISUAL_GUIDE_SECTIONS.find((name) => name === section);
}

/** Static text, so any thread reader may call it, even before a turn starts streaming. */
export function makeAgentGatewayVisualGuideTool(): ToolEntry {
  return {
    requiredCapability: "thread:read",
    definition: {
      name: VISUAL_GUIDE_TOOL_NAME,
      description: VISUAL_GUIDE_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            enum: [...VISUAL_GUIDE_SECTIONS],
            description: "Omit for the core guide; pass one section for its detailed rules.",
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "Visual guide", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (input) =>
      Effect.succeed({
        content: [{ type: "text" as const, text: visualGuideText(readSection(input)) }],
      }),
  };
}
