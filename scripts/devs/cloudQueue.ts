import {
  DEVS_ATTACHMENT_LIMITS,
  DEVS_DEFAULT_DAILY_JOB_LIMIT,
  DEVS_DEFAULT_DAILY_REPORT_LIMIT,
  DEVS_DEFAULT_INSTALL_DAILY_LIMIT,
  devsSecondsUntilNextDay,
  devsAttachmentBytesMatch,
  devsAttachmentName,
  devsUtcDay,
  parseDevsAttachmentManifest,
  redactDevsReportText,
  type DevsAttachmentManifestEntry,
} from "@moss/shared/devsReport";

export interface DevsQueueStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  transaction<T>(action: (store: DevsQueueStore) => Promise<T>): Promise<T>;
}
interface CloudJob {
  id: string;
  engine: "codex" | "claude";
  description: string;
  context: string;
  readHash: string;
  status: "queued" | "running" | "pull-request" | "failed";
  message: string;
  pullRequestUrl: string | null;
  createdAt: number;
  claimId?: string;
  lease?: string;
  expiresAt?: number;
  /** Declared with the report; each one's bytes arrive in its own upload. */
  attachments?: (DevsAttachmentManifestEntry & { stored: boolean })[];
}
/** How long a report waits for its declared attachments before a worker may take it anyway. */
const ATTACHMENT_GRACE_MS = 10 * 60_000;
/** Today's counts. Reset when the UTC day changes; holds at most the report cap's installs. */
interface DailyBudget {
  day: string;
  accepted: number;
  claimed: number;
  installs: Record<string, number>;
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
const receipt = (job: CloudJob) => ({
  id: job.id,
  status: job.status,
  message: job.message,
  pullRequestUrl: job.pullRequestUrl,
  ...(job.attachments?.length
    ? {
        attachments: {
          count: job.attachments.length,
          received: job.attachments.filter((attachment) => attachment.stored).length,
        },
      }
    : {}),
});
const claim = (job: CloudJob) => ({
  report: {
    id: job.id,
    engine: job.engine,
    description: job.description,
    context: job.context,
    // Only what arrived; the worker downloads each by its index.
    attachments: (job.attachments ?? []).flatMap(({ stored, ...attachment }, index) =>
      stored ? [{ index, ...attachment }] : [],
    ),
  },
  lease: job.lease,
  expiresAt: job.expiresAt,
});
const attachmentKey = (id: string, index: number) => `attachment:${id}:${index}`;
async function dropAttachments(store: DevsQueueStore, job: CloudJob) {
  for (const index of (job.attachments ?? []).keys())
    await store.delete(attachmentKey(job.id, index));
}
/** Reads a request body of at most `limit` bytes; null when it is larger. */
async function boundedBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
async function body(request: Request, limit = 64_000): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The 分享反馈 categories; anything else is refused. */
const FEEDBACK_CATEGORIES: Record<string, string> = {
  bug: "Bug",
  session: "Session",
  ui: "UI",
  performance: "Performance",
  idea: "Idea",
  other: "Other",
};
const FEEDBACK_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Feedback JSON with its images inline: the report limits in base64, plus the text. */
export const FEEDBACK_BODY_LIMIT = Math.ceil((DEVS_ATTACHMENT_LIMITS.totalBytes * 4) / 3) + 64_000;
function decodeBase64(value: string, limit: number): Uint8Array<ArrayBuffer> | null {
  if (value.length > Math.ceil((limit * 4) / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return null;
  try {
    const binary = atob(value);
    if (binary.length > limit) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
type FeedbackAttachment = { entry: DevsAttachmentManifestEntry; bytes: Uint8Array<ArrayBuffer> };
/** The images a feedback report carries, checked like uploaded report attachments. */
async function feedbackAttachments(value: unknown): Promise<FeedbackAttachment[] | null> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DEVS_ATTACHMENT_LIMITS.maxCount) return null;
  const result: FeedbackAttachment[] = [];
  let total = 0;
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object") return null;
    const { name, mimeType, dataBase64 } = item as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      name.length > 300 ||
      typeof mimeType !== "string" ||
      !FEEDBACK_IMAGE_TYPES.has(mimeType) ||
      typeof dataBase64 !== "string"
    )
      return null;
    const bytes = decodeBase64(dataBase64, DEVS_ATTACHMENT_LIMITS.imageBytes);
    if (!bytes || bytes.byteLength < 1 || !devsAttachmentBytesMatch(mimeType, bytes)) return null;
    total += bytes.byteLength;
    if (total > DEVS_ATTACHMENT_LIMITS.totalBytes) return null;
    result.push({
      entry: {
        name: devsAttachmentName(name),
        kind: "image",
        mimeType: mimeType as DevsAttachmentManifestEntry["mimeType"],
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      },
      bytes,
    });
  }
  return result;
}

/** Public capability-based reporting; only the private outbound worker can read reports or run jobs. */
export function createCloudDevsQueue(options: {
  store: DevsQueueStore;
  workerToken: string;
  repository: string;
  engines: readonly string[];
  /** Reports accepted per UTC day, across everyone. */
  dailyReportLimit?: number;
  /** Jobs handed to the worker per UTC day. */
  dailyJobLimit?: number;
  /** Reports accepted per installation per UTC day. */
  installDailyLimit?: number;
  /** The engine 分享反馈 reports are queued for; the first engine when unset. */
  feedbackEngine?: string;
  now?: () => number;
}) {
  if (options.workerToken.length < 32) throw new Error("Missing private worker credential.");
  const now = options.now ?? Date.now;
  const reportLimit = options.dailyReportLimit ?? DEVS_DEFAULT_DAILY_REPORT_LIMIT;
  const jobLimit = options.dailyJobLimit ?? DEVS_DEFAULT_DAILY_JOB_LIMIT;
  const installLimit = options.installDailyLimit ?? DEVS_DEFAULT_INSTALL_DAILY_LIMIT;
  const budget = async (store: DevsQueueStore): Promise<DailyBudget> => {
    const day = devsUtcDay(now());
    const saved = await store.get<DailyBudget>("budget");
    return saved?.day === day ? saved : { day, accepted: 0, claimed: 0, installs: {} };
  };
  const limited = (error: string) =>
    new Response(JSON.stringify({ error }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": String(devsSecondsUntilNextDay(now())),
      },
    });
  const expire = async (store: DevsQueueStore, job: CloudJob) => {
    if (job.status === "running" && (job.expiresAt ?? 0) < now()) {
      job.status = "failed";
      job.message =
        "The developer worker disconnected. The job needs maintainer inspection and will not be replayed automatically.";
      await dropAttachments(store, job);
      await store.put(`job:${job.id}`, job);
    }
  };
  const feedbackEngine = (
    options.feedbackEngine && options.engines.includes(options.feedbackEngine)
      ? options.feedbackEngine
      : options.engines[0]
  ) as CloudJob["engine"] | undefined;
  /**
   * Queues a report or a 分享反馈 report under the shared caps. `stored` holds attachment bytes
   * that arrived with the request; a report's others are uploaded separately.
   */
  const enqueue = (input: {
    job: Omit<CloudJob, "readHash" | "status" | "message" | "pullRequestUrl" | "createdAt">;
    readHash: string;
    install: string;
    stored?: readonly Uint8Array<ArrayBuffer>[];
  }) =>
    options.store.transaction(async (store) => {
      const existing = await store.get<CloudJob>(`job:${input.job.id}`);
      if (existing)
        return equal(existing.readHash, input.readHash)
          ? json(receipt(existing))
          : json({ error: "Report ID in use" }, 409);
      const ids = (await store.get<string[]>("index")) ?? [];
      if (ids.length >= 1_000) {
        const removable = await store.get<CloudJob>(`job:${ids[0]}`);
        if (
          !removable ||
          !["failed", "pull-request"].includes(removable.status) ||
          removable.createdAt > now() - 7 * 86400_000
        )
          return json({ error: "Queue full" }, 429);
        await dropAttachments(store, removable);
        await store.delete(`job:${ids.shift()}`);
      }
      let pending = 0;
      for (const id of ids) {
        const job = await store.get<CloudJob>(`job:${id}`);
        if (job) await expire(store, job);
        if (job && ["queued", "running"].includes(job.status)) pending++;
      }
      if (pending >= 100) return json({ error: "Queue full" }, 429);
      const today = await budget(store);
      if (today.accepted >= reportLimit) return limited("Daily report limit reached");
      if ((today.installs[input.install] ?? 0) >= installLimit)
        return limited("Daily report limit reached for this installation");
      today.accepted++;
      today.installs[input.install] = (today.installs[input.install] ?? 0) + 1;
      await store.put("budget", today);
      const job: CloudJob = {
        ...input.job,
        readHash: input.readHash,
        status: "queued",
        message: "Received by the Moss developers.",
        pullRequestUrl: null,
        createdAt: now(),
      };
      for (const [index, bytes] of (input.stored ?? []).entries())
        await store.put(attachmentKey(job.id, index), bytes);
      await store.put(`job:${job.id}`, job);
      ids.push(job.id);
      await store.put("index", ids);
      return json(receipt(job), 202);
    });
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (path.startsWith("/worker/") && !equal(bearer, options.workerToken))
      return json({ error: "Unauthorized" }, 401);
    if (path === "/worker/claim" && request.method === "POST") {
      const input = await body(request);
      const engines = input && (Array.isArray(input.engines) ? input.engines : [input.engine]);
      if (
        !input ||
        !uuid(input.claimId) ||
        !engines?.length ||
        engines.some((engine) => !options.engines.includes(String(engine)))
      )
        return json({ error: "Invalid claim" }, 400);
      return options.store.transaction(async (store) => {
        const ids = (await store.get<string[]>("index")) ?? [];
        let queued: CloudJob | undefined;
        for (const id of ids) {
          const job = await store.get<CloudJob>(`job:${id}`);
          if (!job) continue;
          await expire(store, job);
          if (job.status === "running")
            return job.claimId === input.claimId ? json(claim(job)) : json({ job: null });
          const waitingForAttachments =
            job.attachments?.some((attachment) => !attachment.stored) &&
            job.createdAt > now() - ATTACHMENT_GRACE_MS;
          if (
            !queued &&
            job.status === "queued" &&
            engines.includes(job.engine) &&
            !waitingForAttachments
          )
            queued = job;
        }
        if (!queued) return json({ job: null });
        // The day's job budget bounds model and CI cost; the rest wait for tomorrow.
        const today = await budget(store);
        if (today.claimed >= jobLimit) return json({ job: null, budgetExhausted: true });
        today.claimed++;
        await store.put("budget", today);
        queued.status = "running";
        queued.claimId = input.claimId as string;
        queued.lease = crypto.randomUUID() + crypto.randomUUID();
        queued.expiresAt = now() + 120_000;
        queued.message = `${queued.engine === "codex" ? "Codex" : "Claude"} is reproducing the problem and preparing a fix.`;
        await store.put(`job:${queued.id}`, queued);
        return json(claim(queued));
      });
    }
    const download = /^\/worker\/([^/]+)\/attachment$/.exec(path);
    if (download && request.method === "POST" && uuid(download[1])) {
      const input = await body(request);
      if (!input || typeof input.lease !== "string" || !Number.isSafeInteger(input.index))
        return json({ error: "Invalid attachment request" }, 400);
      return options.store.transaction(async (store) => {
        const job = await store.get<CloudJob>(`job:${download[1]}`);
        if (
          !job ||
          job.status !== "running" ||
          !job.lease ||
          !equal(job.lease, input.lease as string)
        )
          return json({ error: "Invalid lease" }, 409);
        const index = input.index as number;
        const attachment = job.attachments?.[index];
        const bytes = attachment?.stored
          ? await store.get<Uint8Array<ArrayBuffer>>(attachmentKey(job.id, index))
          : undefined;
        if (!attachment || !bytes) return json({ error: "Attachment not found" }, 404);
        return new Response(bytes, {
          headers: { "content-type": attachment.mimeType, "cache-control": "no-store" },
        });
      });
    }
    const operation = /^\/worker\/([^/]+)\/(heartbeat|complete)$/.exec(path);
    if (operation && request.method === "POST" && uuid(operation[1])) {
      const input = await body(request);
      if (!input || typeof input.lease !== "string") return json({ error: "Invalid lease" }, 400);
      return options.store.transaction(async (store) => {
        const job = await store.get<CloudJob>(`job:${operation[1]}`);
        if (!job || !job.lease || !equal(job.lease, input.lease as string))
          return json({ error: "Invalid lease" }, 409);
        // Receipt retries are idempotent; they never execute a job again.
        if (["failed", "pull-request"].includes(job.status)) return json(receipt(job));
        await expire(store, job);
        if (job.status !== "running") return json({ error: "Lease expired" }, 409);
        if (operation[2] === "heartbeat") job.expiresAt = now() + 120_000;
        else {
          const url = input.pullRequestUrl;
          if (
            url !== null &&
            (typeof url !== "string" ||
              !new RegExp(
                `^https://github\\.com/${options.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/\\d+$`,
              ).test(url))
          )
            return json({ error: "Invalid PR receipt" }, 400);
          job.pullRequestUrl = url as string | null;
          job.status = url ? "pull-request" : "failed";
          job.message = url
            ? "A fix PR is ready for maintainer review and CI."
            : "The repair did not pass its checks. A maintainer must inspect the job; it will not be replayed automatically.";
          // The worker keeps its copy with the retained job; the queue holds none after completion.
          await dropAttachments(store, job);
        }
        await store.put(`job:${job.id}`, job);
        return json(receipt(job));
      });
    }
    const upload = /^\/reports\/([^/]+)\/attachments\/(\d)$/.exec(path);
    if (upload && request.method === "PUT" && uuid(upload[1])) {
      if (bearer.length < 32) return json({ error: "Report not found" }, 404);
      const readHash = await hash(bearer);
      const index = Number(upload[2]);
      const bytes = await boundedBytes(request, DEVS_ATTACHMENT_LIMITS.imageBytes);
      if (!bytes) return json({ error: "Attachment too large" }, 413);
      return options.store.transaction(async (store) => {
        const job = await store.get<CloudJob>(`job:${upload[1]}`);
        if (!job || !equal(job.readHash, readHash)) return json({ error: "Report not found" }, 404);
        const attachment = job.attachments?.[index];
        if (!attachment) return json({ error: "Attachment not declared" }, 400);
        if (attachment.stored) return json(receipt(job));
        // Once a worker has the job, a late attachment can no longer reach the repair.
        if (job.status !== "queued") return json({ error: "Report already taken" }, 409);
        if (
          bytes.byteLength !== attachment.size ||
          request.headers.get("content-type") !== attachment.mimeType ||
          !devsAttachmentBytesMatch(attachment.mimeType, bytes) ||
          (await sha256Hex(bytes)) !== attachment.sha256
        )
          return json({ error: "Attachment does not match the report" }, 400);
        await store.put(attachmentKey(job.id, index), bytes);
        attachment.stored = true;
        await store.put(`job:${job.id}`, job);
        return json(receipt(job));
      });
    }
    const read = /^\/reports\/([^/]+)$/.exec(path);
    if (read && request.method === "GET" && uuid(read[1])) {
      const readHash = await hash(bearer);
      return options.store.transaction(async (store) => {
        const job = await store.get<CloudJob>(`job:${read[1]}`);
        if (!job || bearer.length < 32 || !equal(job.readHash, readHash))
          return json({ error: "Report not found" }, 404);
        await expire(store, job);
        return json(receipt(job));
      });
    }
    if (request.method === "POST" && path === "/feedback") {
      // Feedback needs no capability; one the app sends makes its retries idempotent.
      if (bearer && (bearer.length < 32 || bearer.length > 256))
        return json({ error: "Invalid feedback" }, 400);
      const input = await body(request, FEEDBACK_BODY_LIMIT);
      if (!input) return json({ error: "Feedback too large or unreadable" }, 413);
      const category = input.category ?? null;
      if (
        !feedbackEngine ||
        !uuid(input.id) ||
        (category !== null &&
          (typeof category !== "string" || !Object.hasOwn(FEEDBACK_CATEGORIES, category))) ||
        typeof input.details !== "string" ||
        !input.details.trim() ||
        input.details.length > 5_000 ||
        (input.summary !== undefined &&
          (typeof input.summary !== "string" || input.summary.length > 10_000)) ||
        (input.install !== undefined && !uuid(input.install))
      )
        return json({ error: "Invalid feedback" }, 400);
      const attachments = await feedbackAttachments(input.attachments);
      if (!attachments) return json({ error: "Invalid feedback attachments" }, 400);
      const label = category ? FEEDBACK_CATEGORIES[category as string] : null;
      // Without an installation ID, feedback from one address shares one allowance.
      const sender =
        input.install ?? `address:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
      return enqueue({
        job: {
          id: input.id as string,
          engine: feedbackEngine,
          description: redactDevsReportText(
            `Moss feedback${label ? ` (${label})` : ""}: ${(input.details as string).trim()}`,
            5_000,
          ),
          context: redactDevsReportText((input.summary as string | undefined) ?? "", 10_000),
          ...(attachments.length
            ? { attachments: attachments.map(({ entry }) => ({ ...entry, stored: true })) }
            : {}),
        },
        readHash: await hash(bearer || crypto.randomUUID() + crypto.randomUUID()),
        install: (await hash(`install:${sender}`)).slice(0, 32),
        stored: attachments.map(({ bytes }) => bytes),
      });
    }
    if (request.method !== "POST" || path !== "/reports") return json({ error: "Not found" }, 404);
    if (bearer.length < 32 || bearer.length > 256)
      return json({ error: "Report capability required" }, 401);
    const input = await body(request);
    if (
      !input ||
      !uuid(input.id) ||
      !options.engines.includes(String(input.engine)) ||
      typeof input.description !== "string" ||
      !input.description.trim() ||
      input.description.length > 5_000 ||
      typeof input.context !== "string" ||
      input.context.length > 10_000 ||
      (input.install !== undefined && !uuid(input.install))
    )
      return json({ error: "Invalid report" }, 400);
    const attachments = parseDevsAttachmentManifest(input.attachments);
    if (!attachments) return json({ error: "Invalid report" }, 400);
    return enqueue({
      job: {
        id: input.id as string,
        engine: input.engine as CloudJob["engine"],
        description: redactDevsReportText(input.description as string, 5_000),
        context: redactDevsReportText(input.context as string, 10_000),
        ...(attachments.length
          ? { attachments: attachments.map((attachment) => ({ ...attachment, stored: false })) }
          : {}),
      },
      readHash: await hash(bearer),
      // Older apps send no installation ID; they share one allowance.
      install: (await hash(`install:${input.install ?? "legacy"}`)).slice(0, 32),
    });
  };
}
