// FILE: useDashboardItemMeta.ts
// Purpose: The 资料空间 list knows an item's kind (`app`) but not its payload. An `app` item that
//          is a 数据看板 should read 数据看板 with its own glyph, so this reads the payload once
//          (cached per revision) and answers the label and icon to show.
// Layer: Web 资料空间 数据看板, used by the space list's cards and rows
// Exports: useSpaceItemMeta

import { isDashboardPayload } from "@moss/shared/spaceItems/dashboard";
import { useQuery } from "@tanstack/react-query";

import { DataDashboardIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import type { SpaceItem } from "../../space/spaceItems";
import { spaceItemMeta, type SpaceKindMeta } from "../../space/spaceKinds";

const DASHBOARD_META: SpaceKindMeta = { label: "数据看板", icon: DataDashboardIcon };

export function useSpaceItemMeta(item: SpaceItem): SpaceKindMeta {
  const page = item.source.type === "page" && item.kind === "app" ? item.source.page : null;
  const query = useQuery({
    queryKey: [
      "space-item-dashboard",
      page?.scopeSpaceId ?? null,
      page?.id ?? null,
      page?.revision ?? 0,
    ],
    queryFn: async () => {
      const read = await ensureNativeApi().pageTypes.read({
        scopeSpaceId: page!.scopeSpaceId,
        pageId: page!.id,
      });
      return read.data !== null && isDashboardPayload(read.data);
    },
    enabled: page !== null,
    staleTime: Infinity,
  });
  return query.data ? DASHBOARD_META : spaceItemMeta(item);
}
