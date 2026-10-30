import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

import {
  COMPUTER_HISTORY_QUOTA_BYTES,
  COMPUTER_HISTORY_RETENTION_DAYS,
  type ComputerHistoryObservation,
  type ComputerHistorySemanticSummary,
} from "@synara/contracts";

const RECORD_VERSION = 2;
const RECORD_ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
export const COMPUTER_HISTORY_MAX_BUNDLE_IDENTIFIER_LENGTH = 200;
export const COMPUTER_HISTORY_MAX_APPLICATION_NAME_LENGTH = 160;
export const COMPUTER_HISTORY_MAX_WINDOW_TITLE_LENGTH = 500;
export const COMPUTER_HISTORY_MAX_ACTIVITY_TEXT_LENGTH = 12_000;
export const COMPUTER_HISTORY_MAX_SEMANTIC_TITLE_LENGTH = 120;
export const COMPUTER_HISTORY_MAX_SEMANTIC_DESCRIPTION_LENGTH = 400;
const REDACTED_ACTIVITY_MARKER = "[redacted activity]";
export const COMPUTER_HISTORY_RETENTION_MS = COMPUTER_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
/** The audit stream has an explicit separate budget; health reports both files together. */
export const COMPUTER_HISTORY_AUDIT_QUOTA_BYTES = 16 * 1024 * 1024;

export interface ComputerHistoryKeyProvider {
  readonly getOrCreateKey: () => Promise<Buffer>;
  readonly destroyKey?: () => Promise<void>;
}

export interface EncryptedHistoryRecord {
  readonly seq: number;
  readonly observation: ComputerHistoryObservation;
}

interface CipherRecord {
  readonly version: 2;
  readonly algorithm: typeof RECORD_ALGORITHM;
  readonly seq: number;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function assertKey(key: Buffer): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new Error("Computer History key has an invalid size.");
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value: unknown, maxLength: number, required = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length > maxLength || (required && normalized.length === 0)) return undefined;
  return normalized;
}

const SEMANTIC_URL_PATTERN =
  /\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+|\b[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,}(?:[/:]\S*)?/iu;
const SEMANTIC_PATH_PATTERN =
  /(?:^|[\s(])(?:~\/|\/(?:Users|private|var|tmp|Volumes|Applications|home|root|opt|srv|run|System|Library)\/|[A-Za-z]:[\\/])/u;
const SEMANTIC_SECRET_PATTERN =
  /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b|\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_-]{8,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b|\bAKIA[0-9A-Z]{8,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9+/=_\-.]{8,}\b|\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|token|password|passwd|secret|credential|key)\s*[:=]/iu;
const SEMANTIC_EMAIL_PATTERN = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/iu;
const SEMANTIC_IP_PATTERN =
  /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9A-F]{1,4}:){2,7}[0-9A-F]{1,4}\b/iu;
const SEMANTIC_IDENTIFIER_PATTERN = /\b[0-9a-f]{32,}\b|\b[A-Za-z0-9_-]{32,}\b/iu;
const SEMANTIC_COMMAND_PATTERN =
  /`[^`]+`|(?:^|[\s(])(?:sudo|curl|wget|rm|chmod|chown|git|npm|bun|python|bash|zsh)\s+|&&|\|\|/iu;
const SEMANTIC_PROMPT_INJECTION_PATTERN =
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b|\b(?:system|developer)\s+prompt\b|\bdo\s+not\s+follow\b/iu;

function semanticTextIsUnsafe(value: string): boolean {
  return (
    SEMANTIC_URL_PATTERN.test(value) ||
    SEMANTIC_PATH_PATTERN.test(value) ||
    SEMANTIC_SECRET_PATTERN.test(value) ||
    SEMANTIC_EMAIL_PATTERN.test(value) ||
    SEMANTIC_IP_PATTERN.test(value) ||
    SEMANTIC_IDENTIFIER_PATTERN.test(value) ||
    SEMANTIC_COMMAND_PATTERN.test(value) ||
    SEMANTIC_PROMPT_INJECTION_PATTERN.test(value)
  );
}

function normalizeSemanticText(value: unknown, maxLength: number): string | undefined {
  const normalized = safeText(value, maxLength, true);
  if (!normalized || semanticTextIsUnsafe(normalized)) return undefined;
  return normalized;
}

/** Normalize the only model-generated fields allowed into an observation. */
export function normalizeComputerHistorySemanticSummary(
  value: unknown,
): ComputerHistorySemanticSummary {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["title", "description", "source"]) ||
    value.source !== "apple_on_device"
  ) {
    throw new Error("Computer History semantic summary contains unknown fields.");
  }
  const title = normalizeSemanticText(value.title, COMPUTER_HISTORY_MAX_SEMANTIC_TITLE_LENGTH);
  const description = normalizeSemanticText(
    value.description,
    COMPUTER_HISTORY_MAX_SEMANTIC_DESCRIPTION_LENGTH,
  );
  if (!title || !description) {
    throw new Error("Computer History semantic summary is unsafe or out of bounds.");
  }
  return { title, description, source: "apple_on_device" };
}

/** Validate and rebuild the exact shape allowed into encrypted persistence. */
export function normalizeComputerHistoryObservation(value: unknown): ComputerHistoryObservation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["capturedAtMs", "app", "window", "activityText", "semanticSummary"])
  ) {
    throw new Error("Computer History observation contains unknown fields.");
  }
  const capturedAtMs = value.capturedAtMs;
  if (typeof capturedAtMs !== "number" || !Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) {
    throw new Error("Computer History observation timestamp is invalid.");
  }
  if (!isRecord(value.app) || !hasOnlyKeys(value.app, ["bundleIdentifier", "name"])) {
    throw new Error("Computer History observation application is invalid.");
  }
  const bundleIdentifier = safeText(
    value.app.bundleIdentifier,
    COMPUTER_HISTORY_MAX_BUNDLE_IDENTIFIER_LENGTH,
    true,
  );
  const applicationName = safeText(
    value.app.name,
    COMPUTER_HISTORY_MAX_APPLICATION_NAME_LENGTH,
    true,
  );
  if (
    !bundleIdentifier ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/u.test(bundleIdentifier) ||
    !applicationName
  ) {
    throw new Error("Computer History observation application is out of bounds.");
  }
  if (!isRecord(value.window) || !hasOnlyKeys(value.window, ["title"])) {
    throw new Error("Computer History observation window is invalid.");
  }
  const windowTitle =
    value.window.title === undefined
      ? undefined
      : safeText(value.window.title, COMPUTER_HISTORY_MAX_WINDOW_TITLE_LENGTH);
  if (value.window.title !== undefined && windowTitle === undefined) {
    throw new Error("Computer History observation window title is out of bounds.");
  }
  const activityText =
    value.activityText === undefined
      ? undefined
      : safeText(value.activityText, COMPUTER_HISTORY_MAX_ACTIVITY_TEXT_LENGTH);
  if (value.activityText !== undefined && activityText === undefined) {
    throw new Error("Computer History observation activity text is out of bounds.");
  }
  const semanticSummary =
    value.semanticSummary === undefined
      ? undefined
      : normalizeComputerHistorySemanticSummary(value.semanticSummary);
  if (activityText !== undefined && semanticSummary !== undefined) {
    throw new Error("Computer History activity text and semantic summary are mutually exclusive.");
  }
  return {
    capturedAtMs,
    app: {
      bundleIdentifier,
      name: applicationName,
    },
    window: windowTitle === undefined ? {} : { title: windowTitle },
    ...(activityText === undefined ? {} : { activityText: REDACTED_ACTIVITY_MARKER }),
    ...(semanticSummary === undefined ? {} : { semanticSummary }),
  };
}

function encodeRecord(record: EncryptedHistoryRecord, key: Buffer): CipherRecord {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(RECORD_ALGORITHM, key, nonce, {
    authTagLength: 16,
  });
  const aad = Buffer.from(`${RECORD_ALGORITHM}:${RECORD_VERSION}:${record.seq}`, "utf8");
  cipher.setAAD(aad);
  const plaintext = Buffer.from(
    JSON.stringify(normalizeComputerHistoryObservation(record.observation)),
    "utf8",
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: RECORD_VERSION,
    algorithm: RECORD_ALGORITHM,
    seq: record.seq,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decodeRecord(value: unknown, key: Buffer, expectedSeq: number): EncryptedHistoryRecord {
  if (value === null || typeof value !== "object") throw new Error("Invalid history record.");
  const record = value as Partial<CipherRecord>;
  if (
    record.version !== RECORD_VERSION ||
    record.algorithm !== RECORD_ALGORITHM ||
    !Number.isSafeInteger(record.seq) ||
    record.seq !== expectedSeq ||
    typeof record.nonce !== "string" ||
    typeof record.tag !== "string" ||
    typeof record.ciphertext !== "string"
  ) {
    throw new Error("Computer History sequence or record metadata is invalid.");
  }
  const decipher = createDecipheriv(RECORD_ALGORITHM, key, Buffer.from(record.nonce, "base64url"), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(`${RECORD_ALGORITHM}:${RECORD_VERSION}:${record.seq}`, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64url")),
    decipher.final(),
  ]);
  const observation = normalizeComputerHistoryObservation(JSON.parse(plaintext.toString("utf8")));
  return { seq: record.seq, observation };
}

/**
 * Authenticated, sequenced local store. The store intentionally has no
 * plaintext fallback: an unavailable key or a malformed/reordered record
 * makes reads fail closed and leaves the ciphertext untouched for recovery.
 */
export class EncryptedComputerHistoryStore {
  readonly eventsPath: string;
  private key: Buffer | null = null;
  private records: EncryptedHistoryRecord[] = [];
  private loaded = false;
  private corruptionDetected = false;

  constructor(
    private readonly rootDir: string,
    private readonly keyProvider: ComputerHistoryKeyProvider,
  ) {
    this.eventsPath = join(rootDir, "events.moss-history");
  }

  get isCorrupt(): boolean {
    return this.corruptionDetected;
  }

  get loadedRecords(): readonly EncryptedHistoryRecord[] {
    return this.records;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.loaded = false;
      throw error;
    }
    try {
      this.key = assertKey(await this.keyProvider.getOrCreateKey());
      const records: EncryptedHistoryRecord[] = [];
      let expectedSeq = 1;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        records.push(decodeRecord(JSON.parse(line), this.key, expectedSeq));
        expectedSeq += 1;
      }
      this.records = records;
    } catch (error) {
      this.corruptionDetected = true;
      this.records = [];
      throw new Error(`Computer History is unavailable: ${String(error)}`);
    }
  }

  /** Refresh an already-open view so separate read-only gateway instances do not go stale. */
  async reload(): Promise<void> {
    this.loaded = false;
    this.records = [];
    this.corruptionDetected = false;
    await this.load();
  }

  async ensureKey(): Promise<void> {
    this.key = assertKey(await this.keyProvider.getOrCreateKey());
  }

  async append(observation: ComputerHistoryObservation): Promise<EncryptedHistoryRecord> {
    if (this.corruptionDetected) {
      throw new Error("Computer History is corrupt and cannot accept new records.");
    }
    await this.load();
    const normalizedObservation = normalizeComputerHistoryObservation(observation);
    if (!this.key) await this.ensureKey();
    const key = this.key;
    if (!key) throw new Error("Computer History encryption key is unavailable.");
    const record: EncryptedHistoryRecord = {
      seq: (this.records.at(-1)?.seq ?? 0) + 1,
      observation: normalizedObservation,
    };
    const encoded = encodeRecord(record, key);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(encoded)}\n`;
    const currentBytes = await this.sizeBytes();
    if (currentBytes + Buffer.byteLength(line) > COMPUTER_HISTORY_QUOTA_BYTES) {
      throw new Error("Computer History storage quota reached.");
    }
    await appendFile(this.eventsPath, line, { mode: 0o600 });
    this.records.push(record);
    return record;
  }

  async replace(records: readonly EncryptedHistoryRecord[]): Promise<void> {
    if (this.corruptionDetected) {
      throw new Error("Computer History is corrupt and cannot be rewritten.");
    }
    await this.load();
    if (!this.key) await this.ensureKey();
    const key = this.key;
    if (!key) throw new Error("Computer History encryption key is unavailable.");
    const normalized = records.map((record, index) => ({ ...record, seq: index + 1 }));
    const body = normalized.map((record) => JSON.stringify(encodeRecord(record, key))).join("\n");
    if (Buffer.byteLength(body, "utf8") > COMPUTER_HISTORY_QUOTA_BYTES) {
      throw new Error("Computer History storage quota reached.");
    }
    if (body.length > 0) {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.eventsPath}.tmp-${process.pid}`;
      await writeFile(temporaryPath, `${body}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.eventsPath);
    } else {
      await unlink(this.eventsPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    this.records = normalized;
  }

  async clear(): Promise<void> {
    this.records = [];
    this.corruptionDetected = false;
    await unlink(this.eventsPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await stat(this.eventsPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  async prune(nowMs: number): Promise<number> {
    await this.load();
    const threshold = nowMs - COMPUTER_HISTORY_RETENTION_MS;
    const kept = this.records.filter((record) => record.observation.capturedAtMs >= threshold);
    const deleted = this.records.length - kept.length;
    if (deleted > 0) await this.replace(kept);
    return deleted;
  }
}

export interface EncryptedHistoryAuditRecord {
  readonly seq: number;
  readonly atMs: number;
  readonly tool: "history_status" | "history_query";
  readonly callerThreadId: string;
  readonly callerProvider: string;
  readonly resultCount?: number;
}

function encodeAuditRecord(record: EncryptedHistoryAuditRecord, key: Buffer): CipherRecord {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(RECORD_ALGORITHM, key, nonce, {
    authTagLength: 16,
  });
  const aad = Buffer.from(`${RECORD_ALGORITHM}:${RECORD_VERSION}:${record.seq}`, "utf8");
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(record), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: RECORD_VERSION,
    algorithm: RECORD_ALGORITHM,
    seq: record.seq,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decodeAuditRecord(
  value: unknown,
  key: Buffer,
  expectedSeq: number,
): EncryptedHistoryAuditRecord {
  if (value === null || typeof value !== "object") throw new Error("Invalid history audit record.");
  const record = value as Partial<CipherRecord>;
  if (
    record.version !== RECORD_VERSION ||
    record.algorithm !== RECORD_ALGORITHM ||
    !Number.isSafeInteger(record.seq) ||
    record.seq !== expectedSeq ||
    typeof record.nonce !== "string" ||
    typeof record.tag !== "string" ||
    typeof record.ciphertext !== "string"
  ) {
    throw new Error("Computer History audit sequence or record metadata is invalid.");
  }
  const decipher = createDecipheriv(RECORD_ALGORITHM, key, Buffer.from(record.nonce, "base64url"), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(`${RECORD_ALGORITHM}:${RECORD_VERSION}:${record.seq}`, "utf8"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64url")),
    decipher.final(),
  ]);
  const audit = JSON.parse(plaintext.toString("utf8")) as Partial<EncryptedHistoryAuditRecord>;
  const atMs = audit.atMs;
  if (
    !audit ||
    typeof audit !== "object" ||
    !Number.isFinite(atMs) ||
    (audit.tool !== "history_status" && audit.tool !== "history_query") ||
    typeof audit.callerThreadId !== "string" ||
    typeof audit.callerProvider !== "string" ||
    (audit.resultCount !== undefined &&
      (!Number.isSafeInteger(audit.resultCount) || audit.resultCount < 0))
  ) {
    throw new Error("Computer History audit payload is invalid.");
  }
  return {
    seq: record.seq,
    atMs: atMs as number,
    tool: audit.tool,
    callerThreadId: audit.callerThreadId,
    callerProvider: audit.callerProvider,
    ...(audit.resultCount === undefined ? {} : { resultCount: audit.resultCount }),
  };
}

/**
 * Authenticated audit stream for read access. It uses the same Keychain key
 * and is intentionally separate from user-facing observation queries.
 */
export class EncryptedComputerHistoryAuditStore {
  readonly auditPath: string;
  private key: Buffer | null = null;
  private records: EncryptedHistoryAuditRecord[] = [];
  private loaded = false;
  private corruptionDetected = false;

  constructor(
    private readonly rootDir: string,
    private readonly keyProvider: ComputerHistoryKeyProvider,
  ) {
    this.auditPath = join(rootDir, "access-audit.moss-history");
  }

  get isCorrupt(): boolean {
    return this.corruptionDetected;
  }

  /** Internal authenticated view used for retention tests and reload checks. */
  get loadedRecords(): readonly EncryptedHistoryAuditRecord[] {
    return this.records;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.auditPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.loaded = false;
      throw error;
    }
    try {
      this.key = assertKey(await this.keyProvider.getOrCreateKey());
      const records: EncryptedHistoryAuditRecord[] = [];
      let expectedSeq = 1;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        records.push(decodeAuditRecord(JSON.parse(line), this.key, expectedSeq));
        expectedSeq += 1;
      }
      this.records = records;
    } catch (error) {
      this.corruptionDetected = true;
      this.records = [];
      throw new Error(`Computer History audit is unavailable: ${String(error)}`);
    }
  }

  async reload(): Promise<void> {
    this.loaded = false;
    this.records = [];
    this.corruptionDetected = false;
    await this.load();
  }

  async append(
    record: Omit<EncryptedHistoryAuditRecord, "seq">,
  ): Promise<EncryptedHistoryAuditRecord> {
    if (this.corruptionDetected) {
      throw new Error("Computer History audit is corrupt and cannot accept new records.");
    }
    await this.load();
    if (!this.key) this.key = assertKey(await this.keyProvider.getOrCreateKey());
    const encodedRecord: EncryptedHistoryAuditRecord = {
      ...record,
      seq: (this.records.at(-1)?.seq ?? 0) + 1,
    };
    const encoded = encodeAuditRecord(encodedRecord, this.key);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(encoded)}\n`;
    const currentBytes = await this.sizeBytes();
    if (currentBytes + Buffer.byteLength(line) > COMPUTER_HISTORY_AUDIT_QUOTA_BYTES) {
      throw new Error("Computer History audit storage quota reached.");
    }
    await appendFile(this.auditPath, line, { mode: 0o600 });
    this.records.push(encodedRecord);
    return encodedRecord;
  }

  async replace(records: readonly EncryptedHistoryAuditRecord[]): Promise<void> {
    if (this.corruptionDetected) {
      throw new Error("Computer History audit is corrupt and cannot be rewritten.");
    }
    await this.load();
    if (!this.key) this.key = assertKey(await this.keyProvider.getOrCreateKey());
    const key = this.key;
    const normalized = records.map((record, index) => ({ ...record, seq: index + 1 }));
    const body = normalized
      .map((record) => JSON.stringify(encodeAuditRecord(record, key)))
      .join("\n");
    if (Buffer.byteLength(body, "utf8") > COMPUTER_HISTORY_AUDIT_QUOTA_BYTES) {
      throw new Error("Computer History audit storage quota reached.");
    }
    if (body.length > 0) {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.auditPath}.tmp-${process.pid}`;
      await writeFile(temporaryPath, `${body}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.auditPath);
    } else {
      await unlink(this.auditPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    this.records = normalized;
  }

  async prune(nowMs: number): Promise<number> {
    await this.load();
    const threshold = nowMs - COMPUTER_HISTORY_RETENTION_MS;
    const kept = this.records.filter((record) => record.atMs >= threshold);
    const deleted = this.records.length - kept.length;
    if (deleted > 0) await this.replace(kept);
    return deleted;
  }

  async clear(): Promise<void> {
    this.records = [];
    this.corruptionDetected = false;
    await unlink(this.auditPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await stat(this.auditPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
}

export function createTestHistoryKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function historyKeyFromBytes(bytes: Uint8Array): Buffer {
  return assertKey(Buffer.from(bytes));
}
