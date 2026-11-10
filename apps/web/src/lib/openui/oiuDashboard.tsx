// @ts-nocheck
// FILE: oiuDashboard.tsx
// Purpose: The dashboard kit's catalog for Moss's OpenUI visual language. A Dashboard root
//   holds a DashboardHeader and Sections; a Section holds an optional FilterBar and
//   CardRows of SmallCard, MediumCard and LargeCard; cards hold a DashboardCardHeader,
//   MetricIndicator, List and Moss's own charts, tables, tags and text. FilterSelect and
//   FilterMultiSelect write $variables, so a dashboard filters its own data with
//   @functions. Also re-scopes three stock components so the kit's forms parse: IconText
//   (title optional, so IconText(Icon(...), variant) is the bare icon badge), ListItem
//   (an Icon may take the image slot) and ListBlock (holds the re-scoped ListItem).
//   This file holds what the model can call (schemas, descriptions, prompt groups);
//   oiuDashboardViews.tsx draws it.
// Layer: Chat UI support (imported by mossOpenUILibrary.tsx)
// Origin: Adapted from the OpenUI dashboard kit (packages/kits/dashboard/src/lib,
//   @openuidev/dashboard-kit 0.0.1) in OpenUI (https://github.com/thesysdev/openui, MIT)
//   at 9f01894. Component names, positional arguments and semantics match the kit so its
//   prompts and examples transfer. Moss accepts plain-string filter options, puts its own
//   charts in the card slots (Buttons stands in for ButtonGroup; the kit's inline Select is
//   left out because Moss form inputs need a Form) and makes ListItem actions work in List.
//   See THIRD_PARTY_NOTICES.md.

import { defineComponent, reactive } from "@openuidev/react-lang";
import { z } from "zod/v4";
import {
  CardRowView,
  DashboardCardHeaderView,
  DashboardHeaderView,
  DashboardView,
  FilterBarView,
  FilterMultiSelectView,
  FilterSelectView,
  IconBadge,
  LargeCardView,
  ListView,
  MediumCardView,
  MetricIndicatorView,
  SectionView,
  SmallCardView,
} from "./oiuDashboardViews";

type DefinedComponent = {
  name: string;
  props: unknown;
  description: string;
  component: unknown;
  ref: unknown;
};
/** Looks up a library component by name: Moss's own content first, then the stock ones. */
export type ResolveComponent = (name: string) => DefinedComponent;

const trendSchema = z.object({ direction: z.enum(["up", "down"]), value: z.number() });
const ICON_VARIANTS = ["neutral", "info", "success", "warning", "danger", "inverted"] as const;

// What a MediumCard holds, in the kit's order with Moss's names.
const MEDIUM_CARD_CONTENT = [
  "DashboardCardHeader",
  "BarChart",
  "LineChart",
  "AreaChart",
  "RadarChart",
  "HorizontalBarChart",
  "PieChart",
  "RadialChart",
  "ScatterChart",
  "FunnelChart",
  "SegmentedBar",
  "Table",
  "MetricIndicator",
  "TextContent",
  "MarkDownRenderer",
  "Callout",
  "ImageBlock",
  "TagBlock",
  "Button",
  "Buttons",
  "List",
  "EntityList",
  // Standard-catalog additions (oiuStandard.tsx) that read well inside a card.
  "Grid",
  "SegmentedControl",
  "PulseIndicator",
  "ShimmerText",
  "Tooltip",
  "DefinedText",
  "Popover",
  "Blockquote",
  "Link",
  "LinkCard",
  "Citation",
  "CitedText",
  "EntityCard",
  "ImageGrid",
];
// A LargeCard leaves out the round charts and adds the wide matrix ones.
const ROUND_CHARTS = new Set(["RadarChart", "PieChart", "RadialChart"]);
const LARGE_CARD_CONTENT = MEDIUM_CARD_CONTENT.filter((name) => !ROUND_CHARTS.has(name)).flatMap(
  (name) => (name === "SegmentedBar" ? [name, "HeatmapChart", "CalendarHeatmap"] : [name]),
);

/**
 * Builds the dashboard components against the host library. `resolve` supplies the
 * components the kit places in its slots (charts, tables, Icon, IconButton, DatePicker)
 * and the stock IconText, ListItem and ListBlock it re-scopes.
 */
export function createDashboardKit(resolve: ResolveComponent) {
  const overrides = createStockOverrides(resolve);
  const cards = createCardComponents(resolve, overrides);
  const filters = createFilterComponents(resolve);
  return {
    /** The kit's own components, in catalog order. */
    components: [...createLayoutComponents(resolve, cards, filters), ...cards.all],
    /** Re-scoped stock components; the host drops the stock ones of the same names. */
    overrides: [overrides.IconText, overrides.ListItem, overrides.ListBlock],
  };
}

const BARE_ICON_TEXT =
  "With only an Icon and iconVariant it is a bare icon badge: the icon form of SmallCard.";
const ICON_LIST_ITEM = 'In a List with variant "icon" the third argument may be an Icon.';

function createStockOverrides(resolve: ResolveComponent) {
  const stockIconText = resolve("IconText");
  const StockIconText = stockIconText.component;
  const IconText = defineComponent({
    name: "IconText",
    props: stockIconText.props.extend({ title: z.string().optional() }),
    description: `${stockIconText.description} ${BARE_ICON_TEXT}`,
    component: function IconTextView(args) {
      return args.props.title ? (
        <StockIconText {...args} />
      ) : (
        <IconBadge
          icon={args.props.icon}
          variant={args.props.iconVariant}
          renderNode={args.renderNode}
        />
      );
    },
  });

  const stockListItem = resolve("ListItem");
  const ListItem = defineComponent({
    name: "ListItem",
    props: stockListItem.props.extend({
      image: z.union([stockListItem.props.shape.image.unwrap(), resolve("Icon").ref]).optional(),
    }),
    description: `${stockListItem.description} ${ICON_LIST_ITEM}`,
    component: stockListItem.component,
  });

  // ListBlock's items slot names ListItem alone, so it must point at the re-scoped one.
  const stockListBlock = resolve("ListBlock");
  const ListBlock = defineComponent({
    name: "ListBlock",
    props: stockListBlock.props.extend({ items: z.array(ListItem.ref) }),
    description: stockListBlock.description,
    component: stockListBlock.component,
  });

  return { IconText, ListItem, ListBlock };
}

function createCardComponents(resolve: ResolveComponent, { IconText, ListItem }) {
  const IconButton = resolve("IconButton");

  const MetricIndicator = defineComponent({
    name: "MetricIndicator",
    props: z.object({
      value: z.string(),
      subtext: z.string().optional(),
      trend: trendSchema.optional(),
    }),
    description:
      "A headline value with an optional +/- percentage trend and a label below; use inside SmallCard (icon form), MediumCard and LargeCard.",
    component: MetricIndicatorView,
  });

  const DashboardCardHeader = defineComponent({
    name: "DashboardCardHeader",
    props: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      titleType: z.enum(["text", "number"]).default("text"),
      controls: z.array(IconButton.ref).max(2).optional(),
    }),
    description:
      'Card header for MediumCard and LargeCard, placed first. If the card leads with one KPI or score, make that value the title with titleType "number" and the label the subtitle; use titleType "text" for descriptive titles. controls takes up to two IconButtons.',
    component: DashboardCardHeaderView,
  });

  const List = defineComponent({
    name: "List",
    props: z.object({
      items: z.array(ListItem.ref).default([]),
      variant: z.enum(["icon", "number"]).default("number"),
      heading: z.string().optional(),
      description: z.string().optional(),
    }),
    description:
      'Numbered or icon list for a card. variant "number" (default) numbers the rows; use variant "icon" when the ListItems carry an Icon as their third argument. A ListItem with an action is a clickable row.',
    component: ListView,
  });

  const SmallCard = defineComponent({
    name: "SmallCard",
    props: z.object({
      top: z.union([
        z.string(),
        IconText.ref,
        z.object({
          title: z.string(),
          subtitle: z.string().optional(),
          icon: z.optional(resolve("Icon").ref),
          iconVariant: z.enum(ICON_VARIANTS).optional(),
          imageSrc: z.string().optional(),
          imageAlt: z.string().optional(),
        }),
      ]),
      bottom: z
        .union([
          z.string(),
          z.number(),
          z.array(MetricIndicator.ref),
          z.object({
            value: z.string(),
            subtext: z.string().optional(),
            variant: z.enum(["text", "number", "textOnly"]).optional(),
            subtextVariant: z.enum(["text", "number", "metric"]).optional(),
          }),
        ])
        .optional(),
      trend: trendSchema.optional(),
    }),
    description:
      'Compact dashboard card with three forms. KPI: SmallCard(title, metric, trend?) for a metric with no universal symbol. Icon KPI: SmallCard(IconText(Icon(...), iconVariant), [MetricIndicator(value, label, trend?)]) when the metric has one (users, revenue, errors, latency). Snippet: SmallCard({title, subtitle?, icon?, iconVariant?, imageSrc?, imageAlt?}, {value, subtext?, variant?, subtextVariant?}) for one record with one emphasized value; subtextVariant "metric" colors a "+" or "-" subtext.',
    component: SmallCardView,
  });

  const own = { DashboardCardHeader, MetricIndicator, List };
  const cardProps = (content: string[]) =>
    z.object({
      children: z
        .array(z.union(content.map((name) => (own[name] ?? resolve(name)).ref)))
        .default([]),
      collapsed: z.boolean().default(false),
    });

  const MediumCard = defineComponent({
    name: "MediumCard",
    props: cardProps(MEDIUM_CARD_CONTENT),
    description:
      "Dashboard card for one chart, table, list or text block, led by a DashboardCardHeader. collapsed true clips a dense card to a preview with an Expand control.",
    component: MediumCardView,
  });

  const LargeCard = defineComponent({
    name: "LargeCard",
    props: cardProps(LARGE_CARD_CONTENT),
    description:
      "Wide dashboard card for a main chart or a long table, led by a DashboardCardHeader; no round charts (PieChart, RadialChart, RadarChart). collapsed true clips it to a preview with an Expand control, only in rows that also hold a MediumCard.",
    component: LargeCardView,
  });

  return {
    SmallCard,
    MediumCard,
    LargeCard,
    all: [SmallCard, MediumCard, LargeCard, DashboardCardHeader, MetricIndicator, List],
  };
}

function createFilterComponents(resolve: ResolveComponent) {
  const options = z
    .array(z.union([z.string(), z.object({ value: z.string(), label: z.string().optional() })]))
    .default([]);

  const FilterSelect = defineComponent({
    name: "FilterSelect",
    props: z.object({
      name: z.string(),
      label: z.string(),
      options,
      defaultValue: reactive(z.string().optional()),
      placeholder: z.string().optional(),
    }),
    description:
      'Single-choice dashboard filter for a FilterBar. Bind it to a $variable (FilterSelect("region", "Region", options, $region)) and read that variable wherever the filter applies; unbound, it still sets $name (here $region) to the chosen value.',
    component: FilterSelectView,
  });

  const FilterMultiSelect = defineComponent({
    name: "FilterMultiSelect",
    props: z.object({
      name: z.string(),
      label: z.string(),
      options,
      defaultValues: reactive(z.array(z.string()).optional()),
      placeholder: z.string().optional(),
    }),
    description:
      "Several-choice dashboard filter for a FilterBar. Bind it to a list $variable and filter rows with @WhereIn(rows, field, $variable); nothing picked keeps every row.",
    component: FilterMultiSelectView,
  });

  const child = z.union([
    FilterSelect.ref,
    FilterMultiSelect.ref,
    resolve("DatePicker").ref,
    resolve("IconButton").ref,
  ]);
  const FilterBar = defineComponent({
    name: "FilterBar",
    props: z.object({
      children: z.array(child).default([]),
      rightChildren: z.array(child).default([]),
      compact: z.boolean().default(false),
    }),
    description:
      "The filters of one Section: FilterSelect, FilterMultiSelect, DatePicker and IconButton only. rightChildren sit at the end of the bar; compact tightens the gaps.",
    component: FilterBarView,
  });

  return { FilterBar, FilterSelect, FilterMultiSelect };
}

function createLayoutComponents(resolve: ResolveComponent, cards, filters) {
  const CardRow = defineComponent({
    name: "CardRow",
    props: z.object({
      children: z
        .array(z.union([cards.SmallCard.ref, cards.MediumCard.ref, cards.LargeCard.ref]))
        .default([]),
      align: z.enum(["start", "stretch"]).default("stretch"),
    }),
    description:
      "A row of dashboard cards that wraps on narrow screens. Valid rows: SmallCards only, MediumCards only, MediumCard + LargeCard, or LargeCards only.",
    component: CardRowView,
  });

  const Section = defineComponent({
    name: "Section",
    props: z.object({
      rows: z.array(CardRow.ref).min(1),
      filterBar: z.optional(filters.FilterBar.ref),
      title: z.string().optional(),
    }),
    description:
      "Major topical dashboard grouping with rows and an optional FilterBar. Use one Section for most dashboard content; add more Sections only for altogether different domains or topics. title names the Section; give one when a dashboard has several Sections.",
    component: SectionView,
  });

  const DashboardHeader = defineComponent({
    name: "DashboardHeader",
    props: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      controls: z.array(resolve("IconButton").ref).max(2).optional(),
    }),
    description:
      "Page-level header of a Dashboard: title, optional subtitle (period, scope, units) and up to two IconButtons.",
    component: DashboardHeaderView,
  });

  const Dashboard = defineComponent({
    name: "Dashboard",
    props: z.object({
      children: z.array(z.union([DashboardHeader.ref, Section.ref])).min(1),
    }),
    description:
      "Root of a dashboard, used instead of Card: root = Dashboard([DashboardHeader(...), Section(...), ...]).",
    component: DashboardView,
  });

  return [
    Dashboard,
    DashboardHeader,
    Section,
    CardRow,
    filters.FilterBar,
    filters.FilterSelect,
    filters.FilterMultiSelect,
  ];
}

/** Prompt groups for the kit, listed after the host's own groups. */
export const dashboardComponentGroups = [
  {
    name: "Dashboard Layout & Filters",
    components: [
      "Dashboard",
      "DashboardHeader",
      "Section",
      "CardRow",
      "FilterBar",
      "FilterSelect",
      "FilterMultiSelect",
    ],
    notes: [
      "- A dashboard (KPIs, charts, tables and filters about one topic) is the one program whose root is not Card: root = Dashboard([header, section]). Never wrap a Dashboard in a Card.",
      "- Use one Section for most dashboards. Add Sections only for altogether different topics (Sales vs Expenses) and give each a title. A Section holds CardRows plus an optional FilterBar for the rows it affects.",
      "- Valid CardRows: SmallCards only, MediumCards only, MediumCard + LargeCard, or LargeCards only. Never mix SmallCard with MediumCard or LargeCard in a row. Rows wrap on narrow screens.",
      '- A filter must change what the dashboard shows. Declare $region = "all", pass $region as the FilterSelect value, then read every value it affects from one object with an entry per option (data[$region].revenue), or filter rows in the page: $region == "all" ? rows : @Filter(rows, "region", "==", $region). Aggregate with @Sum, @Count, @Round, @GroupBy and @Top.',
      '- FilterMultiSelect values are a list: declare $channels = [], pass $channels, and filter with @WhereIn(rows, "channel", $channels); nothing picked keeps every row.',
      '- Without a data tool use FilterSelect even for dates: written data cannot follow a free date, so offer periods as options ("Last 30 days").',
    ],
  },
  {
    name: "Dashboard Cards",
    components: [
      "SmallCard",
      "MediumCard",
      "LargeCard",
      "DashboardCardHeader",
      "MetricIndicator",
      "List",
    ],
    notes: [
      '- SmallCard KPI form: SmallCard("Churn rate", "2.4%", {direction: "down", value: 0.3}) for an abstract or internal metric.',
      '- SmallCard icon form: SmallCard(IconText(Icon("users", "people"), "info"), [MetricIndicator("2,847", "Active users", {direction: "up", value: 8.1})]) when the metric has a universal symbol (users, revenue, errors, latency).',
      '- SmallCard snippet form: SmallCard({title: "Acme Corp", subtitle: "Enterprise", icon: Icon("building-2")}, {value: "$48K", subtext: "+12%", subtextVariant: "metric"}) for one account, task or alert with one emphasized value; never for aggregate KPIs.',
      "- MediumCard and LargeCard start with a DashboardCardHeader, then a chart, Table, MetricIndicator, List, EntityList, TagBlock, TextContent, Callout or Buttons. LargeCard takes no PieChart, RadialChart or RadarChart; use a vertical BarChart there for categories.",
      '- DashboardCardHeader: when a card leads with one KPI, make the value the title with titleType "number" and the label the subtitle.',
      "- MediumCard(children, true) and LargeCard(children, true) clip a dense card (long table or text, several blocks) to a preview with an Expand control. Never collapse cards in a LargeCard-only row.",
      '- List(items, variant, heading, description) numbers its ListItems; with variant "icon" each ListItem(title, subtitle, Icon(...)) shows its icon. A ListItem action (fifth argument) makes the row clickable.',
      '- A trend\'s direction sets the sign and color (up green, down red), so pass the magnitude: {direction: "down", value: 3} reads -3%.',
      "- Buttons and IconButtons only send their label back as a chat message: they cannot export, download or save. Never offer a download button.",
    ],
  },
];
