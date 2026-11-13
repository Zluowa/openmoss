// FILE: DashboardSourcesPanel.tsx
// Purpose: 数据来源 beside a 数据看板: every source grouped by connector, files and calculations,
//          with how it loaded and how fresh it is; one source's page with its query, transform,
//          result rows (the clicked number lit), file or formula, CSV download, editing a file or
//          a query's arguments, and the 刷新数据 window.
// Layer: Web 资料空间 数据看板 host
// Spec: docs/design/data-claude-teardown.md §2.1

import {
  DASHBOARD_INLINE_FILE_MAX_BYTES,
  DASHBOARD_LIBRARY_FILE_MAX_BYTES,
  blanksOf,
  readDatasetFile,
  rowsToCsv,
  type DashboardDataset,
  type DashboardItem,
  type DashboardUpdates,
} from "@moss/shared/spaceItems/dashboard";
import { useMemo, useState, type ReactNode } from "react";

import { downloadBlob } from "~/lib/browserDownload";
import { uploadLibraryFiles } from "~/lib/libraryUpload";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CodeIcon,
  DatabaseIcon,
  DownloadIcon,
  FileIcon,
  type LucideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { DisclosureRegion } from "../../ui/DisclosureRegion";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../../ui/menu";
import type { DashboardCopy } from "./dashboardCopy";
import type {
  DashboardCalcState,
  DashboardPick,
  DashboardSourceState,
} from "./useDashboardRuntime";

const RESULT_ROWS = 100;

type Entry =
  | {
      readonly kind: "dataset";
      readonly id: string;
      readonly dataset: DashboardDataset;
      readonly state: DashboardSourceState | undefined;
    }
  | { readonly kind: "calc"; readonly id: string; readonly calc: DashboardCalcState };

function age(at: number | string | null | undefined, locale: string): string | null {
  if (at === null || at === undefined) return null;
  const time = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(time)) return null;
  const minutes = Math.round((Date.now() - time) / 60_000);
  const zh = locale.startsWith("zh");
  if (minutes < 1) return zh ? "刚刚" : "just now";
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return zh ? `${hours} 小时前` : `${hours} h ago`;
  return new Date(time).toLocaleDateString(zh ? "zh-CN" : "en");
}

function StatusDot(props: { status: string; stale?: boolean }) {
  const color =
    props.status === "error" || props.status === "declined"
      ? "bg-[var(--color-text-danger,var(--destructive))]"
      : props.status === "connect" || props.stale
        ? "bg-[var(--color-text-warning)]"
        : props.status === "loading"
          ? "bg-muted-foreground motion-safe:animate-pulse"
          : null;
  return (
    <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
      {color ? <span className={cn("size-1.5 rounded-full", color)} /> : null}
    </span>
  );
}

function entryStatus(entry: Entry): string {
  if (entry.kind === "calc") return entry.calc.status;
  return entry.state?.status ?? "idle";
}

function isStale(dataset: DashboardDataset): boolean {
  if (dataset.source.kind !== "file" || !dataset.updated || !dataset.staleAfterHours) return false;
  return Date.now() - Date.parse(dataset.updated.at) > dataset.staleAfterHours * 3_600_000;
}

function Fold(props: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className="border-t border-border" data-testid={props.testId}>
      <Button
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="h-9 w-full justify-between rounded-none px-1 text-ui font-medium text-foreground hover:bg-transparent"
      >
        {props.title}
        <DisclosureChevron open={open} className="size-4 text-muted-foreground" />
      </Button>
      <DisclosureRegion open={open}>
        <div className="pb-3">{props.children}</div>
      </DisclosureRegion>
    </div>
  );
}

function CodeBlock(props: { text: string }) {
  return (
    <pre className="max-h-60 overflow-auto rounded-card border border-border bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] px-2.5 py-2 font-mono text-chat-code whitespace-pre-wrap break-words text-foreground">
      {props.text}
    </pre>
  );
}

function ResultTable(props: {
  columns: readonly string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  count: number;
  lit: DashboardPick | null;
  copy: DashboardCopy;
}) {
  const rows = props.rows.slice(0, RESULT_ROWS);
  if (props.columns.length === 0 || rows.length === 0)
    return <p className="text-ui-sm text-muted-foreground">{props.copy.noRows}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="max-h-72 overflow-auto rounded-card border border-border">
        <table className="w-full border-collapse text-ui-sm tabular-nums">
          <thead className="sticky top-0 bg-background">
            <tr>
              {props.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-border px-2 py-1 text-left font-medium whitespace-nowrap text-muted-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={index}
                data-lit={props.lit?.row === index ? "" : undefined}
                className="data-[lit]:bg-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)]"
              >
                {props.columns.map((column) => (
                  <td
                    key={column}
                    className={cn(
                      "border-b border-border/60 px-2 py-1 whitespace-nowrap text-foreground",
                      props.lit?.row === index &&
                        props.lit.field === column &&
                        "font-medium text-[var(--color-text-accent)]",
                    )}
                  >
                    {row[column] === null || row[column] === undefined ? "" : String(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.count > rows.length ? (
        <p className="text-ui-xs text-muted-foreground">
          {props.copy.moreRows(rows.length, props.count)}
        </p>
      ) : null}
    </div>
  );
}

export function DashboardSourcesPanel(props: {
  readonly copy: DashboardCopy;
  readonly locale: string;
  readonly dashboard: DashboardItem;
  readonly sources: Readonly<Record<string, DashboardSourceState>>;
  readonly calcs: readonly DashboardCalcState[];
  readonly loaders: ReadonlyArray<{ id: string; description: string; code: string }>;
  readonly used: ReadonlySet<string>;
  readonly selected: string | null;
  readonly pick: DashboardPick | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onUpdates: (updates: DashboardUpdates) => void;
  readonly onSaveDataset: (id: string, dataset: DashboardDataset) => void;
  readonly onTest: (
    id: string,
    dataset: DashboardDataset,
  ) => Promise<{ ok: boolean; text: string }>;
  readonly onAskFix: (id: string, message: string) => void;
}) {
  const { copy } = props;
  const entries = useMemo(() => {
    const datasets: Entry[] = Object.entries(props.dashboard.datasets).map(([id, dataset]) => ({
      kind: "dataset",
      id,
      dataset,
      state: props.sources[id],
    }));
    const calcs: Entry[] = props.calcs.map((calc) => ({ kind: "calc", id: calc.id, calc }));
    return { datasets, calcs };
  }, [props.dashboard.datasets, props.sources, props.calcs]);
  const groups = useMemo(() => {
    const byConnector = new Map<string, Entry[]>();
    const files: Entry[] = [];
    for (const entry of entries.datasets) {
      if (entry.kind !== "dataset") continue;
      if (entry.dataset.source.kind === "file") files.push(entry);
      else {
        const name = entry.dataset.source.connector;
        byConnector.set(name, [...(byConnector.get(name) ?? []), entry]);
      }
    }
    return [
      ...[...byConnector.entries()].map(([name, list]) => ({
        key: `c:${name}`,
        label: name,
        icon: DatabaseIcon,
        list,
      })),
      ...(files.length
        ? [{ key: "files", label: copy.groupFiles, icon: FileIcon, list: files }]
        : []),
      ...(entries.calcs.length
        ? [{ key: "calcs", label: copy.groupCalcs, icon: CodeIcon, list: entries.calcs }]
        : []),
    ];
  }, [copy, entries]);

  const selectedEntry =
    props.selected === null
      ? null
      : (entries.datasets.find((entry) => entry.id === props.selected) ??
        entries.calcs.find((entry) => entry.id === props.selected) ??
        null);

  const updates = props.dashboard.settings.updates;
  const updatesLabel =
    typeof updates === "number"
      ? copy.minutesAfter(updates)
      : (copy.updates[updates] ?? copy.updates.viewed!);
  const footer = (
    <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-t border-border py-1 pr-2.5 pl-3.5 text-ui-sm text-muted-foreground">
      <span>{copy.refreshData}</span>
      {props.readOnly ? (
        <span>{updatesLabel}</span>
      ) : (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${copy.refreshData}：${updatesLabel}`}
                data-testid="dashboard-updates"
              >
                {updatesLabel}
                <ChevronDownIcon className="size-3.5" aria-hidden />
              </Button>
            }
          />
          <ComposerPickerMenuPopup align="end" side="top" className="w-48 min-w-48">
            <MenuGroup>
              <MenuGroupLabel>{copy.whenOpened}</MenuGroupLabel>
              <MenuRadioGroup
                value={String(updates)}
                onValueChange={(value) =>
                  props.onUpdates(
                    /^\d+$/u.test(String(value)) ? Number(value) : (value as DashboardUpdates),
                  )
                }
              >
                {(["viewed", "5min", "hour", "day", "week"] as const).map((choice) => (
                  <MenuRadioItem key={choice} value={choice}>
                    {copy.updates[choice]}
                  </MenuRadioItem>
                ))}
                {typeof updates === "number" ? (
                  <MenuRadioItem value={String(updates)}>
                    {copy.minutesAfter(updates)}
                  </MenuRadioItem>
                ) : null}
              </MenuRadioGroup>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      )}
    </div>
  );

  if (selectedEntry) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SourcePage {...props} entry={selectedEntry} />
        </div>
        {footer}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="dashboard-sources-list">
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-2">
        <p className="px-2 pt-1 pb-2 text-ui-sm text-muted-foreground">{copy.pickHint}</p>
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-ui-sm text-muted-foreground">{copy.noSources}</p>
        ) : null}
        {groups.map((group, index) => (
          <section
            key={group.key}
            className={cn("flex flex-col", index > 0 && "mt-3.5 border-t border-border pt-2")}
          >
            <div className="flex min-h-7 items-center gap-2 px-2 text-ui-sm">
              <span className="min-w-0 truncate font-medium text-foreground">{group.label}</span>
            </div>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {group.list.map((entry) => (
                <SourceRow key={entry.id} {...props} entry={entry} icon={group.icon} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {footer}
    </div>
  );
}

function SourceRow(
  props: Parameters<typeof DashboardSourcesPanel>[0] & { entry: Entry; icon: LucideIcon },
) {
  const { copy, entry } = props;
  const Icon = props.icon;
  const status = entryStatus(entry);
  const title = entry.kind === "calc" ? entry.calc.title : entry.dataset.title;
  const lit = props.pick?.source === entry.id;
  const dim = props.pick !== null && !lit;
  const unused = entry.kind === "dataset" && !props.used.has(entry.id) && status === "idle";
  const meta =
    entry.kind === "calc"
      ? entry.calc.rows.length
        ? copy.rows(entry.calc.rows.length)
        : copy.value
      : status === "ok"
        ? [
            entry.state?.count ? copy.rows(entry.state.count) : null,
            age(entry.state?.at ?? null, props.locale),
          ]
            .filter(Boolean)
            .join(" · ")
        : status === "error" || status === "declined" || status === "connect"
          ? copy.failed
          : unused
            ? copy.notUsed
            : status === "loading"
              ? copy.loading
              : copy.notLoaded;
  const failing = status === "error" || status === "declined";
  const message = entry.kind === "calc" ? entry.calc.message : (entry.state?.message ?? "");
  return (
    <li
      className={cn(
        "group relative rounded-row hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]",
        lit && "bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]",
        dim && "opacity-55",
      )}
      data-testid={`dashboard-source-${entry.id}`}
      data-light={lit ? "lit" : dim ? "dim" : undefined}
    >
      <Button
        variant="ghost"
        onClick={() => props.onSelect(entry.id)}
        className="h-8 w-full justify-start gap-1 rounded-row pr-2 pl-1 text-left font-normal hover:bg-transparent"
      >
        <StatusDot status={status} stale={entry.kind === "dataset" && isStale(entry.dataset)} />
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">{title}</span>
        <span
          className={cn(
            "shrink-0 text-ui-sm text-muted-foreground",
            failing && "group-hover:invisible",
          )}
        >
          {meta}
        </span>
      </Button>
      {failing && !props.readOnly ? (
        <Button
          size="xs"
          variant="secondary"
          className="absolute top-1 right-2 hidden group-hover:inline-flex"
          onClick={() => props.onAskFix(entry.id, message)}
        >
          {copy.askFix}
        </Button>
      ) : null}
    </li>
  );
}

function SourcePage(props: Parameters<typeof DashboardSourcesPanel>[0] & { entry: Entry }) {
  const { copy, entry } = props;
  const status = entryStatus(entry);
  const lit = props.pick?.source === entry.id ? props.pick : null;
  const title = entry.kind === "calc" ? entry.calc.title : entry.dataset.title;
  const description = entry.kind === "calc" ? entry.calc.description : entry.dataset.description;
  const message = entry.kind === "calc" ? entry.calc.message : (entry.state?.message ?? "");
  const loader = props.loaders.find((item) => item.id === entry.id);
  const columns = entry.kind === "calc" ? entry.calc.columns : (entry.state?.columns ?? []);
  const rows = entry.kind === "calc" ? entry.calc.rows : (entry.state?.rows ?? []);
  const count =
    entry.kind === "calc" ? entry.calc.rows.length : (entry.state?.count ?? rows.length);
  const download = () => {
    const csv = rowsToCsv(columns, rows);
    downloadBlob(
      new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }),
      `${title.replace(/[\\/:*?"<>|]+/gu, "_") || entry.id}.csv`,
    );
  };
  return (
    <div className="flex flex-col gap-3 px-3.5 pt-2 pb-4" data-testid="dashboard-source-page">
      <Button
        size="xs"
        variant="ghost"
        className="-ml-1.5 self-start text-muted-foreground"
        onClick={() => props.onSelect(null)}
      >
        <ArrowLeftIcon className="size-4" aria-hidden />
        {copy.back}
      </Button>
      <div className="flex flex-col gap-1">
        <h3 className="text-ui-lg font-medium text-foreground [overflow-wrap:anywhere]">{title}</h3>
        {description ? <p className="text-ui-sm text-muted-foreground">{description}</p> : null}
        {entry.kind === "dataset" ? (
          <p className="text-ui-xs text-muted-foreground">
            {entry.dataset.source.kind === "file"
              ? entry.dataset.updated
                ? copy.updatedAt(age(entry.dataset.updated.at, props.locale) ?? "")
                : copy.updatedUnknown
              : entry.state?.at
                ? copy.updatedAt(age(entry.state.at, props.locale) ?? "")
                : copy.notLoaded}
            {entry.dataset.schedule ? ` · ${entry.dataset.schedule}` : ""}
          </p>
        ) : null}
      </div>
      {(status === "error" || status === "declined" || status === "connect") && message ? (
        <div className="flex flex-col gap-1.5 rounded-card border border-border p-2.5" role="alert">
          <p className="text-ui text-foreground">{copy.failed}</p>
          <p className="text-ui-xs text-muted-foreground">{copy.whatError}</p>
          <pre className="max-h-60 overflow-auto rounded-control bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] px-2 py-1.5 font-mono text-chat-code whitespace-pre-wrap break-words">
            {message}
          </pre>
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void navigator.clipboard?.writeText(message)}
            >
              {copy.copyError}
            </Button>
            {!props.readOnly ? (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => props.onAskFix(entry.id, message)}
              >
                {copy.askFix}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col">
        {entry.kind === "dataset" && entry.dataset.source.kind === "call" ? (
          <QueryFold {...props} id={entry.id} dataset={entry.dataset} />
        ) : null}
        {entry.kind === "dataset" && entry.dataset.source.kind === "file" ? (
          <FileFold {...props} id={entry.id} dataset={entry.dataset} />
        ) : null}
        {entry.kind === "calc" ? (
          <Fold title={copy.formula} defaultOpen>
            <p className="mb-1.5 text-ui-sm text-muted-foreground">
              {copy.inputs}：{entry.calc.inputs.join("、") || "—"}
            </p>
            <CodeBlock text={entry.calc.code} />
          </Fold>
        ) : null}
        {loader ? (
          <Fold title={copy.transform}>
            {loader.description ? (
              <p className="mb-1.5 text-ui-sm text-muted-foreground">{loader.description}</p>
            ) : null}
            <CodeBlock text={loader.code} />
          </Fold>
        ) : null}
        <Fold title={copy.result} defaultOpen testId="dashboard-source-result">
          {entry.kind === "calc" &&
          entry.calc.rows.length === 0 &&
          entry.calc.value !== undefined ? (
            <CodeBlock text={JSON.stringify(entry.calc.value, null, 2)} />
          ) : (
            <ResultTable columns={columns} rows={rows} count={count} lit={lit} copy={copy} />
          )}
          {rows.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              className="mt-1.5 -ml-1.5 text-muted-foreground"
              onClick={download}
              data-testid="dashboard-download-csv"
            >
              <DownloadIcon className="size-4" aria-hidden />
              {copy.downloadCsv}
            </Button>
          ) : null}
        </Fold>
      </div>
    </div>
  );
}

function QueryFold(
  props: Parameters<typeof DashboardSourcesPanel>[0] & { id: string; dataset: DashboardDataset },
) {
  const { copy } = props;
  const source = props.dataset.source;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  if (source.kind !== "call") return null;
  const blanks = blanksOf(source.args);
  const parseArgs = () => {
    try {
      const args = JSON.parse(text) as unknown;
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args");
      setError(null);
      return { ...props.dataset, source: { ...source, args: args as Record<string, unknown> } };
    } catch {
      setError(copy.argsInvalid);
      return null;
    }
  };
  return (
    <Fold title={copy.query} defaultOpen>
      <div className="flex flex-col gap-2">
        <p className="text-ui-sm text-muted-foreground">
          {source.connector} · <span className="font-mono">{source.tool}</span>
        </p>
        {editing ? (
          <textarea
            aria-label={copy.editQuery}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={8}
            className="w-full resize-y rounded-card border border-border bg-background px-2.5 py-2 font-mono text-chat-code text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : null}
        {editing && props.dataset.saved?.length ? (
          <div className="flex flex-col gap-1" data-testid="dashboard-saved-queries">
            <p className="text-ui-xs text-muted-foreground">{copy.savedQueries}</p>
            {props.dataset.saved.map((entry) => (
              <div key={entry.at} className="flex items-center justify-between gap-2 text-ui-sm">
                <span className="truncate text-muted-foreground">
                  {new Date(entry.at).toLocaleString(
                    props.locale.startsWith("zh") ? "zh-CN" : "en",
                  )}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setText(JSON.stringify(entry.args, null, 2))}
                >
                  {copy.restoreQuery}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {editing ? null : (
          <div className="flex flex-col gap-1.5">
            {Object.entries(source.args).map(([name, value]) => (
              <div key={name} className="flex flex-col gap-0.5">
                <span className="text-ui-xs text-muted-foreground">
                  {name}
                  {props.dataset.langs?.[name] ? ` · ${props.dataset.langs[name]}` : ""}
                </span>
                <ArgumentText value={value} params={props.params} />
              </div>
            ))}
          </div>
        )}
        {blanks.length > 0 && !editing ? (
          <p className="text-ui-xs text-muted-foreground">
            {blanks
              .map((name) => `${name} = ${JSON.stringify(props.params[name] ?? "")}`)
              .join("，")}
          </p>
        ) : null}
        {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
        {test ? (
          <div className="flex flex-col gap-1">
            <p className="text-ui-xs text-muted-foreground">{copy.testResult}</p>
            <CodeBlock text={test.text} />
          </div>
        ) : null}
        {!props.readOnly ? (
          <div className="flex flex-wrap gap-1">
            {editing ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={async () => {
                    const next = parseArgs();
                    if (next) setTest(await props.onTest(props.id, next));
                  }}
                >
                  {copy.test}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                  {copy.cancel}
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    const next = parseArgs();
                    if (!next) return;
                    const at = new Date().toISOString();
                    // The arguments being replaced are kept, so they can be put back later.
                    props.onSaveDataset(props.id, {
                      ...next,
                      edit: { via: "person", at },
                      saved: [{ at, args: source.args }, ...(props.dataset.saved ?? [])].slice(
                        0,
                        5,
                      ),
                    });
                    setEditing(false);
                  }}
                >
                  {copy.save}
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                className="-ml-1.5"
                onClick={() => {
                  setText(JSON.stringify(source.args, null, 2));
                  setTest(null);
                  setEditing(true);
                }}
              >
                {copy.editQuery}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Fold>
  );
}

/** An argument with its filter blanks lit and their current values shown. */
function ArgumentText(props: { value: unknown; params: Readonly<Record<string, unknown>> }) {
  const raw = typeof props.value === "string" ? props.value : JSON.stringify(props.value, null, 2);
  const parts = raw.split(/(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/gu);
  return (
    <pre className="max-h-60 overflow-auto rounded-card border border-border bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] px-2.5 py-2 font-mono text-chat-code whitespace-pre-wrap break-words text-foreground">
      {parts.map((part, index) => {
        const name = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/u.exec(part)?.[1];
        return name ? (
          <span
            key={index}
            title={`${name} = ${JSON.stringify(props.params[name] ?? "")}`}
            className="rounded-inline bg-[color-mix(in_srgb,var(--color-text-accent)_12%,transparent)] text-[var(--color-text-accent)] underline underline-offset-3"
          >
            {part}
          </span>
        ) : (
          part
        );
      })}
    </pre>
  );
}

function FileFold(
  props: Parameters<typeof DashboardSourcesPanel>[0] & { id: string; dataset: DashboardDataset },
) {
  const { copy } = props;
  const source = props.dataset.source;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (source.kind !== "file") return null;
  const size = source.library ? source.library.size : new Blob([source.text]).size;
  const save = (nextText: string, name = source.name) => {
    const next: DashboardDataset = {
      ...props.dataset,
      source: {
        ...source,
        name,
        text: nextText,
        format: /\.tsv$/iu.test(name)
          ? "tsv"
          : /\.json$/iu.test(name)
            ? "json"
            : (source.format ?? "csv"),
      },
      updated: { at: new Date().toISOString(), by: copy.historyBy.me ?? "我" },
      edit: { via: "person", at: new Date().toISOString() },
    };
    try {
      if (next.source.kind === "file") readDatasetFile(next.source);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.saveFailed);
      return;
    }
    setError(null);
    props.onSaveDataset(props.id, next);
    setEditing(false);
  };
  return (
    <Fold title={copy.file} defaultOpen>
      <div className="flex flex-col gap-2">
        <p className="text-ui-sm text-foreground">
          {source.name}{" "}
          <span className="text-muted-foreground">
            · {(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB
          </span>
        </p>
        {editing ? (
          <textarea
            aria-label={copy.editFile}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={10}
            className="w-full resize-y rounded-card border border-border bg-background px-2.5 py-2 font-mono text-chat-code text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : null}
        {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
        {!props.readOnly ? (
          <div className="flex flex-wrap gap-1">
            {editing ? (
              <>
                <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                  {copy.cancel}
                </Button>
                <Button size="xs" variant="secondary" onClick={() => save(text)}>
                  {copy.save}
                </Button>
              </>
            ) : (
              <>
                {source.library ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="-ml-1.5"
                    onClick={() => {
                      setText(source.text);
                      setEditing(true);
                    }}
                  >
                    {copy.editFile}
                  </Button>
                )}
                <label className="inline-flex">
                  <input
                    type="file"
                    accept=".csv,.tsv,.json,text/csv,application/json"
                    className="sr-only"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      if (file.size > DASHBOARD_LIBRARY_FILE_MAX_BYTES)
                        return setError(copy.fileTooLarge);
                      const buffer = await file.arrayBuffer();
                      let decoded: string;
                      try {
                        decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
                      } catch {
                        return setError(copy.fileNotUtf8);
                      }
                      const name = file.name.slice(0, 200);
                      if (file.size <= DASHBOARD_INLINE_FILE_MAX_BYTES) return save(decoded, name);
                      // Larger files go to the 资料库; the dashboard keeps only where it is.
                      try {
                        readDatasetFile({ kind: "file", name, text: decoded });
                        const result = await uploadLibraryFiles([
                          { name, data: file, ...(file.type ? { mimeType: file.type } : {}) },
                        ]);
                        const item = result.items[0];
                        if (!item) throw new Error(copy.saveFailed);
                        setError(null);
                        props.onSaveDataset(props.id, {
                          ...props.dataset,
                          source: {
                            kind: "file",
                            name,
                            format: /\.tsv$/iu.test(name)
                              ? "tsv"
                              : /\.json$/iu.test(name)
                                ? "json"
                                : "csv",
                            text: "",
                            library: { itemId: item.id, size: file.size },
                          },
                          updated: { at: new Date().toISOString(), by: copy.historyBy.me ?? "我" },
                          edit: { via: "person", at: new Date().toISOString() },
                        });
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : copy.saveFailed);
                      }
                    }}
                  />
                  <span className="inline-flex h-6 cursor-pointer items-center rounded-control-xs px-2 text-ui-sm text-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]">
                    {copy.replaceFile}
                  </span>
                </label>
              </>
            )}
          </div>
        ) : null}
        <p className="text-ui-xs text-muted-foreground">
          {source.library ? copy.fileInLibrary : copy.fileHint}
        </p>
      </div>
    </Fold>
  );
}
