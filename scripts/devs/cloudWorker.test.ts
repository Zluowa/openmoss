import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MOSS_DEVS_FALLBACK_REPORT_URL,
  MOSS_DEVS_PUBLIC_REPORT_URL,
} from "@moss/shared/devsReport";
import worker from "./cloudWorker";

function environment(options: { limited?: boolean } = {}) {
  const forwarded: Request[] = [];
  const env = {
    MOSS_DEVS_WORKER_TOKEN: "worker-private-credential-for-worker-fixture",
    REPORTS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          forwarded.push(request);
          return Response.json({ id: "queued" }, { status: 202 });
        },
      }),
    },
    REPORT_RATE_LIMITER: { limit: async () => ({ success: !options.limited }) },
  };
  return { env, forwarded };
}

describe("developer report worker", () => {
  it("answers the browser's preflight for 分享反馈 without touching the queue", async () => {
    const { env, forwarded } = environment();
    const response = await worker.fetch(
      new Request("https://moss-devs.test/feedback", {
        method: "OPTIONS",
        headers: { origin: "moss://app", "access-control-request-method": "POST" },
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-moss-feedback");
    expect(forwarded).toHaveLength(0);
  });

  it("forwards feedback to the queue and lets the app read the answer", async () => {
    const { env, forwarded } = environment();
    const response = await worker.fetch(
      new Request("https://moss-devs.test/feedback", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({ id: "queued" });
    expect(forwarded).toHaveLength(1);
  });

  it("rate-limits feedback per address like reports, still readable by the app", async () => {
    const { env, forwarded } = environment({ limited: true });
    const response = await worker.fetch(
      new Request("https://moss-devs.test/feedback", { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const report = await worker.fetch(
      new Request("https://moss-devs.test/reports", { method: "POST", body: "{}" }),
      env,
    );
    expect(report.status).toBe(429);
    expect(report.headers.get("access-control-allow-origin")).toBeNull();
    expect(forwarded).toHaveLength(0);
  });
});

describe("developer report worker deployment", () => {
  it("serves both hostnames the app reports to", () => {
    const wrangler = readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8");
    for (const url of [MOSS_DEVS_PUBLIC_REPORT_URL, MOSS_DEVS_FALLBACK_REPORT_URL]) {
      expect(wrangler).toContain(`{ "pattern": "${new URL(url).host}", "custom_domain": true }`);
    }
  });
});
