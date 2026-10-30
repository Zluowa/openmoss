import { readGeneratedImageContextFile } from "./generatedImageContextMenu";
import { readMossImagesJson } from "./mossImagesClient";
import { MOSS_CANVAS_IMAGE_ASSET, type MossCanvasSelectionItem } from "./mossCanvasSelection";
import { resolveWsHttpUrl } from "./wsHttpUrl";

export interface MossCanvasBinding {
  readonly expectedAccount: { readonly id: string; readonly realm: string };
  readonly expectedWorkspace: { readonly threadId: string; readonly fingerprint: string };
}
export interface MossCanvasLocalImage {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly assetId?: string;
}
export interface MossCanvasImportedImage {
  readonly sourceId: string;
  readonly id: string;
  readonly title: string;
  readonly assetId: string;
}
/** Memory-only cache. The key includes the owner and trusted workspace fingerprint. */
export type MossCanvasImageImportCache = Map<string, MossCanvasImportedImage | null>;

export async function loadMossCanvasBinding(
  threadId: string,
  signal?: AbortSignal,
): Promise<MossCanvasBinding> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) throw new Error("会话的工作文件夹尚未就绪。");
  const value = await readMossImagesJson(
    `/api/moss/media/canvas/account?canvasThread=${encodeURIComponent(threadId)}`,
    { method: "GET", ...(signal ? { signal } : {}) },
  );
  const body = value as {
    authenticated?: boolean;
    user?: { id?: unknown };
    realm?: unknown;
    workspace?: { threadId?: unknown; fingerprint?: unknown };
  } | null;
  if (
    !body ||
    body.authenticated !== true ||
    typeof body.user?.id !== "string" ||
    body.user.id.length < 1 ||
    body.user.id.length > 256 ||
    typeof body.realm !== "string" ||
    body.realm.length < 1 ||
    body.realm.length > 128 ||
    body.workspace?.threadId !== threadId ||
    typeof body.workspace.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(body.workspace.fingerprint)
  )
    throw new Error("画布的会话或账号已变化，请重新打开。");
  return {
    expectedAccount: { id: body.user.id, realm: body.realm },
    expectedWorkspace: { threadId, fingerprint: body.workspace.fingerprint },
  };
}

export function mossCanvasAssetUrl(assetId: string, binding: MossCanvasBinding): string {
  const match = MOSS_CANVAS_IMAGE_ASSET.exec(assetId);
  if (!match) throw new Error("画布图片引用无效。");
  const query = new URLSearchParams({
    canvasThread: binding.expectedWorkspace.threadId,
    canvasWorkspace: binding.expectedWorkspace.fingerprint,
    canvasAccount: binding.expectedAccount.id,
    canvasRealm: binding.expectedAccount.realm,
  });
  return resolveWsHttpUrl(`/api/moss/media/canvas/assets/${match[1]}?${query}`);
}

export function readMossCanvasSelectionFile(
  item: MossCanvasSelectionItem,
  binding: MossCanvasBinding,
): Promise<File> {
  return readGeneratedImageContextFile({
    image: { src: item.assetId, name: item.title || "canvas-image" },
    resolveImageUrl: () => mossCanvasAssetUrl(item.assetId, binding),
    fetchCredentials: "include",
  });
}

/** Import local chat outputs through the existing authenticated image reader and storage API. */
export async function importMossCanvasLocalImages(input: {
  readonly images: readonly MossCanvasLocalImage[];
  readonly cwd?: string;
  readonly binding: MossCanvasBinding;
  readonly isCurrent: () => boolean;
  readonly activeImageId?: string;
  readonly cache?: MossCanvasImageImportCache;
  readonly signal?: AbortSignal;
}) {
  const items: MossCanvasImportedImage[] = [];
  const unavailable: string[] = [];
  const cache = input.cache ?? new Map<string, MossCanvasImportedImage | null>();
  const assertCurrent = () => {
    if (!input.isCurrent() || input.signal?.aborted)
      throw new DOMException("画布已切换。", "AbortError");
  };
  if (input.activeImageId && !input.images.some((image) => image.id === input.activeImageId)) {
    throw new Error("当前选中的图片已不可用，请重新选择。");
  }
  for (const image of input.images) {
    assertCurrent();
    if (image.assetId !== undefined && !MOSS_CANVAS_IMAGE_ASSET.test(image.assetId)) {
      throw new Error("画布图片引用无效。");
    }
    const key = JSON.stringify([
      input.binding.expectedAccount,
      input.binding.expectedWorkspace,
      image.id,
      image.path,
      input.cwd ?? null,
      image.assetId ?? null,
    ]);
    const cached = cache.get(key);
    if (cached) {
      items.push({ ...cached, title: image.name.slice(0, 200) });
      continue;
    }
    if (cached === null && image.id !== input.activeImageId) {
      unavailable.push(image.id);
      continue;
    }
    let file: File;
    let bytes: Uint8Array | null;
    try {
      file = image.assetId
        ? await readMossCanvasSelectionFile(
            { shapeId: "shape:selection", assetId: image.assetId, title: image.name },
            input.binding,
          )
        : await readGeneratedImageContextFile({
            image: { src: image.path, cwd: input.cwd, name: image.name },
          });
      assertCurrent();
      bytes = image.assetId ? null : new Uint8Array(await file.arrayBuffer());
      assertCurrent();
    } catch (cause) {
      assertCurrent();
      // Missing historical files do not invalidate a still-available selected
      // image. Storage/account failures below remain fatal rather than hidden.
      if (!input.activeImageId || image.id === input.activeImageId) {
        throw new Error("当前选中的图片无法读取，请返回会话后重新选择。", { cause });
      }
      cache.set(key, null);
      unavailable.push(image.id);
      continue;
    }
    let assetId = image.assetId;
    if (!assetId && bytes) {
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 8192)
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
      assertCurrent();
      const value = (await readMossImagesJson(
        `/api/moss/media/canvas/storage?canvasThread=${encodeURIComponent(input.binding.expectedWorkspace.threadId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            ...input.binding,
            method: "workspace.importAssetBytes",
            input: { bytesBase64: btoa(chunks.join("")), mimeType: file.type, fileName: file.name },
          }),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      )) as { result?: { url?: unknown } };
      assertCurrent();
      if (typeof value.result?.url !== "string" || !MOSS_CANVAS_IMAGE_ASSET.test(value.result.url))
        throw new Error("图片未能保存到画布。");
      assetId = value.result.url;
    }
    if (!assetId) throw new Error("图片未能保存到画布。");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image.id));
    assertCurrent();
    const id = `image:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const item = { sourceId: image.id, id, title: image.name.slice(0, 200), assetId };
    cache.set(key, item);
    items.push(item);
  }
  return { items, unavailable };
}
