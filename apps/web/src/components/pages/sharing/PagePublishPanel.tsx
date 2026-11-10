// FILE: PagePublishPanel.tsx
// Purpose: 发布 tab of the share dialog: publish a page or 应用页 as a 站点, choose who can
//          visit it, update it after edits, copy or open its address, and unpublish.
// Layer: Space sharing (owned by sharing)

import type {
  Page,
  PageSite,
  PageSiteMutateInput,
  PageSiteVisibility,
  SpaceId,
} from "@moss/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "~/lib/icons";
import { openExternalLink } from "~/lib/linkChips";
import { ensurePageSharingApi } from "~/nativeApi";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { PublishTermsDialog } from "./PublishTermsDialog";
import { PagePublishedAppsPanel } from "./PagePublishedAppsPanel";
import {
  SITE_VISIBILITY_OPTIONS,
  describePageSharingError,
  formatRelativeTime,
  pageSharingQueryKeys,
} from "./pageSharing.logic";
import { ShareSelect } from "./ShareSelect";

export function PagePublishPanel(props: {
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  readonly page: Page;
  readonly flush?: () => Promise<boolean>;
}) {
  const { account, scopeSpaceId, page } = props;
  const client = useQueryClient();
  const queryKey = pageSharingQueryKeys.siteForPage(account, scopeSpaceId, page.id);
  const query = useQuery({
    queryKey,
    queryFn: () => ensurePageSharingApi().siteForPage({ scopeSpaceId, pageId: page.id }),
  });
  const [visibility, setVisibility] = useState<PageSiteVisibility>("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => toastManager.add({ type: "error", title: "无法复制链接" }),
  });

  const run = async (input: PageSiteMutateInput) => {
    setBusy(true);
    setError(null);
    try {
      const { site } = await ensurePageSharingApi().siteMutate(input);
      client.setQueryData(queryKey, {
        site,
        termsAccepted: input.op === "publish" ? true : (query.data?.termsAccepted ?? false),
      });
      void client.invalidateQueries({
        queryKey: pageSharingQueryKeys.sites(account, scopeSpaceId),
      });
      return site;
    } catch (cause) {
      const described = describePageSharingError(cause);
      if (described.code === "terms-required") setTermsOpen(true);
      else setError(described.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const publish = async (acceptTerms: boolean) => {
    if (props.flush && !(await props.flush())) {
      setError("页面还有没保存的修改，保存后再发布。");
      return;
    }
    const site = await run({
      op: "publish",
      scopeSpaceId,
      pageId: page.id,
      visibility: existing?.published ? existing.visibility : visibility,
      ...(acceptTerms ? { acceptTerms: true } : {}),
    });
    if (site) toastManager.add({ type: "success", title: "站点已发布" });
  };

  if (query.isPending) {
    return <p className="py-6 text-center text-ui-sm text-muted-foreground">正在读取站点…</p>;
  }
  if (query.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 py-6 text-ui-sm text-destructive">
        <span>{describePageSharingError(query.error).message}</span>
        <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    );
  }
  const existing: PageSite | null = query.data.site;
  const published = existing?.published === true;
  const isApp = page.kind === "app";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span
            className={
              published
                ? "rounded-inline bg-success/12 px-1.5 py-0.5 text-ui-xs text-success"
                : "rounded-inline bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground"
            }
          >
            {published ? "已发布" : "未发布"}
          </span>
          {published && existing.publishedAt ? (
            <span className="text-ui-xs text-muted-foreground">
              {formatRelativeTime(existing.publishedAt)}发布 · 近 30 天 {existing.views30d} 次访问
            </span>
          ) : null}
        </div>
        <p className="text-ui-sm text-muted-foreground">
          {isApp
            ? "把这个应用页发布成站点。访客打开的是发布时的版本，应用以访客模式运行。"
            : "把这个页面发布成一个只读站点。访客看到的是发布时的版本，之后的修改要再次发布才会更新。"}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-ui-sm text-foreground">谁可以访问</span>
        <ShareSelect
          label="站点可见性"
          value={published ? existing.visibility : visibility}
          options={SITE_VISIBILITY_OPTIONS}
          disabled={busy}
          variant="default"
          onChange={(next) => {
            if (published) {
              void run({
                op: "set-visibility",
                scopeSpaceId,
                siteId: existing.id,
                visibility: next,
              });
            } else {
              setVisibility(next);
            }
          }}
        />
      </div>

      {published && existing.url ? (
        <div className="flex items-center gap-2 rounded-card border border-border px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-muted-foreground">
            {existing.url}
          </span>
          <Button size="xs" variant="ghost" onClick={() => copyToClipboard(existing.url!)}>
            {isCopied ? <CheckIcon /> : <CopyIcon />}
            {isCopied ? "已复制" : "复制"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => openExternalLink(existing.url!)}>
            <ExternalLinkIcon />
            打开
          </Button>
        </div>
      ) : published && existing.visibility === "private" ? (
        <p className="text-ui-xs text-muted-foreground">
          仅自己可见：站点只在你的 Moss 里打开，没有对外地址。
        </p>
      ) : null}

      {published &&
      existing.visibility !== "private" &&
      existing.publishedRevision !== null &&
      (page.kind ?? "page") === "page" ? (
        <PagePublishedAppsPanel
          account={account}
          scopeSpaceId={scopeSpaceId}
          pageId={page.id}
          pageRevision={existing.publishedRevision}
          entry={{ kind: "site", id: existing.id }}
          policyVersion={JSON.stringify([existing.visibility, existing.publishedAt])}
        />
      ) : null}
      {published && existing.hasUnpublishedChanges ? (
        <p className="text-ui-xs text-warning">页面在发布后又改过，访客还看不到这些修改。</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        {published ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run({ op: "unpublish", scopeSpaceId, siteId: existing.id }).then((site) => {
                if (site) toastManager.add({ type: "success", title: "已取消发布，链接不再可用" });
              })
            }
          >
            取消发布
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={busy || page.trashedAt !== null}
          onClick={() => void publish(false)}
        >
          {published ? "更新发布" : "发布"}
        </Button>
      </div>

      <PublishTermsDialog
        open={termsOpen}
        onOpenChange={setTermsOpen}
        onAccept={() => {
          setTermsOpen(false);
          void publish(true);
        }}
      />
    </div>
  );
}
