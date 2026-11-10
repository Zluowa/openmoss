import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { redactDiagnosticText } from "@moss/shared/diagnosticsRedaction";
import {
  DEVS_DEFAULT_DAILY_JOB_LIMIT,
  devsAttachmentBytesMatch,
  devsUtcDay,
  parseDevsAttachmentManifest,
} from "@moss/shared/devsReport";
import { writeFileStringAtomically } from "./atomicWrite";
import type { RepairAttachment, RepairReport } from "./devsRepairRunner";
import type { DevsFetch } from "./devsReports";

interface ClaimedAttachment {
  index: number;
  name: string;
  kind: "image" | "text";
  mimeType: string;
  size: number;
  sha256: string;
}
interface Journal {
  claimId: string;
  stage: "claiming" | "running" | "completed";
  report?: Omit<RepairReport, "attachments"> & { attachments?: ClaimedAttachment[] };
  lease?: string;
  pullRequestUrl?: string | null;
}
interface DailyBudget {
  day: string;
  claimed: number;
}
export class WorkerRequestError extends Error {
  constructor(readonly status: number) {
    super(`Developer worker request failed (${status}).`);
  }
}

/**
 * A short, secret-free reason for a failed queue round, for the worker's log: the HTTP
 * status, a timeout, or the network error's code. Never the message, which may echo a URL.
 */
export function describeWorkerError(error: unknown): string {
  if (error instanceof WorkerRequestError) return `HTTP ${error.status}`;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    const code =
      (error as { code?: unknown }).code ??
      (error.cause as { code?: unknown } | undefined)?.code ??
      null;
    if (typeof code === "string" && /^[A-Za-z_]{2,40}$/.test(code)) return `network ${code}`;
    if (error instanceof TypeError) return "network error";
    if (error instanceof SyntaxError) return "invalid response";
    return error.name && /^[A-Za-z]{2,40}$/.test(error.name) ? error.name : "error";
  }
  return "error";
}

/** Durable, outbound-only developer worker. A crash never replays an uncertain code execution/push. */
export class DevsOutboundWorker {
  private readonly endpoint: URL;
  private readonly file: string;
  private readonly budgetFile: string;
  private working = false;
  constructor(
    private readonly options: {
      queueUrl: string;
      token: string;
      stateDir: string;
      engines?: readonly ("claude" | "codex")[];
      ready?: () => Promise<boolean>;
      repair: (report: RepairReport, authorizePublish: () => Promise<void>) => Promise<string>;
      fetcher?: DevsFetch;
      /** Jobs this worker starts per UTC day. Once used, it stops claiming until tomorrow. */
      dailyJobLimit?: number;
      now?: () => number;
    },
  ) {
    this.endpoint = new URL(options.queueUrl);
    if (
      (this.endpoint.protocol !== "https:" &&
        !(
          this.endpoint.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(this.endpoint.hostname)
        )) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.pathname !== "/" ||
      this.endpoint.search ||
      this.endpoint.hash ||
      options.token.length < 32
    )
      throw new Error("Invalid developer worker endpoint or credential.");
    this.file = path.join(options.stateDir, "worker-journal.json");
    this.budgetFile = path.join(options.stateDir, "worker-budget.json");
  }
  private async budget(): Promise<DailyBudget> {
    const day = devsUtcDay((this.options.now ?? Date.now)());
    try {
      const saved = JSON.parse(await fs.readFile(this.budgetFile, "utf8")) as DailyBudget;
      if (saved.day === day && Number.isSafeInteger(saved.claimed) && saved.claimed >= 0)
        return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    return { day, claimed: 0 };
  }
  private save(journal: Journal) {
    return Effect.runPromise(
      writeFileStringAtomically({ filePath: this.file, contents: JSON.stringify(journal) }),
    );
  }
  private async request(route: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await (this.options.fetcher ?? fetch)(new URL(route, this.endpoint), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkerRequestError(response.status);
    }
    return (await response.json()) as Record<string, unknown>;
  }
  /**
   * Fetches what the queue received with the report into the worker's state folder, outside
   * any checkout, and keeps it with the retained job. A missing or damaged one is left out and
   * the repair is told so; it never stops the job.
   */
  private async downloadAttachments(journal: Journal): Promise<RepairAttachment[]> {
    const declared = journal.report?.attachments ?? [];
    if (!declared.length) return [];
    const folder = path.join(this.options.stateDir, "attachments", journal.report!.id);
    await fs.mkdir(folder, { recursive: true });
    const result: RepairAttachment[] = [];
    for (const attachment of declared) {
      const extension =
        { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" }[attachment.mimeType] ??
        "txt";
      const file = path.join(folder, `${attachment.index}.${extension}`);
      try {
        const response = await (this.options.fetcher ?? fetch)(
          new URL(`/worker/${journal.report!.id}/attachment`, this.endpoint),
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
            headers: {
              authorization: `Bearer ${this.options.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ lease: journal.lease, index: attachment.index }),
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new WorkerRequestError(response.status);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (
          bytes.byteLength !== attachment.size ||
          createHash("sha256").update(bytes).digest("hex") !== attachment.sha256 ||
          !devsAttachmentBytesMatch(attachment.mimeType, bytes)
        )
          throw new Error("Attachment does not match its receipt.");
        await fs.writeFile(file, bytes);
        result.push({
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          path: file,
        });
      } catch (error) {
        console.error(
          `${new Date().toISOString()} Developer report attachment ${attachment.index} was not received (${describeWorkerError(error)}); the repair continues without it.`,
        );
        result.push({
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          path: null,
        });
      }
    }
    return result;
  }
  async runOnce(): Promise<boolean> {
    if (this.working) return false;
    this.working = true;
    try {
      let journal: Journal;
      try {
        journal = JSON.parse(await fs.readFile(this.file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        journal = { claimId: randomUUID(), stage: "claiming" };
        await this.save(journal);
      }
      if (
        !/^[0-9a-f-]{36}$/i.test(journal.claimId) ||
        !["claiming", "running", "completed"].includes(journal.stage)
      )
        throw new Error("Invalid developer worker journal; inspect it before restarting.");
      const interrupted = journal.stage === "running";
      if (journal.stage === "claiming") {
        // Keep queued work in the cloud until the local model router is available.
        if (this.options.ready && !(await this.options.ready())) return false;
        // The day's job budget bounds model and CI cost: queued reports wait for tomorrow.
        const budget = await this.budget();
        if (budget.claimed >= (this.options.dailyJobLimit ?? DEVS_DEFAULT_DAILY_JOB_LIMIT))
          return false;
        const result = await this.request("/worker/claim", {
          claimId: journal.claimId,
          engines: this.options.engines ?? ["codex"],
        });
        if (result.job === null) {
          await fs.unlink(this.file);
          return false;
        }
        const report = result.report as Journal["report"] | undefined;
        const attachments = parseDevsAttachmentManifest(
          (report?.attachments ?? []).map(({ index: _index, ...entry }) => entry),
        );
        if (
          !report ||
          !/^[0-9a-f-]{36}$/i.test(report.id) ||
          !(this.options.engines ?? ["codex"]).includes(report.engine) ||
          typeof report.description !== "string" ||
          report.description.length > 5_000 ||
          typeof report.context !== "string" ||
          report.context.length > 10_000 ||
          typeof result.lease !== "string" ||
          result.lease.length < 32 ||
          result.lease.length > 256 ||
          !attachments ||
          (report.attachments ?? []).some(
            (entry) => !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index > 7,
          )
        )
          throw new Error("Invalid developer job claim.");
        // Counted before the job runs, so a crash can only over-count.
        await Effect.runPromise(
          writeFileStringAtomically({
            filePath: this.budgetFile,
            contents: JSON.stringify({ ...budget, claimed: budget.claimed + 1 }),
          }),
        );
        journal = { ...journal, stage: "running", report, lease: result.lease };
        await this.save(journal);
      }
      if (!journal.report || !journal.lease)
        throw new Error("Incomplete developer worker journal.");
      if (interrupted) {
        journal.stage = "completed";
        journal.pullRequestUrl = null;
        await this.save(journal);
      }
      if (journal.stage === "running") {
        const current = journal;
        const heartbeat = async () => {
          const receipt = await this.request(`/worker/${current.report!.id}/heartbeat`, {
            lease: current.lease,
          });
          if (receipt.status !== "running")
            throw new Error("Developer job lease is no longer active; publication stopped.");
        };
        const timer = setInterval(() => {
          void heartbeat().catch(() => {});
        }, 30_000);
        timer.unref();
        let pullRequestUrl: string | null = null;
        try {
          await heartbeat();
          const { attachments: _declared, ...report } = journal.report;
          const attachments = await this.downloadAttachments(current);
          pullRequestUrl = await this.options.repair(
            { ...report, ...(attachments.length ? { attachments } : {}) },
            heartbeat,
          );
        } catch (error) {
          console.error(
            `${new Date().toISOString()} Developer repair ${journal.report.id} failed; inspect the retained job directory.`,
            redactDiagnosticText(
              (error instanceof Error ? error.message : "Error")
                .split(this.options.token)
                .join("[redacted]"),
              { maxLength: 2_000 },
            ),
          );
        } finally {
          clearInterval(timer);
        }
        journal.stage = "completed";
        journal.pullRequestUrl = pullRequestUrl;
        await this.save(journal);
      }
      try {
        await this.request(`/worker/${journal.report.id}/complete`, {
          lease: journal.lease,
          pullRequestUrl: journal.pullRequestUrl ?? null,
        });
      } catch (error) {
        if (!(error instanceof WorkerRequestError) || ![404, 409].includes(error.status))
          throw error;
        // The remote receipt may have expired during a long shutdown. Preserve evidence, never replay.
        await fs.rename(
          this.file,
          path.join(
            path.dirname(this.file),
            `worker-closed-${journal.report.id}-${Date.now()}.json`,
          ),
        );
        return true;
      }
      await fs.unlink(this.file);
      return true;
    } finally {
      this.working = false;
    }
  }
}
