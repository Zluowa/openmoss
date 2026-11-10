// @ts-nocheck
// FILE: oiuDashboardViews.tsx
// Purpose: How the dashboard kit draws: the Dashboard frame, header, sections, card rows
//   that wrap by card width, the three card sizes (with a collapsed card's preview and
//   Expand control), card headers, metrics, trends, icon badges, lists and filter fields,
//   all in Moss theme tokens. Also the row and option rules the views apply.
// Layer: Chat UI support (renderers for oiuDashboard.tsx; the pickers and the expand
//   dialog load lazily from oiuDashboardControls.tsx, so Node, the validation tests and
//   the reference generator never import the app's UI primitives)
// Origin: Adapted from the views in the OpenUI dashboard kit (packages/kits/dashboard/src)
//   in OpenUI (https://github.com/thesysdev/openui, MIT) at 9f01894. Moss draws with its
//   own tokens instead of @openuidev/react-components, wraps rows by card width instead of
//   row-width arithmetic, and seeds an unbound filter's $variable with its default.
//   See THIRD_PARTY_NOTICES.md.

import {
  useFormName,
  useGetFieldValue,
  useIsStreaming,
  useSetDefaultValue,
  useSetFieldValue,
  useStateField,
  useTriggerAction,
} from "@openuidev/react-lang";
import { lazy, Suspense, useId, useLayoutEffect, useRef, useState } from "react";
import { inline } from "./oiuMarkdown";
import { cx, webUrl } from "./oiuStyle";

// The pickers and the expand dialog use the app's Base UI primitives and localization.
// Loading them on first use keeps this module importable outside the browser.
const controls = () => import("./oiuDashboardControls");
const FilterSelectControl = lazy(async () => ({
  default: (await controls()).FilterSelectControl,
}));
const FilterMultiSelectControl = lazy(async () => ({
  default: (await controls()).FilterMultiSelectControl,
}));
const CardExpandControl = lazy(async () => ({ default: (await controls()).CardExpandControl }));

// ── Values ──

const isElement = (value: unknown, name?: string) =>
  !!value &&
  typeof value === "object" &&
  value.type === "element" &&
  (name === undefined || value.typeName === name);
const isRecord = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value) && value.type !== "element";
const isScalar = (value: unknown) =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const text = (value: unknown) => (value == null ? "" : String(value));
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value == null ? [] : [value];
/** Icon slots take an Icon(...) node; a bare name works too and renders the same Icon. */
const iconNode = (icon: unknown) =>
  typeof icon === "string" && icon.trim()
    ? { type: "element", typeName: "Icon", props: { name: icon.trim() } }
    : isElement(icon, "Icon")
      ? icon
      : null;

const CARD_SURFACE = "rounded-card border border-border bg-card text-card-foreground";
const NUMBER_TEXT = "font-semibold tabular-nums tracking-tight text-foreground";
const METRIC_TEXT = cx("text-xl leading-7", NUMBER_TEXT);
const LABEL_TEXT = "text-ui-sm text-muted-foreground";

/** Heading semantics on a div: transcript prose styles every h1-h6 inside a reply. */
function Heading({ level, className, children }) {
  return (
    <div role="heading" aria-level={level} className={className}>
      {children}
    </div>
  );
}

// ── Shared pieces ──

/** The direction supplies the sign, so {direction: "down", value: -3} reads -3%, not --3%. */
function Trend({ trend }) {
  if (!isRecord(trend)) return null;
  const amount = Number(trend.value);
  if (!Number.isFinite(amount)) return null;
  const up = trend.direction === "up";
  const down = trend.direction === "down";
  const magnitude = up || down ? Math.abs(amount) : amount;
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center text-ui-xs font-medium tabular-nums",
        up ? "text-success" : down ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {up ? "+" : down ? "−" : ""}
      {magnitude.toLocaleString("en-US", { maximumFractionDigits: 1 })}%
    </span>
  );
}

// The tints follow the Badge recipe in components/ui/badge.tsx: the role color at 8% (16%
// in dark) under the role color as ink.
const ICON_TONE: Record<string, string> = {
  neutral: "bg-muted text-foreground",
  soft: "bg-muted text-foreground",
  info: "bg-info/8 text-info-foreground dark:bg-info/16",
  success: "bg-success/8 text-success dark:bg-success/16",
  warning: "bg-warning/8 text-warning dark:bg-warning/16",
  danger: "bg-destructive/8 text-destructive dark:bg-destructive/16",
  inverted: "bg-foreground text-background",
  filled: "bg-foreground text-background",
};

/** A tinted square holding one Icon; IconText without a title draws as this. */
export function IconBadge({ icon, variant, renderNode }) {
  const node = iconNode(icon);
  if (!node) return null;
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-control [&_svg]:size-4",
        ICON_TONE[variant] ?? ICON_TONE.neutral,
      )}
    >
      {renderNode(node)}
    </span>
  );
}

function ControlList({ controls, renderNode }) {
  const nodes = asArray(controls).slice(0, 2);
  return nodes.length ? (
    <div className="flex shrink-0 items-center gap-1">{renderNode(nodes)}</div>
  ) : null;
}

// ── Layout ──

export function DashboardView({ props, renderNode }) {
  return (
    <div data-moss-dashboard="" className="flex w-full min-w-0 flex-col gap-5 text-foreground">
      {renderNode(asArray(props.children))}
    </div>
  );
}

export function DashboardHeaderView({ props, renderNode }) {
  return (
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Heading level={2} className="text-ui-xl font-semibold leading-snug text-foreground">
          {text(props.title)}
        </Heading>
        {props.subtitle ? <span className={LABEL_TEXT}>{text(props.subtitle)}</span> : null}
      </div>
      <ControlList controls={props.controls} renderNode={renderNode} />
    </header>
  );
}

export function SectionView({ props, renderNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      {props.title ? (
        <Heading level={3} className="text-ui-lg font-semibold text-foreground">
          {text(props.title)}
        </Heading>
      ) : null}
      {props.filterBar ? renderNode(props.filterBar) : null}
      <div className="flex min-w-0 flex-col gap-3">{renderNode(asArray(props.rows))}</div>
    </section>
  );
}

const CARD_KIND: Record<string, string> = {
  SmallCard: "small",
  MediumCard: "medium",
  LargeCard: "large",
};

/** Which card sizes a row holds: one size, "medium-large", "empty", or "mixed" (invalid). */
export function rowVariant(cards: unknown[]): string {
  if (!cards.length) return "empty";
  const kinds = new Set(cards.map((card) => (isElement(card) ? CARD_KIND[card.typeName] : null)));
  if (kinds.has(null) || kinds.has(undefined)) return "mixed";
  if (kinds.size === 1) return [...kinds][0];
  return kinds.size === 2 && kinds.has("medium") && kinds.has("large") ? "medium-large" : "mixed";
}

/**
 * The kit's row rules: LargeCards alone in a row are never collapsed, and three
 * MediumCards in a row draw their pie charts as half circles to fit the narrow cards.
 */
export function normalizeRow(cards: unknown[], variant: string): unknown[] {
  if (variant === "large") {
    return cards.map((card) =>
      card.props?.collapsed === true
        ? { ...card, props: { ...card.props, collapsed: false } }
        : card,
    );
  }
  if (variant !== "medium" || cards.length !== 3) return cards;
  return cards.map((card) => ({
    ...card,
    props: {
      ...card.props,
      children: asArray(card.props?.children).map((child) =>
        isElement(child, "PieChart")
          ? { ...child, props: { ...child.props, appearance: "semiCircular" } }
          : child,
      ),
    },
  }));
}

/**
 * SmallCards share an auto-fit grid (two KPI columns at phone width, orphans keep their
 * column width; snippet cards need a wider column for their two sides); other rows wrap
 * by each card's basis, and LargeCards alone take the row.
 */
export function CardRowView({ props, renderNode }) {
  const cards = asArray(props.children);
  const variant = rowVariant(cards);
  const snippets = variant === "small" && cards.some((card) => isRecord(card.props?.top));
  return (
    <div
      data-card-row={variant}
      className={cx(
        variant !== "small"
          ? "flex flex-wrap"
          : snippets
            ? "grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]"
            : "grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))]",
        variant === "large" && "*:basis-full",
        "min-w-0 gap-3",
        props.align === "start" ? "items-start" : "items-stretch",
      )}
    >
      {renderNode(normalizeRow(cards, variant))}
    </div>
  );
}

// ── Cards ──

function SmallShell({ className, children }) {
  return (
    <div
      data-dashboard-card="small"
      className={cx("flex min-w-0 flex-[1_1_9rem] flex-col px-3.5 py-3", CARD_SURFACE, className)}
    >
      {children}
    </div>
  );
}

/** The kit's three SmallCard forms: KPI, icon KPI (free slots) and snippet. */
export function SmallCardView({ props, renderNode }) {
  const { top, bottom } = props;
  if (typeof top === "string" && isScalar(bottom)) {
    return (
      <SmallShell>
        <span className={cx("truncate", LABEL_TEXT)}>{top}</span>
        <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className={METRIC_TEXT}>{text(bottom)}</span>
          <Trend trend={props.trend} />
        </div>
      </SmallShell>
    );
  }
  if (isRecord(top) && isRecord(bottom) && bottom.value != null) {
    return <SnippetCard lhs={top} rhs={bottom} renderNode={renderNode} />;
  }
  return (
    <SmallShell className="gap-2.5">
      {typeof top === "string" ? (
        <span className={cx("truncate", LABEL_TEXT)}>{top}</span>
      ) : (
        renderNode(top)
      )}
      {bottom == null ? null : (
        <div className="flex min-w-0 flex-col gap-2">
          {isScalar(bottom) ? (
            <span className={METRIC_TEXT}>{text(bottom)}</span>
          ) : (
            renderNode(bottom)
          )}
        </div>
      )}
    </SmallShell>
  );
}

function SnippetCard({ lhs, rhs, renderNode }) {
  const photo = webUrl(lhs.imageSrc);
  const subtext = text(rhs.subtext);
  const metric = rhs.subtextVariant === "metric";
  const subtextTone =
    metric && subtext.startsWith("+")
      ? "text-success"
      : metric && /^[-−]/.test(subtext)
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <SmallShell className="flex-row items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {lhs.icon ? (
          <IconBadge icon={lhs.icon} variant={lhs.iconVariant} renderNode={renderNode} />
        ) : photo ? (
          <img
            src={photo}
            alt={text(lhs.imageAlt) || text(lhs.title)}
            className="size-8 shrink-0 rounded-control object-cover"
          />
        ) : null}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-ui font-medium text-foreground">{text(lhs.title)}</span>
          {lhs.subtitle ? (
            <span className="truncate text-ui-xs text-muted-foreground">{text(lhs.subtitle)}</span>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 shrink-0 flex-col items-end text-end">
        <span
          className={cx(
            "truncate text-ui text-foreground",
            rhs.variant !== "textOnly" && "font-semibold",
            rhs.variant === "number" && "tabular-nums",
          )}
        >
          {text(rhs.value)}
        </span>
        {subtext ? (
          <span
            className={cx(
              "truncate text-ui-xs",
              subtextTone,
              (metric || rhs.subtextVariant === "number") && "tabular-nums",
            )}
          >
            {subtext}
          </span>
        ) : null}
      </div>
    </SmallShell>
  );
}

export function MediumCardView({ props, renderNode }) {
  return <ShellCard size="medium" props={props} renderNode={renderNode} />;
}

export function LargeCardView({ props, renderNode }) {
  return <ShellCard size="large" props={props} renderNode={renderNode} />;
}

/** Medium and Large cards; collapsed clips the body and offers an Expand dialog. */
function ShellCard({ size, props, renderNode }) {
  const isStreaming = useIsStreaming();
  const collapsed = props.collapsed === true;
  const items = asArray(props.children);
  const content = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!collapsed || !element) {
      setOverflowing(false);
      return;
    }
    const frame = element.parentElement;
    const read = () =>
      setOverflowing(
        !!frame && frame.clientHeight > 0 && element.scrollHeight > frame.clientHeight + 1,
      );
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed]);
  const header = items.find((item) => isElement(item, "DashboardCardHeader"));
  const clipped = collapsed && overflowing;
  return (
    <div
      data-dashboard-card={size}
      className={cx(
        "flex min-w-0 flex-col gap-3 p-4",
        size === "large" ? "flex-[2_1_28rem]" : "flex-[1_1_18rem]",
        CARD_SURFACE,
      )}
    >
      <div
        className={cx(
          "relative min-w-0",
          collapsed && "overflow-hidden",
          collapsed && (size === "large" ? "max-h-70" : "max-h-60"),
        )}
      >
        <div ref={content} className="flex min-w-0 flex-col gap-3">
          {renderNode(items)}
        </div>
        {clipped ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-card"
          />
        ) : null}
      </div>
      {clipped && !isStreaming ? (
        // Pinned to the bottom so Expand lines up across a stretched row.
        <div className="mt-auto">
          <Suspense fallback={null}>
            <CardExpandControl
              title={text(header?.props?.title)}
              subtitle={text(header?.props?.subtitle)}
              body={renderNode(items.filter((item) => item !== header))}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}

export function DashboardCardHeaderView({ props, renderNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Heading
          level={4}
          className={
            props.titleType === "number"
              ? cx("text-2xl leading-8", NUMBER_TEXT)
              : "text-ui-lg font-semibold text-foreground"
          }
        >
          {text(props.title)}
        </Heading>
        {props.subtitle ? <span className={LABEL_TEXT}>{text(props.subtitle)}</span> : null}
      </div>
      <ControlList controls={props.controls} renderNode={renderNode} />
    </div>
  );
}

export function MetricIndicatorView({ props }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className={METRIC_TEXT}>{text(props.value)}</span>
        <Trend trend={props.trend} />
      </div>
      {props.subtext ? <span className={LABEL_TEXT}>{text(props.subtext)}</span> : null}
    </div>
  );
}

/** Numbered or icon rows; a ListItem with an action is a button, as in ListBlock. */
export function ListView({ props, renderNode }) {
  const triggerAction = useTriggerAction();
  const isStreaming = useIsStreaming();
  const items = asArray(props.items).filter((item) => isElement(item));
  const icons = props.variant === "icon";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.heading || props.description ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {props.heading ? (
            <Heading level={5} className="text-ui font-semibold text-foreground">
              {text(props.heading)}
            </Heading>
          ) : null}
          {props.description ? <span className={LABEL_TEXT}>{text(props.description)}</span> : null}
        </div>
      ) : null}
      <div role="list" className="flex min-w-0 flex-col divide-y divide-border">
        {items.map((item, index) => {
          const title = text(item.props?.title);
          const subtitle = text(item.props?.subtitle);
          const action = item.props?.action;
          const body = (
            <>
              <ListMarker
                icons={icons}
                index={index}
                image={item.props?.image}
                renderNode={renderNode}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui text-foreground">{inline(title)}</span>
                {subtitle ? <span className={LABEL_TEXT}>{inline(subtitle)}</span> : null}
              </span>
            </>
          );
          return (
            <div role="listitem" key={index} className="min-w-0 py-1">
              {action ? (
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => triggerAction(title, undefined, action)}
                  className="flex w-full min-w-0 items-start gap-3 rounded-row px-1.5 py-1.5 text-start hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-64"
                >
                  {body}
                </button>
              ) : (
                <div className="flex min-w-0 items-start gap-3 px-1.5 py-1.5">{body}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListMarker({ icons, index, image, renderNode }) {
  if (!icons) {
    return (
      <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-ui-xs font-medium tabular-nums text-muted-foreground">
        {index + 1}
      </span>
    );
  }
  const photo = isRecord(image) ? webUrl(image.src) : null;
  return photo ? (
    <img
      src={photo}
      alt={text(image.alt)}
      className="size-8 shrink-0 rounded-control object-cover"
    />
  ) : (
    <IconBadge icon={image ?? "circle-dot"} variant="neutral" renderNode={renderNode} />
  );
}

// ── Filters ──

export function FilterBarView({ props, renderNode }) {
  const gap = props.compact ? "gap-1.5" : "gap-2";
  const right = asArray(props.rightChildren);
  return (
    <div className={cx("flex min-w-0 flex-wrap items-end", gap)}>
      <div className={cx("flex min-w-0 flex-1 flex-wrap items-end", gap)}>
        {renderNode(asArray(props.children))}
      </div>
      {right.length ? (
        <div className={cx("ms-auto flex flex-wrap items-end", gap)}>{renderNode(right)}</div>
      ) : null}
    </div>
  );
}

/** Options as {value, label}: plain strings are both, blank and repeated values drop. */
export function normalizeOptions(options: unknown): { value: string; label: string }[] {
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const option of asArray(options)) {
    const raw = isElement(option) ? option.props : option;
    const value = isScalar(raw) ? String(raw) : text(raw?.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: isScalar(raw) ? value : text(raw?.label) || value });
  }
  return out;
}

/**
 * One filter's state, as in the kit: a bound $variable is read and written directly;
 * unbound, the value lives under `name` and is mirrored to `$name` so expressions can
 * read it. Moss also seeds that mirror with the default once streaming ends, so
 * data[$region] works before the first pick.
 */
function useFilterBinding(componentType: string, name: string, defaultValue: unknown) {
  const isStreaming = useIsStreaming();
  const formName = useFormName();
  const setFieldValue = useSetFieldValue();
  const getFieldValue = useGetFieldValue();
  const field = useStateField(name, defaultValue);
  const mirror = `$${name}`;
  useSetDefaultValue({
    formName,
    componentType,
    name: mirror,
    existingValue: field.isReactive ? null : (getFieldValue(formName, mirror) ?? undefined),
    defaultValue: field.isReactive ? undefined : (field.value ?? undefined),
  });
  return {
    value: field.value,
    disabled: isStreaming,
    setValue: (value: unknown) => {
      field.setValue(value);
      if (!field.isReactive) setFieldValue(formName, componentType, mirror, value, false);
    },
  };
}

function FilterField({ label, children }) {
  const labelId = useId();
  return (
    <div className="flex min-w-0 flex-[1_1_9rem] flex-col gap-1 sm:w-44 sm:flex-none">
      <span id={labelId} className="truncate text-ui-xs text-muted-foreground">
        {text(label)}
      </span>
      <Suspense
        fallback={
          <div aria-hidden className="h-8 w-full rounded-control border border-border sm:h-7" />
        }
      >
        {children(labelId)}
      </Suspense>
    </div>
  );
}

export function FilterSelectView({ props }) {
  const binding = useFilterBinding("FilterSelect", props.name, props.defaultValue);
  return (
    <FilterField label={props.label}>
      {(labelId) => (
        <FilterSelectControl
          labelId={labelId}
          options={normalizeOptions(props.options)}
          value={binding.value == null ? "" : String(binding.value)}
          placeholder={props.placeholder}
          disabled={binding.disabled}
          onValueChange={binding.setValue}
        />
      )}
    </FilterField>
  );
}

export function FilterMultiSelectView({ props }) {
  const binding = useFilterBinding("FilterMultiSelect", props.name, props.defaultValues ?? []);
  const values = Array.isArray(binding.value)
    ? binding.value.filter((value) => value != null && value !== "").map(String)
    : [];
  return (
    <FilterField label={props.label}>
      {(labelId) => (
        <FilterMultiSelectControl
          labelId={labelId}
          options={normalizeOptions(props.options)}
          values={values}
          placeholder={props.placeholder}
          disabled={binding.disabled}
          onValuesChange={binding.setValue}
        />
      )}
    </FilterField>
  );
}
