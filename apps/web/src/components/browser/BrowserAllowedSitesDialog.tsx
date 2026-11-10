// FILE: BrowserAllowedSitesDialog.tsx
// Purpose: "Manage allowed sites…": the sites a page opened from a local file may open or
//   load from. Local pages reach nothing else; this list is the only way out.
// Layer: BrowserPanel UI

import type { BrowserPanelMethods, BrowserPanelPreferences } from "@moss/contracts";
import { useEffect, useState } from "react";

import { GlobeIcon, XIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";

export function BrowserAllowedSitesDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly panelApi: BrowserPanelMethods;
}) {
  const { t, format } = useTranslation();
  const { panelApi, open } = props;
  const [preferences, setPreferences] = useState<BrowserPanelPreferences | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void panelApi.getPreferences().then((next) => {
      if (!cancelled) setPreferences(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, panelApi]);

  const sites = preferences?.allowedSites ?? [];
  const addSite = () => {
    const value = draft.trim();
    if (!value) return;
    void panelApi.addAllowedSite(value).then(
      (next) => {
        setPreferences(next);
        setDraft("");
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : t("browser.allowedSites.invalid")),
    );
  };

  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md" data-browser-allowed-sites="">
        <DialogHeader>
          <DialogTitle>{t("browser.allowedSites.title")}</DialogTitle>
          <DialogDescription>{t("browser.allowedSites.description")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addSite();
            }}
          >
            <Input
              value={draft}
              placeholder="https://example.com"
              aria-label={t("browser.allowedSites.inputLabel")}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            <Button type="submit" variant="secondary" disabled={draft.trim().length === 0}>
              {t("browser.allowedSites.add")}
            </Button>
          </form>
          {error ? <p className="m-0 text-ui-sm text-destructive">{error}</p> : null}
          {sites.length === 0 ? (
            <p className="m-0 py-2 text-center text-ui text-muted-foreground">
              {t("browser.allowedSites.empty")}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {sites.map((site) => (
                <li
                  key={site}
                  className="flex h-8 items-center gap-2 rounded-row ps-2 pe-1 hover:bg-[var(--color-background-button-secondary-hover)]"
                >
                  <GlobeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-ui" data-translation-skip="true">
                    {site.replace(/^https:\/\//, "")}
                  </span>
                  <IconButton
                    variant="ghost"
                    size="icon-xs"
                    label={format("browser.allowedSites.remove", { site })}
                    onClick={() => {
                      void panelApi.removeAllowedSite(site).then(setPreferences);
                    }}
                  >
                    <XIcon className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("browser.allowedSites.done")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
