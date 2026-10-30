// Opt-in transport receipts for native lifecycle investigation. This module
// persists only fixed metadata and SHA-256 digests, never protocol payloads.
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

const MOSS_PROCESS_INSTANCE = randomUUID();
const HARD_LIMITS = {
  events: 4096,
  bytes: 4 * 1024 * 1024,
  frameBytes: 1024 * 1024,
  pending: 128,
  queued: 64,
} as const;
const FOOTER_RESERVE = 1024;
const REQUEST_KEYS = {
  initialize: ["clientInfo", "capabilities"],
  "plugin/list": [
    "cwds",
    "marketplaceKinds",
    "forceReload",
    "forceRefetch",
    "marketplacePath",
    "remoteMarketplaceName",
  ],
  "plugin/read": ["marketplacePath", "remoteMarketplaceName", "pluginName", "pluginId"],
  "plugin/install": ["marketplacePath", "remoteMarketplaceName", "pluginName"],
  "plugin/uninstall": ["pluginId"],
  "config/batchWrite": ["edits", "expectedVersion", "filePath", "reloadUserConfig"],
  "skills/list": ["cwds", "forceReload"],
  "thread/start": null,
  "turn/start": null,
} as const;
const NOTIFICATIONS = new Set([
  "thread/started",
  "turn/started",
  "turn/completed",
  "item/completed",
]);
type Method = keyof typeof REQUEST_KEYS;
type JsonRecord = Record<string, unknown>;
type Limits = { [K in keyof typeof HARD_LIMITS]: number };
type StopReason = "events" | "bytes" | "frame" | "pending" | "queue" | "io";

export interface CodexWireEvidenceOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly sessionAttemptId: string;
  readonly childPid: number | undefined;
  readonly threadId: string;
  readonly homePath?: string | undefined;
  readonly workspacePath?: string | undefined;
  /** Tests may lower a limit. Values never raise the production ceiling. */
  readonly limits?: Partial<Limits>;
}

export interface CodexWireWriteObservation {
  readonly rpcIdSha256: string;
  readonly frameSha256: string;
  readonly method: Method;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}
function rpcId(value: unknown): string | undefined {
  return (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" && value.length <= 128)
    ? digest(JSON.stringify(value))
    : undefined;
}
function allowedRequest(method: Method, params: unknown): boolean {
  const fields = record(params);
  if (!fields) return false;
  const allowed = REQUEST_KEYS[method];
  if (
    allowed !== null &&
    Object.keys(fields).some((key) => !(allowed as readonly string[]).includes(key))
  ) {
    return false;
  }
  if (method !== "config/batchWrite") return true;
  // Never collect arbitrary config writes, auth settings, environment, or routing.
  return (
    Array.isArray(fields.edits) &&
    fields.edits.length > 0 &&
    fields.edits.length <= 16 &&
    fields.edits.every((value) => {
      const edit = record(value);
      return (
        edit !== undefined &&
        Object.keys(edit).every((key) => ["keyPath", "value", "mergeStrategy"].includes(key)) &&
        typeof edit.keyPath === "string" &&
        /^plugins\.[A-Za-z0-9_@.-]+\.enabled$/u.test(edit.keyPath) &&
        typeof edit.value === "boolean" &&
        (edit.mergeStrategy === undefined || edit.mergeStrategy === "upsert")
      );
    })
  );
}

/** Disabled by default. No filesystem work occurs without both explicit flags. */
export function createCodexWireEvidenceCollector(
  options: CodexWireEvidenceOptions,
): CodexWireEvidenceCollector | undefined {
  const env = options.environment ?? process.env;
  const directory = env.MOSS_CODEX_WIRE_EVIDENCE_DIR;
  if (
    env.MOSS_CODEX_WIRE_EVIDENCE !== "1" ||
    !directory ||
    !path.isAbsolute(directory) ||
    !Number.isSafeInteger(options.childPid) ||
    (options.childPid ?? 0) <= 0
  )
    return undefined;
  return new CodexWireEvidenceCollector(directory, options);
}

export class CodexWireEvidenceCollector {
  readonly outputPath: string;
  readonly #limits: Limits;
  readonly #pending = new Map<string, CodexWireWriteObservation>();
  readonly #identity: JsonRecord;
  #tail: Promise<void>;
  #closing: Promise<void> = Promise.resolve();
  #file: FileHandle | undefined;
  #sequence = 0;
  #bytes = 0;
  #queued = 0;
  #ignored = 0;
  #state: "collecting" | "closed" | "truncated" | "failed" = "collecting";
  #reason: StopReason | undefined;

  constructor(directory: string, options: CodexWireEvidenceOptions) {
    this.outputPath = path.join(directory, `codex-wire-${randomUUID()}.jsonl`);
    this.#limits = Object.fromEntries(
      Object.entries(HARD_LIMITS).map(([key, ceiling]) => {
        const value = options.limits?.[key as keyof Limits];
        const minimum = key === "bytes" ? 2048 : key === "events" ? 4 : 1;
        return [
          key,
          typeof value === "number" && Number.isSafeInteger(value)
            ? Math.min(ceiling, Math.max(minimum, value))
            : ceiling,
        ];
      }),
    ) as Limits;
    const startedAt = new Date().toISOString();
    this.#identity = {
      hostProcessId: process.pid,
      appServerProcessId: options.childPid,
      hostInstanceSha256: digest(`${process.pid}:${MOSS_PROCESS_INSTANCE}`),
      appServerInstanceSha256: digest(
        `${options.childPid}:${options.sessionAttemptId}:${startedAt}`,
      ),
      sessionAttemptSha256: digest(options.sessionAttemptId),
      threadIdSha256: digest(options.threadId),
      launchHomeSha256: options.homePath === undefined ? null : digest(options.homePath),
      workspaceSha256: options.workspacePath === undefined ? null : digest(options.workspacePath),
      homeIdentitySource: "server-launch-environment",
      hostIdentityScope: "codex-manager-process",
    };
    this.#tail = this.#open(directory).catch(() => {
      this.#fail();
    });
    this.#emit({
      kind: "process-start",
      scope: "collection-only",
      limits: this.#limits,
      ...this.#identity,
    });
  }

  async #open(directory: string): Promise<void> {
    // Reject symlink/junction output roots and parents. Never follow an existing
    // receipt filename or reuse a prior run, including after a crash.
    let current = path.resolve(directory);
    while (true) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe evidence directory");
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    this.#file = await open(this.outputPath, "wx", 0o600);
  }

  get status() {
    return {
      state: this.#state,
      reason: this.#reason,
      events: this.#sequence,
      bytes: this.#bytes,
      queued: this.#queued,
      pending: this.#pending.size,
      ignored: this.#ignored,
    };
  }

  /** Capture a candidate before writing so an immediate response can correlate. */
  observeOutgoing(message: unknown): CodexWireWriteObservation | undefined {
    if (this.#state !== "collecting") return undefined;
    try {
      const frame = record(message);
      const method = frame?.method;
      if (
        !frame ||
        typeof method !== "string" ||
        !Object.hasOwn(REQUEST_KEYS, method) ||
        !allowedRequest(method as Method, frame.params)
      ) {
        this.#ignored += 1;
        return undefined;
      }
      const key = rpcId(frame.id);
      if (!key) {
        this.#ignored += 1;
        return undefined;
      }
      const serialized = JSON.stringify(message);
      if (Buffer.byteLength(serialized) > this.#limits.frameBytes) {
        this.#truncate("frame");
        return undefined;
      }
      if (this.#pending.size >= this.#limits.pending || this.#pending.has(key)) {
        this.#truncate("pending");
        return undefined;
      }
      const observation = {
        rpcIdSha256: key,
        frameSha256: digest(serialized),
        method: method as Method,
      };
      const keys =
        REQUEST_KEYS[method as Method] === null
          ? undefined
          : Object.keys(record(frame.params)!).sort();
      if (
        !this.#emit({
          kind: "request-attempt",
          ...observation,
          payloadSha256: digest(JSON.stringify(frame.params)),
          ...(keys ? { requestKeys: keys } : {}),
        })
      )
        return undefined;
      this.#pending.set(key, observation);
      return observation;
    } catch {
      this.#truncate("frame");
      return undefined;
    }
  }

  /** A failed or unconfirmed write is never represented as dispatched. */
  settleOutgoing(observation: CodexWireWriteObservation | undefined, written: boolean): void {
    if (!observation || this.#state !== "collecting") return;
    this.#emit({ kind: written ? "request-written" : "request-write-failed", ...observation });
    if (!written) this.#pending.delete(observation.rpcIdSha256);
  }

  observeIncoming(rawLine: string, parsed: unknown): void {
    if (this.#state !== "collecting") return;
    try {
      const frame = record(parsed);
      if (!frame) return;
      if (Buffer.byteLength(rawLine) > this.#limits.frameBytes) {
        this.#truncate("frame");
        return;
      }
      if (typeof frame.method === "string") {
        if (!NOTIFICATIONS.has(frame.method) || Object.hasOwn(frame, "id")) {
          this.#ignored += 1;
          return;
        }
        this.#emit({ kind: "notification", method: frame.method, frameSha256: digest(rawLine) });
        return;
      }
      const key = rpcId(frame.id);
      const request = key === undefined ? undefined : this.#pending.get(key);
      if (!request || (!Object.hasOwn(frame, "result") && !Object.hasOwn(frame, "error"))) {
        this.#ignored += 1;
        return;
      }
      this.#pending.delete(request.rpcIdSha256);
      this.#emit({
        kind: "response",
        method: request.method,
        rpcIdSha256: request.rpcIdSha256,
        requestFrameSha256: request.frameSha256,
        frameSha256: digest(rawLine),
        responseKind: Object.hasOwn(frame, "error") ? "error" : "result",
      });
    } catch {
      this.#truncate("frame");
    }
  }

  #emit(event: JsonRecord): boolean {
    if (this.#state !== "collecting") return false;
    const line = this.#line(event);
    if (this.#sequence >= this.#limits.events - 1) {
      this.#truncate("events");
      return false;
    }
    if (this.#bytes + Buffer.byteLength(line) > this.#limits.bytes - FOOTER_RESERVE) {
      this.#truncate("bytes");
      return false;
    }
    if (this.#queued >= this.#limits.queued) {
      this.#truncate("queue");
      return false;
    }
    this.#append(line);
    return true;
  }
  #line(event: JsonRecord): string {
    return `${JSON.stringify({
      schemaVersion: 1,
      sequence: this.#sequence + 1,
      observedAt: new Date().toISOString(),
      ...event,
    })}\n`;
  }
  #append(line: string): void {
    this.#sequence += 1;
    this.#bytes += Buffer.byteLength(line);
    this.#queued += 1;
    this.#tail = this.#tail
      .then(async () => {
        if (!this.#file || this.#state === "failed") return;
        await this.#file.writeFile(line, "utf8");
      })
      .catch(() => {
        this.#fail();
      })
      .finally(() => {
        this.#queued -= 1;
      });
  }
  #fail(): void {
    this.#state = "failed";
    this.#reason = "io";
    this.#pending.clear();
    const file = this.#file;
    this.#file = undefined;
    if (file) this.#closing = file.close().catch(() => undefined);
  }
  #truncate(reason: StopReason): void {
    if (this.#state !== "collecting") return;
    this.#reason = reason;
    this.#finish("truncated");
  }
  #finish(
    state: "closed" | "truncated",
    exit?: { code: number | null; signal: string | null },
  ): void {
    if (this.#state !== "collecting") return;
    const unansweredRequests = this.#pending.size;
    this.#pending.clear();
    this.#state = state;
    // Terminal metadata has reserved space and cannot manufacture a gate result.
    this.#append(
      this.#line({
        kind: "collection-stopped",
        state,
        reason: this.#reason ?? null,
        unansweredRequests,
        ignoredFrames: this.#ignored,
        ...(exit
          ? {
              exitCode: exit.code,
              signal: ["SIGTERM", "SIGINT", "SIGKILL"].includes(exit.signal ?? "")
                ? exit.signal
                : null,
            }
          : {}),
      }),
    );
    this.#tail = this.#tail
      .then(async () => {
        await this.#file?.close();
        this.#file = undefined;
      })
      .catch(() => {
        this.#fail();
      });
  }

  close(exit: { code: number | null; signal: string | null }): void {
    this.#finish("closed", exit);
  }
  /** Waits for bounded receipt IO only; never rejects or affects native transport. */
  async flush(): Promise<void> {
    await this.#tail;
    await this.#closing;
  }
}
