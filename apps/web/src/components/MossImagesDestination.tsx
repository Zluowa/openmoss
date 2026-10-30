// The Images destination starts with the ordinary Codex image flow. Canvas is
// mounted only after an image edit or an explicit, thread-bound MCP request.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openMossCanvas, type MossCanvasImageFocus } from "~/lib/mossCanvasBridge";
import type { MossImagesConversationInput } from "~/lib/mossImagesConversation";
import { MossImagesWorkspace } from "./MossImagesWorkspace";
import { MossCanvasWebSurface } from "./MossCanvasWebSurface";
import type { Project } from "~/types";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import {
  describeMossImagesError,
  loadMossImagesCanvasOrigin,
  MossImagesError,
} from "~/lib/mossImagesClient";

export interface MossImagesCanvasRequest {
  readonly id: string;
  readonly threadId: string;
  readonly image?: MossCanvasImageFocus;
}

export function MossImagesDestination({
  threadId,
  contextThreadId = threadId,
  prepareThread,
  onClose,
  onLeaveGuardChange,
  canvasRequest,
  onCanvasRequestConsumed,
  onStartConversation,
  voiceProject,
  openCanvasInConversation = false,
  onOpenOriginCanvas,
}: {
  readonly threadId: string | null;
  readonly contextThreadId?: string | null;
  readonly voiceProject?: Project | undefined;
  readonly prepareThread: () => Promise<string | null>;
  readonly onClose: () => void;
  readonly onLeaveGuardChange: (guard: (() => Promise<boolean>) | null) => void;
  readonly canvasRequest?: MossImagesCanvasRequest | null;
  readonly onCanvasRequestConsumed?: () => void;
  readonly onStartConversation?: (input: MossImagesConversationInput) => Promise<void>;
  readonly openCanvasInConversation?: boolean;
  readonly onOpenOriginCanvas?: (
    threadId: string,
    image: MossCanvasImageFocus,
    isCurrent: () => boolean,
    beginNavigation: () => void,
  ) => Promise<void>;
}) {
  const boundary = useMossImagesAccountBoundary();
  const mounted = useRef(true);
  const editRequest = useRef<AbortController | null>(null);
  const currentThread = useRef(contextThreadId);
  currentThread.current = contextThreadId;
  useLayoutEffect(() => {
    editRequest.current?.abort();
    editRequest.current = null;
  }, [boundary.key]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editRequest.current?.abort();
    };
  }, []);
  const [openError, setOpenError] = useState("");
  const [canvas, setCanvas] = useState<{
    threadId: string | null;
    image?: MossCanvasImageFocus;
  } | null>(null);
  const lastRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      !canvasRequest ||
      canvasRequest.id === lastRequest.current ||
      canvasRequest.threadId !== threadId
    )
      return;
    lastRequest.current = canvasRequest.id;
    setCanvas({
      threadId: canvasRequest.threadId,
      ...(canvasRequest.image ? { image: canvasRequest.image } : {}),
    });
    onCanvasRequestConsumed?.();
  }, [canvasRequest, threadId, onCanvasRequestConsumed]);
  const editImage = useCallback(
    (image: MossCanvasImageFocus, sourceIsCurrent?: () => boolean) => {
      if (
        !/^moss_[A-Za-z0-9_-]{1,128}$/u.test(image.jobId) ||
        !Number.isInteger(image.imageIndex) ||
        image.imageIndex < 0 ||
        image.imageIndex > 31 ||
        !boundary.isCurrent() ||
        sourceIsCurrent?.() === false
      )
        return;
      editRequest.current?.abort();
      const controller = new AbortController();
      editRequest.current = controller;
      const initialThread = currentThread.current;
      let targetThread: string | null = null;
      let navigating = false;
      const isCurrent = () =>
        editRequest.current === controller &&
        boundary.isCurrent() &&
        sourceIsCurrent?.() !== false &&
        (currentThread.current === initialThread || currentThread.current === targetThread) &&
        (navigating || (mounted.current && !controller.signal.aborted));
      setOpenError("");
      void (async () => {
        const origin = await loadMossImagesCanvasOrigin(image.jobId, controller.signal);
        if (!isCurrent()) return;
        targetThread = origin.threadId;
        if (origin.threadId) {
          if (openCanvasInConversation) {
            if (!onOpenOriginCanvas) throw new Error("原会话导航尚未就绪，请重新打开图像页。");
            // The route grants this narrow handoff only after leave/flush passes.
            // It separately retires the navigation on an explicit close/switch.
            await onOpenOriginCanvas(origin.threadId, image, isCurrent, () => {
              navigating = true;
            });
          } else setCanvas({ threadId: origin.threadId, image });
          return;
        }
        // Only a genuinely unbound legacy image uses the selected folder.
        if (openCanvasInConversation) {
          const id = threadId ?? (await prepareThread());
          targetThread = id;
          if (!isCurrent()) return;
          if (!id) throw new Error("请先选择此会话的工作文件夹。");
          openMossCanvas({ surface: "canvas", threadId: id, image });
        } else setCanvas({ threadId, image });
      })().catch((cause) => {
        if (isCurrent())
          setOpenError(
            cause instanceof MossImagesError
              ? describeMossImagesError(cause)
              : cause instanceof Error
                ? cause.message
                : "画布尚未就绪。",
          );
      });
    },
    [threadId, prepareThread, openCanvasInConversation, onOpenOriginCanvas, boundary],
  );
  return (
    <div data-moss-images-destination className="relative flex h-full min-h-0 min-w-0 flex-1">
      {openError && (
        <p
          role="alert"
          className="absolute inset-x-0 top-12 z-50 bg-background p-3 text-center text-ui-sm text-destructive"
        >
          {openError}
        </p>
      )}
      <div className={canvas ? "hidden" : "contents"} aria-hidden={canvas ? true : undefined}>
        <MossImagesWorkspace
          onClose={onClose}
          threadId={threadId}
          prepareThread={prepareThread}
          onEditInCanvas={editImage}
          onStartConversation={onStartConversation}
          voiceProject={voiceProject}
        />
      </div>
      {canvas && (
        <MossCanvasWebSurface
          threadId={canvas.threadId}
          prepareThread={prepareThread}
          {...(canvas.image ? { image: canvas.image } : {})}
          returnSurface="images"
          onClose={() => setCanvas(null)}
          onLeaveGuardChange={onLeaveGuardChange}
        />
      )}
    </div>
  );
}
