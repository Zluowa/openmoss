/**
 * Read-only inspection of the developer report queue (and optional attachment download):
 *
 *   bun scripts/devs/list.ts [--status all|queued|running|pull-request|failed] [--json] [--save <dir>]
 *
 * The worker credential is read through DPAPI (like `resolve.ts`) and never printed.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import { DEVS_QUEUE_URL, readWorkerToken } from "./resolve";

export type DevsListStatusFilter = "all" | "queued" | "running" | "pull-request" | "failed";

export interface DevsListArgs {
  readonly status: DevsListStatusFilter;
  readonly json: boolean;
  readonly saveDir: string | null;
}

export interface DevsQueueAttachmentEntry {
  readonly index: number;
  readonly name: string;
  readonly kind: "image" | "text";
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly stored: boolean;
}

export interface DevsQueueJobSummary {
  readonly id: string;
  readonly engine: "codex" | "claude";
  readonly status: "queued" | "running" | "pull-request" | "failed";
  readonly resolution: "in-progress" | "fixed" | null;
  readonly expired: boolean;
  readonly description: string;
  readonly context: string;
  readonly message: string;
  readonly pullRequestUrl: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly attachments: readonly DevsQueueAttachmentEntry[];
  readonly history: readonly unknown[];
}

export interface DevsQueueListResponse {
  readonly day: string;
  readonly budget: {
    readonly accepted: number;
    readonly claimed: number;
    readonly reportLimit: number;
    readonly jobLimit: number;
    readonly installLimit: number;
  };
  readonly total: number;
  readonly counts: Record<string, number>;
  readonly jobs: readonly DevsQueueJobSummary[];
}

const VALID_STATUSES = new Set<DevsListStatusFilter>([
  "all",
  "queued",
  "running",
  "pull-request",
  "failed",
]);
const USAGE =
  "Usage: bun scripts/devs/list.ts [--status all|queued|running|pull-request|failed] [--json] [--save <dir>]";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "text/plain": "txt",
};

/** Parses CLI flags for `scripts/devs/list.ts`. */
export function parseDevsListArgs(argv: readonly string[]): DevsListArgs {
  let status: DevsListStatusFilter = "all";
  let json = false;
  let saveDir: string | null = null;
  const fail = (problem: string): never => {
    throw new Error(`${problem}\n${USAGE}`);
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) fail(`${argument} needs a value.`);
      return next as string;
    };
    if (argument === "--json") {
      json = true;
    } else if (argument === "--status") {
      const candidate = value() as DevsListStatusFilter;
      if (!VALID_STATUSES.has(candidate)) {
        fail(`Invalid status "${candidate}".`);
      }
      status = candidate;
    } else if (argument === "--save") {
      saveDir = path.resolve(value());
    } else if (argument.startsWith("--")) {
      fail(`Unknown option ${argument}.`);
    } else {
      fail(`Unexpected argument ${argument}.`);
    }
  }
  return { status, json, saveDir };
}

async function downloadStoredAttachments(
  saveDir: string,
  jobs: readonly DevsQueueJobSummary[],
  token: string,
): Promise<Record<string, readonly string[]>> {
  const saved: Record<string, string[]> = {};
  for (const job of jobs) {
    const stored = job.attachments.filter((attachment) => attachment.stored);
    if (!stored.length) continue;
    const jobDir = path.join(saveDir, "attachments", job.id);
    await fs.mkdir(jobDir, { recursive: true });
    const paths: string[] = [];
    for (const attachment of stored) {
      const response = await fetch(
        `${DEVS_QUEUE_URL}/worker/${job.id}/attachment/${attachment.index}`,
        {
          method: "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        console.error(
          `Attachment ${attachment.index} for ${job.id} is no longer stored in the queue (404); skipping.`,
        );
        continue;
      }
      if (!response.ok) {
        const text = (await response.text()).split(token).join("[redacted]");
        throw new Error(
          `Failed to download attachment ${attachment.index} for ${job.id} (HTTP ${response.status}): ${text}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const extension = EXTENSION_BY_MIME[attachment.mimeType] ?? "bin";
      const filePath = path.join(jobDir, `${attachment.index}.${extension}`);
      await fs.writeFile(filePath, bytes);
      paths.push(filePath);
    }
    if (paths.length) saved[job.id] = paths;
  }
  return saved;
}

async function main() {
  const args = parseDevsListArgs(process.argv.slice(2));
  const token = await readWorkerToken();
  const response = await fetch(`${DEVS_QUEUE_URL}/worker/list`, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = (await response.text()).split(token).join("[redacted]");
  if (!response.ok) {
    console.error(`The queue refused the list request (HTTP ${response.status}): ${text}`);
    process.exit(1);
  }
  const payload = JSON.parse(text) as DevsQueueListResponse;
  const jobs =
    args.status === "all" ? payload.jobs : payload.jobs.filter((job) => job.status === args.status);
  const filtered: DevsQueueListResponse = {
    ...payload,
    total: jobs.length,
    jobs,
  };
  let downloaded: Record<string, readonly string[]> = {};
  if (args.saveDir) {
    await fs.mkdir(args.saveDir, { recursive: true });
    downloaded = await downloadStoredAttachments(args.saveDir, jobs, token);
    await fs.writeFile(
      path.join(args.saveDir, "reports.json"),
      JSON.stringify({ ...filtered, downloadedAttachments: downloaded }, null, 2),
      "utf8",
    );
  }
  if (args.json) {
    console.log(JSON.stringify({ ...filtered, downloadedAttachments: downloaded }, null, 2));
    return;
  }
  console.log(
    `Queue day=${filtered.day} accepted=${filtered.budget.accepted}/${filtered.budget.reportLimit} claimed=${filtered.budget.claimed}/${filtered.budget.jobLimit} total=${payload.total} shown=${jobs.length}`,
  );
  console.log(
    `Counts: queued=${payload.counts.queued ?? 0} running=${payload.counts.running ?? 0} pull-request=${payload.counts["pull-request"] ?? 0} failed=${payload.counts.failed ?? 0}`,
  );
  for (const job of jobs) {
    const created = new Date(job.createdAt).toISOString();
    const res = job.resolution ? ` resolution=${job.resolution}` : "";
    const exp = job.expired ? " expired=true" : "";
    const att = job.attachments.length
      ? ` attachments=${job.attachments.filter((a) => a.stored).length}/${job.attachments.length}`
      : "";
    console.log(
      `- ${job.id} [${job.status}${res}${exp}] engine=${job.engine} created=${created}${att}`,
    );
    console.log(`  desc: ${job.description.replace(/\s+/g, " ").slice(0, 160)}`);
    if (downloaded[job.id]?.length) {
      console.log(`  files: ${downloaded[job.id]!.join(", ")}`);
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
