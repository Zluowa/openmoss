import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawnProcess, type RuntimeSpawnOptions } from "@synara/shared/processRuntime";
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, join, sep } from "node:path";

const PROTOCOL_VERSION = 2;
const REQUEST_MAGIC = Buffer.from("MOSSFSRQ", "ascii");
const RESPONSE_MAGIC = Buffer.from("MOSSFSRS", "ascii");
const READY_LINE = "MOSS_CANONICAL_FS_HELPER_READY 2\n";
const MAX_REQUEST_BYTES = 384 * 1024 * 1024;
const MAX_STAGE_BYTES = 256 * 1024 * 1024;
const MAX_STAGE_ENTRIES = 10_000;
const MAX_SEGMENTS = 128;
const MAX_SEGMENT_BYTES = 255;
const MAX_RELATIVE_PATH_BYTES = 4096;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_READY_BYTES = 512;
const DEFAULT_TIMEOUT_MS = 30_000;
const FINGERPRINT_BYTES = 32;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_HELPER_BINARY_BYTES = 8 * 1024 * 1024;

export type MossCanonicalFilesystemHelperAction = "create" | "publish" | "replace" | "remove";
export type MossCanonicalFilesystemEntryKind = "missing" | "file" | "directory";

export interface MossCanonicalFilesystemIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface MossCanonicalFilesystemTargetObservation extends MossCanonicalFilesystemIdentity {
  readonly kind: Exclude<MossCanonicalFilesystemEntryKind, "missing">;
  readonly mode: number;
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
}

export type MossCanonicalFilesystemExpectedTarget =
  | { readonly kind: "missing" }
  | ({ readonly kind: "file" | "directory" } & MossCanonicalFilesystemIdentity);

export type MossCanonicalFilesystemPayload =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly content: Uint8Array }
  | {
      readonly kind: "directory";
      readonly entries: ReadonlyArray<{
        readonly relativePath: string;
        readonly kind: "file" | "directory";
        readonly content?: Uint8Array;
      }>;
    };

export interface MossCanonicalFilesystemHelperInput {
  /** Absolute workspace anchor passed as spawn cwd, never encoded in the protocol. */
  readonly cwd: string;
  readonly action: MossCanonicalFilesystemHelperAction;
  /** Safe segments from the workspace anchor to the canonical root. */
  readonly rootSegments: ReadonlyArray<string>;
  /** Safe segments from the canonical root to the target. */
  readonly targetSegments: ReadonlyArray<string>;
  readonly expectedWorkspace: MossCanonicalFilesystemIdentity;
  readonly expectedRoot: MossCanonicalFilesystemIdentity;
  readonly expectedParent: MossCanonicalFilesystemIdentity;
  readonly expectedTarget: MossCanonicalFilesystemExpectedTarget;
  /** SHA-256 of the target content/tree captured at the CAS boundary. */
  readonly expectedBeforeFingerprint: string;
  /** SHA-256 of the staged content/tree required after the mutation. */
  readonly expectedAfterFingerprint: string;
  readonly expectedAfterKind: MossCanonicalFilesystemEntryKind;
  readonly payload: MossCanonicalFilesystemPayload;
}

export interface MossCanonicalFilesystemHelperResult {
  readonly status: "committed";
  readonly after: MossCanonicalFilesystemTargetObservation | null;
  readonly afterFingerprint: string;
  readonly parent: MossCanonicalFilesystemIdentity;
  readonly rollback: "none" | "restored";
}

export type MossCanonicalFilesystemHelperErrorCode =
  | "durability-unsupported"
  | "recovery-needed"
  | "concurrent-modification"
  | "symlink-escape"
  | "conflict";

export class MossCanonicalFilesystemHelperError extends Error {
  readonly code: MossCanonicalFilesystemHelperErrorCode;

  constructor(code: MossCanonicalFilesystemHelperErrorCode, message: string) {
    super(message);
    this.name = "MossCanonicalFilesystemHelperError";
    this.code = code;
  }
}

export interface MossCanonicalFilesystemHelperOptions {
  readonly helperPath?: string;
  readonly metadataPath?: string;
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: MossCanonicalFilesystemSpawn;
  readonly env?: NodeJS.ProcessEnv;
}

export interface MossCanonicalFilesystemHelper {
  readonly execute: (
    input: MossCanonicalFilesystemHelperInput,
  ) => Promise<MossCanonicalFilesystemHelperResult>;
}

interface MossCanonicalFilesystemSpawn {
  (command: string, args: ReadonlyArray<string>, options: RuntimeSpawnOptions): ChildProcess;
}

interface RawResponse {
  readonly status: number;
  readonly errorCode: number;
  readonly rollback: number;
  readonly after: MossCanonicalFilesystemTargetObservation | null;
  readonly afterFingerprint: string;
  readonly parent: MossCanonicalFilesystemIdentity;
  readonly requestId: string;
}

export const MOSS_CANONICAL_FILESYSTEM_HELPER_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const MOSS_CANONICAL_FILESYSTEM_HELPER_NAME = "moss-canonical-filesystem-helper";

function protocolError(message: string): MossCanonicalFilesystemHelperError {
  return new MossCanonicalFilesystemHelperError("durability-unsupported", message);
}

function recoveryError(message: string): MossCanonicalFilesystemHelperError {
  return new MossCanonicalFilesystemHelperError("recovery-needed", message);
}

function assertSafeSegment(value: string, label: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes === 0 ||
    bytes > MAX_SEGMENT_BYTES ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw protocolError(`${label} contains an unsafe relative segment.`);
  }
}

function assertSafeSegments(
  values: ReadonlyArray<string>,
  label: string,
  allowEmpty: boolean,
): void {
  if (values.length > MAX_SEGMENTS || (!allowEmpty && values.length === 0)) {
    throw protocolError(`${label} exceeds its bounded segment contract.`);
  }
  for (const value of values) assertSafeSegment(value, label);
}

function assertSafeRelativePath(value: string): void {
  if (
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw protocolError("The private stage entry path is not a bounded relative path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw protocolError("The private stage entry path contains traversal segments.");
  }
  for (const segment of segments) assertSafeSegment(segment, "The private stage entry path");
}

function assertIdentity(identity: MossCanonicalFilesystemIdentity, label: string): void {
  if (
    !Number.isSafeInteger(identity.dev) ||
    !Number.isSafeInteger(identity.ino) ||
    identity.dev < 0 ||
    identity.ino < 0
  ) {
    throw protocolError(`${label} identity is not a bounded numeric identity.`);
  }
}

function assertFingerprint(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw protocolError(`${label} must be a lowercase SHA-256 fingerprint.`);
  }
}

function validatePayload(payload: MossCanonicalFilesystemPayload): void {
  if (payload.kind === "missing") return;
  if (payload.kind === "file") {
    if (payload.content.byteLength > MAX_STAGE_BYTES) {
      throw protocolError("The private stage exceeds its byte boundary.");
    }
    return;
  }
  if (payload.entries.length > MAX_STAGE_ENTRIES) {
    throw protocolError("The private stage exceeds its entry boundary.");
  }
  let totalBytes = 0;
  for (const entry of payload.entries) {
    assertSafeRelativePath(entry.relativePath);
    if (entry.kind === "file") {
      if (!entry.content) throw protocolError("A private stage file has no content.");
      totalBytes += entry.content.byteLength;
      if (totalBytes > MAX_STAGE_BYTES) {
        throw protocolError("The private stage exceeds its byte boundary.");
      }
    }
  }
}

function validateInput(input: MossCanonicalFilesystemHelperInput): void {
  if (!isAbsolute(input.cwd) || input.cwd.includes("\0")) {
    throw protocolError("The helper workspace anchor must be an absolute safe path.");
  }
  assertSafeSegments(input.rootSegments, "The canonical root", true);
  assertSafeSegments(input.targetSegments, "The canonical target", false);
  assertIdentity(input.expectedWorkspace, "The workspace");
  assertIdentity(input.expectedRoot, "The canonical root");
  assertIdentity(input.expectedParent, "The canonical parent");
  assertIdentity(
    input.expectedTarget.kind === "missing" ? { dev: 0, ino: 0 } : input.expectedTarget,
    "The target",
  );
  assertFingerprint(input.expectedBeforeFingerprint, "The expected before fingerprint");
  assertFingerprint(input.expectedAfterFingerprint, "The expected after fingerprint");
  if (!Object.hasOwn({ missing: true, file: true, directory: true }, input.expectedAfterKind)) {
    throw protocolError("The expected after-kind is invalid.");
  }
  if (input.action === "remove" && input.payload.kind !== "missing") {
    throw protocolError("Remove operations cannot carry a stage payload.");
  }
  if (input.action !== "remove" && input.payload.kind === "missing") {
    throw protocolError("Mutation operations require a stage payload.");
  }
  validatePayload(input.payload);
}

class BinaryWriter {
  readonly #chunks: Buffer[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  bytes(value: Uint8Array): void {
    const chunk = Buffer.from(value);
    this.#chunks.push(chunk);
    this.#length += chunk.byteLength;
  }

  u8(value: number): void {
    const chunk = Buffer.from([value & 0xff]);
    this.#chunks.push(chunk);
    this.#length += 1;
  }

  u32(value: number): void {
    const chunk = Buffer.allocUnsafe(4);
    chunk.writeUInt32BE(value >>> 0, 0);
    this.#chunks.push(chunk);
    this.#length += 4;
  }

  u64(value: number): void {
    const chunk = Buffer.allocUnsafe(8);
    chunk.writeBigUInt64BE(BigInt(value), 0);
    this.#chunks.push(chunk);
    this.#length += 8;
  }

  string(value: string, maximumBytes: number): void {
    const chunk = Buffer.from(value, "utf8");
    if (chunk.byteLength === 0 || chunk.byteLength > maximumBytes) {
      throw protocolError("A helper protocol string exceeded its boundary.");
    }
    this.u32(chunk.byteLength);
    this.bytes(chunk);
  }

  build(): Buffer {
    if (this.#length > MAX_REQUEST_BYTES) {
      throw protocolError("The helper request exceeded its byte boundary.");
    }
    return Buffer.concat(this.#chunks, this.#length);
  }
}

function writeIdentity(writer: BinaryWriter, identity: MossCanonicalFilesystemIdentity): void {
  writer.u64(identity.dev);
  writer.u64(identity.ino);
}

function writeSegments(writer: BinaryWriter, values: ReadonlyArray<string>): void {
  writer.u32(values.length);
  for (const value of values) writer.string(value, MAX_SEGMENT_BYTES);
}

function writePayload(writer: BinaryWriter, payload: MossCanonicalFilesystemPayload): void {
  const kind = payload.kind === "missing" ? 0 : payload.kind === "file" ? 1 : 2;
  writer.u8(kind);
  writer.bytes(Buffer.alloc(3));
  if (payload.kind === "missing") return;
  if (payload.kind === "file") {
    writer.u64(payload.content.byteLength);
    writer.bytes(payload.content);
    return;
  }
  writer.u32(payload.entries.length);
  for (const entry of payload.entries) {
    writer.string(entry.relativePath, MAX_RELATIVE_PATH_BYTES);
    writer.u8(entry.kind === "file" ? 1 : 2);
    writer.bytes(Buffer.alloc(3));
    if (entry.kind === "file") {
      writer.u64(entry.content!.byteLength);
      writer.bytes(entry.content!);
    }
  }
}

function serializeRequest(input: MossCanonicalFilesystemHelperInput): {
  readonly buffer: Buffer;
  readonly requestId: string;
} {
  const writer = new BinaryWriter();
  writer.bytes(REQUEST_MAGIC);
  writer.u32(PROTOCOL_VERSION);
  writer.u8(
    input.action === "create"
      ? 1
      : input.action === "publish"
        ? 2
        : input.action === "replace"
          ? 3
          : 4,
  );
  writer.bytes(Buffer.alloc(3));
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writer.string(requestId, MAX_REQUEST_ID_BYTES);
  writeSegments(writer, input.rootSegments);
  writeSegments(writer, input.targetSegments);
  writeIdentity(writer, input.expectedWorkspace);
  writeIdentity(writer, input.expectedRoot);
  writeIdentity(writer, input.expectedParent);
  const targetKind =
    input.expectedTarget.kind === "missing" ? 0 : input.expectedTarget.kind === "file" ? 1 : 2;
  writer.u8(targetKind);
  writer.bytes(Buffer.alloc(3));
  if (input.expectedTarget.kind !== "missing") writeIdentity(writer, input.expectedTarget);
  writer.bytes(Buffer.from(input.expectedBeforeFingerprint, "hex"));
  writer.bytes(Buffer.from(input.expectedAfterFingerprint, "hex"));
  writer.u8(input.expectedAfterKind === "missing" ? 0 : input.expectedAfterKind === "file" ? 1 : 2);
  writer.bytes(Buffer.alloc(3));
  writePayload(writer, input.payload);
  return { buffer: writer.build(), requestId };
}

class BinaryReader {
  readonly #bytes: Buffer;
  #offset = 0;

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  bytes(length: number): Buffer {
    if (length < 0 || length > this.remaining)
      throw protocolError("The helper response was truncated.");
    const result = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  u32(): number {
    return this.bytes(4).readUInt32BE(0);
  }

  u64(): number {
    const value = this.bytes(8).readBigUInt64BE(0);
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw protocolError("The helper response identity exceeded JS safety.");
    return number;
  }

  string(maximumBytes: number): string {
    const length = this.u32();
    if (length === 0 || length > maximumBytes)
      throw protocolError("The helper response string exceeded its boundary.");
    return this.bytes(length).toString("utf8");
  }
}

function parseResponse(bytes: Buffer): RawResponse {
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw protocolError("The helper response exceeded its byte boundary.");
  const reader = new BinaryReader(bytes);
  if (!reader.bytes(RESPONSE_MAGIC.byteLength).equals(RESPONSE_MAGIC)) {
    throw protocolError("The helper response magic was invalid.");
  }
  if (reader.u32() !== PROTOCOL_VERSION)
    throw protocolError("The helper response version was invalid.");
  const status = reader.u8();
  const errorCode = reader.u8();
  const rollback = reader.u8();
  const kind = reader.u8();
  const dev = reader.u64();
  const ino = reader.u64();
  const mode = reader.u32();
  const ctimeSeconds = reader.u64();
  const ctimeNanoseconds = reader.u32();
  const parentDev = reader.u64();
  const parentIno = reader.u64();
  const afterFingerprint = reader.bytes(FINGERPRINT_BYTES).toString("hex");
  const requestId = reader.string(MAX_REQUEST_ID_BYTES);
  reader.string(MAX_RESPONSE_BYTES);
  if (reader.remaining !== 0) throw protocolError("The helper emitted extra output.");
  if (kind !== 0 && kind !== 1 && kind !== 2)
    throw protocolError("The helper after-kind was invalid.");
  return {
    status,
    errorCode,
    rollback,
    requestId,
    afterFingerprint,
    parent: { dev: parentDev, ino: parentIno },
    after:
      kind === 0
        ? null
        : {
            kind: kind === 1 ? "file" : "directory",
            dev,
            ino,
            mode,
            ctimeSeconds,
            ctimeNanoseconds,
          },
  };
}

function defaultHelperPath(): string {
  const configured = process.env.MOSS_CANONICAL_FILESYSTEM_HELPER_PATH?.trim();
  if (configured && process.env.MOSS_MODE === "desktop") return resolve(configured);
  const serverRoot = process.cwd().endsWith(sep + join("apps", "server"))
    ? process.cwd()
    : resolve(process.cwd(), "apps/server");
  return resolve(
    serverRoot,
    "native/moss-canonical-filesystem-helper/build/moss-canonical-filesystem-helper",
  );
}

function defaultMetadataPath(helperPath: string): string {
  const configured = process.env.MOSS_CANONICAL_FILESYSTEM_HELPER_METADATA_PATH?.trim();
  if (configured && process.env.MOSS_MODE === "desktop") return resolve(configured);
  return `${helperPath}.build.json`;
}

interface HelperArtifactMetadata {
  readonly schemaVersion: 1;
  readonly helper: string;
  readonly protocolVersion: number;
  readonly arch: string;
  readonly architectures: ReadonlyArray<string>;
  readonly fingerprint: string;
  readonly sha256: string;
  readonly size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseArtifactMetadata(value: unknown): HelperArtifactMetadata {
  if (!isRecord(value))
    throw protocolError("The canonical filesystem helper metadata was invalid.");
  const architectures = value.architectures;
  const size = value.size;
  if (
    value.schemaVersion !== 1 ||
    value.helper !== MOSS_CANONICAL_FILESYSTEM_HELPER_NAME ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.arch !== "string" ||
    !Array.isArray(architectures) ||
    architectures.some((item) => typeof item !== "string") ||
    typeof value.fingerprint !== "string" ||
    typeof value.sha256 !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_HELPER_BINARY_BYTES
  ) {
    throw protocolError("The canonical filesystem helper metadata was invalid.");
  }
  assertFingerprint(value.fingerprint, "The helper build fingerprint");
  assertFingerprint(value.sha256, "The helper binary fingerprint");
  return {
    schemaVersion: 1,
    helper: MOSS_CANONICAL_FILESYSTEM_HELPER_NAME,
    protocolVersion: PROTOCOL_VERSION,
    arch: value.arch,
    architectures,
    fingerprint: value.fingerprint,
    sha256: value.sha256,
    size,
  };
}

async function streamHelperFingerprint(helperPath: string): Promise<{
  readonly size: number;
  readonly sha256: string;
}> {
  let before;
  try {
    before = await stat(helperPath);
  } catch {
    throw protocolError("The canonical filesystem helper binary could not be inspected.");
  }
  if (!before.isFile() || (before.mode & 0o111) === 0 || before.size <= 0) {
    throw protocolError("The canonical filesystem helper binary is not executable.");
  }
  if (before.size > MAX_HELPER_BINARY_BYTES) {
    throw protocolError("The canonical filesystem helper binary exceeded its size boundary.");
  }
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of createReadStream(helperPath, { highWaterMark: 64 * 1024 })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_HELPER_BINARY_BYTES) {
        throw protocolError("The canonical filesystem helper binary exceeded its size boundary.");
      }
      digest.update(bytes);
    }
  } catch (cause) {
    if (cause instanceof MossCanonicalFilesystemHelperError) throw cause;
    throw protocolError("The canonical filesystem helper binary could not be hashed.");
  }
  let after;
  try {
    after = await stat(helperPath);
  } catch {
    throw protocolError("The canonical filesystem helper binary disappeared during validation.");
  }
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw protocolError("The canonical filesystem helper binary changed during validation.");
  }
  return { size, sha256: digest.digest("hex") };
}

async function validateHelperArtifact(helperPath: string, metadataPath: string): Promise<void> {
  if (!isAbsolute(metadataPath) || metadataPath.includes("\0")) {
    throw protocolError("The canonical filesystem helper metadata path is not safe.");
  }
  let metadataBytes: Buffer;
  try {
    metadataBytes = await readFile(metadataPath);
  } catch {
    throw protocolError("The canonical filesystem helper metadata is unavailable.");
  }
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) {
    throw protocolError("The canonical filesystem helper metadata exceeded its size boundary.");
  }
  let metadata: HelperArtifactMetadata;
  try {
    metadata = parseArtifactMetadata(JSON.parse(metadataBytes.toString("utf8")));
  } catch (cause) {
    if (cause instanceof MossCanonicalFilesystemHelperError) throw cause;
    throw protocolError("The canonical filesystem helper metadata was not valid JSON.");
  }
  const runtimeArch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (
    !runtimeArch ||
    (metadata.arch !== runtimeArch && metadata.arch !== "universal") ||
    !metadata.architectures.includes(runtimeArch)
  ) {
    throw protocolError("The canonical filesystem helper has no compatible runtime architecture.");
  }
  const binary = await streamHelperFingerprint(helperPath);
  if (binary.size !== metadata.size || binary.sha256 !== metadata.sha256) {
    throw protocolError("The canonical filesystem helper binary failed its sidecar validation.");
  }
}

function spawnFailureCode(
  requestSent: boolean,
  message: string,
): MossCanonicalFilesystemHelperError {
  return requestSent ? recoveryError(message) : protocolError(message);
}

async function readReadyLine(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ readonly remainder: Buffer }> {
  const stdout = child.stdout;
  if (!stdout) throw protocolError("The helper stdout pipe was unavailable.");
  return await new Promise((resolveReady, rejectReady) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(protocolError("The helper did not complete its protocol handshake."));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.byteLength > MAX_READY_BYTES) {
        cleanup();
        rejectReady(protocolError("The helper handshake emitted too much output."));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline + 1).toString("utf8");
      cleanup();
      if (line !== READY_LINE) {
        rejectReady(protocolError("The helper protocol handshake was invalid."));
        return;
      }
      resolveReady({ remainder: buffer.subarray(newline + 1) });
    };
    const onError = () => {
      cleanup();
      rejectReady(protocolError("The helper could not be started."));
    };
    const onClose = () => {
      cleanup();
      rejectReady(protocolError("The helper exited before its protocol handshake."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function dispatchRequestAndCollectResponse(
  child: ChildProcess,
  initial: Buffer,
  timeoutMs: number,
  request: Buffer,
): Promise<Buffer> {
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout) throw protocolError("The helper stdout pipe was unavailable before dispatch.");
  if (!stdin) throw protocolError("The helper stdin pipe was unavailable before dispatch.");
  return await new Promise((resolveResponse, rejectResponse) => {
    const chunks: Buffer[] = [initial];
    let total = initial.byteLength;
    let settled = false;
    let requestSent = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      cleanup();
      rejectResponse(
        spawnFailureCode(requestSent, "The helper timed out during its protocol exchange."),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onData);
      stdin.off("error", onStdinError);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        settled = true;
        child.kill("SIGKILL");
        cleanup();
        rejectResponse(recoveryError("The helper emitted too much response data."));
        return;
      }
      chunks.push(value);
    };
    const onStdinError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResponse(
        spawnFailureCode(requestSent, "The helper request pipe failed during dispatch."),
      );
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResponse(spawnFailureCode(requestSent, "The helper process failed."));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0 || signal !== null) {
        rejectResponse(recoveryError("The helper exited before returning a durable response."));
        return;
      }
      resolveResponse(Buffer.concat(chunks, total));
    };
    stdout.on("data", onData);
    stdin.once("error", onStdinError);
    child.once("error", onError);
    child.once("close", onClose);

    if (child.exitCode !== null || child.signalCode !== null) {
      settled = true;
      cleanup();
      rejectResponse(protocolError("The helper exited before request dispatch."));
      return;
    }

    requestSent = true;
    try {
      stdin.end(request);
    } catch {
      settled = true;
      cleanup();
      rejectResponse(recoveryError("The helper request pipe failed during dispatch."));
    }
  });
}

function parseDispatchedResponse(bytes: Buffer): RawResponse {
  try {
    return parseResponse(bytes);
  } catch (cause) {
    if (
      cause instanceof MossCanonicalFilesystemHelperError &&
      cause.code === "durability-unsupported"
    ) {
      throw recoveryError("The helper returned no trustworthy response after request dispatch.");
    }
    throw cause;
  }
}

function mapResponse(
  response: RawResponse,
  input: MossCanonicalFilesystemHelperInput,
  requestId: string,
): MossCanonicalFilesystemHelperResult {
  if (response.status === 0) {
    if (
      response.requestId !== requestId ||
      response.parent.dev === 0 ||
      response.parent.ino === 0 ||
      (response.after === null && input.expectedAfterKind !== "missing")
    ) {
      throw recoveryError("The helper committed an invalid after-state.");
    }
    if (input.expectedAfterKind === "missing" && response.after !== null) {
      throw recoveryError("The helper committed an unexpected target state.");
    }
    if (response.afterFingerprint !== input.expectedAfterFingerprint) {
      throw recoveryError("The helper committed an unexpected content fingerprint.");
    }
    if (response.rollback !== 0)
      throw recoveryError("The helper returned an invalid rollback state.");
    return {
      status: "committed",
      after: response.after,
      afterFingerprint: response.afterFingerprint,
      parent: response.parent,
      rollback: "none",
    };
  }
  if (response.status === 1) {
    throw new MossCanonicalFilesystemHelperError(
      "conflict",
      "The helper observed a filesystem conflict.",
    );
  }
  if (response.status === 2) {
    throw recoveryError("The helper reported that filesystem recovery is required.");
  }
  switch (response.errorCode) {
    case 1:
      throw new MossCanonicalFilesystemHelperError(
        "durability-unsupported",
        "The helper could not durably complete the filesystem operation.",
      );
    case 2:
      throw new MossCanonicalFilesystemHelperError(
        "concurrent-modification",
        "The helper observed a concurrent filesystem modification.",
      );
    case 3:
      throw new MossCanonicalFilesystemHelperError(
        "symlink-escape",
        "The helper rejected a symlink boundary.",
      );
    case 4:
      throw new MossCanonicalFilesystemHelperError(
        "conflict",
        "The helper observed a filesystem conflict.",
      );
    default:
      throw protocolError(
        `The helper returned an invalid operation result (status=${response.status}, error=${response.errorCode}, rollback=${response.rollback}).`,
      );
  }
}

export function makeMossCanonicalFilesystemHelper(
  options: MossCanonicalFilesystemHelperOptions = {},
): MossCanonicalFilesystemHelper {
  const platform = options.platform ?? process.platform;
  const helperPath = options.helperPath ?? defaultHelperPath();
  const metadataPath = options.metadataPath ?? defaultMetadataPath(helperPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = options.spawn ?? spawnProcess;

  return {
    execute: async (input) => {
      validateInput(input);
      if (platform !== "darwin") {
        throw protocolError(`The canonical filesystem helper is unavailable on ${platform}.`);
      }
      if (!isAbsolute(helperPath) || helperPath.includes("\0")) {
        throw protocolError("The canonical filesystem helper path is not an absolute safe path.");
      }
      await validateHelperArtifact(helperPath, metadataPath);
      const serializedRequest = serializeRequest(input);
      let child: ChildProcess;
      try {
        child = spawn(helperPath, [], {
          cwd: input.cwd,
          env: { ...process.env, ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        throw protocolError("The canonical filesystem helper could not be spawned.");
      }
      const stderr = child.stderr;
      stderr?.on("data", () => undefined);
      let requestSent = false;
      try {
        const handshake = await readReadyLine(child, timeoutMs);
        if (handshake.remainder.byteLength > 0) {
          throw protocolError("The helper emitted extra output during its handshake.");
        }
        requestSent = true;
        const responseBytes = await dispatchRequestAndCollectResponse(
          child,
          Buffer.alloc(0),
          timeoutMs,
          serializedRequest.buffer,
        );
        return mapResponse(
          parseDispatchedResponse(responseBytes),
          input,
          serializedRequest.requestId,
        );
      } catch (cause) {
        if (cause instanceof MossCanonicalFilesystemHelperError) throw cause;
        throw spawnFailureCode(requestSent, "The canonical filesystem helper protocol failed.");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  };
}
