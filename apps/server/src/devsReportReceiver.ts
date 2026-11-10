import * as fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Effect } from "effect";
import { redactDiagnosticText } from "@moss/shared/diagnosticsRedaction";
import { writeFileStringAtomically } from "./atomicWrite";
import type { RepairReport } from "./devsRepairRunner";

interface Job extends RepairReport {
  status: "queued" | "running" | "pull-request" | "failed";
  message: string;
  pullRequestUrl: string | null;
}
const clean = (text: string, maxLength: number) => redactDiagnosticText(text, { maxLength });
const receipt = (job: Job) => ({
  id: job.id,
  status: job.status,
  message: job.message,
  pullRequestUrl: job.pullRequestUrl,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Private remote control plane. An ID is idempotent across network loss and process restarts. */
export async function createDevsReportReceiver(options: {
  stateDir: string;
  token: string;
  engines: readonly ("claude" | "codex")[];
  repair: (report: RepairReport) => Promise<string>;
}) {
  if (options.token.length < 32)
    throw new Error("A developer service token of at least 32 characters is required.");
  const file = path.join(options.stateDir, "reports.json");
  let jobs: Job[] = [];
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(parsed) || parsed.length > 1_000)
      throw new Error("Invalid developer queue.");
    jobs = parsed as Job[];
    for (const job of jobs) {
      if (
        !/^[0-9a-f-]{36}$/i.test(job.id) ||
        !["claude", "codex"].includes(job.engine) ||
        !["queued", "running", "pull-request", "failed"].includes(job.status) ||
        typeof job.description !== "string" ||
        typeof job.context !== "string"
      )
        throw new Error("Invalid developer queue.");
      if (job.status === "running") {
        job.status = "failed";
        job.message =
          "Execution was interrupted. A maintainer must inspect the job branch before retrying.";
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const save = () =>
    Effect.runPromise(
      writeFileStringAtomically({ filePath: file, contents: JSON.stringify(jobs) }),
    );
  await save();
  let chain = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>) {
    const result = chain.then(operation);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  let working: Promise<void> | null = null;
  let stopped = false;
  const pump = () => {
    if (working || stopped) return;
    working = (async () => {
      while (!stopped) {
        const next = await exclusive(async () => {
          const job = jobs.find((entry) => entry.status === "queued");
          if (!job) return null;
          job.status = "running";
          job.message = `${job.engine === "claude" ? "Claude" : "Codex"} is reproducing the problem and preparing a fix.`;
          await save();
          return job;
        });
        if (!next) break;
        let url: string | null = null;
        let failed = false;
        try {
          url = await options.repair(next);
          if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) {
            throw new Error("Invalid pull request receipt.");
          }
        } catch {
          failed = true;
        }
        await exclusive(async () => {
          next.status = failed ? "failed" : "pull-request";
          next.pullRequestUrl = url;
          next.message = failed
            ? "The repair did not pass its checks. A maintainer must inspect the job; it will not be replayed automatically."
            : "A fix PR is ready for maintainer review and CI.";
          await save();
        });
      }
    })()
      .catch((error) => {
        stopped = true;
        throw error;
      })
      .finally(() => {
        working = null;
        if (!stopped && jobs.some((job) => job.status === "queued")) pump();
      });
    // Queue write failures must stop execution, not create an unobserved retry loop.
    void working.catch(() => {
      stopped = true;
    });
  };
  pump();
  return {
    async handle(request: Request): Promise<Response> {
      const provided = Buffer.from(request.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
        return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      if (request.method === "GET" && /^\/reports\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        return exclusive(async () => {
          const job = jobs.find((entry) => entry.id === url.pathname.split("/").at(-1));
          return job ? json(receipt(job)) : json({ error: "Report not found" }, 404);
        });
      }
      if (request.method !== "POST" || url.pathname !== "/reports")
        return json({ error: "Not found" }, 404);
      if (stopped) return json({ error: "Developer queue unavailable" }, 503);
      const reader = request.body?.getReader();
      if (!reader) return json({ error: "Missing report" }, 400);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 64_000) {
            await reader.cancel();
            return json({ error: "Report too large" }, 413);
          }
          chunks.push(value);
        }
      } catch {
        return json({ error: "Invalid report" }, 400);
      }
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(raw.id) ||
        !["claude", "codex"].includes(String(raw.engine)) ||
        typeof raw.description !== "string" ||
        !raw.description.trim() ||
        raw.description.length > 5_000 ||
        typeof raw.context !== "string" ||
        raw.context.length > 10_000
      ) {
        return json({ error: "Invalid report" }, 400);
      }
      return exclusive(async () => {
        const existing = jobs.find((entry) => entry.id === raw.id);
        if (existing) return json(receipt(existing));
        if (!options.engines.includes(raw.engine as "claude" | "codex"))
          return json({ error: "Executor not configured" }, 400);
        if (
          jobs.length >= 1_000 ||
          jobs.filter((job) => ["queued", "running"].includes(job.status)).length >= 100
        )
          return json({ error: "Queue full" }, 429);
        const job: Job = {
          id: raw.id as string,
          engine: raw.engine as Job["engine"],
          description: clean(raw.description as string, 5_000),
          context: clean(raw.context as string, 10_000),
          status: "queued",
          message: "Received by the Moss developers.",
          pullRequestUrl: null,
        };
        jobs.push(job);
        try {
          await save();
        } catch (error) {
          jobs = jobs.filter((entry) => entry !== job);
          throw error;
        }
        queueMicrotask(pump);
        return json(receipt(job), 202);
      });
    },
    async close() {
      stopped = true;
      await working;
    },
    async idle() {
      await working;
    },
  };
}
