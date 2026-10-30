import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HoolaCanvasBridgeBroker,
  hoolaCanvasRequestIdentity,
  type HoolaCanvasJobSnapshot,
} from "./hoolaCanvasBridge";

const credential = {
  realm: "memfire-phone" as const,
  accessToken: "server-owned-account-token",
  gatewayBaseUrl: "https://moss.example/functions/v1/moss-model-gateway/v1",
};

describe("HoolaCanvasBridgeBroker", () => {
  it.each([
    { startFrameUrl: "blob:reference" },
    { images: ["https://assets.example/start.png"] },
    { reference_images: "https://assets.example/source.png" },
    { referenceVideos: {} },
    { generation_mode: "all-reference" },
    { motionControl: { enabled: true } },
    { metadata: { subject_reference_images: ["https://assets.example/subject.png"] } },
  ])("rejects video options before normalizing, hashing or creating a job: %j", (options) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const persistHistory = vi.fn();
    const broker = new HoolaCanvasBridgeBroker({ fetchImpl, persistHistory });
    const input = {
      projectId: "p",
      operation: "video",
      modelId: "wan3.0-video",
      prompt: "A cat",
      idempotencyKey: "video-1",
      ...options,
    };
    expect(() => hoolaCanvasRequestIdentity(input)).toThrow("invalid_request");
    expect(() => broker.create(input)).toThrow("invalid_request");
    expect(broker.list()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(persistHistory).not.toHaveBeenCalled();
  });

  it("still submits a plain video and queries that original task", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const broker = new HoolaCanvasBridgeBroker({
      pollMs: 0,
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push({ path, body: JSON.parse(String(init?.body)) });
        return path.endsWith("/generations")
          ? Response.json({ taskToken: "video-task-1", pending: true }, { status: 202 })
          : Response.json({ pending: false, videoUrl: "https://assets.example/video.mp4" });
      },
    });
    const job = broker.create({
      projectId: "p",
      operation: "video",
      modelId: "wan3.0-video",
      prompt: "A cat",
      idempotencyKey: "text-video-1",
      referenceImages: [],
      duration: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      generateAudio: false,
      promptExtend: true,
    });
    expect((await broker.run(job.jobId, credential)).status).toBe("succeeded");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({
      prompt: "A cat",
      generateAudio: false,
      promptExtend: true,
    });
    expect(calls[1]?.body).toMatchObject({ taskToken: "video-task-1" });
  });

  it("canonicalizes first-last aliases, hashes all source images, and strips them from history", async () => {
    const bodies: Record<string, unknown>[] = [];
    const broker = new HoolaCanvasBridgeBroker({
      pollMs: 0,
      fetchImpl: async (url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return String(url).endsWith("/generations")
          ? Response.json({ taskToken: "original-video-task", pending: true }, { status: 202 })
          : Response.json({ pending: false, videoUrl: "https://assets.example/result.mp4" });
      },
    });
    const input = {
      projectId: "p",
      operation: "video",
      modelId: "wan3.0-video",
      prompt: "A cat",
      idempotencyKey: "first-last-video",
      first_frame_url: "https://assets.example/first.png",
      last_frame_url: "https://assets.example/last.png",
    };
    const job = broker.create(input);
    expect(() =>
      broker.create({ ...input, last_frame_url: "https://assets.example/changed.png" }),
    ).toThrow("idempotency_conflict");
    expect((await broker.run(job.jobId, credential)).status).toBe("succeeded");
    expect(bodies[0]).toMatchObject({
      generationMode: "start-end",
      startFrameUrl: input.first_frame_url,
      endFrameUrl: input.last_frame_url,
    });
    expect(bodies).toHaveLength(2);
    const history = broker.durableJobs()[0]!;
    expect(history.checkpoint.input).not.toHaveProperty("startFrameUrl");
    expect(history.checkpoint.input).not.toHaveProperty("endFrameUrl");
    expect(history.requestDigest).toBe(hoolaCanvasRequestIdentity(input).requestDigest);
  });

  it.each(["MEDIA_ADMISSION_MAINTENANCE", "PROXY_CAPACITY_EXCEEDED"])(
    "records a pre-forward %s rejection without inventing an unknown bill or resubmitting",
    async (code) => {
      const paths: string[] = [];
      const broker = new HoolaCanvasBridgeBroker({
        fetchImpl: async (url) => {
          paths.push(new URL(String(url)).pathname);
          return Response.json({ error: { code } }, { status: 503 });
        },
      });
      const job = broker.create({
        projectId: "p",
        operation: "text_to_image",
        modelId: "seedream-5-0",
        prompt: "Admission must reject before submission",
        idempotencyKey: `admission-${code}`,
      });
      const completed = await broker.run(job.jobId, credential);
      expect(completed).toMatchObject({
        status: "failed_terminal",
        errorCode: code,
        billingStatus: "released",
        billing: { actualCostNano: 0 },
      });
      expect(await broker.run(job.jobId, credential)).toEqual(completed);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/\/images\/generations$/);
    },
  );

  it("keeps an unrecognized 503 outcome uncertain and never submits it again", async () => {
    const paths: string[] = [];
    const broker = new HoolaCanvasBridgeBroker({
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        return Response.json(
          {
            error: {
              code: path.endsWith("/generations") ? "upstream_timeout" : "operation_not_found",
            },
          },
          { status: path.endsWith("/generations") ? 503 : 404 },
        );
      },
    });
    const job = broker.create({
      projectId: "p",
      operation: "text_to_image",
      modelId: "seedream-5-0",
      prompt: "Unknown provider acceptance",
      idempotencyKey: "admission-unknown-503",
    });
    expect(await broker.run(job.jobId, credential)).toMatchObject({
      status: "reconciliation_required",
      billingStatus: "unknown",
    });
    expect(await broker.run(job.jobId, credential)).toMatchObject({
      status: "reconciliation_required",
      billingStatus: "unknown",
    });
    expect(paths.filter((path) => path.endsWith("/generations"))).toHaveLength(1);
    expect(paths.at(-1)).toMatch(/\/media\/query$/);
  });

  it("reconciles a failed task's late actual bill through queries without another generation", async () => {
    const paths: string[] = [];
    let billAvailable = false;
    const broker = new HoolaCanvasBridgeBroker({
      pollMs: 0,
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith("/generations"))
          return Response.json({ taskToken: "failed-task", billingStatus: "pending" });
        return Response.json({
          status: "failed",
          terminal: true,
          pending: false,
          billingStatus: billAvailable ? "captured" : "unknown",
          walletKind: "package_cost_v1",
          ...(billAvailable
            ? { actualCostNano: 29_250_000, chargedNanoCny: "195811200", currency: "USD" }
            : {}),
          error: { code: "provider_generation_failed" },
        });
      },
    });
    const job = broker.create({
      projectId: "p",
      operation: "text_to_image",
      modelId: "gpt-image-2-official",
      prompt: "test",
      idempotencyKey: "failed-bill-query",
    });
    expect(await broker.run(job.jobId, credential)).toMatchObject({
      status: "failed_terminal",
      billingStatus: "unknown",
    });
    billAvailable = true;
    expect(await broker.refreshBilling(job.jobId, credential)).toMatchObject({
      status: "failed_terminal",
      billingStatus: "captured",
      billing: {
        walletKind: "package_cost_v1",
        actualCostNano: 29_250_000,
        chargedNanoCny: "195811200",
      },
    });
    expect(paths.filter((path) => path.endsWith("/generations"))).toHaveLength(1);
    expect(paths.filter((path) => path.endsWith("/query"))).toHaveLength(2);
  });
  it.each(["captured", "failed", "transport", "missing"])(
    "refreshes billing after an in-flight completion checkpoint (%s)",
    async (outcome) => {
      let releaseCompletion!: () => void;
      let markCompletionStarted!: () => void;
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      const completionStarted = new Promise<void>((resolve) => {
        markCompletionStarted = resolve;
      });
      let released = false;
      let submissions = 0;
      let queries = 0;
      const broker = new HoolaCanvasBridgeBroker({
        pollMs: 0,
        persistHistory: async (job) => {
          if (job.snapshot.status === "succeeded" && !released) {
            markCompletionStarted();
            await completionGate;
          }
        },
        fetchImpl: async (url) => {
          if (String(url).endsWith("/generations")) {
            submissions += 1;
            return Response.json({ taskToken: "completion-task", billingStatus: "pending" });
          }
          queries += 1;
          if (queries > 1 && outcome === "transport") throw new Error("billing transport failed");
          return Response.json({
            status: queries > 1 && outcome === "failed" ? "failed" : "completed",
            pending: false,
            billingStatus: queries > 1 && outcome === "captured" ? "captured" : "unknown",
            imageUrl: "https://assets.example/completed.png",
          });
        },
      });
      const job = broker.create({
        projectId: "p",
        operation: "text_to_image",
        modelId: "gpt-image-2-official",
        prompt: "test",
        idempotencyKey: `completion-billing-${outcome}`,
      });
      const generating = broker.run(job.jobId, credential);
      try {
        await completionStarted;
        expect(broker.get(job.jobId)?.status).toBe("succeeded");
        const checking = Promise.all([
          broker.refreshBilling(job.jobId, credential),
          broker.refreshBilling(job.jobId, credential),
        ]);
        void checking.catch(() => undefined);
        expect(queries).toBe(1);
        released = true;
        releaseCompletion();
        await generating;
        if (outcome === "failed" || outcome === "transport") {
          await expect(checking).rejects.toThrow(
            outcome === "failed" ? "billing_query_failed" : "billing transport failed",
          );
        } else {
          const results = await checking;
          expect(results.map((result) => result.billingStatus)).toEqual([
            outcome === "captured" ? "captured" : "unknown",
            outcome === "captured" ? "captured" : "unknown",
          ]);
        }
        expect(submissions).toBe(1);
        expect(queries).toBe(2);
        expect(broker.get(job.jobId)).toMatchObject({
          status: "succeeded",
          imageUrls: ["https://assets.example/completed.png"],
          billingStatus: outcome === "captured" ? "captured" : "unknown",
        });
      } finally {
        released = true;
        releaseCompletion();
        await generating;
      }
    },
  );

  it("commits the output and a newer revision before awaiting its cache, even with an unchanged clock", async () => {
    let release!: () => void;
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const downloadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed: HoolaCanvasJobSnapshot[] = [];
    const broker = new HoolaCanvasBridgeBroker({
      now: () => 1000,
      pollMs: 0,
      persistHistory: async (job) => {
        committed.push(job.snapshot);
      },
      cacheOutputs: async () => {
        started();
        await downloadGate;
        return [];
      },
      fetchImpl: async (url) =>
        String(url).endsWith("/generations")
          ? Response.json({ taskToken: "same-task", billingStatus: "pending" })
          : Response.json({
              status: "completed",
              pending: false,
              billingStatus: "captured",
              imageUrl: "https://assets.example/ready.png",
            }),
    });
    const job = broker.create({
      projectId: "p",
      operation: "text_to_image",
      modelId: "gpt-image-2-official",
      prompt: "test",
      idempotencyKey: "cache-checkpoint",
    });
    const running = broker.run(job.jobId, credential);
    let intermediate = 0;
    try {
      await downloading;
      const visible = broker.get(job.jobId)!;
      expect(visible).toMatchObject({
        status: "running",
        billingStatus: "captured",
        imageUrls: ["https://assets.example/ready.png"],
      });
      expect(committed.at(-1)).toEqual(visible);
      expect(visible.revision).toBeGreaterThan(committed.at(-2)!.revision!);
      intermediate = visible.revision!;
    } finally {
      release();
    }
    const completed = await running;
    expect(completed.revision).toBeGreaterThan(intermediate);
    expect(completed.createdAt).toBe(job.createdAt);
    expect(committed.at(-1)).toEqual(completed);
  });
  it("does not send a provider request until the independent history commit succeeds", async () => {
    const upstreamCalls: string[] = [];
    let historyUnavailable = true;
    const broker = new HoolaCanvasBridgeBroker({
      persistHistory: async () => {
        if (historyUnavailable) throw new Error("history commit failed");
      },
      fetchImpl: async (url) => {
        upstreamCalls.push(String(url));
        return Response.json({ terminal: true, status: "failed", billingStatus: "released" });
      },
    });
    const job = broker.create({
      projectId: "p",
      operation: "text_to_image",
      modelId: "gpt-image-2-official",
      prompt: "test",
      idempotencyKey: "durable-first",
    });
    await expect(broker.run(job.jobId, credential)).rejects.toThrow("history commit failed");
    expect(upstreamCalls).toHaveLength(0);
    expect(broker.get(job.jobId)?.status).toBe("running");
    historyUnavailable = false;
    await broker.run(job.jobId, credential);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]).toMatch(/\/query$/u);
  });

  it.each(["unknown bill", "failed output persistence", "failed terminal archive"] as const)(
    "keeps a %s pinned when the active queue reaches 256",
    async (failure) => {
      let submissions = 0;
      const broker = new HoolaCanvasBridgeBroker({
        pollMs: 0,
        persistHistory: async (job) => {
          if (failure === "failed terminal archive" && job.snapshot.status === "succeeded")
            throw new Error("terminal commit failed");
        },
        ...(failure === "failed output persistence" ? { cacheOutputs: async () => [] } : {}),
        fetchImpl: async (url) => {
          if (String(url).endsWith("/generations")) {
            submissions++;
            return Response.json({ taskToken: "one-task" });
          }
          return Response.json({
            status: "completed",
            pending: false,
            billingStatus: failure === "unknown bill" ? "unknown" : "captured",
            imageUrl: "https://assets.example/output.png",
          });
        },
      });
      const input = {
        projectId: "p",
        operation: "text_to_image",
        modelId: "gpt-image-2-official",
        prompt: "test",
        idempotencyKey: "original",
      };
      const first = broker.create(input);
      await broker.run(first.jobId, credential);
      expect(broker.get(first.jobId)).toMatchObject(
        failure === "unknown bill"
          ? { status: "succeeded", billingStatus: "unknown", persistenceStatus: "ready" }
          : failure === "failed output persistence"
            ? { status: "succeeded", billingStatus: "captured", persistenceStatus: "failed" }
            : { status: "reconciliation_required" },
      );
      for (let i = 1; i < 256; i++) broker.create({ ...input, idempotencyKey: `queued-${i}` });
      expect(() => broker.create({ ...input, idempotencyKey: "would-evict" })).toThrow(
        "job_capacity_exceeded",
      );
      expect(broker.get(first.jobId)).not.toBeNull();
      expect(broker.create(input).jobId).toBe(first.jobId);
      expect(submissions).toBe(1);
    },
  );
  it("binds mask and transparency to one idempotent job and drops image bytes from submitted checkpoints", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-mask-checkpoint-"));
    const statePath = join(directory, "jobs.json");
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII=";
    const posted: Record<string, unknown>[] = [];
    try {
      const broker = new HoolaCanvasBridgeBroker({
        statePath,
        pollMs: 0,
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/generations")) {
            posted.push(JSON.parse(String(init?.body)));
            return Response.json({ taskToken: "mask-task" });
          }
          return Response.json({
            pending: false,
            status: "completed",
            imageUrl: "https://assets.example/edited.png",
          });
        },
      });
      const input = {
        projectId: "p",
        operation: "image_edit",
        modelId: "gpt-image-2-official",
        prompt: "Remove the marked object",
        referenceImages: [png],
        maskImage: png,
        background: "transparent",
        outputFormat: "png",
        idempotencyKey: "one-mask-edit",
      };
      const created = broker.create(input);
      expect(broker.create(input).jobId).toBe(created.jobId);
      expect(() => broker.create({ ...input, background: "opaque" })).toThrow(
        "idempotency_conflict",
      );
      await broker.run(created.jobId, credential);
      await broker.run(created.jobId, credential);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        maskImage: png,
        background: "transparent",
        outputFormat: "png",
        referenceImages: [png],
      });
      expect(readFileSync(statePath, "utf8")).not.toContain("data:image");
      expect(broker.get(created.jobId)?.status).toBe("succeeded");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects a mask without a local same-size PNG source before creating a job", () => {
    const broker = new HoolaCanvasBridgeBroker();
    expect(() =>
      broker.create({
        projectId: "p",
        operation: "image_edit",
        modelId: "gpt-image-2-official",
        prompt: "erase",
        maskImage: "data:image/png;base64,AA==",
        idempotencyKey: "bad-mask",
      }),
    ).toThrow("invalid_mask_image");
    expect(broker.list()).toEqual([]);
  });
  it("does not submit when durable checkpoint replacement fails after temporary creation", () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-checkpoint-failure-"));
    const statePath = join(directory, "jobs.json");
    mkdirSync(statePath);
    let calls = 0;
    const broker = new HoolaCanvasBridgeBroker({
      statePath,
      fetchImpl: async () => {
        calls += 1;
        return new Response();
      },
    });
    expect(() =>
      broker.create({
        projectId: "p",
        operation: "text_to_image",
        modelId: "seedream-5-0",
        prompt: "test",
        idempotencyKey: "persist-failure",
      }),
    ).toThrow("checkpoint_unavailable");
    expect(calls).toBe(0);
  });
  it("submits and queries one image job without exposing the account token", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const broker = new HoolaCanvasBridgeBroker({
      pollMs: 0,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
          body,
        });
        if (String(url).endsWith("/images/generations")) {
          return new Response(
            JSON.stringify({
              taskToken: "opaque-task-token",
              provider: "apimart-gpt-image",
              billingExempt: true,
            }),
            { status: 202 },
          );
        }
        return new Response(
          JSON.stringify({
            pending: false,
            status: "completed",
            imageUrl: "https://assets.example/generated.png",
          }),
          { status: 200 },
        );
      },
    });

    const created = broker.create({
      projectId: "project-1",
      targetCardId: "card-1",
      operation: "image_edit",
      modelId: "gpt-image-2-official",
      prompt: "Relight this image",
      referenceImages: ["https://assets.example/source.png"],
      resolution: "1K",
      aspectRatio: "1:1",
      idempotencyKey: "image-edit:project-1:card-1",
    });
    const completed = await broker.run(created.jobId, credential);

    expect(completed).toMatchObject({
      status: "succeeded",
      outputAssetUrl: "https://assets.example/generated.png",
      metadata: { provider: "apimart-gpt-image", billingExempt: true },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://moss.example/functions/v1/moss-model-gateway/v1/canvas/images/generations",
      "https://moss.example/functions/v1/moss-model-gateway/v1/canvas/media/query",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer server-owned-account-token")).toBe(
      true,
    );
    expect(JSON.stringify(completed)).not.toContain("server-owned-account-token");
  });

  it("replays the same idempotent job and never resubmits it", async () => {
    let submissions = 0;
    const broker = new HoolaCanvasBridgeBroker({
      pollMs: 0,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/images/generations")) {
          submissions += 1;
          return new Response(JSON.stringify({ taskToken: "task-1" }), {
            status: 202,
          });
        }
        return new Response(
          JSON.stringify({
            pending: false,
            imageUrl: "https://assets.example/a.png",
          }),
        );
      },
    });
    const input = {
      projectId: "project-1",
      operation: "text_to_image",
      modelId: "seedream-5-0",
      prompt: "A blue cube",
      idempotencyKey: "same-operation",
    };
    const first = broker.create(input);
    const replay = broker.create(input);
    expect(replay.jobId).toBe(first.jobId);
    await broker.run(first.jobId, credential);
    await broker.run(replay.jobId, credential);
    expect(submissions).toBe(1);
  });

  it("rejects models outside the exact canvas catalog", () => {
    const broker = new HoolaCanvasBridgeBroker();
    expect(() =>
      broker.create({
        projectId: "project-1",
        operation: "text_to_image",
        modelId: "invented-model",
        prompt: "test",
        idempotencyKey: "invalid-model",
      }),
    ).toThrowError("unsupported_model");
  });

  it.each(["queued", "running", "succeeded"] as const)(
    "retains a persisted %s video with legacy options without submitting again",
    async (status) => {
      const directory = mkdtempSync(join(tmpdir(), "moss-hoola-canvas-jobs-"));
      const statePath = join(directory, "jobs.json");
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          jobs: [
            {
              jobId: "moss_persisted_job",
              input: {
                projectId: "project-1",
                operation: "video",
                modelId: "kling-v3-omni",
                prompt: "A cat turns its head",
                referenceImages: [],
                metadata: { sourceVideo: "legacy-metadata-must-remain-queryable" },
                idempotencyKey: "video-operation-1",
              },
              status,
              ...(status === "queued" ? {} : { taskToken: "persisted-provider-task-token" }),
              provider: "apimart-kling-o3",
              createdAt: 1_000,
              updatedAt: 2_000,
            },
          ],
        }),
        { mode: 0o600 },
      );
      chmodSync(statePath, 0o600);
      const calls: string[] = [];
      const broker = new HoolaCanvasBridgeBroker({
        statePath,
        pollMs: 0,
        fetchImpl: async (url, init) => {
          calls.push(String(url));
          expect(JSON.parse(String(init?.body))).toMatchObject(
            status === "queued"
              ? { operationId: expect.stringMatching(/^hoola-canvas:/u) }
              : { taskToken: "persisted-provider-task-token" },
          );
          return new Response(
            JSON.stringify({
              pending: false,
              videoUrl: "https://assets.example/generated.mp4",
            }),
          );
        },
      });
      const completed = await broker.run("moss_persisted_job", credential);
      expect(completed.status).toBe("succeeded");
      expect(calls).toEqual(
        status !== "succeeded"
          ? ["https://moss.example/functions/v1/moss-model-gateway/v1/canvas/media/query"]
          : [],
      );
      // Windows reports synthetic POSIX mode bits; chmod cannot represent its ACL.
      if (process.platform !== "win32") expect(statSync(statePath).mode & 0o077).toBe(0);
      expect(JSON.stringify(completed)).not.toContain("persisted-provider-task-token");
    },
  );

  it("keeps an existing task token across transient query throttling", async () => {
    let calls = 0;
    const broker = new HoolaCanvasBridgeBroker({
      pollMs: 0,
      sleep: async () => undefined,
      fetchImpl: async (url) => {
        calls += 1;
        if (String(url).endsWith("/images/generations")) {
          return new Response(JSON.stringify({ taskToken: "stable-task-token" }), {
            status: 202,
          });
        }
        if (calls === 2) {
          return new Response(JSON.stringify({ error: { code: "provider_query_rejected" } }), {
            status: 503,
          });
        }
        return new Response(
          JSON.stringify({
            pending: false,
            imageUrl: "https://assets.example/recovered.png",
          }),
          { status: 200 },
        );
      },
    });
    const created = broker.create({
      projectId: "project-1",
      operation: "text_to_image",
      modelId: "seedream-5-0",
      prompt: "A recovered image",
      idempotencyKey: "transient-query-recovery",
    });
    const completed = await broker.run(created.jobId, credential);
    expect(completed.status).toBe("succeeded");
    expect(calls).toBe(3);
  });
});
