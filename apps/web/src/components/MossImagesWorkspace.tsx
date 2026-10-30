// Account-bound Images workspace; shared gallery owns Focused/Canvas, zoom and downloads.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";

import { PlusIcon, XIcon, ChevronLeftIcon, ChevronRightIcon, BookIcon } from "~/lib/icons";
import { useTheme } from "~/hooks/useTheme";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import {
  describeMossImagesError,
  loadMossImagesCatalog,
  loadMossImagesHome,
  loadMossImagesWorkspaceBinding,
  loadMossImageJob,
  loadMossImagesHistory,
  mossImagePreviewSource,
  isMossImageOutputUrl,
  readMossImageAssetReference,
  MossImagesError,
  MAX_IMAGE_REFERENCES,
  MAX_TOTAL_REFERENCE_BYTES,
  readMossImageReference,
  requestMossImagesGenerate,
  waitForMossImageJob,
  type MossImageJob,
  type MossImagesCatalog,
} from "~/lib/mossImagesClient";
import { MossCodexShellTopTabChrome, type MossShellTab } from "./MossCodexShellTopTabChrome";
import { GeneratedImagePreviewPane } from "./chat/GeneratedImagePreviewPane";
import { MossImageBilling } from "./MossImageBilling";
import {
  MossImageMarkupEditor,
  type MossImageMarkupDocument,
  type MossImageMarkupResult,
} from "./images/MossImageMarkupEditor";
import { MossImageEraseEditor, type MossImageEraseSelection } from "./images/MossImageEraseEditor";
import type { MossImageStyle } from "./images/mossImagesDiscoveryCatalog";
import {
  mossImagesTemplatePrompt,
  type MossImagesConversationInput,
} from "~/lib/mossImagesConversation";
import { openMossLibraryDestination } from "~/lib/mossCanvasBridge";
import {
  readGeneratedImageContextFile,
  showGeneratedImageContextMenu,
  type GeneratedImageContextMenuHandler,
} from "~/lib/generatedImageContextMenu";
import { Button } from "./ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "./ui/dialog";
import { Menu, MenuItem, MenuPopupBase, MenuTrigger } from "./ui/menu";
import { MossImagesComposer } from "./images/MossImagesComposer";
import { MossImagesDiscovery } from "./images/MossImagesDiscovery";
import type { ModelSelection } from "@synara/contracts";
import type { Project } from "~/types";
import type { RightDockImagePreviewView } from "~/rightDockStore.logic";
import type { MossCanvasImageFocus } from "~/lib/mossCanvasBridge";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

export { requestMossImagesGenerate } from "~/lib/mossImagesClient";
export type { MossImagesGenerateRequest } from "~/lib/mossImagesClient";

export interface MossImagesWorkspaceProps {
  readonly voiceProject?: Project | undefined;
  readonly onClose: () => void;
  readonly threadId?: string | null;
  readonly prepareThread?: () => Promise<string | null>;
  readonly onEditInCanvas?: (image: MossCanvasImageFocus, isCurrent?: () => boolean) => void;
  readonly onStartConversation?:
    | ((input: MossImagesConversationInput) => Promise<void>)
    | undefined;
}
export type MossImagesViewMode = "prompt" | "result";

interface ImageReference {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly file: File;
}
type ImageEditRequest =
  | { readonly kind: "resize"; readonly aspectRatio: string }
  | { readonly kind: "remove-background" }
  | { readonly kind: "erase"; readonly source: string; readonly mask: string };
interface MossImagesTab extends MossShellTab {
  readonly mode: MossImagesViewMode;
  readonly prompt: string;
  readonly followUp: string;
  readonly references: readonly ImageReference[];
  readonly jobIds: readonly string[];
  readonly conversationId: string | null;
  readonly conversationCursor: string | null | undefined;
  readonly conversationError: string | null;
  readonly historyAnchorJobId: string | null;
  readonly style: MossImageStyle | null;
  readonly activeImageId: string | null;
  readonly view: RightDockImagePreviewView;
  readonly busy: boolean;
  readonly error: string | null;
  readonly markup: {
    readonly sourceImageId: string;
    readonly url: string;
    readonly document: MossImageMarkupDocument;
    readonly comments: string;
  } | null;
}

function createImagesTab(id: string, title = "图像"): MossImagesTab {
  return {
    id,
    title,
    active: true,
    kind: "prompt",
    mode: "prompt",
    prompt: "",
    followUp: "",
    references: [],
    jobIds: [],
    conversationId: null,
    conversationCursor: undefined,
    conversationError: null,
    historyAnchorJobId: null,
    style: null,
    activeImageId: null,
    view: "single",
    busy: false,
    error: null,
    markup: null,
  };
}
function jobStatusLabel(job: MossImageJob): string {
  switch (job.status) {
    case "queued":
      return "已排队";
    case "running":
      return "正在生成";
    case "succeeded":
      return "已生成";
    case "reconciliation_required":
      return "等待确认任务与费用";
    case "failed_terminal":
      return "生成未完成";
  }
}
function jobFailure(job: MossImageJob): string | null {
  if (job.status === "reconciliation_required")
    return "任务结果和费用尚待确认，请点击“检查任务与费用”。重复生成可能产生另一笔费用。";
  if (job.status === "failed_terminal")
    return job.errorMessage || "生成未完成，请检查描述和模型后重试。";
  return null;
}
function imageTitle(prompt: string): string {
  return prompt.length > 24 ? `${prompt.slice(0, 24)}…` : prompt || "新图像";
}

function mergeImageJobs(current: readonly MossImageJob[], incoming: readonly MossImageJob[]) {
  const merged = new Map(current.map((job) => [job.jobId, job]));
  for (const job of incoming) {
    const existing = merged.get(job.jobId);
    if (!existing || (job.revision ?? 0) >= (existing.revision ?? 0)) merged.set(job.jobId, job);
  }
  return [...merged.values()];
}

function isAccountInvalidation(error: unknown) {
  return (
    error instanceof MossImagesError &&
    (error.code === "media_account_changed" ||
      error.status === 401 ||
      (error.status === 403 && error.code !== "media_skill_not_installed"))
  );
}

export function MossImagesWorkspace({
  onClose,
  threadId,
  prepareThread,
  onEditInCanvas,
  onStartConversation,
  voiceProject,
}: MossImagesWorkspaceProps) {
  const usesConversationEntry = onStartConversation !== undefined;
  const { resolvedTheme } = useTheme();
  const accountBoundary = useMossImagesAccountBoundary();
  const appliedBoundaryRef = useRef(accountBoundary.key);
  const [tabs, setTabs] = useState<MossImagesTab[]>(() => [createImagesTab("images-home")]);
  const [catalog, setCatalog] = useState<MossImagesCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [conversationSelection, setConversationSelection] = useState<{
    ownerKey: string;
    selection: ModelSelection;
    unavailableReason: string | null;
  } | null>(null);
  const aspectRatio = "1:1";
  const [readingReferences, setReadingReferences] = useState(false);
  const [draggingImages, setDraggingImages] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null | undefined>(undefined);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRequestRef = useRef<AbortController | null>(null);
  const historyScopeRef = useRef<string | null>(null);
  const [referencePickerKey, setReferencePickerKey] = useState<string | null>(null);
  const [sketchEditor, setSketchEditor] = useState<{
    readonly id: string;
    readonly scopeKey: string;
  } | null>(null);
  const [markupEditor, setMarkupEditor] = useState<{
    id: string;
    mode: "markup" | "erase";
    modelId: string;
    tabId: string;
    imageId: string;
    imagePath: string;
    boundaryKey: string;
    file: File | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoRowRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const requestsRef = useRef(new Map<string, AbortController>());
  const refreshRef = useRef<AbortController | null>(null);
  const accountRef = useRef<string | null>(null);
  const hasReadAccountRef = useRef(false);
  const referencesReadRef = useRef(0);
  const accountReady =
    !accountBoundary.transitioning && appliedBoundaryRef.current === accountBoundary.key;
  const visibleCatalog = accountReady ? catalog : null;
  const visibleTabs = accountReady ? tabs : [createImagesTab("images-home")];
  const activeTab = visibleTabs.find((tab) => tab.active) ?? visibleTabs[0]!;
  const models =
    visibleCatalog?.models.filter((model) => model.kind === "image" && model.installed) ?? [];
  const model = models.find((item) => item.id === modelId);
  const jobs = visibleCatalog?.jobs.filter((job) => job.operation !== "video") ?? [];
  const orderedJobIds =
    activeTab.historyAnchorJobId && !activeTab.jobIds.includes(activeTab.historyAnchorJobId)
      ? [activeTab.historyAnchorJobId, ...activeTab.jobIds]
      : activeTab.jobIds;
  const tabJobs = orderedJobIds.flatMap((id) => {
    const job = jobs.find((item) => item.jobId === id);
    return job ? [job] : [];
  });
  const images = tabJobs.flatMap((job) =>
    job.imageUrls.map((url, index) => {
      const asset = job.assets?.find((item) => item.kind === "image" && item.index === index);
      const extension =
        asset?.contentType === "image/jpeg" ? "jpg" : (asset?.contentType.split("/")[1] ?? "png");
      return {
        id: `${job.jobId}:${index}`,
        jobId: job.jobId,
        path: mossImagePreviewSource(job, index),
        sourceUrl: url,
        asset,
        name: `moss-${job.jobId}-${index + 1}.${extension}`,
      };
    }),
  );
  const activeImage = images.find((image) => image.id === activeTab.activeImageId) ?? images.at(-1);
  const currentMarkup =
    activeTab.markup?.sourceImageId === activeImage?.id ? activeTab.markup : null;
  const newestJob = tabJobs.at(-1);
  const hasAccount = Boolean(visibleCatalog?.account);
  const canGenerate =
    hasAccount &&
    !visibleCatalog?.mediaWallet?.reviewRequired &&
    model?.available === true &&
    !loading &&
    !readingReferences;
  const prompt = activeTab.mode === "result" ? activeTab.followUp : activeTab.prompt;
  const isEditing = activeTab.mode === "result" && Boolean(activeImage);
  const isConversationEntry = usesConversationEntry;
  const supportsReferences = isConversationEntry || model?.supportsReferences === true;
  const canSubmit = isConversationEntry ? accountReady && !readingReferences : canGenerate;
  const canAttach =
    (isConversationEntry || hasAccount) &&
    accountReady &&
    supportsReferences &&
    !activeTab.busy &&
    !readingReferences;
  const discoveryKey = `${accountBoundary.key}:${activeTab.id}`;
  const reportConversationSelection = useCallback(
    (selection: ModelSelection, unavailableReason: string | null) => {
      setConversationSelection({ ownerKey: discoveryKey, selection, unavailableReason });
    },
    [discoveryKey],
  );
  const visibleSketch =
    accountReady &&
    sketchEditor?.scopeKey === discoveryKey &&
    activeTab.mode === "prompt" &&
    supportsReferences;
  const visibleReferencePicker =
    accountReady && referencePickerKey === discoveryKey && supportsReferences;
  const sketchOwnerRef = useRef<string | null>(null);
  sketchOwnerRef.current = visibleSketch ? sketchEditor!.id : null;
  useLayoutEffect(() => {
    if (!visibleSketch) setSketchEditor(null);
    if (!visibleReferencePicker) setReferencePickerKey(null);
  }, [visibleSketch, visibleReferencePicker]);
  const contextOwnerRef = useRef({
    tabId: activeTab.id,
    boundaryKey: accountBoundary.key,
    modelId,
    imageId: activeImage?.id,
    imagePath: activeImage?.path,
  });
  contextOwnerRef.current = {
    tabId: activeTab.id,
    boundaryKey: accountBoundary.key,
    modelId,
    imageId: activeImage?.id,
    imagePath: activeImage?.path,
  };
  const conversationReadVersionRef = useRef(0);
  useLayoutEffect(() => {
    conversationReadVersionRef.current += 1;
  }, [activeTab.id, accountBoundary.key, activeImage?.id, activeImage?.path]);
  const openImageInCanvas = (image: MossCanvasImageFocus) => {
    const version = conversationReadVersionRef.current;
    const accountIsCurrent = boundaryRef.current.isCurrent;
    onEditInCanvas?.(
      image,
      () => accountIsCurrent() && version === conversationReadVersionRef.current,
    );
  };
  const visibleMarkupEditor =
    accountReady &&
    activeTab.mode === "result" &&
    markupEditor?.boundaryKey === accountBoundary.key &&
    markupEditor.tabId === activeTab.id &&
    markupEditor.imageId === activeImage?.id &&
    markupEditor.imagePath === activeImage.path &&
    markupEditor.modelId === modelId &&
    (markupEditor.mode !== "erase" || model?.supportsMaskEdits === true)
      ? markupEditor
      : null;
  const markupEditorIdRef = useRef<string | undefined>(undefined);
  markupEditorIdRef.current = visibleMarkupEditor?.id;
  useLayoutEffect(() => {
    if (markupEditor && !visibleMarkupEditor) setMarkupEditor(null);
  }, [markupEditor, visibleMarkupEditor]);

  const updateTab = useCallback((id: string, update: (tab: MossImagesTab) => MossImagesTab) => {
    setTabs((previous) => previous.map((tab) => (tab.id === id ? update(tab) : tab)));
  }, []);

  const boundaryRef = useRef(accountBoundary);
  boundaryRef.current = accountBoundary;
  const clearAccountState = useCallback(() => {
    refreshRef.current?.abort();
    historyRequestRef.current?.abort();
    historyScopeRef.current = null;
    for (const request of requestsRef.current.values()) request.abort();
    requestsRef.current.clear();
    referencesReadRef.current += 1;
    accountRef.current = null;
    hasReadAccountRef.current = false;
    setReadingReferences(false);
    setCatalog(null);
    setTabs([createImagesTab("images-home")]);
    setModelId("");
    setHistoryCursor(undefined);
    setHistoryError(null);
    setHistoryLoading(false);
    setLoading(false);
  }, []);
  const readHistoryPage = useCallback(
    async (account: NonNullable<MossImagesCatalog["account"]>, cursor?: string) => {
      historyRequestRef.current?.abort();
      const controller = new AbortController();
      historyRequestRef.current = controller;
      const accountKey = `${account.realm}:${account.id}`;
      const current = () =>
        mountedRef.current &&
        !controller.signal.aborted &&
        historyRequestRef.current === controller &&
        accountRef.current === accountKey &&
        boundaryRef.current.isCurrent();
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const page = await loadMossImagesHistory(
          { expectedAccount: account, ...(cursor ? { cursor } : {}) },
          controller.signal,
        );
        if (!current()) return;
        setCatalog((previous) =>
          previous &&
          previous.account?.id === account.id &&
          previous.account.realm === account.realm
            ? { ...previous, jobs: mergeImageJobs(previous.jobs, page.jobs) }
            : previous,
        );
        setHistoryCursor(page.nextCursor);
      } catch (error) {
        if (current()) {
          if (isAccountInvalidation(error)) {
            clearAccountState();
            setCatalogError(describeMossImagesError(error));
          } else setHistoryError(describeMossImagesError(error));
        }
      } finally {
        if (current()) setHistoryLoading(false);
      }
    },
    [clearAccountState],
  );
  const refresh = useCallback(async () => {
    if (!boundaryRef.current.isCurrent()) return;
    refreshRef.current?.abort();
    const controller = new AbortController();
    refreshRef.current = controller;
    setLoading(true);
    try {
      const next = await (usesConversationEntry ? loadMossImagesHome : loadMossImagesCatalog)(
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted || !boundaryRef.current.isCurrent())
        return;
      const accountKey = next.account ? `${next.account.realm}:${next.account.id}` : null;
      if (
        accountRef.current !== accountKey &&
        (!usesConversationEntry || hasReadAccountRef.current)
      ) {
        for (const request of requestsRef.current.values()) request.abort();
        requestsRef.current.clear();
        referencesReadRef.current += 1;
        setReadingReferences(false);
        setTabs([createImagesTab("images-home")]);
        historyRequestRef.current?.abort();
        historyScopeRef.current = null;
        setHistoryCursor(undefined);
        setHistoryError(null);
        setHistoryLoading(false);
      }
      hasReadAccountRef.current = true;
      accountRef.current = accountKey;
      setCatalog((previous) =>
        previous?.account &&
        next.account &&
        previous.account.id === next.account.id &&
        previous.account.realm === next.account.realm
          ? { ...next, jobs: mergeImageJobs(previous.jobs, next.jobs) }
          : next,
      );
      if (next.account && next.nextCursor !== undefined && historyScopeRef.current !== accountKey) {
        historyScopeRef.current = accountKey;
        if (usesConversationEntry) setHistoryCursor(next.nextCursor);
        else void readHistoryPage(next.account);
      }
      setCatalogError(
        next.errorCode && next.account
          ? "模型目录暂时无法读取，已有图像仍可查看。请稍后刷新。"
          : null,
      );
      setModelId((current) => {
        const installed = next.models.filter((item) => item.kind === "image" && item.installed);
        return installed.some((item) => item.id === current)
          ? current
          : (installed.find((item) => item.available)?.id ?? installed[0]?.id ?? "");
      });
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current) {
        setCatalogError(describeMossImagesError(error));
        if (isAccountInvalidation(error)) clearAccountState();
      }
    } finally {
      if (!controller.signal.aborted && mountedRef.current) setLoading(false);
    }
  }, [clearAccountState, readHistoryPage, usesConversationEntry]);

  useLayoutEffect(() => {
    const changed = appliedBoundaryRef.current !== accountBoundary.key;
    appliedBoundaryRef.current = accountBoundary.key;
    if (!changed && !accountBoundary.transitioning) return;
    // Clear before paint. Even a transport that ignores AbortSignal cannot commit
    // its late response after its controller has been retired here.
    refreshRef.current?.abort();
    historyRequestRef.current?.abort();
    historyScopeRef.current = null;
    setHistoryCursor(undefined);
    setHistoryError(null);
    setHistoryLoading(false);
    for (const request of requestsRef.current.values()) request.abort();
    requestsRef.current.clear();
    referencesReadRef.current += 1;
    accountRef.current = null;
    hasReadAccountRef.current = false;
    setReadingReferences(false);
    setCatalog(null);
    setCatalogError(null);
    setModelId("");
    setTabs([createImagesTab("images-home")]);
    setLoading(accountBoundary.transitioning);
    if (!accountBoundary.transitioning) void refresh();
  }, [accountBoundary.key, accountBoundary.transitioning, refresh]);

  useEffect(() => {
    mountedRef.current = true;
    const requests = requestsRef.current;
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      mountedRef.current = false;
      refreshRef.current?.abort();
      historyRequestRef.current?.abort();
      referencesReadRef.current += 1;
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Let select popups and other dialogs own Escape before closing the workspace.
      if (document.querySelector('[role="listbox"], [role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const applyJob = useCallback(
    (tabId: string, job: MossImageJob) => {
      setCatalog((previous) =>
        previous
          ? {
              ...previous,
              jobs: mergeImageJobs(previous.jobs, [job]),
            }
          : previous,
      );
      updateTab(tabId, (tab) => ({
        ...tab,
        title: imageTitle(job.prompt),
        kind: "image",
        mode: "result",
        jobIds: tab.jobIds.includes(job.jobId) ? tab.jobIds : [...tab.jobIds, job.jobId],
        conversationId: job.conversationId ?? tab.conversationId,
        activeImageId: job.imageUrls.length ? `${job.jobId}:0` : tab.activeImageId,
        error: jobFailure(job),
      }));
    },
    [updateTab],
  );

  const observeJob = async (tabId: string, job: MossImageJob, controller: AbortController) => {
    const apply = (next: MossImageJob) => {
      if (
        mountedRef.current &&
        requestsRef.current.get(tabId) === controller &&
        !controller.signal.aborted
      )
        applyJob(tabId, next);
    };
    apply(job);
    await waitForMossImageJob({ job, signal: controller.signal, onUpdate: apply });
    if (!controller.signal.aborted && mountedRef.current) void refresh();
  };

  const runGenerate = async (
    edit?: ImageEditRequest,
    template?: { prompt: string; aspectRatio: string },
    modelSelection?: ModelSelection,
  ) => {
    const tabId = activeTab.id;
    const editorId = edit?.kind === "erase" ? visibleMarkupEditor?.id : undefined;
    // Resize is an edit of the current image, using the same paid request path.
    // Pass the selected ratio directly; a state update may not have committed yet.
    const text =
      edit?.kind === "resize"
        ? `将这张图像的宽高比调整为 ${edit.aspectRatio}`
        : edit?.kind === "erase"
          ? "移除此图像中选定的区域。"
          : edit?.kind === "remove-background"
            ? "移除此图像的背景。保持所有前景主体完整且不变，边缘干净平滑，并使背景透明。"
            : template
              ? onStartConversation
                ? mossImagesTemplatePrompt(template.prompt, template.aspectRatio)
                : template.prompt
              : [currentMarkup?.comments, prompt.trim(), activeTab.style?.promptSuffix]
                  .filter(Boolean)
                  .join("\n\n");
    const isConversationSubmit = !edit && onStartConversation !== undefined;
    const supportsRequestReferences = isConversationSubmit || model?.supportsReferences === true;
    if (
      (edit && !isEditing) ||
      (edit?.kind === "erase" && model?.supportsMaskEdits !== true) ||
      (edit?.kind === "remove-background" && model?.supportsTransparentBackground !== true) ||
      !text ||
      !(isConversationSubmit ? canSubmit : canGenerate) ||
      !boundaryRef.current.isCurrent() ||
      activeTab.busy ||
      requestsRef.current.has(tabId) ||
      (!isConversationSubmit && !model)
    )
      return false;
    if ((isEditing || activeTab.references.length > 0) && !supportsRequestReferences) {
      updateTab(tabId, (tab) => ({
        ...tab,
        error: "该模型不支持参考图编辑，请选择支持编辑的模型。",
      }));
      return false;
    }
    if (
      !edit &&
      activeTab.style?.requiresReference &&
      (!supportsRequestReferences || (!isEditing && activeTab.references.length === 0))
    ) {
      updateTab(tabId, (tab) => ({
        ...tab,
        error: "此样式需要参考图，请先添加图片并选择支持参考图的模型。",
      }));
      return false;
    }
    const controller = new AbortController();
    requestsRef.current.set(tabId, controller);
    updateTab(tabId, (tab) => ({ ...tab, busy: true, error: null }));
    try {
      if (!edit && onStartConversation) {
        if (!modelSelection) throw new Error("请选择会话 CLI 后发送。");
        const version = conversationReadVersionRef.current;
        const accountKey = accountRef.current;
        const accountIsCurrent = boundaryRef.current.isCurrent;
        // The normal handoff unmounts this workspace before dispatch. Keep the
        // captured image/account guard valid across that expected unmount.
        const isCurrent = () =>
          accountIsCurrent() &&
          version === conversationReadVersionRef.current &&
          (!isEditing || accountKey === accountRef.current);
        const original =
          isEditing && activeImage
            ? await readGeneratedImageContextFile({
                image: {
                  src: currentMarkup?.url ?? activeImage.path,
                  name: activeImage.name,
                },
                resolveImageUrl: ({ src }) => src,
                fetchCredentials: !currentMarkup && activeImage.asset ? "include" : "omit",
              })
            : null;
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          requestsRef.current.get(tabId) !== controller ||
          !isCurrent()
        )
          return false;
        await onStartConversation({
          prompt: text,
          modelSelection,
          references: [
            ...(original ? [original] : []),
            ...activeTab.references.map((reference) => reference.file),
          ],
          isCurrent,
        });
        return true;
      }
      if (!model) return false;
      const expectedAccount = {
        id: visibleCatalog!.account!.id,
        realm: visibleCatalog!.account!.realm,
      };
      const preparedThreadId = prepareThread ? await prepareThread() : threadId;
      controller.signal.throwIfAborted();
      if (prepareThread && !preparedThreadId)
        throw new MossImagesError("会话的工作文件夹尚未就绪。", "canvas_workspace_unavailable");
      if (preparedThreadId && threadRef.current != null && threadRef.current !== preparedThreadId)
        throw new MossImagesError("会话已变化，请重新发送。", "canvas_workspace_changed");
      const workspace = preparedThreadId
        ? await loadMossImagesWorkspaceBinding(preparedThreadId, expectedAccount, controller.signal)
        : undefined;
      controller.signal.throwIfAborted();
      if (preparedThreadId && threadRef.current != null && threadRef.current !== preparedThreadId)
        throw new MossImagesError("会话已变化，请重新发送。", "canvas_workspace_changed");
      const original =
        isEditing && activeImage
          ? edit?.kind === "erase"
            ? edit.source
            : !edit && currentMarkup
              ? currentMarkup.url
              : activeImage.asset
                ? await readMossImageAssetReference(activeImage.asset, controller.signal)
                : activeImage.sourceUrl
          : null;
      controller.signal.throwIfAborted();
      if (!boundaryRef.current.isCurrent()) throw new DOMException("Account changed", "AbortError");
      const referenceImages = [
        ...new Set([
          ...(original ? [original] : []),
          ...(edit ? [] : activeTab.references.map((image) => image.url)),
        ]),
      ];
      if (
        referenceImages.reduce(
          (total, image) => total + image.length,
          edit?.kind === "erase" ? edit.mask.length : 0,
        ) >
        7 * 1024 * 1024
      ) {
        throw new MossImagesError(
          "参考图总大小过大，请减少参考图或缩小图片。",
          "reference_too_large",
        );
      }
      const job = await requestMossImagesGenerate(
        {
          prompt: text,
          modelId: model.id,
          aspectRatio:
            edit?.kind === "resize"
              ? edit.aspectRatio
              : edit
                ? "auto"
                : (template?.aspectRatio ?? aspectRatio),
          idempotencyKey: crypto.randomUUID(),
          expectedAccount,
          ...(workspace ? { workspace } : {}),
          ...(isEditing && activeTab.conversationId && activeImage
            ? { conversationId: activeTab.conversationId, parentJobId: activeImage.jobId }
            : {}),
          ...(referenceImages.length ? { referenceImages } : {}),
          ...(edit?.kind === "erase" ? { maskImage: edit.mask, outputFormat: "png" as const } : {}),
          ...(edit?.kind === "remove-background"
            ? { background: "transparent" as const, outputFormat: "png" as const }
            : {}),
        },
        controller.signal,
      );
      if (!controller.signal.aborted && mountedRef.current) {
        if (!edit)
          updateTab(tabId, (tab) => ({ ...tab, followUp: "", references: [], markup: null }));
        if (edit?.kind === "erase")
          setMarkupEditor((previous) => (previous?.id === editorId ? null : previous));
        await observeJob(tabId, job, controller);
      }
      return true;
    } catch (error) {
      if (mountedRef.current && requestsRef.current.get(tabId) === controller) {
        if (isAccountInvalidation(error)) {
          clearAccountState();
          void refresh();
        } else {
          updateTab(tabId, (tab) => ({ ...tab, error: describeMossImagesError(error) }));
        }
      }
      return false;
    } finally {
      if (requestsRef.current.get(tabId) === controller) {
        requestsRef.current.delete(tabId);
        if (mountedRef.current) updateTab(tabId, (tab) => ({ ...tab, busy: false }));
      }
    }
  };

  const resumeJob = async (job: MossImageJob) => {
    const tabId = activeTab.id;
    if (!boundaryRef.current.isCurrent() || requestsRef.current.has(tabId)) return;
    const controller = new AbortController();
    requestsRef.current.set(tabId, controller);
    updateTab(tabId, (tab) => ({ ...tab, busy: true, error: null }));
    try {
      const current = await loadMossImageJob(job.jobId, controller.signal);
      controller.signal.throwIfAborted();
      if (!boundaryRef.current.isCurrent()) throw new DOMException("Account changed", "AbortError");
      await observeJob(tabId, current, controller);
    } catch (error) {
      if (mountedRef.current && requestsRef.current.get(tabId) === controller) {
        if (isAccountInvalidation(error)) {
          clearAccountState();
          setCatalogError(describeMossImagesError(error));
        } else updateTab(tabId, (tab) => ({ ...tab, error: describeMossImagesError(error) }));
      }
    } finally {
      if (requestsRef.current.get(tabId) === controller) {
        requestsRef.current.delete(tabId);
        if (mountedRef.current) updateTab(tabId, (tab) => ({ ...tab, busy: false }));
      }
    }
  };

  const restoreConversation = async (
    job: MossImageJob,
    loadEarlier = false,
    tabId = activeTab.id,
    imageIndex = 0,
  ) => {
    const account = visibleCatalog?.account;
    if (!account || !boundaryRef.current.isCurrent() || requestsRef.current.has(tabId)) return;
    if (!job.conversationId) {
      updateTab(tabId, (tab) => ({
        ...tab,
        mode: "result",
        kind: "image",
        jobIds: [job.jobId],
        conversationId: null,
        conversationCursor: undefined,
        conversationError: null,
        historyAnchorJobId: null,
        activeImageId: job.imageUrls.length ? `${job.jobId}:${imageIndex}` : null,
        title: imageTitle(job.prompt),
        error: jobFailure(job),
      }));
      return;
    }
    const controller = new AbortController();
    const accountKey = accountRef.current;
    requestsRef.current.set(tabId, controller);
    updateTab(tabId, (tab) => ({
      ...tab,
      busy: true,
      conversationError: null,
      ...(!loadEarlier
        ? {
            mode: "result" as const,
            kind: "image" as const,
            jobIds: [],
            conversationId: job.conversationId!,
            conversationCursor: undefined,
            historyAnchorJobId: job.jobId,
            activeImageId: job.imageUrls.length ? `${job.jobId}:${imageIndex}` : null,
            title: imageTitle(job.prompt),
            error: jobFailure(job),
          }
        : {}),
    }));
    const current = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      requestsRef.current.get(tabId) === controller &&
      accountRef.current === accountKey &&
      boundaryRef.current.isCurrent();
    try {
      const page = await loadMossImagesHistory(
        {
          expectedAccount: account,
          conversationId: job.conversationId,
          ...(loadEarlier && activeTab.conversationCursor
            ? { cursor: activeTab.conversationCursor }
            : {}),
        },
        controller.signal,
      );
      if (!current()) return;
      setCatalog((previous) =>
        previous ? { ...previous, jobs: mergeImageJobs(previous.jobs, page.jobs) } : previous,
      );
      updateTab(tabId, (tab) => ({
        ...tab,
        conversationCursor: page.nextCursor,
        jobIds: [
          ...new Set([
            ...page.jobs.toReversed().map((entry) => entry.jobId),
            ...(loadEarlier ? tab.jobIds : []),
          ]),
        ],
      }));
    } catch (error) {
      if (current()) {
        if (isAccountInvalidation(error)) {
          clearAccountState();
          setCatalogError(describeMossImagesError(error));
        } else
          updateTab(tabId, (tab) => ({
            ...tab,
            conversationError: describeMossImagesError(error),
          }));
      }
    } finally {
      if (requestsRef.current.get(tabId) === controller) {
        requestsRef.current.delete(tabId);
        if (mountedRef.current)
          updateTab(tabId, (tab) => ({
            ...tab,
            busy: false,
            ...(controller.signal.aborted
              ? { conversationError: "已停止读取记录，可以重试。" }
              : {}),
          }));
      }
    }
  };

  const closeTab = (tabId: string) => {
    referencesReadRef.current += 1;
    setReadingReferences(false);
    requestsRef.current.get(tabId)?.abort();
    requestsRef.current.delete(tabId);
    setTabs((previous) => {
      const remaining = previous.filter((tab) => tab.id !== tabId);
      if (!remaining.length) return [createImagesTab("images-home")];
      if (remaining.some((tab) => tab.active)) return remaining;
      const last = remaining.at(-1)!;
      return [...remaining.slice(0, -1), { ...last, active: true }];
    });
  };
  const addReferences = async (
    files: FileList | readonly File[] | (() => Promise<readonly File[]>) | null,
    options?: { readonly promptMode?: boolean; readonly isCurrent?: () => boolean },
  ) => {
    if (
      !files ||
      activeTab.busy ||
      readingReferences ||
      (!isConversationEntry && !hasAccount) ||
      !accountReady ||
      options?.isCurrent?.() === false ||
      !boundaryRef.current.isCurrent()
    )
      return false;
    const tabId = activeTab.id;
    if (!supportsReferences) {
      updateTab(tabId, (tab) => ({ ...tab, error: "所选模型不支持参考图，请更换模型。" }));
      return false;
    }
    const version = ++referencesReadRef.current;
    const accountKey = accountRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      version === referencesReadRef.current &&
      (isConversationEntry || accountKey === accountRef.current) &&
      options?.isCurrent?.() !== false &&
      boundaryRef.current.isCurrent();
    setReadingReferences(true);
    try {
      const selected = Array.from(typeof files === "function" ? await files() : files);
      if (!isCurrent() || !selected.length) return false;
      const total =
        selected.reduce((sum, file) => sum + file.size, 0) +
        activeTab.references.reduce((sum, image) => sum + image.size, 0);
      if (
        selected.length +
          activeTab.references.length +
          (isEditing && !options?.promptMode ? 1 : 0) >
          MAX_IMAGE_REFERENCES ||
        total > MAX_TOTAL_REFERENCE_BYTES
      ) {
        throw new MossImagesError(
          "最多使用 4 张参考图（含当前图像），上传文件总大小不能超过 5 MB。",
          "reference_too_large",
        );
      }
      const references = await Promise.all(
        selected.map(async (file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          file,
          url: await readMossImageReference(file),
        })),
      );
      if (isCurrent()) {
        updateTab(tabId, (tab) => ({
          ...tab,
          ...(options?.promptMode && tab.mode === "result"
            ? {
                mode: "prompt" as const,
                jobIds: [],
                conversationId: null,
                conversationCursor: undefined,
                conversationError: null,
                historyAnchorJobId: null,
                activeImageId: null,
                markup: null,
              }
            : {}),
          references: [...tab.references, ...references],
          error: null,
        }));
        return true;
      }
      return false;
    } catch (error) {
      if (isCurrent())
        updateTab(tabId, (tab) => ({ ...tab, error: describeMossImagesError(error) }));
      return false;
    } finally {
      if (mountedRef.current && version === referencesReadRef.current) setReadingReferences(false);
    }
  };

  const addGeneratedReference = (job: MossImageJob, index: number) => {
    const image = {
      src: mossImagePreviewSource(job, index),
      name: `moss-${job.jobId}-${index + 1}.png`,
    };
    void addReferences(
      async () => [
        await readGeneratedImageContextFile({
          image,
          resolveImageUrl: ({ src }) => src,
          fetchCredentials: job.assets?.some(
            (asset) => asset.kind === "image" && asset.index === index,
          )
            ? "include"
            : "omit",
        }),
      ],
      { promptMode: true },
    );
  };

  const openMarkup = async (mode: "markup" | "erase" = "markup") => {
    if (
      !activeImage ||
      !hasAccount ||
      !accountReady ||
      !supportsReferences ||
      activeTab.busy ||
      !boundaryRef.current.isCurrent() ||
      (mode === "erase" && model?.supportsMaskEdits !== true)
    )
      return;
    const owner = {
      id: crypto.randomUUID(),
      mode,
      modelId,
      tabId: activeTab.id,
      imageId: activeImage.id,
      imagePath: activeImage.path,
      boundaryKey: accountBoundary.key,
      file: null,
    };
    setMarkupEditor(owner);
    const isCurrent = () =>
      mountedRef.current &&
      boundaryRef.current.isCurrent() &&
      owner.boundaryKey === contextOwnerRef.current.boundaryKey &&
      owner.tabId === contextOwnerRef.current.tabId &&
      owner.imageId === contextOwnerRef.current.imageId &&
      owner.imagePath === contextOwnerRef.current.imagePath;
    try {
      const file = await readGeneratedImageContextFile({
        image: { src: activeImage.path, name: activeImage.name },
        resolveImageUrl: ({ src }) => src,
        fetchCredentials: activeImage.asset ? "include" : "omit",
      });
      if (isCurrent())
        setMarkupEditor((previous) => (previous?.id === owner.id ? { ...owner, file } : previous));
    } catch (error) {
      if (isCurrent()) {
        setMarkupEditor((previous) => (previous?.id === owner.id ? null : previous));
        updateTab(owner.tabId, (tab) => ({ ...tab, error: describeMossImagesError(error) }));
      }
    }
  };

  const applyMarkup = async (result: MossImageMarkupResult) => {
    const owner = visibleMarkupEditor;
    if (!owner) return;
    const url = await readMossImageReference(result.file);
    if (
      !mountedRef.current ||
      markupEditorIdRef.current !== owner.id ||
      !boundaryRef.current.isCurrent() ||
      owner.boundaryKey !== contextOwnerRef.current.boundaryKey ||
      owner.tabId !== contextOwnerRef.current.tabId ||
      owner.imageId !== contextOwnerRef.current.imageId ||
      owner.imagePath !== contextOwnerRef.current.imagePath
    )
      return;
    updateTab(owner.tabId, (tab) => ({
      ...tab,
      markup: {
        sourceImageId: owner.imageId,
        url,
        document: result.document,
        comments: result.comments,
      },
      error: null,
    }));
    setMarkupEditor(null);
    document.querySelector<HTMLElement>("[data-moss-images-composer] [contenteditable]")?.focus();
  };

  const applyErase = async (selection: MossImageEraseSelection) => {
    const owner = visibleMarkupEditor;
    if (!owner || owner.mode !== "erase") return;
    const [source, mask] = await Promise.all([
      readMossImageReference(selection.source),
      readMossImageReference(selection.mask),
    ]);
    if (
      !mountedRef.current ||
      markupEditorIdRef.current !== owner.id ||
      !boundaryRef.current.isCurrent() ||
      owner.boundaryKey !== contextOwnerRef.current.boundaryKey ||
      owner.tabId !== contextOwnerRef.current.tabId ||
      owner.imageId !== contextOwnerRef.current.imageId ||
      owner.imagePath !== contextOwnerRef.current.imagePath ||
      owner.modelId !== contextOwnerRef.current.modelId
    )
      return;
    if (!(await runGenerate({ kind: "erase", source, mask })))
      throw new Error("擦除请求未被接受，请检查模型与账户状态后重试。");
  };

  const showImageMenu: GeneratedImageContextMenuHandler = (image, event) => {
    event.preventDefault();
    event.stopPropagation();
    const owner = contextOwnerRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      boundaryRef.current.isCurrent() &&
      owner.boundaryKey === contextOwnerRef.current.boundaryKey &&
      owner.tabId === contextOwnerRef.current.tabId &&
      owner.modelId === contextOwnerRef.current.modelId;
    const job = jobs.find((entry) =>
      entry.imageUrls.some((_, index) => mossImagePreviewSource(entry, index) === image.src),
    );
    const index =
      job?.imageUrls.findIndex((_, at) => mossImagePreviewSource(job, at) === image.src) ?? -1;
    if (!job || index < 0 || !isCurrent()) return;
    const sourceUrl = job.imageUrls[index];
    void showGeneratedImageContextMenu({
      image,
      position: { x: event.clientX, y: event.clientY },
      isCurrent,
      resolveImageUrl: ({ src }) => src,
      allowBrowserClipboard: true,
      fetchCredentials: job.assets?.some((asset) => asset.kind === "image" && asset.index === index)
        ? "include"
        : "omit",
      labels: {
        addToChat: "用作参考图",
        copyImage: "复制图片",
        showInFileManager: "在文件夹中显示",
        downloadCopy: "下载图片",
        addToChatError: "无法添加参考图",
        copyError: "无法复制图片",
        showInFileManagerError: "无法打开文件夹",
        downloadError: "无法下载图片",
      },
      onAddToChat: async (file) => {
        await addReferences([file], { promptMode: true });
      },
      onFocusComposer: () => document.getElementById("moss-images-prompt-input")?.focus(),
      additionalActions: [
        ...(onEditInCanvas
          ? [
              {
                id: "edit-in-canvas",
                label: "编辑图像",
                errorLabel: "无法打开画布",
                onSelect: () => {
                  if (isCurrent())
                    openImageInCanvas({ jobId: job.jobId, imageIndex: index, action: "edit" });
                },
              },
            ]
          : []),
        {
          id: "open-in-images-tab",
          label: "在新图像标签打开",
          errorLabel: "无法打开图像",
          onSelect: () => {
            const tabId = crypto.randomUUID();
            setTabs((previous) => [
              ...previous.map((tab) => ({ ...tab, active: false })),
              {
                ...createImagesTab(tabId, imageTitle(job.prompt)),
                mode: "result",
                kind: "image",
                jobIds: [job.jobId],
                activeImageId: `${job.jobId}:${index}`,
              },
            ]);
            void restoreConversation(job, false, tabId, index);
          },
        },
        ...(isMossImageOutputUrl(sourceUrl)
          ? [
              {
                id: "copy-image-address",
                label: "复制原图地址",
                errorLabel: "无法复制地址",
                onSelect: () => navigator.clipboard.writeText(sourceUrl),
              },
            ]
          : []),
      ],
    });
  };

  const preview = useMemo(
    () => ({
      imagePreview: {
        images: images.map((image) =>
          image.id === currentMarkup?.sourceImageId ? { ...image, path: currentMarkup.url } : image,
        ),
        activeImageId: activeImage?.id ?? null,
        cwd: null,
        conversationTitle: activeTab.title,
        view: activeTab.view,
        groupId: activeTab.id,
        createdAt: newestJob?.createdAt ?? null,
      },
    }),
    [
      images,
      currentMarkup,
      activeImage?.id,
      activeTab.title,
      activeTab.view,
      activeTab.id,
      newestJob?.createdAt,
    ],
  );

  const composer = (
    <MossImagesComposer
      key={`${accountBoundary.key}:${activeTab.id}`}
      project={voiceProject}
      prompt={prompt}
      isEditing={isEditing}
      busy={activeTab.busy}
      canSend={
        canSubmit &&
        Boolean(prompt.trim() || currentMarkup?.comments) &&
        !(
          activeTab.style?.requiresReference &&
          (!supportsReferences || (!isEditing && activeTab.references.length === 0))
        ) &&
        !((isEditing || activeTab.references.length > 0) && !supportsReferences)
      }
      canAttach={canAttach}
      requireProviderAdmission={usesConversationEntry}
      onAttach={() => fileInputRef.current?.click()}
      onPasteFiles={(files) => {
        void addReferences(files);
      }}
      onStop={() => requestsRef.current.get(activeTab.id)?.abort()}
      onSend={(selection) => {
        void runGenerate(undefined, undefined, selection);
      }}
      onSelectionChange={reportConversationSelection}
      onPromptChange={(value) => {
        if (!accountBoundary.isCurrent()) return;
        updateTab(activeTab.id, (tab) =>
          tab.mode === "result"
            ? { ...tab, followUp: value }
            : { ...tab, prompt: value, title: imageTitle(value) },
        );
      }}
      beforeEditor={
        <>
          {" "}
          {currentMarkup && isEditing && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-border p-2 text-ui-sm">
              <img
                src={currentMarkup.url}
                alt="标注预览"
                className="size-12 rounded-lg object-contain"
              />
              <span className="flex-1">
                已附加标注{currentMarkup.comments ? "与评论" : ""}，发送后生成编辑结果
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={activeTab.busy}
                onClick={() => updateTab(activeTab.id, (tab) => ({ ...tab, markup: null }))}
              >
                取消标注
              </Button>
            </div>
          )}
        </>
      }
      attachments={
        <>
          {" "}
          {(activeTab.references.length > 0 || isEditing) && (
            <div className="mb-2 flex flex-wrap gap-2">
              {isEditing && activeImage && (
                <span className="flex items-center gap-2 rounded-lg border border-border px-2 py-1 text-ui-sm">
                  <img
                    src={activeImage.path}
                    alt="编辑原图"
                    referrerPolicy="no-referrer"
                    className="size-8 rounded object-cover"
                  />
                  当前图像
                </span>
              )}
              {activeTab.references.map((reference) => (
                <span
                  key={reference.id}
                  className="flex items-center gap-1 rounded-lg border border-border p-1"
                >
                  <img
                    src={reference.url}
                    alt={reference.name}
                    className="size-10 rounded object-cover"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除 ${reference.name}`}
                    disabled={activeTab.busy}
                    onClick={() =>
                      updateTab(activeTab.id, (tab) => ({
                        ...tab,
                        references: tab.references.filter((image) => image.id !== reference.id),
                      }))
                    }
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </span>
              ))}
            </div>
          )}
        </>
      }
      notice={
        <>
          {" "}
          {model && !model.available && (
            <p className="mt-2 px-2 text-ui-sm text-muted-foreground">
              {model.unavailableReason || "生图服务当前不可用，请稍后再试。"}
            </p>
          )}
          {isEditing && !supportsReferences && (
            <p className="mt-2 px-2 text-ui-sm text-muted-foreground">
              请选择支持参考图的模型来编辑当前图像。
            </p>
          )}
          {activeTab.style?.requiresReference &&
            (!supportsReferences || (!isEditing && activeTab.references.length === 0)) && (
              <p className="mt-2 px-2 text-ui-sm text-muted-foreground">
                此样式需要参考图，请添加图片并选择支持参考图的模型。
              </p>
            )}
        </>
      }
    />
  );

  return (
    <section
      aria-label="Moss Images"
      data-moss-images-workspace
      data-moss-images-mode={activeTab.mode}
      data-moss-images-tab-count={tabs.length}
      data-canvas-surface="images"
      data-moss-theme={resolvedTheme}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface text-default"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDraggingImages(true);
        }
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDraggingImages(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDraggingImages(false);
        void addReferences(event.dataTransfer.files);
      }}
    >
      {draggingImages && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-panel border-2 border-dashed border-primary bg-surface/90 text-ui-lg"
        >
          放开以添加参考图
        </div>
      )}
      {activeTab.mode === "result" && (
        <MossCodexShellTopTabChrome
          tabs={visibleTabs}
          onSelectTab={(id) =>
            setTabs((previous) => previous.map((tab) => ({ ...tab, active: tab.id === id })))
          }
          onCloseTab={closeTab}
          onNewTab={() =>
            setTabs((previous) => [
              ...previous.map((tab) => ({ ...tab, active: false })),
              createImagesTab(`images-${crypto.randomUUID()}`, "新图像"),
            ])
          }
          onToggleSidebar={() => window.dispatchEvent(new Event("moss-sidebar-toggle"))}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="参考图文件"
        onChange={(event) => {
          void addReferences(event.target.files);
          event.target.value = "";
        }}
      />
      <div className={activeTab.mode === "result" ? "flex items-center gap-2 px-6 py-2" : "hidden"}>
        <Button
          variant="ghost"
          size="sm"
          disabled={activeTab.busy}
          onClick={() =>
            updateTab(activeTab.id, (tab) => ({
              ...tab,
              mode: "prompt",
              jobIds: [],
              conversationId: null,
              conversationCursor: undefined,
              conversationError: null,
              historyAnchorJobId: null,
              activeImageId: null,
              markup: null,
            }))
          }
        >
          图像
        </Button>
        <span className="flex-1" />
        {hasAccount && (
          <Button
            variant="ghost"
            size="sm"
            render={<Link to="/settings" search={{ section: "usage" }} onClick={onClose} />}
          >
            套餐用量
          </Button>
        )}
        {activeImage && activeTab.mode === "result" && (
          <Button
            variant="ghost"
            size="sm"
            render={<a href={activeImage.path} target="_blank" rel="noreferrer" />}
          >
            打开原图
          </Button>
        )}
        <Button variant="ghost" size="sm" render={<Link to="/skills" onClick={onClose} />}>
          安装模型 Skill
        </Button>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
          {loading ? "正在刷新…" : "刷新"}
        </Button>
      </div>
      {visibleCatalog?.mediaWallet?.reviewRequired && (
        <p role="status" className="px-5 py-2 text-ui-sm text-destructive">
          历史付款记录待核实，暂不能生成。
        </p>
      )}
      {accountReady && catalogError && (
        <p role="alert" className="px-6 pb-3 text-ui-sm text-destructive">
          {catalogError}
        </p>
      )}
      {!loading && !catalogError && !hasAccount && (
        <div className="flex items-center gap-3 px-6 pb-3 text-ui-sm text-muted-foreground">
          登录 Moss 账号后使用套餐额度生成图像。
          <Button variant="ghost" size="sm" render={<Link to="/account" onClick={onClose} />}>
            登录账号
          </Button>
        </div>
      )}
      {accountReady && activeTab.error && (
        <p role="alert" className="px-6 pb-3 text-ui-sm text-destructive">
          {activeTab.error}
        </p>
      )}
      {!accountReady || activeTab.mode === "prompt" ? (
        <div data-moss-images-prompt className="relative flex min-h-0 flex-1 flex-col">
          <div data-moss-images-gallery className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-8">
            <div className="mx-auto w-full max-w-[1344px]">
              <h1 className={`mb-5 ${PAGE_TITLE_CLASS_NAME}`}>图像</h1>
              {composer}
              <div className="mx-auto mt-8 max-w-[768px]" data-moss-images-photos>
                <div className="mb-4 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon-lg"
                    className="rounded-full"
                    aria-label="选择参考照片"
                    disabled={!canAttach}
                    onClick={() => setReferencePickerKey(discoveryKey)}
                  >
                    <ChevronLeftIcon className="size-4" />
                  </Button>
                  <h2 className="text-ui-sm font-medium">添加照片</h2>
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="上一组照片"
                    className="rounded-full border-border/60"
                    onClick={() =>
                      photoRowRef.current?.scrollBy({ left: -300, behavior: "smooth" })
                    }
                  >
                    <ChevronLeftIcon className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="下一组照片"
                    className="rounded-full border-border/60"
                    onClick={() => photoRowRef.current?.scrollBy({ left: 300, behavior: "smooth" })}
                  >
                    <ChevronRightIcon className="size-4" />
                  </Button>
                </div>
                <div ref={photoRowRef} className="flex gap-3 overflow-x-auto pb-1">
                  <button
                    type="button"
                    aria-label="上传照片"
                    className="relative flex h-44 w-36 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground transition-colors hover:bg-muted/80"
                    disabled={!canAttach}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <PlusIcon className="size-5" />
                    <span className="absolute bottom-3 text-ui-xs">上传照片</span>
                  </button>
                  {activeTab.references.map((reference) => (
                    <img
                      key={reference.id}
                      src={reference.url}
                      alt={`已选照片：${reference.name}`}
                      className="h-44 w-36 shrink-0 rounded-2xl object-cover"
                    />
                  ))}
                  {jobs
                    .filter((job) => job.imageUrls.length > 0)
                    .slice(0, 8)
                    .map((job) => (
                      <button
                        type="button"
                        key={job.jobId}
                        aria-label={`使用“${job.prompt}”作参考图`}
                        className="h-44 w-36 shrink-0 overflow-hidden rounded-2xl"
                        disabled={!canAttach}
                        onClick={() => addGeneratedReference(job, 0)}
                      >
                        <img
                          src={mossImagePreviewSource(job, 0)}
                          alt={job.prompt}
                          referrerPolicy="no-referrer"
                          className="size-full object-cover"
                        />
                      </button>
                    ))}
                </div>
              </div>
              {!usesConversationEntry &&
                hasAccount &&
                !loading &&
                !catalogError &&
                models.length === 0 && (
                  <p className="mt-4 text-center text-ui-sm text-muted-foreground">
                    尚未安装图像模型。前往插件市场安装官方图像 Skill。
                  </p>
                )}
              <div className="mt-8 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-ui-lg font-semibold">我的图像</h2>
                  <p className="mt-1 text-ui-xs text-muted-foreground">
                    可在资料库中找到你的所有图像及更多内容
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={openMossLibraryDestination}
                >
                  <BookIcon className="size-4" />
                  打开资料库
                </Button>
              </div>
              {jobs.length === 0 ? (
                <p className="mt-5 text-ui-sm text-muted-foreground">
                  {loading ? "正在读取生成记录…" : "你在这里创建的图像会显示在这里。"}
                </p>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  {jobs
                    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
                    .map((job) => (
                      <div
                        key={job.jobId}
                        className="group relative overflow-hidden rounded-xl bg-muted"
                      >
                        <button
                          key={job.jobId}
                          type="button"
                          aria-label={`打开图像：${job.prompt}`}
                          className="group block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onContextMenu={(event) =>
                            job.imageUrls[0] &&
                            showImageMenu(
                              {
                                src: mossImagePreviewSource(job, 0),
                                name: `moss-${job.jobId}-1.png`,
                              },
                              event,
                            )
                          }
                          disabled={activeTab.busy}
                          onClick={() => void restoreConversation(job)}
                        >
                          <div className="flex aspect-square items-center justify-center overflow-hidden">
                            {job.imageUrls[0] ? (
                              <img
                                src={mossImagePreviewSource(job, 0)}
                                alt={job.prompt}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <span className="px-4 text-center text-ui-sm text-muted-foreground">
                                {jobStatusLabel(job)}
                              </span>
                            )}
                          </div>
                          <span className="sr-only">{jobStatusLabel(job)}</span>
                        </button>
                        {job.imageUrls[0] && onEditInCanvas && (
                          <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                            <Button
                              variant="secondary"
                              size="sm"
                              aria-label={`编辑图像：${job.prompt}`}
                              disabled={!hasAccount || activeTab.busy}
                              onClick={() =>
                                openImageInCanvas({
                                  jobId: job.jobId,
                                  imageIndex: 0,
                                  action: "edit",
                                })
                              }
                            >
                              编辑
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              )}
              {(historyCursor || historyError || historyLoading) && (
                <div className="mt-4 flex flex-col items-center gap-2">
                  {historyError && (
                    <p role="alert" className="text-ui-sm text-destructive">
                      {historyError}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={historyLoading || !visibleCatalog?.account}
                    onClick={() =>
                      visibleCatalog?.account &&
                      void readHistoryPage(visibleCatalog.account, historyCursor ?? undefined)
                    }
                  >
                    {historyLoading
                      ? "正在读取记录…"
                      : historyError
                        ? "重试读取记录"
                        : "加载更多图像"}
                  </Button>
                </div>
              )}
              <div className="mt-8" data-moss-images-discovery>
                <MossImagesDiscovery
                  resetKey={discoveryKey}
                  disabled={!accountReady || activeTab.busy || readingReferences}
                  selectedStyle={activeTab.style}
                  onSelectStyle={(style) => updateTab(activeTab.id, (tab) => ({ ...tab, style }))}
                  referenceCount={activeTab.references.length}
                  supportsReferences={supportsReferences}
                  onRequestReference={(source) => {
                    if (source === "upload") fileInputRef.current?.click();
                    else setReferencePickerKey(discoveryKey);
                  }}
                  onUseTemplate={(template) =>
                    updateTab(activeTab.id, (tab) => ({ ...tab, prompt: template.prompt }))
                  }
                  onGenerateTemplate={(template, ratio) => {
                    const selection =
                      conversationSelection?.ownerKey === discoveryKey
                        ? conversationSelection.selection
                        : undefined;
                    void runGenerate(
                      undefined,
                      { prompt: template.prompt, aspectRatio: ratio },
                      selection,
                    );
                  }}
                  canGenerate={
                    usesConversationEntry
                      ? canSubmit &&
                        conversationSelection?.ownerKey === discoveryKey &&
                        !conversationSelection.unavailableReason
                      : canGenerate
                  }
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div data-moss-images-result className="flex min-h-0 flex-1 flex-col">
          {activeTab.conversationId &&
            (activeTab.conversationCursor ||
              activeTab.conversationError ||
              (activeTab.busy && activeTab.conversationCursor === undefined)) && (
              <div className="flex shrink-0 flex-col items-center gap-1 px-4 pb-2">
                {activeTab.conversationError && (
                  <p role="alert" className="text-ui-sm text-destructive">
                    {activeTab.conversationError}
                  </p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={activeTab.busy || !newestJob}
                  onClick={() => newestJob && void restoreConversation(newestJob, true)}
                >
                  {activeTab.busy
                    ? "正在恢复会话…"
                    : activeTab.conversationError
                      ? "重试读取会话"
                      : "加载更早的图像"}
                </Button>
              </div>
            )}
          {activeImage && (
            <div className="flex shrink-0 justify-center px-4 pb-2" aria-label="图像编辑工具">
              {onEditInCanvas && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mr-1 rounded-full"
                  disabled={activeTab.busy}
                  onClick={() =>
                    openImageInCanvas({
                      jobId: activeImage.jobId,
                      imageIndex: Number(activeImage.id.split(":").at(-1)),
                      action: "edit",
                    })
                  }
                >
                  编辑图像
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="mr-1 rounded-full"
                disabled={
                  (!onEditInCanvas && (!hasAccount || !supportsReferences)) ||
                  activeTab.busy ||
                  Boolean(visibleMarkupEditor)
                }
                onClick={() =>
                  onEditInCanvas
                    ? openImageInCanvas({
                        jobId: activeImage.jobId,
                        imageIndex: Number(activeImage.id.split(":").at(-1)),
                        action: "annotate",
                      })
                    : void openMarkup()
                }
              >
                {visibleMarkupEditor && !visibleMarkupEditor.file
                  ? "正在读取…"
                  : currentMarkup
                    ? "修改标注"
                    : "标注"}
              </Button>
              <span
                title={
                  onEditInCanvas || model?.supportsMaskEdits === true
                    ? undefined
                    : "此模型未提供选区擦除能力"
                }
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="mr-1 rounded-full"
                  disabled={
                    (!onEditInCanvas &&
                      (!canGenerate || !supportsReferences || model?.supportsMaskEdits !== true)) ||
                    activeTab.busy ||
                    Boolean(visibleMarkupEditor)
                  }
                  onClick={() =>
                    onEditInCanvas
                      ? openImageInCanvas({
                          jobId: activeImage.jobId,
                          imageIndex: Number(activeImage.id.split(":").at(-1)),
                          action: "erase",
                        })
                      : void openMarkup("erase")
                  }
                >
                  擦除
                </Button>
              </span>
              <span
                title={
                  onEditInCanvas || model?.supportsTransparentBackground === true
                    ? undefined
                    : "此模型未提供透明背景能力"
                }
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="mr-1 rounded-full"
                  disabled={
                    (!onEditInCanvas &&
                      (!canGenerate ||
                        !supportsReferences ||
                        model?.supportsTransparentBackground !== true)) ||
                    activeTab.busy ||
                    Boolean(visibleMarkupEditor)
                  }
                  onClick={() =>
                    onEditInCanvas
                      ? openImageInCanvas({
                          jobId: activeImage.jobId,
                          imageIndex: Number(activeImage.id.split(":").at(-1)),
                          action: "remove-background",
                        })
                      : void runGenerate({ kind: "remove-background" })
                  }
                >
                  移除背景
                </Button>
              </span>
              {onEditInCanvas ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={activeTab.busy}
                  onClick={() =>
                    openImageInCanvas({
                      jobId: activeImage.jobId,
                      imageIndex: Number(activeImage.id.split(":").at(-1)),
                      action: "resize",
                    })
                  }
                >
                  调整大小
                </Button>
              ) : (
                <Menu key={activeImage.id}>
                  <MenuTrigger
                    disabled={!canGenerate || !supportsReferences || activeTab.busy}
                    render={<Button variant="outline" size="sm" className="rounded-full" />}
                  >
                    调整比例
                  </MenuTrigger>
                  <MenuPopupBase>
                    {[
                      ["正方形", "1:1"],
                      ["竖版", "3:4"],
                      ["故事", "9:16"],
                      ["横版", "4:3"],
                      ["宽屏", "16:9"],
                    ].map(([label, ratio]) => (
                      <MenuItem
                        key={ratio}
                        onClick={() => void runGenerate({ kind: "resize", aspectRatio: ratio! })}
                      >
                        <span>{label}</span>
                        <span className="ml-auto pl-6 text-muted-foreground">{ratio}</span>
                      </MenuItem>
                    ))}
                  </MenuPopupBase>
                </Menu>
              )}
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {images.length > 0 ? (
              <GeneratedImagePreviewPane
                pane={preview}
                fullWidth
                animateViewChanges={!onEditInCanvas}
                onImageContextMenu={showImageMenu}
                resolveImageUrl={({ src }) => src}
                onActiveImageChange={(id) =>
                  updateTab(activeTab.id, (tab) => ({ ...tab, activeImageId: id }))
                }
                onViewChange={(view) => {
                  if (view === "playground" && onEditInCanvas && activeImage) {
                    openImageInCanvas({
                      jobId: activeImage.jobId,
                      imageIndex: Number(activeImage.id.split(":").at(-1)),
                      action: "canvas",
                    });
                    return;
                  }
                  updateTab(activeTab.id, (tab) => ({ ...tab, view }));
                }}
              />
            ) : (
              <div
                className="flex h-full items-center justify-center p-8 text-center text-ui text-muted-foreground"
                role="status"
              >
                {newestJob ? jobStatusLabel(newestJob) : "提交描述以创建图像"}
              </div>
            )}
          </div>
          {newestJob && (
            <div
              className="flex shrink-0 items-center justify-center gap-3 px-4 py-2 text-ui-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <span>{jobStatusLabel(newestJob)}</span>
              {!activeTab.busy &&
                (newestJob.status === "queued" ||
                  newestJob.status === "running" ||
                  newestJob.status === "reconciliation_required" ||
                  (newestJob.status === "succeeded" &&
                    (newestJob.billingStatus === "unknown" ||
                      newestJob.billingStatus === "pending"))) && (
                  <Button variant="ghost" size="sm" onClick={() => void resumeJob(newestJob)}>
                    {newestJob.status === "reconciliation_required" ||
                    newestJob.status === "succeeded"
                      ? "检查任务与费用"
                      : "继续等待"}
                  </Button>
                )}
              <MossImageBilling job={newestJob} />
              {newestJob.persistenceStatus === "ready" && newestJob.assets?.length ? (
                <span>已保存到此设备</span>
              ) : null}
              {newestJob.status === "succeeded" && newestJob.persistenceStatus === "failed" && (
                <span>原图保存失败，请及时下载</span>
              )}
            </div>
          )}
          <div className="shrink-0 px-4 pb-4">{composer}</div>
        </div>
      )}
      {visibleMarkupEditor?.file &&
        (visibleMarkupEditor.mode === "erase" ? (
          <MossImageEraseEditor
            key={visibleMarkupEditor.id}
            file={visibleMarkupEditor.file}
            onCancel={() => setMarkupEditor(null)}
            onApply={applyErase}
          />
        ) : (
          <MossImageMarkupEditor
            key={visibleMarkupEditor.id}
            file={visibleMarkupEditor.file}
            {...(currentMarkup ? { initialDocument: currentMarkup.document } : {})}
            onCancel={() => setMarkupEditor(null)}
            onApply={applyMarkup}
          />
        ))}
      {visibleSketch && (
        <MossImageMarkupEditor
          key={sketchEditor!.id}
          blankCanvas={{ width: 1024, height: 1024 }}
          onCancel={() => setSketchEditor(null)}
          onApply={async ({ file }) => {
            const owner = sketchEditor!.id;
            const isCurrent = () => sketchOwnerRef.current === owner;
            if (!isCurrent()) return;
            const added = await addReferences([file], { isCurrent });
            if (!isCurrent()) return;
            if (!added) throw new Error("草图未能添加，请检查参考图数量与大小后重试。");
            setSketchEditor((current) => (current?.id === owner ? null : current));
          }}
        />
      )}
      <Dialog
        open={visibleReferencePicker}
        onOpenChange={(open) => {
          if (!open) setReferencePickerKey(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>选择最近的图像</DialogTitle>
          <DialogDescription>选择一张图像添加到参考图。</DialogDescription>
          <div className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto py-3">
            {jobs
              .filter((job) => job.imageUrls.length > 0)
              .map((job) => (
                <Button
                  key={job.jobId}
                  variant="ghost"
                  className="h-auto min-w-0 flex-col"
                  disabled={readingReferences}
                  onClick={() => {
                    addGeneratedReference(job, 0);
                    setReferencePickerKey(null);
                  }}
                >
                  <img
                    src={mossImagePreviewSource(job, 0)}
                    alt=""
                    className="aspect-square w-full rounded-md object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                  <span className="w-full truncate text-ui-sm">{job.prompt}</span>
                </Button>
              ))}
            {!jobs.some((job) => job.imageUrls.length) && (
              <p className="col-span-3 text-ui-sm text-muted-foreground">
                还没有可选的图像，请先上传参考图。
              </p>
            )}
          </div>
          <Button variant="outline" onClick={() => setReferencePickerKey(null)}>
            取消
          </Button>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
