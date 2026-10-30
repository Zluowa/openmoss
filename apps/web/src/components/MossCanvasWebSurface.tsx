// FILE: MossCanvasWebSurface.tsx
// Purpose: Hosts the complete Open Moss Canvas web app inside the Images
//          destination — Codex-style surface chrome with our own canvas
//          features and components in the workspace area.
// Layer: Web destination surface

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useRailShellStore } from "../railShellStore";
import { useDesktopTopBarWindowControlsGutterClassName } from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";

import { resolveWsHttpUrl } from "../lib/wsHttpUrl";
import type { MossCanvasImageFocus } from "../lib/mossCanvasBridge";
import { useMossImagesAccountBoundary } from "../lib/mossImagesAccountBoundary";
import {
  importMossCanvasLocalImages,
  loadMossCanvasBinding,
  type MossCanvasBinding,
  type MossCanvasLocalImage,
  type MossCanvasImageImportCache,
} from "../lib/mossCanvasClient";
import {
  parseMossCanvasComposeContext,
  parseMossCanvasSelection,
  type MossCanvasComposeContext,
  type MossCanvasSelection,
} from "../lib/mossCanvasSelection";

export type MossCanvasComposeContextReader = () => Promise<{
  readonly context: MossCanvasComposeContext;
  readonly binding: MossCanvasBinding;
} | null>;

// The pinned Canvas host can wait 90 seconds for each account/storage request.
// Import completion is awaited separately; leave enough time for the final
// save acknowledgement instead of reporting failure while it is still active.
const CANVAS_FLUSH_TIMEOUT_MS = 100_000;

interface MossCanvasWebSurfaceProps {
  readonly onClose: () => void;
  readonly onLeaveGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
  readonly onComposeContextChange?: (reader: MossCanvasComposeContextReader | null) => void;
  readonly threadId?: string | null;
  readonly prepareThread?: () => Promise<string | null>;
  readonly image?: MossCanvasImageFocus;
  readonly returnSurface?: "images";
  readonly embedded?: boolean;
  readonly localImages?: {
    readonly images: readonly MossCanvasLocalImage[];
    readonly activeImageId: string;
    readonly cwd?: string;
    readonly action?: MossCanvasImageFocus["action"];
  };
  readonly onSelectionChange?: (selection: MossCanvasSelection, binding: MossCanvasBinding) => void;
  readonly onImportStateChange?: (state: "loading" | "ready" | "failed") => void;
}

function canvasFrame(
  threadId?: string | null,
  image?: MossCanvasImageFocus,
  returnSurface?: "images",
): { src: string; token: string } | null {
  if (typeof window === "undefined") return null;
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  let token = "";
  if (wsUrl) {
    try {
      token = new URL(wsUrl).searchParams.get("token") ?? "";
    } catch {
      token = "";
    }
  }
  const base = resolveWsHttpUrl("/canvas/");
  const url = new URL(base, window.location.origin);
  url.searchParams.delete("token");
  url.searchParams.set("moss_host", "1");
  url.searchParams.delete("moss_token");
  if (threadId) {
    url.searchParams.set("moss_thread", threadId);
    url.searchParams.set("projectId", `thread:${threadId}`);
    url.searchParams.set("projectKey", threadId);
  }
  if (image) {
    url.searchParams.set("moss_image_job", image.jobId);
    url.searchParams.set("moss_image_index", String(image.imageIndex));
    url.searchParams.set("moss_image_action", image.action ?? "edit");
  }
  if (returnSurface) url.searchParams.set("moss_return_surface", returnSurface);
  return { src: url.toString(), token };
}

export function MossCanvasWebSurface({
  onClose,
  onLeaveGuardChange,
  onComposeContextChange,
  threadId,
  prepareThread,
  image,
  returnSurface,
  embedded = false,
  localImages,
  onSelectionChange,
  onImportStateChange,
}: MossCanvasWebSurfaceProps) {
  const boundary = useMossImagesAccountBoundary();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const [prepared, setPrepared] = useState(!prepareThread);
  const [resolvedThread, setResolvedThread] = useState(threadId ?? null);
  const [preparationError, setPreparationError] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (threadId || !prepareThread) {
      setResolvedThread(threadId ?? null);
      setPrepared(true);
      setPreparationError("");
      return;
    }
    setPrepared(false);
    setPreparationError("");
    void prepareThread().then(
      (id) => {
        if (!cancelled) {
          if (!id) {
            setPreparationError("请先选择此会话的工作文件夹。");
            return;
          }
          setResolvedThread(id);
          setPrepared(true);
        }
      },
      () => {
        if (!cancelled) setPreparationError("画布的工作文件夹尚未就绪，请稍后重新打开。");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [threadId, prepareThread]);
  const connection = useMemo(
    () => (prepared ? canvasFrame(resolvedThread, image, returnSurface) : null),
    [prepared, resolvedThread, image, returnSurface],
  );
  const src = connection?.src ?? null;
  const frame = useRef<HTMLIFrameElement>(null);
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [imageImportError, setImageImportError] = useState("");
  const [contextError, setContextError] = useState("");
  const frameKey = JSON.stringify([src, boundary.key]);
  const currentFrameKey = useRef(frameKey);
  currentFrameKey.current = frameKey;
  const [readyFrameKey, setReadyFrameKey] = useState<string | null>(null);
  const binding = useRef<MossCanvasBinding | null>(null);
  const latestSelection = useRef<MossCanvasSelection | null>(null);
  const selectionCallback = useRef(onSelectionChange);
  selectionCallback.current = onSelectionChange;
  const selectionSequence = useRef(0);
  const selectionEpoch = useRef(-1);
  const documentGeneration = useRef(0);
  const flushLatest = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const importVersion = useRef(0);
  const importControllers = useRef(new Set<AbortController>());
  const importedImages = useRef<MossCanvasImageImportCache>(new Map());
  const openedAssets = useRef(new Map<string, string>());
  const pendingImport = useRef<{
    id: string;
    version: number;
    resolve: (result: { ok: boolean; errorCode?: string; documentEpoch?: number }) => void;
  } | null>(null);
  const importWork = useRef<Promise<void>>(Promise.resolve());
  const lastFocus = useRef<string | null>(null);
  const requestedFocus = useRef<string | null>(null);
  const failedFocus = useRef<string | null>(null);
  const documentChanged = useRef(false);
  const navigationVersion = useRef(0);
  const [historyWarning, setHistoryWarning] = useState("");
  const importStateCallback = useRef(onImportStateChange);
  importStateCallback.current = onImportStateChange;
  const pendingFlush = useRef<{ id: string; resolve: (ok: boolean) => void } | null>(null);
  const pendingContext = useRef<{
    id: string;
    epoch: number;
    sequence: number;
    resolve: (context: MossCanvasComposeContext | null) => void;
  } | null>(null);
  const contextFlight = useRef<ReturnType<MossCanvasComposeContextReader> | null>(null);
  const leaving = useRef<Promise<boolean> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    setReadyFrameKey(null);
    binding.current = null;
    latestSelection.current = null;
    selectionSequence.current = 0;
    selectionEpoch.current = -1;
    documentGeneration.current += 1;
    documentChanged.current = false;
    importVersion.current += 1;
    importControllers.current.forEach((controller) => controller.abort());
    importControllers.current.clear();
    pendingImport.current?.resolve({ ok: false, errorCode: "cancelled" });
    pendingFlush.current?.resolve(false);
    pendingContext.current?.resolve(null);
    contextFlight.current = null;
    leaving.current = null;
    importWork.current = Promise.resolve();
    navigationVersion.current += 1;
    importedImages.current.clear();
    openedAssets.current.clear();
    lastFocus.current = null;
    requestedFocus.current = null;
    failedFocus.current = null;
    setClosing(false);
    setSaveError("");
    setImageImportError("");
    setContextError("");
    setHistoryWarning("");
    return () => {
      importVersion.current += 1;
      importControllers.current.forEach((controller) => controller.abort());
      importControllers.current.clear();
      documentGeneration.current += 1;
      navigationVersion.current += 1;
      pendingImport.current?.resolve({ ok: false, errorCode: "cancelled" });
      pendingFlush.current?.resolve(false);
      pendingContext.current?.resolve(null);
    };
  }, [frameKey]);

  useEffect(() => {
    if (readyFrameKey !== frameKey || !resolvedThread || !src || documentChanged.current) return;
    const focusKey = localImages
      ? `${localImages.activeImageId}:${localImages.action ?? "canvas"}`
      : null;
    if (requestedFocus.current !== focusKey) {
      requestedFocus.current = focusKey;
      importVersion.current += 1;
      importControllers.current.forEach((controller) => controller.abort());
      pendingImport.current?.resolve({ ok: false, errorCode: "cancelled" });
    }
    const version = importVersion.current;
    const controller = new AbortController();
    importControllers.current.add(controller);
    const generation = documentGeneration.current;
    const current = () =>
      !controller.signal.aborted &&
      currentFrameKey.current === frameKey &&
      generation === documentGeneration.current &&
      importVersion.current === version &&
      boundary.isCurrent();
    // History can grow while a batch is awaiting acknowledgement. Queue the
    // next snapshot behind that work instead of cancelling/replaying its write.
    const previous = importWork.current;
    const work = previous
      .then(async () => {
        if (!current() || (focusKey && failedFocus.current === focusKey)) return;
        importStateCallback.current?.("loading");
        setImageImportError("");
        setHistoryWarning("");
        const lease = await loadMossCanvasBinding(resolvedThread, controller.signal);
        if (!current()) return;
        if (binding.current && JSON.stringify(binding.current) !== JSON.stringify(lease)) {
          throw new Error("画布的账号或工作文件夹已变化，请重新打开。");
        }
        const firstBinding = !binding.current;
        binding.current = lease;
        if (firstBinding && latestSelection.current)
          selectionCallback.current?.(latestSelection.current, lease);
        if (!localImages?.images.length) {
          importStateCallback.current?.("ready");
          return;
        }
        // Reading/importing the selected item first makes its failure authoritative
        // before any optional historical outputs are considered.
        const selected = localImages.images.find((item) => item.id === localImages.activeImageId);
        const images = selected
          ? [selected, ...localImages.images.filter((item) => item !== selected)]
          : localImages.images;
        const { items, unavailable } = await importMossCanvasLocalImages({
          images,
          ...(localImages.cwd ? { cwd: localImages.cwd } : {}),
          binding: lease,
          isCurrent: current,
          activeImageId: localImages.activeImageId,
          cache: importedImages.current,
          signal: controller.signal,
        });
        if (!current()) return;
        const active = items.find((item) => item.sourceId === localImages.activeImageId);
        if (!active) throw new Error("当前选中的图片无法打开，请重新选择。");
        const focus = lastFocus.current !== focusKey;
        const changed = items.filter((item) => openedAssets.current.get(item.id) !== item.assetId);
        const queued = focus
          ? [active, ...changed.filter((item) => item.id !== active.id)]
          : changed;
        for (let offset = 0; offset < queued.length; offset += 32) {
          if (!current()) return;
          const batch = queued.slice(offset, offset + 32);
          const focusBatch = focus && offset === 0;
          const epoch = selectionEpoch.current;
          const requestId = crypto.randomUUID();
          const result = await new Promise<{
            ok: boolean;
            errorCode?: string;
            documentEpoch?: number;
          }>((resolve) => {
            const timer = setTimeout(() => finish({ ok: false, errorCode: "timeout" }), 20_000);
            const finish = (value: { ok: boolean; errorCode?: string; documentEpoch?: number }) => {
              clearTimeout(timer);
              if (pendingImport.current?.id === requestId) pendingImport.current = null;
              resolve(value);
            };
            pendingImport.current = { id: requestId, version, resolve: finish };
            if (focusBatch) lastFocus.current = focusKey;
            const target = frame.current?.contentWindow;
            if (!target) {
              finish({ ok: false, errorCode: "frame_unavailable" });
              return;
            }
            try {
              target.postMessage(
                {
                  type: "moss-canvas-open-assets",
                  version: 1,
                  threadId: resolvedThread,
                  requestId,
                  items: batch.map(({ id, title, assetId }) => ({ id, title, assetId })),
                  ...(focusBatch ? { activeImageId: active.id } : {}),
                  ...(epoch >= 1 ? { expectedDocumentEpoch: epoch } : {}),
                  action: focusBatch ? (localImages.action ?? "canvas") : "canvas",
                  focus: focusBatch,
                },
                new URL(src).origin,
              );
            } catch {
              finish({ ok: false, errorCode: "frame_unavailable" });
            }
          });
          if (!current()) return;
          if (
            !result.ok ||
            (result.documentEpoch !== undefined && epoch >= 0 && result.documentEpoch !== epoch)
          ) {
            throw new Error(
              result.errorCode === "canvas_document_changed" ||
                (result.documentEpoch !== undefined && epoch >= 0 && result.documentEpoch !== epoch)
                ? "画布文档已切换，请返回会话后重新打开。"
                : result.errorCode === "timeout"
                  ? "画布尚未确认图片已打开，请返回会话后重新打开。"
                  : "图片未能打开，请返回会话后重新打开画布。",
            );
          }
          batch.forEach((item) => openedAssets.current.set(item.id, item.assetId));
        }
        if (current()) {
          setHistoryWarning(
            unavailable.length
              ? `有 ${unavailable.length} 张历史图片暂不可用，已打开其余图片。`
              : "",
          );
          importStateCallback.current?.("ready");
        }
      })
      .catch((cause) => {
        if (!current()) return;
        failedFocus.current = focusKey;
        setImageImportError(
          cause instanceof Error ? cause.message : "图片未能打开，请返回会话后重新打开画布。",
        );
        importStateCallback.current?.("failed");
      })
      .finally(() => {
        importControllers.current.delete(controller);
      });
    importWork.current = work;
  }, [readyFrameKey, frameKey, resolvedThread, src, localImages, boundary.isCurrent]);

  useEffect(() => {
    if (!src) {
      setState("unavailable");
      return;
    }
    let cancelled = false;
    // A missing bundle is a visible release failure; never silently substitute
    // the former partial editor for the complete Canvas workspace.
    fetch(src, { method: "GET", credentials: "omit" })
      .then((response) => {
        if (cancelled) return;
        setState(response.ok ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!cancelled) setState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const acceptEpoch = (epoch: unknown): epoch is number => {
      if (
        !Number.isSafeInteger(epoch) ||
        (epoch as number) < 1 ||
        (epoch as number) < selectionEpoch.current
      )
        return false;
      if (selectionEpoch.current >= 1 && (epoch as number) > selectionEpoch.current) {
        documentGeneration.current += 1;
        documentChanged.current = true;
        importControllers.current.forEach((controller) => controller.abort());
        pendingImport.current?.resolve({ ok: false, errorCode: "canvas_document_changed" });
        pendingFlush.current?.resolve(false);
        pendingContext.current?.resolve(null);
        setImageImportError("画布文档已切换，请返回会话后重新打开。");
        importStateCallback.current?.("failed");
      }
      if ((epoch as number) > selectionEpoch.current) {
        selectionEpoch.current = epoch as number;
        selectionSequence.current = 0;
      }
      return true;
    };
    const receive = (event: MessageEvent) => {
      if (
        !src ||
        currentFrameKey.current !== frameKey ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== new URL(src).origin
      )
        return;
      if (!boundary.isCurrent()) return;
      if (
        event.data?.type === "moss-canvas-ready" &&
        event.data.version === 1 &&
        event.data.threadId === resolvedThread
      ) {
        if (!acceptEpoch(event.data.documentEpoch)) return;
        setReadyFrameKey(frameKey);
        return;
      }
      if (
        event.data?.type === "moss-canvas-open-assets-result" &&
        event.data.version === 1 &&
        event.data.requestId === pendingImport.current?.id &&
        event.data.threadId === resolvedThread
      ) {
        const epoch = event.data.documentEpoch;
        if (!Number.isSafeInteger(epoch) || epoch < 1) return;
        if (epoch > selectionEpoch.current) {
          acceptEpoch(epoch);
          return;
        }
        pendingImport.current?.resolve({
          ok: event.data.ok === true,
          ...(typeof event.data.errorCode === "string" ? { errorCode: event.data.errorCode } : {}),
          documentEpoch: epoch,
        });
        return;
      }
      if (resolvedThread) {
        const selection = parseMossCanvasSelection(event.data, resolvedThread);
        if (
          selection &&
          (selection.documentEpoch > selectionEpoch.current ||
            (selection.documentEpoch === selectionEpoch.current &&
              selection.sequence > selectionSequence.current))
        ) {
          if (!acceptEpoch(selection.documentEpoch)) return;
          selectionSequence.current = selection.sequence;
          latestSelection.current = selection;
          if (
            pendingContext.current &&
            (pendingContext.current.epoch !== selection.documentEpoch ||
              pendingContext.current.sequence !== selection.sequence)
          )
            pendingContext.current.resolve(null);
          if (binding.current) selectionCallback.current?.(selection, binding.current);
          return;
        }
      }
      if (event.data?.type === "moss-canvas-bootstrap-ready") {
        frame.current?.contentWindow?.postMessage(
          { type: "moss-canvas-bootstrap", token: connection?.token ?? "" },
          new URL(src).origin,
        );
        return;
      }
      if (event.data?.type === "moss-canvas-media-import-status") {
        setImageImportError(
          event.data.status === "ready" ? "" : "图像尚未导入画布，请检查账号和当前会话文件夹。",
        );
        return;
      }
      if (
        event.data?.type === "moss-canvas-compose-context-result" &&
        event.data.version === 1 &&
        event.data.threadId === resolvedThread &&
        event.data.requestId === pendingContext.current?.id
      ) {
        const expected = pendingContext.current;
        const context = resolvedThread
          ? parseMossCanvasComposeContext(event.data, resolvedThread)
          : null;
        if (event.data.ok !== true && event.data.errorCode === "canvas_context_truncated") {
          setContextError("选中的标注或评论过多，请缩小选择后再发送。");
        }
        expected?.resolve(
          context &&
            context.documentEpoch === expected.epoch &&
            context.selectionSequence === expected.sequence
            ? context
            : null,
        );
        return;
      }
      if (
        event.data?.type === "moss-canvas-flushed" &&
        event.data.requestId === pendingFlush.current?.id
      ) {
        pendingFlush.current?.resolve(event.data.ok === true);
        return;
      }
      if (event.data?.type !== "moss-canvas-navigation") return;
      const destination = event.data.destination;
      if (!["account", "skills", "plugins", "close"].includes(destination)) return;
      const requestVersion = ++navigationVersion.current;
      const generation = documentGeneration.current;
      void flushLatest
        .current()
        .then(async (saved) => {
          if (
            !saved ||
            !boundary.isCurrent() ||
            currentFrameKey.current !== frameKey ||
            generation !== documentGeneration.current ||
            requestVersion !== navigationVersion.current
          )
            return;
          if (destination === "account") {
            await navigate({ to: "/settings", search: { section: "usage" } });
          } else if (destination === "skills" || destination === "plugins") {
            await navigate({ to: destination === "skills" ? "/skills" : "/plugins" });
          }
          if (
            !boundary.isCurrent() ||
            currentFrameKey.current !== frameKey ||
            generation !== documentGeneration.current ||
            requestVersion !== navigationVersion.current
          )
            return;
          if (destination === "account") useRailShellStore.getState().selectRouteItem("settings");
          else if (destination === "skills" || destination === "plugins")
            useRailShellStore.getState().selectRouteItem("skills");
          onClose();
        })
        .catch(() => {
          if (boundary.isCurrent() && requestVersion === navigationVersion.current)
            setSaveError("页面未能打开，画布和草稿已保留，请稍后再试。");
        });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [
    src,
    frameKey,
    connection,
    onClose,
    navigate,
    boundary.isCurrent,
    resolvedThread,
    onSelectionChange,
  ]);

  const requestFlush = useCallback((): Promise<boolean> => {
    if (leaving.current) return leaving.current;
    if (!src || !frame.current?.contentWindow) return Promise.resolve(true);
    const generation = documentGeneration.current;
    const current = () =>
      currentFrameKey.current === frameKey &&
      generation === documentGeneration.current &&
      boundary.isCurrent();
    setClosing(true);
    setSaveError("");
    const saved = (async () => {
      // Imports mutate the document; save only after the latest import sequence
      // settles so closing cannot drop a batch that is already being acknowledged.
      let work: Promise<void>;
      do {
        work = importWork.current;
        await work;
      } while (work !== importWork.current);
      if (!current()) return false;
      const target = frame.current?.contentWindow;
      if (!target) return false;
      const id = crypto.randomUUID();
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => finish(false), CANVAS_FLUSH_TIMEOUT_MS);
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          if (pendingFlush.current?.id === id) pendingFlush.current = null;
          resolve(ok);
        };
        pendingFlush.current = { id, resolve: finish };
        try {
          target.postMessage({ type: "moss-canvas-flush", requestId: id }, new URL(src).origin);
        } catch {
          finish(false);
        }
      });
    })();
    const flight = saved
      .catch(() => false)
      .then((ok) => {
        if (!current()) return false;
        setClosing(false);
        if (!ok) setSaveError("画布还未保存完成，请稍后再关闭。");
        return ok;
      })
      .finally(() => {
        if (leaving.current === flight) leaving.current = null;
      });
    leaving.current = flight;
    return flight;
  }, [src, frameKey, boundary.isCurrent]);
  flushLatest.current = requestFlush;

  const readComposeContext = useCallback<MossCanvasComposeContextReader>(() => {
    if (contextFlight.current) return contextFlight.current;
    const generation = documentGeneration.current;
    const current = () =>
      currentFrameKey.current === frameKey &&
      generation === documentGeneration.current &&
      boundary.isCurrent() &&
      !documentChanged.current;
    setContextError("");
    const work = (async () => {
      if (!(await requestFlush()) || !current() || !resolvedThread || !src) return null;
      const target = frame.current?.contentWindow;
      const lease = binding.current;
      const epoch = selectionEpoch.current;
      const sequence = selectionSequence.current;
      const selectedItems = latestSelection.current?.items;
      if (!target || !lease || !selectedItems || epoch < 1 || sequence < 1) return null;
      const requestId = crypto.randomUUID();
      const context = await new Promise<MossCanvasComposeContext | null>((resolve) => {
        const timer = setTimeout(() => finish(null), 10_000);
        const finish = (value: MossCanvasComposeContext | null) => {
          clearTimeout(timer);
          if (pendingContext.current?.id === requestId) pendingContext.current = null;
          resolve(value);
        };
        pendingContext.current = { id: requestId, epoch, sequence, resolve: finish };
        try {
          target.postMessage(
            {
              type: "moss-canvas-compose-context",
              version: 1,
              threadId: resolvedThread,
              requestId,
              expectedDocumentEpoch: epoch,
              expectedSelectionSequence: sequence,
            },
            new URL(src).origin,
          );
        } catch {
          finish(null);
        }
      });
      if (context?.items.some((item) => item.context?.truncated) && current()) {
        setContextError("选中的标注或评论过多，请缩小选择后再发送。");
        return null;
      }
      if (
        !context ||
        !current() ||
        selectionEpoch.current !== epoch ||
        selectionSequence.current !== sequence ||
        context.items.length !== selectedItems.length ||
        context.items.some(
          (item, index) =>
            item.shapeId !== selectedItems[index]?.shapeId ||
            item.assetId !== selectedItems[index]?.assetId,
        )
      )
        return null;
      return { context, binding: lease };
    })();
    const flight = work
      .catch(() => null)
      .then((result) => {
        if (!result && current())
          setContextError(
            (existing) => existing || "画布的图片或标注尚未确认，请检查当前选择后再发送。",
          );
        return result;
      })
      .finally(() => {
        if (contextFlight.current === flight) contextFlight.current = null;
      });
    contextFlight.current = flight;
    return flight;
  }, [frameKey, boundary.isCurrent, requestFlush, resolvedThread, src]);

  useEffect(() => {
    onComposeContextChange?.(readComposeContext);
    return () => onComposeContextChange?.(null);
  }, [onComposeContextChange, readComposeContext]);

  useEffect(() => {
    onLeaveGuardChange?.(requestFlush);
    return () => onLeaveGuardChange?.(null);
  }, [onLeaveGuardChange, requestFlush]);
  // Reuse the editor's router guard for navigation outside this destination.
  // Browser shutdown cannot await an RPC; Canvas retains its normal autosave.
  useBlocker({ shouldBlockFn: async () => !(await requestFlush()), enableBeforeUnload: false });

  const close = async () => {
    const requestVersion = ++navigationVersion.current;
    if (
      (await requestFlush()) &&
      currentFrameKey.current === frameKey &&
      boundary.isCurrent() &&
      requestVersion === navigationVersion.current
    )
      onClose();
  };

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      {!embedded && (
        <div
          className={cn(
            "flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-4",
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className="text-ui-sm font-medium text-foreground">画布</div>
          <button
            type="button"
            aria-label="关闭画布"
            onClick={() => void close()}
            disabled={closing}
            className="no-drag rounded-md px-2 py-1 text-ui-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {closing ? "正在保存…" : "关闭"}
          </button>
        </div>
      )}
      {saveError ? (
        <p role="alert" className="px-4 py-2 text-ui-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      {imageImportError ? (
        <p role="alert" className="px-4 py-2 text-ui-sm text-destructive">
          {imageImportError}
        </p>
      ) : null}
      {contextError ? (
        <p role="alert" className="px-4 py-2 text-ui-sm text-destructive">
          {contextError}
        </p>
      ) : null}
      {historyWarning ? (
        <p role="status" className="px-4 py-2 text-ui-sm text-muted-foreground">
          {historyWarning}
        </p>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1">
        {preparationError ? (
          <p role="alert" className="px-4 py-2 text-ui-sm text-destructive">
            {preparationError}
          </p>
        ) : !prepared ? (
          <div className="flex h-full items-center justify-center text-ui-sm text-muted-foreground">
            正在加载画布…
          </div>
        ) : state === "ready" && src ? (
          <>
            <iframe
              key={frameKey}
              ref={frame}
              src={src}
              onLoad={() => {
                if (!boundary.isCurrent() || currentFrameKey.current !== frameKey) return;
                frame.current?.contentWindow?.postMessage(
                  { type: "moss-canvas-bootstrap", token: connection?.token ?? "" },
                  new URL(src).origin,
                );
              }}
              title="Moss Canvas"
              className="absolute inset-0 h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write"
            />
            {readyFrameKey !== frameKey && (
              <div
                role="status"
                className="absolute inset-0 z-10 flex items-center justify-center bg-background text-ui-sm text-muted-foreground"
              >
                正在加载画布…
              </div>
            )}
          </>
        ) : state === "unavailable" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-ui-sm text-muted-foreground">
            <p>画布工作区暂不可用</p>
            <p className="max-w-md text-center text-ui-xs">
              请重新打开画布；如果问题持续，请更新 Moss。
            </p>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-ui-sm text-muted-foreground">
            正在加载画布…
          </div>
        )}
      </div>
    </div>
  );
}
