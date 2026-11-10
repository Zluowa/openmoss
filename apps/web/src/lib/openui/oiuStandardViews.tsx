// @ts-nocheck
// FILE: oiuStandardViews.tsx
// Purpose: How the standard-catalog additions draw: responsive grids that clamp spans to
//   the columns that fit, text accents, segmented and date/time inputs bound to
//   $variables, clickable containers, media, live dots, study cards, and the composites
//   (LinkCard, Citation, EntityCard, ImageGrid). Links open through Moss's OpenUI action
//   routing; follow-ups land in the composer.
// Design: drawn to docs/design/visual-system.md and Claude's own reply widgets, not to the
//   catalog this came from: replies read like a note, so composites are hairline panels or
//   rows (rounded-card), never stacks of heavy cards; text uses two weights (normal and
//   medium); no primary-filled buttons inside a reply (the first action is secondary, the
//   rest ghost); citations name their publisher instead of a bare [n]; no decorative motion
//   (no 3D flips, ping halos or hover zoom). Tints are ink over the sheet (`INK_*`), because
//   --muted is almost transparent in the dark theme.
// Layer: Chat UI support (renderers for oiuStandard.tsx; the overlays load lazily from
//   oiuStandardControls.tsx, so this module stays importable outside the browser)
// Origin: The catalog's component set and props follow the standard generative-UI catalog
//   in CopilotKit (https://github.com/CopilotKit/CopilotKit, packages/react-core/src/v2/
//   generative-ui/standard, MIT) at 180a2f0. See THIRD_PARTY_NOTICES.md.

import {
  useFormName,
  useIsStreaming,
  useStateField,
  useTriggerAction,
} from "@openuidev/react-lang";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { badgeVariants } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { ArrowUpRightIcon, EyeIcon, PlayIcon, StarFilledIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { inline } from "./oiuMarkdown";
import { cx, textOf, toOption, webUrl } from "./oiuStyle";

const controls = () => import("./oiuStandardControls");
const TooltipControl = lazy(async () => ({ default: (await controls()).TooltipControl }));
const PopoverControl = lazy(async () => ({ default: (await controls()).PopoverControl }));
const CitationControl = lazy(async () => ({ default: (await controls()).CitationControl }));
const LightboxControl = lazy(async () => ({ default: (await controls()).LightboxControl }));

// ── Values ──

const text = (value: unknown) => (value == null ? "" : String(value));
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.flat() : value == null ? [] : [value];
const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
const isScalar = (value: unknown) => typeof value === "string" || typeof value === "number";

/** The host of a URL without "www.", for domain lines and favicon fallbacks. */
export function hostOf(url: unknown): string {
  const href = webUrl(url);
  if (!href) return "";
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A YouTube video id from watch, short, embed and youtu.be URLs. */
export function youTubeId(url: unknown): string | null {
  const href = webUrl(url);
  if (!href) return null;
  try {
    const parsed = new URL(href);
    const host = parsed.hostname.replace(/^(www\.|m\.)/, "");
    const id =
      host === "youtu.be"
        ? parsed.pathname.slice(1).split("/")[0]
        : host === "youtube.com" || host === "youtube-nocookie.com"
          ? parsed.pathname === "/watch"
            ? parsed.searchParams.get("v")
            : /^\/(shorts|embed|live)\/([^/]+)/.exec(parsed.pathname)?.[2]
          : null;
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const isMediaFile = (url: string, extensions: string) =>
  new RegExp(`\\.(${extensions})$`, "i").test(new URL(url).pathname);

/**
 * Whether the app's media policy lets an http(s) file play inline. apps/web/index.html
 * allows media only from the app itself and loopback hosts; anything else is refused,
 * and a refused file does not reliably report an error, so decide before drawing a player.
 */
export function canPlayInline(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return true;
    return typeof window !== "undefined" && parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Who published a cited source, for its chip: the model's `source`, else the host without
 * its last label ("rtings.com" → "rtings"), else the marker number.
 */
export function publisherOf(source: unknown, index: number): string {
  const named = text(source?.source).trim();
  if (named) return named;
  const host = hostOf(source?.url);
  if (host) {
    const parts = host.split(".");
    return parts.length > 1 ? parts.slice(0, -1).join(".") : host;
  }
  return String(index);
}

const GAP_PX = { s: 8, m: 12, l: 20 } as const;
const gapPx = (gap: unknown) => GAP_PX[gap as keyof typeof GAP_PX] ?? GAP_PX.m;

/** Status tones map onto the app's own Badge variants. */
const TONE_BADGE = {
  neutral: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
} as const;
const TONE_DOT = {
  neutral: "bg-muted-foreground",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
} as const;

// Ink tints over the sheet, the weights the visual system names: 3.5% hover, 5% selected or
// filled, 10% pressed or open.
const INK_HOVER = "hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]";
const INK_FILL = "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]";
const INK_FILL_HOVER = "hover:bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)]";
/** A hairline drawn inside media, so pictures keep an edge on a sheet of the same tone. */
const MEDIA_EDGE =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_var(--border)]";

const PANEL = "rounded-card border border-border bg-card text-card-foreground";
const LABEL_TEXT = "text-ui-sm text-muted-foreground";
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
/**
 * Replies render inside .chat-markdown, whose `a` rules color and underline every link.
 * Card-like links drop the underline here and color their text with inner spans, so the
 * link color never leaks into a card or a button.
 */
const PLAIN_LINK = "!no-underline hover:!no-underline focus-visible:!no-underline";
/** The underline a row's title gets while the row is hovered, as on Moss's own links. */
const ROW_TITLE_UNDERLINE =
  "underline-offset-[0.18em] decoration-from-font decoration-muted-foreground/50";

/** Opens an http(s) URL through Moss's action routing (the desktop app opens the browser). */
function useOpenUrl() {
  const triggerAction = useTriggerAction();
  return (url: string | null, label = "") => {
    if (url) void triggerAction(label, undefined, { type: "open_url", params: { url } });
  };
}

/** A link whose click goes through useOpenUrl but keeps native link semantics. */
function ExternalLink({ url, className, children, label, ...rest }) {
  const openUrl = useOpenUrl();
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      {...rest}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        openUrl(url, label);
      }}
    >
      {children}
    </a>
  );
}

// ── Layout ──

/** How many columns a grid actually shows; GridItem and FlowItem clamp their spans to it. */
const GridColumnsContext = createContext(1);

/** Measures the grid's width so `columns` collapse on narrow screens without overflow. */
function useFittedColumns(requested: number, minWidth: number, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(requested);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      const width = element.clientWidth;
      if (width <= 0) return;
      const fit = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
      setColumns(Math.min(requested, fit));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [requested, minWidth, gap]);
  return [ref, columns] as const;
}

export function GridView({ props, renderNode }) {
  const gap = gapPx(props.gap);
  const minChildWidth = clampInt(props.minChildWidth, 80, 640, 0);
  const requested = minChildWidth ? 12 : clampInt(props.columns, 1, 6, 2);
  const [ref, columns] = useFittedColumns(requested, minChildWidth || 150, gap);
  return (
    <GridColumnsContext.Provider value={columns}>
      <div
        ref={ref}
        className="grid w-full min-w-0"
        style={{ gap, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {asArray(props.children).map((child, index) => (
          <div key={index} className="min-w-0 [&:has(>[data-grid-item])]:contents">
            {renderNode(child)}
          </div>
        ))}
      </div>
    </GridColumnsContext.Provider>
  );
}

function SpanCell({ props, renderNode, extraClass }) {
  const columns = useContext(GridColumnsContext);
  const span = clampInt(props.span, 1, 12, 1);
  const rowSpan = clampInt(props.rowSpan, 1, 6, 1);
  return (
    <div
      data-grid-item=""
      className={cx("flex min-w-0 flex-col gap-2", extraClass)}
      style={{
        gridColumn: `span ${Math.min(span, columns)} / span ${Math.min(span, columns)}`,
        gridRow: rowSpan > 1 ? `span ${rowSpan} / span ${rowSpan}` : undefined,
      }}
    >
      {renderNode(asArray(props.children))}
    </div>
  );
}

export function GridItemView({ props, renderNode }) {
  return <SpanCell props={props} renderNode={renderNode} />;
}

export function FlowView({ props, renderNode }) {
  const gap = GAP_PX.s;
  const requested = clampInt(props.columns, 1, 6, 3);
  const [ref, columns] = useFittedColumns(requested, 120, gap);
  return (
    <GridColumnsContext.Provider value={columns}>
      <div
        ref={ref}
        className="grid w-full min-w-0 grid-flow-row-dense"
        style={{
          gap,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: "minmax(7.5rem, auto)",
        }}
      >
        {asArray(props.children).map((child, index) => (
          <div key={index} className="min-w-0 [&:has(>[data-grid-item])]:contents">
            {renderNode(child)}
          </div>
        ))}
      </div>
    </GridColumnsContext.Provider>
  );
}

export function FlowItemView({ props, renderNode }) {
  return (
    <SpanCell
      props={props}
      renderNode={renderNode}
      extraClass="overflow-hidden rounded-card [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
    />
  );
}

export function SpacerView({ props }) {
  const height = { s: 8, m: 16, l: 32 }[props.size] ?? 16;
  return <div aria-hidden style={{ height }} />;
}

// ── Text ──

/** Drawn like the chat's own blockquote: a 2px hairline and secondary text. */
export function BlockquoteView({ props }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-0.5 border-s-2 border-border ps-3">
      {/* The chat's own blockquote rule would draw a second bar; the figure draws the one. */}
      <blockquote className="!m-0 !border-0 !p-0 text-muted-foreground">
        {inline(text(props.text))}
      </blockquote>
      {props.cite ? (
        <figcaption className="text-ui-sm text-muted-foreground/70">{text(props.cite)}</figcaption>
      ) : null}
    </figure>
  );
}

export function ShimmerTextView({ props }) {
  return (
    <span className="shimmer w-fit text-ui text-muted-foreground motion-reduce:shimmer-none">
      {text(props.text)}
    </span>
  );
}

export function LinkView({ props }) {
  const url = webUrl(props.url);
  const label = text(props.label) || hostOf(url);
  if (!url) return <span className="text-foreground">{label}</span>;
  return (
    <ExternalLink
      url={url}
      label={label}
      className={cx(
        "w-fit text-token-text-link-foreground underline-offset-[0.18em] hover:underline",
        FOCUS_RING,
      )}
    >
      {label}
    </ExternalLink>
  );
}

export function TooltipView({ props, renderNode }) {
  const trigger = isScalar(props.trigger) ? inline(text(props.trigger)) : renderNode(props.trigger);
  return (
    <span className="w-fit text-foreground">
      <Suspense fallback={trigger}>
        <TooltipControl trigger={trigger} content={text(props.content)} />
      </Suspense>
    </span>
  );
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A paragraph whose first mention of each term gets a hover definition. */
export function DefinedTextView({ props }) {
  const body = text(props.text);
  const definitions = new Map<string, string>();
  for (const entry of Array.isArray(props.terms) ? props.terms : []) {
    const term = text(entry?.term).trim();
    if (term && entry?.definition && !definitions.has(term)) {
      definitions.set(term, text(entry.definition));
    }
  }
  if (definitions.size === 0) {
    return <p className="m-0 text-foreground">{inline(body)}</p>;
  }
  // Longest terms first, so "经营利润率" wins over "利润率".
  const pattern = new RegExp(
    [...definitions.keys()]
      .toSorted((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  const seen = new Set<string>();
  const parts = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    if (match.index > last) parts.push(inline(body.slice(last, match.index), `t${last}`));
    parts.push(
      <Suspense key={`d${match.index}`} fallback={match[0]}>
        <TooltipControl trigger={match[0]} title={match[0]} content={definitions.get(match[0])} />
      </Suspense>,
    );
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push(inline(body.slice(last), `t${last}`));
  return <p className="m-0 text-foreground">{parts}</p>;
}

// ── Inputs ──

/**
 * Moss's button-group track (ink 4%) with a raised thumb that slides to the chosen segment,
 * the segmented control Claude and Moss settings use.
 */
export function SegmentedControlView({ props }) {
  const isStreaming = useIsStreaming();
  const options = (Array.isArray(props.options) ? props.options : [])
    .filter((option) => option != null)
    .map(toOption);
  const field = useStateField(props.name, props.value ?? options[0]?.value);
  const selected = field.value == null ? "" : String(field.value);
  const radioItemProps = useRadioGroupKeyboardNav({
    values: options.map((option) => option.value),
    value: selected,
    onValueChange: (value) => field.setValue(value),
  });
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const read = () => {
      const button = track.querySelector<HTMLElement>('[aria-checked="true"]');
      setThumb(button ? { left: button.offsetLeft, width: button.offsetWidth } : null);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(track);
    return () => observer.disconnect();
  }, [selected, options.length]);
  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={text(props.name)}
      className="relative isolate inline-flex w-fit max-w-full flex-wrap items-center rounded-control bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5"
    >
      {thumb ? (
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 left-0 -z-1 rounded-inline bg-card shadow-xs ring-1 ring-border transition-[translate,width] duration-200 ease-out motion-reduce:transition-none dark:bg-[color-mix(in_srgb,var(--foreground)_11%,transparent)] dark:shadow-none dark:ring-0"
          style={{ width: thumb.width, translate: `${thumb.left}px 0` }}
        />
      ) : null}
      {options.map((option) => {
        const active = option.value === selected;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={isStreaming}
            onClick={() => field.setValue(option.value)}
            {...radioItemProps(option.value)}
            className={cx(
              "h-6 cursor-pointer rounded-inline px-2.5 text-ui-sm whitespace-nowrap transition-colors disabled:cursor-default",
              active
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
              FOCUS_RING,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const DATE_TIME_INPUT_TYPE = { date: "date", time: "time", datetime: "datetime-local" } as const;

export function DateTimeInputView({ props }) {
  const isStreaming = useIsStreaming();
  const field = useStateField(props.name, props.value);
  const mode = props.mode in DATE_TIME_INPUT_TYPE ? props.mode : "datetime";
  const stepMinutes = clampInt(props.step, 1, 24 * 60, 0);
  return (
    <Input
      nativeInput
      className="max-w-72 tabular-nums"
      type={DATE_TIME_INPUT_TYPE[mode]}
      name={text(props.name)}
      aria-label={text(props.name)}
      value={field.value == null ? "" : String(field.value)}
      step={mode !== "date" && stepMinutes ? stepMinutes * 60 : undefined}
      disabled={isStreaming}
      onChange={(event) => field.setValue(event.target.value)}
    />
  );
}

const INTERACTIVE_DESCENDANT =
  "button, a, input, select, textarea, [role='button'], [role='radio']";

export function PressableView({ props, renderNode }) {
  const triggerAction = useTriggerAction();
  const formName = useFormName();
  const isStreaming = useIsStreaming();
  const openUrl = useOpenUrl();
  const ref = useRef<HTMLDivElement>(null);
  const url = webUrl(props.url);
  const enabled = !isStreaming && (props.action != null || url != null);
  const press = (target: EventTarget | null) => {
    if (!enabled) return;
    // A control inside the container handles its own press.
    const inner = target instanceof Element ? target.closest(INTERACTIVE_DESCENDANT) : null;
    if (inner && inner !== ref.current) return;
    if (props.action != null) void triggerAction(textOf(ref.current), formName, props.action);
    else openUrl(url, textOf(ref.current));
  };
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={enabled ? 0 : -1}
      aria-disabled={!enabled}
      onClick={(event) => press(event.target)}
      onKeyDown={(event) => {
        if (event.target !== ref.current) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          press(event.target);
        }
      }}
      className={cx(
        "flex min-w-0 cursor-pointer flex-col gap-2 rounded-card p-2 transition-colors aria-disabled:cursor-default aria-disabled:hover:bg-transparent",
        INK_HOVER,
        FOCUS_RING,
      )}
    >
      {renderNode(asArray(props.children))}
    </div>
  );
}

// ── Media ──

/** The site's own /favicon.ico (no third-party icon service), with a letter fallback. */
export function FaviconView({ props }) {
  return <SiteIcon url={props.url} size={clampInt(props.size, 12, 64, 16)} />;
}

function SiteIcon({ url, size }) {
  const href = webUrl(url);
  const host = hostOf(href);
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (!href || failed) {
    return (
      <span
        aria-hidden
        style={{ ...box, fontSize: Math.max(9, size * 0.6) }}
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-inline font-medium uppercase leading-none text-muted-foreground",
          INK_FILL,
        )}
      >
        {host.slice(0, 1) || "?"}
      </span>
    );
  }
  return (
    <img
      src={`${new URL(href).origin}/favicon.ico`}
      alt=""
      style={box}
      className="shrink-0 rounded-inline object-contain"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** The small "play" label on a poster's corner; the picture itself stays unobstructed. */
function PlayLabel() {
  const { t } = useTranslation();
  return (
    <span className="absolute bottom-2 left-2 inline-flex h-5.5 items-center gap-1 rounded-control bg-[rgb(20_20_19/0.72)] pe-1.5 ps-1 text-ui-xs font-medium text-white backdrop-blur-sm transition-colors group-hover:bg-[rgb(20_20_19/0.86)]">
      <PlayIcon className="size-3" />
      {t("chat.visualReply.standard.play")}
    </span>
  );
}

function MediaCaption({ url, title }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
      <SiteIcon url={url} size={14} />
      <span
        className={cx(
          "min-w-0 truncate text-foreground group-hover:underline",
          ROW_TITLE_UNDERLINE,
        )}
      >
        {title || hostOf(url)}
      </span>
      {title ? <span className="shrink-0">{hostOf(url)}</span> : null}
    </span>
  );
}

export function VideoView({ props }) {
  const { format } = useTranslation();
  // The app's media policy only plays local sources inline; a file it refuses opens instead.
  const [failed, setFailed] = useState(false);
  const url = webUrl(props.url);
  const title = text(props.title);
  if (!url) return null;
  if (!failed && isMediaFile(url, "mp4|webm|mov|m4v|ogv") && canPlayInline(url)) {
    return (
      <figure className="m-0 flex min-w-0 flex-col gap-1.5">
        <video
          src={url}
          poster={webUrl(props.poster) ?? undefined}
          controls
          preload="metadata"
          playsInline
          onError={() => setFailed(true)}
          className="aspect-video w-full rounded-card bg-black"
          aria-label={title || undefined}
        />
        {title ? <figcaption className={LABEL_TEXT}>{title}</figcaption> : null}
      </figure>
    );
  }
  // Page URLs (YouTube and other sites) and files that cannot play inline open in the
  // browser: embeds would need third-party frames.
  const id = youTubeId(url);
  const poster = webUrl(props.poster) ?? (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null);
  if (!poster) {
    // Without a picture an empty 16:9 frame reads as broken; a compact row reads as a link.
    return (
      <ExternalLink
        url={url}
        label={title}
        className={cx(
          "group flex min-w-0 items-center gap-2.5 px-3 py-2.5 transition-colors",
          PANEL,
          INK_HOVER,
          PLAIN_LINK,
          FOCUS_RING,
        )}
      >
        <span
          className={cx(
            "flex size-7 shrink-0 items-center justify-center rounded-control text-foreground",
            INK_FILL,
          )}
        >
          <PlayIcon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium text-foreground">
            {title || hostOf(url)}
          </span>
          <span className="truncate text-ui-sm text-muted-foreground">{hostOf(url)}</span>
        </span>
      </ExternalLink>
    );
  }
  return (
    <ExternalLink
      url={url}
      label={title}
      aria-label={format("chat.visualReply.standard.playVideo", { title: title || hostOf(url) })}
      className={cx("group flex min-w-0 flex-col gap-1.5", PLAIN_LINK, FOCUS_RING, "rounded-card")}
    >
      <span
        className={cx(
          "relative block aspect-video w-full overflow-hidden rounded-card",
          INK_FILL,
          MEDIA_EDGE,
        )}
      >
        <img
          src={poster}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
        <PlayLabel />
      </span>
      <MediaCaption url={url} title={title} />
    </ExternalLink>
  );
}

export function AudioPlayerView({ props }) {
  const { t } = useTranslation();
  // The app's media policy only plays local sources inline; a file it refuses opens instead.
  const [failed, setFailed] = useState(false);
  const url = webUrl(props.url);
  if (!url) return null;
  return (
    <figure className={cx("m-0 flex min-w-0 flex-col gap-2 p-3", PANEL)}>
      {props.title || props.description ? (
        <figcaption className="flex min-w-0 flex-col">
          {props.title ? (
            <span className="text-ui font-medium text-foreground">{text(props.title)}</span>
          ) : null}
          {props.description ? (
            <span className={LABEL_TEXT}>{inline(text(props.description))}</span>
          ) : null}
        </figcaption>
      ) : null}
      {failed || !canPlayInline(url) ? (
        <ExternalLink
          url={url}
          label={text(props.title)}
          className={cx(buttonVariants({ size: "xs", variant: "secondary" }), "w-fit", PLAIN_LINK)}
        >
          <PlayIcon />
          <span className="text-foreground">{t("chat.visualReply.standard.openInBrowser")}</span>
        </ExternalLink>
      ) : (
        <audio
          src={url}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          className="h-9 w-full"
        />
      )}
    </figure>
  );
}

// ── Feedback & overlay ──

/** A 6px status dot that breathes slowly; no expanding halo. */
export function PulseIndicatorView({ props }) {
  const tone = props.tone in TONE_DOT ? props.tone : "success";
  return (
    <span className="inline-flex w-fit items-center gap-2 text-ui text-foreground">
      <span
        aria-hidden
        className={cx(
          "inline-block size-1.5 shrink-0 animate-pulse rounded-full motion-reduce:animate-none",
          TONE_DOT[tone],
        )}
      />
      {props.label ? text(props.label) : null}
    </span>
  );
}

/**
 * A study card: the front with a Show answer control, and the back opening in place below a
 * hairline. A click anywhere on the card or Enter on the control toggles it.
 */
export function FlashcardFlipView({ props }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cx("flex min-w-0 cursor-pointer flex-col", PANEL)}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, a")) return;
        setOpen((value) => !value);
      }}
    >
      <div className="flex min-w-0 items-center gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-chat font-medium text-foreground">{inline(text(props.front))}</span>
          <span className={LABEL_TEXT}>
            {text(props.hint) || t("chat.visualReply.standard.flipHint")}
          </span>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cx(buttonVariants({ size: "xs", variant: "secondary" }), "shrink-0")}
        >
          <EyeIcon />
          {open
            ? t("chat.visualReply.standard.hideAnswer")
            : t("chat.visualReply.standard.showAnswer")}
        </button>
      </div>
      <div
        className={cx(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-border px-3 py-2.5 text-chat text-foreground">
            {inline(text(props.back))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PopoverView({ props, renderNode }) {
  const isStreaming = useIsStreaming();
  const trigger = text(props.trigger);
  return (
    <Suspense
      fallback={
        <span className={cx(buttonVariants({ size: "sm", variant: "outline" }), "w-fit")}>
          {trigger}
        </span>
      }
    >
      <PopoverControl trigger={trigger} title={props.title} disabled={isStreaming}>
        {renderNode(asArray(props.children))}
      </PopoverControl>
    </Suspense>
  );
}

// ── Composites ──

/** A source row: site icon, title and domain on one line, one line of description. */
export function LinkCardView({ props }) {
  const url = webUrl(props.url);
  const image = webUrl(props.image);
  const domain = text(props.domain) || hostOf(url);
  const title = text(props.title);
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <SiteIcon url={url} size={16} />
          <span
            className={cx(
              "min-w-0 truncate text-ui font-medium text-foreground",
              url && "group-hover:underline",
              ROW_TITLE_UNDERLINE,
            )}
          >
            {title}
          </span>
          <span className="shrink-0 text-ui-sm text-muted-foreground">{domain}</span>
        </span>
        {props.description ? (
          <span className="line-clamp-1 ps-[22px] text-ui-sm text-muted-foreground">
            {text(props.description)}
          </span>
        ) : null}
      </span>
      {image ? (
        <span
          className={cx("relative size-10 shrink-0 overflow-hidden rounded-control", MEDIA_EDGE)}
        >
          <img
            src={image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-cover"
          />
        </span>
      ) : null}
    </>
  );
  const className = cx("flex min-w-0 items-center gap-3 px-3 py-2", PANEL);
  return url ? (
    <ExternalLink
      url={url}
      label={title}
      className={cx("group", className, PLAIN_LINK, "transition-colors", INK_HOVER, FOCUS_RING)}
    >
      {body}
    </ExternalLink>
  ) : (
    <div className={className}>{body}</div>
  );
}

const CHIP = cx(
  "group/chip inline-flex h-4.5 max-w-36 items-center rounded-inline px-1.5 align-[1px] text-ui-xs font-medium leading-none transition-colors",
  INK_FILL,
  INK_FILL_HOVER,
  "data-[popup-open]:bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)]",
);

function SourceSummary({ source, index }) {
  const url = webUrl(source?.url);
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
        <SiteIcon url={url} size={14} />
        <span className="min-w-0 truncate">{hostOf(url) || publisherOf(source, index)}</span>
      </span>
      <span className="text-ui font-medium text-foreground">{text(source?.title)}</span>
      {source?.snippet ? (
        <span className="line-clamp-3 text-ui-sm text-muted-foreground">
          {text(source.snippet)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One citation chip naming its publisher ("RTINGS", "知乎 +1" for a run of sources) with a
 * hover card of the sources; shared by Citation and CitedText.
 */
function CitationMarker({ entries }) {
  const [first, ...rest] = entries;
  const url = webUrl(first.source?.url);
  const label = publisherOf(first.source, first.index);
  const card = (
    <span className="flex min-w-0 flex-col gap-2">
      <SourceSummary source={first.source} index={first.index} />
      {rest.length ? (
        <span className="-mx-1 flex min-w-0 flex-col border-t border-border pt-1.5">
          {rest.map((entry) => (
            <span
              key={entry.index}
              className="flex h-6 min-w-0 items-center gap-1.5 rounded-control px-1 text-ui-sm text-foreground"
            >
              <SiteIcon url={entry.source?.url} size={14} />
              <span className="min-w-0 truncate">
                {text(entry.source?.title) || publisherOf(entry.source, entry.index)}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
  // The chat's link color would win on the anchor itself, so the label colors its own text.
  const chip = (
    <span className="truncate text-muted-foreground group-hover/chip:text-foreground group-data-[popup-open]/chip:text-foreground">
      {label}
      {rest.length ? ` +${rest.length}` : ""}
    </span>
  );
  return (
    <span className="mx-0.5 inline-flex align-baseline">
      <Suspense fallback={<span className={CHIP}>{chip}</span>}>
        <CitationControl
          marker={chip}
          url={url}
          card={card}
          className={cx(CHIP, PLAIN_LINK, FOCUS_RING)}
        />
      </Suspense>
    </span>
  );
}

export function CitationView({ props }) {
  return <CitationMarker entries={[{ index: clampInt(props.index, 1, 999, 1), source: props }]} />;
}

const CITATION_TOKEN = /\[(\d{1,3})\]/g;

/**
 * A paragraph whose [n] tokens become chips for the nth source; tokens with only spaces
 * between them ("[1][3]") share one chip. Unmatched [n] stay text.
 */
export function CitedTextView({ props }) {
  const body = text(props.text);
  const sources = Array.isArray(props.sources) ? props.sources : [];
  const groups: { start: number; end: number; entries: { index: number; source: unknown }[] }[] =
    [];
  for (const match of body.matchAll(CITATION_TOKEN)) {
    const index = Number(match[1]);
    const source = sources[index - 1];
    if (!source) continue;
    const end = match.index + match[0].length;
    const previous = groups.at(-1);
    if (previous && body.slice(previous.end, match.index).trim() === "") {
      if (!previous.entries.some((entry) => entry.index === index)) {
        previous.entries.push({ index, source });
      }
      previous.end = end;
    } else {
      groups.push({ start: match.index, end, entries: [{ index, source }] });
    }
  }
  const parts = [];
  let last = 0;
  for (const group of groups) {
    if (group.start > last) parts.push(inline(body.slice(last, group.start), `t${last}`));
    parts.push(<CitationMarker key={`c${group.start}`} entries={group.entries} />);
    last = group.end;
  }
  if (last < body.length) parts.push(inline(body.slice(last), `t${last}`));
  return <p className="m-0 text-foreground">{parts}</p>;
}

/** One grey star, the score and the count, as metadata rather than decoration. */
function Rating({ rating, count }) {
  const { format } = useTranslation();
  const value = Math.min(5, Math.max(0, rating));
  return (
    <span
      className="inline-flex items-center gap-0.5 tabular-nums"
      aria-label={format("chat.visualReply.standard.rating", { rating: value.toFixed(1) })}
    >
      <StarFilledIcon aria-hidden className="size-3 opacity-70" />
      <span aria-hidden>
        {value.toFixed(1)}
        {typeof count === "number" && Number.isFinite(count) ? ` (${count.toLocaleString()})` : ""}
      </span>
    </span>
  );
}

function EntityActions({ actions, title }) {
  const triggerAction = useTriggerAction();
  const isStreaming = useIsStreaming();
  if (!actions.length) return null;
  return (
    // Above the card-wide title link, so each action keeps its own click.
    <div className="relative z-10 flex min-w-0 flex-wrap items-center gap-1">
      {actions.map((item, index) => {
        const href = webUrl(item.url);
        // Secondary for the first action, ghost for the rest: a reply never shouts.
        const variant = index === 0 ? "secondary" : "ghost";
        const classes = cx(buttonVariants({ size: "xs", variant }), PLAIN_LINK);
        return href ? (
          <ExternalLink key={index} url={href} label={item.label} className={classes}>
            {/* The chat link color would win on the anchor itself. */}
            <span
              className={cx(
                "inline-flex items-center gap-1",
                index === 0 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {text(item.label)}
              <ArrowUpRightIcon className="size-3" />
            </span>
          </ExternalLink>
        ) : (
          <button
            key={index}
            type="button"
            disabled={isStreaming}
            className={classes}
            onClick={() => void triggerAction(`${text(item.label)}: ${title}`)}
          >
            {text(item.label)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One product, place or listing. Horizontal is a compact row (44px thumbnail, title with
 * badge, one line of description, a metadata line, actions on the right), the form for
 * comparing options. Vertical keeps the picture on top for picks where the photo matters.
 */
export function EntityCardView({ props }) {
  const url = webUrl(props.url);
  const image = webUrl(props.image);
  const horizontal = props.layout === "horizontal";
  const title = text(props.title);
  const actions = (Array.isArray(props.actions) ? props.actions : [])
    .filter((item) => item && item.label)
    .slice(0, 3);
  const badge = props.badge && props.badge.label ? props.badge : null;
  const hasRating = typeof props.rating === "number" && Number.isFinite(props.rating);
  const titleText = (
    <span
      className={cx(
        "truncate text-foreground",
        url && "group-hover:underline",
        ROW_TITLE_UNDERLINE,
      )}
    >
      {title}
    </span>
  );
  const titleLine = url ? (
    <ExternalLink
      url={url}
      label={title}
      className={cx(
        "min-w-0 truncate text-ui font-medium after:absolute after:inset-0 after:rounded-[inherit]",
        PLAIN_LINK,
        FOCUS_RING,
      )}
    >
      {titleText}
    </ExternalLink>
  ) : (
    <span className="min-w-0 truncate text-ui font-medium text-foreground">{title}</span>
  );
  const metaLine =
    props.meta || hasRating || (horizontal && props.subtitle) ? (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ui-sm text-muted-foreground tabular-nums">
        {props.meta ? (
          <span className="font-medium text-foreground">{text(props.meta)}</span>
        ) : null}
        {props.meta && hasRating ? (
          <span aria-hidden className="opacity-60">
            ·
          </span>
        ) : null}
        {hasRating ? <Rating rating={props.rating} count={props.ratingCount} /> : null}
        {horizontal && props.subtitle && (props.meta || hasRating) ? (
          <span aria-hidden className="opacity-60">
            ·
          </span>
        ) : null}
        {horizontal && props.subtitle ? <span>{text(props.subtitle)}</span> : null}
      </span>
    ) : null;
  const badgeNode = badge ? (
    <span
      className={cx(
        badgeVariants({ variant: TONE_BADGE[badge.tone] ?? TONE_BADGE.neutral }),
        "shrink-0",
      )}
    >
      {text(badge.label)}
    </span>
  ) : null;
  const picture = image ? (
    <span
      className={cx(
        "relative shrink-0 overflow-hidden",
        INK_FILL,
        horizontal ? "size-11 rounded-control" : "block aspect-[4/3] w-full",
        horizontal && MEDIA_EDGE,
      )}
    >
      <img
        src={image}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-full object-cover"
      />
    </span>
  ) : null;

  if (horizontal) {
    return (
      <div
        className={cx(
          "group relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5",
          PANEL,
          url && cx("transition-colors", INK_HOVER),
        )}
      >
        {picture}
        <div className="flex min-w-0 flex-[1_1_12rem] flex-col">
          <div className="flex min-w-0 items-center gap-1.5">
            {titleLine}
            {badgeNode}
          </div>
          {props.description ? (
            <span className="truncate text-ui-sm text-muted-foreground">
              {inline(text(props.description))}
            </span>
          ) : null}
          {metaLine}
        </div>
        <EntityActions actions={actions} title={title} />
      </div>
    );
  }
  return (
    <div
      className={cx(
        "group relative flex min-w-0 flex-col overflow-hidden",
        PANEL,
        url && cx("transition-colors", INK_HOVER),
      )}
    >
      {picture}
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            {titleLine}
            {props.subtitle ? <span className={LABEL_TEXT}>{text(props.subtitle)}</span> : null}
          </div>
          {badgeNode}
        </div>
        {props.description ? (
          <span className="line-clamp-2 text-ui-sm text-muted-foreground">
            {inline(text(props.description))}
          </span>
        ) : null}
        {metaLine}
        {actions.length ? (
          <div className="mt-1">
            <EntityActions actions={actions} title={title} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A gallery. Without captions the pictures tile edge to edge (2px seams, one rounded-card
 * outline) and show at most two rows, the last tile counting the rest ("+3"). With captions
 * each picture keeps its caption underneath. Any picture opens the viewer.
 */
export function ImageGridView({ props }) {
  const { format } = useTranslation();
  const images = (Array.isArray(props.images) ? props.images : [])
    .filter(
      (image) =>
        image && typeof image.src === "string" && /^(https?:|data:image\/)/.test(image.src.trim()),
    )
    .map((image) => ({ src: image.src.trim(), alt: image.alt, caption: image.caption }));
  const captioned = images.some((image) => image.caption);
  const requested = clampInt(props.columns, 1, 6, 3);
  const [ref, columns] = useFittedColumns(requested, 110, captioned ? GAP_PX.s : 2);
  const bento = props.layout === "bento" && columns >= 2 && images.length >= 3;
  // Two rows: the bento picture takes four cells, every other picture one.
  const limit = captioned ? images.length : bento ? columns * 2 - 3 : columns * 2;
  const shown = images.slice(0, Math.max(1, limit));
  const hidden = images.length - shown.length;
  const [open, setOpen] = useState<number | null>(null);
  const tileLabel = (image, index) =>
    image.alt || format("chat.visualReply.standard.openImage", { index: String(index + 1) });
  return (
    <>
      <div
        ref={ref}
        className={cx(
          "relative grid w-full min-w-0 grid-flow-row-dense",
          !captioned && cx("overflow-hidden rounded-card", MEDIA_EDGE),
        )}
        style={{
          gap: captioned ? GAP_PX.s : 2,
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {shown.map((image, index) => {
          const last = index === shown.length - 1 && hidden > 0;
          const big = bento && index === 0;
          const tile = (
            <button
              type="button"
              onClick={() => setOpen(index)}
              aria-label={
                last
                  ? format("chat.visualReply.standard.moreImages", { count: String(hidden) })
                  : tileLabel(image, index)
              }
              className={cx(
                "relative block w-full cursor-zoom-in overflow-hidden after:absolute after:inset-0 after:bg-black/0 after:transition-colors hover:after:bg-black/10 focus-visible:z-10",
                INK_FILL,
                big ? "h-full min-h-full" : "aspect-square",
                captioned && cx("rounded-card", MEDIA_EDGE),
                FOCUS_RING,
              )}
            >
              <img
                src={image.src}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="size-full object-cover"
              />
              {last ? (
                <span className="absolute inset-0 z-10 flex items-center justify-center bg-[rgb(20_20_19/0.52)] text-ui font-medium text-white">
                  +{hidden}
                </span>
              ) : null}
            </button>
          );
          return captioned ? (
            <figure key={index} className="m-0 flex min-w-0 flex-col gap-1">
              {tile}
              {image.caption ? (
                <figcaption className="truncate text-ui-xs text-muted-foreground">
                  {text(image.caption)}
                </figcaption>
              ) : null}
            </figure>
          ) : (
            <div key={index} className={cx("min-w-0", big && "col-span-2 row-span-2")}>
              {tile}
            </div>
          );
        })}
      </div>
      {open !== null ? (
        <Suspense fallback={null}>
          <LightboxControl images={images} index={open} onIndexChange={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
