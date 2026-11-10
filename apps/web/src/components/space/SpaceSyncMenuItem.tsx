import type { PageSpaceSyncInput } from "@moss/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/localization";
import { MenuCheckboxItem, MenuItem } from "../ui/menu";
import { SpaceAccountPublication } from "./SpaceAccountPublication";

/** Mount only in the opened owner menu. The status operation is local-only. */
export function SpaceSyncMenuItem({
  scopeSpaceId,
  spaceId,
}: Pick<PageSpaceSyncInput, "scopeSpaceId" | "spaceId">) {
  const { t } = useTranslation(),
    client = useQueryClient();
  const key = ["page-space-sync", scopeSpaceId, spaceId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => ensureNativeApi().pages.spaceSync({ scopeSpaceId, spaceId }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
  const change = useMutation({
    mutationFn: (enabled: boolean) =>
      ensureNativeApi().pages.spaceSync({
        scopeSpaceId,
        spaceId,
        enabled,
        observation: query.data?.observation,
      }),
    onSuccess: (state) => {
      client.setQueryData(key, state);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const state = query.data;
  if (
    query.isFetching ||
    !query.isSuccess ||
    !state ||
    (!state.available && !state.canClear && !state.enabled)
  )
    return null;
  return (
    <>
      {(state.available || state.enabled) && (
        <MenuCheckboxItem
          variant="switch"
          checked={state.enabled}
          disabled={change.isPending}
          closeOnClick={false}
          onCheckedChange={(checked) => change.mutate(checked)}
        >
          {t("pageSpace.sync")}
        </MenuCheckboxItem>
      )}
      {scopeSpaceId === null && state.enabled && <SpaceAccountPublication spaceId={spaceId} />}
      {state.canClear && (
        <MenuItem
          closeOnClick={false}
          disabled={change.isPending}
          onClick={() => change.mutate(false)}
        >
          {t("pageSpace.clearSync")}
        </MenuItem>
      )}
      {change.isError && (
        <div role="status" className="px-2 py-1 text-ui-sm text-muted-foreground">
          {t("pageSpace.syncFailed")}
        </div>
      )}
    </>
  );
}
