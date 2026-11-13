// FILE: dashboard.ts
// Purpose: The 数据看板 (data dashboard) payload: where its numbers come from (datasets) and the
//          page that draws them (files), plus filter defaults, the refresh window and the look.
//          Validation, store-style writes (set / update / delete by path), reading an attached
//          file into rows, filling a live query's {{filter}} blanks against its rules, a static
//          check of the page, and the text projection kept as the page content.
// Layer: Shared model (server validates agent writes with it; the web host and frame read it)
// Exports: DashboardItem and its parts, parseDashboard, createDashboard, applyDashboardWrites,
//          readDatasetFile, fillCallArgs, checkRuleValue, checkDashboard, projectDashboard,
//          rowsToCsv, DASHBOARD_LOOKS, DASHBOARD_UPDATE_CHOICES, isDashboardPayload
// Spec: docs/design/data-claude-teardown.md

import {
  BUILT_IN_DESIGN_SYSTEMS,
  findBuiltInDesignSystem,
  parseDesignSystemTokens,
  type DesignSystemTokens,
} from "./designSystems";

/** Re-exported so the dashboard host reads design systems through one module. */
export { BUILT_IN_DESIGN_SYSTEMS, findBuiltInDesignSystem, parseDesignSystemTokens };
export type { DesignSystemTokens };

export const DASHBOARD_FORMS = [
  "dashboard",
  "visual-analysis",
  "scroll-story",
  "visual-short",
] as const;
export type DashboardForm = (typeof DASHBOARD_FORMS)[number];

/** How old a loaded answer may be when someone opens the dashboard. */
export const DASHBOARD_UPDATE_CHOICES = ["viewed", "5min", "hour", "day", "week"] as const;
export type DashboardUpdates = (typeof DASHBOARD_UPDATE_CHOICES)[number] | number;

export type DashboardParamValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean>;

export interface DashboardRule {
  readonly type?: "string" | "number" | "integer" | "boolean" | "array";
  readonly enum?: ReadonlyArray<string | number | boolean>;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: DashboardRule;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export type DashboardFileFormat = "csv" | "tsv" | "json" | "text";

export interface DashboardFileSource {
  readonly kind: "file";
  readonly name: string;
  readonly format?: DashboardFileFormat;
  /** The file's text, kept with the dashboard (small files). */
  readonly text: string;
  /** A larger file kept in the 资料库; the server reads it by id. `text` is then empty. */
  readonly library?: { readonly itemId: string; readonly size: number };
}

/** The largest file a dashboard reads from the 资料库. */
export const DASHBOARD_LIBRARY_FILE_MAX_BYTES = 15 * 1024 * 1024;
/** Files up to this size travel inside the dashboard; larger ones go to the 资料库. */
export const DASHBOARD_INLINE_FILE_MAX_BYTES = 1_500_000;

export interface DashboardCallSource {
  readonly kind: "call";
  /** The connector as the person added it in Moss (a Moss 应用 or a Settings connector). */
  readonly connector: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly rules?: Readonly<Record<string, DashboardRule>>;
}

export type DashboardSource = DashboardFileSource | DashboardCallSource;

export interface DashboardEdit {
  readonly via: "moss" | "person";
  readonly at: string;
}

export interface DashboardDataset {
  readonly title: string;
  readonly description?: string;
  readonly source: DashboardSource;
  /** Language of each argument that is code (`{query: "sql"}`). */
  readonly langs?: Readonly<Record<string, string>>;
  readonly updated?: { readonly at: string; readonly by: string };
  readonly schedule?: string;
  readonly staleAfterHours?: number;
  readonly fixed?: boolean;
  readonly edit?: DashboardEdit;
  /** Arguments a person saved earlier for a live query, newest first (restore puts them back). */
  readonly saved?: ReadonlyArray<{
    readonly at: string;
    readonly args: Readonly<Record<string, unknown>>;
  }>;
}

export interface DashboardPalette {
  readonly ground: string;
  readonly card: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly good: string;
  readonly warning: string;
  readonly bad: string;
  readonly charts: readonly string[];
}

export const DASHBOARD_FONTS = ["sans", "serif", "mono"] as const;
export type DashboardFont = (typeof DASHBOARD_FONTS)[number];

export interface DashboardLook {
  readonly name: string;
  readonly light: DashboardPalette;
  readonly dark: DashboardPalette;
  /** Style tweaks a person made on top of a look. */
  readonly font?: DashboardFont;
  /** Body text size in px (12-18). */
  readonly size?: number;
  readonly tweaked?: boolean;
  /** A design system's own font stack (wins over `font`). */
  readonly fontStack?: string;
  /** Card corner radius in px from a design system. */
  readonly radius?: number;
}

/**
 * The design system a dashboard wears: a copy of its tokens, so the dashboard renders the same
 * after the system changes (same shape as a 设计 item's DesignSystemRef, without components).
 * `source` is `builtin:<id>` or `page:<pageId>`.
 */
export interface DashboardSystemRef {
  readonly source: string;
  readonly name: string;
  readonly tokens: DesignSystemTokens;
  readonly copiedAt: string;
}

/**
 * A remix in another shape, written beside the dashboard. It changes nothing until 保存
 * copies it over; 取消 drops it.
 */
export interface DashboardDraft {
  readonly shape: DashboardForm;
  readonly at: string;
  readonly files: Readonly<Record<string, DashboardFile>>;
  /** New sources, or sources whose call changes; every other source is the dashboard's own. */
  readonly datasets: Readonly<Record<string, DashboardDataset>>;
  /** Replaces all filter defaults when given. */
  readonly params?: Readonly<Record<string, DashboardParamValue>>;
}

export interface DashboardFile {
  readonly text: string;
  readonly edit?: DashboardEdit;
}

export interface DashboardItem {
  readonly version: 2;
  readonly form: "dashboard";
  readonly meta: { readonly title: string; readonly lang?: string; readonly shape?: DashboardForm };
  readonly params: Readonly<Record<string, DashboardParamValue>>;
  readonly settings: { readonly updates: DashboardUpdates };
  readonly look?: DashboardLook;
  readonly datasets: Readonly<Record<string, DashboardDataset>>;
  readonly files: Readonly<Record<string, DashboardFile>>;
  readonly draft?: DashboardDraft;
  readonly system?: DashboardSystemRef;
}

export const DASHBOARD_PAGE_FILE = "index.html";
export const DASHBOARD_MAX_BYTES = 2_000_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const COLOR =
  /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|(rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/+-]+\))$/u;
const FONT_STACK = /^[A-Za-z0-9 ,"'\-一-鿿]{1,200}$/u;
const SYSTEM_SOURCE = /^(builtin:[a-z0-9][a-z0-9-]{0,39}|page:[A-Za-z0-9_-]{1,128})$/u;
const BLANK = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function fail(message: string): never {
  throw new Error(`Invalid dashboard: ${message}`);
}
const text = (value: unknown, what: string, max: number, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length > max)
    fail(`${what} must be text of at most ${max} characters`);
  return value;
};

/** True when a stored `app` payload is a 数据看板 rather than a v1 应用页. */
export function isDashboardPayload(input: string | unknown): boolean {
  try {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    return isRecord(value) && value.version === 2 && value.form === "dashboard";
  } catch {
    return false;
  }
}

function parseRule(value: unknown, where: string, depth = 0): DashboardRule {
  if (!isRecord(value) || depth > 1) fail(`rule ${where} must be an object`);
  const allowed = [
    "type",
    "enum",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "items",
    "minItems",
    "maxItems",
  ];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`rule ${where} uses an unknown word "${key}"`);
  }
  const rule: Record<string, unknown> = {};
  if (value.type !== undefined) {
    if (!["string", "number", "integer", "boolean", "array"].includes(value.type as string))
      fail(`rule ${where} has an unknown type`);
    rule.type = value.type;
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 500)
      fail(`rule ${where}.enum must list 1-500 values`);
    for (const entry of value.enum)
      if (!["string", "number", "boolean"].includes(typeof entry))
        fail(`rule ${where}.enum holds a value that is not text, a number or true/false`);
    rule.enum = value.enum;
  }
  if (value.pattern !== undefined) {
    const pattern = text(value.pattern, `rule ${where}.pattern`, 500)!;
    try {
      new RegExp(pattern, "u");
    } catch {
      fail(`rule ${where}.pattern is not a valid pattern`);
    }
    rule.pattern = pattern;
  }
  for (const key of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]))
      fail(`rule ${where}.${key} must be a number`);
    rule[key] = value[key];
  }
  if (value.items !== undefined) rule.items = parseRule(value.items, `${where}.items`, depth + 1);
  return rule as DashboardRule;
}

function parseSource(value: unknown, where: string): DashboardSource {
  if (!isRecord(value)) fail(`${where}.source must be an object`);
  if (value.kind === "file") {
    const name = text(value.name, `${where}.source.name`, 200)!;
    if (
      value.format !== undefined &&
      !["csv", "tsv", "json", "text"].includes(value.format as string)
    )
      fail(`${where}.source.format must be csv, tsv, json or text`);
    let library: DashboardFileSource["library"];
    if (value.library !== undefined) {
      if (
        !isRecord(value.library) ||
        typeof value.library.itemId !== "string" ||
        !value.library.itemId.trim()
      )
        fail(`${where}.source.library must be {itemId, size}`);
      const size = Number(value.library.size ?? 0);
      if (!Number.isFinite(size) || size < 0 || size > DASHBOARD_LIBRARY_FILE_MAX_BYTES)
        fail(`${where}.source.library.size must be at most 15 MB`);
      library = { itemId: value.library.itemId.slice(0, 200), size };
    }
    return {
      kind: "file",
      name,
      ...(value.format ? { format: value.format as DashboardFileFormat } : {}),
      text:
        library && value.text === undefined
          ? ""
          : text(value.text, `${where}.source.text`, DASHBOARD_MAX_BYTES)!,
      ...(library ? { library } : {}),
    };
  }
  if (value.kind === "call") {
    if (!isRecord(value.args)) fail(`${where}.source.args must be an object`);
    if (JSON.stringify(value.args).length > 64_000)
      fail(`${where}.source.args are longer than 64 KB`);
    let rules: Record<string, DashboardRule> | undefined;
    if (value.rules !== undefined) {
      if (!isRecord(value.rules)) fail(`${where}.source.rules must be an object`);
      rules = {};
      for (const [name, rule] of Object.entries(value.rules)) {
        if (!PARAM_NAME.test(name)) fail(`${where}.source.rules has a bad filter name "${name}"`);
        rules[name] = parseRule(rule, `${where}.rules.${name}`);
      }
    }
    return {
      kind: "call",
      connector: text(value.connector, `${where}.source.connector`, 200)!,
      tool: text(value.tool, `${where}.source.tool`, 200)!,
      args: value.args,
      ...(rules ? { rules } : {}),
    };
  }
  return fail(`${where}.source.kind must be "file" or "call"`);
}

function parseEdit(value: unknown): DashboardEdit | undefined {
  if (!isRecord(value)) return undefined;
  const via =
    value.via === "moss" || value.via === "claude" || value.via === "agent" ? "moss" : "person";
  return {
    via,
    at: typeof value.at === "string" ? value.at.slice(0, 40) : new Date(0).toISOString(),
  };
}

function parseDataset(value: unknown, id: string): DashboardDataset {
  const where = `datasets/${id}`;
  if (!isRecord(value)) fail(`${where} must be an object`);
  const dataset: Record<string, unknown> = {
    title: text(value.title, `${where}.title`, 200)!,
    source: parseSource(value.source, where),
  };
  const description = text(value.description, `${where}.description`, 1_000, true);
  if (description !== undefined) dataset.description = description;
  if (value.langs !== undefined) {
    if (!isRecord(value.langs)) fail(`${where}.langs must be an object`);
    dataset.langs = Object.fromEntries(
      Object.entries(value.langs).map(([k, v]) => [k, String(v).slice(0, 40)]),
    );
  }
  if (isRecord(value.updated) && typeof value.updated.at === "string")
    dataset.updated = {
      at: value.updated.at.slice(0, 40),
      by: String(value.updated.by ?? "").slice(0, 80),
    };
  const schedule = text(value.schedule, `${where}.schedule`, 500, true);
  if (schedule !== undefined) dataset.schedule = schedule;
  if (typeof value.staleAfterHours === "number" && value.staleAfterHours > 0)
    dataset.staleAfterHours = value.staleAfterHours;
  if (value.fixed === true) dataset.fixed = true;
  const edit = parseEdit(value.edit);
  if (edit) dataset.edit = edit;
  if (Array.isArray(value.saved)) {
    dataset.saved = value.saved
      .filter(
        (entry): entry is { at: string; args: Record<string, unknown> } =>
          isRecord(entry) && typeof entry.at === "string" && isRecord(entry.args),
      )
      .slice(0, 5)
      .map((entry) => ({ at: entry.at.slice(0, 40), args: entry.args }));
  }
  return dataset as unknown as DashboardDataset;
}

function parseParamValue(value: unknown, name: string): DashboardParamValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "string" && (value.length > 2_000 || /[\r\n]/u.test(value)))
      fail(`params.${name} must be one line of text`);
    return value as DashboardParamValue;
  }
  if (
    Array.isArray(value) &&
    value.length <= 500 &&
    value.every((entry) => ["string", "number", "boolean"].includes(typeof entry))
  )
    return value as DashboardParamValue;
  return fail(`params.${name} must be text, a number, true/false, null or a list of those`);
}

function parsePalette(value: unknown, where: string): DashboardPalette {
  if (!isRecord(value)) fail(`${where} must be an object`);
  const color = (key: string) => {
    const v = value[key];
    if (typeof v !== "string" || !COLOR.test(v)) fail(`${where}.${key} must be a #rrggbb colour`);
    return v;
  };
  if (!Array.isArray(value.charts) || value.charts.length < 1 || value.charts.length > 12)
    fail(`${where}.charts must list 1-12 colours`);
  return {
    ground: color("ground"),
    card: color("card"),
    text: color("text"),
    muted: color("muted"),
    border: color("border"),
    good: color("good"),
    warning: color("warning"),
    bad: color("bad"),
    charts: value.charts.map((entry, index) => {
      if (typeof entry !== "string" || !COLOR.test(entry))
        fail(`${where}.charts[${index}] must be a #rrggbb colour`);
      return entry;
    }),
  };
}

function parseUpdates(value: unknown): DashboardUpdates {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1)
    return Math.min(Math.round(value), 60 * 24 * 7);
  return (DASHBOARD_UPDATE_CHOICES as readonly unknown[]).includes(value)
    ? (value as DashboardUpdates)
    : "viewed";
}

export function parseDashboard(input: string | unknown): DashboardItem {
  if (typeof input === "string" && input.length > DASHBOARD_MAX_BYTES) fail("larger than 2 MB");
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (!isRecord(value)) fail("expected an object");
  if (value.version !== 2 || value.form !== "dashboard")
    fail('version must be 2 and form "dashboard"');
  const meta = isRecord(value.meta) ? value.meta : {};
  const datasets = parseDatasets(value.datasets, "datasets");
  const files = parseFiles(value.files, "files");
  const params = parseParams(value.params, "params");
  const settings = isRecord(value.settings) ? value.settings : {};
  let look: DashboardLook | undefined;
  if (value.look !== undefined && value.look !== null) {
    if (!isRecord(value.look)) fail("look must be an object");
    const size = value.look.size;
    look = {
      name: text(value.look.name, "look.name", 60)!,
      light: parsePalette(value.look.light, "look.light"),
      dark: parsePalette(value.look.dark, "look.dark"),
      ...((DASHBOARD_FONTS as readonly unknown[]).includes(value.look.font)
        ? { font: value.look.font as DashboardFont }
        : {}),
      ...(typeof size === "number" && size >= 12 && size <= 18 ? { size: Math.round(size) } : {}),
      ...(value.look.tweaked === true ? { tweaked: true } : {}),
      ...(typeof value.look.fontStack === "string" && FONT_STACK.test(value.look.fontStack)
        ? { fontStack: value.look.fontStack }
        : {}),
      ...(typeof value.look.radius === "number" && value.look.radius >= 0 && value.look.radius <= 40
        ? { radius: Math.round(value.look.radius) }
        : {}),
    };
  }
  let system: DashboardSystemRef | undefined;
  if (value.system !== undefined && value.system !== null) {
    if (!isRecord(value.system)) fail("system must be an object");
    const source = text(value.system.source, "system.source", 140)!;
    if (!SYSTEM_SOURCE.test(source))
      fail('system.source must be "builtin:<id>" or "page:<pageId>"');
    system = {
      source,
      name: text(value.system.name, "system.name", 120)!,
      tokens: parseDesignSystemTokens(value.system.tokens),
      copiedAt:
        typeof value.system.copiedAt === "string"
          ? value.system.copiedAt.slice(0, 40)
          : new Date(0).toISOString(),
    };
  }
  let draft: DashboardDraft | undefined;
  if (value.draft !== undefined && value.draft !== null) {
    if (!isRecord(value.draft)) fail("draft must be an object");
    const draftShape = (DASHBOARD_FORMS as readonly unknown[]).includes(value.draft.shape)
      ? (value.draft.shape as DashboardForm)
      : "dashboard";
    draft = {
      shape: draftShape,
      at:
        typeof value.draft.at === "string"
          ? value.draft.at.slice(0, 40)
          : new Date(0).toISOString(),
      files: parseFiles(value.draft.files, "draft/files"),
      datasets: parseDatasets(value.draft.datasets, "draft/datasets"),
      ...(value.draft.params !== undefined
        ? { params: parseParams(value.draft.params, "draft/params") }
        : {}),
    };
  }
  const shape = (DASHBOARD_FORMS as readonly unknown[]).includes(meta.shape)
    ? (meta.shape as DashboardForm)
    : undefined;
  return {
    version: 2,
    form: "dashboard",
    meta: {
      title: typeof meta.title === "string" ? meta.title.slice(0, 256) : "",
      ...(typeof meta.lang === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u.test(meta.lang)
        ? { lang: meta.lang }
        : {}),
      ...(shape ? { shape } : {}),
    },
    params,
    settings: { updates: parseUpdates(settings.updates) },
    ...(look ? { look } : {}),
    datasets,
    files,
    ...(draft ? { draft } : {}),
    ...(system ? { system } : {}),
  };
}

// ── Design systems ────────────────────────────────────────────────────────────────────────

const pick = (tokens: DesignSystemTokens, names: readonly string[], mode: "light" | "dark") => {
  for (const name of names) {
    const token = tokens.colors.find((color) => color.name === name);
    if (token) return mode === "dark" ? (token.dark ?? token.light) : token.light;
  }
  return undefined;
};

/**
 * A dashboard look from a design system's tokens, mapped by colour name with fallbacks
 * (paper→page, panel→card, ink→text, ink-muted|ink-secondary→muted, line→border,
 * success / warning / danger). Systems have no chart series, so the first series is the
 * system's accent and the rest come from `fallback`.
 */
export function lookFromDesignSystem(
  name: string,
  tokens: DesignSystemTokens,
  fallback: DashboardLook,
): DashboardLook {
  const palette = (mode: "light" | "dark"): DashboardPalette => {
    const base = fallback[mode];
    const accent = pick(tokens, ["accent", "primary", "brand"], mode);
    return {
      ground: pick(tokens, ["paper", "page", "background", "bg"], mode) ?? base.ground,
      card: pick(tokens, ["panel", "card", "surface", "paper"], mode) ?? base.card,
      text: pick(tokens, ["ink", "text", "foreground"], mode) ?? base.text,
      muted:
        pick(tokens, ["ink-muted", "ink-secondary", "muted", "text-secondary"], mode) ?? base.muted,
      border: pick(tokens, ["line", "border", "divider"], mode) ?? base.border,
      good: pick(tokens, ["success", "good", "positive"], mode) ?? base.good,
      warning: pick(tokens, ["warning", "warn", "caution"], mode) ?? base.warning,
      bad: pick(tokens, ["danger", "error", "bad", "negative"], mode) ?? base.bad,
      charts: accent
        ? [accent, ...base.charts.filter((color) => color !== accent).slice(0, 7)]
        : base.charts,
    };
  };
  const body =
    tokens.text.find((style) => style.name === "body") ??
    tokens.text.find((style) => style.name === "prose");
  const radius =
    tokens.radius.find((entry) => entry.name === "card")?.value ??
    (tokens.radius.length ? Math.max(...tokens.radius.map((entry) => entry.value)) : undefined);
  const stack = tokens.fonts[body?.family ?? "sans"];
  return {
    name,
    light: palette("light"),
    dark: palette("dark"),
    ...(stack && FONT_STACK.test(stack) ? { fontStack: stack } : {}),
    ...(body && body.size >= 12 && body.size <= 18 ? { size: Math.round(body.size) } : {}),
    ...(radius !== undefined && radius <= 40 ? { radius: Math.round(radius) } : {}),
  };
}

/** Wears a design system: keeps the token copy and derives the look from it. */
export function applyDashboardSystem(
  item: DashboardItem,
  system: DashboardSystemRef | null,
  fallback: DashboardLook,
): DashboardItem {
  const { system: _old, look: _look, ...rest } = item;
  if (!system) return rest;
  return { ...rest, system, look: lookFromDesignSystem(system.name, system.tokens, fallback) };
}

/** A built-in system as a dashboard reference (`builtin:<id>`). */
export function builtInSystemRef(
  id: string,
  copiedAt = new Date().toISOString(),
): DashboardSystemRef | null {
  const found = findBuiltInDesignSystem(id);
  return found
    ? { source: `builtin:${found.id}`, name: found.name, tokens: found.tokens, copiedAt }
    : null;
}

/** The design system a 设计 item's payload carries (`ownSystem`), or null. */
export function storedSystemTokens(payload: string | null): DesignSystemTokens | null {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return isRecord(value) && value.ownSystem ? parseDesignSystemTokens(value.ownSystem) : null;
  } catch {
    return null;
  }
}

function parseDatasets(value: unknown, where: string): Record<string, DashboardDataset> {
  const datasets: Record<string, DashboardDataset> = {};
  if (value === undefined) return datasets;
  if (!isRecord(value)) fail(`${where} must be an object`);
  const ids = Object.keys(value);
  if (ids.length > 100) fail(`at most 100 datasets in ${where}`);
  for (const id of ids) {
    if (!ID.test(id)) fail(`dataset id "${id}" must be 1-64 letters, digits, _ or -`);
    datasets[id] = parseDataset(value[id], id);
  }
  return datasets;
}

function parseFiles(value: unknown, where: string): Record<string, DashboardFile> {
  const files: Record<string, DashboardFile> = {};
  if (value === undefined) return files;
  if (!isRecord(value)) fail(`${where} must be an object`);
  const names = Object.keys(value);
  if (names.length > 40) fail(`at most 40 files in ${where}`);
  for (const name of names) {
    if (!FILE_NAME.test(name) || name.includes(".."))
      fail(`file name "${name}" must be a flat name like index.html`);
    const file = value[name];
    if (!isRecord(file)) fail(`${where}/${name} must be an object`);
    const edit = parseEdit(file.edit);
    files[name] = {
      text: text(file.text, `${where}/${name}.text`, DASHBOARD_MAX_BYTES)!,
      ...(edit ? { edit } : {}),
    };
  }
  return files;
}

function parseParams(value: unknown, where: string): Record<string, DashboardParamValue> {
  const params: Record<string, DashboardParamValue> = {};
  if (value === undefined) return params;
  if (!isRecord(value)) fail(`${where} must be an object`);
  for (const [name, entry] of Object.entries(value)) {
    if (!PARAM_NAME.test(name)) fail(`filter name "${name}" must be letters, digits and _`);
    params[name] = parseParamValue(entry, name);
  }
  return params;
}

/** The dashboard as the draft would make it: its page, its changed sources, its defaults. */
export function dashboardWithDraft(item: DashboardItem): DashboardItem {
  const draft = item.draft;
  if (!draft) return item;
  const { draft: _draft, ...rest } = item;
  return {
    ...rest,
    meta: { ...item.meta, shape: draft.shape },
    files: draft.files,
    datasets: { ...item.datasets, ...draft.datasets },
    params: draft.params ?? item.params,
  };
}

/** 保存: the draft replaces the page (the old page's files go), its sources and defaults land. */
export function saveDashboardDraft(item: DashboardItem): DashboardItem {
  return item.draft ? dashboardWithDraft(item) : item;
}

/** 取消: the draft is dropped; the dashboard stays as it is. */
export function discardDashboardDraft(item: DashboardItem): DashboardItem {
  if (!item.draft) return item;
  const { draft: _draft, ...rest } = item;
  return rest;
}

export function createDashboard(title = ""): DashboardItem {
  return {
    version: 2,
    form: "dashboard",
    meta: { title, lang: "zh-CN" },
    params: {},
    settings: { updates: "viewed" },
    datasets: {},
    files: {},
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────

/** One store-style write. `path` is `meta`, `params`, `settings`, `look`, `datasets/<id>` or `files/<name>`. */
export interface DashboardWrite {
  readonly op: "set" | "update" | "delete";
  readonly path: string;
  readonly data?: unknown;
}

const DELETE_MARK = "__delete__";
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  if (patch[DELETE_MARK] === true) return undefined;
  const out: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    const merged = deepMerge(out[key], value);
    if (merged === undefined) delete out[key];
    else out[key] = merged;
  }
  return out;
}

/** Applies writes in order and validates the result. Throws with a plain reason on a bad write. */
export function applyDashboardWrites(
  item: DashboardItem,
  writes: readonly DashboardWrite[],
): DashboardItem {
  const next: Record<string, unknown> = JSON.parse(JSON.stringify(item));
  for (const [index, write] of writes.entries()) {
    const where = `write ${index + 1} (${write.path})`;
    if (!["set", "update", "delete"].includes(write.op))
      fail(`${where}: op must be set, update or delete`);
    const [head, name, ...rest] = String(write.path).split("/");
    if (head === "draft") {
      applyDraftWrite(next, write, name, rest, where);
      continue;
    }
    if (rest.length > 0)
      fail(`${where}: paths are meta, params, settings, look, datasets/<id> or files/<name>`);
    if (head === "datasets" || head === "files") {
      if (!name) fail(`${where}: name the dataset or file`);
      const collection = (isRecord(next[head]) ? next[head] : {}) as Record<string, unknown>;
      if (write.op === "delete") delete collection[name];
      else if (write.op === "set") collection[name] = write.data;
      else {
        if (!(name in collection)) fail(`${where}: nothing to update; use set to create it`);
        collection[name] = deepMerge(collection[name], write.data);
      }
      next[head] = collection;
    } else if (
      ["meta", "params", "settings", "look", "system"].includes(head!) &&
      name === undefined
    ) {
      if (write.op === "delete") {
        if (head === "look" || head === "system") delete next[head];
        else
          next[head!] =
            head === "settings" ? { updates: "viewed" } : head === "meta" ? { title: "" } : {};
      } else next[head!] = write.op === "set" ? write.data : deepMerge(next[head!], write.data);
    } else fail(`${where}: paths are meta, params, settings, look, datasets/<id> or files/<name>`);
  }
  const parsed = parseDashboard(next);
  if (JSON.stringify(parsed).length > DASHBOARD_MAX_BYTES)
    fail("the dashboard would be larger than 2 MB");
  return parsed;
}

function applyDraftWrite(
  next: Record<string, unknown>,
  write: DashboardWrite,
  part: string | undefined,
  rest: string[],
  where: string,
) {
  const paths = "draft, draft/files/<name>, draft/datasets/<id> or draft/params";
  if (part === undefined) {
    if (write.op === "delete") delete next.draft;
    else
      next.draft =
        write.op === "set"
          ? { files: {}, datasets: {}, at: new Date().toISOString(), ...(write.data as object) }
          : deepMerge(next.draft, write.data);
    return;
  }
  if (!isRecord(next.draft)) fail(`${where}: no draft is open; set draft first`);
  const draft = next.draft as Record<string, unknown>;
  if (part === "params" && rest.length === 0) {
    if (write.op === "delete") delete draft.params;
    else draft.params = write.op === "set" ? write.data : deepMerge(draft.params, write.data);
    return;
  }
  if ((part === "files" || part === "datasets") && rest.length === 1 && rest[0]) {
    const collection = (isRecord(draft[part]) ? draft[part] : {}) as Record<string, unknown>;
    const key = rest[0];
    if (write.op === "delete") delete collection[key];
    else if (write.op === "set") collection[key] = write.data;
    else {
      if (!(key in collection)) fail(`${where}: nothing to update; use set to create it`);
      collection[key] = deepMerge(collection[key], write.data);
    }
    draft[part] = collection;
    return;
  }
  fail(`${where}: draft paths are ${paths}`);
}

// ── Files into rows ───────────────────────────────────────────────────────────────────────

export interface DatasetRows {
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** A JSON value that is not rows (a record, a number…). */
  readonly value?: unknown;
}

function splitDelimited(textValue: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const source = textValue.replace(/^﻿/u, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((entry) => entry.some((cell) => cell !== ""));
}

/** Reads an attached file the way the dashboard page sees it: text cells, empty cells null. */
export function readDatasetFile(source: DashboardFileSource): DatasetRows {
  const format: DashboardFileFormat =
    source.format ??
    (/\.tsv$/iu.test(source.name) ? "tsv" : /\.json$/iu.test(source.name) ? "json" : "csv");
  if (format === "text") return { columns: ["text"], rows: [{ text: source.text }] };
  if (format === "json") {
    let value: unknown;
    try {
      value = JSON.parse(source.text);
    } catch {
      throw new Error("这个 JSON 文件读不出来");
    }
    const rows = rowsOf(value);
    if (!rows) return { columns: [], rows: [], value };
    return { columns: columnsOf(rows), rows };
  }
  const records = splitDelimited(source.text, format === "tsv" ? "\t" : ",");
  const header = records[0] ?? [];
  const columns = header.map((name, index) => name.trim() || `column_${index + 1}`);
  const rows = records
    .slice(1)
    .map((record) =>
      Object.fromEntries(
        columns.map((column, index) => [
          column,
          record[index] === undefined || record[index] === "" ? null : record[index],
        ]),
      ),
    );
  return { columns, rows };
}

/** Rows as they come: an array of objects, bare or under `rows`, `data` or `results`. */
export function rowsOf(value: unknown): Array<Record<string, unknown>> | null {
  const list = Array.isArray(value)
    ? value
    : isRecord(value)
      ? [value.rows, value.data, value.results].find(Array.isArray)
      : undefined;
  if (!Array.isArray(list)) return null;
  if (!list.every(isRecord)) return null;
  return list.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        isRecord(v) || Array.isArray(v) ? JSON.stringify(v) : v,
      ]),
    ),
  );
}

export function columnsOf(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, 200)) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

export function rowsToCsv(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const cell = (value: unknown) => {
    const raw =
      value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    return /[",\r\n]/u.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
  };
  return [
    columns.map(cell).join(","),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join(",")),
  ].join("\r\n");
}

// ── Filters ───────────────────────────────────────────────────────────────────────────────

/** The `{{name}}` blanks a call's args use. */
export function blanksOf(args: unknown): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(args ?? {}).matchAll(BLANK)) names.add(match[1]!);
  return [...names];
}

/** Null when the value passes; otherwise a plain zh-CN reason. */
export function checkRuleValue(value: unknown, rule: DashboardRule): string | null {
  if (Array.isArray(value)) {
    if (rule.items === undefined && rule.enum === undefined) return "这个筛选只接受一个值";
    if (rule.minItems !== undefined && value.length < rule.minItems)
      return `至少选 ${rule.minItems} 个`;
    if (rule.maxItems !== undefined && value.length > rule.maxItems)
      return `最多选 ${rule.maxItems} 个`;
    for (const entry of value) {
      const reason = checkRuleValue(entry, rule.items ?? { enum: rule.enum! });
      if (reason) return reason;
    }
    return null;
  }
  if (rule.type === "array" || rule.items) return "这个筛选需要一组值";
  if (rule.enum && !rule.enum.includes(value as string)) return "不在可选范围内";
  if (rule.type === "boolean" && typeof value !== "boolean") return "需要是或否";
  if (
    (rule.type === "number" ||
      rule.type === "integer" ||
      rule.minimum !== undefined ||
      rule.maximum !== undefined) &&
    typeof value !== "number"
  )
    return "需要一个数字";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "需要一个数字";
    if (rule.type === "integer" && !Number.isInteger(value)) return "需要一个整数";
    if (rule.minimum !== undefined && value < rule.minimum) return `不能小于 ${rule.minimum}`;
    if (rule.maximum !== undefined && value > rule.maximum) return `不能大于 ${rule.maximum}`;
  }
  if (rule.pattern !== undefined) {
    if (typeof value !== "string") return "需要一段文字";
    if (!new RegExp(`^(?:${rule.pattern})$`, "u").test(value)) return "格式不对";
  }
  if (typeof value === "string") {
    if (rule.minLength !== undefined && value.length < rule.minLength)
      return `至少 ${rule.minLength} 个字`;
    if (rule.maxLength !== undefined && value.length > rule.maxLength)
      return `最多 ${rule.maxLength} 个字`;
  }
  return null;
}

/** True when the rule pins what a value can be (an enum, a pattern, a number or a boolean). */
export function rulePins(rule: DashboardRule | undefined): boolean {
  if (!rule) return false;
  if (rule.items) return rulePins(rule.items) && rule.minItems !== undefined;
  return (
    rule.enum !== undefined ||
    rule.pattern !== undefined ||
    rule.type === "number" ||
    rule.type === "integer" ||
    rule.type === "boolean" ||
    rule.minimum !== undefined ||
    rule.maximum !== undefined
  );
}

/**
 * Fills a call's `{{name}}` blanks. A blank that is a whole argument becomes the value itself;
 * one inside text becomes its characters (lists joined by commas). Each value is checked against
 * its rule first; a blank without a pinning rule only takes plain text with no quote or backslash.
 */
export function fillCallArgs(
  source: DashboardCallSource,
  params: Readonly<Record<string, DashboardParamValue>>,
): { readonly args: Record<string, unknown> } | { readonly error: string } {
  for (const name of blanksOf(source.args)) {
    const value = params[name] ?? "";
    const rule = source.rules?.[name];
    if (rule) {
      const reason = checkRuleValue(value, rule);
      if (reason) return { error: `筛选「${name}」的值${reason}` };
    }
    if (!rulePins(rule)) {
      const parts = Array.isArray(value) ? value : [value];
      if (parts.some((part) => typeof part === "string" && /["'`\\$]/u.test(part)))
        return { error: `筛选「${name}」的值含有引号或反斜杠，不能放进查询` };
    }
  }
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const whole = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/u.exec(value);
      if (whole) return params[whole[1]!] ?? "";
      return value.replace(BLANK, (_, name: string) => {
        const param = params[name];
        if (param === null || param === undefined) return "";
        return Array.isArray(param) ? param.join(",") : String(param);
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (isRecord(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    return value;
  };
  return { args: fill(source.args) as Record<string, unknown> };
}

// ── Static check ──────────────────────────────────────────────────────────────────────────

export interface DashboardFault {
  readonly where: string;
  readonly message: string;
}

const DROPPED = [
  [/<iframe\b/iu, "<iframe> 会被去掉"],
  [/<object\b|<embed\b/iu, "<object>/<embed> 会被去掉"],
  [/<form\b/iu, "<form> 和里面的内容会被去掉"],
  [/<base\b/iu, "<base> 会被去掉"],
  [/<script\b[^>]*type\s*=\s*["']?module/iu, "module 脚本不会运行"],
  [/\son[a-z]+\s*=/iu, "on…= 属性会被去掉，请用 addEventListener"],
  [
    /\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|document\.cookie)\b/u,
    "页面不能联网、不能使用浏览器存储",
  ],
] as const;

/** Script bodies of a page file, in order (inline ones and those naming a dashboard file). */
export function pageScripts(
  item: DashboardItem,
  fileName = DASHBOARD_PAGE_FILE,
): Array<{ name: string; code: string }> {
  const html = item.files[fileName]?.text ?? "";
  const out: Array<{ name: string; code: string }> = [];
  let index = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    index += 1;
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/iu.exec(match[1] ?? "")?.[1];
    if (src) {
      const file = item.files[src];
      if (file) out.push({ name: src, code: file.text });
    } else out.push({ name: `${fileName} 脚本 ${index}`, code: match[2] ?? "" });
  }
  return out;
}

/** Ids a page declares with dash.calc / dash.loader. */
export function declaredIds(code: string, kind: "calc" | "loader"): string[] {
  return [
    ...code.matchAll(new RegExp(`dash\\.${kind}\\(\\s*["'\`]([A-Za-z0-9_-]{1,64})["'\`]`, "gu")),
  ].map((m) => m[1]!);
}

/**
 * What can be found without running the page: a missing page, scripts that do not compile,
 * marks naming no source, filters without a default or rule, files that cannot be read.
 * `compile` checks one script's syntax (the server passes one that never runs the code).
 */
export function checkDashboard(
  item: DashboardItem,
  compile?: (code: string) => string | null,
): DashboardFault[] {
  const faults: DashboardFault[] = [];
  const page = item.files[DASHBOARD_PAGE_FILE];
  if (!page) faults.push({ where: "files/index.html", message: "还没有页面（files/index.html）" });
  const scripts = pageScripts(item);
  const code = scripts.map((script) => script.code).join("\n");
  const calcs = new Set(declaredIds(code, "calc"));
  for (const id of calcs)
    if (item.datasets[id]) faults.push({ where: `calc ${id}`, message: "计算和数据来源同名" });
  for (const script of scripts) {
    const reason = compile?.(script.code);
    if (reason) faults.push({ where: script.name, message: `脚本有语法错误：${reason}` });
  }
  const allHtml = Object.entries(item.files)
    .filter(([name]) => name.endsWith(".html"))
    .map(([, file]) => file.text)
    .join("\n");
  // Markup rules look at the markup; the no-network rule looks at the scripts too.
  const markup = allHtml.replace(
    /<(script|style)\b[\s\S]*?<\/\1>/giu,
    (_, tag: string) => `<${tag}></${tag}>`,
  );
  for (const [pattern, message] of DROPPED) {
    const scope = message.startsWith("页面不能联网") ? `${allHtml}\n${code}` : markup;
    if (pattern.test(scope)) faults.push({ where: "页面", message });
  }
  for (const match of allHtml.matchAll(
    /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']?([^"'\s>]+)/giu,
  )) {
    const ref = match[1]!;
    if (!item.files[ref])
      faults.push({ where: "页面", message: `${ref} 不是看板里的文件，不会载入` });
  }
  for (const match of allHtml.matchAll(/data-source\s*=\s*["']([^"']*)["']/giu)) {
    for (const id of match[1]!.split(/\s+/u).filter(Boolean)) {
      if (!item.datasets[id] && !calcs.has(id))
        faults.push({ where: `data-source="${id}"`, message: "没有这个数据来源或计算" });
    }
  }
  for (const [id, dataset] of Object.entries(item.datasets)) {
    const source = dataset.source;
    if (source.kind === "file" && source.library) {
      // Kept in the 资料库: read when the page opens, not here.
      if (!dataset.updated)
        faults.push({ where: `datasets/${id}`, message: "文件缺少 updated: {at, by}" });
    } else if (source.kind === "file") {
      try {
        const rows = readDatasetFile(source);
        if (rows.rows.length === 0 && rows.value === undefined && source.format !== "text")
          faults.push({ where: `datasets/${id}`, message: "文件里没有可读的行" });
      } catch (error) {
        faults.push({
          where: `datasets/${id}`,
          message: error instanceof Error ? error.message : "文件读不出来",
        });
      }
      if (!dataset.updated)
        faults.push({ where: `datasets/${id}`, message: "文件缺少 updated: {at, by}" });
    } else {
      for (const name of blanksOf(source.args)) {
        if (!(name in item.params))
          faults.push({
            where: `datasets/${id}`,
            message: `筛选「${name}」在 params 里没有默认值`,
          });
        const rule = source.rules?.[name];
        if (!rule)
          faults.push({ where: `datasets/${id}`, message: `筛选「${name}」没有规则（rules）` });
        else if (name in item.params) {
          const reason = checkRuleValue(item.params[name], rule);
          if (reason)
            faults.push({ where: `datasets/${id}`, message: `筛选「${name}」的默认值${reason}` });
        }
      }
    }
  }
  const unique = new Map(faults.map((fault) => [`${fault.where}\u0000${fault.message}`, fault]));
  return [...unique.values()];
}

/** Searchable text kept as the page content: title, sources and the page's words. */
export function projectDashboard(item: DashboardItem, title = ""): string {
  const words = (item.files[DASHBOARD_PAGE_FILE]?.text ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const sources = Object.values(item.datasets).map(
    (dataset) => `- ${dataset.title}${dataset.description ? `：${dataset.description}` : ""}`,
  );
  return [
    `# ${item.meta.title || title || "数据看板"}`,
    sources.length ? `数据来源\n${sources.join("\n")}` : "",
    words,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4_000);
}

// ── Looks ─────────────────────────────────────────────────────────────────────────────────

const darkBase = {
  text: "#f0efec",
  muted: "#8f8d88",
  border: "#2c2c2a",
  good: "#2fb344",
  warning: "#f5b44a",
  bad: "#f07a7a",
};
const lightStatus = { good: "#0f7a2a", warning: "#8a5300", bad: "#b3261e" };

/** Ready-made looks. The page names only tokens, so a look can change later. */
export const DASHBOARD_LOOKS: readonly DashboardLook[] = [
  {
    name: "暖纸",
    light: {
      ground: "#f5f0e8",
      card: "#ffffff",
      text: "#2a251f",
      muted: "#776c5f",
      border: "#e5ddd0",
      ...lightStatus,
      charts: [
        "#c8694a",
        "#3f3a2b",
        "#bfae7c",
        "#738a58",
        "#5f93c4",
        "#875a79",
        "#c4902a",
        "#5c6870",
      ],
    },
    dark: {
      ground: "#15120e",
      card: "#221e18",
      ...darkBase,
      charts: [
        "#dc805f",
        "#cbc4b4",
        "#b98f5b",
        "#8fa673",
        "#7aabd9",
        "#a67898",
        "#d6a547",
        "#8b98a1",
      ],
    },
  },
  {
    name: "海蓝",
    light: {
      ground: "#eff4f9",
      card: "#ffffff",
      text: "#102233",
      muted: "#596c7e",
      border: "#d6e0ea",
      ...lightStatus,
      charts: [
        "#1f4f8a",
        "#2b7ad6",
        "#1c99a8",
        "#60b3e3",
        "#79cdab",
        "#7650b5",
        "#788997",
        "#d5c49c",
      ],
    },
    dark: {
      ground: "#0c131a",
      card: "#16212c",
      ...darkBase,
      charts: [
        "#5f8fcc",
        "#3584e8",
        "#47b0c0",
        "#80ccfb",
        "#9ce6c5",
        "#a38ae4",
        "#91a1af",
        "#eadab3",
      ],
    },
  },
  {
    name: "青草",
    light: {
      ground: "#f1f5eb",
      card: "#ffffff",
      text: "#1d2a1e",
      muted: "#64715d",
      border: "#dbe3d0",
      ...lightStatus,
      charts: [
        "#2e6b50",
        "#50b586",
        "#a2b23d",
        "#795c3f",
        "#d6982c",
        "#2c8a8a",
        "#888d83",
        "#a5435a",
      ],
    },
    dark: {
      ground: "#0f140f",
      card: "#1a211a",
      ...darkBase,
      charts: [
        "#4a8267",
        "#70cea0",
        "#d6e783",
        "#907355",
        "#efb253",
        "#4ea3a3",
        "#a1a59c",
        "#be5b72",
      ],
    },
  },
];

// ── History diff ──────────────────────────────────────────────────────────────────────────

/** Each document of a dashboard as text, for comparing two versions. */
export function dashboardDocuments(item: DashboardItem): Map<string, string> {
  const docs = new Map<string, string>();
  docs.set("meta", JSON.stringify(item.meta, null, 2));
  docs.set("params", JSON.stringify(item.params, null, 2));
  docs.set("settings", JSON.stringify(item.settings, null, 2));
  if (item.look) docs.set("look", JSON.stringify(item.look, null, 2));
  for (const [id, dataset] of Object.entries(item.datasets)) {
    const { edit: _edit, ...rest } = dataset;
    docs.set(`datasets/${id}`, JSON.stringify(rest, null, 2));
  }
  for (const [name, file] of Object.entries(item.files)) docs.set(`files/${name}`, file.text);
  return docs;
}

export type DiffLine = { readonly mark: " " | "+" | "−"; readonly text: string };

/** Line diff (longest common subsequence). Null when the texts are too long to compare. */
export function diffLines(before: string, after: string, limit = 2_500): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > limit || b.length > limit || a.length * b.length > 4_000_000) return null;
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ mark: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ mark: "−", text: a[i]! });
      i += 1;
    } else {
      out.push({ mark: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ mark: "−", text: a[i++]! });
  while (j < m) out.push({ mark: "+", text: b[j++]! });
  return out;
}

/** What changed between two versions, document by document (unchanged ones left out). */
export function diffDashboards(
  before: DashboardItem,
  after: DashboardItem,
): Array<{ path: string; added: number; removed: number; lines: DiffLine[] | null }> {
  const a = dashboardDocuments(before);
  const b = dashboardDocuments(after);
  const paths = [...new Set([...a.keys(), ...b.keys()])];
  return paths.flatMap((path) => {
    const left = a.get(path) ?? "";
    const right = b.get(path) ?? "";
    if (left === right) return [];
    const lines = diffLines(left, right);
    return [
      {
        path,
        added: lines ? lines.filter((l) => l.mark === "+").length : right.split("\n").length,
        removed: lines ? lines.filter((l) => l.mark === "−").length : left.split("\n").length,
        lines,
      },
    ];
  });
}
