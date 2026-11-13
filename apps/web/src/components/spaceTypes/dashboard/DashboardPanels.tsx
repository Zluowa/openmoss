// FILE: DashboardPanels.tsx
// Purpose: The 外观 and 历史 side panels of a 数据看板, and its empty state with the four shapes
//          (看板 / 可视化分析 / 滚动叙事 / 短视觉) to pick before Moss builds the page.
// Layer: Web 资料空间 数据看板 host
// Spec: docs/design/data-claude-teardown.md §2, §2.1

import type { PageId, PageVersion, SpaceId } from "@moss/contracts";
import {
  BUILT_IN_DESIGN_SYSTEMS,
  storedSystemTokens,
  type DashboardSystemRef,
  type DesignSystemTokens,
  DASHBOARD_FONTS,
  DASHBOARD_FORMS,
  DASHBOARD_LOOKS,
  type DashboardFont,
  type DashboardForm,
  type DashboardLook,
  type DiffLine,
} from "@moss/shared/spaceItems/dashboard";
import { DASHBOARD_STANDARD_LOOK } from "@moss/shared/spaceItems/dashboardFrame";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { MossLogoMark } from "../../MossLogoMark";
import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { CheckIcon, Undo2Icon } from "~/lib/icons";
import { Button } from "../../ui/button";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { DisclosureRegion } from "../../ui/DisclosureRegion";
import type { DashboardCopy } from "./dashboardCopy";

// Prose fields, not code: the global field reset would make them monospace.
const UI_FONT = { fontFamily: "var(--font-ui-family)" } as const;

// ── Design ────────────────────────────────────────────────────────────────────────────

function LookSwatch(props: { look: DashboardLook; mode: "light" | "dark"; small?: boolean }) {
  const palette = props.look[props.mode];
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-end gap-0.5 overflow-hidden rounded-control border border-border",
        props.small ? "h-5 w-8 p-1" : "h-9 w-14 p-1.5",
      )}
      style={{ background: palette.ground }}
    >
      {palette.charts.slice(0, 4).map((color, index) => (
        <span
          key={color}
          className="w-2 rounded-inline"
          style={{ background: color, height: `${40 + index * 15}%` }}
        />
      ))}
      <span
        className="ml-auto h-1 w-3 self-start rounded-full"
        style={{ background: palette.text }}
      />
    </span>
  );
}

export function DashboardDesignPanel(props: {
  readonly copy: DashboardCopy;
  readonly look: DashboardLook | undefined;
  readonly mode: "light" | "dark";
  readonly shape: DashboardForm | undefined;
  readonly readOnly: boolean;
  readonly canAsk: boolean;
  readonly onLook: (look: DashboardLook | null) => void;
  readonly onRemake: (form: DashboardForm) => void;
  /** The look being tweaked (null when nothing is changed yet). */
  readonly style: { readonly look: DashboardLook; readonly undo: number } | null;
  readonly onTweak: (look: DashboardLook) => void;
  readonly onStyleUndo: () => void;
  readonly onStyleCancel: () => void;
  readonly onStyleSave: () => void;
  readonly draftOpen: boolean;
  /** The design system the dashboard wears, and where stored systems are listed from. */
  readonly system: DashboardSystemRef | undefined;
  readonly scopeSpaceId: SpaceId | null;
  readonly account: string;
  readonly onSystem: (system: DashboardSystemRef | null) => void;
}) {
  const { copy } = props;
  const [form, setForm] = useState<DashboardForm>(props.shape ?? "dashboard");
  const looks: Array<{ look: DashboardLook; value: DashboardLook | null; label: string }> = [
    { look: DASHBOARD_STANDARD_LOOK, value: null, label: copy.lookDefault },
    ...DASHBOARD_LOOKS.map((look) => ({ look, value: look, label: look.name })),
  ];
  // While a design system is worn, no ready-made look is picked.
  const current = props.system ? "\u0000system" : (props.look?.name ?? null);
  return (
    <div className="flex flex-col gap-5 px-3.5 py-3" data-testid="dashboard-design-panel">
      <section className="flex flex-col gap-2">
        <h3 className="text-ui font-medium text-foreground">{copy.lookTitle}</h3>
        <div role="radiogroup" aria-label={copy.looks} className="flex flex-col gap-0.5">
          {looks.map((entry) => {
            const on = (entry.value?.name ?? null) === current;
            return (
              <Button
                key={entry.label}
                variant="ghost"
                role="radio"
                aria-checked={on}
                disabled={props.readOnly}
                onClick={() => !on && props.onLook(entry.value)}
                className={cn(
                  "h-12 justify-start gap-3 rounded-row px-2 font-normal",
                  on && "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]",
                )}
              >
                <LookSwatch look={entry.look} mode={props.mode} />
                <span className="min-w-0 flex-1 truncate text-left text-ui text-foreground">
                  {entry.label}
                </span>
                {on ? (
                  <span className="flex items-center gap-1 text-ui-sm text-muted-foreground">
                    {props.look?.tweaked ? copy.styleAdjusted : null}
                    <CheckIcon className="size-4" aria-hidden />
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
      </section>
      <SystemSection {...props} />
      <StyleSection {...props} />
      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="text-ui font-medium text-foreground">{copy.formsTitle}</h3>
        <p className="text-ui-sm text-muted-foreground">{copy.formsBody}</p>
        <FormPicker copy={copy} value={form} onChange={setForm} compact />
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          disabled={props.readOnly || !props.canAsk || props.draftOpen || props.style !== null}
          onClick={() => props.onRemake(form)}
        >
          {copy.remake}
        </Button>
      </section>
    </div>
  );
}

/** 设计系统: Moss's built-in systems and the ones kept in 设计 items of this 资料空间. */
function SystemSection(props: Parameters<typeof DashboardDesignPanel>[0]) {
  const { copy } = props;
  const stored = useQuery({
    queryKey: ["dashboard-design-systems", props.account, props.scopeSpaceId],
    staleTime: 30_000,
    queryFn: async () => {
      const api = ensureNativeApi();
      const listed = await api.pages.list({ scopeSpaceId: props.scopeSpaceId });
      const designs = listed.pages
        .filter((page) => (page.kind as string | undefined) === "design" && page.trashedAt === null)
        .slice(0, 40);
      const found = await Promise.all(
        designs.map(async (page) => {
          const item = await api.pageTypes
            .read({ scopeSpaceId: props.scopeSpaceId, pageId: page.id })
            .catch(() => null);
          const tokens = storedSystemTokens(item?.data ?? null);
          return tokens ? { source: `page:${page.id}`, name: page.title, tokens } : null;
        }),
      );
      return found.filter(
        (entry): entry is { source: string; name: string; tokens: DesignSystemTokens } =>
          entry !== null,
      );
    },
  });
  const choices = [
    ...BUILT_IN_DESIGN_SYSTEMS.map((system) => ({
      source: `builtin:${system.id}`,
      name: system.name,
      tokens: system.tokens,
      note: system.description,
    })),
    ...(stored.data ?? []).map((system) => ({ ...system, note: copy.systemStored })),
  ];
  const current = props.system?.source ?? null;
  const latest = choices.find((choice) => choice.source === current);
  const outdated =
    props.system !== undefined &&
    latest !== undefined &&
    JSON.stringify(latest.tokens) !== JSON.stringify(props.system.tokens);
  const disabled = props.readOnly || props.draftOpen || props.style !== null;
  const wear = (choice: { source: string; name: string; tokens: DesignSystemTokens }) =>
    props.onSystem({
      source: choice.source,
      name: choice.name,
      tokens: choice.tokens,
      copiedAt: new Date().toISOString(),
    });
  return (
    <section
      className="flex flex-col gap-2 border-t border-border pt-4"
      data-testid="dashboard-systems"
    >
      <h3 className="text-ui font-medium text-foreground">{copy.systemTitle}</h3>
      <div role="radiogroup" aria-label={copy.systemTitle} className="flex flex-col gap-0.5">
        {choices.map((choice) => {
          const on = choice.source === current;
          return (
            <Button
              key={choice.source}
              variant="ghost"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => !on && wear(choice)}
              className={cn(
                "h-auto min-h-10 justify-start gap-3 rounded-row px-2 py-1.5 font-normal",
                on && "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]",
              )}
            >
              <SystemSwatch tokens={choice.tokens} mode={props.mode} />
              <span className="flex min-w-0 flex-1 flex-col items-start text-left">
                <span className="w-full truncate text-ui text-foreground">{choice.name}</span>
                <span className="w-full truncate text-ui-xs text-muted-foreground">
                  {choice.note}
                </span>
              </span>
              {on ? <CheckIcon className="size-4 text-muted-foreground" aria-hidden /> : null}
            </Button>
          );
        })}
      </div>
      {props.system ? (
        <div className="flex flex-wrap items-center gap-1">
          {outdated && latest ? (
            <Button size="xs" variant="secondary" disabled={disabled} onClick={() => wear(latest)}>
              {copy.systemUpdate}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => props.onSystem(null)}
          >
            {copy.systemNone}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function SystemSwatch(props: { tokens: DesignSystemTokens; mode: "light" | "dark" }) {
  const color = (names: string[], fallback: string) => {
    for (const name of names) {
      const token = props.tokens.colors.find((entry) => entry.name === name);
      if (token) return props.mode === "dark" ? (token.dark ?? token.light) : token.light;
    }
    return fallback;
  };
  return (
    <span
      aria-hidden
      className="flex h-9 w-14 shrink-0 items-center justify-center gap-1 overflow-hidden rounded-control border border-border"
      style={{ background: color(["paper", "page", "background"], "transparent") }}
    >
      <span
        className="size-3 rounded-full"
        style={{ background: color(["ink", "text"], "currentColor") }}
      />
      <span
        className="size-3 rounded-full"
        style={{ background: color(["accent", "primary"], "currentColor") }}
      />
    </span>
  );
}

function ColorField(props: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-ui-sm text-foreground">
      <span className="min-w-0 truncate">{props.label}</span>
      <input
        type="color"
        aria-label={props.label}
        // A colour picker only takes #rrggbb; anything else (oklch, rgb) shows as its default.
        value={/^#[0-9a-fA-F]{6}$/u.test(props.value) ? props.value : ""}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-7 w-10 cursor-pointer rounded-control border border-border bg-transparent p-0.5"
      />
    </label>
  );
}

/** 调整: single style values on top of the look, with 撤销 / 取消 / 保存. */
function StyleSection(props: Parameters<typeof DashboardDesignPanel>[0]) {
  const { copy } = props;
  const [open, setOpen] = useState(false);
  const base = props.style?.look ?? props.look ?? DASHBOARD_STANDARD_LOOK;
  const palette = base[props.mode];
  const disabled = props.readOnly || props.draftOpen;
  const tweak = (patch: Partial<DashboardLook>, colors?: Partial<typeof palette>) =>
    props.onTweak({
      ...base,
      ...patch,
      ...(colors ? { [props.mode]: { ...palette, ...colors } } : {}),
      tweaked: true,
    });
  return (
    <section
      className="flex flex-col gap-2 border-t border-border pt-3"
      data-testid="dashboard-style"
    >
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="h-8 justify-between rounded-none px-0 text-ui font-medium text-foreground hover:bg-transparent"
      >
        {copy.style}
        <DisclosureChevron open={open} className="size-4 text-muted-foreground" />
      </Button>
      <DisclosureRegion open={open}>
        <div className="flex flex-col gap-2.5 pb-1">
          <p className="text-ui-xs text-muted-foreground">{copy.styleHint}</p>
          <ColorField
            label={copy.stylePage}
            value={palette.ground}
            disabled={disabled}
            onChange={(ground) => tweak({}, { ground })}
          />
          <ColorField
            label={copy.styleCard}
            value={palette.card}
            disabled={disabled}
            onChange={(card) => tweak({}, { card })}
          />
          <ColorField
            label={copy.styleText}
            value={palette.text}
            disabled={disabled}
            onChange={(text) => tweak({}, { text })}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm text-foreground">{copy.styleCharts}</span>
            <div className="grid grid-cols-8 gap-1">
              {palette.charts.map((color, index) => (
                <input
                  key={index}
                  type="color"
                  aria-label={`${copy.styleCharts} ${index + 1}`}
                  value={color}
                  disabled={disabled}
                  onChange={(event) =>
                    tweak(
                      {},
                      {
                        charts: palette.charts.map((c, i) =>
                          i === index ? event.target.value : c,
                        ),
                      },
                    )
                  }
                  className="h-7 w-full cursor-pointer rounded-control-xs border border-border bg-transparent p-0.5"
                />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 text-ui-sm text-foreground">
            <span>{copy.styleFont}</span>
            <div role="radiogroup" aria-label={copy.styleFont} className="flex gap-0.5">
              {DASHBOARD_FONTS.map((font: DashboardFont) => {
                const on = (base.font ?? "sans") === font;
                return (
                  <Button
                    key={font}
                    size="xs"
                    variant="ghost"
                    role="radio"
                    aria-checked={on}
                    disabled={disabled}
                    onClick={() => !on && tweak({ font })}
                    className={cn(on && "bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]")}
                  >
                    {copy.fonts[font]}
                  </Button>
                );
              })}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 text-ui-sm text-foreground">
            <span className="shrink-0">{copy.styleSize}</span>
            <input
              type="range"
              min={12}
              max={18}
              step={1}
              value={base.size ?? 14}
              disabled={disabled}
              aria-label={copy.styleSize}
              onChange={(event) => tweak({ size: Number(event.target.value) })}
              className="min-w-0 flex-1 accent-[var(--color-text-accent)]"
            />
            <span className="w-8 text-right tabular-nums text-muted-foreground">
              {base.size ?? 14}px
            </span>
          </label>
          {props.style ? (
            <div className="flex items-center gap-1 pt-1" data-testid="dashboard-style-bar">
              <Button
                size="xs"
                variant="ghost"
                disabled={props.style.undo === 0}
                onClick={props.onStyleUndo}
                aria-label={copy.styleUndo}
              >
                <Undo2Icon className="size-4" aria-hidden />
              </Button>
              <span className="flex-1" />
              <Button size="xs" variant="ghost" onClick={props.onStyleCancel}>
                {copy.styleCancel}
              </Button>
              <Button
                size="xs"
                variant="secondary"
                onClick={props.onStyleSave}
                data-testid="dashboard-style-save"
              >
                {copy.styleSave}
              </Button>
            </div>
          ) : null}
        </div>
      </DisclosureRegion>
    </section>
  );
}

// ── Shapes ────────────────────────────────────────────────────────────────────────────

/** Moss-drawn pictures of the four shapes: boxes and one mark each. */
function FormPicture(props: { form: DashboardForm }) {
  const box = "fill-none stroke-current";
  return (
    <svg viewBox="0 0 106 66" className="size-full text-muted-foreground opacity-100" aria-hidden>
      {props.form === "dashboard" ? (
        <>
          <rect className={box} x="10" y="10" width="52" height="46" rx="4" />
          <rect className={box} x="68" y="10" width="28" height="20" rx="4" />
          <rect className={box} x="68" y="36" width="28" height="20" rx="4" />
          <path
            className="fill-none stroke-[var(--color-text-accent)]"
            strokeWidth="2"
            d="M16 46 28 36l10 4 18-16"
          />
        </>
      ) : props.form === "visual-analysis" ? (
        <>
          <rect className={box} x="30" y="6" width="46" height="54" rx="4" />
          <path
            className="fill-none stroke-[var(--color-text-accent)]"
            strokeWidth="2"
            d="M36 44c10 0 12-20 24-20 6 0 8 4 10 6"
          />
          <path className={box} d="M36 14h22M36 19h14" />
        </>
      ) : props.form === "scroll-story" ? (
        <>
          <rect className={box} x="10" y="8" width="38" height="50" rx="4" />
          <path className={box} d="M56 16h40M56 26h40M56 36h28" />
          <path
            className="fill-none stroke-[var(--color-text-accent)]"
            strokeWidth="2"
            d="M16 46l9-8 7 4 10-12"
          />
        </>
      ) : (
        <>
          <rect className={box} x="10" y="12" width="86" height="42" rx="4" />
          <path className="fill-[var(--color-text-accent)]" d="M48 25v16l13-8z" />
        </>
      )}
    </svg>
  );
}

export function FormPicker(props: {
  readonly copy: DashboardCopy;
  readonly value: DashboardForm;
  readonly onChange: (form: DashboardForm) => void;
  readonly compact?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.copy.formsHint}
      className={cn(
        "grid w-full gap-2",
        props.compact
          ? "grid-cols-2"
          : "grid-cols-2 sm:grid-cols-[repeat(4,minmax(0,9rem))] sm:justify-center sm:gap-4",
      )}
    >
      {DASHBOARD_FORMS.map((form) => {
        const on = form === props.value;
        return (
          <Button
            key={form}
            variant="ghost"
            role="radio"
            aria-checked={on}
            onClick={() => props.onChange(form)}
            data-testid={`dashboard-form-${form}`}
            className={cn(
              "h-auto w-full flex-col items-stretch gap-1.5 p-1 font-normal hover:bg-transparent",
              on && "font-medium",
            )}
          >
            <span
              className={cn(
                "block aspect-[212/146] w-full overflow-hidden rounded-card border bg-background",
                on ? "border-2 border-[var(--color-text-accent)]" : "border-border",
              )}
            >
              <FormPicture form={form} />
            </span>
            <span
              className={cn(
                "text-center text-ui-sm",
                on ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {props.copy.forms[form]}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

export function DashboardEmptyState(props: {
  readonly copy: DashboardCopy;
  readonly working: boolean;
  readonly readOnly: boolean;
  readonly canAsk: boolean;
  readonly onAsk: (request: string, form: DashboardForm, look: DashboardLook | null) => void;
  readonly mode: "light" | "dark";
}) {
  const { copy } = props;
  const [form, setForm] = useState<DashboardForm>("dashboard");
  const [look, setLook] = useState<DashboardLook | null>(null);
  const [text, setText] = useState("");
  if (props.working) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
        data-testid="dashboard-empty"
        data-working=""
      >
        <MossLogoMark className="size-8 motion-safe:animate-pulse" />
        <p className="text-ui text-muted-foreground">{copy.emptyWorking}</p>
      </div>
    );
  }
  return (
    <div
      className="flex h-full flex-col items-center justify-center overflow-auto p-6"
      data-testid="dashboard-empty"
    >
      <div className="flex w-full max-w-[680px] flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-1">
          <p className="text-ui-lg font-medium text-foreground">{copy.emptyTitle}</p>
          {props.readOnly ? null : (
            <p className="text-ui text-muted-foreground">{copy.emptyBody}</p>
          )}
        </div>
        {props.readOnly ? null : (
          <>
            <FormPicker copy={copy} value={form} onChange={setForm} />
            <div
              role="radiogroup"
              aria-label={copy.lookQuestion}
              className="flex flex-wrap items-center justify-center gap-2"
              data-testid="dashboard-empty-looks"
            >
              <span className="text-ui-sm text-muted-foreground">{copy.lookQuestion}</span>
              {[
                {
                  value: null as DashboardLook | null,
                  swatch: DASHBOARD_STANDARD_LOOK,
                  label: copy.lookDefault,
                },
                ...DASHBOARD_LOOKS.map((entry) => ({
                  value: entry as DashboardLook | null,
                  swatch: entry,
                  label: entry.name,
                })),
              ].map((entry) => {
                const on = (entry.value?.name ?? null) === (look?.name ?? null);
                return (
                  <Button
                    key={entry.label}
                    size="sm"
                    variant="ghost"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setLook(entry.value)}
                    className={cn(
                      "gap-2 px-1.5 font-normal",
                      on && "bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]",
                    )}
                  >
                    <LookSwatch look={entry.swatch} mode={props.mode} small />
                    {entry.label}
                  </Button>
                );
              })}
            </div>
            <form
              className="flex w-full items-end gap-2 rounded-composer border border-border bg-background p-2 shadow-xs"
              onSubmit={(event) => {
                event.preventDefault();
                if (text.trim() && props.canAsk) props.onAsk(text.trim(), form, look);
              }}
            >
              <textarea
                aria-label={copy.askPlaceholder}
                value={text}
                rows={2}
                placeholder={copy.emptyBody}
                style={UI_FONT}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (text.trim() && props.canAsk) props.onAsk(text.trim(), form, look);
                  }
                }}
                className="min-h-10 flex-1 resize-none bg-transparent px-1.5 py-1 text-ui text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground/70"
              />
              <Button size="sm" type="submit" disabled={!text.trim() || !props.canAsk}>
                {copy.send}
              </Button>
            </form>
            {!props.canAsk ? (
              <p className="text-ui-sm text-muted-foreground">{copy.noAgent}</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ── History ───────────────────────────────────────────────────────────────────────────

export function DashboardHistoryPanel(props: {
  readonly copy: DashboardCopy;
  readonly locale: string;
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly pageId: PageId;
  readonly revision: number;
  readonly viewing: number | null;
  readonly readOnly: boolean;
  readonly onView: (revision: number | null) => void;
  readonly onRestore: (revision: number) => void;
  /** What the viewed version has that differs from now. */
  readonly diff: ReadonlyArray<{
    path: string;
    added: number;
    removed: number;
    lines: DiffLine[] | null;
  }> | null;
}) {
  const { copy } = props;
  const query = useQuery({
    queryKey: [
      "dashboard-history",
      props.account,
      props.scopeSpaceId,
      props.pageId,
      props.revision,
    ],
    queryFn: () =>
      ensureNativeApi().pages.versions({
        scopeSpaceId: props.scopeSpaceId,
        pageId: props.pageId,
        summaryOnly: true,
        limit: 30,
      }),
  });
  const versions: readonly PageVersion[] = query.data?.versions ?? [];
  const zh = props.locale.startsWith("zh");
  const when = (iso: string) =>
    new Date(iso).toLocaleString(zh ? "zh-CN" : "en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <div className="flex flex-col" data-testid="dashboard-history-panel">
      {props.viewing !== null ? (
        <div className="flex flex-col gap-2 border-b border-border px-3.5 py-3">
          <p className="text-ui-sm text-muted-foreground">{copy.historyViewing}</p>
          <div className="flex gap-1">
            <Button size="xs" variant="ghost" onClick={() => props.onView(null)}>
              {copy.historyBack}
            </Button>
            {props.readOnly ? null : (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => props.onRestore(props.viewing!)}
                data-testid="dashboard-restore"
              >
                {copy.restore}
              </Button>
            )}
          </div>
          {props.diff ? <VersionDiff copy={copy} diff={props.diff} /> : null}
        </div>
      ) : null}
      {versions.length === 0 && !query.isLoading ? (
        <p className="px-4 py-8 text-center text-ui-sm text-muted-foreground">
          {copy.historyEmpty}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5 px-2 py-3">
        {versions.map((version) => {
          const current = version.page.revision === props.revision;
          const on = props.viewing === version.page.revision || (props.viewing === null && current);
          const by = version.author === "agent" ? copy.historyBy.moss : copy.historyBy.me;
          return (
            <li key={version.page.revision}>
              <Button
                variant="ghost"
                onClick={() => props.onView(current ? null : version.page.revision)}
                className={cn(
                  "h-auto w-full flex-col items-start gap-1 rounded-row px-2 py-2.5 font-normal",
                  on && "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]",
                )}
                data-testid={`dashboard-version-${version.page.revision}`}
              >
                <span className="flex w-full items-center gap-2 text-ui text-foreground">
                  {when(version.createdAt)}
                  {current ? (
                    <span className="text-ui-xs text-muted-foreground">{copy.historyCurrent}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
                  {version.author === "agent" ? (
                    <MossLogoMark className="size-4" />
                  ) : (
                    <span
                      aria-hidden
                      className="size-4 rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]"
                    />
                  )}
                  {by}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Gallery thumbnail of a 数据看板 template: three figures and a trend, drawn by Moss. */
export function DashboardThumbnail() {
  return (
    <div className="pointer-events-none flex h-[130px] w-full flex-col gap-1.5 p-3" aria-hidden>
      <div className="grid grid-cols-3 gap-1.5">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="flex flex-col gap-1 rounded-control border border-border bg-background p-1.5"
          >
            <span className="h-1 w-8 rounded-full bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)]" />
            <span className="h-2 w-10 rounded-full bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)]" />
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 rounded-control border border-border bg-background p-1.5">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full">
          <path
            d="M2 34 20 27 38 29 56 18 74 15 98 6"
            fill="none"
            className="stroke-[var(--color-text-accent)]"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </div>
  );
}

function VersionDiff(props: {
  copy: DashboardCopy;
  diff: NonNullable<Parameters<typeof DashboardHistoryPanel>[0]["diff"]>;
}) {
  const { copy } = props;
  return (
    <div className="flex flex-col gap-1.5" data-testid="dashboard-diff">
      <p className="text-ui-xs text-muted-foreground">{copy.diffTitle}</p>
      {props.diff.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">{copy.diffNone}</p>
      ) : null}
      {props.diff.map((doc) => (
        <DiffDoc key={doc.path} copy={copy} doc={doc} />
      ))}
    </div>
  );
}

function DiffDoc(props: {
  copy: DashboardCopy;
  doc: { path: string; added: number; removed: number; lines: DiffLine[] | null };
}) {
  const [open, setOpen] = useState(false);
  const { copy, doc } = props;
  // Keep two lines of context around each change.
  const lines = doc.lines
    ? doc.lines.filter(
        (line, index, all) =>
          line.mark !== " " ||
          all.slice(Math.max(0, index - 2), index + 3).some((near) => near.mark !== " "),
      )
    : null;
  return (
    <div className="overflow-hidden rounded-card border border-border">
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="h-8 w-full justify-between rounded-none px-2.5 font-normal"
      >
        <span className="min-w-0 truncate font-mono text-ui-xs text-foreground">{doc.path}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-ui-xs tabular-nums">
          <span className="text-[var(--color-text-success,var(--foreground))]">
            {copy.diffAdded(doc.added)}
          </span>
          <span className="text-[var(--color-text-danger,var(--foreground))]">
            {copy.diffRemoved(doc.removed)}
          </span>
          <DisclosureChevron open={open} className="size-3.5 text-muted-foreground" />
        </span>
      </Button>
      <DisclosureRegion open={open}>
        {lines ? (
          <pre className="max-h-72 overflow-auto border-t border-border font-mono text-chat-code whitespace-pre-wrap break-words">
            {lines.map((line, index) => (
              <span
                key={index}
                data-mark={line.mark}
                className={cn(
                  "block border-l-[3px] border-transparent px-2.5",
                  line.mark === "+" &&
                    "border-[var(--color-text-success,currentColor)] bg-[color-mix(in_srgb,var(--color-text-success,currentColor)_10%,transparent)]",
                  line.mark === "−" &&
                    "border-[var(--color-text-danger,currentColor)] bg-[color-mix(in_srgb,var(--color-text-danger,currentColor)_10%,transparent)]",
                )}
              >
                <span aria-hidden className="mr-2 select-none text-muted-foreground">
                  {line.mark}
                </span>
                {line.text}
              </span>
            ))}
          </pre>
        ) : (
          <p className="border-t border-border px-2.5 py-2 text-ui-sm text-muted-foreground">
            {copy.diffTooBig}
          </p>
        )}
      </DisclosureRegion>
    </div>
  );
}
