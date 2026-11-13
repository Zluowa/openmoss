import {
  DEVS_CONSENT_REQUIRED_MESSAGE,
  MOSS_DEVS_PUBLIC_REPORT_URL,
} from "@moss/shared/devsReport";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId, type DevsReportSubmitInput, type OrchestrationThread } from "@moss/contracts";
import { DevsReports, curateDevsContext, devsEndpoint, type DevsFetch } from "./devsReports";
import { createDevsReportReceiver } from "./devsReportReceiver";

const token = "test-developer-connection-token-1234567890";
const thread = {
  modelSelection: { provider: "codex", model: "test-model" },
  session: { status: "error" },
  latestTurn: { state: "failed" },
  messages: [{ text: "PRIVATE CONVERSATION MUST NOT LEAVE" }],
  activities: [
    {
      tone: "error",
      kind: "provider.failed",
      summary: "Request failed Authorization: Bearer secret-fixture-value",
      payload: { private: "PRIVATE TOOL ARGUMENT" },
    },
  ],
} as unknown as OrchestrationThread;
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-test-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function createLocal(directory: string, fetcher: DevsFetch) {
  const client = new DevsReports(directory, fetcher, {
    MOSS_DEVS_REPORT_URL: "http://127.0.0.1:5789/reports",
    MOSS_DEVS_REPORT_TOKEN: token,
  });
  cleanup.push(() => client.close());
  return client;
}

const PUBLIC_QUEUE_ENV = { MOSS_DEVS_REPORT_URL: MOSS_DEVS_PUBLIC_REPORT_URL };
/** What the app does: build the report, show it, and send it once the user confirms. */
async function send(client: DevsReports, input: DevsReportSubmitInput) {
  await client.prepare(input, thread, { phoneAccount: false });
  return client.submit(input);
}

describe("durable developer reporting", () => {
  it("preserves a report and stops retrying when an acknowledged remote receipt has expired", async () => {
    const directory = await temporary();
    const id = randomUUID();
    const threadId = ThreadId.makeUnsafe("receipt-chat");
    const fetcher = vi.fn<DevsFetch>(async (_url, options) =>
      options?.method === "POST"
        ? Response.json({ id, status: "queued", message: "received", pullRequestUrl: null })
        : new Response(null, { status: 404 }),
    );
    const client = new DevsReports(directory, fetcher, PUBLIC_QUEUE_ENV);
    cleanup.push(() => client.close());
    await send(client, { id, threadId, text: "@devs original problem" });
    await client.poll();
    client.close();
    const file = path.join(directory, "devs-reports.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    stored[0].nextAttemptAt = 0;
    await fs.writeFile(file, JSON.stringify(stored));
    const restarted = new DevsReports(directory, fetcher, PUBLIC_QUEUE_ENV);
    cleanup.push(() => restarted.close());
    await restarted.poll();
    await restarted.poll();
    const state = (await restarted.list(threadId)).reports[0]!;
    expect(state.status).toBe("failed");
    expect(state.description).toBe("original problem");
    expect(state.message).toContain("no longer available");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("connects production clients without team credentials and retains private per-report capabilities", async () => {
    const directory = await temporary();
    const authorizations = new Map<string, string>();
    const fetcher: DevsFetch = async (_url, options) => {
      const input = JSON.parse(String(options!.body));
      authorizations.set(input.id, new Headers(options?.headers).get("authorization")!);
      return new Response(
        JSON.stringify({
          id: input.id,
          status: "queued",
          message: "received",
          pullRequestUrl: null,
        }),
      );
    };
    const client = new DevsReports(directory, fetcher, PUBLIC_QUEUE_ENV);
    cleanup.push(() => client.close());
    const threadId = ThreadId.makeUnsafe("production-chat");
    for (let index = 0; index < 2; index++)
      await send(client, { id: randomUUID(), threadId, text: "@devs window broken" });
    await client.poll();
    expect(new Set(authorizations.values()).size).toBe(2);
    expect(
      [...authorizations.values()].every(
        (value) => value.startsWith("Bearer ") && value.length > 64,
      ),
    ).toBe(true);
    expect(JSON.stringify(await client.list(threadId))).not.toContain("readToken");
    const stored = JSON.parse(await fs.readFile(path.join(directory, "devs-reports.json"), "utf8"));
    expect(stored[0].readToken).toBeTruthy();
    expect(stored[0].state.engine).toBe("codex");
  });
  it("defaults plain mentions to the configured local engine and honors explicit choices", async () => {
    const client = new DevsReports(await temporary(), fetch, {
      MOSS_DEVS_REPORT_URL: "http://127.0.0.1:5789/reports",
      MOSS_DEVS_REPORT_TOKEN: token,
      MOSS_DEVS_DEFAULT_ENGINE: "codex",
    });
    cleanup.push(() => client.close());
    const threadId = ThreadId.makeUnsafe("chat");
    await send(client, { id: randomUUID(), threadId, text: "@devs broken" });
    await send(client, { id: randomUUID(), threadId, text: "@devs claude broken" });
    expect((await client.list("chat")).reports.map((report) => report.engine)).toEqual([
      "codex",
      "claude",
    ]);
  });
  it("exports only allowlisted observed context and redacts credentials", () => {
    const context = curateDevsContext(thread);
    expect(context).toContain("Provider: codex");
    for (const secret of ["PRIVATE CONVERSATION", "PRIVATE TOOL", "secret-fixture-value"])
      expect(context).not.toContain(secret);
  });
  it.each([
    "http://external.test/reports",
    "https://user:pass@example.test/reports",
    "https://example.test/?token=x",
    "file:///tmp/reports",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(devsEndpoint(url)).toBeNull();
  });
  it("queues once and completes the entire report-to-PR receipt path for both engines", async () => {
    const directory = await temporary();
    const repair = vi.fn(async () => "https://github.com/Zluowa/moss-synara/pull/99999");
    const remote = await createDevsReportReceiver({
      stateDir: path.join(directory, "remote"),
      token,
      engines: ["claude", "codex"],
      repair,
    });
    cleanup.push(() => remote.close());
    const bodies: string[] = [];
    const fetcher: DevsFetch = async (url, options) => {
      if (options?.body) bodies.push(String(options.body));
      return remote.handle(new Request(String(url), options));
    };
    const local = createLocal(path.join(directory, "local"), fetcher);
    for (const engine of ["claude", "codex"] as const) {
      const id = randomUUID();
      const input = {
        id,
        threadId: ThreadId.makeUnsafe("chat"),
        text: `@devs ${engine} 模型切换后卡住`,
      };
      await local.prepare(input, thread, { phoneAccount: false });
      await Promise.all([local.submit(input), local.submit(input)]);
      await local.poll();
      await remote.idle();
    }
    // Poll schedule is bypassed only in persisted test data, then restored from disk as a real restart.
    local.close();
    const file = path.join(directory, "local", "devs-reports.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    for (const item of stored) item.nextAttemptAt = 0;
    await fs.writeFile(file, JSON.stringify(stored));
    const restarted = createLocal(path.join(directory, "local"), fetcher);
    await restarted.poll();
    const { reports } = await restarted.list("chat");
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.status === "pull-request")).toBe(true);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(bodies.join("\n")).not.toContain("PRIVATE CONVERSATION");
    expect(bodies.join("\n")).not.toContain("secret-fixture-value");
  });
  it("retains an undelivered report across failure and restart with the same request ID", async () => {
    const directory = await temporary();
    const fetcher = vi.fn<DevsFetch>(async () => {
      throw new Error("offline");
    });
    const client = createLocal(directory, fetcher);
    const input = {
      id: randomUUID(),
      threadId: ThreadId.makeUnsafe("chat"),
      text: "@devs 请修复窗口",
    };
    await send(client, input);
    await client.poll();
    expect((await client.list("chat")).reports[0]?.message).toContain("retry");
    client.close();
    const restarted = createLocal(directory, fetcher);
    // A retry after a lost response previews the queued report and sends nothing new.
    expect((await restarted.prepare(input, thread, { phoneAccount: false })).description).toBe(
      "请修复窗口",
    );
    await restarted.submit(input);
    expect((await restarted.list("chat")).reports).toHaveLength(1);
    expect((await restarted.list("other")).reports).toEqual([]);
  });
  it("is on by default and delivers to the public queue", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn<DevsFetch>(async (url, options) => {
      urls.push(String(url));
      const input = JSON.parse(String(options!.body));
      return Response.json({ id: input.id, status: "queued", message: "ok", pullRequestUrl: null });
    });
    const client = new DevsReports(await temporary(), fetcher, {});
    cleanup.push(() => client.close());
    expect(client.configured).toBe(true);
    await send(client, {
      id: randomUUID(),
      threadId: ThreadId.makeUnsafe("chat"),
      text: "@devs broken",
    });
    await client.poll();
    expect(urls).toEqual([MOSS_DEVS_PUBLIC_REPORT_URL]);
  });
  it("sends exactly what the user confirmed, and nothing without a confirmation", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher: DevsFetch = async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      bodies.push(body);
      return Response.json({ id: body.id, status: "queued", message: "ok", pullRequestUrl: null });
    };
    const directory = await temporary();
    const client = new DevsReports(directory, fetcher, PUBLIC_QUEUE_ENV);
    cleanup.push(() => client.close());
    const threadId = ThreadId.makeUnsafe("chat");
    const input = {
      id: randomUUID(),
      threadId,
      text: "@devs the window froze, call me on 13812345678 or bob@example.com, see D:\\work\\acme\\a.ts",
    };
    await expect(client.submit(input)).rejects.toThrow("Review the report again");
    const preview = await client.prepare(input, thread, { phoneAccount: true });
    expect(preview.processedOutsideMainlandChina).toBe(true);
    for (const secret of ["13812345678", "bob@example.com", "acme", "secret-fixture-value"])
      expect(JSON.stringify(preview)).not.toContain(secret);
    await expect(client.submit({ ...input, text: `${input.text} and more` })).rejects.toThrow(
      "Review the report again",
    );
    await expect(client.submit({ ...input, engine: "claude" })).rejects.toThrow(
      "Review the report again",
    );
    await client.submit(input);
    await client.poll();
    expect(bodies).toHaveLength(1);
    const install = await fs.readFile(path.join(directory, "devs-install-id"), "utf8");
    expect(bodies[0]).toEqual({
      id: input.id,
      engine: preview.engine,
      description: preview.description,
      context: preview.context,
      install,
    });
    expect(install).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("sends a report only for a message that starts with @devs", async () => {
    const client = new DevsReports(await temporary(), vi.fn<DevsFetch>(), PUBLIC_QUEUE_ENV);
    cleanup.push(() => client.close());
    await expect(
      client.prepare(
        {
          id: randomUUID(),
          threadId: ThreadId.makeUnsafe("chat"),
          text: "please ask @devs about it",
        },
        thread,
        { phoneAccount: false },
      ),
    ).rejects.toThrow("Describe the problem after @devs");
  });
  it("follows the error-report switch: nothing is prepared or delivered while it is off", async () => {
    let consent = false;
    const fetcher = vi.fn<DevsFetch>(async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      return Response.json({ id: body.id, status: "queued", message: "ok", pullRequestUrl: null });
    });
    const client = new DevsReports(await temporary(), fetcher, PUBLIC_QUEUE_ENV, {
      consent: async () => consent,
    });
    cleanup.push(() => client.close());
    const input = { id: randomUUID(), threadId: ThreadId.makeUnsafe("chat"), text: "@devs broken" };
    await expect(client.prepare(input, thread, { phoneAccount: false })).rejects.toThrow(
      DEVS_CONSENT_REQUIRED_MESSAGE,
    );
    consent = true;
    await client.prepare(input, thread, { phoneAccount: false });
    consent = false;
    await expect(client.submit(input)).rejects.toThrow(DEVS_CONSENT_REQUIRED_MESSAGE);
    consent = true;
    await client.submit(input);
    consent = false;
    await client.poll();
    expect(fetcher).not.toHaveBeenCalled();
    consent = true;
    await client.poll();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("limits one installation to three reports a day", async () => {
    let time = Date.parse("2026-11-03T08:00:00Z");
    const client = new DevsReports(await temporary(), vi.fn<DevsFetch>(), PUBLIC_QUEUE_ENV, {
      now: () => time,
    });
    cleanup.push(() => client.close());
    const threadId = ThreadId.makeUnsafe("chat");
    for (let index = 0; index < 3; index++)
      await send(client, { id: randomUUID(), threadId, text: "@devs broken" });
    await expect(
      send(client, { id: randomUUID(), threadId, text: "@devs broken" }),
    ).rejects.toThrow("up to 3");
    time += 86_400_000;
    await send(client, { id: randomUUID(), threadId, text: "@devs broken" });
  });
  it("waits as long as the queue asks when its daily cap is reached", async () => {
    let time = Date.parse("2026-11-03T08:00:00Z");
    const fetcher = vi.fn<DevsFetch>(
      async () => new Response("{}", { status: 429, headers: { "retry-after": "7200" } }),
    );
    const client = new DevsReports(await temporary(), fetcher, PUBLIC_QUEUE_ENV, {
      now: () => time,
    });
    cleanup.push(() => client.close());
    await send(client, {
      id: randomUUID(),
      threadId: ThreadId.makeUnsafe("chat"),
      text: "@devs x",
    });
    await client.poll();
    const [report] = (await client.list("chat")).reports;
    expect(report!.status).toBe("queued");
    expect(report!.message).toContain("daily report limit");
    time += 3_600_000;
    await client.poll();
    expect(fetcher).toHaveBeenCalledTimes(1);
    time += 3_600_001;
    await client.poll();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("refuses missing configuration without acknowledging or clearing the report", async () => {
    const client = new DevsReports(await temporary(), fetch, { MOSS_DEVS_REPORT_URL: "" });
    cleanup.push(() => client.close());
    await expect(
      client.prepare(
        { id: randomUUID(), threadId: ThreadId.makeUnsafe("chat"), text: "@devs broken" },
        thread,
        { phoneAccount: false },
      ),
    ).rejects.toThrow("not connected");
  });
  it("requires remote authentication, validates inputs, and never reruns an interrupted job", async () => {
    const directory = await temporary();
    const id = randomUUID();
    await fs.writeFile(
      path.join(directory, "reports.json"),
      JSON.stringify([
        {
          id,
          engine: "codex",
          description: "broken",
          context: "none",
          status: "running",
          message: "running",
          pullRequestUrl: null,
        },
      ]),
    );
    const repair = vi.fn(async () => "https://github.com/Zluowa/moss-synara/pull/99999");
    const receiver = await createDevsReportReceiver({
      stateDir: directory,
      token,
      engines: ["codex"],
      repair,
    });
    cleanup.push(() => receiver.close());
    expect((await receiver.handle(new Request("http://localhost/reports"))).status).toBe(401);
    const request = (body: unknown) =>
      new Request("http://localhost/reports", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    expect((await receiver.handle(request({ id: "../bad" }))).status).toBe(400);
    expect(
      (
        await receiver.handle(
          request({ id: randomUUID(), engine: "claude", description: "bad", context: "" }),
        )
      ).status,
    ).toBe(400);
    const response = await receiver.handle(
      request({ id, engine: "codex", description: "broken", context: "none" }),
    );
    expect(((await response.json()) as { status: string }).status).toBe("failed");
    await receiver.idle();
    expect(repair).not.toHaveBeenCalled();
  });
});

describe("app feedback without a conversation", () => {
  it("previews allowlisted app facts and persists a real app report before local delivery", async () => {
    const directory = await temporary();
    const id = randomUUID();
    const bodies: Record<string, unknown>[] = [];
    const repair = vi.fn(async () => "https://github.com/Zluowa/moss-synara/pull/99999");
    const remote = await createDevsReportReceiver({
      stateDir: path.join(directory, "remote"),
      token,
      engines: ["codex"],
      repair,
    });
    cleanup.push(() => remote.close());
    const client = createLocal(directory, async (url, options) => {
      if (options?.method === "POST") bodies.push(JSON.parse(String(options.body)));
      return remote.handle(new Request(String(url), options));
    });
    const input = {
      id,
      text: "@devs [ui] The sidebar label wraps.",
      feedbackContext: {
        appVersion: "1.0.5-test",
        platform: "Win32",
        language: "zh-CN",
        category: "ui" as const,
        provider: null,
        model: null,
      },
    };
    const preview = await client.prepare(input, null, { phoneAccount: false });
    expect(preview.scope).toBe("application");
    expect(preview.context).toContain("Report source: Moss feedback form");
    expect(preview.context).toContain("Platform: Win32");
    expect(bodies).toHaveLength(0);
    const report = await client.submit(input);
    expect(report.threadId).toBeNull();
    await client.poll();
    await remote.idle();
    expect(repair).toHaveBeenCalledOnce();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("threadId");
    expect(bodies[0]?.context).not.toContain("PRIVATE CONVERSATION");
    const saved = JSON.parse(await fs.readFile(path.join(directory, "devs-reports.json"), "utf8"));
    expect(saved[0].state.threadId).toBeNull();
    expect(saved[0].delivered).toBe(true);
  });

  it("rejects missing app facts and still enforces the report privacy switch", async () => {
    const directory = await temporary();
    const fetcher = vi.fn<DevsFetch>();
    const client = new DevsReports(directory, fetcher, PUBLIC_QUEUE_ENV, {
      consent: async () => false,
    });
    cleanup.push(() => client.close());
    await expect(
      client.prepare({ id: randomUUID(), text: "@devs no context" }, null, { phoneAccount: false }),
    ).rejects.toThrow("Open a saved chat");
    await expect(
      client.prepare(
        {
          id: randomUUID(),
          text: "@devs ui problem",
          feedbackContext: {
            appVersion: "test",
            platform: "Win32",
            language: "zh-CN",
            category: "ui",
            provider: null,
            model: null,
          },
        },
        null,
        { phoneAccount: false },
      ),
    ).rejects.toThrow(DEVS_CONSENT_REQUIRED_MESSAGE);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
