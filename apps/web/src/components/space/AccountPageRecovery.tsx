import type { PageAccountRecoveryResult, PageId } from "@moss/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DownloadIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { RecoveryAccountBoundary } from "./RecoveryAccountBoundary";

type Entry = Extract<PageAccountRecoveryResult, { kind: "list" }>["items"][number];
type Catalog =
  | { stage: "loading" }
  | { stage: "error" }
  | { stage: "ready"; entries: readonly Entry[]; notice?: "stale" | "unconfirmed" };

export function AccountPageRecovery({ onRestored }: { onRestored: (id: PageId) => void }) {
  return (
    <RecoveryAccountBoundary>
      {(current) => <RecoveryDialog current={current} onRestored={onRestored} />}
    </RecoveryAccountBoundary>
  );
}

function RecoveryDialog({
  current,
  onRestored,
}: {
  current: () => boolean;
  onRestored: (id: PageId) => void;
}) {
  const { t, locale } = useTranslation();
  const alive = useRef(false);
  const request = useRef(0);
  const busy = useRef(false);
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog>({ stage: "loading" });
  const [restoring, setRestoring] = useState<string | null>(null);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++request.current;
    };
  }, []);
  const valid = useCallback(
    (n: number) => alive.current && current() && request.current === n,
    [current],
  );
  useEffect(() => {
    let watching = true;
    setAvailable(false);
    if (current()) {
      void Promise.resolve()
        .then(() => ensureNativeApi().pages.accountRecovery({ op: "availability" }))
        .then((result) => {
          if (watching && alive.current && current())
            setAvailable(result.kind === "availability" && result.available);
        })
        .catch(() => {});
    }
    return () => {
      watching = false;
    };
  }, [current]);
  async function load(notice?: "stale" | "unconfirmed") {
    const n = ++request.current;
    setCatalog({ stage: "loading" });
    try {
      if (!valid(n)) return;
      const result = await ensureNativeApi().pages.accountRecovery({ op: "list" });
      if (!valid(n)) return;
      setCatalog(
        result.kind === "list"
          ? { stage: "ready", entries: result.items, ...(notice ? { notice } : {}) }
          : { stage: "error" },
      );
    } catch {
      if (valid(n)) setCatalog({ stage: "error" });
    }
  }
  async function restore(entry: Entry) {
    if (busy.current || !current()) return;
    const n = ++request.current;
    busy.current = true;
    setRestoring(entry.recoveryId);
    try {
      const result = await ensureNativeApi().pages.accountRecovery({
        op: "restore",
        recoveryId: entry.recoveryId,
        observation: entry.observation,
      });
      if (!valid(n)) return;
      if (result.kind !== "restored") throw new Error();
      setOpen(false);
      setCatalog({ stage: "loading" });
      onRestored(result.pageId);
    } catch (error) {
      if (!valid(n)) return;
      // An observation is consumed on the server even if its version is now stale.
      // Refresh only the list; a restore is always a new explicit user action.
      const stale =
        typeof error === "object" && error !== null && "code" in error && error.code === "conflict";
      void load(stale ? "stale" : "unconfirmed");
    } finally {
      busy.current = false;
      if (alive.current && current()) setRestoring(null);
    }
  }
  if (!available) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy.current || !current()) return;
        setOpen(next);
        if (next) void load();
        else {
          ++request.current;
          setCatalog({ stage: "loading" });
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <DownloadIcon aria-hidden className="size-3.5" />
        {t("pageRecovery.open")}
      </DialogTrigger>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("pageRecovery.open")}</DialogTitle>
          <DialogDescription>{t("pageRecovery.description")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {catalog.stage === "loading" && (
            <p role="status" className="py-3 text-ui text-muted-foreground">
              {t("pageRecovery.loading")}
            </p>
          )}
          {catalog.stage === "error" && (
            <div className="flex items-center justify-between gap-3 py-3">
              <p role="alert" className="text-ui text-destructive">
                {t("pageRecovery.listError")}
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                {t("pageRecovery.retry")}
              </Button>
            </div>
          )}
          {catalog.stage === "ready" && (
            <>
              {catalog.notice && (
                <p role="alert" className="mb-2 text-ui-sm text-destructive">
                  {t(
                    catalog.notice === "stale" ? "pageRecovery.stale" : "pageRecovery.unconfirmed",
                  )}
                </p>
              )}
              {catalog.entries.length === 0 ? (
                <p className="py-3 text-ui text-muted-foreground">{t("pageRecovery.empty")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {catalog.entries.map((entry) => (
                    <li
                      key={entry.recoveryId}
                      className="flex items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <div className="break-words text-ui font-medium text-foreground">
                          {entry.title}
                        </div>
                        <div className="mt-1 text-ui-xs text-muted-foreground">
                          {t("pageRecovery.confirmed")}{" "}
                          <time dateTime={entry.confirmedAt}>
                            {new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(entry.confirmedAt))}
                          </time>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={restoring !== null}
                        onClick={() => void restore(entry)}
                      >
                        {t(
                          restoring === entry.recoveryId
                            ? "pageRecovery.restoring"
                            : "pageRecovery.restore",
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
