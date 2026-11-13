import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { outboundHttp } from "@moss/shared/outboundHttp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoolaCanvasBridgeBroker } from "./hoolaCanvasBridge";
import { MossMediaAssetStore } from "./mossMediaAssets";
import { MossMediaHistory } from "./mossMediaHistory";
import { readMossMediaLibraryItems } from "./mossMediaLibrary";
import {
  adoptMediaAccountScope,
  mediaAccountScope,
  mediaScopeBelongsTo,
  MossMediaJobsService,
  type MossMediaCredential,
} from "./mossMediaJobsService";
import { resetMossMediaScopeAdoptionForTest } from "./mossMediaScopeAdoption";

const PRIMARY = "https://moss-models.comiction.cn/functions/v1/moss-model-gateway/v1";
const FALLBACK = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";

const account = (id: string, gatewayBaseUrl: string): MossMediaCredential => ({
  realm: "memfire-phone",
  accessToken: "private-account-bearer",
  gatewayBaseUrl,
  account: { id, realm: "memfire-phone" },
});

/** The scope as Moss computed it before 2026-11-13: it named the gateway URL. */
const legacyScope = (credential: MossMediaCredential) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        credential.realm,
        credential.account.id,
        credential.gatewayBaseUrl.replace(/\/+$/u, ""),
      ]),
    )
    .digest("hex");

const directories: string[] = [];
beforeEach(() => {
  vi.spyOn(outboundHttp, "request").mockImplementation(async (request) => ({
    status: 200,
    body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    headers: new Headers({ "content-type": "image/png" }),
    url: String(request.url),
  }));
});
afterEach(() => {
  resetMossMediaScopeAdoptionForTest();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

/** Generates one image as the old code did: history, assets and jobs under `scope`. */
async function generateUnder(directory: string, scope: string, credential: MossMediaCredential) {
  const history = new MossMediaHistory(directory);
  const assets = new MossMediaAssetStore(directory);
  const broker = new HoolaCanvasBridgeBroker({
    statePath: join(directory, "media-jobs", `${scope}.json`),
    pollMs: 0,
    persistHistory: (job) => history.save(scope, job),
    cacheOutputs: (id, urls, kind) => assets.cache(scope, id, urls, kind),
    fetchImpl: async (url) =>
      String(url).endsWith("/generations")
        ? Response.json({ taskToken: `task-${scope.slice(0, 8)}` })
        : Response.json({
            status: "completed",
            pending: false,
            billingStatus: "captured",
            imageUrl: "https://assets.example/kept.png",
          }),
  });
  const job = broker.create({
    projectId: "images-workspace",
    operation: "text_to_image",
    modelId: "gpt-image-2-official",
    prompt: `made through ${credential.gatewayBaseUrl}`,
    idempotencyKey: `key-${scope.slice(0, 8)}`,
  });
  await broker.run(job.jobId, credential);
  return job.jobId;
}

describe("media saved while scopes named the gateway URL", () => {
  it("is the account's through either entry, and never another account's", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-media-scope-"));
    directories.push(directory);
    const onPrimary = account("account-a", PRIMARY);
    const onFallback = account("account-a", FALLBACK);
    const madeOnPrimary = await generateUnder(directory, legacyScope(onPrimary), onPrimary);
    const madeOnFallback = await generateUnder(directory, legacyScope(onFallback), onFallback);
    // The account-wide Canvas was opened while on the primary.
    mkdirSync(join(directory, "moss-canvas", legacyScope(onPrimary)), { recursive: true });
    writeFileSync(join(directory, "moss-canvas", legacyScope(onPrimary), "board.txt"), "board");

    const service = new MossMediaJobsService({
      stateDirectory: directory,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    for (const credential of [onFallback, onPrimary]) {
      const listed = (await service.history(credential)).jobs.map((job) => job.jobId);
      expect(listed.toSorted()).toEqual([madeOnPrimary, madeOnFallback].toSorted());
      for (const jobId of [madeOnPrimary, madeOnFallback])
        expect((await service.readAsset(jobId, 0, credential)).bytes).toHaveLength(9);
    }

    // Moved, not rewritten: the Canvas folder is the account's now, and the database was
    // copied before its first change.
    const scope = mediaAccountScope(onPrimary);
    expect(readFileSync(join(directory, "moss-canvas", scope, "board.txt"), "utf8")).toBe("board");
    expect(existsSync(join(directory, "moss-canvas", legacyScope(onPrimary)))).toBe(false);
    expect(
      existsSync(join(directory, "media-history", "history.before-account-scope.sqlite")),
    ).toBe(true);

    // A link saved in a chat names the old scope; it still opens, signed out too.
    expect(mediaScopeBelongsTo(onFallback, legacyScope(onPrimary))).toBe(true);
    expect(
      (await service.readSavedAsset(legacyScope(onPrimary), madeOnPrimary, 0)).bytes,
    ).toHaveLength(9);

    // Library items keep the ids they had, so favorites and deletions still apply.
    const libraryIds = (await readMossMediaLibraryItems(directory, onFallback)).map(
      (item) => item.id,
    );
    expect(libraryIds.toSorted()).toEqual(
      [
        `moss-media:${legacyScope(onPrimary)}:${madeOnPrimary}:0`,
        `moss-media:${legacyScope(onFallback)}:${madeOnFallback}:0`,
      ].toSorted(),
    );

    // Another account, through either entry, gets nothing.
    for (const gateway of [PRIMARY, FALLBACK]) {
      const other = account("account-b", gateway);
      expect((await service.history(other)).jobs).toEqual([]);
      await expect(service.readAsset(madeOnPrimary, 0, other)).rejects.toMatchObject({
        status: 404,
      });
      expect(mediaScopeBelongsTo(other, legacyScope(onPrimary))).toBe(false);
    }
  });

  it("creates nothing when there is nothing to move, so a read stays a read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moss-media-scope-"));
    directories.push(directory);
    await adoptMediaAccountScope(directory, account("account-a", PRIMARY));
    expect(readdirSync(directory)).toEqual([]);
  });
});
