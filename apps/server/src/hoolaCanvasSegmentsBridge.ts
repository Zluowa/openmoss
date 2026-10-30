// FILE: hoolaCanvasSegmentsBridge.ts
// Purpose: Persist Hoola Segments receipts while Moss owns account authority.

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { HoolaCanvasAuthorityCredential } from "./hoolaCanvasBridge";

const SEGMENTS_MODEL_ID = "grok-segments-v1";
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_INLINE_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024;
const MAX_JOBS = 64;
const MAX_STRING_CHARS = 4_096;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const JOB_ID_PATTERN = /^seg_[A-Za-z0-9_-]{16,96}$/u;

interface SegmentIdentity {
  readonly imageUrl: string;
  readonly assetId: string;
  readonly projectId: string;
  readonly sourcePageId: string;
}

interface SegmentObject {
  readonly id: string;
  readonly name: string;
  readonly boxXyxy: readonly [number, number, number, number];
  readonly maskRle: {
    readonly size: readonly [number, number];
    readonly counts: string | readonly number[];
  };
  readonly [key: string]: unknown;
}

interface SceneMap {
  readonly assetId: string;
  readonly imageUrl: string;
  readonly width: number;
  readonly height: number;
  readonly objects: readonly SegmentObject[];
  readonly decodeCacheKey: Readonly<Record<string, unknown>>;
  readonly stage: "masks_ready";
  readonly [key: string]: unknown;
}

interface SegmentRecord {
  readonly jobId: string;
  readonly accountKey: string;
  readonly identity: SegmentIdentity;
  readonly idempotencyKey: string;
  readonly createdAt: number;
  updatedAt: number;
  status: "queued" | "running" | "masks_ready" | "failed";
  sceneMap?: SceneMap;
  errorCode?: string;
}

export interface HoolaCanvasSegmentsBridgeOptions {
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly statePath?: string;
}

export class HoolaCanvasSegmentsBridgeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "HoolaCanvasSegmentsBridgeError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = MAX_STRING_CHARS): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 && normalized.length <= maximum ? normalized : "";
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeJwtSubject(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const subject = boundedString(payload?.sub, 256);
    return subject && /^[A-Za-z0-9._:@-]+$/u.test(subject) ? subject : null;
  } catch {
    return null;
  }
}

function accountKey(credential: HoolaCanvasAuthorityCredential): string {
  const subject = safeJwtSubject(credential.accessToken);
  return stableHash(`${credential.realm}\0${subject ?? stableHash(credential.accessToken)}`);
}

function normalizeIdentity(value: unknown): SegmentIdentity {
  if (!isRecord(value)) throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_INVALID_REQUEST");
  const imageUrl = boundedString(value.imageUrl);
  const assetId = boundedString(value.assetId, 256);
  const projectId = boundedString(value.projectId, 256);
  const sourcePageId = boundedString(value.sourcePageId ?? value.pageId, 256);
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_INVALID_REQUEST");
  }
  const publicHttps = parsed.protocol === "https:" && !parsed.username && !parsed.password;
  const localCanvasAsset =
    parsed.protocol === "hoola-local:" &&
    parsed.hostname === "asset" &&
    parsed.pathname.length > 1 &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash;
  if ((!publicHttps && !localCanvasAsset) || !assetId || !projectId || !sourcePageId)
    throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_OWNER_REQUIRED");
  return { imageUrl: parsed.toString(), assetId, projectId, sourcePageId };
}

function normalizeInlineImageDataUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_INLINE_IMAGE_DATA_URL_CHARS ||
    !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_SOURCE_INVALID");
  }
  return value;
}

function identityKey(account: string, identity: SegmentIdentity): string {
  return stableHash(
    [account, identity.projectId, identity.sourcePageId, identity.assetId, identity.imageUrl].join(
      "\0",
    ),
  );
}

function sameIdentity(left: SegmentIdentity, right: SegmentIdentity): boolean {
  return (
    left.imageUrl === right.imageUrl &&
    left.assetId === right.assetId &&
    left.projectId === right.projectId &&
    left.sourcePageId === right.sourcePageId
  );
}

function safeCode(value: unknown, fallback: string): string {
  const code = boundedString(value, 80).toUpperCase();
  return /^[A-Z0-9_.-]+$/u.test(code) ? code : fallback;
}

function normalizeBox(value: unknown): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
  }
  const box = value.map(Number);
  if (box.some((item) => !Number.isFinite(item)) || box[2]! <= box[0]! || box[3]! <= box[1]!) {
    throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
  }
  return box as [number, number, number, number];
}

function normalizeMask(value: unknown): SegmentObject["maskRle"] {
  if (!isRecord(value) || !Array.isArray(value.size) || value.size.length !== 2) {
    throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
  }
  const height = Number(value.size[0]);
  const width = Number(value.size[1]);
  if (
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(width) ||
    height <= 0 ||
    width <= 0 ||
    height * width > 16_777_216 ||
    !(typeof value.counts === "string" || Array.isArray(value.counts))
  )
    throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
  if (typeof value.counts === "string") {
    if (!value.counts || value.counts.length > 4_000_000) {
      throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
    }
    return { size: [height, width], counts: value.counts };
  }
  const counts = value.counts.map(Number);
  if (
    counts.length === 0 ||
    counts.length > 1_000_000 ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 0)
  )
    throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
  return { size: [height, width], counts };
}

function normalizeSceneMap(value: unknown, identity: SegmentIdentity): SceneMap {
  if (!isRecord(value) || !Array.isArray(value.objects)) {
    throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
  }
  const width = Number(value.width);
  const height = Number(value.height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 16_777_216 ||
    value.objects.length === 0 ||
    value.objects.length > 128 ||
    boundedString(value.assetId, 256) !== identity.assetId ||
    boundedString(value.imageUrl) !== identity.imageUrl ||
    !isRecord(value.decodeCacheKey)
  )
    throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
  const ids = new Set<string>();
  const objects = value.objects.map((raw): SegmentObject => {
    if (!isRecord(raw)) throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
    const id = boundedString(raw.id, 128);
    const name = boundedString(raw.name, 80);
    if (!id || ids.has(id) || !name) {
      throw new HoolaCanvasSegmentsBridgeError(502, "SEGMENTS_RESPONSE_INVALID");
    }
    ids.add(id);
    return {
      ...raw,
      id,
      name,
      boxXyxy: normalizeBox(raw.boxXyxy),
      maskRle: normalizeMask(raw.maskRle),
      maskState: "ready",
    };
  });
  return {
    ...value,
    assetId: identity.assetId,
    imageUrl: identity.imageUrl,
    width,
    height,
    objects,
    decodeCacheKey: value.decodeCacheKey,
    stage: "masks_ready",
  } as SceneMap;
}

function sceneIndex(record: SegmentRecord): Readonly<Record<string, unknown>> {
  if (!record.sceneMap) throw new HoolaCanvasSegmentsBridgeError(404, "SEGMENTS_NOT_CACHED");
  return {
    ...record.sceneMap,
    jobId: record.jobId,
    stage: "masks_ready",
    objects: record.sceneMap.objects.map(({ maskRle: _maskRle, ...object }) => ({
      ...object,
      maskState: "ready",
      maskRef: { segmentId: object.id, jobId: record.jobId },
    })),
  };
}

function gatewayRoot(credential: HoolaCanvasAuthorityCredential): string {
  return credential.gatewayBaseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

export class HoolaCanvasSegmentsBridgeBroker {
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #now: () => number;
  readonly #statePath: string | undefined;
  readonly #jobs = new Map<string, SegmentRecord>();
  readonly #cache = new Map<string, string>();
  readonly #idempotency = new Map<string, string>();

  constructor(options: HoolaCanvasSegmentsBridgeOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#statePath = options.statePath;
    this.#restore();
  }

  #restore(): void {
    if (!this.#statePath) return;
    try {
      const info = statSync(this.#statePath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_STATE_BYTES) return;
      const parsed = JSON.parse(readFileSync(this.#statePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) return;
      for (const raw of parsed.jobs.slice(-MAX_JOBS)) {
        if (!isRecord(raw) || !isRecord(raw.identity)) continue;
        const identity = normalizeIdentity(raw.identity);
        const jobId = boundedString(raw.jobId, 128);
        const account = boundedString(raw.accountKey, 128);
        const idempotencyKey = boundedString(raw.idempotencyKey, 192);
        const status = boundedString(raw.status, 32);
        if (
          !JOB_ID_PATTERN.test(jobId) ||
          !/^[0-9a-f]{64}$/u.test(account) ||
          !OPERATION_ID_PATTERN.test(idempotencyKey) ||
          !["queued", "running", "masks_ready", "failed"].includes(status)
        )
          continue;
        const record: SegmentRecord = {
          jobId,
          accountKey: account,
          identity,
          idempotencyKey,
          createdAt: Number(raw.createdAt) || this.#now(),
          updatedAt: Number(raw.updatedAt) || this.#now(),
          status: status as SegmentRecord["status"],
        };
        if (raw.sceneMap) record.sceneMap = normalizeSceneMap(raw.sceneMap, identity);
        const errorCode = safeCode(raw.errorCode, "");
        if (errorCode) record.errorCode = errorCode;
        this.#jobs.set(jobId, record);
        this.#idempotency.set(`${account}\0${idempotencyKey}`, jobId);
        if (record.sceneMap) this.#cache.set(identityKey(account, identity), jobId);
      }
    } catch {
      // Corrupt local state is a cache miss and never starts provider work.
    }
  }

  #persist(): void {
    if (!this.#statePath) return;
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    const payload = `${JSON.stringify({ version: 1, jobs: [...this.#jobs.values()] })}\n`;
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) return;
    try {
      mkdirSync(dirname(this.#statePath), { recursive: true, mode: 0o700 });
      try {
        unlinkSync(temporaryPath);
      } catch {
        // No stale temporary file.
      }
      writeFileSync(temporaryPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.#statePath);
    } catch {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best effort only; the in-memory receipt remains available.
      }
    }
  }

  authorize(
    raw: unknown,
    credential: HoolaCanvasAuthorityCredential,
  ): Readonly<Record<string, unknown>> {
    if (!isRecord(raw) || raw.createPath !== "/api/segments" || raw.cachedOnly !== false) {
      throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_AUTHORIZATION_INVALID");
    }
    const identity = normalizeIdentity(raw);
    const idempotencyKey = boundedString(raw.idempotencyKey, 192);
    if (
      !OPERATION_ID_PATTERN.test(idempotencyKey) ||
      raw.modelId !== SEGMENTS_MODEL_ID ||
      raw.provider !== "gemini-replicate-sam3"
    )
      throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_AUTHORIZATION_INVALID");
    return {
      creditOperationId: `moss_segments_${stableHash(
        `${accountKey(credential)}\0${identityKey(accountKey(credential), identity)}\0${idempotencyKey}`,
      ).slice(0, 32)}`,
    };
  }

  cacheOnly(
    raw: unknown,
    credential: HoolaCanvasAuthorityCredential,
  ): Readonly<Record<string, unknown>> {
    if (!isRecord(raw) || raw.cachedOnly !== true) {
      throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_MODE_REQUIRED");
    }
    const identity = normalizeIdentity(raw);
    const jobId = this.#cache.get(identityKey(accountKey(credential), identity));
    const record = jobId ? this.#jobs.get(jobId) : undefined;
    if (!record?.sceneMap) throw new HoolaCanvasSegmentsBridgeError(404, "SEGMENTS_NOT_CACHED");
    return sceneIndex(record);
  }

  async create(
    raw: unknown,
    credential: HoolaCanvasAuthorityCredential,
  ): Promise<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> }> {
    if (!isRecord(raw) || raw.cachedOnly !== false) {
      throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_MODE_REQUIRED");
    }
    const identity = normalizeIdentity(raw);
    const localCanvasSource = identity.imageUrl.startsWith("hoola-local://asset/");
    const imageDataUrl = localCanvasSource
      ? normalizeInlineImageDataUrl(raw.imageDataUrl)
      : undefined;
    if (!localCanvasSource && raw.imageDataUrl !== undefined) {
      throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_SOURCE_INVALID");
    }
    const idempotencyKey = boundedString(raw.idempotencyKey, 192);
    const creditOperationId = boundedString(raw.creditOperationId, 128);
    if (
      !OPERATION_ID_PATTERN.test(idempotencyKey) ||
      !/^moss_segments_[0-9a-f]{32}$/u.test(creditOperationId) ||
      raw.modelId !== SEGMENTS_MODEL_ID
    )
      throw new HoolaCanvasSegmentsBridgeError(400, "SEGMENTS_AUTHORIZATION_INVALID");
    const account = accountKey(credential);
    const cacheId = this.#cache.get(identityKey(account, identity));
    const cached = cacheId ? this.#jobs.get(cacheId) : undefined;
    if (cached?.sceneMap) return { status: 200, body: sceneIndex(cached) };
    const replayId = this.#idempotency.get(`${account}\0${idempotencyKey}`);
    const replay = replayId ? this.#jobs.get(replayId) : undefined;
    if (replay) {
      return {
        status: replay.sceneMap ? 200 : 202,
        body: replay.sceneMap ? sceneIndex(replay) : { jobId: replay.jobId, status: replay.status },
      };
    }
    const response = await this.#fetch(`${gatewayRoot(credential)}/v1/canvas/segments/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": "application/json",
        "x-moss-operation-id": idempotencyKey,
      },
      body: JSON.stringify({
        ...identity,
        ...(imageDataUrl ? { imageDataUrl } : {}),
        modelId: SEGMENTS_MODEL_ID,
        idempotencyKey,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => ({}));
    const recordData = isRecord(data) ? data : {};
    const gatewayError = isRecord(recordData.error) ? recordData.error : recordData;
    const jobId = boundedString(recordData.jobId, 128);
    if (!response.ok || !JOB_ID_PATTERN.test(jobId)) {
      throw new HoolaCanvasSegmentsBridgeError(
        response.status >= 400 && response.status <= 599 ? response.status : 502,
        safeCode(gatewayError.code, "SEGMENTS_PROVIDER_FAILED"),
      );
    }
    while (this.#jobs.size >= MAX_JOBS) {
      const oldest = [...this.#jobs.values()]
        .filter((item) => item.sceneMap || item.status === "failed")
        .toSorted((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) throw new HoolaCanvasSegmentsBridgeError(503, "SEGMENTS_CAPACITY_EXHAUSTED");
      this.#jobs.delete(oldest.jobId);
      this.#cache.delete(identityKey(oldest.accountKey, oldest.identity));
      this.#idempotency.delete(`${oldest.accountKey}\0${oldest.idempotencyKey}`);
    }
    const now = this.#now();
    const record: SegmentRecord = {
      jobId,
      accountKey: account,
      identity,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
      status: recordData.status === "queued" ? "queued" : "running",
    };
    this.#jobs.set(jobId, record);
    this.#idempotency.set(`${account}\0${idempotencyKey}`, jobId);
    this.#persist();
    return { status: 202, body: { jobId, status: record.status } };
  }

  async status(
    jobId: string,
    rawIdentity: unknown,
    credential: HoolaCanvasAuthorityCredential,
  ): Promise<Readonly<Record<string, unknown>>> {
    if (!JOB_ID_PATTERN.test(jobId)) {
      throw new HoolaCanvasSegmentsBridgeError(404, "SEGMENTS_JOB_NOT_FOUND");
    }
    const identity = normalizeIdentity(rawIdentity);
    const record = this.#jobs.get(jobId);
    if (
      !record ||
      record.accountKey !== accountKey(credential) ||
      !sameIdentity(record.identity, identity)
    )
      throw new HoolaCanvasSegmentsBridgeError(404, "SEGMENTS_JOB_NOT_FOUND");
    if (record.sceneMap) {
      return { jobId, status: "masks_ready", sceneMap: sceneIndex(record) };
    }
    if (record.status === "failed") {
      return { jobId, status: "failed", code: record.errorCode ?? "SEGMENTS_PROVIDER_FAILED" };
    }
    const response = await this.#fetch(
      `${gatewayRoot(credential)}/v1/canvas/segments/jobs/${encodeURIComponent(jobId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${credential.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const data = await response.json().catch(() => ({}));
    const payload = isRecord(data) ? data : {};
    const gatewayError = isRecord(payload.error) ? payload.error : payload;
    if (!response.ok) {
      throw new HoolaCanvasSegmentsBridgeError(
        response.status >= 400 && response.status <= 599 ? response.status : 502,
        safeCode(gatewayError.code, "SEGMENTS_STATUS_FAILED"),
      );
    }
    if (payload.status === "failed") {
      record.status = "failed";
      record.errorCode = safeCode(payload.code, "SEGMENTS_PROVIDER_FAILED");
    } else if (payload.sceneMap) {
      record.sceneMap = normalizeSceneMap(payload.sceneMap, identity);
      record.status = "masks_ready";
      this.#cache.set(identityKey(record.accountKey, identity), jobId);
    } else {
      record.status = payload.status === "queued" ? "queued" : "running";
    }
    record.updatedAt = this.#now();
    this.#persist();
    return record.sceneMap
      ? { jobId, status: "masks_ready", sceneMap: sceneIndex(record) }
      : {
          jobId,
          status: record.status,
          ...(record.errorCode ? { code: record.errorCode } : {}),
        };
  }

  mask(
    segmentId: string,
    jobId: string,
    rawIdentity: unknown,
    credential: HoolaCanvasAuthorityCredential,
  ): SegmentObject {
    const identity = normalizeIdentity(rawIdentity);
    const record = this.#jobs.get(jobId);
    if (
      !record ||
      record.accountKey !== accountKey(credential) ||
      !sameIdentity(record.identity, identity)
    )
      throw new HoolaCanvasSegmentsBridgeError(404, "SEGMENTS_JOB_NOT_FOUND");
    if (!record.sceneMap) {
      if (record.status === "failed") {
        throw new HoolaCanvasSegmentsBridgeError(
          502,
          record.errorCode ?? "SEGMENTS_PROVIDER_FAILED",
        );
      }
      throw new HoolaCanvasSegmentsBridgeError(202, "SEGMENTS_MASK_PENDING");
    }
    const object = record.sceneMap.objects.find((candidate) => candidate.id === segmentId);
    if (!object) throw new HoolaCanvasSegmentsBridgeError(404, "SEGMENTS_MASK_NOT_FOUND");
    return object;
  }
}
