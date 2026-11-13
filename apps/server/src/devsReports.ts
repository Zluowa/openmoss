import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  DevsReportState,
  type DevsReportPreview,
  type DevsReportSubmitInput,
  type OrchestrationThread,
} from "@moss/contracts";
import {
  DEVS_ATTACHMENT_LIMITS,
  DEVS_CONSENT_REQUIRED_MESSAGE,
  DEVS_DEFAULT_INSTALL_DAILY_LIMIT,
  MOSS_DEVS_FALLBACK_REPORT_URL,
  MOSS_DEVS_PUBLIC_REPORT_URL,
  MOSS_DEVS_REPORTS_ENABLED,
  devsAttachmentBytesMatch,
  devsAttachmentName,
  devsUtcDay,
  parseDevsInvocation,
  redactDevsReportText,
  type DevsAttachmentManifestEntry,
} from "@moss/shared/devsReport";
import { Effect } from "effect";
import { isMossConnectionLevelFailure } from "./account/mossServiceEntries";
import { writeFileStringAtomically } from "./atomicWrite";

const MAX_REPORTS = 200;
const REMOTE_TIMEOUT_MS = 10_000;
const DRAFT_TTL_MS = 15 * 60_000;
const MAX_DRAFTS = 20;
const clean = (value: string, maxLength = 2_000) => redactDevsReportText(value, maxLength);

/**
 * Only the explicit report, allowlisted state/error facts and the attachments the person
 * chose (and saw in the confirmation) leave the server. No transcript.
 */
export function curateDevsContext(thread: OrchestrationThread): string {
  const problems = thread.activities
    .filter((activity) => activity.tone === "error" || /error|fail|disconnect/i.test(activity.kind))
    .slice(-12)
    .map((activity) => clean(activity.summary, 500));
  return clean(
    [
      `Provider: ${thread.modelSelection.provider}`,
      `Model: ${thread.modelSelection.model}`,
      `Session status: ${thread.session?.status ?? "none"}`,
      `Latest turn: ${thread.latestTurn?.state ?? "none"}`,
      `Messages: ${thread.messages.length}; activities: ${thread.activities.length}`,
      "Recent observed problems:",
      ...(problems.length ? problems : ["No errors observed; reproduce the user's description."]),
    ].join("\n"),
    10_000,
  );
}

/** App feedback never reads a conversation, project, path, log or arbitrary diagnostic object. */
export function curateFeedbackContext(
  facts: NonNullable<DevsReportSubmitInput["feedbackContext"]>,
): string {
  return clean(
    [
      "Report source: Moss feedback form",
      `App version: ${facts.appVersion}`,
      `Platform: ${facts.platform}`,
      `Language: ${facts.language}`,
      `Category: ${facts.category ?? "other"}`,
      `Provider: ${facts.provider ?? "none"}`,
      `Model: ${facts.model ?? "none"}`,
    ].join("\n"),
    2_000,
  );
}

export function devsEndpoint(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export type DevsFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
export interface DevsReportsOptions {
  /** The app's error-report switch. While it is off nothing is prepared or delivered. */
  readonly consent?: () => Promise<boolean>;
  readonly now?: () => number;
}
interface DraftAttachment extends DevsAttachmentManifestEntry {
  bytes: Buffer;
}
interface DevsDraft {
  threadId: string | null;
  text: string;
  engine: DevsReportState["engine"];
  description: string;
  context: string;
  attachments: DraftAttachment[];
  expiresAt: number;
}
interface StoredAttachment extends DevsAttachmentManifestEntry {
  uploaded: boolean;
}
type MutableState = {
  -readonly [Key in Exclude<
    keyof DevsReportState,
    "delivered" | "attachments"
  >]: DevsReportState[Key];
};
interface StoredReport {
  readToken?: string;
  state: MutableState;
  context: string;
  delivered: boolean;
  attempts: number;
  nextAttemptAt: number;
  /** Bytes live in devs-attachments/<id>/<index> until the queue has them. */
  attachments?: StoredAttachment[];
  /** The report left the queue before every attachment arrived; they are not sent again. */
  attachmentsMissed?: boolean;
}

/** Decodes and checks what the composer sent. Text files are redacted like the description. */
export function prepareDevsAttachments(
  inputs: DevsReportSubmitInput["attachments"],
): DraftAttachment[] {
  const list = inputs ?? [];
  if (list.length > DEVS_ATTACHMENT_LIMITS.maxCount)
    throw new Error(
      `A report can carry up to ${DEVS_ATTACHMENT_LIMITS.maxCount} images or text files.`,
    );
  let total = 0;
  return list.map((input) => {
    let bytes: Buffer = Buffer.from(input.dataBase64, "base64");
    const expectedKind = input.mimeType === "text/plain" ? "text" : "image";
    if (input.kind !== expectedKind || !devsAttachmentBytesMatch(input.mimeType, bytes))
      throw new Error("An attachment could not be read. Remove it and try again.");
    if (input.kind === "text") {
      const text = bytes.toString("utf8").replaceAll("\r\n", "\n");
      bytes = Buffer.from(clean(text, DEVS_ATTACHMENT_LIMITS.textBytes), "utf8");
    }
    const limit =
      input.kind === "image" ? DEVS_ATTACHMENT_LIMITS.imageBytes : DEVS_ATTACHMENT_LIMITS.textBytes;
    if (bytes.length < 1 || bytes.length > limit)
      throw new Error("An attachment is too large to send with a report.");
    total += bytes.length;
    if (total > DEVS_ATTACHMENT_LIMITS.totalBytes)
      throw new Error("The attachments are too large to send with one report.");
    return {
      name: devsAttachmentName(input.name),
      kind: input.kind,
      mimeType: input.mimeType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  });
}

/** One instance per server, a durable outbox, stable IDs, and one serialized network operation at a time. */
export class DevsReports {
  private reports: StoredReport[] = [];
  private loaded = false;
  private polling = false;
  private chain = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly endpoint: URL | null;
  /** The public queue's older hostname; null for a configured queue. */
  private readonly fallbackEndpoint: URL | null;
  private readonly token: string | undefined;
  private readonly file: string;
  private readonly defaultEngine: "claude" | "codex";
  private readonly installFile: string;
  private installId: Promise<string> | null = null;
  /** What the user was shown, keyed by report ID. Submission sends exactly this. */
  private readonly drafts = new Map<string, DevsDraft>();
  private readonly now: () => number;

  constructor(
    private readonly stateDir: string,
    private readonly fetcher: DevsFetch = fetch,
    env: NodeJS.ProcessEnv = process.env,
    private readonly options: DevsReportsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.installFile = path.join(stateDir, "devs-install-id");
    this.endpoint = devsEndpoint(
      env.MOSS_DEVS_REPORT_URL ?? (MOSS_DEVS_REPORTS_ENABLED ? MOSS_DEVS_PUBLIC_REPORT_URL : ""),
    );
    this.fallbackEndpoint =
      env.MOSS_DEVS_REPORT_URL === undefined && this.endpoint !== null
        ? devsEndpoint(MOSS_DEVS_FALLBACK_REPORT_URL)
        : null;
    this.token = env.MOSS_DEVS_REPORT_TOKEN;
    this.defaultEngine = env.MOSS_DEVS_DEFAULT_ENGINE === "claude" ? "claude" : "codex";
    this.file = path.join(stateDir, "devs-reports.json");
    this.timer = setInterval(() => {
      void this.poll().catch(() => {});
    }, 15_000);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async load() {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as StoredReport[];
      if (!Array.isArray(raw) || raw.length > MAX_REPORTS)
        throw new Error("Invalid report outbox.");
      for (const entry of raw) {
        Schema.decodeUnknownSync(DevsReportState)(entry.state);
        if (
          (entry.attachments !== undefined && !Array.isArray(entry.attachments)) ||
          typeof entry.context !== "string" ||
          typeof entry.delivered !== "boolean" ||
          !Number.isSafeInteger(entry.attempts) ||
          !Number.isFinite(entry.nextAttemptAt)
        ) {
          throw new Error("Invalid report outbox.");
        }
      }
      this.reports = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private attachmentDir(id: string) {
    return path.join(this.stateDir, "devs-attachments", id);
  }
  /** Drops local attachment copies once the queue has them or can no longer take them. */
  private async releaseAttachments(entry: StoredReport) {
    await fs.rm(this.attachmentDir(entry.state.id), { recursive: true, force: true });
  }
  private save() {
    return Effect.runPromise(
      writeFileStringAtomically({
        filePath: this.file,
        contents: JSON.stringify(this.reports),
      }),
    );
  }
  /**
   * One request to the queue at `endpoint`, built by `request`. When it fails below HTTP and
   * the public queue is in use, it is sent once more to the queue's older hostname. Every such
   * request names its report ID, which the queue deduplicates, so a repeat changes nothing.
   */
  private async fetchQueue(
    request: (endpoint: URL) => { readonly url: URL; readonly init: RequestInit },
  ): Promise<Response> {
    const first = request(this.endpoint!);
    try {
      return await this.fetcher(first.url, first.init);
    } catch (cause) {
      if (this.fallbackEndpoint === null || !isMossConnectionLevelFailure(cause)) throw cause;
      const again = request(this.fallbackEndpoint);
      return this.fetcher(again.url, again.init);
    }
  }
  get configured() {
    return this.endpoint !== null;
  }
  private async consented() {
    try {
      return (await this.options.consent?.()) ?? true;
    } catch {
      return false;
    }
  }
  /** A random ID used only to limit how many reports one installation sends. */
  private install() {
    this.installId ??= (async () => {
      try {
        const saved = (await fs.readFile(this.installFile, "utf8")).trim();
        if (/^[0-9a-f-]{36}$/i.test(saved)) return saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const created = randomUUID();
      await Effect.runPromise(
        writeFileStringAtomically({ filePath: this.installFile, contents: created }),
      );
      return created;
    })();
    const pending = this.installId;
    pending.catch(() => {
      if (this.installId === pending) this.installId = null;
    });
    return pending;
  }
  private assertDailyLimit() {
    const today = devsUtcDay(this.now());
    const sentToday = this.reports.filter(
      (entry) => devsUtcDay(Date.parse(entry.state.createdAt)) === today,
    ).length;
    if (sentToday >= DEVS_DEFAULT_INSTALL_DAILY_LIMIT)
      throw new Error(
        `You can send up to ${DEVS_DEFAULT_INSTALL_DAILY_LIMIT} developer reports a day. Try again tomorrow.`,
      );
  }
  /**
   * Builds the exact report for the user to confirm. Nothing leaves the app until submit is
   * called with the same ID and text, and submit sends only what this returned.
   */
  prepare(
    input: DevsReportSubmitInput,
    thread: OrchestrationThread | null,
    account: { readonly phoneAccount: boolean },
  ): Promise<DevsReportPreview> {
    return this.serialize(async () => {
      await this.load();
      if (
        (!input.threadId && !input.feedbackContext) ||
        Boolean(input.threadId) !== Boolean(thread)
      )
        throw new Error("Open a saved chat or provide app feedback details.");
      if (!this.configured) throw new Error("The Moss developer service is not connected yet.");
      if (!(await this.consented())) throw new Error(DEVS_CONSENT_REQUIRED_MESSAGE);
      const existing = this.reports.find((entry) => entry.state.id === input.id);
      if (existing) {
        if (existing.state.threadId !== (input.threadId ?? null))
          throw new Error("Report ID already in use.");
        // A retry after a lost response: show what was already queued; submit is idempotent.
        return {
          id: input.id,
          scope: existing.state.threadId === null ? "application" : "thread",
          engine: existing.state.engine,
          description: existing.state.description,
          context: existing.context,
          processedOutsideMainlandChina: account.phoneAccount,
          attachments: (existing.attachments ?? []).map((attachment) => ({
            name: attachment.name,
            kind: attachment.kind,
            sizeBytes: attachment.size,
          })),
        };
      }
      const invocation = parseDevsInvocation(input.text);
      if (!invocation?.description) throw new Error("Describe the problem after @devs.");
      this.assertDailyLimit();
      const now = this.now();
      for (const [id, draft] of this.drafts) if (draft.expiresAt <= now) this.drafts.delete(id);
      this.drafts.delete(input.id);
      while (this.drafts.size >= MAX_DRAFTS) {
        const oldest = this.drafts.keys().next();
        if (oldest.done) break;
        this.drafts.delete(oldest.value);
      }
      const draft: DevsDraft = {
        threadId: input.threadId ?? null,
        text: input.text,
        engine: input.engine ?? invocation.engine ?? this.defaultEngine,
        description: clean(invocation.description, 5_000),
        context: thread ? curateDevsContext(thread) : curateFeedbackContext(input.feedbackContext!),
        attachments: prepareDevsAttachments(input.attachments),
        expiresAt: now + DRAFT_TTL_MS,
      };
      this.drafts.set(input.id, draft);
      return {
        id: input.id,
        scope: draft.threadId === null ? "application" : "thread",
        engine: draft.engine,
        description: draft.description,
        context: draft.context,
        processedOutsideMainlandChina: account.phoneAccount,
        attachments: draft.attachments.map((attachment) => ({
          name: attachment.name,
          kind: attachment.kind,
          sizeBytes: attachment.size,
          ...(attachment.kind === "text" ? { text: attachment.bytes.toString("utf8") } : {}),
        })),
      };
    });
  }
  list(threadId: string) {
    return this.serialize(async () => {
      await this.load();
      return {
        configured: this.configured,
        reports: this.reports
          .filter((entry) => entry.state.threadId === threadId)
          .map(
            (entry): DevsReportState => ({
              ...entry.state,
              delivered: entry.delivered,
              ...(entry.attachments?.length
                ? {
                    attachments: {
                      count: entry.attachments.length,
                      delivered: entry.attachments.filter((attachment) => attachment.uploaded)
                        .length,
                      missed: entry.attachmentsMissed === true,
                    },
                  }
                : {}),
            }),
          ),
      };
    });
  }
  /** Sends what prepare showed for this ID, and nothing else. */
  submit(input: DevsReportSubmitInput) {
    return this.serialize(async () => {
      await this.load();
      const existing = this.reports.find((entry) => entry.state.id === input.id);
      if (existing) {
        if (existing.state.threadId !== (input.threadId ?? null))
          throw new Error("Report ID already in use.");
        return { ...existing.state };
      }
      if (!this.configured) throw new Error("The Moss developer service is not connected yet.");
      if (!(await this.consented())) throw new Error(DEVS_CONSENT_REQUIRED_MESSAGE);
      const draft = this.drafts.get(input.id);
      if (
        !draft ||
        draft.expiresAt <= this.now() ||
        draft.threadId !== (input.threadId ?? null) ||
        draft.text !== input.text ||
        (input.engine !== undefined && input.engine !== draft.engine)
      )
        throw new Error("Review the report again before sending it.");
      this.assertDailyLimit();
      const before = [...this.reports];
      if (this.reports.length >= MAX_REPORTS) {
        const completed = this.reports.findIndex((entry) =>
          ["pull-request", "failed"].includes(entry.state.status),
        );
        if (completed < 0) throw new Error("The developer report queue is full. Try again later.");
        this.reports.splice(completed, 1);
      }
      const now = new Date(this.now()).toISOString();
      const state: DevsReportState = {
        id: input.id,
        threadId: input.threadId ?? null,
        engine: draft.engine,
        description: draft.description,
        status: "queued",
        message: "Queued for the Moss developers.",
        pullRequestUrl: null,
        createdAt: now,
        updatedAt: now,
      };
      const attachments = draft.attachments.map(({ bytes: _bytes, ...rest }) => ({
        ...rest,
        uploaded: false,
      }));
      this.reports.push({
        ...(!this.token ? { readToken: randomUUID() + randomUUID() } : {}),
        state,
        context: draft.context,
        delivered: false,
        attempts: 0,
        nextAttemptAt: 0,
        ...(attachments.length ? { attachments } : {}),
      });
      try {
        if (attachments.length) {
          const folder = this.attachmentDir(input.id);
          await fs.mkdir(folder, { recursive: true });
          for (const [index, attachment] of draft.attachments.entries())
            await fs.writeFile(path.join(folder, String(index)), attachment.bytes);
        }
        await this.save();
      } catch (error) {
        this.reports = before;
        await fs.rm(this.attachmentDir(input.id), { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      this.drafts.delete(input.id);
      return { ...state };
    });
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.serialize(() => this.load());
      if (!this.configured || !this.endpoint) return;
      const consented = await this.consented();
      for (const entry of [...this.reports]) {
        if (
          ["pull-request", "failed"].includes(entry.state.status) ||
          this.now() < entry.nextAttemptAt ||
          // A report waiting for delivery stays here while error reports are switched off.
          (!entry.delivered && !consented)
        )
          continue;
        try {
          const install = entry.delivered ? undefined : await this.install();
          const response = await this.fetchQueue((endpoint) => {
            const url = new URL(endpoint);
            url.pathname = `${url.pathname.replace(/\/$/, "")}/${entry.state.id}`;
            return {
              url: entry.delivered ? url : endpoint,
              init: {
                method: entry.delivered ? "GET" : "POST",
                redirect: "error",
                headers: {
                  authorization: `Bearer ${this.token ?? entry.readToken}`,
                  "content-type": "application/json",
                },
                ...(entry.delivered
                  ? {}
                  : {
                      body: JSON.stringify({
                        id: entry.state.id,
                        engine: entry.state.engine,
                        description: entry.state.description,
                        context: entry.context,
                        install,
                        ...(entry.attachments?.length
                          ? {
                              attachments: entry.attachments.map(
                                ({ uploaded: _uploaded, ...manifest }) => manifest,
                              ),
                            }
                          : {}),
                      }),
                    }),
                signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
              },
            };
          });
          if (!response.ok) {
            await response.body?.cancel();
            if (response.status === 404 && entry.delivered) {
              entry.state.status = "failed";
              entry.state.message =
                "The remote receipt is no longer available. Your original report is saved here; it will not be submitted again automatically.";
            } else if (response.status === 429 && !entry.delivered) {
              // A queue cap: wait as long as the queue asks, between a minute and a day.
              const retryAfter = Number(response.headers.get("retry-after"));
              entry.nextAttemptAt =
                this.now() +
                1000 *
                  (Number.isFinite(retryAfter)
                    ? Math.min(Math.max(retryAfter, 60), 86_400)
                    : 3_600);
              entry.state.message =
                "The developer service has reached its daily report limit. Your report is saved here and will be sent later.";
              entry.state.updatedAt = new Date(this.now()).toISOString();
              await this.serialize(() => this.save());
              continue;
            } else if ([400, 401, 403, 413].includes(response.status)) {
              entry.state.status = "failed";
              entry.state.message =
                "The developer service refused the report. Check its connection settings.";
            } else throw new Error("Developer service temporarily unavailable.");
          } else {
            const bodyText = await response.text();
            if (bodyText.length > 32_000) throw new Error("Invalid developer service response.");
            const body = JSON.parse(bodyText) as Record<string, unknown>;
            if (
              body.id !== entry.state.id ||
              !["queued", "running", "pull-request", "failed"].includes(String(body.status))
            ) {
              throw new Error("Invalid developer service response.");
            }
            const pr =
              typeof body.pullRequestUrl === "string" &&
              /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.pullRequestUrl)
                ? body.pullRequestUrl
                : null;
            if (body.status === "pull-request" && !pr)
              throw new Error("Missing pull request receipt.");
            entry.delivered = true;
            entry.state.status = body.status as DevsReportState["status"];
            entry.state.pullRequestUrl = pr;
            entry.state.message = clean(String(body.message ?? "Report received."), 1_000);
            entry.attempts = 0;
            await this.uploadAttachments(entry);
          }
          entry.state.updatedAt = new Date(this.now()).toISOString();
          entry.nextAttemptAt = this.now() + 15_000;
        } catch {
          entry.attempts += 1;
          entry.nextAttemptAt =
            this.now() + Math.min(300_000, 15_000 * 2 ** Math.min(entry.attempts, 5));
          entry.state.message = entry.delivered
            ? "Waiting for an update from the developer service."
            : "Saved here. Delivery will retry when the developer service reconnects.";
        }
        if (
          ["pull-request", "failed"].includes(entry.state.status) &&
          entry.attachments?.some((attachment) => !attachment.uploaded) &&
          !entry.attachmentsMissed
        ) {
          entry.attachmentsMissed = true;
          await this.releaseAttachments(entry);
        }
        await this.serialize(() => this.save());
      }
    } finally {
      this.polling = false;
    }
  }
  /**
   * Uploads attachments after the queue has the report, one request each. A queue that does
   * not know attachments yet (404) keeps them here and is asked again on the next poll; once
   * the report has left the queue they can no longer reach the repair and are dropped.
   */
  private async uploadAttachments(entry: StoredReport) {
    const all = entry.attachments ?? [];
    if (
      !all.some((attachment) => !attachment.uploaded) ||
      entry.attachmentsMissed ||
      !this.endpoint
    )
      return;
    if (entry.state.status !== "queued") {
      entry.attachmentsMissed = true;
      await this.releaseAttachments(entry);
      return;
    }
    for (const [index, attachment] of all.entries()) {
      if (attachment.uploaded) continue;
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(path.join(this.attachmentDir(entry.state.id), String(index)));
      } catch {
        entry.attachmentsMissed = true;
        return;
      }
      const response = await this.fetchQueue((endpoint) => {
        const url = new URL(endpoint);
        url.pathname = `${url.pathname.replace(/\/$/, "")}/${entry.state.id}/attachments/${index}`;
        return {
          url,
          init: {
            method: "PUT",
            redirect: "error",
            headers: {
              authorization: `Bearer ${this.token ?? entry.readToken}`,
              "content-type": attachment.mimeType,
            },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS * 3),
          },
        };
      });
      await response.body?.cancel();
      // An older queue without attachment routes: ask again on the next poll.
      if (response.status === 404 || response.status === 405) return;
      // The queue no longer accepts them for this report (already claimed or refused).
      if ([400, 409, 413].includes(response.status)) {
        entry.attachmentsMissed = true;
        await this.releaseAttachments(entry);
        return;
      }
      if (!response.ok) throw new Error("Developer service temporarily unavailable.");
      attachment.uploaded = true;
    }
    await this.releaseAttachments(entry);
  }
}
