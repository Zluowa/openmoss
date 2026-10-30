// FILE: generatedImageContextMenu.ts
// Purpose: Shared context actions for generated images across transcript and preview surfaces.
// Layer: Web UI helper
// Notes: Image bytes stay behind the authenticated local-image route and the narrow desktop
//        bridges. Callers own the composer callback so an action cannot silently target another
//        thread.

import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_IMPORT_BYTES,
  type ContextMenuItem,
} from "@synara/contracts";
import { isLocalAbsolutePath, isUncPath } from "@synara/shared/path";
import type { MouseEvent } from "react";

import { safeGeneratedImagePreviewDownloadName } from "~/components/chat/generatedImagePreviewControls.logic";
import { toastManager } from "~/components/ui/toast";
import { copyPngBlobToDesktopClipboard } from "~/lib/desktopClipboard";
import { downloadUrlAsBlob } from "~/lib/browserDownload";
import { getRevealInFolderLabel } from "~/lib/fileReferenceContextMenu";
import { buildLocalImageUrl, localImageFileName } from "~/lib/localImageUrls";
import { getNavigatorPlatform, isMacPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import type { TranslationKey } from "~/localization";

export const GENERATED_IMAGE_CONTEXT_ACTION_IDS = {
  addToChat: "add-to-chat",
  copyImage: "copy-image",
  showInFileManager: "open-in-file-manager",
  downloadCopy: "download-a-copy",
} as const;

export type GeneratedImageContextAction =
  (typeof GENERATED_IMAGE_CONTEXT_ACTION_IDS)[keyof typeof GENERATED_IMAGE_CONTEXT_ACTION_IDS];

export const GENERATED_IMAGE_CONTEXT_MAX_IMPORT_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_IMPORT_BYTES;
export const GENERATED_IMAGE_CONTEXT_MAX_CLIPBOARD_BYTES = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

export interface GeneratedImageContextImage {
  readonly src: string;
  readonly cwd?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly downloadName?: string | null | undefined;
}

export type GeneratedImageContextMenuHandler = (
  image: GeneratedImageContextImage,
  event: MouseEvent<HTMLElement>,
) => void;

const generatedImageContextMenuOwners = new Map<string, Set<GeneratedImageContextMenuHandler>>();

/** Registers an owning thread's composer callback for right-dock previews. */
export function registerGeneratedImageContextMenuOwner(
  threadId: string,
  handler: GeneratedImageContextMenuHandler,
): () => void {
  const owners = generatedImageContextMenuOwners.get(threadId) ?? new Set();
  owners.add(handler);
  generatedImageContextMenuOwners.set(threadId, owners);
  return () => {
    const current = generatedImageContextMenuOwners.get(threadId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) generatedImageContextMenuOwners.delete(threadId);
  };
}

export function resolveGeneratedImageContextMenuOwner(
  threadId: string | null | undefined,
): GeneratedImageContextMenuHandler | undefined {
  if (!threadId) return undefined;
  return generatedImageContextMenuOwners.get(threadId)?.values().next().value;
}

export interface GeneratedImageContextLabels {
  readonly addToChat: string;
  readonly copyImage: string;
  readonly showInFileManager: string;
  readonly downloadCopy: string;
  readonly addToChatError: string;
  readonly copyError: string;
  readonly showInFileManagerError: string;
  readonly downloadError: string;
}

export interface GeneratedImageContextMenuInput {
  readonly image: GeneratedImageContextImage;
  readonly position: { readonly x: number; readonly y: number };
  readonly labels: GeneratedImageContextLabels;
  /** The owning ChatView supplies its existing intake queue, never a global active-chat lookup. */
  readonly onAddToChat?: ((file: File) => void | Promise<void>) | undefined;
  /** Focus callback from the owning ChatView composer. */
  readonly onFocusComposer?: (() => void) | undefined;
  /** Account-scoped media assets use their own authenticated route. */
  readonly resolveImageUrl?:
    | ((image: GeneratedImageContextImage, download?: boolean) => string)
    | undefined;
  readonly fetchCredentials?: RequestCredentials | undefined;
  readonly isCurrent?: (() => boolean) | undefined;
  readonly allowBrowserClipboard?: boolean | undefined;
  readonly additionalActions?:
    | readonly {
        readonly id: string;
        readonly label: string;
        readonly errorLabel: string;
        readonly onSelect: () => void | Promise<void>;
      }[]
    | undefined;
}

type GeneratedImageContextMenuItem = ContextMenuItem<GeneratedImageContextAction>;

function desktopBridge(): Window["desktopBridge"] | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

function hasDesktopClipboardWriter(): boolean {
  return typeof desktopBridge()?.clipboard?.writeImagePngDataUrl === "function";
}

function hasBrowserImageClipboard(): boolean {
  return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

function hasDesktopFileManager(): boolean {
  const bridge = desktopBridge();
  return (
    typeof bridge?.shell?.showInFolder === "function" || typeof bridge?.showInFolder === "function"
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.slice(1).every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function hasLocalDesktopBackend(): boolean {
  const bridge = desktopBridge();
  const getWsUrl = bridge?.getWsUrl;
  if (typeof getWsUrl !== "function") return false;

  let rawUrl: string | null;
  try {
    rawUrl = getWsUrl();
  } catch {
    return false;
  }
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) return false;

  try {
    const wsUrl = new URL(rawUrl.trim());
    if (
      (wsUrl.protocol !== "ws:" && wsUrl.protocol !== "wss:") ||
      !isLoopbackHostname(wsUrl.hostname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Finder is intentionally stricter than image loading: an absolute path is
 * revealable only when the renderer is attached to the local desktop backend
 * that serves the authenticated image route. Remote desktop backends,
 * protocol-like paths, UNC paths, and browser-only execution fail closed.
 */
export function isGeneratedImageFinderEligible(
  input: string | Pick<GeneratedImageContextImage, "src" | "cwd">,
): boolean {
  const src = typeof input === "string" ? input : input.src;
  const trimmed = src.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("//") ||
    isUncPath(trimmed) ||
    !isLocalAbsolutePath(trimmed)
  ) {
    return false;
  }

  // The generated-image surfaces only expose this action after the image has
  // loaded through Moss's authenticated local-image route. Pair that loaded
  // absolute source with a verified loopback desktop backend; a remote or
  // browser-only backend therefore cannot reveal a path in the local Finder.
  return hasLocalDesktopBackend();
}

export function isGeneratedImageContextCopyEligible(): boolean {
  return hasDesktopClipboardWriter();
}

export function resolveGeneratedImageContextMenuItems(
  input: Pick<GeneratedImageContextMenuInput, "image" | "labels" | "allowBrowserClipboard">,
): readonly GeneratedImageContextMenuItem[] {
  const items: GeneratedImageContextMenuItem[] = [
    {
      id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat,
      label: input.labels.addToChat,
    },
  ];

  if (hasDesktopClipboardWriter() || (input.allowBrowserClipboard && hasBrowserImageClipboard())) {
    items.push({
      id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage,
      label: input.labels.copyImage,
    });
  }

  if (hasDesktopFileManager() && isGeneratedImageFinderEligible(input.image)) {
    items.push({
      id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.showInFileManager,
      label: input.labels.showInFileManager,
    });
  }

  items.push({
    id: GENERATED_IMAGE_CONTEXT_ACTION_IDS.downloadCopy,
    label: input.labels.downloadCopy,
  });
  return items;
}

function imageMimeTypeFromPath(pathValue: string): string | null {
  const extension = pathValue
    .trim()
    .split(/[\\/.]/)
    .pop()
    ?.toLowerCase();
  switch (extension) {
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
    case "svgz":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

function normalizedMimeType(value: string | null | undefined): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function imageName(input: GeneratedImageContextImage): string {
  const explicit = input.downloadName?.trim() || input.name?.trim();
  const sourceName = localImageFileName(input.src).trim();
  return safeGeneratedImagePreviewDownloadName(explicit || sourceName);
}

function imageFileName(input: GeneratedImageContextImage, mimeType: string): string {
  const name = imageName(input);
  if (/\.[a-z\d]{2,5}$/i.test(name)) return name;
  const extension = mimeType === "image/svg+xml" ? "svg" : (mimeType.split("/")[1] ?? "png");
  return `${name}.${extension.replace(/[^a-z\d]+/gi, "") || "png"}`;
}

function generatedImageUrl(input: GeneratedImageContextImage): string {
  return buildLocalImageUrl({ src: input.src, cwd: input.cwd ?? undefined });
}

async function readResponseBlobBounded(response: Response, maxBytes: number): Promise<Blob> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("The generated image is too large to import safely.");
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("The generated image response was invalid.");
        }
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("The generated image is too large to import safely.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    if (total === 0) throw new Error("The generated image response was empty.");
    return new Blob(chunks as BlobPart[], {
      type: normalizedMimeType(response.headers.get("content-type")),
    });
  }

  const blob = await response.blob();
  if (blob.size === 0) throw new Error("The generated image response was empty.");
  if (blob.size > maxBytes) throw new Error("The generated image is too large to import safely.");
  return blob;
}

async function fetchGeneratedImageBlob(
  input: GeneratedImageContextImage,
  url = generatedImageUrl(input),
  credentials?: RequestCredentials,
): Promise<Blob> {
  const response = credentials ? await fetch(url, { credentials }) : await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load generated image (HTTP ${response.status}).`);
  }
  return readResponseBlobBounded(response, GENERATED_IMAGE_CONTEXT_MAX_IMPORT_BYTES);
}

function resolveImageMimeType(blob: Blob, source: GeneratedImageContextImage): string {
  const responseType = normalizedMimeType(blob.type);
  const pathType = imageMimeTypeFromPath(source.src);
  const mimeType = responseType || pathType || "";
  if (!mimeType.startsWith("image/")) {
    throw new Error("The generated image response was not an image.");
  }
  return mimeType;
}

async function fetchGeneratedImageFile(
  input: GeneratedImageContextImage,
  url?: string,
  credentials?: RequestCredentials,
): Promise<File> {
  const blob = await fetchGeneratedImageBlob(input, url, credentials);
  const mimeType = resolveImageMimeType(blob, input);
  return new File([blob], imageFileName(input, mimeType), { type: mimeType });
}

export function readGeneratedImageContextFile(
  input: Pick<GeneratedImageContextMenuInput, "image" | "resolveImageUrl" | "fetchCredentials">,
): Promise<File> {
  return fetchGeneratedImageFile(
    input.image,
    input.resolveImageUrl?.(input.image),
    input.fetchCredentials,
  );
}

interface DecodedImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly release: () => void;
}

const MAX_DECODE_EDGE = 16_384;
const MAX_DECODE_PIXELS = 64_000_000;

function validateDecodedImage(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_DECODE_EDGE ||
    height > MAX_DECODE_EDGE ||
    width * height > MAX_DECODE_PIXELS
  ) {
    throw new Error("The generated image has too many pixels to copy safely.");
  }
}

function loadImageElement(blob: Blob): Promise<DecodedImage> {
  if (
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return Promise.reject(new Error("Image decoding is unavailable in this browser."));
  }
  const objectUrl = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const release = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      try {
        validateDecodedImage(width, height);
      } catch (error) {
        release();
        reject(error);
        return;
      }
      resolve({ source: image, width, height, release });
    };
    image.onerror = () => {
      release();
      reject(new Error("The generated image could not be decoded."));
    };
    image.src = objectUrl;
  });
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        validateDecodedImage(bitmap.width, bitmap.height);
      } catch (error) {
        bitmap.close();
        throw error;
      }
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch (error) {
      try {
        return await loadImageElement(blob);
      } catch {
        throw error instanceof Error
          ? error
          : new Error("The generated image could not be decoded.");
      }
    }
  }
  return loadImageElement(blob);
}

function encodeClipboardPngInWorker(bitmap: ImageBitmap): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./generatedImageClipboard.worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = (blob: Blob | null) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(blob);
    };
    const timeout = setTimeout(() => finish(null), 30_000);
    worker.addEventListener(
      "message",
      ({ data }) => {
        finish(data?.ok === true && data.blob instanceof Blob ? data.blob : null);
      },
      { once: true },
    );
    worker.addEventListener("error", () => finish(null), { once: true });
    worker.addEventListener("messageerror", () => finish(null), { once: true });
    try {
      worker.postMessage(bitmap, [bitmap]);
    } catch (error) {
      clearTimeout(timeout);
      worker.terminate();
      reject(error);
    }
  });
}

export async function normalizeImageToPng(blob: Blob): Promise<Blob> {
  if (blob.size <= 0 || blob.size > GENERATED_IMAGE_CONTEXT_MAX_CLIPBOARD_BYTES) {
    throw new Error("The generated image is too large or empty to copy.");
  }
  const decoded = await decodeImage(blob);
  try {
    let png: Blob | null;
    if (
      typeof Worker === "function" &&
      typeof OffscreenCanvas === "function" &&
      typeof ImageBitmap === "function" &&
      decoded.source instanceof ImageBitmap
    ) {
      // Chromium schedules renderer PNG toBlob work during idle periods, which
      // can delay Copy image behind ongoing animations. Worker encoding keeps
      // the exact decoded dimensions/pixels without depending on renderer idle.
      png = await encodeClipboardPngInWorker(decoded.source);
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image copying is unavailable in this browser.");
      context.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
      png = await new Promise<Blob | null>((resolve) => {
        try {
          canvas.toBlob(resolve, "image/png");
        } catch {
          resolve(null);
        }
      });
      canvas.width = 0;
      canvas.height = 0;
    }
    if (!png || png.size <= 0 || normalizedMimeType(png.type) !== "image/png") {
      throw new Error("The generated image could not be encoded as PNG.");
    }
    if (png.size > GENERATED_IMAGE_CONTEXT_MAX_CLIPBOARD_BYTES) {
      throw new Error("The generated image is too large to copy.");
    }
    return png;
  } finally {
    decoded.release();
  }
}

function showContextActionError(title: string, error: unknown): void {
  toastManager.add({
    type: "error",
    title,
    ...(error instanceof Error && error.message.trim().length > 0
      ? { description: error.message }
      : {}),
  });
}

export async function showGeneratedImageContextMenu(
  input: GeneratedImageContextMenuInput,
): Promise<void> {
  const api = readNativeApi();
  if (!api) return;

  const isCurrent = () => input.isCurrent?.() !== false;
  if (!isCurrent()) return;
  let clicked: string | null;
  try {
    clicked = await api.contextMenu.show(
      [
        ...resolveGeneratedImageContextMenuItems(input),
        ...(input.additionalActions ?? []).map(({ id, label }) => ({ id, label })),
      ],
      input.position,
    );
  } catch {
    return;
  }
  if (!isCurrent()) return;
  const additionalAction = input.additionalActions?.find((action) => action.id === clicked);
  if (additionalAction) {
    try {
      await additionalAction.onSelect();
    } catch (error) {
      showContextActionError(additionalAction.errorLabel, error);
    }
    return;
  }
  if (clicked === GENERATED_IMAGE_CONTEXT_ACTION_IDS.addToChat) {
    try {
      const file = await readGeneratedImageContextFile(input);
      if (!isCurrent()) return;
      if (!input.onAddToChat) throw new Error("The owning chat composer is unavailable.");
      await input.onAddToChat(file);
      input.onFocusComposer?.();
    } catch (error) {
      showContextActionError(input.labels.addToChatError, error);
    }
    return;
  }

  if (clicked === GENERATED_IMAGE_CONTEXT_ACTION_IDS.copyImage) {
    try {
      const useDesktopClipboard = hasDesktopClipboardWriter();
      if (!useDesktopClipboard && !(input.allowBrowserClipboard && hasBrowserImageClipboard()))
        throw new Error("Image copying is unavailable.");
      const blob = await fetchGeneratedImageBlob(
        input.image,
        input.resolveImageUrl?.(input.image),
        input.fetchCredentials,
      );
      const png = await normalizeImageToPng(blob);
      if (!isCurrent()) return;
      if (!useDesktopClipboard) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      } else {
        const copied = await copyPngBlobToDesktopClipboard(png, isCurrent);
        if (!isCurrent()) return;
        if (!copied) throw new Error("The desktop clipboard rejected the image.");
      }
    } catch (error) {
      if (isCurrent()) showContextActionError(input.labels.copyError, error);
    }
    return;
  }

  if (clicked === GENERATED_IMAGE_CONTEXT_ACTION_IDS.showInFileManager) {
    try {
      const pathValue = input.image.src.trim();
      if (!isGeneratedImageFinderEligible(input.image)) {
        throw new Error("The generated image path is not a local absolute path.");
      }
      const bridge = desktopBridge();
      const showInFolder = bridge?.shell?.showInFolder ?? bridge?.showInFolder;
      if (typeof showInFolder !== "function") {
        throw new Error("The desktop file manager is unavailable.");
      }
      await showInFolder(pathValue);
    } catch (error) {
      showContextActionError(input.labels.showInFileManagerError, error);
    }
    return;
  }

  if (clicked === GENERATED_IMAGE_CONTEXT_ACTION_IDS.downloadCopy) {
    try {
      await downloadUrlAsBlob({
        url:
          input.resolveImageUrl?.(input.image, true) ??
          buildLocalImageUrl({
            src: input.image.src,
            cwd: input.image.cwd ?? undefined,
            download: true,
          }),
        filename: imageName(input.image),
        ...(input.fetchCredentials ? { credentials: input.fetchCredentials } : {}),
        ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
      });
    } catch (error) {
      showContextActionError(input.labels.downloadError, error);
    }
  }
}

export function generatedImageContextMenuLabels(
  t: (key: TranslationKey) => string,
): GeneratedImageContextLabels {
  const platform = getNavigatorPlatform();
  return {
    addToChat: t("chat.generatedImage.contextMenu.addToChat"),
    copyImage: t("chat.generatedImage.contextMenu.copyImage"),
    showInFileManager: isMacPlatform(platform)
      ? "Show in Finder"
      : getRevealInFolderLabel(platform),
    downloadCopy: t("chat.generatedImage.contextMenu.downloadCopy"),
    addToChatError: t("chat.generatedImage.contextMenu.addToChatError"),
    copyError: t("chat.generatedImage.contextMenu.copyError"),
    showInFileManagerError: t("chat.generatedImage.contextMenu.showInFileManagerError"),
    downloadError: t("chat.generatedImage.contextMenu.downloadError"),
  };
}
