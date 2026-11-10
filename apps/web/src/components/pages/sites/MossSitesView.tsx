// FILE: MossSitesView.tsx
// Purpose: The 站点 destination: every page or 应用页 published from this Moss, with owner,
//          visibility, last update and 30-day visits; pin, copy, open, change visibility and
//          unpublish from each row.
// Layer: Space sharing (owned by sharing); mounted by the 资料空间 sidebar's 站点 entry

import type { PageId, PageSite, PageSiteMutateInput, SpaceId } from "@moss/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { AppsIcon, EllipsisIcon, GlobeIcon, PageTextIcon, PinFilledIcon } from "~/lib/icons";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import { ensurePageSharingApi } from "~/nativeApi";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { SearchInput } from "../../ui/search-input";
import { toastManager } from "../../ui/toast";
import {
  RELAY_STATUS_LABELS,
  SITE_VISIBILITY_OPTIONS,
  describePageSharingError,
  formatRelativeTime,
  pageSharingQueryKeys,
  siteVisibilityLabel,
} from "../sharing/pageSharing.logic";

type SitesTab = "all" | "pinned";

export function MossSitesView(props: {
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  /** Opens the site's page in the 资料空间 (also how private sites are viewed). */
  readonly onOpenPage: (pageId: PageId) => void;
}) {
  const { account, scopeSpaceId } = props;
  const client = useQueryClient();
  const queryKey = pageSharingQueryKeys.sites(account, scopeSpaceId);
  const query = useQuery({
    queryKey,
    queryFn: () => ensurePageSharingApi().sitesList({ scopeSpaceId }),
    refetchInterval: 30_000,
  });
  const [tab, setTab] = useState<SitesTab>("all");
  const [search, setSearch] = useState("");
  const sites = useMemo(() => {
    const all = query.data?.sites ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter(
      (site) =>
        (tab === "all" || site.pinned) &&
        (needle === "" || site.title.toLowerCase().includes(needle)),
    );
  }, [query.data, tab, search]);

  const mutate = async (input: PageSiteMutateInput, success?: string) => {
    try {
      const { site } = await ensurePageSharingApi().siteMutate(input);
      client.setQueryData(queryKey, (current: typeof query.data) =>
        current
          ? { ...current, sites: current.sites.map((item) => (item.id === site.id ? site : item)) }
          : current,
      );
      if (success) toastManager.add({ type: "success", title: success });
    } catch (cause) {
      toastManager.add({ type: "error", title: describePageSharingError(cause).message });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col p-6 md:p-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={PAGE_TITLE_CLASS_NAME}>站点</h1>
          <p className="mt-2 text-ui-sm text-muted-foreground">
            从资料空间发布的页面和应用页。在页面的“分享 → 发布”里发布新的站点。
          </p>
        </div>
        <SearchInput
          aria-label="搜索站点"
          placeholder="搜索站点"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="w-56"
        />
      </header>
      <div role="tablist" aria-label="站点视图" className="mb-3 flex gap-1">
        {(
          [
            ["all", "全部"],
            ["pinned", "已置顶"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn(
              "h-7 rounded-control px-2.5 text-ui-sm",
              tab === id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          正在加载站点…
        </p>
      ) : query.isError ? (
        <div role="alert" className="flex items-center gap-3 text-ui-sm text-destructive">
          <span>无法加载站点。{describePageSharingError(query.error).message}</span>
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      ) : sites.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <GlobeIcon className="size-6 opacity-60" aria-hidden />
          <p className="text-ui text-foreground">
            {tab === "pinned" ? "还没有置顶的站点" : search ? "没有匹配的站点" : "还没有站点"}
          </p>
          <p className="max-w-sm text-ui-sm">
            {tab === "pinned"
              ? "在站点的菜单里选择“置顶”，它就会出现在这里。"
              : "打开一个页面，点右上角的“分享”，在“发布”里把它发布成站点。"}
          </p>
        </div>
      ) : (
        <div role="table" aria-label="站点" className="min-h-0 overflow-auto">
          <div
            role="row"
            className="grid grid-cols-[minmax(0,1fr)_6rem_7rem_7rem_8rem_2rem] items-center gap-3 border-b border-border px-2 pb-2 text-ui-xs text-muted-foreground"
          >
            <span role="columnheader">站点</span>
            <span role="columnheader">所有者</span>
            <span role="columnheader">共享对象</span>
            <span role="columnheader">更新时间</span>
            <span role="columnheader" className="text-right">
              访问量（近 30 天）
            </span>
            <span role="columnheader" className="sr-only">
              操作
            </span>
          </div>
          {sites.map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              onOpenPage={() => props.onOpenPage(site.pageId)}
              onMutate={(input, success) => void mutate(input, success)}
              scopeSpaceId={scopeSpaceId}
            />
          ))}
        </div>
      )}
      {query.data && query.data.relayStatus !== "online" && query.data.sites.length > 0 ? (
        <p className="mt-3 text-ui-xs text-muted-foreground">
          {RELAY_STATUS_LABELS[query.data.relayStatus]}
        </p>
      ) : null}
    </div>
  );
}

function SiteRow(props: {
  site: PageSite;
  scopeSpaceId: SpaceId | null;
  onOpenPage: () => void;
  onMutate: (input: PageSiteMutateInput, success?: string) => void;
}) {
  const { site, scopeSpaceId } = props;
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "已复制站点链接" }),
    onError: () => toastManager.add({ type: "error", title: "无法复制链接" }),
  });
  const Icon = site.kind === "app" ? AppsIcon : PageTextIcon;
  const audience = site.published ? siteVisibilityLabel(site.visibility) : "未发布";
  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(0,1fr)_6rem_7rem_7rem_8rem_2rem] items-center gap-3 rounded-control px-2 py-2 text-ui-sm hover:bg-accent/60"
    >
      <button
        role="cell"
        type="button"
        className="flex min-w-0 items-center gap-2 text-left"
        onClick={() => (site.url ? openExternalLink(site.url) : props.onOpenPage())}
        title={site.url ? "在浏览器中打开" : "在资料空间中打开"}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{site.title}</span>
        {site.pinned ? (
          <PinFilledIcon aria-label="已置顶" className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
        {site.hasUnpublishedChanges ? (
          <span className="shrink-0 rounded-inline bg-muted px-1 text-ui-xs text-muted-foreground">
            有新修改
          </span>
        ) : null}
      </button>
      <span role="cell" className="truncate text-muted-foreground">
        你
      </span>
      <span
        role="cell"
        className={cn("truncate", site.published ? "text-foreground" : "text-muted-foreground")}
      >
        {audience}
      </span>
      <span role="cell" className="truncate text-muted-foreground">
        {formatRelativeTime(site.updatedAt)}
      </span>
      <span role="cell" className="text-right tabular-nums text-foreground">
        {site.views30d}
      </span>
      <span role="cell">
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost" aria-label={`${site.title} 的更多操作`} />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end">
            {site.url ? (
              <>
                <MenuItem onClick={() => openExternalLink(site.url!)}>在浏览器中打开</MenuItem>
                <MenuItem onClick={() => copyToClipboard(site.url!)}>复制链接</MenuItem>
              </>
            ) : null}
            <MenuItem onClick={props.onOpenPage}>在资料空间中打开</MenuItem>
            <MenuItem
              onClick={() =>
                props.onMutate({ op: "pin", scopeSpaceId, siteId: site.id, pinned: !site.pinned })
              }
            >
              {site.pinned ? "取消置顶" : "置顶"}
            </MenuItem>
            <MenuSeparator />
            {SITE_VISIBILITY_OPTIONS.filter((option) => option.value !== site.visibility).map(
              (option) => (
                <MenuItem
                  key={option.value}
                  onClick={() =>
                    props.onMutate(
                      {
                        op: "set-visibility",
                        scopeSpaceId,
                        siteId: site.id,
                        visibility: option.value,
                      },
                      `已改为${option.label}`,
                    )
                  }
                >
                  改为{option.label}
                </MenuItem>
              ),
            )}
            {site.published ? null : (
              <MenuItem
                onClick={() =>
                  props.onMutate(
                    {
                      op: "publish",
                      scopeSpaceId,
                      pageId: site.pageId,
                      visibility: site.visibility,
                    },
                    "站点已发布",
                  )
                }
              >
                重新发布
              </MenuItem>
            )}
            {site.published ? (
              <>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() =>
                    props.onMutate(
                      { op: "unpublish", scopeSpaceId, siteId: site.id },
                      "已取消发布，链接不再可用",
                    )
                  }
                >
                  取消发布
                </MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
      </span>
    </div>
  );
}
