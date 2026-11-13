import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { promoteMossCanvasOwnedMediaAsset, type PromotionFetch } from "./mossCanvasMediaPromotion";

const TOKEN = "server-account-token-never-sent-to-storage";
const NOW = Date.parse("2026-10-16T00:00:00Z");
const credential = {
  account: { id: "owner-a", realm: "memfire-phone" as const },
  realm: "memfire-phone" as const,
  accessToken: TOKEN,
  gatewayBaseUrl: "https://gateway.example/functions/v1/moss-model-gateway/v1",
};
const scope = { threadId: "thread-1", fingerprint: "f".repeat(64) };
const bytes = Uint8Array.from([1, 2, 3, 4]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const input = {
  assetName: `${sha256}.mp4`,
  modelId: "MiniMax-H3",
  projectId: "project-1",
  pageId: "page:1",
  idempotencyKey: "promotion-operation-1",
  expectedAccount: credential.account,
  expectedWorkspace: scope,
};
function success(overrides: Record<string, unknown> = {}) {
  const url = `https://project.example/storage/v1/object/sign/private-media/moss-canvas/v1/memfire-phone/${"a".repeat(64)}/${"e".repeat(64)}.mp4?token=storage-read-capability-test-only`;
  return {
    success: true,
    status: "ready",
    assetId: `moss_media_${"e".repeat(64)}`,
    url,
    assetUrl: url,
    modelId: input.modelId,
    kind: "video",
    contentType: "video/mp4",
    sizeBytes: bytes.length,
    checksumSha256: sha256,
    expiresAt: "2026-10-16T02:00:00.000Z",
    persistenceStatus: "temporary",
    billingStatus: "exempt",
    authority: "moss-desktop-database",
    metadataVerification: "bytes-only",
    storageOrigin: "https://project.example",
    signedUrlTtlSeconds: 7_200,
    objectRetention: "operator-managed",
    ...overrides,
  };
}
function fixture(body: Record<string, unknown> = success(), status = 200) {
  return {
    readAsset: vi.fn(async () => ({ bytes, contentType: "video/mp4" })),
    fetchImpl: vi.fn<PromotionFetch>(async () => Response.json(body, { status })),
    now: () => NOW,
  };
}

describe("owner/workspace-bound Canvas media promotion", () => {
  it("reads the exact owned asset and sends raw bytes only to the configured Moss gateway", async () => {
    const { readAsset, ...options } = fixture(success({ debug: "must never be forwarded" }));
    const response = await promoteMossCanvasOwnedMediaAsset(
      input,
      credential,
      scope,
      readAsset,
      options,
    );
    const body = await response.json();
    expect(body).toEqual(success());
    expect(readAsset).toHaveBeenCalledExactlyOnceWith(input.assetName);
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = options.fetchImpl.mock.calls[0]!;
    expect(String(rawUrl)).toBe(
      "https://gateway.example/functions/v1/moss-model-gateway/v1/canvas/assets/promote-media",
    );
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("content-type")).toBe("video/mp4");
    expect(
      JSON.parse(Buffer.from(headers.get("x-moss-media-promotion")!, "base64url").toString()),
    ).toEqual({
      modelId: input.modelId,
      projectId: input.projectId,
      pageId: input.pageId,
      operationId: input.idempotencyKey,
      workspaceThreadId: scope.threadId,
      workspaceFingerprint: scope.fingerprint,
      sha256,
      sizeBytes: bytes.length,
    });
    expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
  });

  it.each([
    { extension: "mp3", contentType: "audio/mpeg" },
    { extension: "wav", contentType: "audio/wav" },
  ])(
    "promotes an owner-bound $extension asset with its canonical audio MIME",
    async ({ extension, contentType }) => {
      const url = success().url.replace(".mp4?", `.${extension}?`);
      const { fetchImpl, now } = fixture(
        success({ url, assetUrl: url, kind: "audio", contentType }),
      );
      const readAsset = vi.fn(async () => ({ bytes, contentType }));
      const result = await promoteMossCanvasOwnedMediaAsset(
        { ...input, assetName: `${sha256}.${extension}` },
        credential,
        scope,
        readAsset,
        { fetchImpl, now },
      );
      expect(result.status).toBe(200);
      expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("content-type")).toBe(
        contentType,
      );
    },
  );

  it("enforces the independent audio byte ceiling before network", async () => {
    const { fetchImpl, now } = fixture();
    await expect(
      promoteMossCanvasOwnedMediaAsset(
        { ...input, assetName: `${sha256}.wav` },
        credential,
        scope,
        async () => ({ bytes: new Uint8Array(15_000_001), contentType: "audio/wav" }),
        { fetchImpl, now },
      ),
    ).rejects.toMatchObject({ code: "canvas_asset_too_large", status: 413 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { expectedAccount: { id: "other", realm: "memfire-phone" } },
    { expectedAccount: { id: "owner-a", realm: "supabase-google" } },
    { expectedWorkspace: { ...scope, fingerprint: "e".repeat(64) } },
    { expectedWorkspace: { ...scope, threadId: "another-thread" } },
    { assetName: "../../other-account.mp4" },
    { assetName: "https://external.example/video.mp4" },
    { url: "https://external.example/video.mp4" },
    { modelId: "happyhorse" },
  ])(
    "rejects unbound ownership, arbitrary paths and upload destinations before reading: %j",
    async (changes) => {
      const { readAsset, ...options } = fixture();
      await expect(
        promoteMossCanvasOwnedMediaAsset(
          { ...input, ...changes },
          credential,
          scope,
          readAsset,
          options,
        ),
      ).rejects.toThrow();
      expect(readAsset).not.toHaveBeenCalled();
      expect(options.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      asset: { bytes: new Uint8Array([9]), contentType: "video/mp4" },
      code: "canvas_asset_corrupt",
    },
    { asset: { bytes, contentType: "audio/mpeg" }, code: "canvas_asset_invalid" },
    {
      asset: { bytes: new Uint8Array(50_000_001), contentType: "video/mp4" },
      code: "canvas_asset_too_large",
    },
  ])("rejects inconsistent owned bytes before network: $code", async ({ asset, code }) => {
    const { fetchImpl, now } = fixture();
    await expect(
      promoteMossCanvasOwnedMediaAsset(input, credential, scope, async () => asset, {
        fetchImpl,
        now,
      }),
    ).rejects.toMatchObject({ code });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry a transport failure or fetch a signed Storage URL with the Moss token", async () => {
    const { readAsset, now } = fixture();
    const fetchImpl = vi.fn<PromotionFetch>(async () => {
      throw new Error("unknown upload outcome");
    });
    await expect(
      promoteMossCanvasOwnedMediaAsset(input, credential, scope, readAsset, { fetchImpl, now }),
    ).rejects.toMatchObject({ code: "canvas_asset_upload_transport_uncertain", status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { gatewayBaseUrl: "https://user:password@external.example/v1" },
    { gatewayBaseUrl: "https://gateway.example/v1?redirect=https://external.example" },
    { gatewayBaseUrl: "http://external.example/v1" },
    { accessToken: "contains whitespace" },
  ])("does not send authentication to an invalid gateway configuration", async (changes) => {
    const { readAsset, ...options } = fixture();
    await expect(
      promoteMossCanvasOwnedMediaAsset(
        input,
        { ...credential, ...changes },
        scope,
        readAsset,
        options,
      ),
    ).rejects.toMatchObject({ code: "media_gateway_unavailable" });
    expect(readAsset).not.toHaveBeenCalled();
    expect(options.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { checksumSha256: "0".repeat(64) },
    { sizeBytes: 999 },
    { metadataVerification: "server-duration-verified" },
    { storageOrigin: "https://another-project.example" },
    { objectRetention: "automatically-deleted" },
    { expiresAt: "2026-10-17T00:00:00.000Z" },
    { url: `${success().url.split("?")[0]}?token=${TOKEN}` },
    {
      url: `${success().url.split("?")[0]}?token=${[...TOKEN].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`,
    },
    {
      url: "https://user:password@external.example/storage/v1/object/sign/bucket/file.mp4?token=external",
    },
  ])("rejects invalid promotion receipts: %j", async (changes) => {
    const { readAsset, ...options } = fixture(
      success({
        ...changes,
        ...(typeof changes.url === "string" ? { assetUrl: changes.url } : {}),
      }),
    );
    await expect(
      promoteMossCanvasOwnedMediaAsset(input, credential, scope, readAsset, options),
    ).rejects.toMatchObject({ code: "canvas_asset_upload_invalid_response" });
  });

  it("returns a bounded actionable error without upstream debug/secret fields", async () => {
    const { readAsset, ...options } = fixture(
      { code: "media_storage_not_configured", message: TOKEN, debug: "secret" },
      503,
    );
    const response = await promoteMossCanvasOwnedMediaAsset(
      input,
      credential,
      scope,
      readAsset,
      options,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      code: "media_storage_not_configured",
      error: { code: "media_storage_not_configured" },
    });
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("supports an independently configured Storage origin without accepting a receipt mismatch", async () => {
    const { readAsset, ...options } = fixture();
    await expect(
      promoteMossCanvasOwnedMediaAsset(input, credential, scope, readAsset, {
        ...options,
        expectedStorageOrigin: "https://another-project.example",
      }),
    ).rejects.toMatchObject({ code: "canvas_asset_upload_invalid_response" });
  });
});
