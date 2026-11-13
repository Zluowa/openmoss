// Durable account-scoped media history. The bounded broker is a work queue, not a library.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { HoolaCanvasDurableJob, HoolaCanvasJobSnapshot } from "./hoolaCanvasBridge";

const JOB = /^moss_[A-Za-z0-9_-]{1,128}$/u;
const CONVERSATION = /^mossconv_[a-f0-9]{32}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_RECORD_BYTES = 512 * 1024;
export type MediaHistoryKind = "image" | "video";
export interface MediaHistoryPageInput {
  readonly kind?: MediaHistoryKind;
  readonly limit?: number;
  readonly cursor?: string;
  readonly conversationId?: string;
}
export interface MediaHistoryPage {
  readonly jobs: readonly HoolaCanvasJobSnapshot[];
  readonly nextCursor: string | null;
}
export class MediaHistoryError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
interface Row {
  readonly sequence: number;
  readonly durable: string;
  readonly snapshot: string;
  readonly digest: string;
}
interface Cursor {
  readonly v: 1;
  readonly scope: string;
  readonly kind: string;
  readonly conversation: string;
  readonly high: number;
  readonly last: number;
}

function readDurable(row: Row): HoolaCanvasDurableJob {
  if (Buffer.byteLength(row.durable) > MAX_RECORD_BYTES)
    throw new MediaHistoryError("media_history_invalid", 503);
  const job = JSON.parse(row.durable) as HoolaCanvasDurableJob;
  if (
    !job ||
    !JOB.test(job.snapshot?.jobId) ||
    !CONVERSATION.test(job.snapshot?.conversationId) ||
    job.snapshot.jobId !== job.checkpoint?.jobId ||
    job.requestDigest !== row.digest ||
    !HASH.test(job.requestDigest) ||
    !Number.isSafeInteger(job.revision) ||
    job.revision < 0
  )
    throw new MediaHistoryError("media_history_invalid", 503);
  return job;
}

/** Scoped connections close after each bounded transaction, including failures. */
export class MossMediaHistory {
  readonly #path: string;
  constructor(readonly stateDirectory: string) {
    this.#path = join(stateDirectory, "media-history", "history.sqlite");
  }

  async #db<T>(operation: (sql: SqlClient.SqlClient) => Effect.Effect<T, unknown>): Promise<T> {
    const directory = join(this.stateDirectory, "media-history");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new MediaHistoryError("media_history_unavailable", 503);
    try {
      const file = await open(this.#path, "wx", 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const fileInfo = await lstat(this.#path);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
      throw new MediaHistoryError("media_history_unavailable", 503);
    // Same runtime split as persistence/Layers/Sqlite.ts; no new native dependency.
    const client =
      process.versions.bun !== undefined
        ? await import("@effect/sql-sqlite-bun/SqliteClient")
        : await import("./persistence/NodeSqliteClient.ts");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 5000`;
        yield* sql`PRAGMA synchronous = FULL`;
        yield* sql`CREATE TABLE IF NOT EXISTS media_history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
        yield* sql`INSERT OR IGNORE INTO media_history_meta(key,value) VALUES ('cursor_key',${randomBytes(32).toString("hex")})`;
        yield* sql`CREATE TABLE IF NOT EXISTS media_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, job_id TEXT NOT NULL,
        identity TEXT NOT NULL, digest TEXT NOT NULL, kind TEXT NOT NULL,
        conversation_id TEXT NOT NULL, parent_job_id TEXT, revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL, durable TEXT NOT NULL, protected INTEGER NOT NULL,
        UNIQUE(scope,job_id), UNIQUE(scope,identity))`;
        yield* sql`CREATE INDEX IF NOT EXISTS media_history_page ON media_history(scope,kind,sequence)`;
        yield* sql`CREATE INDEX IF NOT EXISTS media_history_all_page ON media_history(scope,sequence)`;
        yield* sql`CREATE INDEX IF NOT EXISTS media_history_protected ON media_history(scope,protected)`;
        yield* sql`CREATE INDEX IF NOT EXISTS media_history_conversation ON media_history(scope,conversation_id,sequence)`;
        yield* sql`CREATE TABLE IF NOT EXISTS media_history_assets (
        scope TEXT NOT NULL, asset_id TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(scope,asset_id,job_id))`;
        return yield* operation(sql);
      }).pipe(Effect.provide(client.layer({ filename: this.#path })), Effect.result),
    );
    if (result._tag === "Failure") throw result.failure;
    return result.success;
  }

  #scope(scope: string) {
    if (!HASH.test(scope)) throw new MediaHistoryError("media_history_scope_invalid");
  }

  async get(scope: string, jobId: string): Promise<HoolaCanvasDurableJob | null> {
    this.#scope(scope);
    if (!JOB.test(jobId)) throw new MediaHistoryError("invalid_request");
    return this.#db((sql) =>
      sql<Row>`SELECT sequence,durable,snapshot,digest FROM media_history WHERE scope=${scope} AND job_id=${jobId}`.pipe(
        Effect.map((rows) => (rows[0] ? readDurable(rows[0]) : null)),
      ),
    );
  }

  async find(
    scope: string,
    identity: string,
    digest: string,
  ): Promise<HoolaCanvasDurableJob | null> {
    this.#scope(scope);
    return this.#db((sql) =>
      sql<Row>`SELECT sequence,durable,snapshot,digest FROM media_history WHERE scope=${scope} AND identity=${identity}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] && rows[0].digest !== digest
            ? Effect.fail(new MediaHistoryError("idempotency_conflict", 409))
            : Effect.succeed(rows[0] ? readDurable(rows[0]) : null),
        ),
      ),
    );
  }

  async save(scope: string, rawJob: HoolaCanvasDurableJob): Promise<void> {
    this.#scope(scope);
    const job = {
      ...rawJob,
      snapshot: { ...rawJob.snapshot, revision: rawJob.revision },
      checkpoint: { ...rawJob.checkpoint, revision: rawJob.revision },
    };
    const encoded = JSON.stringify(job);
    if (
      Buffer.byteLength(encoded) > MAX_RECORD_BYTES ||
      !Number.isSafeInteger(job.revision) ||
      job.revision < 0 ||
      !JOB.test(job.snapshot.jobId) ||
      !CONVERSATION.test(job.snapshot.conversationId) ||
      !HASH.test(job.requestDigest)
    )
      throw new MediaHistoryError("media_history_invalid", 503);
    const kind = job.snapshot.operation === "video" ? "video" : "image";
    const protectedJob = !(
      (job.snapshot.status === "succeeded" || job.snapshot.status === "failed_terminal") &&
      ["captured", "released", "exempt"].includes(job.snapshot.billingStatus) &&
      (job.snapshot.status === "failed_terminal" || job.snapshot.persistenceStatus === "ready")
    );
    await this.#db((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<
            Row & {
              revision: number;
              job_id: string;
              conversation_id: string;
              parent_job_id: string | null;
            }
          >`
        SELECT sequence,durable,snapshot,digest,revision,job_id,conversation_id,parent_job_id
        FROM media_history WHERE scope=${scope} AND (identity=${job.idempotencyIdentity} OR job_id=${job.snapshot.jobId})`;
          const prior = existing[0];
          if (
            existing.length > 1 ||
            (prior &&
              (prior.job_id !== job.snapshot.jobId ||
                prior.digest !== job.requestDigest ||
                prior.conversation_id !== job.snapshot.conversationId ||
                prior.parent_job_id !== job.snapshot.parentJobId))
          )
            return yield* Effect.fail(new MediaHistoryError("idempotency_conflict", 409));
          if (prior && prior.revision >= job.revision) return;
          if (!prior && job.snapshot.parentJobId) {
            const parents =
              yield* sql<Row>`SELECT sequence,durable,snapshot,digest FROM media_history WHERE scope=${scope} AND job_id=${job.snapshot.parentJobId}`;
            const parent = parents[0] ? readDurable(parents[0]).snapshot : null;
            if (
              !parent ||
              parent.conversationId !== job.snapshot.conversationId ||
              parent.status !== "succeeded" ||
              (parent.operation === "video" ? "video" : "image") !== kind ||
              (kind === "video" ? parent.videoUrls : parent.imageUrls).length === 0
            )
              return yield* Effect.fail(new MediaHistoryError("invalid_conversation", 409));
          }
          yield* sql`INSERT INTO media_history(scope,job_id,identity,digest,kind,conversation_id,parent_job_id,revision,snapshot,durable,protected)
        VALUES (${scope},${job.snapshot.jobId},${job.idempotencyIdentity},${job.requestDigest},${kind},${job.snapshot.conversationId},${job.snapshot.parentJobId},${job.revision},${JSON.stringify(job.snapshot)},${encoded},${protectedJob ? 1 : 0})
        ON CONFLICT(scope,job_id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,durable=excluded.durable,protected=excluded.protected`;
          for (const asset of job.snapshot.assets ?? [])
            yield* sql`INSERT OR IGNORE INTO media_history_assets(scope,asset_id,job_id) VALUES (${scope},${asset.assetId},${job.snapshot.jobId})`;
        }),
      ),
    );
  }

  async hasAsset(scope: string, assetId: string): Promise<boolean> {
    this.#scope(scope);
    return this.#db((sql) =>
      sql`SELECT 1 FROM media_history_assets WHERE scope=${scope} AND asset_id=${assetId} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    );
  }

  async hasProtectedJobs(scope: string): Promise<boolean> {
    this.#scope(scope);
    return this.#db((sql) =>
      sql`SELECT 1 FROM media_history WHERE scope=${scope} AND protected=1 LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),
    );
  }

  async conversationKind(scope: string, conversationId: string): Promise<MediaHistoryKind | null> {
    this.#scope(scope);
    if (!CONVERSATION.test(conversationId)) throw new MediaHistoryError("invalid_conversation");
    return this.#db((sql) =>
      sql<{
        kind: MediaHistoryKind;
      }>`SELECT kind FROM media_history WHERE scope=${scope} AND conversation_id=${conversationId} LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.kind ?? null),
      ),
    );
  }

  async page(scope: string, input: MediaHistoryPageInput = {}): Promise<MediaHistoryPage> {
    this.#scope(scope);
    const limit = input.limit ?? 24;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (input.kind !== undefined && input.kind !== "image" && input.kind !== "video") ||
      (input.conversationId !== undefined && !CONVERSATION.test(input.conversationId)) ||
      (input.cursor !== undefined &&
        (input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u.test(input.cursor)))
    )
      throw new MediaHistoryError("invalid_history_cursor");
    return this.#db((sql) =>
      Effect.gen(function* () {
        const keys = yield* sql<{
          value: string;
        }>`SELECT value FROM media_history_meta WHERE key='cursor_key'`;
        const key = keys[0]?.value;
        if (!key || !HASH.test(key))
          return yield* Effect.fail(new MediaHistoryError("media_history_invalid", 503));
        let position: Cursor;
        if (input.cursor !== undefined) {
          try {
            const [payload, signature] = input.cursor.split(".") as [string, string];
            const expected = createHmac("sha256", key).update(payload).digest();
            if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new Error();
            position = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Cursor;
            if (
              position.v !== 1 ||
              position.scope !== scope ||
              position.kind !== (input.kind ?? "all") ||
              position.conversation !== (input.conversationId ?? "") ||
              !Number.isSafeInteger(position.high) ||
              position.high < 0 ||
              !Number.isSafeInteger(position.last) ||
              position.last < 0 ||
              position.last > position.high
            )
              throw new Error();
          } catch {
            return yield* Effect.fail(new MediaHistoryError("invalid_history_cursor"));
          }
        } else {
          const rows = yield* sql<{
            high: number;
          }>`SELECT COALESCE(MAX(sequence),0) AS high FROM media_history WHERE scope=${scope}`;
          position = {
            v: 1,
            scope,
            kind: input.kind ?? "all",
            conversation: input.conversationId ?? "",
            high: rows[0]!.high,
            last: 0,
          };
        }
        const filter = input.kind ? sql`AND kind=${input.kind}` : sql``;
        const conversation = input.conversationId
          ? sql`AND conversation_id=${input.conversationId}`
          : sql``;
        const after = input.cursor ? sql`AND sequence<${position.last}` : sql``;
        const rows = yield* sql<{
          sequence: number;
          snapshot: string;
        }>`SELECT sequence,snapshot FROM media_history
        WHERE scope=${scope} AND sequence<=${position.high} ${filter} ${conversation} ${after}
        ORDER BY sequence DESC LIMIT ${limit + 1}`;
        const page = rows.slice(0, limit);
        let nextCursor: string | null = null;
        if (rows.length > limit) {
          const payload = Buffer.from(
            JSON.stringify({ ...position, last: page.at(-1)!.sequence }),
          ).toString("base64url");
          nextCursor = `${payload}.${createHmac("sha256", key).update(payload).digest("hex")}`;
        }
        return {
          jobs: page.map((row) => JSON.parse(row.snapshot) as HoolaCanvasJobSnapshot),
          nextCursor,
        };
      }),
    );
  }
}
