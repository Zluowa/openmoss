// FILE: SpaceTypedItemView.tsx
// Purpose: Opens a typed 资料空间 item (幻灯片, 电子表格, 白板, 应用页): loads its payload,
//          shows the editor for its kind, and saves edits against the item's revision.
// Layer: 资料空间 types stream. space-ui's page view renders this for typed kinds.
// Why: Every typed editor is a plain value editor; saving, retry, conflicts, the title and
//      "存为模板" are decided here once.

import type { PageId, PageTypedItem, SpaceId } from "@moss/contracts";
import { parseSheetWorkbook, type SheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";
import { parseSlidesDeck, type SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";
import { TemplateGridIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { AppItemView } from "./app/AppItemView";
import { BoardItemView } from "./board/BoardItemView";
import { DeckEditorHost } from "./slides/DeckEditorHost";
import { pageTypesQueryKeys } from "./spaceItemTypes";

const SheetEditorHost = lazy(() =>
  import("./sheet/SheetEditorHost").then((module) => ({ default: module.SheetEditorHost })),
);

const SAVE_DELAY_MS = 700;
type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";
const SAVE_LABELS: Record<SaveState, string> = {
  saved: "已保存",
  dirty: "未保存",
  saving: "正在保存…",
  failed: "保存失败，正在重试",
  conflict: "内容在别处被修改，已载入最新版本",
};

export function SpaceTypedItemView(props: {
  account: string;
  scopeSpaceId: SpaceId | null;
  pageId: PageId;
  readOnly?: boolean;
  /** Called after a save so lists and cards refresh. */
  onSaved?: (item: PageTypedItem) => void;
  /** Registered while edits are unsaved; resolves false if the user should stay. */
  onGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
  /** Hide the built-in title row when the host page chrome shows the title. */
  hideHeader?: boolean;
}) {
  const query = useQuery({
    queryKey: pageTypesQueryKeys.item(props.account, props.scopeSpaceId, props.pageId),
    queryFn: () =>
      ensureNativeApi().pageTypes.read({ scopeSpaceId: props.scopeSpaceId, pageId: props.pageId }),
    staleTime: Infinity,
  });
  if (query.error && !query.data) {
    return (
      <div role="alert" className="p-8">
        {query.error.message}
        <Button variant="ghost" onClick={() => void query.refetch()}>
          重新加载
        </Button>
      </div>
    );
  }
  if (!query.data) {
    return (
      <p role="status" className="p-8 text-muted-foreground">
        正在打开…
      </p>
    );
  }
  return <TypedItemEditor key={`${query.data.page.id}`} {...props} item={query.data} />;
}

function TypedItemEditor(
  props: Parameters<typeof SpaceTypedItemView>[0] & { item: PageTypedItem },
) {
  const client = useQueryClient();
  const queryKey = pageTypesQueryKeys.item(props.account, props.scopeSpaceId, props.pageId);
  const [item, setItem] = useState(props.item);
  const [draft, setDraft] = useState(props.item.data ?? "");
  const [title, setTitle] = useState(props.item.page.title);
  const [state, setState] = useState<SaveState>("saved");
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  // Bumped when the payload is replaced from outside the editor (import, conflict reload).
  const [epoch, setEpoch] = useState(0);
  const latest = useRef({
    draft,
    title,
    revision: item.page.revision,
    savedDraft: draft,
    savedTitle: title,
  });
  const flight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readOnly = props.readOnly || item.page.trashedAt !== null;

  const save = useCallback((): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (flight.current) return flight.current.then(() => save());
    const snapshot = { ...latest.current };
    if (snapshot.draft === snapshot.savedDraft && snapshot.title === snapshot.savedTitle)
      return Promise.resolve(true);
    setState("saving");
    const run = ensureNativeApi()
      .pageTypes.save({
        requestId: `space-save:${crypto.randomUUID()}`,
        scopeSpaceId: props.scopeSpaceId,
        pageId: props.pageId,
        expectedRevision: snapshot.revision,
        data: snapshot.draft,
        ...(snapshot.title.trim() && snapshot.title !== snapshot.savedTitle
          ? { title: snapshot.title.trim().slice(0, 256) }
          : {}),
      })
      .then(
        (saved) => {
          latest.current = {
            ...latest.current,
            revision: saved.page.revision,
            savedDraft: snapshot.draft,
            savedTitle: snapshot.title,
          };
          setItem(saved);
          client.setQueryData(queryKey, saved);
          props.onSaved?.(saved);
          const clean =
            latest.current.draft === snapshot.draft && latest.current.title === snapshot.title;
          setState(clean ? "saved" : "dirty");
          return true;
        },
        async (error: unknown) => {
          const code = (error as { code?: string }).code;
          if (code === "conflict") {
            // Someone (often an agent) saved first: take theirs rather than overwrite it.
            const fresh = await ensureNativeApi().pageTypes.read({
              scopeSpaceId: props.scopeSpaceId,
              pageId: props.pageId,
            });
            latest.current = {
              draft: fresh.data ?? "",
              title: fresh.page.title,
              revision: fresh.page.revision,
              savedDraft: fresh.data ?? "",
              savedTitle: fresh.page.title,
            };
            setItem(fresh);
            setDraft(fresh.data ?? "");
            setTitle(fresh.page.title);
            setEpoch((value) => value + 1);
            client.setQueryData(queryKey, fresh);
            setState("conflict");
            return false;
          }
          setState(code === "invalid" ? "failed" : "failed");
          if (code !== "invalid") timer.current = setTimeout(() => void save(), 3_000);
          return false;
        },
      )
      .finally(() => {
        flight.current = null;
      });
    flight.current = run;
    return run;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pageId, props.scopeSpaceId]);

  const schedule = useCallback(() => {
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [save]);

  const change = useCallback(
    (next: string) => {
      if (next === latest.current.draft) return;
      latest.current.draft = next;
      setDraft(next);
      schedule();
    },
    [schedule],
  );

  useEffect(() => {
    props.onGuardChange?.(() => save());
    return () => {
      props.onGuardChange?.(null);
      void save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save]);

  /** Takes a newer revision someone else saved (an agent filling the deck), unless edits are pending. */
  const reloadIfChanged = useCallback(async (): Promise<boolean> => {
    const pending =
      latest.current.draft !== latest.current.savedDraft ||
      latest.current.title !== latest.current.savedTitle ||
      flight.current !== null;
    if (pending) return false;
    const fresh = await ensureNativeApi().pageTypes.read({
      scopeSpaceId: props.scopeSpaceId,
      pageId: props.pageId,
    });
    if (fresh.page.revision <= latest.current.revision) return false;
    latest.current = {
      draft: fresh.data ?? "",
      title: fresh.page.title,
      revision: fresh.page.revision,
      savedDraft: fresh.data ?? "",
      savedTitle: fresh.page.title,
    };
    setItem(fresh);
    setDraft(fresh.data ?? "");
    setTitle(fresh.page.title);
    setEpoch((value) => value + 1);
    client.setQueryData(queryKey, fresh);
    props.onSaved?.(fresh);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pageId, props.scopeSpaceId]);

  const saveAsTemplate = async () => {
    setTemplateNote(null);
    if (!(await save())) return;
    try {
      const template = await ensureNativeApi().pageTypes.templates.save({
        requestId: `space-template:${crypto.randomUUID()}`,
        scopeSpaceId: props.scopeSpaceId,
        pageId: props.pageId,
        title: latest.current.title.trim() || "我的模板",
      });
      void client.invalidateQueries({
        queryKey: pageTypesQueryKeys.templates(props.account, props.scopeSpaceId),
      });
      setTemplateNote(`已存为模板“${template.title}”`);
    } catch (error) {
      setTemplateNote(error instanceof Error ? error.message : "无法存为模板");
    }
  };

  const deck = useMemo<SlidesDeck | null>(() => {
    if (item.kind !== "slides") return null;
    try {
      return parseSlidesDeck(draft);
    } catch {
      return null;
    }
  }, [draft, item.kind]);
  const workbook = useMemo<SheetWorkbook | null>(() => {
    if (item.kind !== "sheet") return null;
    try {
      return parseSheetWorkbook(draft);
    } catch {
      return null;
    }
    // The sheet engine owns live state; only a replaced payload re-seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, item.kind]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-typed-item={item.kind}>
      {props.hideHeader ? null : (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <input
            aria-label="标题"
            value={title}
            readOnly={readOnly}
            maxLength={256}
            onChange={(event) => {
              setTitle(event.target.value);
              latest.current.title = event.target.value;
              if (event.target.value.trim()) schedule();
            }}
            className="min-w-0 flex-1 truncate bg-transparent text-ui-lg font-medium outline-none"
          />
          {templateNote ? (
            <span className="text-ui-sm text-muted-foreground">{templateNote}</span>
          ) : null}
          <span role="status" className="text-ui-sm text-muted-foreground" data-save-state={state}>
            {readOnly ? "只读" : SAVE_LABELS[state]}
          </span>
          {readOnly || item.kind === "board" ? null : (
            <Button size="xs" variant="ghost" onClick={() => void saveAsTemplate()}>
              <TemplateGridIcon /> 存为模板
            </Button>
          )}
        </div>
      )}
      {item.kind === "slides" && deck ? (
        <DeckEditorHost
          account={props.account}
          scopeSpaceId={props.scopeSpaceId}
          item={item}
          deck={deck}
          title={title}
          readOnly={readOnly}
          epoch={epoch}
          onChange={(next) => change(JSON.stringify(next))}
          onReplace={(next) => {
            change(JSON.stringify(next));
            setEpoch((value) => value + 1);
          }}
          onTitle={(next) => {
            setTitle(next);
            latest.current.title = next;
            if (next.trim()) schedule();
          }}
          flush={save}
          revision={() => latest.current.revision}
          reloadIfChanged={reloadIfChanged}
          saveState={state}
        />
      ) : item.kind === "sheet" && workbook ? (
        <Suspense fallback={<p className="p-8 text-muted-foreground">正在载入表格…</p>}>
          <SheetEditorHost
            account={props.account}
            item={item}
            workbook={workbook}
            title={title}
            readOnly={readOnly}
            epoch={epoch}
            onChange={(next) => change(JSON.stringify(next))}
            onReplace={(next) => {
              change(JSON.stringify(next));
              setEpoch((value) => value + 1);
            }}
            flush={save}
            revision={() => latest.current.revision}
            reloadIfChanged={reloadIfChanged}
          />
        </Suspense>
      ) : item.kind === "board" && item.data ? (
        <BoardItemView data={item.data} />
      ) : item.kind === "app" && item.data ? (
        <AppItemView
          pageId={item.page.id}
          revision={item.page.revision}
          dataRevision={item.dataRevision}
          title={title}
          data={item.data}
        />
      ) : (
        <p role="alert" className="p-8 text-destructive">
          这个条目的内容无法打开。
        </p>
      )}
    </div>
  );
}
