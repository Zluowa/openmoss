// FILE: ReleaseHistoryDialog.tsx
// Purpose: Stand-alone dialog with Moss's own release history, for entry points outside
//          Settings (Settings shows the same list in place under 通用 › 更新记录).
// Layer: Overlay — mounted lazily by the caller.

import { useTranslation } from "../localization";
import { MossReleaseHistory } from "./settings/MossReleaseHistory";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface ReleaseHistoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Kept for callers; the newest installed version always starts open. */
  readonly defaultExpandedVersion?: string | null;
}

export default function ReleaseHistoryDialog({ open, onOpenChange }: ReleaseHistoryDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg gap-0 p-0">
        <DialogHeader className="gap-1 p-4 pr-12">
          <DialogTitle className="text-base">{t("releaseHistory.dialog.title")}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="max-h-[min(62vh,520px)] px-4 py-3">
          <MossReleaseHistory />
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("dialog.close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
