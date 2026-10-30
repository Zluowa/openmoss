import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HoolaCanvasSegmentsBridgeBroker,
  HoolaCanvasSegmentsBridgeError,
} from "./hoolaCanvasSegmentsBridge";

const credential = {
  realm: "memfire-phone" as const,
  accessToken: "server-owned-moss-account-token",
  gatewayBaseUrl: "https://moss.example/functions/v1/moss-model-gateway/v1",
};

const identity = {
  imageUrl: "https://assets.example/cat.png",
  assetId: "asset-a",
  projectId: "project-a",
  sourcePageId: "page-a",
};

const authorizationInput = {
  ...identity,
  createPath: "/api/segments",
  cachedOnly: false,
  idempotencyKey: "segments:test-operation-a",
  modelId: "grok-segments-v1",
  provider: "gemini-replicate-sam3",
};

function sceneMap() {
  return {
    assetId: identity.assetId,
    imageUrl: identity.imageUrl,
    width: 2,
    height: 2,
    stage: "masks_ready",
    decodeCacheKey: {
      assetId: identity.assetId,
      revision: "revision-a",
      modelId: "grok-segments-v1",
      preprocessVersion: "segments-v6",
    },
    objects: [
      {
        id: "cat-a",
        name: "猫",
        canonicalName: "cat",
        groupKey: "猫",
        instance: 1,
        boxXyxy: [1, 0, 2, 2],
        score: 0.94,
        semanticRole: "subject",
        maskState: "ready",
        maskRle: { size: [2, 2], counts: "22" },
      },
    ],
  };
}

describe("HoolaCanvasSegmentsBridgeBroker", () => {
  it("adapts Hoola cache/authorization/job/mask contracts to the Moss gateway", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const broker = new HoolaCanvasSegmentsBridgeBroker({
      fetchImpl: async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
          body,
        });
        if (init?.method === "POST") {
          return Response.json(
            { jobId: "seg_0123456789abcdef", status: "queued" },
            { status: 202 },
          );
        }
        return Response.json({
          jobId: "seg_0123456789abcdef",
          status: "masks_ready",
          sceneMap: sceneMap(),
        });
      },
    });

    expect(() => broker.cacheOnly({ ...identity, cachedOnly: true }, credential)).toThrowError(
      expect.objectContaining({ code: "SEGMENTS_NOT_CACHED", status: 404 }),
    );
    const authorized = broker.authorize(authorizationInput, credential);
    expect(authorized.creditOperationId).toMatch(/^moss_segments_[0-9a-f]{32}$/u);
    const created = await broker.create(
      {
        ...authorizationInput,
        creditOperationId: authorized.creditOperationId,
      },
      credential,
    );
    expect(created).toEqual({
      status: 202,
      body: { jobId: "seg_0123456789abcdef", status: "queued" },
    });
    const completed = await broker.status("seg_0123456789abcdef", identity, credential);
    expect(completed).toMatchObject({
      status: "masks_ready",
      sceneMap: {
        objects: [
          {
            id: "cat-a",
            name: "猫",
            maskState: "ready",
            maskRef: { segmentId: "cat-a", jobId: "seg_0123456789abcdef" },
          },
        ],
      },
    });
    expect(JSON.stringify(completed)).not.toContain("maskRle");
    expect(broker.mask("cat-a", "seg_0123456789abcdef", identity, credential)).toMatchObject({
      id: "cat-a",
      maskRle: { size: [2, 2], counts: "22" },
    });
    expect(broker.cacheOnly({ ...identity, cachedOnly: true }, credential)).toMatchObject({
      jobId: "seg_0123456789abcdef",
      objects: [{ id: "cat-a", maskState: "ready" }],
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://moss.example/functions/v1/moss-model-gateway/v1/canvas/segments/jobs",
      "https://moss.example/functions/v1/moss-model-gateway/v1/canvas/segments/jobs/seg_0123456789abcdef",
    ]);
    expect(
      calls.every((call) => call.authorization === "Bearer server-owned-moss-account-token"),
    ).toBe(true);
    expect(JSON.stringify(calls[0]?.body)).not.toContain("server-owned-moss-account-token");
  });

  it("persists owner-bound masks in a mode-0600 receipt and restores without provider work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-hoola-segments-"));
    const statePath = join(directory, "segments.json");
    let calls = 0;
    const broker = new HoolaCanvasSegmentsBridgeBroker({
      statePath,
      fetchImpl: async (_url, init) => {
        calls += 1;
        if (init?.method === "POST") {
          return Response.json(
            { jobId: "seg_fedcba9876543210", status: "queued" },
            { status: 202 },
          );
        }
        return Response.json({
          jobId: "seg_fedcba9876543210",
          status: "masks_ready",
          sceneMap: sceneMap(),
        });
      },
    });
    const authorized = broker.authorize(authorizationInput, credential);
    await broker.create(
      {
        ...authorizationInput,
        creditOperationId: authorized.creditOperationId,
      },
      credential,
    );
    await broker.status("seg_fedcba9876543210", identity, credential);
    expect(calls).toBe(2);
    expect(statSync(statePath).isFile()).toBe(true);
    // POSIX mode bits do not describe a Windows DACL.
    if (process.platform !== "win32") expect(statSync(statePath).mode & 0o077).toBe(0);
    expect(readFileSync(statePath, "utf8")).not.toContain(credential.accessToken);

    const restored = new HoolaCanvasSegmentsBridgeBroker({
      statePath,
      fetchImpl: async () => {
        throw new Error("restored cache must not call the gateway");
      },
    });
    expect(restored.cacheOnly({ ...identity, cachedOnly: true }, credential)).toMatchObject({
      jobId: "seg_fedcba9876543210",
      objects: [{ id: "cat-a" }],
    });
    const foreignCredential = { ...credential, accessToken: "another-account-token" };
    expect(() =>
      restored.cacheOnly({ ...identity, cachedOnly: true }, foreignCredential),
    ).toThrowError(expect.objectContaining({ code: "SEGMENTS_NOT_CACHED", status: 404 }));
  });

  it("forwards a bounded local Hoola asset as inline bytes without persisting the source", async () => {
    const localIdentity = {
      ...identity,
      imageUrl: "hoola-local://asset/project-a/cat.png",
      assetId: "moss-local-cat",
    };
    let gatewayBody: Record<string, unknown> | undefined;
    const broker = new HoolaCanvasSegmentsBridgeBroker({
      fetchImpl: async (_url, init) => {
        gatewayBody = JSON.parse(String(init?.body));
        return Response.json({ jobId: "seg_abcdef0123456789", status: "queued" }, { status: 202 });
      },
    });
    const localAuthorization = {
      ...authorizationInput,
      ...localIdentity,
      idempotencyKey: "segments:test-operation-local",
    };
    const authorized = broker.authorize(localAuthorization, credential);
    await expect(
      broker.create(
        {
          ...localAuthorization,
          creditOperationId: authorized.creditOperationId,
          imageDataUrl: "data:image/png;base64,iVBORw==",
        },
        credential,
      ),
    ).resolves.toMatchObject({ status: 202 });
    expect(gatewayBody).toMatchObject({
      ...localIdentity,
      imageDataUrl: "data:image/png;base64,iVBORw==",
      modelId: "grok-segments-v1",
    });
    await expect(
      broker.create(
        {
          ...localAuthorization,
          idempotencyKey: "segments:test-operation-missing-source",
          creditOperationId: authorized.creditOperationId,
        },
        credential,
      ),
    ).rejects.toMatchObject({ code: "SEGMENTS_SOURCE_INVALID", status: 400 });
  });

  it("rejects unbound masks and invalid authorization", () => {
    const broker = new HoolaCanvasSegmentsBridgeBroker();
    expect(() =>
      broker.authorize({ ...authorizationInput, provider: "other" }, credential),
    ).toThrow(HoolaCanvasSegmentsBridgeError);
    expect(() => broker.mask("cat-a", "seg_0123456789abcdef", identity, credential)).toThrowError(
      expect.objectContaining({ code: "SEGMENTS_JOB_NOT_FOUND", status: 404 }),
    );
  });
});
