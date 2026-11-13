// FILE: dashboardFrame.ts
// Purpose: The document a 数据看板 page runs in: Moss's tokens, the local d3, and the `dash`
//          page runtime (data, onData, calc, loader, draw, colors, params, refresh, setLink),
//          the one-writer mount, marks, source states, picking a number for 数据来源, comment
//          anchors, hand editing of the stored words, and fault reports back to the host.
// Layer: Shared model. The web host posts the document into an opaque-origin sandboxed frame;
//        the runtime never sees the host, the network or storage.
// Exports: DASHBOARD_FRAME_PROTOCOL, buildDashboardFrameDocument, dashboardTokensCss,
//          dashboardPalette, DASHBOARD_STANDARD_LOOK, message types
// Spec: docs/design/data-claude-teardown.md §1.1, §7

import {
  readDatasetFile,
  type DashboardItem,
  type DashboardLook,
  type DashboardPalette,
} from "./dashboard";
import { designSystemCss } from "./designSystems";

export const DASHBOARD_FRAME_PROTOCOL = "moss-dashboard-frame-v1";

/** Moss's own look: paper ground, ink text, the accent blue as the first series colour. */
export const DASHBOARD_STANDARD_LOOK: DashboardLook = {
  name: "默认",
  light: {
    ground: "#fcfcfb",
    card: "#ffffff",
    text: "#141413",
    muted: "#6f6e69",
    border: "#e8e7e3",
    good: "#0f7a2a",
    warning: "#8a5300",
    bad: "#b3261e",
    charts: [
      "#2a78d6",
      "#eb6834",
      "#1baf7a",
      "#eda100",
      "#e87ba4",
      "#008300",
      "#9085e9",
      "#e66767",
    ],
  },
  dark: {
    ground: "#1c1c1b",
    card: "#232322",
    text: "#f0efec",
    muted: "#9a9893",
    border: "#30302e",
    good: "#2fb344",
    warning: "#f5b44a",
    bad: "#f07a7a",
    charts: [
      "#3987e5",
      "#d95926",
      "#199e70",
      "#c98500",
      "#d55181",
      "#2fa84a",
      "#6250d6",
      "#e34948",
    ],
  },
};

export function dashboardPalette(
  look: DashboardLook | undefined,
  mode: "light" | "dark",
): DashboardPalette {
  return (look ?? DASHBOARD_STANDARD_LOOK)[mode];
}

/** CSS custom properties a page may use (named in the spec). They follow the theme and look. */
const FONT_STACKS = {
  sans: '"Inter Variable",Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
  serif: '"Noto Serif SC","Source Han Serif SC","Songti SC",SimSun,Georgia,serif',
  mono: '"JetBrains Mono","Cascadia Mono",ui-monospace,"Microsoft YaHei",monospace',
} as const;

export function dashboardTokensCss(
  look: DashboardLook | undefined,
  mode: "light" | "dark",
): string {
  const font = look?.fontStack ?? FONT_STACKS[look?.font ?? "sans"];
  const radius = look?.radius ?? 12;
  const body = look?.size ?? 14;
  const p = dashboardPalette(look, mode);
  const charts = p.charts.map((color, index) => `--dash-chart-${index + 1}:${color};`).join("");
  const mix = (color: string, amount: number) =>
    `color-mix(in srgb, ${color} ${amount}%, transparent)`;
  return `:root{color-scheme:${mode};--dash-fg:${p.text};--dash-fg-muted:${p.muted};--dash-bg:${p.ground};--dash-panel:${p.card};--dash-line:${p.border};--dash-ok:${p.good};--dash-warn:${p.warning};--dash-bad:${p.bad};${charts}--dash-chart-count:${p.charts.length};--dash-chart-muted:${mix(p.muted, 45)};--dash-chart-critical:${p.bad};--dash-chart-grid:${mix(p.text, 7)};--dash-chart-axis:${mix(p.text, 18)};--dash-chart-reference:${mix(p.text, 35)};--dash-tip-bg:${p.card};--dash-tip-line:${p.border};--dash-tip-shadow:0 2px 6px rgb(0 0 0 / 8%),0 8px 24px rgb(0 0 0 / 12%);--dash-font:${font};--dash-font-number:${font};--dash-font-mono:"JetBrains Mono",ui-monospace,monospace;--dash-size-caption:12px;--dash-size-body:${body}px;--dash-size-heading:15px;--dash-size-title:22px;--dash-weight-medium:475;--dash-gap-xs:8px;--dash-gap-sm:12px;--dash-gap-md:16px;--dash-gap-lg:28px;--dash-gap-xl:40px;--dash-pad-xs:6px;--dash-pad-sm:8px;--dash-pad-md:12px;--dash-pad-lg:16px;--dash-pad-xl:24px;--dash-radius:${radius}px;--dash-dur:200ms;--dash-ease:cubic-bezier(0,0,.2,1)}`;
}

/** Tokens for a view: the dashboard's own, plus the design system's `--ds-*` when it wears one. */
export function dashboardThemeCss(
  item: Pick<DashboardItem, "system">,
  look: DashboardLook | undefined,
  mode: "light" | "dark",
): string {
  return `${dashboardTokensCss(look, mode)}${item.system ? designSystemCss(item.system.tokens, mode) : ""}`;
}

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:var(--dash-bg);color:var(--dash-fg);font-family:var(--dash-font);-webkit-font-smoothing:antialiased}
#dash-root{color:var(--dash-fg);font-size:var(--dash-size-body);line-height:1.45;min-height:100vh}
#dash-root:not(:empty){padding:var(--dash-gutter,clamp(var(--dash-pad-md),4%,var(--dash-pad-xl)))}
#dash-root svg text{font-family:var(--dash-font)}
.dash-select{appearance:none;border:1px solid var(--dash-line);border-radius:8px;background:var(--dash-panel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='M4.5 6.5 8 10l3.5-3.5' fill='none' stroke='%23888' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 8px center;max-width:100%;height:32px;color:var(--dash-fg);font:inherit;padding:0 30px 0 10px}
.dash-select:disabled{opacity:.55}
.dash-skeleton{-webkit-text-fill-color:transparent!important;background-image:linear-gradient(color-mix(in srgb,currentColor 13%,transparent) 0 0)!important;border-radius:.3em}
.dash-skeleton>*{visibility:hidden!important}
.dash-skeleton:empty::before{content:"";display:inline-block;width:3ch}
[data-dash-source-state=refreshing]{opacity:.5;transition:opacity var(--dash-dur) var(--dash-ease)}
[data-dash-lit]{outline:2px solid var(--dash-chart-1);outline-offset:2px;border-radius:4px}
html[data-dash-pick] [data-source]{cursor:pointer}
html[data-dash-pick] [data-source]:hover{outline:1px dashed var(--dash-chart-1);outline-offset:2px}
html[data-dash-comment] #dash-root [data-dash-hover]{outline:2px solid color-mix(in srgb,var(--dash-chart-1) 55%,transparent);outline-offset:2px;cursor:copy}
html[data-dash-edit] #dash-root{outline:none}
html[data-dash-edit] #dash-root [data-dash-locked]{background:color-mix(in srgb,var(--dash-fg) 5%,transparent);border-radius:4px;cursor:not-allowed;user-select:none}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

export interface DashboardFrameBoot {
  readonly nonce: string;
  readonly protocol: string;
  readonly files: Readonly<Record<string, string>>;
  readonly page: string;
  readonly datasets: readonly string[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly colors: number;
  readonly edit: boolean;
  /** Data handed in up front (a share link, where no host answers). */
  readonly inline?: Readonly<Record<string, Record<string, unknown>>>;
}

/** Host → frame messages (besides the boot document). */
export type DashboardHostMessage =
  | {
      readonly kind: "data";
      readonly id: string;
      readonly status: "ok" | "loading" | "connect" | "declined" | "error" | "missing";
      readonly rows?: ReadonlyArray<Record<string, unknown>>;
      readonly columns?: readonly string[];
      readonly value?: unknown;
      /** An answer that is not rows yet (a loader makes rows of it). */
      readonly answer?: unknown;
      readonly args?: Readonly<Record<string, unknown>>;
      readonly message?: string;
      readonly refreshing?: boolean;
      readonly meta?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
    }
  | { readonly kind: "params"; readonly params: Readonly<Record<string, unknown>> }
  | { readonly kind: "mode"; readonly pick: boolean; readonly comment: boolean }
  | {
      readonly kind: "light";
      readonly source: string | null;
      readonly field?: string;
      readonly row?: number;
    }
  | { readonly kind: "rects"; readonly ids: readonly string[] }
  | { readonly kind: "theme"; readonly css: string }
  | { readonly kind: "editCommand"; readonly command: "undo" | "redo" }
  | {
      readonly kind: "callResult";
      readonly ref: string;
      readonly answer?: unknown;
      readonly error?: string;
    }
  | { readonly kind: "serialize" };

/** Frame → host messages. */
export type DashboardFrameMessage =
  | { readonly kind: "boot" }
  | { readonly kind: "use"; readonly ids: readonly string[] }
  | { readonly kind: "setParams"; readonly params: Readonly<Record<string, unknown>> }
  | { readonly kind: "resetParams" }
  | { readonly kind: "refresh"; readonly id: string }
  | {
      readonly kind: "calcs";
      readonly calcs: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly inputs: readonly string[];
        readonly code: string;
        readonly status: string;
        readonly message: string;
        readonly columns: readonly string[];
        readonly rows: ReadonlyArray<Record<string, unknown>>;
        readonly value?: unknown;
      }>;
    }
  | {
      readonly kind: "loaders";
      readonly loaders: ReadonlyArray<{
        readonly id: string;
        readonly description: string;
        readonly code: string;
      }>;
    }
  | {
      readonly kind: "rows";
      readonly id: string;
      readonly status: string;
      readonly message: string;
      readonly columns: readonly string[];
      readonly rows: ReadonlyArray<Record<string, unknown>>;
      readonly count: number;
      readonly value?: unknown;
    }
  | {
      readonly kind: "faults";
      readonly faults: ReadonlyArray<{ readonly where: string; readonly message: string }>;
    }
  | {
      readonly kind: "pick";
      readonly source: string;
      readonly field: string | null;
      readonly row: number | null;
      readonly text: string;
    }
  | {
      readonly kind: "anchor";
      readonly id: string;
      readonly label: string;
      readonly rect: FrameRect;
    }
  | { readonly kind: "rects"; readonly rects: Readonly<Record<string, FrameRect>> }
  | { readonly kind: "page"; readonly html: string; readonly width: number }
  | { readonly kind: "link"; readonly name: string }
  | { readonly kind: "selection"; readonly text: string; readonly at: string | null }
  | { readonly kind: "edited"; readonly count: number }
  | { readonly kind: "serialized"; readonly html: string }
  | {
      readonly kind: "call";
      readonly ref: string;
      readonly id: string;
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

export interface FrameRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

// ── Frame globals ────────────────────────────────────────────────────────────────────────
// The runtime below runs inside the frame. The server imports this module to build share
// snapshots and type-checks without the DOM lib, so the frame globals the runtime uses are
// named here: where the DOM lib is loaded (web, shared) they keep their DOM types; without it
// they fall back to `any`. Only types and `declare`s: nothing here is emitted.
type FrameGlobal<K extends string> = typeof globalThis extends { [key in K]: infer T } ? T : any;
type FrameClass<K extends string> = typeof globalThis extends {
  [key in K]: { prototype: infer T };
}
  ? T
  : any;
type Element = FrameClass<"Element">;
type HTMLElement = FrameClass<"HTMLElement">;
declare const window: FrameGlobal<"window">;
declare const document: FrameGlobal<"document">;
declare const requestAnimationFrame: FrameGlobal<"requestAnimationFrame">;
declare const ResizeObserver: FrameGlobal<"ResizeObserver">;
declare const CSS: FrameGlobal<"CSS">;

/**
 * The page runtime. It is serialized with Function.prototype.toString and runs inside the frame,
 * so it may use nothing from this module's scope.
 */
function mossDashboardRuntime(boot: DashboardFrameBoot): void {
  type Row = Record<string, unknown>;
  type Snapshot = {
    status: string;
    data: unknown;
    columns: string[];
    message: string;
    refreshing: boolean;
    meta: Array<{ label: string; value: string }>;
  };
  const win = window as unknown as Record<string, unknown>;
  const post = (kind: string, body: Record<string, unknown> = {}) =>
    window.parent.postMessage({ protocol: boot.protocol, nonce: boot.nonce, kind, ...body }, "*");
  const root = document.getElementById("dash-root") as HTMLElement;
  const isRows = (value: unknown): value is Row[] =>
    Array.isArray(value) &&
    value.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
  const columnsOf = (rows: Row[]) => {
    const seen = new Set<string>();
    for (const row of rows.slice(0, 200)) for (const key of Object.keys(row)) seen.add(key);
    return [...seen];
  };
  const faults = new Map<string, { where: string; message: string }>();
  let faultTimer = 0;
  const fault = (where: string, error: unknown) => {
    const message =
      error instanceof Error
        ? error.message || error.name
        : typeof error === "string"
          ? error
          : "出错了，但没有说明";
    faults.set(`${where}\u0000${message}`, { where, message: message.slice(0, 500) });
    clearTimeout(faultTimer);
    faultTimer = window.setTimeout(
      () => post("faults", { faults: [...faults.values()].slice(0, 50) }),
      120,
    );
  };
  window.addEventListener("error", (event: FrameClass<"ErrorEvent">) =>
    fault("页面", event.error ?? event.message),
  );
  window.addEventListener("unhandledrejection", (event: FrameClass<"PromiseRejectionEvent">) =>
    fault("页面", event.reason),
  );

  // ── Sources ────────────────────────────────────────────────────────────────────────
  const sources = new Map<
    string,
    Snapshot & { version: number; answer?: unknown; args?: unknown; value?: unknown }
  >();
  for (const id of boot.datasets)
    sources.set(id, {
      status: "loading",
      data: [],
      columns: [],
      message: "",
      refreshing: false,
      meta: [],
      version: 0,
    });
  const used = new Set<string>();
  let useTimer = 0;
  const markUsed = (id: string) => {
    if (used.has(id) || !sources.has(id)) return;
    used.add(id);
    clearTimeout(useTimer);
    useTimer = window.setTimeout(() => post("use", { ids: [...used] }), 0);
  };
  type Calc = {
    inputs: string[];
    fn: (...args: unknown[]) => unknown;
    title: string;
    description: string;
    stamp: string;
    snapshot: Snapshot;
  };
  const calcs = new Map<string, Calc>();
  const loaders = new Map<string, { description: string; fn: (input: unknown) => unknown }>();
  const empty = (status: string, message = ""): Snapshot => ({
    status,
    data: [],
    columns: [],
    message,
    refreshing: false,
    meta: [],
  });

  const readCalc = (id: string, depth: number): Snapshot => {
    const calc = calcs.get(id)!;
    if (depth > 20) return empty("error", "计算互相引用");
    const inputs = calc.inputs.map((input) => read(input, depth + 1));
    const bad = inputs.find((input) => input.status !== "ok");
    if (bad) {
      calc.snapshot = {
        ...empty(bad.status === "missing" ? "error" : bad.status, bad.message),
        data: null,
      };
      calc.stamp = "";
      return calc.snapshot;
    }
    const stamp = calc.inputs
      .map((input) =>
        calcs.has(input) ? calcs.get(input)!.stamp : String(sources.get(input)?.version ?? 0),
      )
      .join("|");
    if (stamp === calc.stamp) return calc.snapshot;
    calc.stamp = stamp;
    try {
      // A source that is not rows gives [], another calc gives its value.
      const value = calc.fn(
        ...inputs.map((input, index) =>
          calcs.has(calc.inputs[index]!) ? input.data : isRows(input.data) ? input.data : [],
        ),
      );
      calc.snapshot = isRows(value)
        ? {
            status: "ok",
            data: value,
            columns: columnsOf(value),
            message: "",
            refreshing: false,
            meta: [],
          }
        : {
            status: "ok",
            data: value === undefined ? null : value,
            columns: [],
            message: "",
            refreshing: false,
            meta: [],
          };
    } catch (error) {
      fault(`计算 ${id}`, error);
      calc.snapshot = {
        ...empty("error", error instanceof Error ? error.message : String(error)),
        data: null,
      };
    }
    reportCalcs();
    return calc.snapshot;
  };
  const read = (id: string, depth = 0): Snapshot => {
    if (calcs.has(id)) return readCalc(id, depth);
    const source = sources.get(id);
    if (!source) return empty("missing", "没有这个数据来源");
    markUsed(id);
    return {
      status: source.status,
      data: source.data,
      columns: source.columns,
      message: source.message,
      refreshing: source.refreshing,
      meta: source.meta,
    };
  };
  let calcTimer = 0;
  const reportCalcs = () => {
    clearTimeout(calcTimer);
    calcTimer = window.setTimeout(() => {
      post("calcs", {
        calcs: [...calcs.entries()].map(([id, calc]) => ({
          id,
          title: calc.title,
          description: calc.description,
          inputs: calc.inputs,
          code: String(calc.fn).slice(0, 20_000),
          status: calc.snapshot.status,
          message: calc.snapshot.message,
          columns: calc.snapshot.columns,
          rows: isRows(calc.snapshot.data) ? calc.snapshot.data.slice(0, 500) : [],
          ...(isRows(calc.snapshot.data) ? {} : { value: safeValue(calc.snapshot.data) }),
        })),
      });
    }, 60);
  };
  const safeValue = (value: unknown) => {
    try {
      return JSON.parse(JSON.stringify(value ?? null));
    } catch {
      return String(value);
    }
  };

  // ── Params ─────────────────────────────────────────────────────────────────────────
  let params: Record<string, unknown> = { ...boot.params };

  // ── Drawings ───────────────────────────────────────────────────────────────────────
  type DrawSpec =
    | ((el: Element) => void)
    | {
        mount?: (el: Element) => unknown;
        update?: (el: Element, made: unknown) => void;
        unmount?: (el: Element, made: unknown) => void;
      };
  const draws = new Map<string, DrawSpec>();
  const made = new WeakMap<Element, { value: unknown }>();
  const listeners: Array<() => void> = [];
  const widths = new WeakMap<Element, number>();
  let scheduled = false;
  let running = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  };
  const visible = (el: Element) =>
    !el.closest("[hidden]") && !el.parentElement?.closest("[data-draw]");
  const runDraw = (name: string, el: Element) => {
    const spec = draws.get(name);
    if (!spec) return;
    try {
      if (typeof spec === "function") spec(el);
      else {
        let entry = made.get(el);
        if (!entry) {
          el.replaceChildren();
          entry = { value: spec.mount ? spec.mount(el) : undefined };
          made.set(el, entry);
        }
        spec.update?.(el, entry.value);
      }
    } catch (error) {
      fault(`绘制 ${name}`, error);
      if (typeof spec !== "function") {
        const entry = made.get(el);
        try {
          spec.unmount?.(el, entry?.value);
        } catch {
          /* already reported */
        }
        made.delete(el);
      }
    }
  };
  const observer = new ResizeObserver((entries: FrameClass<"ResizeObserverEntry">[]) => {
    let changed = false;
    for (const entry of entries) {
      const width = Math.round(entry.contentRect.width);
      if (widths.get(entry.target) !== width) {
        widths.set(entry.target, width);
        changed = true;
      }
    }
    if (changed && !editing) schedule();
  });
  const render = () => {
    if (editing || running) return;
    running = true;
    try {
      for (const fn of listeners) {
        try {
          fn();
        } catch (error) {
          fault("onData", error);
        }
      }
      for (const el of root.querySelectorAll("[data-draw]")) {
        const name = el.getAttribute("data-draw")!;
        if (!draws.has(name) || !visible(el)) continue;
        if (!widths.has(el)) {
          widths.set(el, Math.round(el.getBoundingClientRect().width));
          observer.observe(el);
        }
        runDraw(name, el);
      }
      markTables();
      markStates();
    } finally {
      running = false;
    }
    settle();
  };

  // ── Marks ──────────────────────────────────────────────────────────────────────────
  const idsOf = (el: Element) =>
    (el.getAttribute("data-source") ?? "").split(/\s+/u).filter(Boolean);
  const stateOf = (id: string) => {
    const snap = calcs.has(id) ? calcs.get(id)!.snapshot : sources.get(id);
    if (!snap) return "error";
    if (snap.status === "loading") return "loading";
    if (snap.status !== "ok") return "error";
    if (snap.refreshing) return "refreshing";
    if (isRows(snap.data) && snap.data.length === 0) return "empty";
    return "";
  };
  const markStates = () => {
    let rootState = "";
    for (const el of root.querySelectorAll("[data-source]")) {
      const states = idsOf(el).map(stateOf);
      const state = states.includes("error")
        ? "error"
        : states.includes("loading")
          ? "loading"
          : states.includes("refreshing")
            ? "refreshing"
            : states.length > 0 && states.every((s: string) => s === "empty")
              ? "empty"
              : "";
      if (state) el.setAttribute("data-dash-source-state", state);
      else el.removeAttribute("data-dash-source-state");
      if (state === "error") rootState = "error";
      else if (state === "loading" && rootState !== "error") rootState = "loading";
    }
    if (rootState) root.setAttribute("data-dash-state", rootState);
    else root.removeAttribute("data-dash-state");
  };
  const keyText = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  const markTables = () => {
    for (const table of root.querySelectorAll("table[data-source][data-row-key]")) {
      const tableSource = idsOf(table)[0];
      if (!tableSource) continue;
      const keys: string[] = String(table.getAttribute("data-row-key") ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      const heads = [...table.querySelectorAll("thead th, tr:first-child th")];
      const fields = heads.map((th) => ({
        field: th.getAttribute("data-field"),
        source: idsOf(th)[0] ?? tableSource,
      }));
      const snap = read(tableSource);
      const rows = isRows(snap.data) ? snap.data : [];
      for (const tr of table.querySelectorAll("tbody tr")) {
        const cells = [...tr.children];
        let keyValues: string[] = [];
        const stored = tr.getAttribute("data-key");
        if (stored)
          keyValues = String(stored)
            .split(",")
            .map((part) => decodeURIComponent(part));
        else
          keyValues = keys.map((key) => {
            const index = fields.findIndex((f) => f.field === key);
            return index >= 0 ? (cells[index]?.textContent ?? "").trim() : "";
          });
        const matches = rows.filter((row) =>
          keys.every((key, i) => keyText(row[key]) === keyValues[i]),
        );
        if (matches.length !== 1) continue;
        const where = keys
          .map((key, i) => `${encodeURIComponent(key)}=${encodeURIComponent(keyValues[i]!)}`)
          .join("&");
        cells.forEach((cell, index) => {
          const f = fields[index];
          if (!f?.field) return;
          cell.setAttribute("data-source", f.source);
          cell.setAttribute("data-field", f.field);
          cell.setAttribute("data-where", where);
        });
      }
    }
  };
  const parseWhere = (where: string) =>
    where.split("&").map((pair) => {
      const [k = "", v = ""] = pair.split("=");
      return [decodeURIComponent(k), decodeURIComponent(v)] as const;
    });
  const rowFor = (el: Element, rows: Row[]): { row: Row; index: number } | null => {
    const rowAttr = el.getAttribute("data-row");
    if (rowAttr !== null) {
      const index = Number(rowAttr);
      return rows[index] ? { row: rows[index]!, index } : null;
    }
    const where = el.getAttribute("data-where");
    if (!where) return null;
    const pairs = parseWhere(where);
    const hits = rows.flatMap((row, index) =>
      pairs.every(([k, v]) => keyText(row[k]) === v) ? [{ row, index }] : [],
    );
    return hits.length === 1 ? hits[0]! : null;
  };
  const numberIn = (textValue: string) => {
    const match = /-?\d[\d,]*(\.\d+)?/u.exec(textValue.replace(/\s/gu, ""));
    return match
      ? { value: Number(match[0].replace(/,/gu, "")), decimals: match[1] ? match[1].length - 1 : 0 }
      : null;
  };
  const verifyMarks = () => {
    for (const el of root.querySelectorAll("[data-source][data-field]")) {
      if (el.children.length > 0 || el.closest("table[data-row-key]")) continue;
      const ids = idsOf(el);
      if (ids.length !== 1) continue;
      const id = ids[0]!;
      const snap = read(id);
      if (snap.status !== "ok") continue;
      const field = el.getAttribute("data-field")!;
      const label = `${el.tagName.toLowerCase()}[data-source="${id}"][data-field="${field}"]`;
      if (!isRows(snap.data)) continue;
      if (!snap.columns.includes(field) && snap.data.length > 0) {
        fault(label, `数据里没有「${field}」这一列`);
        continue;
      }
      if (!el.hasAttribute("data-row") && !el.hasAttribute("data-where")) continue;
      const hit = rowFor(el, snap.data);
      if (!hit) {
        fault(label, "标记找不到唯一对应的一行");
        continue;
      }
      const shown = numberIn(el.textContent ?? "");
      const cell = Number(hit.row[field]);
      if (!shown || !Number.isFinite(cell)) continue;
      const scale = 10 ** shown.decimals;
      const close =
        Math.abs(Math.round(cell * scale) / scale - shown.value) <= 1 / scale ||
        Math.abs(cell - shown.value) <= Math.abs(cell) * 0.005;
      const percent = Math.abs(cell * 100 - shown.value) <= 1 / scale;
      if (!close && !percent) fault(label, `页面显示 ${shown.value}，数据是 ${cell}`);
    }
  };
  let settleTimer = 0;
  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      const pending = [...used].some((id) => sources.get(id)?.status === "loading");
      if (pending || editing) return;
      verifyMarks();
      for (const id of used) {
        const source = sources.get(id)!;
        post("rows", {
          id,
          status: source.status,
          message: source.message,
          columns: source.columns,
          rows: isRows(source.data) ? source.data.slice(0, 500) : [],
          count: isRows(source.data) ? source.data.length : 0,
          ...(isRows(source.data) ? {} : { value: safeValue(source.data) }),
        });
      }
      post("page", { html: pageText(), width: Math.round(root.clientWidth) });
    }, 700);
  };
  const pageText = () => {
    const clone = root.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll("script,style,template,svg defs")) el.remove();
    for (const el of clone.querySelectorAll("svg,canvas,img")) {
      const img = document.createElement("img");
      const label = el.getAttribute("aria-label") ?? el.getAttribute("alt");
      if (label) img.setAttribute("alt", label);
      for (const name of ["id", "data-source"])
        if (el.getAttribute(name)) img.setAttribute(name, el.getAttribute(name)!);
      el.replaceWith(img);
    }
    for (const el of clone.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        if (
          ![
            "id",
            "data-source",
            "data-field",
            "data-where",
            "data-row",
            "data-draw",
            "hidden",
            "alt",
            "href",
            "lang",
          ].includes(attr.name)
        )
          el.removeAttribute(attr.name);
      }
    }
    return clone.innerHTML.replace(/\s+/gu, " ").slice(0, 60_000);
  };

  // ── The dash object ────────────────────────────────────────────────────────────────
  const colors = Array.from(
    { length: boot.colors },
    (_, index) => `var(--dash-chart-${index + 1})`,
  );
  const dash = {
    data(id: string) {
      return read(String(id));
    },
    onData(fn: () => void) {
      if (typeof fn !== "function") return;
      listeners.push(fn);
      try {
        fn();
      } catch (error) {
        fault("onData", error);
      }
    },
    calc(
      id: string,
      spec: {
        inputs?: string[];
        fn: (...args: unknown[]) => unknown;
        title?: string;
        description?: string;
      },
    ) {
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(String(id)) || !spec || typeof spec.fn !== "function") {
        fault(`计算 ${String(id)}`, "dash.calc 需要一个 id 和 fn");
        return;
      }
      calcs.set(id, {
        inputs: Array.isArray(spec.inputs) ? spec.inputs.map(String) : [],
        fn: spec.fn,
        title: String(spec.title ?? id),
        description: String(spec.description ?? ""),
        stamp: "",
        snapshot: { ...empty("loading"), data: null },
      });
      for (const input of calcs.get(id)!.inputs) if (sources.has(input)) markUsed(input);
      reportCalcs();
    },
    loader(id: string, spec: { description?: string; fn: (input: unknown) => unknown }) {
      if (!sources.has(id) || !spec || typeof spec.fn !== "function") {
        fault(`转换 ${String(id)}`, "dash.loader 需要一个已有的数据来源和 fn");
        return;
      }
      loaders.set(id, { description: String(spec.description ?? ""), fn: spec.fn });
      post("loaders", {
        loaders: [...loaders.entries()].map(([key, entry]) => ({
          id: key,
          description: entry.description,
          code: String(entry.fn).slice(0, 20_000),
        })),
      });
    },
    draw(name: string, spec?: DrawSpec) {
      if (spec === undefined) {
        for (const el of root.querySelectorAll(`[data-draw="${CSS.escape(String(name))}"]`))
          if (visible(el)) runDraw(name, el);
        return;
      }
      draws.set(String(name), spec);
      if (booted) schedule();
    },
    colors,
    refresh(id: string) {
      if (running) {
        fault("dash.refresh", "不要在绘制里调用 dash.refresh");
        return;
      }
      if (sources.has(id)) post("refresh", { id });
    },
    params() {
      return { ...params };
    },
    setParams(next: Record<string, unknown>) {
      if (!next || typeof next !== "object") return;
      params = { ...params, ...next };
      post("setParams", { params: next });
      schedule();
    },
    resetParams() {
      params = { ...boot.params };
      post("resetParams");
      schedule();
    },
    setLink(name: string) {
      post("link", { name: String(name).slice(0, 120) });
    },
  };
  win.dash = dash;

  // ── Mount ──────────────────────────────────────────────────────────────────────────
  const scripts: Array<{ code: string; name: string }> = [];
  const scriptOuter: string[] = [];
  const prepare = (html: string, live: boolean) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    const content = template.content;
    for (const el of content.querySelectorAll(
      "iframe,object,embed,base,form,frame,frameset,portal",
    ))
      el.remove();
    for (const el of content.querySelectorAll("meta[http-equiv]")) el.remove();
    for (const el of content.querySelectorAll("*")) {
      for (const attr of [...el.attributes])
        if (/^on/iu.test(attr.name)) el.removeAttribute(attr.name);
    }
    for (const link of live ? content.querySelectorAll("link") : []) {
      const href = link.getAttribute("href") ?? "";
      const file = boot.files[href];
      if (/stylesheet/iu.test(link.getAttribute("rel") ?? "") && file !== undefined) {
        const style = document.createElement("style");
        style.setAttribute("data-dash-file", href);
        style.textContent = file;
        link.replaceWith(style);
      } else link.remove();
    }
    let index = 0;
    for (const script of content.querySelectorAll("script")) {
      const src = script.getAttribute("src");
      const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
      const runnable = !type || type === "text/javascript" || type === "application/javascript";
      if (!live) {
        const marker = document.createElement("template");
        marker.setAttribute("data-dash-script", String(scriptOuter.length));
        scriptOuter.push(script.outerHTML);
        script.replaceWith(marker);
        continue;
      }
      if (type === "module" || (src && boot.files[src] === undefined)) {
        script.remove();
        continue;
      }
      if (!runnable) continue;
      index += 1;
      scripts.push({
        code: src ? boot.files[src]! : (script.textContent ?? ""),
        name: src ?? `脚本 ${index}`,
      });
      script.remove();
    }
    return content;
  };
  let booted = false;
  let editing = false;
  let edits = 0;
  const html = boot.files[boot.page] ?? "";
  if (boot.edit) {
    editing = true;
    document.documentElement.setAttribute("data-dash-edit", "");
    root.replaceChildren(prepare(html, false));
    root.setAttribute("data-dash-one-writer", "");
    for (const el of root.querySelectorAll("[data-draw]")) {
      el.setAttribute("contenteditable", "false");
      el.setAttribute("data-dash-locked", "");
    }
    root.setAttribute("contenteditable", "true");
    root.addEventListener("input", () => {
      edits += 1;
      post("edited", { count: edits });
    });
    post("boot");
  } else {
    root.replaceChildren(prepare(html, true));
    if (/<meta\s+name=["']?dash-one-writer/iu.test(html))
      root.setAttribute("data-dash-one-writer", "");
    for (const script of scripts) {
      try {
        // Each script runs in its own scope, after the page is in place.
        new Function(script.code)();
      } catch (error) {
        fault(script.name, error);
      }
    }
    booted = true;
    observer.observe(root);
    render();
    post("boot");
    // A share link has no host: its data travels in the document.
    if (boot.inline)
      queueMicrotask(() => {
        for (const [id, data] of Object.entries(boot.inline!)) applyData({ id, ...data });
      });
  }

  // ── Picking, comments, selection ───────────────────────────────────────────────────
  let pick = false;
  let commenting = false;
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const labelOf = (el: Element) => {
    const heading = el.querySelector("h1,h2,h3,h4,.title,[class*=label]")?.textContent?.trim();
    const own = (heading || el.textContent || "").trim().replace(/\s+/gu, " ").slice(0, 40);
    return own ? `#${el.id} · ${own}` : `#${el.id}`;
  };
  document.addEventListener(
    "click",
    (event: FrameClass<"MouseEvent">) => {
      const target = event.target as Element | null;
      if (!target || editing) return;
      if (commenting) {
        const anchor = target.closest("#dash-root [id]");
        event.preventDefault();
        event.stopPropagation();
        if (anchor && anchor !== root)
          post("anchor", { id: anchor.id, label: labelOf(anchor), rect: rectOf(anchor) });
        return;
      }
      if (!pick) return;
      const mark = target.closest("[data-source]");
      if (!mark) return;
      event.preventDefault();
      event.stopPropagation();
      const id = idsOf(mark)[0]!;
      const snap = read(id);
      const hit = isRows(snap.data) ? rowFor(mark, snap.data) : null;
      post("pick", {
        source: id,
        field: mark.getAttribute("data-field"),
        row: hit ? hit.index : null,
        text: (mark.textContent ?? "").trim().slice(0, 80),
      });
    },
    true,
  );
  // In comment mode only the element a comment would pin to is outlined.
  let hovered: Element | null = null;
  document.addEventListener("pointerover", (event: FrameClass<"PointerEvent">) => {
    if (!commenting) return;
    const next = (event.target as Element | null)?.closest("#dash-root [id]") ?? null;
    if (next === hovered) return;
    hovered?.removeAttribute("data-dash-hover");
    hovered = next && next !== root ? next : null;
    hovered?.setAttribute("data-dash-hover", "");
  });
  document.addEventListener("mouseup", () => {
    if (editing || commenting) return;
    const selection = document.getSelection();
    const textValue = selection?.toString().trim() ?? "";
    const at = selection?.anchorNode?.parentElement?.closest("#dash-root [id]")?.id ?? null;
    post("selection", { text: textValue.slice(0, 1_000), at });
  });
  let rectIds: string[] = [];
  const sendRects = () => {
    if (rectIds.length === 0) return;
    const rects: Record<string, unknown> = {};
    for (const id of rectIds) {
      const el = document.getElementById(id);
      if (el && root.contains(el)) rects[id] = rectOf(el);
    }
    post("rects", { rects });
  };
  window.addEventListener("scroll", sendRects, { passive: true });
  window.addEventListener("resize", sendRects);

  // ── Host messages ──────────────────────────────────────────────────────────────────
  const applyData = (message: Record<string, unknown>) => {
    const id = String(message.id);
    const source = sources.get(id);
    if (!source) return;
    const status = String(message.status);
    source.refreshing = message.refreshing === true;
    source.meta = Array.isArray(message.meta) ? (message.meta as Snapshot["meta"]) : [];
    source.message = typeof message.message === "string" ? message.message : "";
    if (status === "loading" && source.status === "ok") {
      source.refreshing = true;
      schedule();
      return;
    }
    const finish = (rows: unknown) => {
      if (isRows(rows)) {
        source.data = rows;
        source.columns =
          Array.isArray(message.columns) && !loaders.has(id)
            ? (message.columns as string[])
            : columnsOf(rows);
      } else {
        source.data = rows === undefined ? [] : rows;
        source.columns = [];
      }
      source.status = "ok";
      source.version += 1;
      schedule();
    };
    if (status !== "ok") {
      source.status = status;
      if (status !== "loading") {
        source.data = [];
        source.columns = [];
      }
      source.version += 1;
      schedule();
      return;
    }
    const loader = loaders.get(id);
    const rows = message.rows;
    if (loader) {
      const answer = "answer" in message ? message.answer : (message.value ?? rows);
      const callTool = (tool: unknown, args: unknown) => askHost(id, String(tool), args);
      Promise.resolve()
        .then(() => loader.fn({ answer, args: message.args ?? {}, call: callTool, read: readers }))
        .then((out) => {
          const value = out as Record<string, unknown> | Row[];
          if (isRows(value)) return finish(value);
          if (
            value &&
            typeof value === "object" &&
            Array.isArray((value as Record<string, unknown>).rows)
          )
            return finish((value as Record<string, unknown>).rows);
          if (value && typeof value === "object" && "data" in value)
            return finish((value as Record<string, unknown>).data);
          finish(value);
        })
        .catch((error) => {
          fault(`转换 ${id}`, error);
          source.status = "error";
          source.message = error instanceof Error ? error.message : String(error);
          source.version += 1;
          schedule();
        });
      return;
    }
    finish(rows !== undefined ? rows : message.value);
  };
  // ── A loader's further calls (next page, a running query) go through the host ──────
  const pendingCalls = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let callSeq = 0;
  const askHost = (id: string, tool: string, args: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (callSeq >= 50) return reject(new Error("一次载入里的调用太多了"));
      callSeq += 1;
      const ref = `${id}:${callSeq}`;
      pendingCalls.set(ref, { resolve, reject });
      post("call", { ref, id, tool, args: args && typeof args === "object" ? args : {} });
      window.setTimeout(() => {
        if (pendingCalls.delete(ref)) reject(new Error("调用太久没有结果"));
      }, 130_000);
    });
  type Parsed = {
    data: Row[];
    columns: string[];
    cut: boolean;
    meta: Array<{ label: string; value: string }>;
  };
  const typed = (value: unknown, type: string) => {
    if (value === null || value === undefined) return null;
    const t = type.toUpperCase();
    if (/^(INT|INTEGER|INT64|BIGINT|SMALLINT|TINYINT|LONG|SHORT|BYTE)$/u.test(t)) {
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : String(value);
    }
    if (/^(FLOAT|FLOAT64|DOUBLE|REAL|NUMERIC|DECIMAL|BIGNUMERIC|FIXED|NUMBER)/u.test(t)) {
      const n = Number(value);
      return Number.isFinite(n) && String(value).replace(/^-/u, "").replace(".", "").length <= 15
        ? n
        : String(value);
    }
    if (/^(BOOL|BOOLEAN)$/u.test(t)) return value === true || value === "true";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  };
  const failIn = (answer: unknown) => {
    const error =
      answer && typeof answer === "object" ? (answer as Record<string, unknown>).error : undefined;
    if (error)
      throw new Error(
        typeof error === "string"
          ? error
          : String((error as Record<string, unknown>).message ?? "查询出错了"),
      );
  };
  const readers = {
    // BigQuery jobs.query / getQueryResults: schema.fields + rows[].f[].v
    async bigquery(answer: Record<string, unknown>): Promise<Parsed> {
      failIn(answer);
      const fields = ((answer?.schema as Record<string, unknown>)?.fields ?? []) as Array<{
        name: string;
        type: string;
      }>;
      const raw = (answer?.rows ?? []) as Array<{ f: Array<{ v: unknown }> }>;
      const data = raw.map((row) =>
        Object.fromEntries(
          fields.map((field, i) => [field.name, typed(row.f?.[i]?.v, field.type)]),
        ),
      );
      const total = Number(answer?.totalRows ?? data.length);
      return {
        data,
        columns: fields.map((f) => f.name),
        cut: Boolean(answer?.pageToken) || total > data.length || answer?.jobComplete === false,
        meta: answer?.jobReference
          ? [{ label: "job", value: JSON.stringify(answer.jobReference) }]
          : [],
      };
    },
    // Snowflake SQL API: resultSetMetaData.rowType + data[][]
    async snowflake(answer: Record<string, unknown>): Promise<Parsed> {
      failIn(answer);
      const set = (answer?.result_set ?? answer) as Record<string, unknown>;
      const rowType = ((set?.resultSetMetaData as Record<string, unknown>)?.rowType ??
        []) as Array<{ name: string; type: string }>;
      const raw = (set?.data ?? []) as unknown[][];
      const data = raw.map((row) =>
        Object.fromEntries(
          rowType.map((col, i) => [
            col.name,
            row[i] === null
              ? /text|varchar|string/iu.test(col.type)
                ? ""
                : null
              : typed(row[i], col.type),
          ]),
        ),
      );
      const total = Number(
        (set?.resultSetMetaData as Record<string, unknown>)?.numRows ?? data.length,
      );
      return {
        data,
        columns: rowType.map((c) => c.name),
        cut: total > data.length,
        meta: set?.statementHandle
          ? [{ label: "statement", value: String(set.statementHandle) }]
          : [],
      };
    },
    // Databricks statement execution: manifest.schema.columns + result.data_array
    async databricks(answer: Record<string, unknown>): Promise<Parsed> {
      failIn(answer);
      const state = String((answer?.status as Record<string, unknown>)?.state ?? "SUCCEEDED");
      if (state === "FAILED" || state === "CANCELED")
        throw new Error(
          String(
            ((answer?.status as Record<string, unknown>)?.error as Record<string, unknown>)
              ?.message ?? `查询${state === "FAILED" ? "失败" : "已取消"}`,
          ),
        );
      const manifest = (answer?.manifest ?? {}) as Record<string, unknown>;
      const cols = ((manifest.schema as Record<string, unknown>)?.columns ?? []) as Array<{
        name: string;
        type_name: string;
      }>;
      const raw = ((answer?.result as Record<string, unknown>)?.data_array ?? []) as unknown[][];
      const data = raw.map((row) =>
        Object.fromEntries(cols.map((col, i) => [col.name, typed(row[i], col.type_name)])),
      );
      return {
        data,
        columns: cols.map((c) => c.name),
        cut: manifest.truncated === true || state === "PENDING" || state === "RUNNING",
        meta: answer?.statement_id
          ? [{ label: "statement", value: String(answer.statement_id) }]
          : [],
      };
    },
  };

  window.addEventListener("message", (event: FrameClass<"MessageEvent">) => {
    if (event.source !== window.parent) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || message.protocol !== boot.protocol || message.nonce !== boot.nonce) return;
    switch (message.kind) {
      case "data":
        applyData(message);
        break;
      case "callResult": {
        const pending = pendingCalls.get(String(message.ref));
        if (!pending) break;
        pendingCalls.delete(String(message.ref));
        if (typeof message.error === "string") pending.reject(new Error(message.error));
        else pending.resolve(message.answer);
        break;
      }
      case "params":
        params = { ...(message.params as Record<string, unknown>) };
        schedule();
        break;
      case "mode":
        pick = message.pick === true;
        commenting = message.comment === true;
        if (!commenting) {
          hovered?.removeAttribute("data-dash-hover");
          hovered = null;
        }
        document.documentElement.toggleAttribute("data-dash-pick", pick);
        document.documentElement.toggleAttribute("data-dash-comment", commenting);
        break;
      case "light": {
        for (const el of root.querySelectorAll("[data-dash-lit]"))
          el.removeAttribute("data-dash-lit");
        const source = typeof message.source === "string" ? message.source : null;
        if (!source) break;
        const snap = read(source);
        for (const el of root.querySelectorAll("[data-source]")) {
          if (!idsOf(el).includes(source)) continue;
          if (typeof message.field === "string" && el.getAttribute("data-field") !== message.field)
            continue;
          if (typeof message.row === "number" && isRows(snap.data)) {
            const hit = rowFor(el, snap.data);
            if (hit && hit.index !== message.row) continue;
          }
          el.setAttribute("data-dash-lit", "");
        }
        root.querySelector("[data-dash-lit]")?.scrollIntoView({ block: "nearest" });
        break;
      }
      case "rects":
        rectIds = Array.isArray(message.ids) ? (message.ids as string[]).slice(0, 200) : [];
        sendRects();
        break;
      case "theme": {
        const style = document.getElementById("dash-tokens");
        if (style) style.textContent = String(message.css ?? "");
        schedule();
        break;
      }
      case "editCommand":
        if (editing) document.execCommand(message.command === "redo" ? "redo" : "undo");
        break;
      case "serialize": {
        if (!editing) break;
        const clone = root.cloneNode(true) as HTMLElement;
        clone.removeAttribute("contenteditable");
        for (const el of clone.querySelectorAll("[data-dash-locked]")) {
          el.removeAttribute("data-dash-locked");
          el.removeAttribute("contenteditable");
        }
        let out = clone.innerHTML;
        out = out.replace(
          /<template data-dash-script="(\d+)"><\/template>/gu,
          (_: string, n: string) => scriptOuter[Number(n)] ?? "",
        );
        post("serialized", { html: out });
        break;
      }
    }
  });
}

const escapeScript = (code: string) => code.replace(/<\/script/giu, "<\\/script");

/** The whole document for one dashboard view. `d3` is Moss's local d3 7.9.0 source text. */
export function buildDashboardFrameDocument(input: {
  readonly nonce: string;
  readonly item: DashboardItem;
  readonly d3: string;
  readonly mode: "light" | "dark";
  readonly params: Readonly<Record<string, unknown>>;
  readonly edit?: boolean;
  /** A style being tweaked, shown before it is saved. */
  readonly look?: DashboardLook;
  /** Load d3 from this address instead of inlining `d3` (share links). */
  readonly d3Src?: string;
  readonly inline?: DashboardFrameBoot["inline"];
  /** Follow the viewer's light/dark setting (share links) instead of a fixed mode. */
  readonly bothModes?: boolean;
}): string {
  const look = input.look ?? input.item.look;
  const boot: DashboardFrameBoot = {
    nonce: input.nonce,
    protocol: DASHBOARD_FRAME_PROTOCOL,
    files: Object.fromEntries(
      Object.entries(input.item.files).map(([name, file]) => [name, file.text]),
    ),
    page: "index.html",
    datasets: Object.keys(input.item.datasets),
    params: input.params,
    colors: dashboardPalette(look, input.mode).charts.length,
    edit: input.edit === true,
    ...(input.inline ? { inline: input.inline } : {}),
  };
  const d3Tag = input.d3Src
    ? `<script src="${input.d3Src.replace(/"/gu, "")}"></script>`
    : `<script>${escapeScript(input.d3)}</script>`;
  const lang = input.item.meta.lang ?? "zh-CN";
  return `<!doctype html><html lang="${lang.replace(/[^A-Za-z0-9-]/gu, "")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="dash-tokens">${input.bothModes ? `${dashboardThemeCss(input.item, look, "light")}@media (prefers-color-scheme: dark){${dashboardThemeCss(input.item, look, "dark")}}` : dashboardThemeCss(input.item, look, input.mode)}</style><style>${BASE_CSS}</style>${d3Tag}</head><body><div id="dash-root"></div><script>(${escapeScript(String(mossDashboardRuntime))})(${escapeScript(JSON.stringify(boot))});</script></body></html>`;
}

/**
 * A share link's copy of a dashboard: the page with its files' rows inlined and live queries
 * marked as the owner's (a guest has no access to them). d3 comes from the address the
 * read-only host allows.
 */
export function buildDashboardSnapshotDocument(item: DashboardItem, d3Src: string): string {
  const inline: Record<string, Record<string, unknown>> = {};
  for (const [id, dataset] of Object.entries(item.datasets)) {
    if (dataset.source.kind === "file" && dataset.source.library) {
      inline[id] = { status: "connect", message: "这个文件放在所有者的资料库里，分享页里看不到。" };
    } else if (dataset.source.kind === "file") {
      try {
        const read = readDatasetFile(dataset.source);
        inline[id] = {
          status: "ok",
          rows: read.rows,
          columns: read.columns,
          ...(read.value !== undefined ? { value: read.value } : {}),
          answer: dataset.source.text,
        };
      } catch (error) {
        inline[id] = {
          status: "error",
          message: error instanceof Error ? error.message : "文件读不出来",
        };
      }
    } else {
      inline[id] = { status: "connect", message: "这项数据来自所有者的连接，分享页里看不到。" };
    }
  }
  const { draft: _draft, ...stored } = item;
  return buildDashboardFrameDocument({
    nonce: "share-link-snapshot-0000",
    item: stored,
    d3: "",
    d3Src,
    mode: "light",
    bothModes: true,
    params: item.params,
    inline,
  });
}
