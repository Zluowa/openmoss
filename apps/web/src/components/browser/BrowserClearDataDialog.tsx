// FILE: BrowserClearDataDialog.tsx
// Purpose: Confirms "Clear browsing data" before the browser panel's cookies, site storage
//   and cache are removed. Saved logins (the vault) stay.
// Layer: BrowserPanel UI

import type { BrowserPanelMethods } from "@moss/contracts";
import { useState } from "react";

import { useTranslation } from "~/localization";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function BrowserClearDataDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly panelApi: BrowserPanelMethods;
}) {
  const { t } = useTranslation();
  const [clearing, setClearing] = useState(false);
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup className="max-w-md" data-browser-clear-data="">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("browser.clearData.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("browser.clearData.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("browser.clearData.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              void props.panelApi
                .clearBrowsingData()
                .then(
                  () => {
                    toastManager.add({ type: "success", title: t("browser.clearData.done") });
                    props.onOpenChange(false);
                  },
                  (cause: unknown) => {
                    toastManager.add({
                      type: "error",
                      title: t("browser.menu.actionFailed"),
                      description: cause instanceof Error ? cause.message : undefined,
                    });
                  },
                )
                .finally(() => setClearing(false));
            }}
          >
            {t("browser.clearData.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
