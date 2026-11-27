// FILE: MossDataSpaceDestination.tsx
// Purpose: The 资料空间 rail destination: its sidebar, the item views (全部, one kind, one
//          资料空间, 回收站), and whichever item is open (a page, a chat output, an 应用页…).
// Layer: Space UI composition
// Why: Pages, 应用页, files agents wrote in chats and 资料库 files are different stores; the
//      Space lists them as one set of items (`space/spaceItems.ts`) so people find a thing
//      where they expect it, whichever store holds it.

import { createDashboard } from "@moss/shared/spaceItems/dashboard";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type Page,
  PageId,
  type PageSpace,
  type PagesMutateInput,
  type PagesReadResult,
  type SpaceId,
  type ThreadId,
} from "@moss/contracts";

import { ensureNativeApi } from "~/nativeApi";
import { uploadLibraryFiles, uploadPickedLibraryFiles } from "~/lib/libraryUpload";
import { cn } from "~/lib/utils";
import { isMossCanvasAccountSignedOut, MOSS_CANVAS_SIGN_IN_MESSAGE } from "~/lib/mossCanvasClient";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { isPageMutationRejected, PageMutationIntent } from "~/lib/pageMutationIntent";
import { listSpacePageApps, moveSpacePageApp, promoteHtmlToPageApp } from "~/lib/spacePageApps";
import { clearSpacePageHash, readSpacePageHash, SPACE_PAGE_HASH_PREFIX } from "~/lib/spacePageLink";

import { MossLibraryDestination } from "./MossLibraryDestination";
import { PageView } from "./pages/PageView";
import type { SpaceCreateAction } from "./space/SpaceCreateMenu";
import { SpaceHome } from "./space/SpaceHome";
import {
  buildSpaceItems,
  recentItems,
  setSyncedSpaceHomeKind,
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
import { GalleryProvider, type GalleryPlace } from "./space/gallery/GalleryContext";
import { useGalleryLocalStore } from "./space/gallery/galleryLocalStore";
import { buildGalleryTree, fileIntoSpaces, type GalleryFolder } from "./space/gallery/galleryModel";
import { spaceItemDisplayTitle } from "./space/spaceItems";
import { GalleryImageViewer } from "./space/gallery/GalleryImageViewer";
import {
  WELCOME_FOLDER_TITLE,
  markWelcomeOffered,
  seedWelcomeSpace,
  shouldOfferWelcomeSpace,
  welcomeOffered,
} from "./space/welcome/spaceWelcome";
import { GallerySearchDialog } from "./space/gallery/GallerySearchDialog";
import {
  type SpaceCanvasActiveArtifact,
  SpaceCanvasChatDockHost,
} from "./space/SpaceCanvasChatDock";
import type { SpaceArtifactKind, SpaceCanvasDockController } from "./space/spaceCanvasDockContract";
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
  pageTypesQueryKeys,
} from "./spaceTypes/spaceItemTypes";
import { SpaceTypedItemView } from "./spaceTypes/SpaceTypedItemView";
import { TemplatePickerDialog } from "./spaceTypes/templates/TemplatePickerDialog";
import { MossSitesView } from "./pages/sites/MossSitesView";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
  PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

type LibraryProps = Parameters<typeof MossLibraryDestination>[0];
type Props = LibraryProps & {
  onStartPageConversation: (document: PagesReadResult, isCurrent: () => boolean) => Promise<void>;
  /** The title bar's sidebar toggle shows and hides this page's sidebar (shown when absent). */
  sidebarVisible?: boolean;
};

/** What fills the content sheet besides a section's item list. */
type Open =
  | { readonly type: "page"; readonly pageId: PageId }
  | { readonly type: "item"; readonly key: string }
  | { readonly type: "stub"; readonly kind: string }
  | { readonly type: "library" };

/** Kinds stored as page rows whose editor is the rich page editor. */
const PAGE_EDITOR_KINDS = new Set(["page"]);
const EMPTY_SPACES: readonly PageSpace[] = [];

/**
 * What opening a stored page shows: the rich editor for plain pages, the typed view
 * (幻灯片, 表格, …) for the rest. Every "open what was just made" path goes through here,
 * so a page made from a template opens in the editor, not the 即将推出 placeholder.
 */
function openPageState(page: {
  readonly id: PageId;
  readonly kind?: string | null | undefined;
}): Open {
  return PAGE_EDITOR_KINDS.has(page.kind ?? "page")
    ? { type: "page", pageId: page.id }
    : { type: "item", key: `page:${page.id}` };
}

export { SPACE_PAGE_HASH_PREFIX };

/** The folder card a section came from, to outline it on the way back. */
function folderKeyOfSection(section: SpaceSection): string | null {
  if (section.type === "space") return `space:${section.spaceId}`;
  if (section.type === "folder") return `folder:${section.folderId}`;
  return null;
}

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
  sidebarVisible = true,
  ...libraryProps
}: Props & { account: string; scopeSpaceId: SpaceId | null; isCurrent: () => boolean }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [section, setSection] = useState<SpaceSection>({ type: "all" });
  const [open, setOpen] = useState<Open | null>(null);
  /** The card to outline after coming back: the folder or item just left. */
  const [marked, setMarked] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const collections = useGalleryLocalStore((state) => state.collections);
  const removeCollection = useGalleryLocalStore((state) => state.removeCollection);
  const folderAssignments = useGalleryLocalStore((state) => state.folderAssignments);
  const openedCollection =
    section.type === "collection"
      ? (collections.find((entry) => entry.id === section.id) ?? null)
      : null;
  const dialogNameInputId = useId();
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
      setOpen(openPageState(created.page));
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
      setOpen(openPageState({ id: pageId, kind }));
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
    // Only what reached the person: not a tool's screenshots or an agent's edit backups.
    queryFn: () => ensureNativeApi().library.list({ includeTrashed: true, deliveredOnly: true }),
    refetchInterval: 15_000,
  });
  const allPages = useMemo(() => listQuery.data?.pages ?? [], [listQuery.data]);
  const libraryFolders = useMemo(() => libraryQuery.data?.folders ?? [], [libraryQuery.data]);
  const spaces = useMemo(() => spacesQuery.data?.spaces ?? EMPTY_SPACES, [spacesQuery.data]);
  // Pictures in a 资料库 folder named like a 资料空间 live in that space, beside its pages.
  const items = useMemo(
    () =>
      fileIntoSpaces({
        items: buildSpaceItems({
          pages: allPages,
          apps: appsQuery.data ?? [],
          outputs: outputsQuery.data?.outputs ?? [],
          library: libraryQuery.data?.items ?? [],
        }),
        spaces,
        libraryFolders,
        folderAssignments,
      }),
    [
      allPages,
      appsQuery.data,
      outputsQuery.data,
      libraryQuery.data,
      spaces,
      libraryFolders,
      folderAssignments,
    ],
  );
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: pagesQueryKeys.scope(account, scopeSpaceId) }),
    [account, client, scopeSpaceId],
  );

  // A first visit to an empty 资料空间 gets the 示例资料, once per account on this device.
  const welcomeStarted = useRef(false);
  const addTag = useGalleryLocalStore((state) => state.addTag);
  const hasWelcomeSpace = useMemo(
    () => spaces.some((space) => space.trashedAt === null && space.title === WELCOME_FOLDER_TITLE),
    [spaces],
  );
  useEffect(() => {
    if (welcomeStarted.current || welcomeOffered(account)) return;
    if (!spacesQuery.data || appsQuery.isLoading) return;
    if (!shouldOfferWelcomeSpace({ spaces: spacesQuery.data.spaces })) return;
    welcomeStarted.current = true;
    void seedWelcomeSpace({
      api: ensureNativeApi(),
      scopeSpaceId,
      upload: uploadLibraryFiles,
      onTags: (key, tags) => {
        for (const tag of tags) addTag(key, tag);
      },
    })
      .then(() => {
        markWelcomeOffered(account);
      })
      .catch((cause: unknown) => {
        welcomeStarted.current = false;
        if (isCurrent()) setNotice(cause instanceof Error ? cause.message : "示例资料没有放好。");
      })
      .finally(() => void refresh());
  }, [
    account,
    scopeSpaceId,
    listQuery.data,
    spacesQuery.data,
    outputsQuery.data,
    libraryQuery.data,
    appsQuery.data,
    appsQuery.isLoading,
    addTag,
    isCurrent,
    refresh,
  ]);
  const leave = async () =>
    (await (leaveGuard.current?.() ?? Promise.resolve(true))) && isCurrent();
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const handleTypedItemSaved = useCallback(() => {
    void refresh();
  }, [refresh]);
  const handleTypedItemBack = useCallback(() => {
    void leaveRef.current().then((ok) => ok && setOpen(null));
  }, []);

  const showSection = async (next: SpaceSection) => {
    if (!(await leave())) return;
    // Coming back outlines where the person was: the item just closed, else the folder left.
    const closing =
      open?.type === "page" ? `page:${open.pageId}` : open?.type === "item" ? open.key : null;
    setMarked(closing ?? folderKeyOfSection(section));
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
      setOpen(openPageState(item.source.page));
      return;
    }
    setOpen({ type: "item", key: item.key });
  };
  const openedItem =
    open?.type === "item" ? (items.find((item) => item.key === open.key) ?? null) : null;

  const workspaceHostRef = useRef<HTMLDivElement | null>(null);
  const dockControllerRef = useRef<SpaceCanvasDockController | null>(null);
  const [pendingStarter, setPendingStarter] = useState<{
    readonly itemId: string;
    readonly prompt: string;
    readonly prefillOnly?: boolean;
  } | null>(null);

  const rawArtifact = (() => {
    if (open?.type === "page") {
      const page = allPages.find((entry) => entry.id === open.pageId);
      return {
        kind: "page" as const,
        itemId: open.pageId,
        title: page?.title ?? "未命名文档",
        sourceThreadId: page?.sourceThreadId ?? null,
        revision: page?.revision ?? null,
      };
    }
    if (!openedItem) return null;
    if (openedItem.source.type === "page" && isTypedSpaceKind(openedItem.source.page.kind)) {
      const resolvedKind: SpaceArtifactKind =
        openedItem.kind === "dashboard"
          ? "dashboard"
          : (openedItem.source.page.kind as SpaceArtifactKind);
      return {
        kind: resolvedKind,
        itemId: openedItem.source.page.id,
        title: openedItem.title,
        sourceThreadId: openedItem.sourceThreadId ?? null,
        revision: openedItem.source.page.revision,
      };
    }
    if (openedItem.source.type === "app") {
      return {
        kind: "app" as const,
        itemId: openedItem.source.app.id,
        title: openedItem.title,
        sourceThreadId: openedItem.sourceThreadId ?? null,
        revision: undefined,
      };
    }
    return null;
  })();
  const rawArtifactKind = rawArtifact?.kind ?? null;
  const rawArtifactItemId = rawArtifact?.itemId ?? null;
  const rawArtifactTitle = rawArtifact?.title ?? null;
  const rawArtifactSourceThreadId = rawArtifact?.sourceThreadId ?? null;
  const rawArtifactRevision = rawArtifact?.revision;

  const activeArtifact = useMemo<SpaceCanvasActiveArtifact | null>(() => {
    if (!rawArtifactKind || !rawArtifactItemId || rawArtifactTitle === null) return null;
    return {
      kind: rawArtifactKind,
      itemId: rawArtifactItemId,
      title: rawArtifactTitle,
      scopeSpaceId,
      account,
      sourceThreadId: rawArtifactSourceThreadId,
      ...(rawArtifactRevision !== undefined ? { revision: rawArtifactRevision } : {}),
    };
  }, [
    account,
    rawArtifactItemId,
    rawArtifactKind,
    rawArtifactRevision,
    rawArtifactSourceThreadId,
    rawArtifactTitle,
    scopeSpaceId,
  ]);

  useEffect(() => {
    if (!pendingStarter || !activeArtifact || activeArtifact.itemId !== pendingStarter.itemId) {
      return;
    }
    const dock = dockControllerRef.current;
    if (!dock) return;
    const queued = pendingStarter;
    setPendingStarter(null);
    void dock.ask({
      prompt: queued.prompt,
      autoRun: !queued.prefillOnly,
      prefillOnly: Boolean(queued.prefillOnly),
      keepItemOpen: true,
      preferredState: "pip",
      origin: "template-auto-run",
    });
  }, [activeArtifact, pendingStarter]);

  // Listen for `moss:space-template-launch` dispatched by template galleries so created starter
  // items stay open in place and hand their prompt to SpaceCanvasChatDock (`autoRun` / `prefillOnly`).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleTemplateLaunch = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown> | null>).detail;
      if (!detail || typeof detail !== "object") return;
      const itemId =
        typeof detail.itemId === "string"
          ? detail.itemId
          : typeof detail.pageId === "string"
            ? detail.pageId
            : null;
      const starterPrompt =
        typeof detail.starterPrompt === "string" && detail.starterPrompt.trim()
          ? detail.starterPrompt.trim()
          : typeof detail.prefillPrompt === "string" && detail.prefillPrompt.trim()
            ? detail.prefillPrompt.trim()
            : null;
      if (!itemId || !starterPrompt) return;
      const prefillOnly = detail.autoRun === false && !detail.starterPrompt;
      setPendingStarter({ itemId, prompt: starterPrompt, prefillOnly });
    };
    window.addEventListener("moss:space-template-launch", handleTemplateLaunch);
    return () => window.removeEventListener("moss:space-template-launch", handleTemplateLaunch);
  }, []);

  const loadWelcomeSamples = () =>
    run("加载示例资料", async () => {
      try {
        await seedWelcomeSpace({
          api: ensureNativeApi(),
          scopeSpaceId,
          upload: uploadLibraryFiles,
          onTags: (key, tags) => {
            for (const tag of tags) addTag(key, tag);
          },
        });
        markWelcomeOffered(account);
      } catch (cause) {
        await refresh();
        throw cause;
      }
    });
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
      // 撤销 restores from the revision the trash produced, not the one the card showed.
      let trashed: SpaceItem = item;
      if (item.source.type === "page") {
        const page = item.source.page;
        const result = await pageMutation(page, {
          op: isSpaceRoot(page) ? "trash-space" : "trash",
        });
        trashed = { ...item, source: { ...item.source, page: result.page } };
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
      toastManager.add({
        type: "success",
        title: "已移到回收站",
        actionProps: { children: "撤销", onClick: () => void restoreItem(trashed) },
      });
    });
  const trashItems = (targets: readonly SpaceItem[]) => {
    if (targets.length === 0) return;
    if (targets.length === 1) {
      void trashItem(targets[0]!);
      return;
    }
    void run("移到回收站", async () => {
      const api = ensureNativeApi();
      const trashed: SpaceItem[] = [];
      const libraryIds: string[] = [];
      for (const item of targets) {
        if (item.source.type === "page") {
          const page = item.source.page;
          const result = await pageMutation(page, {
            op: isSpaceRoot(page) ? "trash-space" : "trash",
          });
          trashed.push({ ...item, source: { ...item.source, page: result.page } });
        } else if (item.source.type === "output") {
          await api.pages.outputState({
            scopeSpaceId,
            outputId: item.source.output.id,
            action: "trash",
          });
          trashed.push(item);
        } else if (item.source.type === "library") {
          libraryIds.push(item.source.item.id);
          trashed.push(item);
        }
      }
      if (libraryIds.length) await api.library.trash({ ids: libraryIds });
      if (open?.type === "item" && targets.some((entry) => entry.key === open.key)) setOpen(null);
      toastManager.add({
        type: "success",
        title: `已将 ${trashed.length} 项移到回收站`,
        actionProps: {
          children: "撤销",
          onClick: () =>
            void run("恢复", async () => {
              const libRestore: string[] = [];
              for (const item of trashed) {
                if (item.source.type === "page") {
                  await pageMutation(item.source.page, {
                    op: isSpaceRoot(item.source.page) ? "restore-space" : "restore",
                  });
                } else if (item.source.type === "output") {
                  await api.pages.outputState({
                    scopeSpaceId,
                    outputId: item.source.output.id,
                    action: "restore",
                  });
                } else if (item.source.type === "library") {
                  libRestore.push(item.source.item.id);
                }
              }
              if (libRestore.length) await api.library.restore({ ids: libRestore });
            }),
        },
      });
    });
  };
  const moveItemsToFolder = (targets: readonly SpaceItem[], destination: GalleryFolder | null) => {
    if (targets.length === 0) return;
    void run(destination ? "移入文件夹" : "移出文件夹", async () => {
      const api = ensureNativeApi();
      let targetSpaceId = (destination?.spaceId as PageSpace["id"] | null | undefined) ?? null;
      let targetRootPageId = targetSpaceId
        ? (spaces.find((entry) => entry.id === targetSpaceId)?.rootPageId ?? null)
        : null;
      let targetLibraryFolderId = destination?.libraryFolderIds[0] ?? null;

      const needsSpace = targets.some(
        (item) => item.source.type === "page" || item.source.type === "app",
      );
      const needsLibraryFolder = targets.some((item) => item.source.type === "library");

      if (destination && needsSpace && !targetSpaceId) {
        const created = await api.pages.mutate({
          op: "create-space",
          requestId: crypto.randomUUID(),
          scopeSpaceId,
          title: destination.title,
        });
        targetSpaceId = created.space?.id ?? null;
        targetRootPageId = created.space?.rootPageId ?? null;
      }
      if (destination && needsLibraryFolder && !targetLibraryFolderId) {
        const createdFolder = await api.library.createFolder({
          id: crypto.randomUUID(),
          title: destination.title,
        });
        targetLibraryFolderId = createdFolder.folder.id;
      }

      const movedPages: Array<{
        page: Page;
        prevSpaceId: Page["spaceId"];
        prevParentPageId: Page["parentPageId"];
      }> = [];
      const libraryMoves: Array<{ id: string; prevFolderId: string | null }> = [];
      const movedApps: Array<{ id: string; revision: number; prevSpaceId: Page["spaceId"] }> = [];
      const outputPrev = new Map<string, string | null>();
      const currentAssignments = useGalleryLocalStore.getState().folderAssignments;

      for (const item of targets) {
        if (item.source.type === "page") {
          const page = item.source.page;
          if (isSpaceRoot(page)) continue;
          const nextSpaceId = destination ? targetSpaceId : null;
          const nextParentId = destination ? targetRootPageId : null;
          if (page.spaceId === nextSpaceId && page.parentPageId === nextParentId) continue;
          const res = await pageMutation(page, {
            op: "move",
            spaceId: nextSpaceId,
            parentPageId: nextParentId,
          });
          movedPages.push({
            page: res.page,
            prevSpaceId: page.spaceId,
            prevParentPageId: page.parentPageId,
          });
        } else if (item.source.type === "library") {
          const entry = item.source.item;
          const nextFolderId = destination ? targetLibraryFolderId : null;
          if (entry.folderId === nextFolderId) continue;
          libraryMoves.push({ id: entry.id, prevFolderId: entry.folderId });
        } else if (item.source.type === "app") {
          const app = item.source.app;
          const nextSpaceId = destination ? targetSpaceId : null;
          if (app.spaceId === nextSpaceId) continue;
          const updatedApp = await moveSpacePageApp({
            scopeSpaceId,
            appId: app.id,
            expectedRevision: app.revision,
            spaceId: nextSpaceId,
          });
          if (updatedApp) {
            movedApps.push({
              id: updatedApp.id,
              revision: updatedApp.revision,
              prevSpaceId: app.spaceId,
            });
          }
        } else {
          outputPrev.set(item.key, currentAssignments[item.key] ?? null);
        }
      }

      if (libraryMoves.length > 0) {
        await api.library.move({
          ids: libraryMoves.map((entry) => entry.id),
          folderId: destination ? targetLibraryFolderId : null,
        });
      }
      if (outputPrev.size > 0) {
        const assignKey = destination
          ? targetSpaceId
            ? `space:${targetSpaceId}`
            : destination.key
          : null;
        useGalleryLocalStore.getState().assignItemsFolder([...outputPrev.keys()], assignKey);
      }

      const movedCount =
        movedPages.length + libraryMoves.length + movedApps.length + outputPrev.size;
      if (movedCount === 0) return;

      const label =
        targets.length === 1
          ? `已将“${spaceItemDisplayTitle(targets[0]!)}”`
          : `已将 ${movedCount} 项`;
      const actionTitle = destination
        ? `${label}移入“${destination.title}”`
        : `${label}移出到未归入文件夹`;

      toastManager.add({
        type: "success",
        title: actionTitle,
        actionProps: {
          children: "撤销",
          onClick: () =>
            void run("撤销移动", async () => {
              for (const entry of movedPages) {
                await pageMutation(entry.page, {
                  op: "move",
                  spaceId: entry.prevSpaceId,
                  parentPageId: entry.prevParentPageId,
                });
              }
              const byPrevFolder = new Map<string | null, string[]>();
              for (const entry of libraryMoves) {
                const list = byPrevFolder.get(entry.prevFolderId) ?? [];
                list.push(entry.id);
                byPrevFolder.set(entry.prevFolderId, list);
              }
              for (const [prevFolderId, ids] of byPrevFolder) {
                await api.library.move({ ids, folderId: prevFolderId });
              }
              for (const entry of movedApps) {
                await moveSpacePageApp({
                  scopeSpaceId,
                  appId: entry.id,
                  expectedRevision: entry.revision,
                  spaceId: entry.prevSpaceId,
                });
              }
              for (const [key, prevAssigned] of outputPrev) {
                useGalleryLocalStore.getState().assignItemFolder(key, prevAssigned);
              }
            }),
        },
      });
    });
  };
  const dropKeysToFolderKey = (folderKey: string | null, keys: readonly string[]) => {
    const resolved = keys
      .map((key) => items.find((item) => item.key === key))
      .filter((entry): entry is SpaceItem => entry !== undefined && entry.trashedAt === null);
    if (resolved.length === 0) return;
    if (folderKey === null) {
      moveItemsToFolder(resolved, null);
      return;
    }
    const folders = buildGalleryTree({
      items,
      spaces,
      libraryFolders,
      folderAssignments,
    }).folders;
    const match = folders.find((folder) => folder.key === folderKey);
    if (match) moveItemsToFolder(resolved, match);
  };
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
  const renameItem = (item: SpaceItem, title: string) =>
    run("重命名", async () => {
      if (item.source.type === "page") {
        const pageId = item.source.page.id;
        await pageMutation(item.source.page, { op: "update", title });
        // An editor opened later reads the new name, not a cached one.
        await Promise.all([
          client.invalidateQueries({
            queryKey: pagesQueryKeys.read(account, scopeSpaceId, pageId),
          }),
          client.invalidateQueries({
            queryKey: pageTypesQueryKeys.item(account, scopeSpaceId, pageId),
          }),
        ]);
      } else if (item.source.type === "library") {
        await ensureNativeApi().library.rename({ id: item.source.item.id, title });
        await client.invalidateQueries({
          queryKey: [...pagesQueryKeys.scope(account, scopeSpaceId), "library"],
        });
      }
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

  /** 文档 opens at once, untitled (as Claude's Docs do); it is named later in place. */
  const createUntitledPage = async (parent: Page | null) => {
    if (busy || !isCurrent()) return;
    setBusy(true);
    setError(null);
    try {
      const spaceId = parent?.spaceId ?? (section.type === "space" ? section.spaceId : null);
      const parentPageId =
        parent?.id ??
        (spaceId ? (spaces.find((space) => space.id === spaceId)?.rootPageId ?? null) : null);
      const input: PagesMutateInput =
        createIntent.pending ??
        createIntent.remember({
          op: "create",
          requestId: crypto.randomUUID(),
          scopeSpaceId,
          title: "未命名文档",
          spaceId,
          parentPageId,
        });
      const result = await createIntent.submit(input, (pending) =>
        ensureNativeApi().pages.mutate(pending),
      );
      createIntent.clear();
      if (!isCurrent()) return;
      client.setQueryData(pagesQueryKeys.read(account, scopeSpaceId, result.page.id), result);
      setOpen({ type: "page", pageId: result.page.id });
      await refresh();
    } catch (cause) {
      if (isPageMutationRejected(cause)) createIntent.clear();
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const startCreate = async (action: SpaceCreateAction, parent: Page | null = null) => {
    if (!(await leave())) return;
    if (action === "page" && !(createIntent.pending?.op === "create-space")) {
      await createUntitledPage(parent);
      return;
    }
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
    if (action === "dashboard") {
      // 数据看板: an empty dashboard; its empty state asks what to show and hands it to Moss.
      const spaceId = section.type === "space" ? section.spaceId : null;
      await run("创建", async () => {
        const created = await createSpaceItem(ensureNativeApi(), {
          scopeSpaceId,
          kind: "app",
          title: "未命名数据看板",
          spaceId,
          data: JSON.stringify(createDashboard("")),
        });
        await refresh();
        setOpen(openPageState(created.page));
      });
      return;
    }
    if (action === "sheet" || action === "board" || action === "design") {
      const spaceId = section.type === "space" ? section.spaceId : null;
      await run("创建", async () => {
        // A 画布 cannot open signed out: never save an empty one (WALK-1 C-1).
        if (action === "board" && (await isMossCanvasAccountSignedOut()))
          throw new Error(MOSS_CANVAS_SIGN_IN_MESSAGE);
        const created = await createSpaceItem(ensureNativeApi(), {
          scopeSpaceId,
          kind: action,
          spaceId,
        });
        await refresh();
        setOpen(openPageState(created.page));
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
      // Raw bytes over HTTP: `library.import` goes through the 2 MiB-capped WebSocket.
      await uploadPickedLibraryFiles(picked);
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
        return { title: "资料空间", description: "" };
      case "kind": {
        const labels = {
          page: "文档",
          slides: "幻灯片",
          site: "站点",
          image: "图像",
          app: "应用页",
        } as const;
        return { title: labels[section.kind], description: "" };
      }
      case "space": {
        const space = spaces.find((entry) => entry.id === section.spaceId);
        return { title: space?.title ?? "资料空间", description: "" };
      }
      case "folder": {
        const folder = libraryFolders.find((entry) => entry.id === section.folderId);
        return { title: folder?.title ?? "文件夹", description: "" };
      }
      case "tag":
        return { title: `#${section.tag}`, description: "" };
      case "collection":
        return {
          title: openedCollection?.title ?? "合集",
          description: section.tags.map((tag) => `#${tag}`).join(" "),
        };
      default:
        return { title: "回收站", description: "" };
    }
  })();
  const openKey =
    open?.type === "page" ? `page:${open.pageId}` : open?.type === "item" ? open.key : null;

  useEffect(() => {
    // ⌘K / Ctrl+K searches the 资料空间 while it is open, before the app-wide palette sees it.
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  const sectionOfFolder = (folder: GalleryFolder): SpaceSection =>
    folder.spaceId
      ? { type: "space", spaceId: folder.spaceId as PageSpace["id"] }
      : { type: "folder", folderId: folder.libraryFolderIds[0] ?? "" };
  const goToPlace = (place: GalleryPlace) => {
    setSyncedSpaceHomeKind("any");
    switch (place.type) {
      case "home":
        return void showSection({ type: "all" });
      case "folder":
        return void showSection(
          place.key.startsWith("space:")
            ? { type: "space", spaceId: place.key.slice(6) as PageSpace["id"] }
            : { type: "folder", folderId: place.key.slice(7) },
        );
      case "tag":
        return void showSection({ type: "tag", tag: place.tag });
      default: {
        // Read the store, not this render: a 合集 saved a moment ago is not in it yet.
        const collection = useGalleryLocalStore
          .getState()
          .collections.find((entry) => entry.id === place.id);
        if (collection)
          void showSection({ type: "collection", id: collection.id, tags: collection.tags });
      }
    }
  };
  // Pictures open beside their details; videos and other files keep the file viewer.
  const openedImage =
    openedItem && openedItem.kind === "image" && openedItem.source.type !== "page"
      ? openedItem
      : null;

  const body = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden" data-moss-data-spaces>
      {sidebarVisible === false ? null : (
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
                // Its pictures (the 资料库 folder of the same name) are the same folder here.
                const pictures = items
                  .filter((item) => item.spaceId === space.id && item.source.type === "library")
                  .map((item) => item.key.slice("library:".length));
                if (pictures.length) await ensureNativeApi().library.trash({ ids: pictures });
                if (section.type === "space" && section.spaceId === space.id)
                  setSection({ type: "all" });
              });
          }}
          onClose={libraryProps.onClose}
          onSearch={() => setSearchOpen(true)}
          onLoadWelcome={
            !spacesQuery.isLoading && !hasWelcomeSpace ? () => void loadWelcomeSamples() : undefined
          }
          onDropToSpace={(spaceId, keys) => dropKeysToFolderKey(`space:${spaceId}`, keys)}
          onDropToLibraryFolder={(folderId, keys) =>
            dropKeysToFolderKey(`folder:${folderId}`, keys)
          }
          onDropToLoose={(keys) => dropKeysToFolderKey(null, keys)}
        />
      )}
      <div ref={workspaceHostRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <SpaceCanvasChatDockHost
          artifact={activeArtifact}
          containerRef={workspaceHostRef}
          keepItemOpen
        >
          {(dock) => {
            dockControllerRef.current = dock;
            return (
              <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="资料空间内容">
                {(error && !dialog) || notice ? (
                  <div
                    role={error ? "alert" : "status"}
                    className="flex items-center gap-2 border-b border-border px-4 py-2 text-ui-sm"
                  >
                    <span className={error ? "flex-1 text-destructive" : "flex-1"}>
                      {error ?? notice}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => (setError(null), setNotice(null))}
                    >
                      知道了
                    </Button>
                  </div>
                ) : null}
                {open?.type === "library" ? (
                  <MossLibraryDestination
                    {...libraryProps}
                    onCanvasLeaveGuardChange={registerGuard}
                  />
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
                    dock={dock}
                    onBack={handleTypedItemBack}
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
                ) : openedImage ? (
                  <GalleryImageViewer
                    key={openedImage.key}
                    item={openedImage}
                    onBack={() => {
                      setMarked(openedImage.key);
                      setOpen(null);
                    }}
                    onContinueInChat={(item) => void continueInChat(item)}
                    onTogglePin={(item) => void togglePin(item)}
                    onTrash={(item) => void trashItem(item).then(() => setOpen(null))}
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
                          const { item, skipped } = await convertSpaceFile({
                            scopeSpaceId,
                            ...file,
                          });
                          await refresh();
                          setOpen(openPageState(item.page));
                          if (skipped) setNotice(`已转换。${skipped} 个图表、表格或组合未能转换。`);
                        })
                      }
                    />
                  ) : openedItem.source.type === "page" &&
                    isTypedSpaceKind(openedItem.source.page.kind) ? (
                    <SpaceTypedItemView
                      key={openedItem.key}
                      account={account}
                      scopeSpaceId={scopeSpaceId}
                      pageId={openedItem.source.page.id}
                      onSaved={handleTypedItemSaved}
                      onGuardChange={registerGuard}
                      dock={dock}
                      onBack={handleTypedItemBack}
                      onOpenCreated={(created) => {
                        client.setQueryData(
                          pageTypesQueryKeys.item(account, scopeSpaceId, created.page.id),
                          created,
                        );
                        setOpen(openPageState(created.page));
                      }}
                      onTrash={() => void trashItem(openedItem)}
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
                    key={`${section.type}:${folderKeyOfSection(section) ?? ""}`}
                    marked={marked}
                    onOpenFolder={(folder) => void showSection(sectionOfFolder(folder))}
                    headerAction={
                      scopeSpaceId === null && section.type === "all" ? (
                        <AccountPageRecovery
                          onRestored={(pageId) => {
                            if (!isCurrent()) return;
                            void openPage(pageId);
                            void refresh();
                          }}
                        />
                      ) : openedCollection ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            removeCollection(openedCollection.id);
                            void showSection({ type: "all" });
                          }}
                        >
                          删除合集
                        </Button>
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
                    onRename={(item, title) => void renameItem(item, title)}
                    onTrash={(item) => void trashItem(item)}
                    onTrashMany={(targets) => trashItems(targets)}
                    onMoveToFolder={(targets, destination) =>
                      moveItemsToFolder(targets, destination)
                    }
                  />
                )}
              </main>
            );
          }}
        </SpaceCanvasChatDockHost>
      </div>
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
            setOpen(openPageState(item.page));
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
        onCreated={(
          item,
          starter?: { readonly starterPrompt?: string; readonly prefillOnly?: boolean },
        ) => {
          void refresh();
          setOpen(openPageState(item.page));
          if (starter?.starterPrompt) {
            setPendingStarter({
              itemId: item.page.id,
              prompt: starter.starterPrompt,
              ...(starter.prefillOnly !== undefined ? { prefillOnly: starter.prefillOnly } : {}),
            });
          }
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
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "space"
                ? "新建资料空间"
                : dialog?.mode === "rename"
                  ? "重命名资料空间"
                  : dialog?.mode === "page" && dialog.parent
                    ? "新建子页面"
                    : "新建页面"}
            </DialogTitle>
          </DialogHeader>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
          >
            <DialogPanel className="flex flex-col gap-2">
              <label htmlFor={dialogNameInputId} className={cn("mt-2", dialogFieldLabelClassName)}>
                {dialog?.mode === "page" ? "页面名称" : "资料空间名称"}
              </label>
              <Input
                id={dialogNameInputId}
                autoFocus
                className={PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME}
                maxLength={256}
                placeholder={dialog?.mode === "page" ? "未命名文档" : "为话题或小组起个名字"}
                value={name}
                disabled={busy || (dialog?.mode !== "rename" && createIntent.pending !== null)}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {error || createIntent.error ? (
                <p role="alert" className="text-ui-sm text-destructive">
                  {error ?? createIntent.error}
                  {dialog?.mode === "rename" ? "" : " 重试会核对同一次创建。"}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" type="button" disabled={busy} onClick={() => setDialog(null)}>
                取消
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy
                  ? "正在保存…"
                  : dialog?.mode === "rename"
                    ? "保存"
                    : createIntent.pending
                      ? "核对创建结果"
                      : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <GallerySearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        placeOf={placeOf}
        onContinueInChat={(item) => void continueInChat(item)}
        onTogglePin={(item) => void togglePin(item)}
        onTrash={(item) => void trashItem(item)}
      />
    </div>
  );

  const openItemRef = useRef(openItem);
  openItemRef.current = openItem;
  const goToPlaceRef = useRef(goToPlace);
  goToPlaceRef.current = goToPlace;
  const handleGalleryOpenItem = useCallback((item: SpaceItem) => {
    void openItemRef.current(item);
  }, []);
  const handleGalleryPlace = useCallback((place: GalleryPlace) => {
    goToPlaceRef.current(place);
  }, []);

  return (
    <GalleryProvider
      account={account}
      scopeSpaceId={scopeSpaceId}
      items={items}
      spaces={spaces}
      libraryFolders={libraryFolders}
      loading={listQuery.isLoading || spacesQuery.isLoading}
      onOpenItem={handleGalleryOpenItem}
      onPlace={handleGalleryPlace}
    >
      {body}
    </GalleryProvider>
  );
}

function isSpaceRoot(page: Page): boolean {
  return page.spaceId !== null && page.rootPageId === page.id;
}
