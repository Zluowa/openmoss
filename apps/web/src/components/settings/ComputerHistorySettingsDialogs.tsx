import { useCallback, type ReactNode } from "react";

import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { useTranslation } from "~/localization";

export function ComputerHistoryModal({
  open,
  title,
  onClose,
  size = "default",
  showCloseButton = false,
  onPopupElement,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly size?: "default" | "xwide";
  readonly showCloseButton?: boolean;
  readonly onPopupElement?: (element: HTMLDivElement | null) => void;
  readonly children: ReactNode;
}) {
  const onOpenAutoFocus = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) onPopupElement?.(element);
    },
    [onPopupElement],
  );
  const handlePopupElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) onOpenAutoFocus(element);
      else onPopupElement?.(null);
    },
    [onOpenAutoFocus, onPopupElement],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPopup
        className={`!max-h-full ${
          size === "xwide" ? "w-[680px]" : "w-[520px]"
        } computer-history-dialog-popup max-w-[92vw] overflow-visible rounded-dialog border-0 bg-[var(--color-surface-elevated-secondary)]/90 p-0 text-[var(--color-text-foreground)] shadow-[0_4px_8px_-2px_#0000001a] ring-[0.5px] ring-border backdrop-blur-xl !transition-none !duration-0 data-ending-style:!scale-100 data-starting-style:!scale-100 data-ending-style:!opacity-100 data-starting-style:!opacity-100 data-ending-style:!translate-y-0 data-starting-style:!translate-y-0 motion-reduce:transition-none`}
        backdropClassName="bg-[#00000022] !transition-none !duration-0 data-ending-style:!opacity-100 data-starting-style:!opacity-100 motion-reduce:transition-none"
        bottomStickOnMobile={false}
        showCloseButton={showCloseButton}
        ref={handlePopupElement}
        data-testid="computer-history-dialog"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest(
              "[data-computer-history-permission-popover], [data-computer-history-website-editor]",
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <div
          className="min-h-0 max-h-[calc(100dvh-4rem)] min-w-0 overflow-y-auto p-5"
          data-computer-history-dialog-scroll-owner="true"
        >
          {children}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function ComputerHistoryRuleChip({
  value,
  onRemove,
}: {
  readonly value: string;
  readonly onRemove: () => void;
}) {
  const { format } = useTranslation();
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-1 text-ui-sm">
      <span className="truncate">{value}</span>
      <button
        type="button"
        className="rounded-full px-1 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={format("settings.history.removeRule", { value })}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}
