import { openuiChatPromptOptions } from "@openuidev/react-ui/genui-lib";

import { mossOpenUILibrary } from "./mossOpenUILibrary";

/**
 * Moss's own worked example, served after the stock chat examples: a dashboard whose
 * filters drive local data through $variables and @functions.
 */
export const MOSS_DASHBOARD_EXAMPLE = `Example 6 — Dashboard with working filters (the KPIs, chart and list all follow a FilterSelect and a FilterMultiSelect because the page filters its own rows):

root = Dashboard([header, section])
$region = "all"
$channels = []
header = DashboardHeader("Sales overview", "Q3 2026, revenue in $k")
section = Section([kpis, detail], filters)
filters = FilterBar([regionFilter, channelFilter])
regionFilter = FilterSelect("region", "Region", [{value: "all", label: "All regions"}, {value: "na", label: "North America"}, {value: "emea", label: "EMEA"}], $region)
channelFilter = FilterMultiSelect("channels", "Channel", [{value: "web", label: "Web"}, {value: "partner", label: "Partner"}], $channels)
inRegion = $region == "all" ? orders : @Filter(orders, "region", "==", $region)
shown = @WhereIn(inRegion, "channel", $channels)
kpis = CardRow([revenueCard, ordersCard, avgCard])
revenueCard = SmallCard(IconText(Icon("dollar-sign", "finance"), "success"), [MetricIndicator("$" + @Sum(shown.revenue) + "k", "Revenue")])
ordersCard = SmallCard("Orders", @Count(shown))
avgCard = SmallCard("Avg. order", @Count(shown) > 0 ? "$" + @Round(@Sum(shown.revenue) / @Count(shown), 1) + "k" : "n/a")
detail = CardRow([trendCard, dealsCard])
trendCard = LargeCard([trendHeader, trendChart])
trendHeader = DashboardCardHeader("Revenue by month", "Selected region and channels")
byMonth = @GroupBy(shown, "month", "revenue")
trendChart = BarChart(byMonth.key, [Series("Revenue ($k)", byMonth.value)])
dealsCard = MediumCard([dealsHeader, deals])
dealsHeader = DashboardCardHeader("Largest deals")
deals = List(@Each(@Top(shown, "revenue", 3), "o", ListItem(o.account, o.month + " · " + o.channel + " · $" + o.revenue + "k")))
orders = [{account: "Northwind", region: "na", channel: "web", month: "Jul", revenue: 42}, {account: "Fabrikam", region: "emea", channel: "partner", month: "Jul", revenue: 31}, {account: "Contoso", region: "na", channel: "partner", month: "Aug", revenue: 58}, {account: "Litware", region: "emea", channel: "web", month: "Aug", revenue: 24}, {account: "Tailspin", region: "na", channel: "web", month: "Sep", revenue: 37}, {account: "Adatum", region: "emea", channel: "partner", month: "Sep", revenue: 45}]`;

/** Moss embeds the library in Markdown instead of replacing the whole reply. */
export const MOSS_OPENUI_REFERENCE_INTRO = [
  "You are an AI assistant inside a Moss chat thread, replying in Markdown. Moss has one visual language: OpenUI Lang 1.0. When a chart, table, form, card, list, or working tool would beat prose, embed ONE program as a fenced ```openui code block; moss_show_visual accepts the same source when the visual should be published before the reply. Text outside the block stays normal chat Markdown.",
  "The program must define root = Card(...) and Card is the only top-level container — its children stack vertically. Write the root = Card(...) statement first so the frame streams in progressively. The one exception is a dashboard (KPI cards, charts, tables and filters about one topic): it starts with root = Dashboard([header, section]) instead, as the Dashboard groups below describe.",
  "Working tools stay in the page: keep inputs and lists in $variables, derive displayed values with @functions, and update them with @Set/@Append/@Remove/@Toggle. Use @ToAssistant only for a submit or follow-up the page cannot compute; do not send every click back to the model.",
  'This catalog has no Map, MapMarker or SearchImage components. Use charts and tables for data. Draw a map only when the reader asks for a map, or asks about places, a route or a trip: then build an html_render page instead (see visual_guide, section "maps"). Diagrams of systems and processes are SVG pages, never maps.',
  "Pick the most specific component for the job instead of hand-building it from primitives: products, places, people or listings → EntityCard (several in a Grid); a web page you link to → LinkCard; claims backed by retrieved sources → CitedText, whose [n] markers open the source; a set of photos → ImageGrid; study or quiz cards → FlashcardFlip; a live, running or degraded status → PulseIndicator; jargon or metrics to define → DefinedText (terms inside a paragraph) or Tooltip (a lone term); extra details that would clutter the page → Popover; a date or a time → DateTimeInput; 2-5 views of the same content → SegmentedControl bound to a $variable; a custom tile the reader clicks → Pressable; videos and audio files you were given → Video and AudioPlayer.",
  'Interactive actions — { type: "continue_conversation", context: "..." } on card blocks, list items and Buttons, or Action([@ToAssistant("...")]) — send their text back to you as a user message. That is how follow-ups, item taps, and form submissions reach you.',
  "Never invent components or props: use only the components below, with positional arguments in the documented order.",
].join("\n\n");

/** Generate from the same live library used by OpenUIRendererInner. */
export function buildOpenUIChatReference(): string {
  return mossOpenUILibrary.prompt({
    ...openuiChatPromptOptions,
    examples: [...(openuiChatPromptOptions.examples ?? []), MOSS_DASHBOARD_EXAMPLE],
    preamble: MOSS_OPENUI_REFERENCE_INTRO,
    // Moss routes actions into the composer; it does not expose live tools or
    // the library's separate openui-lang inline-response mode to this renderer.
    toolCalls: false,
    bindings: false,
  });
}

/**
 * Collapse the schema-derived `(A | B | … | Z)[]` child-union dumps (1.2-1.5KB
 * each, repeated across Card/SectionItem/TabItem/AccordionItem/Carousel/Modal)
 * into the named alias `ContentBlock[]`, with a legend defining it once. Quoted
 * enum alternations ("small" | "default") are untouched — only bare component
 * name unions collapse.
 */
function collapseContentUnions(text: string): string {
  const collapsed = text.replace(/\(([A-Za-z]+( \| [A-Za-z]+){5,})\]/g, "ContentBlock]");
  return collapsed.replace(
    "## Component Signatures\n",
    "## Component Signatures\n\n`ContentBlock` stands for any chat content component (text, callout, image, code, separator, every chart, table, form, buttons, list, tag, entity, steps, inline header, and every card block); `ContentBlock[][]` in Carousel means an array of slides, each an array of content.\n",
  );
}

const EXAMPLES_HEADING = "## Examples";
const EXAMPLES_END_HEADING = "## Important Rules";

/**
 * Core catalog without the worked examples: intro, syntax, all component
 * signatures (unions collapsed), action/streaming rules. Small enough to fit
 * tool-result limits that truncate the full document.
 */
export function buildOpenUIChatReferenceCore(): string {
  // Keep the catalog signatures complete while dropping prose descriptions from
  // the bounded default tool result; the on-demand examples retain the full copy.
  const raw = collapseContentUnions(buildOpenUIChatReference());
  const signatureAt = raw.indexOf("## Component Signatures");
  const examplesAtRaw = raw.indexOf(EXAMPLES_HEADING);
  const full =
    signatureAt >= 0 && examplesAtRaw > signatureAt
      ? raw.slice(0, signatureAt) +
        raw.slice(signatureAt, examplesAtRaw).replace(/\s—[^\n]*/g, "") +
        raw.slice(examplesAtRaw)
      : raw;
  const examplesAt = full.indexOf(EXAMPLES_HEADING);
  const rulesAt = full.indexOf(EXAMPLES_END_HEADING);
  if (examplesAt === -1 || rulesAt === -1 || rulesAt < examplesAt) {
    throw new Error(
      "openui-chat-reference: upstream prompt structure changed (## Examples / ## Important Rules); update the section split in apps/web/src/lib/openUIChatReference.ts",
    );
  }
  const pointer = `${EXAMPLES_HEADING}\nWorked examples (explainer card, analytics answer, trip-planner form, recommendations, table with follow-ups, dashboard with working filters) are served separately — call openui_reference again with { "section": "examples" } if you want them.\n\n`;
  return full.slice(0, examplesAt) + pointer + full.slice(rulesAt);
}

/** The worked-examples block, served on demand via { section: "examples" }. */
export function buildOpenUIChatExamples(): string {
  const full = buildOpenUIChatReference();
  const examplesAt = full.indexOf(EXAMPLES_HEADING);
  const rulesAt = full.indexOf(EXAMPLES_END_HEADING);
  if (examplesAt === -1 || rulesAt === -1 || rulesAt < examplesAt) {
    throw new Error(
      "openui-chat-reference: upstream prompt structure changed (## Examples / ## Important Rules); update the section split in apps/web/src/lib/openUIChatReference.ts",
    );
  }
  return full.slice(examplesAt, rulesAt).trimEnd();
}

/** Component names the Moss library exposes — the closed set a program may call. */
export function openUIChatComponentNames(): ReadonlySet<string> {
  return new Set(Object.keys(mossOpenUILibrary.components));
}
