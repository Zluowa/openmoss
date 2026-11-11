// FILE: usePageMediaBridge.ts
// Purpose: Runs a page's image and video cards (the Canvas's own cards, drawn by the page editor).
//          The editor builds the same media job the hosted Canvas sends; Moss holds the account,
//          so it posts that job to its media API, follows it, and hands the finished file back to
//          the page: an image is kept in the library like an upload, a video by its saved media
//          address. No agent chat is involved.
// Layer: Pages (web)

import { useEffect, useRef } from "react";

import { ensureNativeApi } from "~/nativeApi";
import {
  describeMossImagesError,
  loadMossImageJob,
  loadMossImagesCatalog,
  requestMossMediaJob,
  waitForMossImageJob,
  type MossImageJob,
} from "~/lib/mossImagesClient";
import type {
  PageEditorMediaEvent,
  PageMediaCatalog,
  PageMediaJobUpdate,
  PageRichEditorChannel,
} from "~/lib/pageRichEditorChannel";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

const MEDIA_ASSET_PATH = /^\/api\/moss\/media\/assets\/moss_[A-Za-z0-9_-]+\/[0-9]{1,2}$/u;
const CATALOG_RETRY_MS = [5_000, 15_000, 45_000] as const;
/** Generations take minutes; the server keeps the job, so a later visit can observe it. */
const JOB_WAIT_MS = 20 * 60 * 1000;

export interface PageMediaBridgeDeps {
  readonly loadCatalog: typeof loadMossImagesCatalog;
  readonly requestJob: typeof requestMossMediaJob;
  readonly loadJob: typeof loadMossImageJob;
  readonly waitForJob: typeof waitForMossImageJob;
  /** Keeps a finished image in the library and returns its page address. */
  readonly saveImage: (job: MossImageJob, signal: AbortSignal) => Promise<string | null>;
}

const statusOf = (job: MossImageJob): PageMediaJobUpdate["status"] =>
  job.status === "queued" ? "queued" : "running";

function outputPath(job: MossImageJob, kind: "image" | "video"): string | null {
  const asset = job.assets?.find((entry) => entry.kind === kind);
  if (asset && MEDIA_ASSET_PATH.test(asset.downloadPath)) return asset.downloadPath;
  const url = (kind === "video" ? job.videoUrls : job.imageUrls)?.[0];
  return typeof url === "string" && MEDIA_ASSET_PATH.test(url.split("?")[0]!)
    ? url.split("?")[0]!
    : null;
}

async function saveImageInLibrary(job: MossImageJob, signal: AbortSignal): Promise<string | null> {
  const path = outputPath(job, "image");
  if (!path) return null;
  const response = await fetch(resolveWsHttpUrl(path), {
    credentials: "include",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const extension =
    blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
  const result = await ensureNativeApi().library.importFiles({
    files: [
      {
        name: `${
          job.prompt
            .trim()
            .slice(0, 40)
            .replace(/[\\/:*?"<>|]/gu, " ") || "image"
        }.${extension}`,
        ...(blob.type ? { mimeType: blob.type } : {}),
        dataBase64: btoa(binary),
      },
    ],
  });
  return result.items[0]?.previewPath ?? null;
}

const defaultDeps: PageMediaBridgeDeps = {
  loadCatalog: loadMossImagesCatalog,
  requestJob: requestMossMediaJob,
  loadJob: loadMossImageJob,
  waitForJob: waitForMossImageJob,
  saveImage: saveImageInLibrary,
};

/** One page editor's media jobs; exported for tests. */
export function createPageMediaRunner(
  channel: Pick<PageRichEditorChannel, "mediaJob" | "mediaResult" | "setMediaCatalog">,
  deps: PageMediaBridgeDeps = defaultDeps,
) {
  const controller = new AbortController();
  const running = new Map<string, PageMediaJobUpdate>();
  const report = (update: PageMediaJobUpdate) => {
    running.set(update.requestId, update);
    channel.mediaJob(update);
  };
  const fail = (base: { blockId: string; requestId: string; jobId?: string }, cause: unknown) => {
    running.delete(base.requestId);
    if (controller.signal.aborted) return;
    channel.mediaJob({ ...base, status: "failed", error: describeMossImagesError(cause) });
  };
  const follow = async (
    base: { blockId: string; requestId: string },
    kind: "image" | "video",
    first: MossImageJob,
  ) => {
    const ids = { ...base, jobId: first.jobId };
    report({ ...ids, status: statusOf(first) });
    const job = await deps.waitForJob({
      job: first,
      signal: controller.signal,
      timeoutMs: JOB_WAIT_MS,
      onUpdate: (next) => {
        if (next.status === "queued" || next.status === "running")
          report({ ...ids, status: statusOf(next) });
      },
    });
    if (job.status !== "succeeded") {
      fail(ids, new Error(job.errorMessage || "生成没有完成，请在生成记录中核对。"));
      return;
    }
    const url =
      kind === "image"
        ? ((await deps.saveImage(job, controller.signal).catch(() => null)) ??
          outputPath(job, "image"))
        : outputPath(job, "video");
    if (!url) {
      fail(ids, new Error("生成完成了，但没能取到结果文件，请在生成记录中查看。"));
      return;
    }
    running.delete(base.requestId);
    if (controller.signal.aborted) return;
    channel.mediaResult({
      ...base,
      kind,
      url,
      name: job.prompt.trim().slice(0, 80) || (kind === "image" ? "图片" : "视频"),
    });
  };
  const handle = (event: PageEditorMediaEvent) => {
    const base = { blockId: event.blockId, requestId: event.requestId };
    const known = running.get(event.requestId);
    if (known) {
      // The editor reloaded while Moss still follows this job: tell it where it stands.
      channel.mediaJob(known);
      return;
    }
    if (event.event === "media-generate") {
      report({ ...base, status: "submitting" });
      void deps
        .requestJob(event.request, controller.signal)
        .then((job) => follow(base, event.kind, job))
        .catch((cause) => fail(base, cause));
      return;
    }
    // A job submitted before a reload: observe it, never submit it again.
    report({ ...base, jobId: event.jobId, status: "running" });
    void deps
      .loadJob(event.jobId, controller.signal)
      .then((job) => {
        const kind = job.operation === "video" ? "video" : "image";
        return job.status === "succeeded" || job.status === "queued" || job.status === "running"
          ? follow(base, kind, job)
          : fail({ ...base, jobId: event.jobId }, new Error(job.errorMessage || "生成没有完成。"));
      })
      .catch((cause) => fail({ ...base, jobId: event.jobId }, cause));
  };
  const loadCatalog = async () => {
    channel.setMediaCatalog({ status: "loading", models: [] });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const catalog = await deps.loadCatalog(controller.signal);
        if (controller.signal.aborted) return;
        if (catalog.errorCode) throw new Error(catalog.errorCode);
        const media: PageMediaCatalog = {
          status: "ready",
          models: catalog.models.map(({ id, available, installed }) => ({
            id,
            available,
            installed,
          })),
        };
        channel.setMediaCatalog(media);
        return;
      } catch {
        if (controller.signal.aborted) return;
        channel.setMediaCatalog({ status: "unavailable", models: [] });
        const delay = CATALOG_RETRY_MS[attempt];
        if (delay === undefined) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (controller.signal.aborted) return;
      }
    }
  };
  return { handle, loadCatalog, dispose: () => controller.abort() };
}

/**
 * Connects one page editor's media cards to Moss's media API. The runner lives as long as the
 * editor: a document reload (after a save, a new revision) must not stop following a job, and
 * the reloaded cards ask about their jobs again. Each ready editor gets the catalog again.
 */
export function usePageMediaBridge(channel: PageRichEditorChannel, ready: boolean) {
  const runner = useRef<ReturnType<typeof createPageMediaRunner> | null>(null);
  useEffect(() => {
    const current = createPageMediaRunner(channel);
    runner.current = current;
    channel.onMediaEvent = current.handle;
    return () => {
      current.dispose();
      if (runner.current === current) runner.current = null;
      channel.onMediaEvent = () => {};
    };
  }, [channel]);
  useEffect(() => {
    if (ready && channel.mediaCardsSupported) void runner.current?.loadCatalog();
  }, [channel, ready]);
}
