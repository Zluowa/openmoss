// FILE: WorkspaceImportDialog.tsx
// Purpose: User-facing Import dialog opened from composer /import.
// Layer: Web UI component

import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { useTranslation } from "../localization";
import { WorkspaceImportFlow } from "./WorkspaceImportFlow";

export function WorkspaceImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" showCloseButton>
        <DialogHeader className="gap-0 px-5 pt-5 pb-3">
          <DialogTitle className="text-xl tracking-[-0.01em]">{t("import.title")}</DialogTitle>
        </DialogHeader>
        {open ? (
          <WorkspaceImportFlow variant="dialog" onCancel={() => onOpenChange(false)} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
