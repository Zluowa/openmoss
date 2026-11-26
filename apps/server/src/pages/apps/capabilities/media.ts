// FILE: media.ts
// Purpose: Server half of the `media` capability: generates images and videos
// through the viewer's Moss media pipeline (MossMediaJobsService) and optionally
// caches completed outputs into the page's own assets for CSP-safe display.
// Layer: Server pages/apps

import { createHash, randomUUID } from "node:crypto";

import {
  PAGE_APP_ASSET_MAX_BYTES,
  PAGE_APP_ASSET_PATH,
  PAGE_APP_MEDIA_MAX_PROMPT_CHARS,
  PAGE_APP_MEDIA_MAX_REF_IMAGES,
  type PageAppAssetType,
  type PageAppMediaJobResult,
  type PageAppMediaKind,
  type PageAppMediaModelInfo,
} from "@moss/contracts";
import { PageAppCapabilityError, toPageAppCallError } from "@moss/shared/pageAppCapabilityPlugin";
import {
  MOSS_DEFAULT_IMAGE_MODEL_ID,
  MOSS_DEFAULT_VIDEO_MODEL_ID,
} from "@moss/shared/mossMediaPlugins";
import { Effect } from "effect";

import type { HoolaCanvasJobSnapshot } from "../../../hoolaCanvasBridge";
import type { MossMediaCredential, MossMediaJobsService } from "../../../mossMediaJobsService";
import type { PageAppExtensionStore } from "../extensions/PageAppExtensionStore";
import { sanitizeAssetName } from "./assets";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

const MAX_WAIT_MS = 45_000;
const DEFAULT_IMAGE_WAIT_MS = 30_000;
const DEFAULT_VIDEO_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_INLINE_DATA_URL_BYTES = 2 * 1024 * 1024;
const MAX_PER_MINUTE_PER_APP = 15;

export interface PageAppMediaGateway {
  readonly listModels: () => Promise<readonly PageAppMediaModelInfo[]>;
  readonly generate: (input: {
    readonly appId: string;
    readonly viewerId: string;
    readonly kind: PageAppMediaKind;
    readonly args: Record<string, unknown>;
  }) => Promise<PageAppMediaJobResult>;
  readonly getJob: (input: {
    readonly appId: string;
    readonly jobId: string;
  }) => Promise<PageAppMediaJobResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);

function mapMediaError(error: unknown): PageAppCapabilityError {
  if (error instanceof PageAppCapabilityError) return error;
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "upstream_error";
  if (code === "authentication_required" || code === "account_recovery_required") {
    return fail("authentication_required", "请先登录 Moss 账号后再生成图片或视频。");
  }
  if (code === "media_skill_not_installed" || code === "media_model_unavailable") {
    return fail("unavailable", "当前账号暂未启用该媒体生成模型。");
  }
  if (code === "insufficient_credits" || code === "quota_exceeded") {
    return fail("quota_exceeded", "Moss 账户媒体额度不足。");
  }
  if (code === "job_not_found") {
    return fail("not_found", "未找到对应的媒体生成任务。");
  }
  if (
    code === "invalid_request" ||
    code === "unsupported_model" ||
    code === "reference_images_not_supported" ||
    code === "mask_edits_not_supported" ||
    code === "transparent_background_not_supported"
  ) {
    return fail("invalid_argument", `媒体生成参数无效 (${code})。`);
  }
  const err = toPageAppCallError(error);
  return fail(err.code, err.message);
}

function validateGenerateArgs(kind: PageAppMediaKind, raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw fail("invalid_argument", "媒体生成参数必须是对象。");
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) throw fail("invalid_argument", "提示词 prompt 不能为空。");
  if (prompt.length > PAGE_APP_MEDIA_MAX_PROMPT_CHARS) {
    throw fail("invalid_argument", `提示词长度不能超过 ${PAGE_APP_MEDIA_MAX_PROMPT_CHARS} 字符。`);
  }
  const refImages = raw.referenceImages;
  if (refImages !== undefined) {
    if (!Array.isArray(refImages) || refImages.length > PAGE_APP_MEDIA_MAX_REF_IMAGES) {
      throw fail("invalid_argument", `参考图数量不能超过 ${PAGE_APP_MEDIA_MAX_REF_IMAGES} 张。`);
    }
    for (const item of refImages) {
      if (typeof item !== "string" || !item.trim()) {
        throw fail("invalid_argument", "参考图必须是有效的 data URL 或 HTTPS URL。");
      }
      if (/^data:image\/(?:png|jpeg|webp);base64,/u.test(item)) continue;
      try {
        const parsed = new URL(item);
        if (parsed.protocol !== "https:") throw new Error("non-https");
      } catch {
        throw fail("invalid_argument", "参考图仅支持 data:image/* 或 https:// URL。");
      }
    }
  }
  return {
    ...raw,
    prompt,
    modelId:
      typeof raw.modelId === "string" && raw.modelId.trim()
        ? raw.modelId.trim()
        : kind === "video"
          ? MOSS_DEFAULT_VIDEO_MODEL_ID
          : MOSS_DEFAULT_IMAGE_MODEL_ID,
    idempotencyKey:
      typeof raw.idempotencyKey === "string" && raw.idempotencyKey.trim()
        ? raw.idempotencyKey.trim().slice(0, 128)
        : `pa_${randomUUID()}`,
  };
}

function toResult(
  snapshot: HoolaCanvasJobSnapshot,
  extras?: {
    readonly assetIds?: readonly string[];
    readonly assetPaths?: readonly string[];
    readonly dataUrls?: readonly string[];
  },
): PageAppMediaJobResult {
  const kind: PageAppMediaKind = snapshot.operation === "video" ? "video" : "image";
  const rawUrls = kind === "video" ? snapshot.videoUrls : snapshot.imageUrls;
  return {
    jobId: snapshot.jobId,
    kind,
    modelId: snapshot.modelId,
    prompt: snapshot.prompt,
    status: snapshot.status,
    url: extras?.assetPaths?.[0] ?? extras?.dataUrls?.[0] ?? rawUrls[0] ?? null,
    urls: [...rawUrls],
    ...(extras?.assetIds?.length ? { assetIds: extras.assetIds } : {}),
    ...(extras?.assetPaths?.length ? { assetPaths: extras.assetPaths } : {}),
    ...(extras?.dataUrls?.length ? { dataUrls: extras.dataUrls } : {}),
    ...(snapshot.errorCode ? { errorCode: snapshot.errorCode } : {}),
    ...(snapshot.errorMessage ? { errorMessage: snapshot.errorMessage } : {}),
    createdAt: snapshot.createdAt,
  };
}

/** Wires `PageAppMediaGateway` to Moss's live `MossMediaJobsService` + credential resolver. */
export function makeMossMediaGateway(deps: {
  readonly service: Pick<MossMediaJobsService, "catalog" | "create" | "check" | "readAsset">;
  readonly resolveCredential: () => Promise<MossMediaCredential>;
  readonly store?: Pick<PageAppExtensionStore, "insertAsset">;
  readonly now?: () => string;
}): PageAppMediaGateway {
  const now = deps.now ?? (() => new Date().toISOString());

  const materializeOutputs = async (
    appId: string,
    viewerId: string,
    snapshot: HoolaCanvasJobSnapshot,
    credential: MossMediaCredential,
  ): Promise<PageAppMediaJobResult> => {
    if (snapshot.status !== "succeeded" || !snapshot.assets?.length) {
      return toResult(snapshot);
    }
    const assetIds: string[] = [];
    const assetPaths: string[] = [];
    const dataUrls: string[] = [];
    for (const item of snapshot.assets) {
      try {
        const { asset, bytes } = await deps.service.readAsset(
          snapshot.jobId,
          item.index,
          credential,
        );
        if (bytes.byteLength <= MAX_INLINE_DATA_URL_BYTES) {
          dataUrls.push(
            `data:${asset.contentType};base64,${Buffer.from(bytes).toString("base64")}`,
          );
        }
        if (deps.store && bytes.byteLength <= PAGE_APP_ASSET_MAX_BYTES) {
          const assetId = randomUUID();
          const ext = asset.contentType.split("/")[1] || "bin";
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          await Effect.runPromise(
            deps.store.insertAsset(
              {
                id: assetId,
                appId,
                name: sanitizeAssetName(`${snapshot.jobId}-${item.index}.${ext}`),
                mimeType: asset.contentType as PageAppAssetType,
                size: bytes.byteLength,
                sha256,
                createdBy: viewerId,
                createdAt: now(),
              },
              bytes,
            ),
          );
          assetIds.push(assetId);
          assetPaths.push(`${PAGE_APP_ASSET_PATH}/${assetId}`);
        }
      } catch {
        // Keep remote URLs / remaining outputs when individual asset materialization fails.
      }
    }
    return toResult(snapshot, { assetIds, assetPaths, dataUrls });
  };

  const waitForCompletion = async (
    jobId: string,
    credential: MossMediaCredential,
    projectId: string,
    waitMs: number,
  ): Promise<HoolaCanvasJobSnapshot> => {
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
    let snapshot = await deps.service.check(jobId, credential, projectId);
    while (
      (snapshot.status === "queued" || snapshot.status === "running") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      snapshot = await deps.service.check(jobId, credential, projectId);
    }
    return snapshot;
  };

  return {
    listModels: async () => {
      try {
        const credential = await deps.resolveCredential();
        const catalog = await deps.service.catalog(credential);
        return catalog.map((item) => ({
          id: item.id,
          label: item.label,
          kind: item.kind,
          available: item.installed && item.available,
        }));
      } catch (error) {
        throw mapMediaError(error);
      }
    },
    generate: async ({ appId, viewerId, kind, args }) => {
      try {
        const credential = await deps.resolveCredential();
        const projectId = `page-app-${appId}`;
        const rawWait =
          typeof args.waitMs === "number" && Number.isFinite(args.waitMs)
            ? args.waitMs
            : kind === "video"
              ? DEFAULT_VIDEO_WAIT_MS
              : DEFAULT_IMAGE_WAIT_MS;
        const created = await deps.service.create(
          {
            ...args,
            projectId,
          },
          credential,
        );
        const settled =
          rawWait > 0
            ? await waitForCompletion(created.jobId, credential, projectId, rawWait)
            : created;
        return materializeOutputs(appId, viewerId, settled, credential);
      } catch (error) {
        throw mapMediaError(error);
      }
    },
    getJob: async ({ appId, jobId }) => {
      try {
        const credential = await deps.resolveCredential();
        const projectId = `page-app-${appId}`;
        const snapshot = await deps.service.check(jobId, credential, projectId);
        return materializeOutputs(appId, "owner", snapshot, credential);
      } catch (error) {
        throw mapMediaError(error);
      }
    },
  };
}

export function makeMediaCapability(deps: {
  readonly media?: PageAppMediaGateway | null;
}): PageAppServerCapability {
  const recent = new Map<string, number[]>();
  const admit = (appId: string) => {
    const now = Date.now();
    const window = (recent.get(appId) ?? []).filter((at) => now - at < 60_000);
    if (window.length >= MAX_PER_MINUTE_PER_APP) {
      throw fail("resource_exhausted", "媒体生成请求过于频繁，请稍后再试。");
    }
    window.push(now);
    recent.set(appId, window);
  };

  const requireGateway = (): PageAppMediaGateway => {
    if (!deps.media) {
      throw fail("unavailable", "当前运行环境尚未接入 Moss 媒体生成服务。");
    }
    return deps.media;
  };

  return {
    name: "media",
    consent: "standing",
    call: (ctx: PageAppServerCallContext, method: string, args: unknown) =>
      Effect.tryPromise({
        try: async () => {
          if (!ctx.viewer.isOwner) {
            throw fail("unavailable", "仅应用页所有者可使用媒体生成能力。");
          }
          const gateway = requireGateway();
          switch (method) {
            case "listModels":
              return gateway.listModels();
            case "generateImage": {
              admit(ctx.app.id);
              const validated = validateGenerateArgs("image", args);
              return gateway.generate({
                appId: ctx.app.id,
                viewerId: ctx.viewer.id,
                kind: "image",
                args: validated,
              });
            }
            case "generateVideo": {
              admit(ctx.app.id);
              const validated = validateGenerateArgs("video", args);
              return gateway.generate({
                appId: ctx.app.id,
                viewerId: ctx.viewer.id,
                kind: "video",
                args: validated,
              });
            }
            case "getJob": {
              const jobId =
                isRecord(args) && typeof args.jobId === "string" ? args.jobId.trim() : "";
              if (!jobId) throw fail("invalid_argument", "getJob 需要提供 jobId。");
              return gateway.getJob({ appId: ctx.app.id, jobId });
            }
            default:
              throw fail("invalid_argument", `media 不支持方法 "${method}"。`);
          }
        },
        catch: (error) => mapMediaError(error),
      }),
  };
}
