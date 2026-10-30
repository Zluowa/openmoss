import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { LibraryItem, LibraryListResult } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundHttp } from "@synara/shared/outboundHttp";
import {
  MossPhoneAccountService,
  type MossPhoneAccountServiceShape,
} from "./account/Services/MossPhoneAccountService";
import {
  MossCloudAccountService,
  type MossCloudAccountServiceShape,
} from "./account/Services/MossCloudAccountService";
import {
  MossEnterpriseKeyAccount,
  type MossEnterpriseKeyAccountShape,
} from "./account/Services/MossEnterpriseKeyAccount";
import { MossAccountServiceError } from "./account/mossAccountErrors";
import { MossCloudAccountServiceError } from "./account/mossCloudAccountErrors";
import type {
  MossLocalAccountAuthority,
  MossLocalAccountAuthorityState,
} from "./account/mossLocalAccountAuthority";
import { HoolaCanvasBridgeBroker, type HoolaCanvasDurableJob } from "./hoolaCanvasBridge";
import type { LibraryServiceShape } from "./library/Services/LibraryService";
import { MossMediaHistory } from "./mossMediaHistory";
import { mediaAccountScope } from "./mossMediaJobsService";
import { listMossMediaLibrary, MOSS_MEDIA_LIBRARY_PREFIX } from "./mossMediaLibrary";

const roots: string[] = [];
const prefix = "moss-media-library-";
const gateway = "https://cn.example/functions/v1/moss-model-gateway/v1";
const globalGateway = "https://global.example/functions/v1/moss-model-gateway/v1";
const phoneIdentity: MossLocalAccountAuthority = {
  realm: "memfire-phone",
  gatewayBaseUrl: gateway,
  account: { id: "account-a", realm: "memfire-phone" },
};
const otherPhoneIdentity: MossLocalAccountAuthority = {
  ...phoneIdentity,
  account: { id: "account-b", realm: "memfire-phone" },
};
const globalIdentity: MossLocalAccountAuthority = {
  realm: "supabase-google",
  gatewayBaseUrl: globalGateway,
  account: { id: "account-a", realm: "supabase-google" },
};
const timestamp = "2026-10-18T00:00:00.000Z";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of roots.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix))
      throw new Error("Unexpected Library fixture cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});

function savedJob(prompt: string): HoolaCanvasDurableJob {
  const broker = new HoolaCanvasBridgeBroker({ now: () => 1000 });
  broker.create({
    projectId: "thread:original-thread",
    operation: "text_to_image",
    modelId: "gpt-image-2-official",
    prompt,
    idempotencyKey: prompt,
  });
  const job = broker.durableJobs()[0]!;
  return {
    ...job,
    snapshot: {
      ...job.snapshot,
      success: true,
      status: "succeeded",
      billingStatus: "captured",
      persistenceStatus: "ready",
      assets: [
        {
          assetId: "a".repeat(64),
          index: 0,
          kind: "image",
          contentType: "image/jpeg",
          byteLength: 1024,
          downloadPath: `/api/moss/media/assets/${job.snapshot.jobId}/0`,
        },
      ],
    },
    checkpoint: {
      ...job.checkpoint,
      status: "succeeded",
      billingStatus: "captured",
      outputPersistenceStatus: "ready",
    },
  };
}

function mediaRow(identity: MossLocalAccountAuthority, job: HoolaCanvasDurableJob): LibraryItem {
  return {
    id: `${MOSS_MEDIA_LIBRARY_PREFIX}${mediaAccountScope(identity)}:${job.snapshot.jobId}:0`,
    title: "用户重命名.jpg",
    kind: "image",
    source: "user:legacy",
    sourceCli: "moss",
    path: null,
    mimeType: null,
    size: 0,
    favorite: true,
    folderId: "folder-1",
    trashedAt: timestamp,
    originationThreadId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
  vi.stubEnv("MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL", globalGateway);
  const network = vi.fn(() => Promise.reject(new Error("Library must not access a provider")));
  vi.stubGlobal("fetch", network);
  const outbound = vi
    .spyOn(outboundHttp, "request")
    .mockRejectedValue(new Error("Library must not download media"));
  const cloudRead = vi.fn(() => Effect.die("Library must use the saved local account identity"));
  const state: {
    phone: MossLocalAccountAuthorityState;
    cloud: MossLocalAccountAuthorityState;
    phoneReadFailed: boolean;
    cloudReadFailed: boolean;
  } = {
    phone: { activeRealm: "cn", identity: phoneIdentity },
    cloud: { identity: null },
    phoneReadFailed: false,
    cloudReadFailed: false,
  };
  const phoneLocal = vi.fn(() =>
    state.phoneReadFailed
      ? Effect.fail(
          new MossAccountServiceError({ code: "persistence_failed", message: "Local read failed" }),
        )
      : Effect.succeed(state.phone),
  );
  const cloudLocal = vi.fn(() =>
    state.cloudReadFailed
      ? Effect.fail(
          new MossCloudAccountServiceError({
            code: "persistence_failed",
            message: "Local read failed",
          }),
        )
      : Effect.succeed(state.cloud),
  );
  const services = Layer.mergeAll(
    Layer.succeed(MossPhoneAccountService, {
      getLocalAuthority: phoneLocal,
      getSession: cloudRead,
      getAuthorityCredential: cloudRead,
    } as unknown as MossPhoneAccountServiceShape),
    Layer.succeed(MossEnterpriseKeyAccount, {
      getActiveAuthorityCredential: () => Effect.succeed(null),
    } as unknown as MossEnterpriseKeyAccountShape),
    Layer.succeed(MossCloudAccountService, {
      getLocalAuthority: cloudLocal,
      getState: cloudRead,
      getAuthorityCredential: cloudRead,
    } as unknown as MossCloudAccountServiceShape),
  );
  const history = new MossMediaHistory(directory);
  const own = savedJob("saved phone image");
  const other = savedJob("other account image");
  const global = savedJob("saved global image");
  await history.save(mediaAccountScope(phoneIdentity), own);
  await history.save(mediaAccountScope(otherPhoneIdentity), other);
  await history.save(mediaAccountScope(globalIdentity), global);
  const ordinary: LibraryItem = {
    ...mediaRow(phoneIdentity, own),
    id: "local-import",
    title: "local.png",
    source: "user:import",
    favorite: false,
    folderId: null,
    trashedAt: null,
  };
  const result: LibraryListResult = {
    items: [
      ordinary,
      mediaRow(phoneIdentity, own),
      mediaRow(otherPhoneIdentity, other),
      mediaRow(globalIdentity, global),
    ],
    folders: [{ id: "folder-1", title: "Saved", createdAt: timestamp, updatedAt: timestamp }],
  };
  const list = vi.fn<LibraryServiceShape["list"]>(() => Effect.succeed(result));
  const register = vi.fn<LibraryServiceShape["register"]>(() => Effect.succeed({ items: [] }));
  const unsupported = () => Effect.die("Unexpected Library mutation");
  const library: LibraryServiceShape = {
    list,
    register,
    sync: unsupported,
    favorite: unsupported,
    move: unsupported,
    rename: unsupported,
    trash: unsupported,
    restore: unsupported,
    deletePermanently: unsupported,
    createFolder: unsupported,
    renameFolder: unsupported,
    deleteFolder: unsupported,
    importFiles: unsupported,
  };
  const paging = vi.spyOn(MossMediaHistory.prototype, "page");
  const read = (includeMedia = true) =>
    listMossMediaLibrary(directory, library, { includeTrashed: true }, includeMedia).pipe(
      Effect.provide(services),
    );
  return {
    directory,
    state,
    services,
    library,
    list,
    register,
    result,
    ordinary,
    own,
    global,
    phoneLocal,
    cloudLocal,
    cloudRead,
    network,
    outbound,
    paging,
    read,
  };
}

describe("saved media in the local Library", () => {
  it.each(["cn", "global"] as const)(
    "lists only the selected %s account's durable media without refresh or provider traffic",
    async (realm) => {
      const app = await harness();
      if (realm === "global") {
        app.state.phone = { identity: phoneIdentity };
        app.state.cloud = { activeRealm: "global", identity: globalIdentity };
      }
      const identity = realm === "cn" ? phoneIdentity : globalIdentity;
      const job = realm === "cn" ? app.own : app.global;
      const result = await app.read().pipe(Effect.runPromise);
      expect(result.folders).toEqual(app.result.folders);
      expect(result.items).toEqual([
        app.ordinary,
        {
          ...mediaRow(identity, job),
          size: 1024,
          mimeType: "image/jpeg",
          originationThreadId: "original-thread",
          mediaJobId: job.snapshot.jobId,
          mediaImageIndex: 0,
          previewPath: `/api/moss/media/assets/${job.snapshot.jobId}/0`,
        },
      ]);
      expect(app.register).toHaveBeenCalledOnce();
      expect(app.register.mock.calls[0]?.[0].items).toEqual([
        expect.objectContaining({ id: result.items[1]!.id, title: `${job.snapshot.prompt}.jpg` }),
      ]);
      expect(app.list).toHaveBeenCalledExactlyOnceWith({ includeTrashed: true });
      expect(app.paging).toHaveBeenCalledExactlyOnceWith(mediaAccountScope(identity), {
        limit: 50,
      });
      expect(app.phoneLocal).toHaveBeenCalled();
      expect(app.cloudLocal).toHaveBeenCalled();
      expect(app.cloudRead).not.toHaveBeenCalled();
      expect(app.network).not.toHaveBeenCalled();
      expect(app.outbound).not.toHaveBeenCalled();
    },
  );

  it.each([
    "conflicting-realms",
    "phone-read-failed",
    "cloud-read-failed",
    "missing-active-account",
  ])(
    "keeps ordinary local items and never falls back to another saved media account: %s",
    async (failure) => {
      const app = await harness();
      app.state.cloud = { activeRealm: "global", identity: globalIdentity };
      if (failure === "phone-read-failed") app.state.phoneReadFailed = true;
      if (failure === "cloud-read-failed") app.state.cloudReadFailed = true;
      if (failure === "missing-active-account") {
        app.state.phone = { activeRealm: "cn", identity: null };
        app.state.cloud = { identity: globalIdentity };
      }
      const result = await app.read().pipe(Effect.runPromise);
      expect(result.items).toEqual([app.ordinary]);
      expect(app.register).not.toHaveBeenCalled();
      expect(app.paging).not.toHaveBeenCalled();
      expect(app.list).toHaveBeenCalledOnce();
      expect(app.cloudRead).not.toHaveBeenCalled();
      expect(app.network).not.toHaveBeenCalled();
      expect(app.outbound).not.toHaveBeenCalled();
    },
  );

  it("does not resolve any identity or read media when includeMedia is false", async () => {
    const app = await harness();
    const result = await app.read(false).pipe(Effect.runPromise);
    expect(result.items).toEqual([app.ordinary]);
    expect(result.folders).toEqual(app.result.folders);
    expect(app.phoneLocal).not.toHaveBeenCalled();
    expect(app.cloudLocal).not.toHaveBeenCalled();
    expect(app.cloudRead).not.toHaveBeenCalled();
    expect(app.register).not.toHaveBeenCalled();
    expect(app.paging).not.toHaveBeenCalled();
    expect(app.list).toHaveBeenCalledOnce();
  });

  it("reports corrupt local media history instead of silently returning an incomplete library", async () => {
    const app = await harness();
    const broken = join(app.directory, "broken-history");
    await mkdir(join(broken, "media-history"), { recursive: true });
    await writeFile(join(broken, "media-history", "history.sqlite"), "not a SQLite database");
    const result = await listMossMediaLibrary(
      broken,
      app.library,
      { includeTrashed: true },
      true,
    ).pipe(Effect.result, Effect.provide(app.services), Effect.runPromise);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: "生成记录暂时无法读取，请稍后刷新资料库。" },
    });
    expect(app.register).not.toHaveBeenCalled();
    expect(app.list).not.toHaveBeenCalled();
    expect(app.cloudRead).not.toHaveBeenCalled();
    expect(app.network).not.toHaveBeenCalled();
  });

  it("rejects an account change during the local list before returning old-account previews", async () => {
    const app = await harness();
    app.list.mockImplementationOnce(() =>
      Effect.sync(() => {
        app.state.phone = { activeRealm: "cn", identity: otherPhoneIdentity };
        return app.result;
      }),
    );
    const result = await app.read().pipe(Effect.result, Effect.runPromise);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: "账号已变化，请刷新资料库。" },
    });
    expect(app.cloudRead).not.toHaveBeenCalled();
    expect(app.network).not.toHaveBeenCalled();
  });
});
