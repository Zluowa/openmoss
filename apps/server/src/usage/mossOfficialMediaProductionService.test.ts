import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { UsageEventSubject } from "@synara/contracts";

import type { MediaUsageReceiptAppender } from "./mediaUsageReceiptBridge.ts";
import {
  createMossOfficialMediaFileCheckpointStore,
  createMossOfficialMediaProductionService,
  type MossOfficialMediaProductionServiceOptions,
} from "./mossOfficialMediaProductionService.ts";
import type {
  ApiMartOfficialMediaTransport,
  MossOfficialMediaExecutionRequest,
} from "./mossOfficialMediaExecutor.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const subject = {
  provider: "codex",
  providerInstanceId: "codex_moss",
  accountRef: "account-ref-1",
} as const satisfies UsageEventSubject;

const request = {
  subject,
  invocationId: "skill-invocation-1",
  skillRef: "moss-official-imagegen",
  attemptIndex: 0,
  role: "primary",
  prompt: "private prompt that must not be persisted",
  media: { kind: "image", model: "gpt-image-2" },
  occurredAt: "2026-08-13T01:02:03.000Z",
  threadId: "thread-1",
  turnId: "turn-1",
} as const satisfies MossOfficialMediaExecutionRequest;

const completedTask = {
  taskId: "task-image-1",
  state: "completed",
  providerPayloadDigest: "a".repeat(64),
  costUsd: "0.01",
  artifactRefs: ["apimart-artifact-image-1"],
  imageOutputCount: "1",
} as const;

async function tempCheckpointPath() {
  const root = await mkdtemp(join(tmpdir(), "moss-media-checkpoints-"));
  roots.push(root);
  await chmod(root, 0o700);
  return join(root, "usage", "official-media-checkpoints.json");
}

function durableAppender(): MediaUsageReceiptAppender & {
  readonly appendAtomically: ReturnType<
    typeof vi.fn<MediaUsageReceiptAppender["appendAtomically"]>
  >;
} {
  const appendAtomically = vi.fn<MediaUsageReceiptAppender["appendAtomically"]>(async (events) =>
    events.map((event) => ({ status: "inserted" as const, eventId: event.eventId })),
  );
  return { instrumentationStatus: "DURABLE", appendAtomically };
}

function transport(): ApiMartOfficialMediaTransport & {
  readonly submit: ReturnType<typeof vi.fn<ApiMartOfficialMediaTransport["submit"]>>;
  readonly getTask: ReturnType<typeof vi.fn<ApiMartOfficialMediaTransport["getTask"]>>;
} {
  return {
    submit: vi.fn<ApiMartOfficialMediaTransport["submit"]>(async () => ({
      taskId: "task-image-1",
    })),
    getTask: vi.fn<ApiMartOfficialMediaTransport["getTask"]>(async () => completedTask),
  };
}

async function makeService(
  filePath: string,
  input: Pick<MossOfficialMediaProductionServiceOptions, "transport" | "usageAppender">,
) {
  return createMossOfficialMediaProductionService({
    checkpointStore: createMossOfficialMediaFileCheckpointStore({ filePath }),
    ...input,
    now: () => "2026-08-13T01:02:04.000Z",
  });
}

describe("Moss official media production service", () => {
  it("persists content-free private checkpoints and resumes them in a new process", async () => {
    const filePath = await tempCheckpointPath();
    const provider = transport();
    const firstAppender = durableAppender();
    const first = await makeService(filePath, {
      transport: provider,
      usageAppender: firstAppender,
    });

    const submitted = await first.execute(request);
    expect(submitted).toMatchObject({
      receiptDelivery: "not_terminal",
      execution: { status: "submitted" },
    });
    const contentsAfterSubmit = await readFile(filePath, "utf8");
    expect(contentsAfterSubmit).not.toContain(request.prompt);
    expect(contentsAfterSubmit).not.toContain("https://");
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    const restarted = await makeService(filePath, {
      transport: provider,
      usageAppender: firstAppender,
    });
    const recovered = await restarted.reconcilePending();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      receiptDelivery: "appended",
      execution: { status: "completed" },
    });
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(firstAppender.appendAtomically).toHaveBeenCalledTimes(1);
    const finalContents = await readFile(filePath, "utf8");
    expect(finalContents).not.toContain(request.prompt);
    expect(finalContents).not.toContain("https://");

    const replayAppender = durableAppender();
    const replayedProcess = await makeService(filePath, {
      transport: provider,
      usageAppender: replayAppender,
    });
    const replayed = await replayedProcess.reconcileAttempt(
      recovered[0]!.execution.checkpoint.operationGraph.attemptOperationId,
    );
    expect(replayed).toMatchObject({
      receiptDelivery: "already_appended",
      execution: { status: "completed" },
    });
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(replayAppender.appendAtomically).not.toHaveBeenCalled();
  });

  it("serializes independent store instances for one checkpoint file", async () => {
    const filePath = await tempCheckpointPath();
    const provider = transport();
    let release!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.submit.mockImplementationOnce(async () => {
      await submitGate;
      return { taskId: "task-image-1" };
    });
    const appender = durableAppender();
    const first = await makeService(filePath, { transport: provider, usageAppender: appender });
    const second = await makeService(filePath, { transport: provider, usageAppender: appender });

    const firstResult = first.execute(request);
    await vi.waitFor(() => expect(provider.submit).toHaveBeenCalledTimes(1));
    await expect(second.execute(request)).resolves.toMatchObject({
      receiptDelivery: "not_terminal",
      execution: { status: "needs_reconciliation" },
    });
    release();
    await expect(firstResult).resolves.toMatchObject({ execution: { status: "submitted" } });
    expect(provider.submit).toHaveBeenCalledTimes(1);
  });

  it("fails before a paid POST when the receipt appender is not durable", async () => {
    const filePath = await tempCheckpointPath();
    const provider = transport();
    const localAppender: MediaUsageReceiptAppender = {
      instrumentationStatus: "LOCAL_CONTRACT_ONLY",
      appendAtomically: vi.fn<MediaUsageReceiptAppender["appendAtomically"]>(async (events) =>
        events.map((event) => ({ status: "local_contract_only" as const, eventId: event.eventId })),
      ),
    };
    const service = await makeService(filePath, {
      transport: provider,
      usageAppender: localAppender,
    });

    await expect(service.execute(request)).rejects.toMatchObject({
      code: "durable_usage_appender_required",
    });
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("replays an atomic receipt append after a crash window without another paid POST", async () => {
    const filePath = await tempCheckpointPath();
    const provider = transport();
    const failingAppender: MediaUsageReceiptAppender = {
      instrumentationStatus: "DURABLE",
      appendAtomically: vi.fn(async (_events) =>
        Promise.reject(new Error("synthetic append outage")),
      ),
    };
    const first = await makeService(filePath, {
      transport: provider,
      usageAppender: failingAppender,
    });
    await first.execute(request);
    await expect(first.reconcilePending()).rejects.toThrow("synthetic append outage");
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(filePath, "utf8")).checkpoints[0]).not.toHaveProperty(
      "receiptAppend",
    );

    const recoveringAppender = durableAppender();
    recoveringAppender.appendAtomically.mockImplementationOnce(async (events) =>
      events.map((event) => ({ status: "idempotent" as const, eventId: event.eventId })),
    );
    const restarted = await makeService(filePath, {
      transport: provider,
      usageAppender: recoveringAppender,
    });
    await expect(restarted.reconcilePending()).resolves.toMatchObject([
      { receiptDelivery: "appended", execution: { status: "completed" } },
    ]);
    expect(provider.submit).toHaveBeenCalledTimes(1);
    expect(recoveringAppender.appendAtomically).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(filePath, "utf8")).checkpoints[0]).toHaveProperty(
      "receiptAppend.state",
      "appended",
    );
  });

  it("does not acknowledge a durable appender that returns a local-only result", async () => {
    const filePath = await tempCheckpointPath();
    const provider = transport();
    const appender: MediaUsageReceiptAppender = {
      instrumentationStatus: "DURABLE",
      appendAtomically: vi.fn<MediaUsageReceiptAppender["appendAtomically"]>(async (events) =>
        events.map((event) => ({
          status: "local_contract_only" as const,
          eventId: event.eventId,
        })),
      ),
    };
    const service = await makeService(filePath, { transport: provider, usageAppender: appender });
    await service.execute(request);

    await expect(service.reconcilePending()).rejects.toMatchObject({
      code: "usage_receipt_not_durable",
    });
    expect(JSON.parse(await readFile(filePath, "utf8")).checkpoints[0]).not.toHaveProperty(
      "receiptAppend",
    );
  });

  it("fails closed when a persisted receipt acknowledgement is tampered", async () => {
    const filePath = await tempCheckpointPath();
    const provider = transport();
    const appender = durableAppender();
    const service = await makeService(filePath, { transport: provider, usageAppender: appender });
    await service.execute(request);
    await service.reconcilePending();

    const envelope = JSON.parse(await readFile(filePath, "utf8"));
    envelope.checkpoints[0].receiptAppend.receiptDigest = "f".repeat(64);
    await writeFile(filePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });

    const restarted = await makeService(filePath, { transport: provider, usageAppender: appender });
    await expect(restarted.reconcilePending()).rejects.toMatchObject({
      code: "checkpoint_file_invalid",
    });
    expect(provider.submit).toHaveBeenCalledTimes(1);
  });
});
