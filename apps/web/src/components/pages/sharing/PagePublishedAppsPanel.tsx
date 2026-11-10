import type {
  PageId,
  PageShareAppPublicationsInput,
  PageShareAppPublicationsResult,
  SpaceId,
} from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslation } from "~/localization";
import { ensurePageSharingApi } from "~/nativeApi";
import { Button } from "../../ui/button";
import { describePageSharingError } from "./pageSharing.logic";

type Item = PageShareAppPublicationsResult["items"][number];
type Props = {
  account: string;
  scopeSpaceId: SpaceId | null;
  pageId: PageId;
  pageRevision: number;
  entry: PageShareAppPublicationsInput["entry"];
  /** Changes with link or site policy, even if its public address stays the same. */
  policyVersion: string;
};

export function PagePublishedAppsPanel(props: Props) {
  const identity = JSON.stringify([
    props.account,
    props.scopeSpaceId,
    props.pageId,
    props.pageRevision,
    props.entry.kind,
    props.entry.id,
    props.policyVersion,
  ]);
  return <PublishedAppList key={identity} identity={identity} {...props} />;
}

function PublishedAppList({
  identity,
  account: _account,
  policyVersion: _version,
  ...scope
}: Props & { identity: string }) {
  const { t, format } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["page-share-published-apps", identity, offset],
    queryFn: () => ensurePageSharingApi().appPublications({ ...scope, op: "list", offset }),
    retry: false,
  });
  const change = async (item: Item, op: "publish" | "revoke") => {
    if (busy || (op === "publish" && item.revision === null)) return;
    setBusy(true);
    setError(null);
    try {
      const slot = { ...scope, nodePath: item.nodePath, expectedGeneration: item.generation };
      if (op === "publish" && item.revision !== null) {
        await ensurePageSharingApi().appPublications({
          ...slot,
          op,
          appId: item.appId,
          appRevision: item.revision,
        });
      } else {
        await ensurePageSharingApi().appPublications({ ...slot, op: "revoke" });
      }
    } catch (cause) {
      setError(describePageSharingError(cause).message);
    } finally {
      setPending(null);
      await list.refetch();
      setBusy(false);
    }
  };
  if (list.isPending || (!list.isError && !list.data?.items.length && offset === 0)) return null;
  return (
    <section
      className="flex flex-col gap-2 border-t border-border pt-3"
      aria-label={t("page.sharedApp.heading")}
    >
      <h3 className="text-ui-sm font-medium">{t("page.sharedApp.heading")}</h3>
      {list.isError ? (
        <div role="alert" className="text-ui-xs text-muted-foreground">
          {describePageSharingError(list.error).message}{" "}
          <Button size="xs" variant="ghost" onClick={() => void list.refetch()}>
            {t("page.sharedApp.retry")}
          </Button>
        </div>
      ) : null}
      {list.data?.items.map((item) => {
        const key = item.nodePath.join(".");
        const selected = pending?.nodePath.join(".") === key;
        const confirmed = item.confirmedRevision !== null;
        return (
          <div key={key} className="flex flex-col gap-1.5 rounded-card bg-muted/40 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui-sm">
                  {item.title ?? t("page.sharedApp.unavailable")}
                </div>
                <p className="text-ui-xs text-muted-foreground">
                  {confirmed
                    ? format("page.sharedApp.revision", { revision: item.confirmedRevision! })
                    : t("page.sharedApp.hidden")}
                </p>
              </div>
              {confirmed ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void change(item, "revoke")}
                >
                  {t("page.sharedApp.revoke")}
                </Button>
              ) : null}
              {item.revision !== null && item.revision !== item.confirmedRevision && !selected ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setPending(item);
                  }}
                >
                  {confirmed ? t("page.sharedApp.update") : t("page.sharedApp.enable")}
                </Button>
              ) : null}
            </div>
            {selected && pending ? (
              <div className="flex flex-col gap-2">
                <p className="text-ui-xs text-muted-foreground">
                  {format(
                    scope.entry.kind === "link"
                      ? "page.sharedApp.linkConsent"
                      : "page.sharedApp.siteConsent",
                    {
                      title: pending.title ?? t("page.sharedApp.unavailable"),
                      revision: pending.revision ?? "",
                    },
                  )}
                </p>
                <div className="flex justify-end gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setPending(null)}
                  >
                    {t("page.sharedApp.cancel")}
                  </Button>
                  <Button size="xs" disabled={busy} onClick={() => void change(pending, "publish")}>
                    {t("page.sharedApp.confirm")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {error}
        </p>
      ) : null}
      {offset || list.data?.nextOffset != null ? (
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !offset}
            onClick={() => {
              setPending(null);
              setOffset(Math.max(0, offset - 16));
            }}
          >
            {t("page.sharedApp.previous")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || list.data?.nextOffset == null}
            onClick={() => {
              if (list.data?.nextOffset != null) {
                setPending(null);
                setOffset(list.data.nextOffset);
              }
            }}
          >
            {t("page.sharedApp.next")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
