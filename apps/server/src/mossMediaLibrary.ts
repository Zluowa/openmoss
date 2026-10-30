import type { LibraryItem, LibraryListInput } from "@synara/contracts";
import { Effect } from "effect";
import { MossMediaHistory } from "./mossMediaHistory";
import { mediaAccountScope, type MossMediaIdentity } from "./mossMediaJobsService";
import { validMossMediaAsset } from "./mossMediaAssets";
import { resolveMossMediaIdentity } from "./mossMediaAuthority";
import type { LibraryServiceShape } from "./library/Services/LibraryService";

export const MOSS_MEDIA_LIBRARY_PREFIX = "moss-media:";

/** Only read saved records; listing the Library never resumes or submits a provider job. */
export async function readMossMediaLibraryItems(
  stateDirectory: string,
  identity: MossMediaIdentity,
): Promise<readonly LibraryItem[]> {
  const scope = mediaAccountScope(identity);
  const history = new MossMediaHistory(stateDirectory);
  const items: LibraryItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await history.page(scope, { limit: 50, ...(cursor ? { cursor } : {}) });
    for (const job of page.jobs) {
      if (job.status !== "succeeded" || job.persistenceStatus !== "ready") continue;
      const thread = /^thread:([A-Za-z0-9_-]{1,128})$/u.exec(job.projectId);
      for (const asset of job.assets ?? []) {
        if (!validMossMediaAsset(asset, job.jobId)) continue;
        const extension =
          asset.contentType === "image/jpeg" ? "jpg" : asset.contentType.split("/")[1];
        items.push({
          id: `${MOSS_MEDIA_LIBRARY_PREFIX}${scope}:${job.jobId}:${asset.index}`,
          title: `${job.prompt.slice(0, 100) || "图像"}.${extension}`,
          kind: asset.kind,
          source: "user:legacy",
          sourceCli: "moss",
          path: null,
          mimeType: asset.contentType,
          size: asset.byteLength,
          favorite: false,
          folderId: null,
          trashedAt: null,
          originationThreadId: thread?.[1] ?? null,
          createdAt: job.createdAt,
          updatedAt: job.createdAt,
          mediaJobId: job.jobId,
          mediaImageIndex: asset.index,
          previewPath: asset.downloadPath,
        });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export function listMossMediaLibrary(
  stateDirectory: string,
  library: LibraryServiceShape,
  input: LibraryListInput,
  includeMedia: boolean,
) {
  return Effect.gen(function* () {
    // Saved local records need an account identity, never a refreshed bearer or
    // an available model gateway. Keep local Library access independent of it.
    const identity = includeMedia ? yield* Effect.result(resolveMossMediaIdentity) : null;
    const media =
      identity?._tag === "Success"
        ? yield* Effect.tryPromise({
            try: () => readMossMediaLibraryItems(stateDirectory, identity.success),
            catch: () => new Error("生成记录暂时无法读取，请稍后刷新资料库。"),
          })
        : [];
    if (media.length)
      yield* library.register({
        items: media.map((item) => ({
          id: item.id,
          title: item.title,
          kind: item.kind,
          sourceCli: item.sourceCli,
          mimeType: item.mimeType ?? undefined,
          updatedAt: Date.parse(item.updatedAt),
        })),
      });
    const result = yield* library.list(input);
    if (media.length && identity?._tag === "Success") {
      const currentIdentity = yield* resolveMossMediaIdentity;
      if (mediaAccountScope(currentIdentity) !== mediaAccountScope(identity.success))
        return yield* Effect.fail(new Error("账号已变化，请刷新资料库。"));
    }
    const byId = new Map(media.map((item) => [item.id, item]));
    return {
      ...result,
      items: result.items.flatMap((item) => {
        if (!item.id.startsWith(MOSS_MEDIA_LIBRARY_PREFIX)) return [item];
        const saved = byId.get(item.id);
        // Another account's generated previews must never enter this response.
        return saved
          ? [
              {
                ...saved,
                ...item,
                size: saved.size,
                mimeType: saved.mimeType,
                originationThreadId: saved.originationThreadId,
                mediaJobId: saved.mediaJobId,
                mediaImageIndex: saved.mediaImageIndex,
                previewPath: saved.previewPath,
              },
            ]
          : [];
      }),
    };
  });
}
