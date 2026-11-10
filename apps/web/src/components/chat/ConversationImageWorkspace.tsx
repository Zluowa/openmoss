import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ThreadId } from "@moss/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeComposerImages } from "~/composerDraftAttachments";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  effectiveComposerAttachmentCount,
  prepareComposerImageAttachmentsFromFiles,
} from "~/lib/composerSend";
import {
  registerConversationImageComposer,
  registerConversationImageLeaveGuard,
} from "~/lib/conversationImageComposer";
import { readGeneratedImageContextFile } from "~/lib/generatedImageContextMenu";
import { createPastedTextDraft } from "~/lib/composerPastedText";
import {
  mossCanvasAssetUrl,
  readMossCanvasSelectionFile,
  reportMossCanvasLiveSelection,
  syncMossCanvasSelectionChip,
  type MossCanvasBinding,
} from "~/lib/mossCanvasClient";
import type { MossCanvasImageFocus } from "~/lib/mossCanvasBridge";
import type {
  MossCanvasImageOpen,
  MossCanvasSelection,
  MossCanvasSelectionItem,
} from "~/lib/mossCanvasSelection";
import { requestComposerImagePreview } from "~/lib/composerImagePreviewRequest";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { useMossCanvasRuntimeLifecycle } from "~/lib/mossCanvasLifecycle";
import {
  isMossImagesAccountIdentityChange,
  useMossImagesAccountBoundary,
} from "~/lib/mossImagesAccountBoundary";
import type { RightDockImagePreviewView, RightDockPane } from "~/rightDockStore.logic";
import { MossCanvasWebSurface, type MossCanvasComposeContextReader } from "../MossCanvasWebSurface";
import { Button } from "../ui/button";
import { GeneratedImagePreviewPane } from "./GeneratedImagePreviewPane";

type CanvasAction = NonNullable<MossCanvasImageFocus["action"]>;
const ACTIONS: readonly [CanvasAction, string][] = [
  ["annotate", "标注"],
  ["comment", "添加评论"],
  ["remove-background", "移除背景"],
  ["erase", "擦除"],
  ["resize", "调整大小"],
];

/** Keeps the normal conversation and composer alive while hosting our original Canvas. */
export function ConversationImageWorkspace(props: {
  readonly threadId: ThreadId;
  readonly pane: Pick<RightDockPane, "imagePreview" | "id">;
  readonly canvasOnly?: boolean;
  readonly imageFocus?: MossCanvasImageFocus;
  readonly onLeaveGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
  readonly fullWidth: boolean;
  readonly visible: boolean;
  readonly onViewChange: (view: RightDockImagePreviewView) => void;
  readonly onActiveImageChange: (id: string) => void;
  readonly onRequestFullWidth: (value: boolean) => void;
  readonly onClose: () => void;
}) {
  const preview = props.pane.imagePreview;
  const boundary = useMossImagesAccountBoundary();
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState<CanvasAction>("canvas");
  const [selectedCanvasImage, setSelectedCanvasImage] = useState<{
    item: MossCanvasSelectionItem;
    binding: MossCanvasBinding;
  } | null>(null);
  const [importState, setImportState] = useState<"loading" | "ready" | "failed">("loading");
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const composeContextRef = useRef<MossCanvasComposeContextReader | null>(null);
  const sendingRef = useRef(false);
  const ownedContextId = useRef<string | null>(null);
  const selectionWork = useRef<Promise<void>>(Promise.resolve());
  const selectionVersion = useRef(0);
  const selectionError = useRef(false);
  const ownedAttachments = useRef<string[]>([]);
  const latestSelection = useRef<MossCanvasSelection | null>(null);
  const selectedAsset = useMemo(
    () =>
      selectedCanvasImage
        ? {
            id: `canvas:${selectedCanvasImage.item.assetId}`,
            path: selectedCanvasImage.item.assetId,
            name: selectedCanvasImage.item.title,
            assetId: selectedCanvasImage.item.assetId,
          }
        : null,
    [selectedCanvasImage],
  );
  const [canvasLaunchAsset, setCanvasLaunchAsset] = useState<typeof selectedAsset>(null);
  const displayedPreview = useMemo(
    () =>
      preview && selectedAsset
        ? {
            ...preview,
            images: [
              ...preview.images.filter((image) => image.id !== selectedAsset.id),
              selectedAsset,
            ],
            activeImageId: selectedAsset.id,
          }
        : preview,
    [preview, selectedAsset],
  );
  const active =
    displayedPreview?.images.find((image) => image.id === displayedPreview.activeImageId) ??
    displayedPreview?.images[0];
  const canvas = props.canvasOnly || preview?.view === "playground";
  const visibleRef = useRef(props.visible);
  visibleRef.current = props.visible;
  const previousBoundary = useRef(boundary.key);
  const previousIdentity = useRef(boundary.identityKey);
  useEffect(() => {
    if (previousBoundary.current === boundary.key) return;
    previousBoundary.current = boundary.key;
    // The account records answering for the first time is not an account
    // change: saying 账号已变化 then sent people to reopen a Canvas that was fine.
    const changed = isMossImagesAccountIdentityChange(
      previousIdentity.current,
      boundary.identityKey,
    );
    previousIdentity.current = boundary.identityKey;
    if (!changed) return;
    selectionVersion.current += 1;
    selectionError.current = true;
    const store = useComposerDraftStore.getState();
    for (const id of ownedAttachments.current) store.removeImage(props.threadId, id);
    if (ownedContextId.current) store.removePastedText(props.threadId, ownedContextId.current);
    store.removePastedText(props.threadId, `canvas-selection:${props.pane.id}`);
    ownedContextId.current = null;
    ownedAttachments.current = [];
    setSelectedCanvasImage(null);
    setCanvasLaunchAsset(null);
    setError("账号已变化，请重新打开画布。");
  }, [boundary.key, boundary.identityKey, props.threadId, props.pane.id]);

  const prepareSelection = useCallback(
    (load: () => Promise<readonly File[]>) => {
      const version = ++selectionVersion.current;
      selectionError.current = false;
      setError("");
      if (ownedContextId.current) {
        useComposerDraftStore.getState().removePastedText(props.threadId, ownedContextId.current);
        ownedContextId.current = null;
      }
      const current = () =>
        version === selectionVersion.current && visibleRef.current && boundary.isCurrent();
      const work = (async () => {
        const files = await load();
        if (!current()) return;
        const result = await prepareComposerImageAttachmentsFromFiles({
          files,
          // An existing user reference may already satisfy this selection. Prepare
          // at most one bounded batch, then count only genuinely new references.
          existingAttachmentCount: 0,
        });
        if (!current() || result.error) {
          result.images.forEach((image) => {
            if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
          });
          if (current()) throw new Error(result.error || "图片引用尚未就绪。");
          return;
        }
        const store = useComposerDraftStore.getState();
        const latestDraft = store.draftsByThreadId[props.threadId];
        const previousOwned = new Set(ownedAttachments.current);
        const retainedImages =
          latestDraft?.images.filter((image) => !previousOwned.has(image.id)) ?? [];
        // Reuse the store's deduplication and discarded-preview cleanup. A reused
        // user image remains user-owned; only the appended images need insertion.
        const mergedImages = mergeComposerImages(retainedImages, result.images);
        const newImages = mergedImages?.slice(retainedImages.length) ?? [];
        if (
          effectiveComposerAttachmentCount({
            ...latestDraft,
            images: mergedImages ?? retainedImages,
            persistedAttachments: latestDraft?.persistedAttachments.filter(
              (image) => !previousOwned.has(image.id),
            ),
          }) > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
        ) {
          newImages.forEach((image) => {
            if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
          });
          throw new Error("图片数量超过当前会话可接收的上限。");
        }
        for (const id of ownedAttachments.current) store.removeImage(props.threadId, id);
        const accepted = store.addImages(props.threadId, newImages);
        const committedIds = new Set(
          useComposerDraftStore
            .getState()
            .draftsByThreadId[props.threadId]?.images.map((image) => image.id),
        );
        ownedAttachments.current = newImages
          .filter((image) => committedIds.has(image.id))
          .map((image) => image.id);
        if (accepted !== newImages.length) throw new Error("图片数量超过当前会话可接收的上限。");
      })().catch((cause) => {
        if (!current()) return;
        selectionError.current = true;
        setError(cause instanceof Error ? cause.message : "图片引用尚未就绪。");
      });
      selectionWork.current = work;
    },
    [boundary.isCurrent, props.threadId],
  );

  useEffect(() => {
    if (!props.visible || canvas || !active) return;
    prepareSelection(async () => [
      selectedCanvasImage
        ? await readMossCanvasSelectionFile(selectedCanvasImage.item, selectedCanvasImage.binding)
        : await readGeneratedImageContextFile({
            image: { src: active.path, cwd: preview?.cwd, name: active.name },
          }),
    ]);
  }, [props.visible, canvas, active, preview?.cwd, prepareSelection, selectedCanvasImage]);
  useEffect(
    () => () => {
      selectionVersion.current += 1;
    },
    [props.threadId, boundary.key],
  );
  useEffect(() => {
    if (!props.visible) selectionVersion.current += 1;
  }, [props.visible]);

  const selectionChipId = `canvas-selection:${props.pane.id}`;
  const onSelection = useCallback(
    (selection: MossCanvasSelection, binding: MossCanvasBinding) => {
      if (!visibleRef.current) return;
      // The agent can read the live selection (moss_canvas_read), like the
      // browser panel's selected element.
      reportMossCanvasLiveSelection(props.threadId, selection);
      latestSelection.current = selection;
      // Selected text and shapes become a composer chip right away.
      syncMossCanvasSelectionChip(props.threadId, selectionChipId, selection.content);
      if (selection.items[0]) setSelectedCanvasImage({ item: selection.items[0], binding });
      prepareSelection(() =>
        Promise.all(selection.items.map((item) => readMossCanvasSelectionFile(item, binding))),
      );
    },
    [prepareSelection, props.threadId, selectionChipId],
  );
  // Opening an image on the board works like ChatGPT's image view: it is
  // attached to the message (as the selection already does) and shown large,
  // ready to mark up with Moss's shared markup editor.
  const onImageOpen = useCallback(
    (open: MossCanvasImageOpen, binding: MossCanvasBinding) => {
      if (!visibleRef.current) return;
      const selected =
        latestSelection.current?.items.findIndex((item) => item.shapeId === open.item.shapeId) ??
        -1;
      if (selected < 0)
        prepareSelection(async () => [await readMossCanvasSelectionFile(open.item, binding)]);
      void (async () => {
        let work: Promise<void>;
        do {
          work = selectionWork.current;
          await work.catch(() => undefined);
        } while (work !== selectionWork.current);
        if (!visibleRef.current || selectionError.current) return;
        const owned = ownedAttachments.current;
        const imageId = owned[Math.max(0, selected)] ?? owned[0];
        if (imageId) requestComposerImagePreview({ imageId, markup: true });
      })();
    },
    [prepareSelection],
  );
  const beforeLeave = useCallback(async () => (await flushRef.current?.()) ?? true, []);
  useEffect(
    () => registerConversationImageLeaveGuard(props.threadId, props.pane.id, beforeLeave),
    [props.threadId, props.pane.id, beforeLeave],
  );
  const beforeSend = useCallback(async () => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    try {
      // Always await the latest selection, including a change made during image preparation.
      let work: Promise<void>;
      do {
        work = selectionWork.current;
        await work;
      } while (work !== selectionWork.current);
      if (
        !visibleRef.current ||
        !boundary.isCurrent() ||
        selectionError.current ||
        (canvas && importState !== "ready")
      )
        return false;
      const version = selectionVersion.current;
      if (canvas) {
        const result = await composeContextRef.current?.();
        if (!result) {
          setError("画布上下文尚未保存，请保留草稿并稍后再发送。");
          return false;
        }
        if (!visibleRef.current || !boundary.isCurrent() || version !== selectionVersion.current)
          return false;
        if (result.context.items.some((item) => item.context?.truncated)) {
          setError("标注或评论较多，请缩小图片选择后再发送。");
          return false;
        }
        // Reuse normal image and pasted-context attachments. JSON encodes all
        // comment text as data and carries no runtime URL, credential or path.
        const contextItems = result.context.items.filter(
          (item) =>
            item.context &&
            (item.context.annotations.length > 0 || item.context.comments.length > 0),
        );
        prepareSelection(async () =>
          (
            await Promise.all(
              result.context.items.map(async (item) => {
                const original = await readMossCanvasSelectionFile(item, result.binding);
                if (!item.context?.annotationAssetId) return [original];
                const annotated = await readMossCanvasSelectionFile(
                  {
                    ...item,
                    assetId: item.context.annotationAssetId,
                    title: `${item.title} — 标注`,
                  },
                  result.binding,
                );
                return [original, annotated];
              }),
            )
          ).flat(),
        );
        const contextVersion = selectionVersion.current;
        await selectionWork.current;
        if (
          !visibleRef.current ||
          !boundary.isCurrent() ||
          selectionError.current ||
          contextVersion !== selectionVersion.current
        )
          return false;
        if (contextItems.length) {
          const id = `canvas-context:${props.pane.id}`;
          const text =
            "画布标注与评论（对应所选图片，坐标为图片内 0–1 比例）\n" +
            JSON.stringify(
              contextItems.map((item) => ({
                title: item.title,
                assetId: item.assetId,
                annotations: item.context!.annotations,
                comments: item.context!.comments,
                ...(item.context!.annotationAssetId
                  ? { annotationAssetId: item.context!.annotationAssetId }
                  : {}),
              })),
            );
          const store = useComposerDraftStore.getState();
          store.addPastedTexts(props.threadId, [
            createPastedTextDraft({ id, createdAt: new Date().toISOString(), text }),
          ]);
          ownedContextId.current = id;
          if (
            !useComposerDraftStore
              .getState()
              .draftsByThreadId[props.threadId]?.pastedTexts.some((entry) => entry.id === id)
          ) {
            setError("画布评论未能加入会话，请保留草稿并稍后再发送。");
            return false;
          }
        }
      } else {
        // A successful ordinary turn clears its attachments. The image panel
        // remains selected, so each follow-up needs that same current reference.
        if (active) {
          prepareSelection(async () => [
            selectedCanvasImage
              ? await readMossCanvasSelectionFile(
                  selectedCanvasImage.item,
                  selectedCanvasImage.binding,
                )
              : await readGeneratedImageContextFile({
                  image: { src: active.path, cwd: preview?.cwd, name: active.name },
                }),
          ]);
          const focusVersion = selectionVersion.current;
          await selectionWork.current;
          if (
            !visibleRef.current ||
            !boundary.isCurrent() ||
            selectionError.current ||
            focusVersion !== selectionVersion.current
          )
            return false;
        }
        const savedVersion = selectionVersion.current;
        const saved = await beforeLeave();
        if (
          !saved ||
          !visibleRef.current ||
          !boundary.isCurrent() ||
          savedVersion !== selectionVersion.current
        )
          return false;
      }
      return true;
    } catch {
      setError("画布上下文尚未就绪，请保留草稿并稍后再发送。");
      return false;
    } finally {
      sendingRef.current = false;
    }
  }, [
    boundary.isCurrent,
    canvas,
    importState,
    beforeLeave,
    prepareSelection,
    props.threadId,
    props.pane.id,
    active,
    selectedCanvasImage,
    preview?.cwd,
  ]);
  const setComposeContext = useCallback((reader: MossCanvasComposeContextReader | null) => {
    composeContextRef.current = reader;
  }, []);
  useEffect(() => {
    if (!props.visible) return;
    return registerConversationImageComposer(props.threadId, {
      target: props.fullWidth ? target : null,
      beforeSend,
      beforeLeave,
    });
  }, [props.threadId, props.visible, props.fullWidth, target, beforeSend, beforeLeave]);
  const setFlush = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      flushRef.current = guard;
      props.onLeaveGuardChange?.(guard);
    },
    [props.onLeaveGuardChange],
  );
  const localImages = useMemo(
    () =>
      preview?.images.length
        ? {
            images: canvasLaunchAsset
              ? [
                  ...preview.images.filter((image) => image.id !== canvasLaunchAsset.id),
                  canvasLaunchAsset,
                ]
              : preview.images,
            activeImageId: canvasLaunchAsset?.id ?? preview.activeImageId ?? preview.images[0]!.id,
            ...(preview.cwd ? { cwd: preview.cwd } : {}),
            action,
          }
        : undefined,
    [preview?.images, preview?.cwd, preview?.activeImageId, action, canvasLaunchAsset],
  );
  // A Canvas nobody is looking at is saved and unloaded after a short while,
  // and loads the same conversation's document again when shown.
  const canvasRuntime = useMossCanvasRuntimeLifecycle({
    visible: props.visible && canvas,
    save: () => flushRef.current?.() ?? Promise.resolve(true),
  });
  const switchView = (view: RightDockImagePreviewView) => {
    void beforeLeave().then((saved) => {
      if (!saved) return;
      if (view === "playground") {
        setCanvasLaunchAsset(selectedAsset);
        setAction("canvas");
        setImportState("loading");
      }
      props.onViewChange(view);
    });
  };
  const edit = (next: CanvasAction) => {
    setCanvasLaunchAsset(selectedAsset);
    setAction(next);
    setImportState("loading");
    props.onViewChange("playground");
    props.onRequestFullWidth(true);
  };
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col" data-conversation-image-workspace>
      <GeneratedImagePreviewPane
        pane={{ ...props.pane, ...(displayedPreview ? { imagePreview: displayedPreview } : {}) }}
        threadId={props.threadId}
        fullWidth={props.fullWidth}
        resolveImageUrl={(input) =>
          selectedCanvasImage && input.src === selectedCanvasImage.item.assetId
            ? mossCanvasAssetUrl(input.src, selectedCanvasImage.binding)
            : buildLocalImageUrl(input)
        }
        onViewChange={switchView}
        animateViewChanges={false}
        onActiveImageChange={(id) => {
          if (id === selectedAsset?.id) return;
          setSelectedCanvasImage(null);
          props.onActiveImageChange(id);
        }}
        onRequestFullWidth={props.onRequestFullWidth}
        canvasContent={
          canvas && canvasRuntime.loaded ? (
            <MossCanvasWebSurface
              embedded={!props.canvasOnly}
              threadId={props.threadId}
              {...(localImages ? { localImages } : {})}
              {...(props.imageFocus ? { image: props.imageFocus } : {})}
              onSelectionChange={onSelection}
              onImageOpen={onImageOpen}
              onImportStateChange={setImportState}
              onComposeContextChange={setComposeContext}
              onLeaveGuardChange={setFlush}
              onClose={props.onClose}
            />
          ) : canvas ? (
            // Saved and unloaded while out of sight; it loads again when shown.
            <div className="h-full w-full" data-moss-canvas-suspended aria-hidden />
          ) : undefined
        }
      />
      <div
        className={
          props.fullWidth
            ? canvas
              ? "z-40 flex shrink-0 flex-col items-end gap-2 px-4 pb-3"
              : "pointer-events-none absolute inset-x-0 bottom-3 z-40 flex flex-col items-center px-4"
            : "z-40 flex shrink-0 flex-col items-center gap-2 p-2"
        }
      >
        {!canvas && (
          <div
            className="pointer-events-auto mb-2 flex max-w-full items-center gap-1 overflow-x-auto rounded-card bg-foreground px-2 py-1 text-background shadow-lg"
            role="toolbar"
            aria-label="图片编辑"
          >
            {ACTIONS.map(([value, label]) => (
              <Button
                key={value}
                variant="ghost"
                size="sm"
                // The bar is dark in both themes; the ghost variant's muted
                // foreground made these labels invisible on it.
                className="shrink-0 text-ui-xs text-background/85 hover:bg-background/15 hover:text-background"
                onClick={() => edit(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <p
            role="alert"
            className="pointer-events-auto mb-2 rounded-card bg-background px-3 py-2 text-ui-sm text-destructive"
          >
            {error}
          </p>
        )}
        <div
          ref={setTarget}
          data-image-composer-target
          className={
            props.fullWidth
              ? `pointer-events-auto w-full ${canvas ? "max-w-xl" : "max-w-3xl"} [&_[data-chat-composer-form]]:max-w-full`
              : "hidden"
          }
        />
      </div>
    </div>
  );
}
