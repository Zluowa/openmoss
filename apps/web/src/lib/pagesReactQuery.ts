import type { PageId, PagesReadResult, SpaceId } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";

export const pagesQueryKeys = {
  scope: (account: string, scopeSpaceId: SpaceId | null) =>
    ["pages", account, scopeSpaceId] as const,
  spaces: (account: string, scopeSpaceId: SpaceId | null) =>
    [...pagesQueryKeys.scope(account, scopeSpaceId), "spaces"] as const,
  list: (account: string, scopeSpaceId: SpaceId | null) =>
    [...pagesQueryKeys.scope(account, scopeSpaceId), "list"] as const,
  read: (account: string, scopeSpaceId: SpaceId | null, pageId: PageId) =>
    [...pagesQueryKeys.scope(account, scopeSpaceId), "read", pageId] as const,
};

export function pageReadQueryOptions(
  account: string,
  scopeSpaceId: SpaceId | null,
  pageId: PageId,
) {
  return {
    queryKey: pagesQueryKeys.read(account, scopeSpaceId, pageId),
    queryFn: (): Promise<PagesReadResult> => ensureNativeApi().pages.read({ scopeSpaceId, pageId }),
    refetchInterval: 5_000,
  };
}
