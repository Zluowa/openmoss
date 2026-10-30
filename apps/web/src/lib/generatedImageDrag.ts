// FILE: generatedImageDrag.ts
// Purpose: Keep generated-image drag payloads private to the Moss runtime.
// Layer: Web utility

export const GENERATED_IMAGE_DRAG_TYPE = "application/x-codex-image";

interface GeneratedImageDragPayload {
  readonly dragId: string;
  readonly filename: string;
}

interface ActiveGeneratedImageDrag extends GeneratedImageDragPayload {
  readonly src: string;
}

let activeGeneratedImageDrag: ActiveGeneratedImageDrag | null = null;

export function setGeneratedImageDragData(
  dataTransfer: DataTransfer,
  input: { readonly src: string; readonly imageNumber: number },
): boolean {
  activeGeneratedImageDrag = null;
  try {
    dataTransfer.clearData();
  } catch {
    return false;
  }

  const src = input.src.trim();
  if (!src || !Number.isSafeInteger(input.imageNumber) || input.imageNumber < 1) {
    return false;
  }

  const dragId = createDragId();
  if (!dragId) return false;
  const payload: GeneratedImageDragPayload = {
    dragId,
    filename: `generated-image-${input.imageNumber}`,
  };

  try {
    dataTransfer.effectAllowed = "copy";
    dataTransfer.setData(GENERATED_IMAGE_DRAG_TYPE, JSON.stringify(payload));
  } catch {
    activeGeneratedImageDrag = null;
    try {
      dataTransfer.clearData();
    } catch {
      // The transfer is already failed closed when clearing is unavailable.
    }
    return false;
  }

  activeGeneratedImageDrag = { ...payload, src };
  if (typeof window !== "undefined") {
    window.addEventListener(
      "dragend",
      () => {
        if (activeGeneratedImageDrag?.dragId === dragId) {
          activeGeneratedImageDrag = null;
        }
      },
      { once: true },
    );
  }
  return true;
}

export function hasGeneratedImageDrag(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  try {
    return Array.from(dataTransfer?.types ?? []).includes(GENERATED_IMAGE_DRAG_TYPE);
  } catch {
    return false;
  }
}

export async function consumeGeneratedImageDrag(
  dataTransfer: Pick<DataTransfer, "getData"> | null | undefined,
): Promise<File | null> {
  if (!dataTransfer) return null;

  const payload = readGeneratedImageDragPayload(dataTransfer);
  const active = activeGeneratedImageDrag;
  if (
    !payload ||
    !active ||
    payload.dragId !== active.dragId ||
    payload.filename !== active.filename
  ) {
    return null;
  }

  // Consume the nonce before awaiting the network so a drop can never be replayed.
  activeGeneratedImageDrag = null;
  try {
    const response = await fetch(active.src, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.ok === false) return null;
    const blob = await response.blob();
    const image = imageBlobMetadata(blob);
    if (!image || blob.size <= 0) return null;
    return new File([blob], `${active.filename}.${image.extension}`, {
      type: image.mimeType,
    });
  } catch {
    return null;
  }
}

function createDragId(): string | null {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") return null;
  try {
    const dragId = randomUUID.call(globalThis.crypto);
    return typeof dragId === "string" && dragId.length > 0 ? dragId : null;
  } catch {
    return null;
  }
}

function readGeneratedImageDragPayload(
  dataTransfer: Pick<DataTransfer, "getData">,
): GeneratedImageDragPayload | null {
  let raw: string;
  try {
    raw = dataTransfer.getData(GENERATED_IMAGE_DRAG_TYPE);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("dragId") || !keys.includes("filename")) {
    return null;
  }
  const dragId = parsed.dragId;
  const filename = parsed.filename;
  if (typeof dragId !== "string" || dragId.length === 0) return null;
  if (typeof filename !== "string" || !/^generated-image-[1-9]\d*$/.test(filename)) {
    return null;
  }
  return { dragId, filename };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageBlobMetadata(
  blob: Blob,
): { readonly mimeType: string; readonly extension: string } | null {
  const mimeType = blob.type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith("image/")) return null;
  const subtype = mimeType.slice("image/".length);
  if (!/^[a-z0-9][a-z0-9.+-]*$/.test(subtype)) return null;
  const extension =
    subtype === "jpeg" || subtype === "jpg" ? "jpg" : subtype === "svg+xml" ? "svg" : subtype;
  return { mimeType, extension };
}
