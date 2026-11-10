import {
  DEVS_DEFAULT_DAILY_JOB_LIMIT,
  DEVS_DEFAULT_DAILY_REPORT_LIMIT,
  DEVS_DEFAULT_INSTALL_DAILY_LIMIT,
  readDevsDailyLimit,
} from "@moss/shared/devsReport";
import { createCloudDevsQueue, type DevsQueueStore } from "./cloudQueue";

interface Env {
  MOSS_DEVS_WORKER_TOKEN: string;
  /** Optional overrides of the daily caps, as whole numbers. */
  MOSS_DEVS_DAILY_REPORT_LIMIT?: string;
  MOSS_DEVS_DAILY_JOB_LIMIT?: string;
  MOSS_DEVS_INSTALL_DAILY_LIMIT?: string;
  REPORTS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  REPORT_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}
export class DevsQueueObject {
  private readonly handle: (request: Request) => Promise<Response>;
  constructor(state: { storage: DevsQueueStore }, env: Env) {
    this.handle = createCloudDevsQueue({
      store: state.storage,
      workerToken: env.MOSS_DEVS_WORKER_TOKEN,
      repository: "Zluowa/moss-synara",
      engines: ["claude", "codex"],
      // The local repair worker always takes Codex jobs; Claude only when it is configured.
      feedbackEngine: "codex",
      dailyReportLimit: readDevsDailyLimit(
        env.MOSS_DEVS_DAILY_REPORT_LIMIT,
        DEVS_DEFAULT_DAILY_REPORT_LIMIT,
      ),
      dailyJobLimit: readDevsDailyLimit(
        env.MOSS_DEVS_DAILY_JOB_LIMIT,
        DEVS_DEFAULT_DAILY_JOB_LIMIT,
      ),
      installDailyLimit: readDevsDailyLimit(
        env.MOSS_DEVS_INSTALL_DAILY_LIMIT,
        DEVS_DEFAULT_INSTALL_DAILY_LIMIT,
      ),
    });
  }
  fetch(request: Request) {
    return this.handle(request);
  }
}
/**
 * 分享反馈 posts from the app's own page (moss://app, or the local server's address), so the
 * browser asks first. Feedback carries no cookies or credentials, so any origin may send it.
 */
const FEEDBACK_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-moss-feedback",
  "access-control-max-age": "86400",
} as const;
function withFeedbackCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(FEEDBACK_CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/feedback") {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: FEEDBACK_CORS_HEADERS });
      if (request.method !== "POST")
        return withFeedbackCors(Response.json({ error: "Not found" }, { status: 404 }));
      return withFeedbackCors(await forward(request, env));
    }
    if (request.method === "GET" && path === "/healthz")
      return Response.json(
        { service: "moss-devs-reports", protocol: 1, engines: ["claude", "codex"] },
        { headers: { "cache-control": "no-store" } },
      );
    return forward(request, env);
  },
};
/** Rate-limits new reports and feedback per address, then hands the request to the queue. */
async function forward(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && (path === "/reports" || path === "/feedback")) {
    const result = await env.REPORT_RATE_LIMITER.limit({
      key: request.headers.get("cf-connecting-ip") ?? "unknown",
    });
    if (!result.success)
      return Response.json(
        { error: "Try again later" },
        { status: 429, headers: { "retry-after": "60" } },
      );
  }
  try {
    return await env.REPORTS.get(env.REPORTS.idFromName("moss-developer-reports-v1")).fetch(
      request,
    );
  } catch {
    return Response.json({ error: "Developer queue unavailable" }, { status: 503 });
  }
}
