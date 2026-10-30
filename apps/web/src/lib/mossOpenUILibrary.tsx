// FILE: mossOpenUILibrary.tsx
// Purpose: Moss's OpenUI component library — full absorption of everything
//          @openuidev/react-ui ships. Starts from openuiChatLibrary, adds Modal
//          and Stack from the generic openuiLibrary, and registers DSL bindings
//          for the chart components the package ships but no stock library
//          exposes (CalendarHeatmap, FunnelChart, HeatmapChart, SegmentedBar,
//          and the Mini sparkline trio). Container unions (Card, SectionBlock,
//          Tabs, Accordion, Carousel) are re-scoped so the new components are
//          legal at every nesting level; stock renderers are reused verbatim.
//          When upstream registers official bindings for these charts, drop ours
//          and re-take the stock ones.
// Layer: Chat UI support (imported by the lazy OpenUI chunk, validation, and the
//        build-time reference generator)

import { createLibrary, defineComponent, type ComponentGroup } from "@openuidev/react-lang";
import {
  openuiChatComponentGroups,
  openuiChatLibrary,
  openuiLibrary,
} from "@openuidev/react-ui/genui-lib";
import { lazy, type ComponentType } from "react";
import { z } from "zod/v4";
import { Chart } from "./openui/oiuChart";
import { MathBlock } from "./openui/oiuExtra";
import { svgComponents } from "./openui/oiuSvg";
import { Table as OpenUITable } from "./openui/oiuTable";
import { functions as openUIFunctions } from "./openui/functions/index";

// OpenUI 1.0 ships a larger built-in function set. Keep the useful OIU
// extensions while avoiding duplicate names rejected by createLibrary.
const mossOpenUIFunctions = openUIFunctions.filter(
  (fn) =>
    !new Set([
      "Slice",
      "Range",
      "Join",
      "Format",
      "Now",
      "Today",
      "Default",
      "Includes",
      "Random",
      "Pick",
      "Shuffle",
    ]).has(fn.name),
);

// The package's unbundled dist/components graph ships a broken import chain
// (Sources → icons → a lucide chunk that isn't published), so CardSourceSchema
// is re-declared here instead of imported — shape must stay identical to the
// stock one for the Card renderer's CardSourceProvider to read it.
const CardSourceSchema = z.object({
  url: z.string().optional(),
  title: z.string(),
  sourceName: z.string(),
});

// The extra chart implementations live in the unbundled dist/components graph,
// whose directory-style re-exports only Vite (browser) resolves — Node (the
// validation/reference unit tests) cannot. Lazy dynamic imports keep the module
// graph importable everywhere; the chart chunk loads on first use inside the
// already-lazy OpenUI frame, behind its Suspense boundary.
type ChartsModule = typeof import("@openuidev/react-ui/Charts");
type ChartComponentKey =
  | "CalendarHeatmap"
  | "FunnelChart"
  | "HeatmapChart"
  | "MiniAreaChart"
  | "MiniBarChart"
  | "MiniLineChart"
  | "SegmentedBar";
const chartsModule = () => import("@openuidev/react-ui/Charts");

function lazyChart<K extends ChartComponentKey>(key: K): ChartsModule[K] {
  const LazyComponent = lazy(async () => {
    const mod = await chartsModule();
    return { default: mod[key] as unknown as ComponentType<any> };
  });
  return LazyComponent as unknown as ChartsModule[K];
}

const OpenUICalendarHeatmap = lazyChart("CalendarHeatmap");
const OpenUIFunnelChart = lazyChart("FunnelChart");
const OpenUIHeatmapChart = lazyChart("HeatmapChart");
const OpenUIMiniAreaChart = lazyChart("MiniAreaChart");
const OpenUIMiniBarChart = lazyChart("MiniBarChart");
const OpenUIMiniLineChart = lazyChart("MiniLineChart");
const OpenUISegmentedBar = lazyChart("SegmentedBar");

const chat = openuiChatLibrary.components;
const full = openuiLibrary.components;

// TODO(viz-merge): Map/MapMarker (MapLibre/OSRM) and SearchImage (remote image
// search/proxy) stay out of the Moss catalog until an external-service policy
// and offline fallback are approved.

function stockRenderer(name: string, source: "chat" | "full" = "chat") {
  const component = (source === "chat" ? chat : full)[name];
  if (!component) {
    throw new Error(`mossOpenUILibrary: ${source} library no longer registers ${name}`);
  }
  return component;
}

// ── Chart bindings the package ships but no stock library registers ──

const CalendarHeatmap = defineComponent({
  name: "CalendarHeatmap",
  props: z.object({
    dates: z.array(z.string()),
    values: z.array(z.number()),
  }),
  description:
    'GitHub-style calendar heatmap of daily activity over a year. Pass parallel arrays: dates ("2026-01-05") and values; missing days render as zero.',
  component: ({ props }) => (
    <OpenUICalendarHeatmap
      data={props.dates.map((date, index) => ({ date, value: props.values[index] ?? 0 }))}
    />
  ),
});

const FunnelChart = defineComponent({
  name: "FunnelChart",
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    orientation: z.enum(["horizontal", "vertical"]).optional(),
    edges: z.enum(["curved", "straight"]).optional(),
  }),
  description:
    "Conversion funnel; stages in order from widest (first) to narrowest. Shows each stage's retention relative to the first stage. Use plucked arrays: FunnelChart(data.stages, data.counts)",
  component: ({ props }) => (
    <OpenUIFunnelChart
      data={props.labels.map((category, index) => ({
        category,
        value: props.values[index] ?? 0,
      }))}
      categoryKey="category"
      dataKey="value"
      {...(props.orientation ? { orientation: props.orientation } : {})}
      {...(props.edges ? { edges: props.edges } : {})}
    />
  ),
});

const HeatmapChart = defineComponent({
  name: "HeatmapChart",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.string()),
    values: z.array(z.array(z.number())),
    diverging: z.boolean().optional(),
  }),
  description:
    "Matrix heatmap: columns are x-axis labels, rows are y-axis labels, values[rowIndex][columnIndex] is the cell. Use diverging: true for signed values around zero (profit/loss, deltas, correlation).",
  component: ({ props }) => (
    <OpenUIHeatmapChart
      data={props.columns.map((column, columnIndex) =>
        Object.fromEntries([
          ["category", column],
          ...props.rows.map((row, rowIndex) => [
            row,
            props.values[rowIndex]?.[columnIndex] ?? null,
          ]),
        ]),
      )}
      categoryKey="category"
      {...(props.diverging ? { rampMode: "diverging" as const } : {})}
    />
  ),
});

const SegmentedBar = defineComponent({
  name: "SegmentedBar",
  props: z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    legendVariant: z.enum(["default", "stacked"]).optional(),
  }),
  description:
    "Single horizontal bar split into segments sized by share of the total; use for part-to-whole composition. Use plucked arrays: SegmentedBar(data.categories, data.values)",
  component: ({ props }) => (
    <OpenUISegmentedBar
      data={props.labels.map((category, index) => ({
        category,
        value: props.values[index] ?? 0,
      }))}
      categoryKey="category"
      dataKey="value"
      {...(props.legendVariant ? { legendVariant: props.legendVariant } : {})}
    />
  ),
});

const miniVariant = z.enum(["linear", "natural", "step"]).optional();

const MiniLineChart = defineComponent({
  name: "MiniLineChart",
  props: z.object({ values: z.array(z.number()), variant: miniVariant }),
  description:
    "Sparkline line chart for a compact trend inside KPI cards or dense layouts; takes a bare values array.",
  component: ({ props }) => (
    <OpenUIMiniLineChart
      data={props.values}
      {...(props.variant ? { variant: props.variant } : {})}
    />
  ),
});

const MiniAreaChart = defineComponent({
  name: "MiniAreaChart",
  props: z.object({ values: z.array(z.number()), variant: miniVariant }),
  description:
    "Sparkline area chart (filled) for a compact trend inside KPI cards or dense layouts; takes a bare values array.",
  component: ({ props }) => (
    <OpenUIMiniAreaChart
      data={props.values}
      {...(props.variant ? { variant: props.variant } : {})}
    />
  ),
});

const MiniBarChart = defineComponent({
  name: "MiniBarChart",
  props: z.object({ values: z.array(z.number()) }),
  description:
    "Sparkline bar chart for compact per-period magnitudes inside KPI cards or dense layouts; takes a bare values array.",
  component: ({ props }) => <OpenUIMiniBarChart data={props.values} />,
});

// ── Stock components the chat library omits ──
// Modal's children union and Stack's z.any() children match elements by
// component NAME (refs are name-tagged), so the stock definitions accept our
// leaf components unchanged. Only the chat container chain needs re-scoping.

const Modal = stockRenderer("Modal", "full");
const Stack = stockRenderer("Stack", "full");

// ── Re-scoped chat containers ──
// The stock chat Card/SectionBlock/Tabs/Accordion/Carousel content unions are
// closed over the stock component refs, which would reject the additions above.
// Rebuild each container with the union widened, reusing the stock renderer.

const CONTAINER_NAMES = new Set([
  "Card",
  "SectionBlock",
  "SectionItem",
  "Tabs",
  "TabItem",
  "Accordion",
  "AccordionItem",
  "Carousel",
]);

const newContentComponents = [
  CalendarHeatmap,
  FunnelChart,
  HeatmapChart,
  SegmentedBar,
  MiniLineChart,
  MiniAreaChart,
  MiniBarChart,
  Chart,
  MathBlock,
  OpenUITable,
  ...svgComponents,
];

// Everything a nested container may hold — mirrors the stock chat union (all
// chat components except the containers) plus the absorbed additions.
const MossNestedContentUnion = z.union([
  ...Object.values(chat)
    .filter((component) => !CONTAINER_NAMES.has(component.name))
    .map((component) => component.ref),
  ...newContentComponents.map((component) => component.ref),
  Stack.ref,
] as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);

const MossAccordionItem = defineComponent({
  name: "AccordionItem",
  props: z.object({
    value: z.string(),
    trigger: z.string(),
    content: z.array(MossNestedContentUnion),
  }),
  description: stockRenderer("AccordionItem").description,
  component: stockRenderer("AccordionItem").component,
});

const MossAccordion = defineComponent({
  name: "Accordion",
  props: z.object({ items: z.array(MossAccordionItem.ref) }),
  description: stockRenderer("Accordion").description,
  component: stockRenderer("Accordion").component,
});

const MossTabItem = defineComponent({
  name: "TabItem",
  props: z.object({
    value: z.string(),
    trigger: z.string(),
    content: z.array(z.union([...MossNestedContentUnion.options, MossAccordion.ref])),
  }),
  description: stockRenderer("TabItem").description,
  component: stockRenderer("TabItem").component,
});

const MossTabs = defineComponent({
  name: "Tabs",
  props: z.object({ items: z.array(MossTabItem.ref) }),
  description: stockRenderer("Tabs").description,
  component: stockRenderer("Tabs").component,
});

const MossSectionItem = defineComponent({
  name: "SectionItem",
  props: z.object({
    value: z.string(),
    trigger: z.string(),
    content: z.array(z.union([...MossNestedContentUnion.options, MossTabs.ref, MossAccordion.ref])),
  }),
  description: stockRenderer("SectionItem").description,
  component: stockRenderer("SectionItem").component,
});

const MossSectionBlock = defineComponent({
  name: "SectionBlock",
  props: z.object({
    sections: z.array(MossSectionItem.ref),
    isFoldable: z.boolean().optional(),
  }),
  description: stockRenderer("SectionBlock").description,
  component: stockRenderer("SectionBlock").component,
});

const MossCarousel = defineComponent({
  name: "Carousel",
  props: z.object({
    children: z.array(z.array(MossNestedContentUnion)),
    variant: z.enum(["card", "sunk"]).optional(),
  }),
  description: stockRenderer("Carousel").description,
  component: stockRenderer("Carousel").component,
});

const MossCardChildUnion = z.union([
  ...MossNestedContentUnion.options,
  MossSectionBlock.ref,
  MossTabs.ref,
  MossCarousel.ref,
  Modal.ref,
]);

const MossCard = defineComponent({
  name: "Card",
  props: z.object({
    children: z.array(MossCardChildUnion),
    sources: z.array(CardSourceSchema).optional(),
  }),
  description: stockRenderer("Card").description,
  component: stockRenderer("Card").component,
});

// ── Library ──

const mossExtraComponentGroups: ComponentGroup[] = [
  {
    name: "Charts (Matrix & Flow)",
    components: ["CalendarHeatmap", "FunnelChart", "HeatmapChart", "SegmentedBar"],
    notes: [
      "- CalendarHeatmap is for daily activity over months (commits, workouts, sales days) — not for category comparisons.",
      "- HeatmapChart values is row-major: values[rowIndex][columnIndex]; every inner array must match the columns length.",
      "- Prefer FunnelChart over a bar chart whenever stages are sequential with drop-off (signup, checkout, pipeline).",
    ],
  },
  {
    name: "Charts (Mini)",
    components: ["MiniLineChart", "MiniAreaChart", "MiniBarChart"],
    notes: [
      "- Mini charts are sparklines: no axes or labels. Use them inside CompositeCardItem bodies next to a MetricIndicatorInline, never as the primary chart of a data answer.",
    ],
  },
  {
    name: "Overlays & Layout",
    components: ["Modal", "Stack"],
    notes: [
      '- Modal: Modal("Title", $showModal, [content]) — $showModal is a boolean binding, X/Escape auto-closes. Put a Form with its own buttons inside children. Use sparingly: chat content belongs inline.',
      "- Stack is a flex container for fine layout control inside sections; Card remains the only root container.",
    ],
  },
];

export const mossOpenUILibrary = createLibrary({
  root: "Card",
  components: [
    ...Object.values(chat).filter(
      (component) => !CONTAINER_NAMES.has(component.name) && component.name !== "Table",
    ),
    MossCard,
    MossSectionBlock,
    MossSectionItem,
    MossTabs,
    MossTabItem,
    MossAccordion,
    MossAccordionItem,
    MossCarousel,
    Modal,
    Stack,
    ...newContentComponents,
  ],
  functions: mossOpenUIFunctions,
  componentGroups: [...openuiChatComponentGroups, ...mossExtraComponentGroups],
});

/** Component names the Moss library exposes — the closed set a program may call. */
export function mossOpenUIComponentNames(): ReadonlySet<string> {
  return new Set(Object.keys(mossOpenUILibrary.components));
}
