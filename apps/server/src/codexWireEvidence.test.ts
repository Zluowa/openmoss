import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexWireEvidenceCollector } from "./codexWireEvidence.ts";

const roots: string[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(limits?: Parameters<typeof createCodexWireEvidenceCollector>[0]["limits"]) {
  const directory = await mkdtemp(path.join(tmpdir(), "moss-wire-receipts-"));
  roots.push(directory);
  const options = {
    environment: { MOSS_CODEX_WIRE_EVIDENCE: "1", MOSS_CODEX_WIRE_EVIDENCE_DIR: directory },
    sessionAttemptId: "private-session-attempt",
    childPid: 12345,
    threadId: "private-thread-id",
    homePath: "/private/home",
    workspacePath: "/private/workspace",
    ...(limits ? { limits } : {}),
  };
  const collector = createCodexWireEvidenceCollector(options)!;
  await collector.flush();
  return { directory, options, collector };
}
async function rows(collector: NonNullable<ReturnType<typeof createCodexWireEvidenceCollector>>) {
  await collector.flush();
  return (await readFile(collector.outputPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
const install = (id = 1) => ({
  id,
  method: "plugin/install",
  params: { marketplacePath: "/private/marketplace", pluginName: "fixture" },
});

describe("Codex native hash receipts", () => {
  it("requires both explicit flags and a native process identity before any IO", () => {
    const options = { sessionAttemptId: "x", childPid: 123, threadId: "y" };
    expect(createCodexWireEvidenceCollector({ ...options, environment: {} })).toBeUndefined();
    expect(
      createCodexWireEvidenceCollector({
        ...options,
        environment: { MOSS_CODEX_WIRE_EVIDENCE_DIR: "/missing" },
      }),
    ).toBeUndefined();
    expect(
      createCodexWireEvidenceCollector({
        ...options,
        environment: { MOSS_CODEX_WIRE_EVIDENCE: "1" },
      }),
    ).toBeUndefined();
    expect(
      createCodexWireEvidenceCollector({
        ...options,
        environment: { MOSS_CODEX_WIRE_EVIDENCE: "1", MOSS_CODEX_WIRE_EVIDENCE_DIR: "relative" },
      }),
    ).toBeUndefined();
    expect(
      createCodexWireEvidenceCollector({
        ...options,
        childPid: undefined,
        environment: { MOSS_CODEX_WIRE_EVIDENCE: "1", MOSS_CODEX_WIRE_EVIDENCE_DIR: "/missing" },
      }),
    ).toBeUndefined();
  });

  it("records exact outbound/inbound hashes, correlates an immediate reply, and distinguishes a confirmed write", async () => {
    const { collector } = await fixture();
    const request = install();
    const observation = collector.observeOutgoing(request);
    const incoming = '{"id":1,"result":{"authPolicy":"ON_USE","appsNeedingAuth":[]}}';
    collector.observeIncoming(incoming, JSON.parse(incoming));
    collector.settleOutgoing(observation, true);
    collector.close({ code: 0, signal: null });
    const events = await rows(collector);
    expect(events.map((row) => row.kind)).toEqual([
      "process-start",
      "request-attempt",
      "response",
      "request-written",
      "collection-stopped",
    ]);
    expect(events[1]).toMatchObject({
      frameSha256: digest(JSON.stringify(request)),
      payloadSha256: digest(JSON.stringify(request.params)),
      requestKeys: ["marketplacePath", "pluginName"],
    });
    expect(events[2]).toMatchObject({
      requestFrameSha256: events[1].frameSha256,
      rpcIdSha256: events[1].rpcIdSha256,
      frameSha256: digest(incoming),
      responseKind: "result",
    });
    expect(events.at(-1)).toMatchObject({ state: "closed", unansweredRequests: 0, exitCode: 0 });
    expect(events.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never persists credentials, text, raw IDs or paths even inside allowed turn/results", async () => {
    const { collector } = await fixture();
    const secret = "private-bearer-secret-THIS-MUST-NOT-APPEAR";
    const text = "private-conversation-THIS-MUST-NOT-APPEAR";
    const request = {
      id: "private-rpc-id",
      method: "turn/start",
      params: {
        threadId: "private-thread-id",
        input: [{ type: "text", text }],
        config: { authorization: secret },
      },
    };
    collector.settleOutgoing(collector.observeOutgoing(request), true);
    const response = { id: request.id, result: { text, token: secret, path: "/private/result" } };
    collector.observeIncoming(JSON.stringify(response), response);
    const notification = { method: "item/completed", params: { text, token: secret } };
    collector.observeIncoming(JSON.stringify(notification), notification);
    collector.close({ code: null, signal: "SIGTERM" });
    const events = await rows(collector);
    const serialized = JSON.stringify(events);
    for (const value of [
      secret,
      text,
      "private-rpc-id",
      "private-thread-id",
      "private-session-attempt",
      "/private/",
    ])
      expect(serialized).not.toContain(value);
    expect(events[0]).toMatchObject({
      launchHomeSha256: digest("/private/home"),
      threadIdSha256: digest("private-thread-id"),
      homeIdentitySource: "server-launch-environment",
      scope: "collection-only",
    });
    expect(events.find((row) => row.kind === "notification")).toMatchObject({
      method: "item/completed",
      frameSha256: digest(JSON.stringify(notification)),
    });
    expect(serialized).not.toMatch(/"(params|result|error|input|text|authorization|token)":/u);
  });

  it("ignores auth operations, unknown methods, routing overrides and non-plugin config writes", async () => {
    const { collector } = await fixture();
    for (const [id, method, params] of [
      [1, "account/login/start", { apiKey: "secret" }],
      [2, "account/read", {}],
      [
        3,
        "plugin/install",
        { pluginName: "fixture", marketplacePath: "x", environment: { token: "secret" } },
      ],
      [
        4,
        "config/batchWrite",
        { edits: [{ keyPath: "model_providers.moss.api_key", value: "secret" }] },
      ],
      [
        5,
        "config/batchWrite",
        { edits: [{ keyPath: "plugins.fixture@local.enabled", value: "secret" }] },
      ],
      [6, "__proto__", {}],
    ] as const) {
      expect(collector.observeOutgoing({ id, method, params })).toBeUndefined();
      collector.observeIncoming(JSON.stringify({ id, result: { token: "secret" } }), {
        id,
        result: { token: "secret" },
      });
    }
    collector.close({ code: 0, signal: null });
    const events = await rows(collector);
    expect(events.map((row) => row.kind)).toEqual(["process-start", "collection-stopped"]);
    expect(collector.status.ignored).toBe(12);
  });

  it("captures native plugin-only toggles and a response error without its message", async () => {
    const { collector } = await fixture();
    const request = {
      id: 1,
      method: "config/batchWrite",
      params: {
        edits: [
          { keyPath: "plugins.fixture@local.enabled", value: false, mergeStrategy: "upsert" },
        ],
        expectedVersion: null,
        filePath: null,
        reloadUserConfig: true,
      },
    };
    collector.settleOutgoing(collector.observeOutgoing(request), true);
    const response = { id: 1, error: { message: "Bearer private-error-credential", code: -1 } };
    collector.observeIncoming(JSON.stringify(response), response);
    collector.close({ code: 0, signal: null });
    const events = await rows(collector);
    expect(events.find((row) => row.kind === "response")).toMatchObject({
      responseKind: "error",
      method: "config/batchWrite",
    });
    expect(JSON.stringify(events)).not.toContain("private-error-credential");
  });

  it("marks failed stdin writes without claiming dispatch or accepting their later unrelated response", async () => {
    const { collector } = await fixture();
    collector.settleOutgoing(collector.observeOutgoing(install()), false);
    collector.observeIncoming('{"id":1,"result":{}}', { id: 1, result: {} });
    collector.close({ code: 1, signal: null });
    const events = await rows(collector);
    expect(events.some((row) => row.kind === "request-written")).toBe(false);
    expect(events.some((row) => row.kind === "response")).toBe(false);
    expect(events.some((row) => row.kind === "request-write-failed")).toBe(true);
  });

  it.each(["events", "bytes", "frame", "pending", "queued"] as const)(
    "stops explicitly at the %s bound and never claims a passing gate",
    async (limit) => {
      const limits =
        limit === "events"
          ? { events: 4 }
          : limit === "bytes"
            ? { bytes: 2048 }
            : limit === "frame"
              ? { frameBytes: 64 }
              : limit === "pending"
                ? { pending: 1 }
                : { queued: 1 };
      const { collector } = await fixture(limits);
      for (let id = 1; id <= 8; id += 1) {
        collector.settleOutgoing(collector.observeOutgoing(install(id)), true);
        if (limit !== "queued") await collector.flush();
      }
      collector.close({ code: 0, signal: null });
      const events = await rows(collector);
      expect(collector.status.state).toBe("truncated");
      expect(events.at(-1)).toMatchObject({
        kind: "collection-stopped",
        state: "truncated",
        reason: limit === "queued" ? "queue" : limit,
      });
      expect(collector.status.pending).toBe(0);
      expect(collector.status.bytes).toBeLessThanOrEqual(limits.bytes ?? 4 * 1024 * 1024);
      expect(events.length).toBeLessThanOrEqual(limits.events ?? 4096);
      expect(JSON.stringify(events)).not.toContain('"pass"');
    },
  );

  it("separates session/process instances under PID reuse while keeping the actual Moss process identity", async () => {
    const first = await fixture();
    const second = createCodexWireEvidenceCollector({
      ...first.options,
      sessionAttemptId: "next-attempt",
    })!;
    first.collector.close({ code: 0, signal: null });
    second.close({ code: 0, signal: null });
    const a = (await rows(first.collector))[0];
    const b = (await rows(second))[0];
    expect(a.hostInstanceSha256).toBe(b.hostInstanceSha256);
    expect(a.appServerInstanceSha256).not.toBe(b.appServerInstanceSha256);
    expect(a.sessionAttemptSha256).not.toBe(b.sessionAttemptSha256);
    expect(first.collector.outputPath).not.toBe(second.outputPath);
  });

  it("fails collection without throwing or exposing an error when the sink is unavailable", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "moss-wire-missing-"));
    roots.push(directory);
    const collector = createCodexWireEvidenceCollector({
      environment: {
        MOSS_CODEX_WIRE_EVIDENCE: "1",
        MOSS_CODEX_WIRE_EVIDENCE_DIR: path.join(directory, "missing"),
      },
      sessionAttemptId: "x",
      threadId: "x",
      childPid: 99,
    })!;
    await expect(collector.flush()).resolves.toBeUndefined();
    expect(collector.status).toMatchObject({ state: "failed", reason: "io" });
    expect(collector.observeOutgoing(install())).toBeUndefined();
    collector.close({ code: 0, signal: null });
    await expect(collector.flush()).resolves.toBeUndefined();
  });

  it("rejects a linked output directory instead of following it", async () => {
    const { directory, options, collector } = await fixture();
    collector.close({ code: 0, signal: null });
    await collector.flush();
    const target = path.join(directory, "target");
    const linked = path.join(directory, "linked");
    await mkdir(target);
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    const rejected = createCodexWireEvidenceCollector({
      ...options,
      environment: { MOSS_CODEX_WIRE_EVIDENCE: "1", MOSS_CODEX_WIRE_EVIDENCE_DIR: linked },
    })!;
    await rejected.flush();
    expect(rejected.status).toMatchObject({ state: "failed", reason: "io" });
  });
});
