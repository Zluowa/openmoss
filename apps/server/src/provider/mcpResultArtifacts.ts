import { Buffer } from "node:buffer";
import { statSync } from "node:fs";

import { Effect, Exit, Option } from "effect";

import {
  attachmentPrincipalForProviderRuntime,
  type ManagedAttachmentPrincipal,
} from "../managedAttachmentPrincipal.ts";
import {
  ManagedAttachmentStoreError,
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "../managedAttachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import type {
  ManagedAttachmentBlob,
  ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";

export const MCP_RESULT_ARTIFACT_LIMITS = {
  maxBlockBytes: 10 * 1024 * 1024,
  maxAggregateBytes: 20 * 1024 * 1024,
  maxBlocks: 4,
} as const;

export interface McpResultArtifactLimits {
  readonly maxBlockBytes: number;
  readonly maxAggregateBytes: number;
  readonly maxBlocks: number;
}

export interface McpImageResultCandidate {
  readonly blockIndex: number;
  readonly type: "image";
  readonly mimeType: string;
  readonly data: string;
}

type SupportedMcpArtifactMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "audio/mpeg"
  | "audio/wav"
  | "audio/ogg"
  | "audio/webm"
  | "audio/mp4";

export interface McpAudioResultCandidate {
  readonly blockIndex: number;
  readonly type: "audio";
  readonly mimeType: string;
  readonly data: string;
}

export interface McpBlobResultCandidate {
  readonly blockIndex: number;
  readonly type: "blob";
  readonly mimeType?: string;
  readonly data?: string;
}

export type McpResultArtifactCandidate =
  | McpImageResultCandidate
  | McpAudioResultCandidate
  | McpBlobResultCandidate;

export interface McpResultArtifactStore {
  readonly attachmentsDir: string;
  readonly repository: ManagedAttachmentRepositoryShape;
}

export type McpResultArtifactDeferredReason =
  | "invalid-block-index"
  | "invalid-reference"
  | "invalid-mime"
  | "unsupported-mime"
  | "invalid-base64"
  | "empty-binary"
  | "mime-signature-mismatch"
  | "block-size-limit"
  | "aggregate-size-limit"
  | "block-count-limit"
  | "quota-exceeded"
  | "storage-failed"
  | "claim-rejected"
  | "artifact-unavailable";

export type McpResultArtifact =
  | {
      readonly blockIndex: number;
      readonly mediaKind: "image" | "audio";
      readonly state: "available";
      readonly attachmentId: string;
      readonly name: string;
      readonly mimeType: SupportedMcpArtifactMimeType;
      readonly sizeBytes: number;
      readonly sha256: string;
    }
  | {
      readonly blockIndex: number;
      readonly mediaKind: "image" | "audio" | "blob";
      readonly state: "deferred";
      readonly reason: McpResultArtifactDeferredReason;
      readonly mimeType?: string;
    };

export interface MaterializeMcpResultArtifactsInput {
  readonly threadId: string;
  readonly callId: string;
  readonly candidates: ReadonlyArray<McpResultArtifactCandidate>;
  readonly store: McpResultArtifactStore;
  readonly now: string;
  readonly limits?: Partial<McpResultArtifactLimits>;
}

type DecodedCandidate = {
  readonly candidate: McpImageResultCandidate | McpAudioResultCandidate;
  readonly mimeType: SupportedMcpArtifactMimeType;
  readonly bytes: Uint8Array;
};

type PreflightCandidate = {
  readonly candidate: McpImageResultCandidate | McpAudioResultCandidate;
  readonly mimeType: SupportedMcpArtifactMimeType;
  readonly encodedByteLength: number;
};

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ATTACHMENT_ID_PATTERN = /^att_v2_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function normalizeMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 100 && MIME_PATTERN.test(normalized) ? normalized : null;
}

function isSupportedMcpArtifactMimeType(
  value: string,
  mediaKind: "image" | "audio",
): value is SupportedMcpArtifactMimeType {
  return mediaKind === "image"
    ? value === "image/png" ||
        value === "image/jpeg" ||
        value === "image/webp" ||
        value === "image/gif"
    : value === "audio/mpeg" ||
        value === "audio/wav" ||
        value === "audio/ogg" ||
        value === "audio/webm" ||
        value === "audio/mp4";
}

function deferred(
  candidate: McpResultArtifactCandidate,
  reason: McpResultArtifactDeferredReason,
  mimeType?: string | null,
): McpResultArtifact {
  const normalizedMime = mimeType ?? normalizeMimeType(candidate.mimeType);
  return {
    blockIndex: Number.isSafeInteger(candidate.blockIndex) ? candidate.blockIndex : -1,
    mediaKind: candidate.type,
    state: "deferred",
    reason,
    ...(normalizedMime ? { mimeType: normalizedMime } : {}),
  };
}

function sameBytes(bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function asciiBytes(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function matchesSignature(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case "image/png":
      return sameBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return sameBytes(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return sameBytes(bytes, asciiBytes("RIFF")) && sameBytes(bytes, asciiBytes("WEBP"), 8);
    case "image/gif":
      return sameBytes(bytes, asciiBytes("GIF87a")) || sameBytes(bytes, asciiBytes("GIF89a"));
    case "audio/mpeg":
      return (
        sameBytes(bytes, asciiBytes("ID3")) ||
        (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
      );
    case "audio/wav":
      return sameBytes(bytes, asciiBytes("RIFF")) && sameBytes(bytes, asciiBytes("WAVE"), 8);
    case "audio/ogg":
      return sameBytes(bytes, asciiBytes("OggS"));
    case "audio/webm":
      return sameBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/mp4":
      return sameBytes(bytes, asciiBytes("ftyp"), 4);
    default:
      return false;
  }
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "m4a";
    default:
      return "bin";
  }
}

function decodeStrictBase64(
  data: unknown,
):
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: "deferred"; readonly reason: "invalid-base64" | "empty-binary" } {
  if (typeof data !== "string" || data.length === 0) {
    return { status: "deferred", reason: "empty-binary" };
  }
  if (!BASE64_PATTERN.test(data)) {
    return { status: "deferred", reason: "invalid-base64" };
  }
  const bytes = Uint8Array.from(Buffer.from(data, "base64"));
  if (bytes.byteLength === 0) {
    return { status: "deferred", reason: "empty-binary" };
  }
  if (Buffer.from(bytes).toString("base64") !== data) {
    return { status: "deferred", reason: "invalid-base64" };
  }
  return { status: "ok", bytes };
}

function encodedByteLength(
  data: unknown,
):
  | { readonly status: "ok"; readonly bytes: number }
  | { readonly status: "deferred"; readonly reason: "invalid-base64" | "empty-binary" } {
  if (typeof data !== "string" || data.length === 0) {
    return { status: "deferred", reason: "empty-binary" };
  }
  if (!BASE64_PATTERN.test(data)) {
    return { status: "deferred", reason: "invalid-base64" };
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = (data.length / 4) * 3 - padding;
  return bytes > 0 ? { status: "ok", bytes } : { status: "deferred", reason: "empty-binary" };
}

function preflightCandidate(
  candidate: McpResultArtifactCandidate,
): PreflightCandidate | McpResultArtifact {
  if (!Number.isSafeInteger(candidate.blockIndex) || candidate.blockIndex < 0) {
    return deferred(candidate, "invalid-block-index");
  }
  if (candidate.type === "blob") {
    return deferred(candidate, "unsupported-mime");
  }
  const mimeType = normalizeMimeType(candidate.mimeType);
  if (!mimeType) return deferred(candidate, "invalid-mime");
  if (!isSupportedMcpArtifactMimeType(mimeType, candidate.type)) {
    return deferred(candidate, "unsupported-mime", mimeType);
  }
  const decoded = encodedByteLength(candidate.data);
  if (decoded.status === "deferred") return deferred(candidate, decoded.reason, mimeType);
  return { candidate, mimeType, encodedByteLength: decoded.bytes };
}

function decodeCandidate(preflight: PreflightCandidate): DecodedCandidate | McpResultArtifact {
  const { candidate, mimeType } = preflight;
  const decoded = decodeStrictBase64(candidate.data);
  if (decoded.status === "deferred") return deferred(candidate, decoded.reason, mimeType);
  if (!matchesSignature(mimeType, decoded.bytes)) {
    return deferred(candidate, "mime-signature-mismatch", mimeType);
  }
  return { candidate, mimeType, bytes: decoded.bytes };
}

function deferredReasonForStorageFailure(error: unknown): McpResultArtifactDeferredReason {
  return error instanceof ManagedAttachmentStoreError && error.code === "attachment_quota_exceeded"
    ? "quota-exceeded"
    : "storage-failed";
}

function availableFromAttachment(input: {
  readonly candidate: McpImageResultCandidate | McpAudioResultCandidate;
  readonly attachment: ManagedAttachmentBlob;
  readonly attachmentsDir: string;
}): McpResultArtifact {
  const attachmentMimeType = normalizeMimeType(input.attachment.mimeType);
  const safeNameValue = input.attachment.originalName.trim();
  const safeName =
    safeNameValue.length > 0 &&
    safeNameValue.length <= 255 &&
    !safeNameValue.includes("\0") &&
    !safeNameValue.includes("\r") &&
    !safeNameValue.includes("\n") &&
    !safeNameValue.includes("/") &&
    !safeNameValue.includes("\\");
  const safeMetadata =
    ATTACHMENT_ID_PATTERN.test(input.attachment.attachmentId) &&
    SHA256_PATTERN.test(input.attachment.sha256 ?? "") &&
    safeName &&
    attachmentMimeType !== null &&
    input.attachment.sizeBytes !== null &&
    input.attachment.sizeBytes > 0 &&
    input.attachment.sizeBytes <= MCP_RESULT_ARTIFACT_LIMITS.maxBlockBytes &&
    isSupportedMcpArtifactMimeType(attachmentMimeType ?? "", input.candidate.type) &&
    attachmentMimeType === normalizeMimeType(input.candidate.mimeType);
  const storagePath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: input.attachment.relativePath,
  });
  const hasDurableBytes =
    input.attachment.sizeBytes !== null &&
    storagePath !== null &&
    (() => {
      try {
        const stat = statSync(storagePath);
        return stat.isFile() && stat.size === input.attachment.sizeBytes;
      } catch {
        return false;
      }
    })();
  if (
    !safeMetadata ||
    !hasDurableBytes ||
    (input.candidate.type === "image" && input.attachment.kind !== "image") ||
    (input.candidate.type === "audio" && input.attachment.kind !== "file")
  ) {
    return deferred(
      input.candidate,
      hasDurableBytes ? "claim-rejected" : "artifact-unavailable",
      input.attachment.mimeType,
    );
  }
  return {
    blockIndex: input.candidate.blockIndex,
    mediaKind: input.candidate.type,
    state: "available",
    attachmentId: input.attachment.attachmentId,
    name: safeNameValue,
    mimeType: attachmentMimeType as SupportedMcpArtifactMimeType,
    sizeBytes: input.attachment.sizeBytes!,
    sha256: input.attachment.sha256!,
  };
}

function materializeOne(input: {
  readonly threadId: string;
  readonly callId: string;
  readonly now: string;
  readonly store: McpResultArtifactStore;
  readonly principal: ManagedAttachmentPrincipal;
  readonly decoded: DecodedCandidate;
}): Effect.Effect<McpResultArtifact> {
  let reservation: ManagedAttachmentBlob | null = null;
  const { candidate, mimeType, bytes } = input.decoded;
  const safeName = `mcp-block-${candidate.blockIndex}.${extensionFor(mimeType)}`;

  const cleanupReservation = (reason: McpResultArtifactDeferredReason) => {
    const cleanup = reservation
      ? input.store.repository
          .cancelStaged({
            attachmentId: reservation.attachmentId,
            ownerKind: input.principal.ownerKind,
            ownerId: input.principal.ownerId,
            reason: `mcp-${reason}`,
            requestedAt: input.now,
          })
          .pipe(Effect.ignore)
      : Effect.void;
    return cleanup.pipe(Effect.as(deferred(candidate, reason, mimeType)));
  };

  return Effect.gen(function* () {
    const reserved = yield* reserveManagedAttachmentUpload({
      type: candidate.type === "image" ? "image" : "file",
      threadId: input.threadId,
      name: safeName,
      mimeType,
      reservedBytes: bytes.byteLength,
      now: input.now,
      principal: input.principal,
      repository: input.store.repository,
    });
    reservation = reserved;
    yield* persistReservedManagedAttachment({
      reservation,
      bytes,
      attachmentsDir: input.store.attachmentsDir,
      now: input.now,
      principal: input.principal,
      repository: input.store.repository,
    });
    const claimed = yield* input.store.repository.claimOrReuseMcpBlock({
      attachmentId: reservation.attachmentId,
      ownerThreadId: input.threadId,
      ownerKind: input.principal.ownerKind,
      ownerId: input.principal.ownerId,
      callId: input.callId,
      blockIndex: candidate.blockIndex,
      now: input.now,
    });
    if (claimed.status === "rejected") {
      return yield* cleanupReservation("claim-rejected");
    }
    return availableFromAttachment({
      candidate,
      attachment: claimed.attachment,
      attachmentsDir: input.store.attachmentsDir,
    });
  }).pipe(Effect.catch((error) => cleanupReservation(deferredReasonForStorageFailure(error))));
}

export function materializeMcpResultArtifacts(
  input: MaterializeMcpResultArtifactsInput,
): Effect.Effect<ReadonlyArray<McpResultArtifact>> {
  const limits: McpResultArtifactLimits = {
    ...MCP_RESULT_ARTIFACT_LIMITS,
    ...input.limits,
  };
  const principal = attachmentPrincipalForProviderRuntime();
  return Effect.gen(function* () {
    const results: McpResultArtifact[] = [];
    let aggregateBytes = 0;
    let materializedBlocks = 0;
    for (const candidate of input.candidates) {
      if (input.threadId.length === 0 || input.callId.length === 0) {
        results.push(deferred(candidate, "invalid-reference"));
        continue;
      }
      if (candidate.type !== "blob" && Number.isSafeInteger(candidate.blockIndex)) {
        const existingClaim = yield* Effect.exit(
          input.store.repository.findClaimedMcpBlock({
            ownerThreadId: input.threadId,
            ownerKind: principal.ownerKind,
            ownerId: principal.ownerId,
            callId: input.callId,
            blockIndex: candidate.blockIndex,
          }),
        );
        if (Exit.isFailure(existingClaim)) {
          results.push(deferred(candidate, "storage-failed"));
          continue;
        }
        const existing = Option.getOrNull(existingClaim.value);
        if (existing) {
          results.push(
            availableFromAttachment({
              candidate,
              attachment: existing,
              attachmentsDir: input.store.attachmentsDir,
            }),
          );
          continue;
        }
      }

      const preflight = preflightCandidate(candidate);
      if ("state" in preflight) {
        results.push(preflight);
        continue;
      }
      if (materializedBlocks >= limits.maxBlocks) {
        results.push(deferred(candidate, "block-count-limit", preflight.mimeType));
        continue;
      }
      if (preflight.encodedByteLength > limits.maxBlockBytes) {
        results.push(deferred(candidate, "block-size-limit", preflight.mimeType));
        continue;
      }
      if (aggregateBytes + preflight.encodedByteLength > limits.maxAggregateBytes) {
        results.push(deferred(candidate, "aggregate-size-limit", preflight.mimeType));
        continue;
      }
      const decoded = decodeCandidate(preflight);
      if ("state" in decoded) {
        results.push(decoded);
        continue;
      }
      materializedBlocks += 1;
      aggregateBytes += decoded.bytes.byteLength;
      results.push(
        yield* materializeOne({
          threadId: input.threadId,
          callId: input.callId,
          now: input.now,
          store: input.store,
          principal,
          decoded,
        }),
      );
    }
    return results;
  });
}

/**
 * Preserve an eligible MCP block as an explicit deferred result when no local
 * materializer is available (or when the ingress fallback cannot carry source
 * bytes). This intentionally exposes only the bounded reason and block index;
 * the candidate's source string never crosses the durable projection boundary.
 */
export function deferMcpResultArtifacts(
  candidates: ReadonlyArray<McpResultArtifactCandidate>,
  reason: McpResultArtifactDeferredReason = "artifact-unavailable",
): ReadonlyArray<McpResultArtifact> {
  return candidates.map((candidate) => deferred(candidate, reason));
}
