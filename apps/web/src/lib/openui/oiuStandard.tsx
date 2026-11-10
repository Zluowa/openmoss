// @ts-nocheck
// FILE: oiuStandard.tsx
// Purpose: The standard-catalog additions to Moss's OpenUI visual language: what the model
//   can call for layout grids, text accents, choice inputs, media, live feedback and the
//   prebuilt composites (LinkCard, Citation, EntityCard, ImageGrid). This file holds the
//   schemas, descriptions and prompt groups; oiuStandardViews.tsx draws them.
//   Components the Moss catalog already covers under its own name are not repeated here
//   (Box/Row/Column are Stack, Badge is Tag, Divider is Separator, TextField is Input,
//   ChoicePicker is Chips/CheckBoxGroup, FollowUp is FollowUpBlock, Title is CardHeader).
//   Map and HtmlView stay out: maps and raw HTML are html_render pages (see visual_guide).
// Layer: Chat UI support (imported by mossOpenUILibrary.tsx; importable in Node)
// Origin: Component set, semantics and descriptions adapted from the standard generative-UI
//   catalog in CopilotKit (https://github.com/CopilotKit/CopilotKit,
//   packages/react-core/src/v2/generative-ui/standard, MIT) at 180a2f0. Moss uses OpenUI
//   Lang positional arguments, its own theme tokens and its own action routing.
//   See THIRD_PARTY_NOTICES.md.

import { action, defineComponent, reactive } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { children, option } from "./oiuStyle";
import {
  AudioPlayerView,
  BlockquoteView,
  CitationView,
  CitedTextView,
  DateTimeInputView,
  DefinedTextView,
  EntityCardView,
  FaviconView,
  FlashcardFlipView,
  FlowItemView,
  FlowView,
  GridItemView,
  GridView,
  ImageGridView,
  LinkCardView,
  LinkView,
  PopoverView,
  PressableView,
  PulseIndicatorView,
  SegmentedControlView,
  ShimmerTextView,
  SpacerView,
  TooltipView,
  VideoView,
} from "./oiuStandardViews";

const TONES = ["neutral", "info", "success", "warning", "danger"] as const;
/** A short text, or one component (an Icon, a Tag, a TextContent). */
const textOrNode = z.union([z.string(), z.any()]);

// ── Layout ──

const Grid = defineComponent({
  name: "Grid",
  props: z.object({
    children,
    columns: z.number().optional(),
    minChildWidth: z.number().optional(),
    gap: z.enum(["s", "m", "l"]).optional(),
  }),
  description:
    "Responsive CSS grid: columns (default 2, up to 6) collapse towards one column on a narrow screen; minChildWidth (px) instead lets as many columns fit as the width allows. Children are any components, or GridItem for a cell that spans columns.",
  component: GridView,
});

const GridItem = defineComponent({
  name: "GridItem",
  props: z.object({
    children,
    span: z.number().optional(),
    rowSpan: z.number().optional(),
  }),
  description: "A Grid cell spanning span columns and rowSpan rows (default 1).",
  component: GridItemView,
});

const Flow = defineComponent({
  name: "Flow",
  props: z.object({ children, columns: z.number().optional() }),
  description:
    "Masonry-like grid that packs FlowItem cells of different sizes densely (default 3 columns), for photo walls and mixed tiles.",
  component: FlowView,
});

const FlowItem = defineComponent({
  name: "FlowItem",
  props: z.object({
    children,
    span: z.number().optional(),
    rowSpan: z.number().optional(),
  }),
  description: "A Flow cell spanning span columns and rowSpan rows (default 1).",
  component: FlowItemView,
});

const Spacer = defineComponent({
  name: "Spacer",
  props: z.object({ size: z.enum(["s", "m", "l"]).optional() }),
  description: "Empty vertical space. You almost never need it: containers already have gaps.",
  component: SpacerView,
});

// ── Text ──

const Blockquote = defineComponent({
  name: "Blockquote",
  props: z.object({ text: z.string(), cite: z.string().optional() }),
  description:
    "A block quotation with a line on the left; text takes inline markdown, cite names who said it.",
  component: BlockquoteView,
});

const ShimmerText = defineComponent({
  name: "ShimmerText",
  props: z.object({ text: z.string() }),
  description:
    "Text with a moving shimmer, showing that something is loading or pending (stops under reduced motion).",
  component: ShimmerTextView,
});

const Link = defineComponent({
  name: "Link",
  props: z.object({ label: z.string(), url: z.string() }),
  description: "An inline link that opens an http(s) URL in the browser.",
  component: LinkView,
});

const Tooltip = defineComponent({
  name: "Tooltip",
  props: z.object({ trigger: textOrNode, content: z.string() }),
  description:
    "A lone term (a short text, an Icon or a Tag) that shows content when the reader points at or focuses it. It is content on its own line or in a Stack row, never a title or label of another component. For terms inside a sentence use DefinedText.",
  component: TooltipView,
});

const DefinedText = defineComponent({
  name: "DefinedText",
  props: z.object({
    text: z.string(),
    terms: z.array(z.object({ term: z.string(), definition: z.string() })),
  }),
  description:
    'A paragraph whose first mention of each term is underlined and shows its definition on hover or focus. text takes inline markdown; each term must appear in text verbatim. DefinedText("毛利率 41.3%，EBITDA 96 亿元。", [{term: "毛利率", definition: "..."}, {term: "EBITDA", definition: "..."}]).',
  component: DefinedTextView,
});

// ── Inputs ──

export const SegmentedControl = defineComponent({
  name: "SegmentedControl",
  props: z.object({
    name: z.string(),
    options: z.array(option),
    value: reactive(z.string().optional()),
  }),
  description:
    'A row of 2-5 segments; the reader picks one. options are strings or {value, label}. Bind value to a $variable to switch what the page shows: SegmentedControl("view", ["Week", "Month"], $view).',
  component: SegmentedControlView,
});

export const DateTimeInput = defineComponent({
  name: "DateTimeInput",
  props: z.object({
    name: z.string(),
    mode: z.enum(["date", "time", "datetime"]).optional(),
    step: z.number().optional(),
    value: reactive(z.string().optional()),
  }),
  description:
    'A date, time or date-and-time input (default "datetime"). step is minutes between offered times, e.g. 30 for bookings. The value is ISO 8601 ("2026-11-04", "14:30", "2026-11-04T14:30"). In a Form, put it in a FormControl like any other field.',
  component: DateTimeInputView,
});

const Pressable = defineComponent({
  name: "Pressable",
  props: z.object({
    children,
    action: action().optional(),
    url: z.string().optional(),
  }),
  description:
    'A container the reader can click or press with Enter or Space: it runs action (e.g. Action([@ToAssistant("Tell me more about X")]) or a @Set), or opens url. Use it to make a custom tile clickable; a Button inside it sends only its own action.',
  component: PressableView,
});

// ── Media ──

const Favicon = defineComponent({
  name: "Favicon",
  props: z.object({ url: z.string(), size: z.number().optional() }),
  description:
    "The site icon for a URL (default 16px), with a letter fallback when it cannot load.",
  component: FaviconView,
});

const Video = defineComponent({
  name: "Video",
  props: z.object({
    url: z.string(),
    title: z.string().optional(),
    poster: z.string().optional(),
  }),
  description:
    "A video: a direct .mp4/.webm/.mov URL plays inline with controls; a YouTube or other page URL shows its thumbnail and opens the page in the browser. Set title.",
  component: VideoView,
});

const AudioPlayer = defineComponent({
  name: "AudioPlayer",
  props: z.object({
    url: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
  }),
  description: "An audio player for a direct audio file URL (.mp3, .m4a, .ogg, .wav).",
  component: AudioPlayerView,
});

// ── Feedback & overlay ──

const PulseIndicator = defineComponent({
  name: "PulseIndicator",
  props: z.object({ label: z.string().optional(), tone: z.enum(TONES).optional() }),
  description:
    'A small status dot that breathes slowly, with an optional label, e.g. PulseIndicator("Live", "success") for a live or running status. For a list of statuses, stack several.',
  component: PulseIndicatorView,
});

const FlashcardFlip = defineComponent({
  name: "FlashcardFlip",
  props: z.object({
    front: z.string(),
    back: z.string(),
    hint: z.string().optional(),
  }),
  description:
    "A study card showing front with a Show answer control; a click or Enter opens back below it and closes it again. Both sides take inline markdown. Stack several for a deck.",
  component: FlashcardFlipView,
});

const Popover = defineComponent({
  name: "Popover",
  props: z.object({
    trigger: z.string(),
    children,
    title: z.string().optional(),
  }),
  description:
    "A button labelled trigger that toggles a small overlay holding children (text, a list, a small table). Escape or a click outside closes it. Use it for details that would clutter the page.",
  component: PopoverView,
});

// ── Composites ──

const linkSchema = z.object({ label: z.string(), url: z.string().optional() });

const LinkCard = defineComponent({
  name: "LinkCard",
  props: z.object({
    url: z.string(),
    title: z.string(),
    description: z.string().optional(),
    image: z.string().optional(),
    domain: z.string().optional(),
  }),
  description:
    "A compact source row: site icon, title and domain on one line, one line of description, optional small thumbnail. A click opens the page. Use it for real sources and articles you have URLs for; stack several in a Stack.",
  component: LinkCardView,
});

const Citation = defineComponent({
  name: "Citation",
  props: z.object({
    index: z.number(),
    title: z.string(),
    url: z.string().optional(),
    snippet: z.string().optional(),
    source: z.string().optional(),
  }),
  description:
    "A lone source chip (it shows source, or the site name) that shows the source title, snippet and link on hover or focus, e.g. after a table or a metric. For claims in a sentence use CitedText, which puts the chips inside the text. Only cite sources you actually have.",
  component: CitationView,
});

const citedSource = z.object({
  title: z.string(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  source: z.string().optional(),
});

const CitedText = defineComponent({
  name: "CitedText",
  props: z.object({ text: z.string(), sources: z.array(citedSource) }),
  description:
    'A paragraph with inline citations: every [n] in text becomes a chip naming the nth source (its source field, e.g. "Reuters", else the site) that shows title, snippet and link on hover or focus; adjacent markers like [1][2] share one chip. text takes inline markdown. CitedText("Weight loss was similar in both groups [1], and lean mass fell [2].", [{title, url, snippet, source}, {...}]).',
  component: CitedTextView,
});

const EntityCard = defineComponent({
  name: "EntityCard",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    meta: z.string().optional(),
    badge: z.object({ label: z.string(), tone: z.enum(TONES).optional() }).optional(),
    rating: z.number().optional(),
    ratingCount: z.number().optional(),
    url: z.string().optional(),
    actions: z.array(linkSchema).optional(),
    layout: z.enum(["vertical", "horizontal"]).optional(),
  }),
  description:
    'One product, place, person or listing: image, title, subtitle, description, a meta line ("$29 / month", "Open until 22:00"), badge, 0-5 rating with count, and up to three actions. url opens the page on click; an action with url opens it, an action without url sends its label back as a follow-up. layout "horizontal" is a compact row with a small thumbnail: stack several to compare options. The default vertical card puts a large image on top: put several in a Grid when the photos matter.',
  component: EntityCardView,
});

const ImageGrid = defineComponent({
  name: "ImageGrid",
  props: z.object({
    images: z.array(
      z.object({
        src: z.string(),
        alt: z.string().optional(),
        caption: z.string().optional(),
      }),
    ),
    columns: z.number().optional(),
    layout: z.enum(["grid", "bento"]).optional(),
  }),
  description:
    'A gallery of images (default 3 columns, two rows shown, the last tile counts the rest); a click opens the image full-screen with arrows to the others. Captions show under each image. layout "bento" makes the first image twice as large.',
  component: ImageGridView,
});

/** Every standard-catalog addition, in prompt order. All are legal inside any container. */
export const standardComponents = [
  Grid,
  GridItem,
  Flow,
  FlowItem,
  Spacer,
  Blockquote,
  ShimmerText,
  Link,
  Tooltip,
  DefinedText,
  SegmentedControl,
  DateTimeInput,
  Pressable,
  Favicon,
  Video,
  AudioPlayer,
  PulseIndicator,
  FlashcardFlip,
  Popover,
  LinkCard,
  Citation,
  CitedText,
  EntityCard,
  ImageGrid,
];

export const standardComponentGroups = [
  {
    name: "Grid Layout",
    components: ["Grid", "GridItem", "Flow", "FlowItem", "Spacer"],
    notes: [
      "- Grid lays out several similar things side by side (vertical EntityCards with photos, KPI tiles, images); it collapses to one column on a phone. Use Stack for a single row or column, and for lists of horizontal EntityCards, LinkCards or flashcards.",
      "- Grid(children, columns, minChildWidth, gap): pass columns for a fixed count, or minChildWidth (e.g. 220) to fit as many as the width allows.",
      "- Names from other UI catalogs map onto this one: Box, Row and Column are Stack; Divider is Separator; Title is CardHeader or InlineHeader; Text and Caption are TextContent (size small); Badge is Tag; Markdown is MarkDownRenderer; Code is CodeBlock; TextField is Input; CheckBox is CheckBoxItem; ChoicePicker is Chips or CheckBoxGroup; FollowUp is FollowUpBlock; CarouselMediaItem is an ImageBlock in a Carousel; Map and HtmlView are html_render pages.",
    ],
  },
  {
    name: "Text Accents",
    components: ["Blockquote", "ShimmerText", "Link", "DefinedText", "Tooltip"],
    notes: [
      "- Inline markdown in TextContent already covers bold, italic, strikethrough and [links](url); use Link only when a link stands alone next to other components.",
    ],
  },
  {
    name: "Choice & Time Inputs",
    components: ["SegmentedControl", "DateTimeInput", "Pressable"],
    notes: [
      '- A SegmentedControl bound to $view switches what the page shows without a round trip: content = $view == "Week" ? weekChart : monthChart.',
    ],
  },
  {
    name: "Media",
    components: ["Favicon", "Video", "AudioPlayer"],
    notes: ["- Only use media URLs you actually have; never invent a video or audio address."],
  },
  {
    name: "Feedback & Overlay",
    components: ["PulseIndicator", "FlashcardFlip", "Popover"],
  },
  {
    name: "Composites",
    components: ["LinkCard", "CitedText", "Citation", "EntityCard", "ImageGrid"],
    notes: [
      "- One composite replaces many primitives: prefer EntityCard over hand-built CompositeCardItems for a product, place or person, and LinkCard for a page you link to.",
      "- CitedText numbers its sources from 1 in the order of its sources array; every [n] must refer to a source you actually retrieved. Do not also write the same [n] in a TextContent next to it.",
    ],
  },
];
