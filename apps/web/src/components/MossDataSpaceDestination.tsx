// FILE: MossDataSpaceDestination.tsx
// Purpose: The 资料空间 rail destination: its sidebar, the item views (全部, one kind, one
//          资料空间, 回收站), and whichever item is open (a page, a chat output, an 应用页…).
// Layer: Space UI composition
// Why: Pages, 应用页, files agents wrote in chats and 资料库 files are different stores; the
//      Space lists them as one set of items (`space/spaceItems.ts`) so people find a thing
//      where they expect it, whichever store holds it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  LIBRARY_IMPORT_FILE_MAX_BYTES,
  type Page,
  PageId,
  type PageSpace,
  type PagesMutateInput,
  type PagesReadResult,
  type SpaceId,
  type ThreadId,
} from "@moss/contracts";

import { ensureNativeApi } from "~/nativeApi";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { isPageMutationRejected, PageMutationIntent } from "~/lib/pageMutationIntent";
import { listSpacePageApps, promoteHtmlToPageApp } from "~/lib/spacePageApps";
import { clearSpacePageHash, readSpacePageHash, SPACE_PAGE_HASH_PREFIX } from "~/lib/spacePageLink";

import { MossLibraryDestination } from "./MossLibraryDestination";
import { PageView } from "./pages/PageView";
import type { SpaceCreateAction } from "./space/SpaceCreateMenu";
import { SpaceHome } from "./space/SpaceHome";
import {
  buildSpaceItems,
  recentItems,
  spaceTitle,
  type SpaceItem,
  type SpaceSection,
} from "./space/spaceItems";
import {
  SpaceAppViewer,
  SpaceComingSoon,
  SpaceOutputViewer,
  readOutputText,
} from "./space/SpaceItemViewers";
import { AccountPageRecovery } from "./space/AccountPageRecovery";
import { SpaceSidebar } from "./space/SpaceSidebar";
import { SpaceTrash } from "./space/SpaceTrash";
import { convertSpaceFile } from "./spaceTypes/spaceFileConversion";
import { queueDeckGeneration } from "./spaceTypes/slides/deckAiPrompt";
import { NewDeckDialog } from "./spaceTypes/slides/NewDeckDialog";
import {
  convertPptxToSlides,
  createAppPageFromTemplate,
  createSpaceItem,
  isTypedSpaceKind,
} from "./spaceTypes/spaceItemTypes";
import { SpaceTypedItemView } from "./spaceTypes/SpaceTypedItemView";
import { TemplatePickerDialog } from "./spaceTypes/templates/TemplatePickerDialog";
import { MossSitesView } from "./pages/sites/MossSitesView";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";

type LibraryProps = Parameters<typeof MossLibraryDestination>[0];
type Props = LibraryProps & {
  onStartPageConversation: (document: PagesReadResult, isCurrent: () => boolean) => Promise<void>;
};

/** What fills the content sheet besides a section's item list. */
type Open =
  | { readonly type: "page"; readonly pageId: PageId }
  | { readonly type: "item"; readonly key: string }
  | { readonly type: "stub"; readonly kind: string }
  | { readonly type: "library" };

/** Kinds stored as page rows whose editor is the rich page editor. */
const PAGE_EDITOR_KINDS = new Set(["page"]);

const INPUT =
  "h-8 w-full rounded-control border border-border bg-transparent px-2.5 text-ui outline-none focus:ring-2 focus:ring-ring";

export { SPACE_PAGE_HASH_PREFIX };

/** Data spaces own Pages; the existing Library remains the file/asset surface. */
export function MossDataSpaceDestination(props: Props) {
  const boundary = useMossImagesAccountBoundary();
  // The sidebar's Spaces were removed, so 资料空间 always opens the shared (unscoped) library.
  const scopeSpaceId: SpaceId | null = null;
  return boundary.transitioning ? (
    <div role="status">正在切换账号…</div>
  ) : (
    <DataSpaceWorkspace
      key={`${boundary.identityKey}:${scopeSpaceId}`}
      {...props}
      account={boundary.identityKey}
      scopeSpaceId={scopeSpaceId}
      isCurrent={boundary.isCurrent}
    />
  );
}

function DataSpaceWorkspace({
  account,
  scopeSpaceId,
  isCurrent,
  onStartPageConversation,
  ...libraryProps
}: Props & { account: string; scopeSpaceId: SpaceId | null; isCurrent: () => boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [section, setSection] = useState<SpaceSection>({ type: "all" });
  const [open, setOpen] = useState<Open | null>(null);
  const [createIntent] = useState(
    () =>
      new PageMutationIntent(
        `moss:page-create:${account}:${scopeSpaceId}`,
        (input) =>
          input.scopeSpaceId === scopeSpaceId &&
          (input.op === "create" || input.op === "create-space"),
      ),
  );
  const [dialog, setDialog] = useState<
    | { mode: "page"; parent: Page | null; spaceId: Page["spaceId"] }
    | { mode: "space" }
    | { mode: "rename"; space: PageSpace }
    | null
  >(() =>
    createIntent.pending
      ? createIntent.pending.op === "create-space"
        ? { mode: "space" }
        : { mode: "page", parent: null, spaceId: null }
      : null,
  );
  const [name, setName] = useState(() => {
    const pending = createIntent.pending;
    return pending?.op === "create" || pending?.op === "create-space" ? pending.title : "";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A confirmation ("已上传…") is read once; it clears itself after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const [templatePicker, setTemplatePicker] = useState<{ kind?: "app" | "slides" } | null>(null);
  const [newDeck, setNewDeck] = useState(false);
  const pptxInput = useRef<HTMLInputElement>(null);
  const createDeck = (prompt: string | null, named?: string) =>
    run("创建", async () => {
      const spaceId = section.type === "space" ? section.spaceId : null;
      const title =
        named?.slice(0, 200) ||
        (prompt ? prompt.replace(/\s+/gu, " ").slice(0, 40) : "未命名幻灯片");
      const created = await createSpaceItem(ensureNativeApi(), {
        scopeSpaceId,
        kind: "slides",
        spaceId,
        title,
      });
      if (prompt) queueDeckGeneration(created.page.id, prompt);
      setNewDeck(false);
      await refresh();
      setOpen({ type: "item", key: `page:${created.page.id}` });
    });
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const { onCanvasLeaveGuardChange } = libraryProps;
  const registerGuard = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      leaveGuard.current = guard;
      onCanvasLeaveGuardChange?.(guard);
    },
    [onCanvasLeaveGuardChange],
  );
  useEffect(() => () => registerGuard(null), [registerGuard]);
  // `#space-page=<id>` (a chat's 打开 link, 在新窗口中打开): open that item, as a page or in
  // its own editor by kind, whether the Space is just mounting or already open.
  const openFromHash = useRef<() => void>(() => {});
  openFromHash.current = () => {
    const id = readSpacePageHash();
    if (!id) return;
    clearSpacePageHash();
    const pageId = PageId.makeUnsafe(id);
    void (async () => {
      if (!(await leave())) return;
      const kind = await ensureNativeApi()
        .pages.read({ scopeSpaceId, pageId })
        .then((document) => document.page.kind ?? "page")
        .catch(() => "page");
      if (!isCurrent()) return;
      await refresh();
      setOpen(
        PAGE_EDITOR_KINDS.has(kind)
          ? { type: "page", pageId }
          : { type: "item", key: `page:${id}` },
      );
    })();
  };
  useEffect(() => {
    openFromHash.current();
    const onHash = () => openFromHash.current();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const spacesQuery = useQuery({
    queryKey: pagesQueryKeys.spaces(account, scopeSpaceId),
    queryFn: () => ensureNativeApi().pages.spaces({ scopeSpaceId }),
    refetchInterval: 5_000,
  });
  const listQuery = useQuery({
    queryKey: pagesQueryKeys.list(account, scopeSpaceId),
    queryFn: () => ensureNativeApi().pages.list({ scopeSpaceId, includeTrashed: true }),
    refetchInterval: 5_000,
  });
  const outputsQuery = useQuery({
    queryKey: [...pagesQueryKeys.scope(account, scopeSpaceId), "outputs"],
    queryFn: () => ensureNativeApi().pages.outputs({ scopeSpaceId, includeTrashed: true }),
    refetchInterval: 10_000,
  });
  const appsQuery = useQuery({
    queryKey: [...pagesQueryKeys.scope(account, scopeSpaceId), "apps"],
    queryFn: () => listSpacePageApps(scopeSpaceId),
    refetchInterval: 10_000,
  });
  const libraryQuery = useQuery({
    queryKey: [...pagesQueryKeys.scope(account, scopeSpaceId), "library"],
    queryFn: () => ensureNativeApi().library.list({ includeTrashed: true }),
    refetchInterval: 15_000,
  });
  const allPages = useMemo(() => listQuery.data?.pages ?? [], [listQuery.data]);
  const spaces = spacesQuery.data?.spaces ?? [];
  const items = useMemo(
    () =>
      buildSpaceItems({
        pages: allPages,
        apps: appsQuery.data ?? [],
        outputs: outputsQuery.data?.outputs ?? [],
        library: libraryQuery.data?.items ?? [],
      }),
    [allPages, appsQuery.data, outputsQuery.data, libraryQuery.data],
  );
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: pagesQueryKeys.scope(account, scopeSpaceId) }),
    [account, client, scopeSpaceId],
  );
  const leave = async () =>
    (await (leaveGuard.current?.() ?? Promise.resolve(true))) && isCurrent();

  const showSection = async (next: SpaceSection) => {
    if (!(await leave())) return;
    setOpen(null);
    setSection(next);
  };
  const openPage = async (pageId: PageId) => {
    if (!(await leave())) return;
    setOpen({ type: "page", pageId });
  };
  const openItem = async (item: SpaceItem) => {
    if (!(await leave())) return;
    if (item.source.type === "page") {
      const kind = item.source.page.kind ?? "page";
      setOpen(
        PAGE_EDITOR_KINDS.has(kind)
          ? { type: "page", pageId: item.source.page.id }
          : { type: "item", key: item.key },
      );
      return;
    }
    setOpen({ type: "item", key: item.key });
  };
  const openedItem =
    open?.type === "item" ? (items.find((item) => item.key === open.key) ?? null) : null;

  const run = async (label: string, task: () => Promise<void>) => {
    if (busy || !isCurrent()) return;
    setBusy(true);
    setError(null);
    try {
      await task();
      await refresh();
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : `${label}失败，请重试。`);
    } finally {
      setBusy(false);
    }
  };
  const pageMutation = (page: Page, operation: Record<string, unknown>) =>
    ensureNativeApi().pages.mutate({
      ...operation,
      requestId: crypto.randomUUID(),
      scopeSpaceId,
      pageId: page.id,
      expectedRevision: page.revision,
    } as PagesMutateInput);

  const trashItem = (item: SpaceItem) =>
    run("移到回收站", async () => {
      if (item.source.type === "page") {
        const page = item.source.page;
        await pageMutation(page, { op: isSpaceRoot(page) ? "trash-space" : "trash" });
      } else if (item.source.type === "output") {
        await ensureNativeApi().pages.outputState({
          scopeSpaceId,
          outputId: item.source.output.id,
          action: "trash",
        });
      } else if (item.source.type === "library") {
        await ensureNativeApi().library.trash({ ids: [item.source.item.id] });
      } else {
        throw new Error("应用页的删除会在这个版本中接入。");
      }
      if (open?.type === "item" && open.key === item.key) setOpen(null);
    });
  const restoreItem = (item: SpaceItem) =>
    run("恢复", async () => {
      if (item.source.type === "page") {
        const page = item.source.page;
        await pageMutation(page, { op: isSpaceRoot(page) ? "restore-space" : "restore" });
      } else if (item.source.type === "output") {
        await ensureNativeApi().pages.outputState({
          scopeSpaceId,
          outputId: item.source.output.id,
          action: "restore",
        });
      } else if (item.source.type === "library") {
        await ensureNativeApi().library.restore({ ids: [item.source.item.id] });
      } else {
        throw new Error("应用页的恢复会在这个版本中接入。");
      }
    });
  const purgeItems = (targets: readonly SpaceItem[]) =>
    run("永久删除", async () => {
      const libraryIds: string[] = [];
      for (const item of targets) {
        if (item.source.type === "page") await pageMutation(item.source.page, { op: "purge" });
        else if (item.source.type === "output")
          await ensureNativeApi().pages.outputState({
            scopeSpaceId,
            outputId: item.source.output.id,
            action: "purge",
          });
        else if (item.source.type === "library") libraryIds.push(item.source.item.id);
      }
      if (libraryIds.length) await ensureNativeApi().library.deletePermanently({ ids: libraryIds });
    });
  const togglePin = (item: SpaceItem) =>
    run("收藏", async () => {
      if (item.source.type === "page")
        await pageMutation(item.source.page, { op: "pin", pinned: !item.pinned });
      else if (item.source.type === "library")
        await ensureNativeApi().library.favorite({
          ids: [item.source.item.id],
          favorite: !item.pinned,
        });
    });
  const continueInChat = async (item: SpaceItem) => {
    if (item.source.type === "page") {
      const document = await ensureNativeApi().pages.read({
        scopeSpaceId,
        pageId: item.source.page.id,
      });
      if (isCurrent()) await onStartPageConversation(document, isCurrent);
      return;
    }
    if (!item.sourceThreadId || !(await leave())) return;
    await navigate({ to: "/$threadId", params: { threadId: item.sourceThreadId as ThreadId } });
    libraryProps.onClose?.();
  };
  const saveAsApp = (item: SpaceItem) =>
    run("保存为应用页", async () => {
      const html = await readOutputText(item);
      await promoteHtmlToPageApp({
        scopeSpaceId,
        title: item.title.replace(/\.html?$/i, ""),
        html,
        sourceThreadId: (item.sourceThreadId as ThreadId | null) ?? null,
        // File it beside the output: the item's own space, else the space being viewed.
        spaceId: item.spaceId ?? (section.type === "space" ? section.spaceId : null),
      });
      setNotice(`已把“${item.title}”保存为应用页。`);
    });

  const startCreate = async (action: SpaceCreateAction, parent: Page | null = null) => {
    if (!(await leave())) return;
    if (action === "page" || action === "space") {
      if (createIntent.pending) {
        setDialog(
          createIntent.pending.op === "create-space"
            ? { mode: "space" }
            : { mode: "page", parent: null, spaceId: null },
        );
        setError("上次创建的结果尚未确认，请核对同一次创建。");
        return;
      }
      setName("");
      setError(null);
      setDialog(
        action === "space"
          ? { mode: "space" }
          : {
              mode: "page",
              parent,
              spaceId: parent?.spaceId ?? (section.type === "space" ? section.spaceId : null),
            },
      );
      return;
    }
    if (action === "upload") {
      uploadInput.current?.click();
      return;
    }
    if (action === "image") {
      setOpen({ type: "stub", kind: "image" });
      return;
    }
    // 幻灯片, 电子表格, 白板 and 从模板开始 / 仪表盘 (types stream).
    if (action === "slides") {
      setNewDeck(true);
      return;
    }
    if (action === "sheet" || action === "board") {
      const spaceId = section.type === "space" ? section.spaceId : null;
      await run("创建", async () => {
        const created = await createSpaceItem(ensureNativeApi(), {
          scopeSpaceId,
          kind: action,
          spaceId,
        });
        await refresh();
        setOpen({ type: "item", key: `page:${created.page.id}` });
      });
      return;
    }
    if (action === "template" || action === "app") {
      setTemplatePicker(action === "app" ? { kind: "app" } : {});
      return;
    }
    // Kinds another stream of this build owns open its placeholder until that stream lands.
    setOpen({ type: "stub", kind: action });
  };
  const submitDialog = async () => {
    if (!dialog || !name.trim() || busy || !isCurrent()) return;
    if (dialog.mode === "rename") {
      const root = allPages.find((page) => page.id === dialog.space.rootPageId);
      if (!root) return;
      await run("重命名", async () => {
        await pageMutation(root, { op: "update", title: name.trim() });
        setDialog(null);
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let spaceTarget: Page["spaceId"] = null;
      let parentTarget: Page["parentPageId"] = null;
      if (dialog.mode === "page") {
        spaceTarget = dialog.spaceId;
        parentTarget =
          dialog.parent?.id ??
          (dialog.spaceId
            ? (spaces.find((space) => space.id === dialog.spaceId)?.rootPageId ?? null)
            : null);
      }
      const input: PagesMutateInput =
        createIntent.pending ??
        createIntent.remember(
          dialog.mode === "space"
            ? {
                op: "create-space",
                requestId: crypto.randomUUID(),
                scopeSpaceId,
                title: name.trim(),
              }
            : {
                op: "create",
                requestId: crypto.randomUUID(),
                scopeSpaceId,
                title: name.trim(),
                spaceId: spaceTarget,
                parentPageId: parentTarget,
              },
        );
      const result = await createIntent.submit(input, (pending) =>
        ensureNativeApi().pages.mutate(pending),
      );
      createIntent.clear();
      if (!isCurrent()) return;
      client.setQueryData(pagesQueryKeys.read(account, scopeSpaceId, result.page.id), result);
      setDialog(null);
      if (result.space) setSection({ type: "space", spaceId: result.space.id });
      setOpen({ type: "page", pageId: result.page.id });
      await refresh();
    } catch (cause) {
      if (isPageMutationRejected(cause)) createIntent.clear();
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const uploadFiles = (files: FileList | null) => {
    if (!files?.length) return;
    void run("上传", async () => {
      const picked = [...files];
      const tooLarge = picked.find((file) => file.size > LIBRARY_IMPORT_FILE_MAX_BYTES);
      if (tooLarge)
        throw new Error(
          `“${tooLarge.name}”超过 ${LIBRARY_IMPORT_FILE_MAX_BYTES / 1024 / 1024} MB。`,
        );
      const encoded = await Promise.all(
        picked.map(async (file) => ({
          name: file.name,
          ...(file.type ? { mimeType: file.type } : {}),
          dataBase64: await fileToBase64(file),
        })),
      );
      await ensureNativeApi().library.importFiles({ files: encoded });
      await client.invalidateQueries({
        queryKey: [...pagesQueryKeys.scope(account, scopeSpaceId), "library"],
      });
      setNotice(
        picked.length === 1 ? `已上传“${picked[0]!.name}”。` : `已上传 ${picked.length} 个文件。`,
      );
    });
  };

  const placeOf = (item: SpaceItem) => {
    if (item.source.type === "output") return item.source.output.threadTitle || "对话";
    if (item.source.type === "library") return item.sourceThreadId ? "对话生成" : "资料库";
    return spaceTitle(spaces, item.spaceId);
  };
  const failure = listQuery.error ?? spacesQuery.error;
  const sectionCopy = (() => {
    switch (section.type) {
      case "all":
        return { title: "全部", description: "页面、应用页和对话里生成的文件都在这里。" };
      case "kind": {
        const labels = {
          page: "页面",
          slides: "幻灯片",
          site: "站点",
          image: "图像",
          app: "应用",
        } as const;
        return { title: labels[section.kind], description: "" };
      }
      case "space": {
        const space = spaces.find((entry) => entry.id === section.spaceId);
        return { title: space?.title ?? "资料空间", description: "这个资料空间里的页面。" };
      }
      default:
        return { title: "回收站", description: "" };
    }
  })();
  const openKey =
    open?.type === "page" ? `page:${open.pageId}` : open?.type === "item" ? open.key : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden" data-moss-data-spaces>
      <SpaceSidebar
        scopeSpaceId={scopeSpaceId}
        section={section}
        openKey={openKey}
        recent={recentItems(items)}
        spaces={spaces}
        pages={allPages}
        onSection={(next) => void showSection(next)}
        onOpen={(item) => void openItem(item)}
        onOpenPage={(pageId) => void openPage(pageId)}
        onCreate={(action) => void startCreate(action)}
        onCreateSubpage={(parent) => void startCreate("page", parent)}
        onRenameSpace={(space) => {
          setName(space.title);
          setError(null);
          setDialog({ mode: "rename", space });
        }}
        onSpaceIcon={(space, icon) => {
          const root = allPages.find((page) => page.id === space.rootPageId);
          if (root)
            void run("更换图标", () =>
              pageMutation(root, { op: "space-icon", icon }).then(() => undefined),
            );
        }}
        onTrashSpace={(space) => {
          const root = allPages.find((page) => page.id === space.rootPageId);
          if (root)
            void run("移到回收站", async () => {
              await pageMutation(root, { op: "trash-space" });
              if (section.type === "space" && section.spaceId === space.id)
                setSection({ type: "all" });
            });
        }}
        onClose={libraryProps.onClose}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="资料空间内容">
        {(error && !dialog) || notice ? (
          <div
            role={error ? "alert" : "status"}
            className="flex items-center gap-2 border-b border-border px-4 py-2 text-ui-sm"
          >
            <span className={error ? "flex-1 text-destructive" : "flex-1"}>{error ?? notice}</span>
            <Button size="xs" variant="ghost" onClick={() => (setError(null), setNotice(null))}>
              知道了
            </Button>
          </div>
        ) : null}
        {open?.type === "library" ? (
          <MossLibraryDestination {...libraryProps} onCanvasLeaveGuardChange={registerGuard} />
        ) : open?.type === "page" ? (
          <PageView
            key={open.pageId}
            pageId={open.pageId}
            account={account}
            scopeSpaceId={scopeSpaceId}
            pages={allPages}
            isCurrent={isCurrent}
            onChanged={refresh}
            onSelect={(id) => void openPage(id)}
            onCreateChild={(parent) => void startCreate("page", parent)}
            onGuardChange={registerGuard}
            onFiles={() => void leave().then((ok) => ok && setOpen({ type: "library" }))}
            onStartConversation={onStartPageConversation}
            onOpenCreated={(document) => {
              client.setQueryData(
                pagesQueryKeys.read(account, scopeSpaceId, document.page.id),
                document,
              );
              setOpen({ type: "page", pageId: document.page.id });
            }}
            onOpenInNewWindow={(pageId) => {
              const url = `${window.location.origin}${window.location.pathname}${SPACE_PAGE_HASH_PREFIX}${encodeURIComponent(pageId)}`;
              const opened = window.open(url, "_blank", "noopener");
              if (!opened) setNotice("这个窗口不能再打开新窗口。页面仍在当前窗口中。");
            }}
          />
        ) : open?.type === "stub" ? (
          <SpaceComingSoon
            kind={open.kind}
            action={
              open.kind === "image"
                ? { label: "在图像工作区创建", onClick: () => libraryProps.onClose?.() }
                : undefined
            }
          />
        ) : openedItem ? (
          openedItem.source.type === "output" || openedItem.source.type === "library" ? (
            <SpaceOutputViewer
              item={openedItem}
              onContinueInChat={(item) => void continueInChat(item)}
              onSaveAsApp={(item) => void saveAsApp(item)}
              onTrash={(item) => void trashItem(item)}
              onConvert={(file) =>
                void run("转换", async () => {
                  const { item, skipped } = await convertSpaceFile({ scopeSpaceId, ...file });
                  await refresh();
                  setOpen({ type: "item", key: `page:${item.page.id}` });
                  if (skipped) setNotice(`已转换。${skipped} 个图表、表格或组合未能转换。`);
                })
              }
            />
          ) : openedItem.source.type === "page" && isTypedSpaceKind(openedItem.source.page.kind) ? (
            <SpaceTypedItemView
              key={openedItem.key}
              account={account}
              scopeSpaceId={scopeSpaceId}
              pageId={openedItem.source.page.id}
              onSaved={() => void refresh()}
              onGuardChange={registerGuard}
            />
          ) : openedItem.source.type === "app" ? (
            <SpaceAppViewer
              item={openedItem}
              onContinueInChat={(item) => void continueInChat(item)}
            />
          ) : (
            <SpaceComingSoon kind={openedItem.kind} item={openedItem} />
          )
        ) : open?.type === "item" ? (
          <p role="status" className="p-8 text-ui text-muted-foreground">
            这个条目已不可用。
          </p>
        ) : section.type === "trash" ? (
          <SpaceTrash
            items={items}
            busy={busy}
            error={null}
            onRestore={(item) => void restoreItem(item)}
            canPurge={(item) => item.source.type !== "app"}
            onPurge={purgeItems}
          />
        ) : section.type === "kind" && section.kind === "site" ? (
          // 站点: published pages and 应用页, owned by sharing.
          <MossSitesView
            account={account}
            scopeSpaceId={scopeSpaceId}
            onOpenPage={(pageId) => void openPage(pageId)}
          />
        ) : (
          <SpaceHome
            headerAction={
              scopeSpaceId === null && section.type === "all" ? (
                <AccountPageRecovery
                  onRestored={(pageId) => {
                    if (!isCurrent()) return;
                    void openPage(pageId);
                    void refresh();
                  }}
                />
              ) : undefined
            }
            section={section}
            title={sectionCopy.title}
            description={sectionCopy.description}
            items={items}
            loading={listQuery.isLoading || spacesQuery.isLoading}
            error={failure ? failure.message : null}
            onRetry={() => void refresh()}
            onCreate={(action) => void startCreate(action)}
            emptyCreate={
              section.type === "kind" && section.kind !== "image" ? section.kind : "page"
            }
            placeOf={placeOf}
            onOpen={(item) => void openItem(item)}
            onContinueInChat={(item) => void continueInChat(item)}
            onSaveAsApp={(item) => void saveAsApp(item)}
            onTogglePin={(item) => void togglePin(item)}
            onTrash={(item) => void trashItem(item)}
          />
        )}
      </main>
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          uploadFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <NewDeckDialog
        open={newDeck}
        onOpenChange={setNewDeck}
        busy={busy}
        onBlank={() => void createDeck(null)}
        onTemplate={() => {
          setNewDeck(false);
          setTemplatePicker({ kind: "slides" });
        }}
        onImport={() => pptxInput.current?.click()}
        onGenerate={(prompt) => void createDeck(prompt)}
        pages={allPages
          .filter((page) => (page.kind ?? "page") === "page" && page.trashedAt === null)
          .map((page) => ({ id: page.id, title: page.title }))}
        onFromPage={(page) =>
          void createDeck(
            `根据资料空间页面“${page.title}”（pageId: ${page.id}）的内容做一份演示文稿。先用 moss_pages_read 读取这个页面，提炼要点，再做成幻灯片。`,
            `${page.title} · 演示`,
          )
        }
      />
      <input
        ref={pptxInput}
        type="file"
        hidden
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void run("导入", async () => {
            const { item, skipped } = await convertPptxToSlides(ensureNativeApi(), {
              scopeSpaceId,
              bytes: await file.arrayBuffer(),
              fileName: file.name,
              spaceId: section.type === "space" ? section.spaceId : null,
            });
            setNewDeck(false);
            await refresh();
            setOpen({ type: "item", key: `page:${item.page.id}` });
            if (skipped) setNotice(`已导入。${skipped} 个对象无法转换为可编辑元素，已跳过。`);
          });
        }}
      />
      <TemplatePickerDialog
        key={templatePicker?.kind ?? "all"}
        open={templatePicker !== null}
        onOpenChange={(next) => {
          if (!next) setTemplatePicker(null);
        }}
        account={account}
        scopeSpaceId={scopeSpaceId}
        spaceId={section.type === "space" ? section.spaceId : null}
        {...(templatePicker?.kind ? { initialKind: templatePicker.kind } : {})}
        onCreated={(item) => {
          void refresh();
          setOpen({ type: "item", key: `page:${item.page.id}` });
        }}
        createAppPage={async (template) => {
          const app = await createAppPageFromTemplate({
            ...template,
            scopeSpaceId,
            spaceId: section.type === "space" ? section.spaceId : null,
          });
          await refresh();
          setOpen({ type: "item", key: `app:${app.id}` });
        }}
      />
      <Dialog
        open={dialog !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setDialog(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>
            {dialog?.mode === "space"
              ? "新建资料空间"
              : dialog?.mode === "rename"
                ? "重命名资料空间"
                : dialog?.mode === "page" && dialog.parent
                  ? "新建子页面"
                  : "新建页面"}
          </DialogTitle>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
          >
            <label className="flex flex-col gap-1.5 text-ui">
              {dialog?.mode === "page" ? "页面名称" : "资料空间名称"}
              <input
                autoFocus
                className={INPUT}
                maxLength={256}
                placeholder={dialog?.mode === "page" ? "未命名页面" : "为话题或小组起个名字"}
                value={name}
                disabled={busy || (dialog?.mode !== "rename" && createIntent.pending !== null)}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {error || createIntent.error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error ?? createIntent.error}
                {dialog?.mode === "rename" ? "" : " 重试会核对同一次创建。"}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                取消
              </Button>
              <Button size="sm" type="submit" disabled={busy || !name.trim()}>
                {busy
                  ? "正在保存…"
                  : dialog?.mode === "rename"
                    ? "保存"
                    : createIntent.pending
                      ? "核对创建结果"
                      : "创建"}
              </Button>
            </div>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function isSpaceRoot(page: Page): boolean {
  return page.spaceId !== null && page.rootPageId === page.id;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
