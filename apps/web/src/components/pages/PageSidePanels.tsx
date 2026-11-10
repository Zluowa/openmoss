// FILE: PageSidePanels.tsx
// Purpose: The panels a page opens to its right: 历史 (versions), 评论, 页面动态 (who changed
//          what, with comments), 文件列表 (linked Library files) and 页面导航 (outline and
//          subpages).
// Layer: Space page UI
// Why the history list asks for summaries: a rich page with pictures can be megabytes per
//      version, and the old panel waited for 30 full bodies before it drew anything — the
//      "正在加载…" that never finished. The list is metadata only, 20 at a time; one version's
//      body is read when it is opened.

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { LibraryItem, Page, PageId, PageVersion, SpaceId } from "@moss/contracts";

import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/localization";
import type { PageCommentFeedItem } from "~/lib/pageCommentFeed";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { formatRelativeTime } from "../space/spaceItems";
import { Button } from "../ui/button";
import { guestCommentAuthorLabel } from "./sharing/pageSharing.logic";

const HISTORY_PAGE_SIZE = 20;
/** After this long without an answer the panel offers a retry instead of spinning forever. */
const STALLED_AFTER_MS = 12_000;

const OPERATION_LABELS: Record<string, string> = {
  create: "创建了页面",
  "create-space": "创建了资料空间",
  update: "编辑了内容",
  move: "移动了页面",
  pin: "更改了置顶",
  trash: "移到回收站",
  "trash-space": "把资料空间移到回收站",
  restore: "从回收站恢复",
  "restore-space": "恢复了资料空间",
  "restore-version": "恢复了旧版本",
  comment: "添加了评论",
};

export function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? "更新了页面";
}

function authorLabel(author: PageVersion["author"], guestLabel: string): string {
  return author === "guest" ? guestLabel : author === "agent" ? "助手" : "你";
}

function versionActivity(version: PageVersion, translation: ReturnType<typeof useTranslation>) {
  if (!version.contributors) {
    const author = authorLabel(version.author, translation.t("chat.guestShare.guestFallbackName"));
    return `${author} ${operationLabel(version.operation)} · ${translation.t("page.history.legacySources")}`;
  }
  const keys = {
    "local-user": "page.history.localSource",
    agent: "page.history.agentSource",
    guest: "page.history.guestSource",
    unrecorded: "page.history.unrecordedSource",
  } as const;
  const categories = Array.from(new Set(version.contributors.map((source) => source.kind)));
  const sources = new Intl.ListFormat(translation.locale, {
    style: "short",
    type: "conjunction",
  }).format(categories.map((category) => translation.t(keys[category])));
  if (categories.length === 1 && categories[0] === "unrecorded") return sources;
  return translation.format(
    version.contributors.length > 1
      ? "page.history.collaborativeSources"
      : "page.history.editedBySource",
    { sources },
  );
}

function useStalled(active: boolean): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!active) {
      setStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return stalled;
}

export function useVersionSummaries(input: {
  account: string;
  scopeSpaceId: SpaceId | null;
  pageId: PageId;
  revision: number;
  enabled: boolean;
}) {
  return useInfiniteQuery({
    queryKey: [
      ...pagesQueryKeys.read(input.account, input.scopeSpaceId, input.pageId),
      "version-summaries",
      input.revision,
    ],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      ensureNativeApi().pages.versions({
        scopeSpaceId: input.scopeSpaceId,
        pageId: input.pageId,
        summaryOnly: true,
        limit: HISTORY_PAGE_SIZE,
        ...(pageParam === undefined ? {} : { beforeRevision: pageParam }),
      }),
    getNextPageParam: (last) =>
      last.versions.length < HISTORY_PAGE_SIZE ? undefined : last.versions.at(-1)?.page.revision,
    enabled: input.enabled,
    retry: 1,
  });
}

function PanelStatus(props: {
  error: Error | null;
  loading: boolean;
  onRetry: () => void;
  loadingLabel?: string;
  retryLabel?: string;
}) {
  const stalled = useStalled(props.loading);
  if (props.error)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-ui-sm text-destructive">
        <p>{props.error.message || "加载失败"}</p>
        <Button size="xs" variant="ghost" onClick={props.onRetry}>
          {props.retryLabel ?? "重试"}
        </Button>
      </div>
    );
  if (!props.loading) return null;
  return (
    <div role="status" className="flex flex-col items-start gap-2 text-ui-sm text-muted-foreground">
      <p>{props.loadingLabel ?? (stalled ? "加载时间比平时长。" : "正在加载…")}</p>
      {stalled ? (
        <Button size="xs" variant="ghost" onClick={props.onRetry}>
          {props.retryLabel ?? "重试"}
        </Button>
      ) : null}
    </div>
  );
}

export function PageHistoryPanel(props: {
  account: string;
  scopeSpaceId: SpaceId | null;
  page: Page;
  busy: boolean;
  onRestore: (revision: number) => Promise<void>;
}) {
  const translation = useTranslation();
  const versions = useVersionSummaries({
    account: props.account,
    scopeSpaceId: props.scopeSpaceId,
    pageId: props.page.id,
    revision: props.page.revision,
    enabled: true,
  });
  const [preview, setPreview] = useState<number | null>(null);
  const [now] = useState(() => Date.now());
  const body = useQuery({
    queryKey: [
      ...pagesQueryKeys.read(props.account, props.scopeSpaceId, props.page.id),
      "revision",
      preview,
    ],
    queryFn: () =>
      ensureNativeApi().pages.read({
        scopeSpaceId: props.scopeSpaceId,
        pageId: props.page.id,
        revision: preview!,
      }),
    enabled: preview !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const list = versions.data?.pages.flatMap((page) => page.versions) ?? [];
  return (
    <div className="flex flex-col gap-2" data-page-panel="history">
      <PanelStatus
        error={versions.error}
        loading={versions.isPending && versions.fetchStatus !== "idle"}
        onRetry={() => void versions.refetch()}
      />
      <ol className="flex flex-col gap-0.5" aria-label="版本历史">
        {list.map((version) => {
          const revision = version.page.revision;
          const open = preview === revision;
          const current = revision === props.page.revision;
          return (
            <li key={revision} className="rounded-row">
              <button
                type="button"
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-row px-2 py-1.5 text-left hover:bg-accent",
                  open && "bg-accent",
                )}
                aria-expanded={open}
                onClick={() => setPreview(open ? null : revision)}
              >
                <span className="text-ui">
                  {versionActivity(version, translation)}
                  {current ? (
                    <span className="ms-1.5 text-ui-sm text-muted-foreground">当前</span>
                  ) : null}
                </span>
                <span
                  className="text-ui-sm text-muted-foreground"
                  title={new Date(version.createdAt).toLocaleString()}
                >
                  版本 {revision} · {formatRelativeTime(version.createdAt, now)}
                </span>
              </button>
              {open ? (
                <div className="mx-2 mt-1 mb-2 flex flex-col gap-2 rounded-card border border-border p-3">
                  {body.data ? (
                    <div className="max-h-72 overflow-auto text-ui-sm">
                      <ChatMarkdown text={body.data.content || "空页面"} cwd={undefined} />
                    </div>
                  ) : (
                    <PanelStatus
                      error={body.error}
                      loading={body.isPending}
                      onRetry={() => void body.refetch()}
                    />
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    className="self-start"
                    disabled={props.busy || current || props.page.trashedAt !== null}
                    onClick={() => void props.onRestore(revision)}
                  >
                    恢复此版本
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {versions.hasNextPage ? (
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          disabled={versions.isFetchingNextPage}
          onClick={() => void versions.fetchNextPage()}
        >
          {versions.isFetchingNextPage ? "正在加载…" : "加载更早的版本"}
        </Button>
      ) : null}
    </div>
  );
}

export interface PageCommentSourceStatus {
  error: Error | null;
  loading: boolean;
  onRetry: () => void;
}

function PageCommentStatuses(props: {
  localStatus: PageCommentSourceStatus;
  shareStatus: PageCommentSourceStatus;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PanelStatus
        {...props.localStatus}
        error={props.localStatus.error ? new Error(t("page.comments.localError")) : null}
        loadingLabel={t("page.comments.localLoading")}
        retryLabel={t("page.comments.retry")}
      />
      <PanelStatus
        {...props.shareStatus}
        error={props.shareStatus.error ? new Error(t("page.comments.sharedError")) : null}
        loadingLabel={t("page.comments.sharedLoading")}
        retryLabel={t("page.comments.retry")}
      />
    </>
  );
}

function commentAuthorLabel(
  comment: PageCommentFeedItem,
  translation: ReturnType<typeof useTranslation>,
) {
  if (comment.authorKind === "owner") return translation.t("page.comments.you");
  if (comment.authorKind === "agent") return translation.t("page.comments.agent");
  return guestCommentAuthorLabel(
    { authorKind: comment.authorKind, authorName: comment.authorName ?? "" },
    translation,
  );
}

export function PageCommentsPanel(props: {
  comments: readonly PageCommentFeedItem[];
  localStatus: PageCommentSourceStatus;
  shareStatus: PageCommentSourceStatus;
  readOnly: boolean;
  busy: boolean;
  onReplyGuest: () => void;
  onSubmit: (content: string) => Promise<boolean>;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const [draft, setDraft] = useState("");
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-col gap-3" data-page-panel="comments">
      <PageCommentStatuses localStatus={props.localStatus} shareStatus={props.shareStatus} />
      {props.comments.length === 0 &&
      !props.localStatus.loading &&
      !props.shareStatus.loading &&
      !props.localStatus.error &&
      !props.shareStatus.error ? (
        <p className="text-ui-sm text-muted-foreground">{t("page.comments.empty")}</p>
      ) : (
        <div role="list" aria-label={t("page.comments.label")} className="flex flex-col gap-2">
          {props.comments.map((entry) => (
            <div key={entry.key} role="listitem" className="rounded-card border border-border p-3">
              <p className="mb-1 text-ui-sm text-muted-foreground">
                {commentAuthorLabel(entry, translation)} ·{" "}
                {formatRelativeTime(entry.createdAt, now)}
                {entry.source === "share" ? ` · ${t("page.comments.shared")}` : ""}
              </p>
              <p className="text-ui whitespace-pre-wrap">{entry.content}</p>
              {entry.source === "share" && !props.readOnly ? (
                <Button size="xs" variant="ghost" onClick={props.onReplyGuest}>
                  {t("page.comments.replyGuest")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {props.readOnly ? null : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const content = draft.trim();
            if (!content) return;
            void props.onSubmit(content).then((sent) => {
              if (sent) setDraft("");
            });
          }}
        >
          <textarea
            className="min-h-20 w-full rounded-control border border-border bg-transparent px-2.5 py-2 text-ui outline-none focus:ring-2 focus:ring-ring"
            aria-label={t("page.comments.submit")}
            placeholder={t("page.comments.new")}
            maxLength={10_000}
            value={draft}
            disabled={props.busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            type="submit"
            className="self-end"
            disabled={props.busy || !draft.trim()}
          >
            {t("page.comments.submit")}
          </Button>
        </form>
      )}
    </div>
  );
}

export function PageActivityPanel(props: {
  account: string;
  scopeSpaceId: SpaceId | null;
  page: Page;
  comments: readonly PageCommentFeedItem[];
  localStatus: PageCommentSourceStatus;
  shareStatus: PageCommentSourceStatus;
}) {
  const translation = useTranslation();
  const versions = useVersionSummaries({
    account: props.account,
    scopeSpaceId: props.scopeSpaceId,
    pageId: props.page.id,
    revision: props.page.revision,
    enabled: true,
  });
  const [now] = useState(() => Date.now());
  const entries = useMemo(() => {
    const changes = (versions.data?.pages.flatMap((page) => page.versions) ?? [])
      .filter((version) => version.operation !== "comment")
      .map((version) => ({
        key: `v${version.page.revision}`,
        at: version.createdAt,
        text: versionActivity(version, translation),
      }));
    const comments = props.comments.map((comment) => ({
      key: comment.key,
      at: comment.createdAt,
      text: translation.format("page.comments.activity", {
        author: commentAuthorLabel(comment, translation),
        content: comment.content.slice(0, 80),
      }),
    }));
    return [...changes, ...comments].toSorted((a, b) => b.at.localeCompare(a.at));
  }, [props.comments, versions.data, translation]);
  return (
    <div className="flex flex-col gap-2" data-page-panel="activity">
      <PanelStatus
        error={versions.error}
        loading={versions.isPending && versions.fetchStatus !== "idle"}
        onRetry={() => void versions.refetch()}
      />
      <PageCommentStatuses localStatus={props.localStatus} shareStatus={props.shareStatus} />
      <ol className="flex flex-col" aria-label="页面动态">
        {entries.map((entry) => (
          <li key={entry.key} className="flex gap-2 border-l border-border py-1.5 ps-3">
            <span className="min-w-0 flex-1 text-ui">{entry.text}</span>
            <span className="shrink-0 text-ui-sm text-muted-foreground">
              {formatRelativeTime(entry.at, now)}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-ui-sm text-muted-foreground">
        创建于 {new Date(props.page.createdAt).toLocaleString()} · 编辑于{" "}
        {new Date(props.page.updatedAt).toLocaleString()}
      </p>
    </div>
  );
}

export function PageFilesPanel(props: {
  page: Page;
  items: readonly LibraryItem[] | undefined;
  error: Error | null;
  loading: boolean;
  onRetry: () => void;
  busy: boolean;
  onToggle: (itemId: string, attached: boolean) => void;
  onOpenLibrary: () => void;
}) {
  const live = (props.items ?? []).filter((item) => !item.trashedAt);
  const attached = live.filter((item) => props.page.assetIds.includes(item.id));
  const others = live.filter((item) => !props.page.assetIds.includes(item.id));
  return (
    <div className="flex flex-col gap-3" data-page-panel="files">
      <PanelStatus error={props.error} loading={props.loading} onRetry={props.onRetry} />
      <p className="text-ui-sm text-muted-foreground">
        关联资料库中的文件。文件本身仍由资料库保管。
      </p>
      {[
        ["已关联", attached],
        ["资料库", others],
      ].map(([label, list]) =>
        (list as LibraryItem[]).length ? (
          <section key={label as string} className="flex flex-col gap-0.5">
            <h3 className="px-1 text-ui-sm text-muted-foreground">{label as string}</h3>
            {(list as LibraryItem[]).map((item) => (
              <label
                key={item.id}
                className="flex h-8 items-center gap-2 rounded-row px-1 text-ui hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="size-4"
                  checked={props.page.assetIds.includes(item.id)}
                  disabled={props.busy || props.page.trashedAt !== null}
                  onChange={(event) => props.onToggle(item.id, event.target.checked)}
                />
                <span className="min-w-0 truncate">{item.title}</span>
              </label>
            ))}
          </section>
        ) : null,
      )}
      <Button size="xs" variant="ghost" className="self-start" onClick={props.onOpenLibrary}>
        打开资料库 / 导入文件
      </Button>
    </div>
  );
}

/** Headings of the page's Markdown projection, for the outline. */
export function pageOutline(markdown: string): { line: number; level: number; text: string }[] {
  const outline: { line: number; level: number; text: string }[] = [];
  let inCode = false;
  for (const [line, text] of markdown.split(/\r?\n/).entries()) {
    if (/^\s*```/.test(text)) inCode = !inCode;
    if (inCode) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(text);
    if (match)
      outline.push({ line, level: match[1]!.length, text: match[2]!.replace(/[*_`]/g, "") });
  }
  return outline;
}

export function PageNavigationPanel(props: {
  page: Page;
  pages: readonly Page[];
  markdown: string;
  onSelect: (pageId: PageId) => void;
}) {
  const outline = pageOutline(props.markdown);
  const ancestors: Page[] = [];
  const seen = new Set<PageId>([props.page.id]);
  let parent = props.page.parentPageId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const entry = props.pages.find((item) => item.id === parent);
    if (!entry) break;
    ancestors.unshift(entry);
    parent = entry.parentPageId;
  }
  const children = props.pages.filter(
    (item) => item.parentPageId === props.page.id && item.trashedAt === null,
  );
  const link = (entry: Page) => (
    <button
      key={entry.id}
      type="button"
      className="flex h-7 w-full items-center truncate rounded-row px-2 text-left text-ui hover:bg-accent"
      onClick={() => props.onSelect(entry.id)}
    >
      {entry.title}
    </button>
  );
  return (
    <nav className="flex flex-col gap-3" aria-label="页面导航" data-page-panel="navigation">
      {ancestors.length ? (
        <section className="flex flex-col gap-0.5">
          <h3 className="px-2 text-ui-sm text-muted-foreground">上级页面</h3>
          {ancestors.map(link)}
        </section>
      ) : null}
      <section className="flex flex-col gap-0.5">
        <h3 className="px-2 text-ui-sm text-muted-foreground">大纲</h3>
        {outline.length ? (
          outline.map((entry) => (
            <p
              key={entry.line}
              className="truncate px-2 py-1 text-ui"
              style={{ paddingInlineStart: `${8 + (entry.level - 1) * 12}px` }}
            >
              {entry.text}
            </p>
          ))
        ) : (
          <p className="px-2 text-ui-sm text-muted-foreground">添加标题后，这里会显示大纲。</p>
        )}
      </section>
      <section className="flex flex-col gap-0.5">
        <h3 className="px-2 text-ui-sm text-muted-foreground">子页面</h3>
        {children.length ? (
          children.map(link)
        ) : (
          <p className="px-2 text-ui-sm text-muted-foreground">没有子页面</p>
        )}
      </section>
    </nav>
  );
}
