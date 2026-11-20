// FILE: DesktopUpdateNoticeDialog.tsx
// Purpose: Tells the user of a build that cannot install updates itself (a Mac build without a
//          Developer ID) that a new Moss is out, with the download page and a per-version「稍后」.
// Layer: Web shell navigation (opened from the rail's update button).

import { useRef } from "react";

import { useTranslation } from "~/localization";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

export function DesktopUpdateNoticeDialog({
  open,
  onOpenChange,
  version,
  onDownload,
  onLater,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly version: string;
  readonly onDownload: () => void;
  /** Hides the notice until a newer version is announced. */
  readonly onLater: () => void;
}) {
  const { t, format } = useTranslation();
  const laterRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup
        className="sm:max-w-md"
        initialFocus={laterRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{format("desktopUpdate.notice.title", { version })}</AlertDialogTitle>
          <AlertDialogDescription>{t("desktopUpdate.notice.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button ref={laterRef} variant="outline" onClick={onLater}>
            {t("desktopUpdate.notice.later")}
          </Button>
          <Button onClick={onDownload}>{t("desktopUpdate.notice.download")}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
