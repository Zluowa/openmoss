// FILE: spacePageApps.ts
// Purpose: The 资料空间's narrow view of 应用页 (runnable HTML pages) — list them beside pages
//          and promote a chat's HTML file into one.
// Layer: Space UI adapter
// Why: 应用页 live in their own tables behind the `/api/page-apps/*` HTTP routes (apps-runtime
//      stream, `pageAppsClient.ts`). Until that branch is integrated the routes answer 404, so
//      every call here degrades to "none yet" instead of failing the whole Space. The shapes mirror
//      `packages/contracts/src/pageApps.ts` (PageApp, PageAppsListInput, the `create` mutation);
//      once both land, replace these local types with the contract's.

import type { PageSpaceId, SpaceId, ThreadId } from "@moss/contracts";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

export interface SpacePageApp {
  readonly id: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly spaceId: PageSpaceId | null;
  readonly title: string;
  readonly description: string;
  readonly revision: number;
  readonly favorite: boolean;
  readonly thumbnail: string | null;
  readonly sourceThreadId: ThreadId | null;
  readonly trashedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One JSON call to the 应用页 HTTP routes; `null` when this build has no such route. */
async function pageAppsRequest<T>(op: "list" | "mutate", body: unknown): Promise<T | null> {
  const response = await fetch(resolveWsHttpUrl(`/api/page-apps/${op}`), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 404) return null;
  const json = (await response.json().catch(() => null)) as
    | (T & { error?: undefined })
    | { error?: { message?: string } }
    | null;
  // A build without the routes may answer with its HTML shell instead of a 404.
  if (json === null) return null;
  if (!response.ok || (json as { error?: unknown }).error) {
    const error = (json as { error?: { message?: string } } | null)?.error;
    throw new Error(error?.message ?? `应用页请求失败（HTTP ${response.status}）`);
  }
  return json as T;
}

export async function listSpacePageApps(scopeSpaceId: SpaceId | null): Promise<SpacePageApp[]> {
  const result = await pageAppsRequest<{ apps: readonly SpacePageApp[] }>("list", {
    scopeSpaceId,
    includeTrashed: true,
  }).catch(() => null);
  return result ? [...result.apps] : [];
}

/** Saves an HTML document as a new 应用页. Throws when this build has no 应用页 yet. */
export async function promoteHtmlToPageApp(input: {
  scopeSpaceId: SpaceId | null;
  title: string;
  html: string;
  sourceThreadId: ThreadId | null;
  /** Document space to file it in; null or omitted is 个人. */
  spaceId?: PageSpaceId | null;
}): Promise<SpacePageApp> {
  const result = await pageAppsRequest<{ app: SpacePageApp }>("mutate", {
    op: "create",
    requestId: crypto.randomUUID(),
    scopeSpaceId: input.scopeSpaceId,
    title: input.title,
    html: input.html,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    sourceThreadId: input.sourceThreadId,
  });
  if (!result) throw new Error("应用页会在这个版本中推出，暂时无法保存。");
  return result.app;
}
