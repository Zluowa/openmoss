// FILE: useDashboardRuntime.ts
// Purpose: Runs one 数据看板 view: opens the sandboxed frame with the page, answers the page's
//          data reads (attached files here, live queries through the server), keeps filter
//          values for this view, and collects what the page reports (faults, rows, calcs,
//          loaders, picks, anchors, page text) for the editor's panels and for Moss.
// Layer: Web 资料空间 数据看板 host
// Spec: docs/design/data-claude-teardown.md §7

import type { PageId, SpaceId } from "@moss/contracts";
import {
  fillCallArgs,
  readDatasetFile,
  type DashboardItem,
  type DashboardLook,
  type DashboardParamValue,
  type DashboardUpdates,
} from "@moss/shared/spaceItems/dashboard";
import {
  buildDashboardFrameDocument,
  DASHBOARD_FRAME_PROTOCOL,
  dashboardThemeCss,
  type DashboardFrameMessage,
  type DashboardHostMessage,
  type FrameRect,
} from "@moss/shared/spaceItems/dashboardFrame";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";

export type DashboardSourceStatus = "idle" | "loading" | "ok" | "error" | "connect" | "declined";

export interface DashboardSourceState {
  readonly status: DashboardSourceStatus;
  readonly message: string;
  readonly at: number | null;
  readonly refreshing: boolean;
  readonly args?: Record<string, unknown>;
  /** What the page ended with after its loader (from the frame). */
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly count: number;
  readonly value?: unknown;
}

export interface DashboardCalcState {
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
}

export interface DashboardPick {
  readonly source: string;
  readonly field: string | null;
  readonly row: number | null;
  readonly text: string;
}

export type DashboardFrameStatus = "loading" | "ready" | "timeout";

const FRAME_TIMEOUT_MS = 15_000;
let d3Text: Promise<string> | null = null;
function loadD3(): Promise<string> {
  d3Text ??= fetch(
    new URL(`${import.meta.env.BASE_URL}inline-visualization-libs/d3.min.js`, window.location.href),
  ).then((response) => {
    if (!response.ok) throw new Error("d3 unavailable");
    return response.text();
  });
  d3Text.catch(() => {
    d3Text = null;
  });
  return d3Text;
}

/** Minutes an answer may be reused when the dashboard opens. */
export function updatesMinutes(updates: DashboardUpdates): number {
  if (typeof updates === "number") return updates;
  return { viewed: 0, "5min": 5, hour: 60, day: 1440, week: 10080 }[updates] ?? 0;
}

/** 资料库 files read in this app session, by item id. */
const libraryText = new Map<string, string>();

/** Answers kept for this app session, keyed by item, dataset and filled arguments. */
const answerCache = new Map<string, { at: number; answer: unknown }>();
const MAX_CACHE = 200;

const idle = (): DashboardSourceState => ({
  status: "idle",
  message: "",
  at: null,
  refreshing: false,
  columns: [],
  rows: [],
  count: 0,
});

export function useDashboardRuntime(props: {
  readonly scopeSpaceId: SpaceId | null;
  readonly pageId: PageId;
  readonly revision: number;
  readonly dashboard: DashboardItem;
  readonly theme: "light" | "dark";
  readonly edit: boolean;
  readonly pick: boolean;
  readonly comment: boolean;
  readonly onSerialized: (html: string) => void;
  /** A look being tweaked: shown live, not saved. */
  readonly lookOverride?: DashboardLook | null;
  /** The view shows the draft: its changed sources run as the draft has them. */
  readonly draft?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<DashboardFrameStatus>("loading");
  const [sources, setSources] = useState<Record<string, DashboardSourceState>>({});
  const [calcs, setCalcs] = useState<DashboardCalcState[]>([]);
  const [loaders, setLoaders] = useState<Array<{ id: string; description: string; code: string }>>(
    [],
  );
  const [faults, setFaults] = useState<Array<{ where: string; message: string }>>([]);
  const [pick, setPick] = useState<DashboardPick | null>(null);
  const [anchor, setAnchor] = useState<{ id: string; label: string; rect: FrameRect } | null>(null);
  const [rects, setRects] = useState<Record<string, FrameRect>>({});
  const [selection, setSelection] = useState<{ text: string; at: string | null } | null>(null);
  const [edits, setEdits] = useState(0);
  const [pageText, setPageText] = useState<{ html: string; width: number } | null>(null);
  const [params, setParamsState] = useState<Record<string, DashboardParamValue>>(() => ({
    ...props.dashboard.params,
  }));
  const used = useRef(new Set<string>());
  const nonceRef = useRef("");
  const latest = useRef(props);
  latest.current = props;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const send = useCallback((message: DashboardHostMessage) => {
    frame.current?.contentWindow?.postMessage(
      { protocol: DASHBOARD_FRAME_PROTOCOL, nonce: nonceRef.current, ...message },
      "*",
    );
  }, []);

  // Defaults changed by Moss (or a reset) take over this view's values.
  const defaultsJson = JSON.stringify(props.dashboard.params);
  useEffect(() => {
    setParamsState({ ...latest.current.dashboard.params });
  }, [defaultsJson]);

  const patchSource = useCallback((id: string, patch: Partial<DashboardSourceState>) => {
    setSources((current) => ({ ...current, [id]: { ...(current[id] ?? idle()), ...patch } }));
  }, []);

  /** Loads one dataset and hands it to the page. */
  const load = useCallback(
    async (id: string, options: { force?: boolean } = {}) => {
      const { dashboard, pageId, scopeSpaceId } = latest.current;
      const dataset = dashboard.datasets[id];
      if (!dataset) return;
      const source = dataset.source;
      if (source.kind === "file") {
        try {
          // A large file lives in the 资料库; the server reads it by id.
          let fileText = source.text;
          if (source.library) {
            const cached = libraryText.get(source.library.itemId);
            if (cached !== undefined && !options.force) fileText = cached;
            else {
              patchSource(id, { status: "loading", refreshing: true });
              send({ kind: "data", id, status: "loading", refreshing: true });
              const result = await ensureNativeApi().pageTypes.dashboard.query({
                scopeSpaceId,
                pageId,
                datasetId: id,
                params: {},
                ...(latest.current.draft ? { draft: true } : {}),
              });
              if (result.status !== "ok" || typeof result.answer !== "string")
                throw new Error(result.message ?? "文件读不出来");
              fileText = result.answer;
              libraryText.set(source.library.itemId, fileText);
              if (libraryText.size > 20) libraryText.delete(libraryText.keys().next().value!);
            }
          }
          const read = readDatasetFile({ ...source, text: fileText });
          patchSource(id, { status: "ok", message: "", at: Date.now(), refreshing: false });
          send({
            kind: "data",
            id,
            status: "ok",
            rows: read.rows,
            columns: read.columns,
            ...(read.value !== undefined ? { value: read.value } : {}),
            answer: fileText,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "文件读不出来";
          patchSource(id, { status: "error", message, refreshing: false });
          send({ kind: "data", id, status: "error", message });
        }
        return;
      }
      const filled = fillCallArgs(source, paramsRef.current);
      if ("error" in filled) {
        patchSource(id, { status: "error", message: filled.error, refreshing: false });
        send({ kind: "data", id, status: "error", message: filled.error });
        return;
      }
      const key = JSON.stringify([
        pageId,
        id,
        source.connector,
        source.tool,
        filled.args,
        latest.current.draft === true,
      ]);
      const windowMs = updatesMinutes(dashboard.settings.updates) * 60_000;
      const cached = answerCache.get(key);
      if (
        !options.force &&
        cached &&
        (windowMs > 0 ? Date.now() - cached.at < windowMs : used.current.has(`${key}#seen`))
      ) {
        patchSource(id, {
          status: "ok",
          message: "",
          at: cached.at,
          refreshing: false,
          args: filled.args,
        });
        send({
          kind: "data",
          id,
          status: "ok",
          answer: cached.answer,
          args: filled.args,
          ...rowsOfAnswer(cached.answer),
        });
        return;
      }
      patchSource(id, { status: "loading", refreshing: true, args: filled.args });
      send({ kind: "data", id, status: "loading", refreshing: true });
      try {
        const result = await ensureNativeApi().pageTypes.dashboard.query({
          scopeSpaceId,
          pageId,
          datasetId: id,
          params: paramsRef.current as Record<string, unknown>,
          ...(latest.current.draft ? { draft: true } : {}),
        });
        if (latest.current.pageId !== pageId) return;
        if (result.status !== "ok") {
          patchSource(id, {
            status: result.status,
            message: result.message ?? "",
            refreshing: false,
          });
          send({ kind: "data", id, status: result.status, message: result.message ?? "" });
          return;
        }
        answerCache.set(key, { at: Date.now(), answer: result.answer });
        used.current.add(`${key}#seen`);
        if (answerCache.size > MAX_CACHE) answerCache.delete(answerCache.keys().next().value!);
        patchSource(id, {
          status: "ok",
          message: "",
          at: Date.now(),
          refreshing: false,
          args: filled.args,
        });
        send({
          kind: "data",
          id,
          status: "ok",
          answer: result.answer,
          args: filled.args,
          ...rowsOfAnswer(result.answer),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "这个数据来源没载入";
        patchSource(id, { status: "error", message, refreshing: false });
        send({ kind: "data", id, status: "error", message });
      }
    },
    [patchSource, send],
  );

  const onFrameMessage = useCallback(
    (message: DashboardFrameMessage) => {
      switch (message.kind) {
        case "boot":
          setStatus("ready");
          send({ kind: "mode", pick: latest.current.pick, comment: latest.current.comment });
          // Files are cheap: hand them over at once, so calcs over them settle.
          for (const [id, dataset] of Object.entries(latest.current.dashboard.datasets))
            if (dataset.source.kind === "file") void load(id);
          break;
        case "use":
          for (const id of message.ids) {
            if (used.current.has(id)) continue;
            used.current.add(id);
            if (latest.current.dashboard.datasets[id]?.source.kind === "call") void load(id);
          }
          break;
        case "setParams":
          setParamsState((current) => ({
            ...current,
            ...(message.params as Record<string, DashboardParamValue>),
          }));
          break;
        case "resetParams":
          setParamsState({ ...latest.current.dashboard.params });
          break;
        case "refresh":
          void load(message.id, { force: true });
          break;
        case "calcs":
          setCalcs([...message.calcs]);
          break;
        case "loaders":
          setLoaders([...message.loaders]);
          break;
        case "rows":
          patchSource(message.id, {
            columns: message.columns,
            rows: message.rows,
            count: message.count,
            ...(message.value !== undefined ? { value: message.value } : {}),
          });
          break;
        case "faults":
          setFaults([...message.faults]);
          break;
        case "pick":
          setPick(message);
          break;
        case "anchor":
          setAnchor(message);
          break;
        case "rects":
          setRects({ ...message.rects });
          break;
        case "page":
          setPageText({ html: message.html, width: message.width });
          break;
        case "selection":
          setSelection(message.text ? { text: message.text, at: message.at } : null);
          break;
        case "edited":
          setEdits(message.count);
          break;
        case "serialized":
          latest.current.onSerialized(message.html);
          break;
        case "call": {
          // A loader's next page or running query: same connector, read-only, via the server.
          const { pageId, scopeSpaceId } = latest.current;
          void ensureNativeApi()
            .pageTypes.dashboard.query({
              scopeSpaceId,
              pageId,
              datasetId: message.id,
              params: paramsRef.current as Record<string, unknown>,
              call: { tool: message.tool, args: message.args as Record<string, unknown> },
              ...(latest.current.draft ? { draft: true } : {}),
            })
            .then(
              (result) =>
                send(
                  result.status === "ok"
                    ? { kind: "callResult", ref: message.ref, answer: result.answer }
                    : {
                        kind: "callResult",
                        ref: message.ref,
                        error: result.message ?? "调用没成功",
                      },
                ),
              (error: unknown) =>
                send({
                  kind: "callResult",
                  ref: message.ref,
                  error: error instanceof Error ? error.message : "调用没成功",
                }),
            );
          break;
        }
        case "link":
          break;
      }
    },
    [load, patchSource, send],
  );

  // A new frame whenever the page, the look or the edit mode changes.
  const filesJson = JSON.stringify(props.dashboard.files);
  const lookJson = JSON.stringify(props.dashboard.look ?? null);
  const datasetIds = Object.keys(props.dashboard.datasets).join(",");
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const nonce = crypto.randomUUID();
    nonceRef.current = nonce;
    used.current = new Set();
    setStatus("loading");
    setFaults([]);
    setCalcs([]);
    setLoaders([]);
    setEdits(0);
    setSources((current) =>
      Object.fromEntries(
        Object.keys(latest.current.dashboard.datasets).map((id) => [
          id,
          { ...(current[id] ?? idle()), status: "idle" as const },
        ]),
      ),
    );
    const url = new URL(
      `${import.meta.env.BASE_URL}space-dashboard-frame.html`,
      window.location.href,
    );
    url.searchParams.set("frame", nonce);
    url.hash = new URLSearchParams({
      protocol: DASHBOARD_FRAME_PROTOCOL,
      nonce,
      parentOrigin: window.location.origin,
    }).toString();
    let sentDocument = false;
    const receive = (event: MessageEvent) => {
      if (event.source !== element.contentWindow || event.origin !== "null") return;
      const data = event.data as { protocol?: string; nonce?: string; kind?: string } | null;
      if (!data || data.protocol !== DASHBOARD_FRAME_PROTOCOL || data.nonce !== nonce) return;
      if (data.kind === "ready" && !sentDocument) {
        sentDocument = true;
        void loadD3()
          .catch(() => "")
          .then((d3) => {
            if (nonceRef.current !== nonce) return;
            const html = buildDashboardFrameDocument({
              nonce,
              item: latest.current.dashboard,
              d3,
              mode: latest.current.theme,
              ...(latest.current.lookOverride ? { look: latest.current.lookOverride } : {}),
              params: paramsRef.current,
              edit: latest.current.edit,
            });
            element.contentWindow?.postMessage(
              { protocol: DASHBOARD_FRAME_PROTOCOL, nonce, kind: "document", html },
              "*",
            );
          });
        return;
      }
      if (data.kind === "boot") clearTimeout(timer);
      onFrameMessage(data as DashboardFrameMessage);
    };
    window.addEventListener("message", receive);
    const timer = setTimeout(
      () => setStatus((current) => (current === "loading" ? "timeout" : current)),
      FRAME_TIMEOUT_MS,
    );
    element.src = url.href;
    return () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      if (element.getAttribute("src") === url.href) element.src = "about:blank";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesJson, lookJson, datasetIds, props.edit, props.revision, epoch]);

  const shownLook = props.lookOverride ?? props.dashboard.look;
  const shownLookJson = JSON.stringify(shownLook ?? null);
  useEffect(() => {
    if (status === "ready")
      send({ kind: "theme", css: dashboardThemeCss(props.dashboard, shownLook, props.theme) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.theme, status, shownLookJson]);
  useEffect(() => {
    if (status === "ready") send({ kind: "mode", pick: props.pick, comment: props.comment });
  }, [props.pick, props.comment, send, status]);

  // A changed filter value: tell the page, then run again only the queries that name it.
  const paramsJson = JSON.stringify(params);
  const previousParams = useRef(paramsJson);
  useEffect(() => {
    if (status !== "ready") return;
    send({ kind: "params", params });
    if (previousParams.current === paramsJson) return;
    const before = JSON.parse(previousParams.current) as Record<string, unknown>;
    previousParams.current = paramsJson;
    const changed = new Set(
      Object.keys({ ...before, ...params }).filter(
        (key) => JSON.stringify(before[key]) !== JSON.stringify(params[key]),
      ),
    );
    for (const [id, dataset] of Object.entries(latest.current.dashboard.datasets)) {
      if (dataset.source.kind !== "call" || !used.current.has(id)) continue;
      const names =
        JSON.stringify(dataset.source.args).match(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu) ?? [];
      if (names.some((name) => changed.has(name.replace(/[{}\s]/gu, "")))) void load(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsJson, status]);

  const refreshAll = useCallback(() => {
    for (const id of used.current)
      if (latest.current.dashboard.datasets[id]) void load(id, { force: true });
    for (const [id, dataset] of Object.entries(latest.current.dashboard.datasets))
      if (dataset.source.kind === "file") void load(id, { force: true });
  }, [load]);

  const usedIds = useMemo(() => used.current, [sources]);
  return {
    frame,
    status,
    sources,
    calcs,
    loaders,
    faults,
    pick,
    clearPick: () => setPick(null),
    anchor,
    clearAnchor: () => setAnchor(null),
    rects,
    selection,
    edits,
    pageText,
    params,
    resetParams: () => setParamsState({ ...latest.current.dashboard.params }),
    used: usedIds,
    send,
    load,
    refreshAll,
    reload: () => setEpoch((value) => value + 1),
  };
}

/** Rows an answer gives as it comes; anything else goes to the page as the answer. */
function rowsOfAnswer(answer: unknown): { rows?: Array<Record<string, unknown>>; value?: unknown } {
  const list = Array.isArray(answer)
    ? answer
    : answer && typeof answer === "object"
      ? [
          (answer as Record<string, unknown>).rows,
          (answer as Record<string, unknown>).data,
          (answer as Record<string, unknown>).results,
        ].find(Array.isArray)
      : undefined;
  if (
    Array.isArray(list) &&
    list.every((row) => row && typeof row === "object" && !Array.isArray(row))
  )
    return { rows: list as Array<Record<string, unknown>> };
  return { value: answer };
}
