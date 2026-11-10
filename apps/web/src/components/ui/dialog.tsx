"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { cn } from "~/lib/utils";
import { DISCLOSURE_FADE_MOTION_CLASS } from "~/lib/disclosureMotion";
import { Button, dialogActionButtonClassName } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

const DialogCreateHandle = DialogPrimitive.createHandle;

const Dialog = DialogPrimitive.Root;

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/60 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

/**
 * Single dialog surface: a fully opaque popover fill, a generously rounded shell,
 * and a soft lift shadow — mirrors the command-palette / composer aesthetic.
 * Dialogs have no backdrop blur, so a translucent fill reads muddy over the dark
 * backdrop; keep this surface opaque. */
const dialogPopupClassName =
  "-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-dialog border border-[color:var(--color-border-light)] bg-popover text-[var(--color-text-foreground)] shadow-[0_16px_50px_-12px_rgba(0,0,0,0.34)] dark:shadow-[0_16px_50px_-12px_rgba(0,0,0,0.7)] opacity-[calc(1-0.1*var(--nested-dialogs))] transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0";

// Capsule-shaped buttons (class contains `rounded-full`) keep their own pill
// geometry in footers, so they are excluded from the sizing override.
const dialogFooterButtonSlotSelector =
  "[&_[data-slot=button]:not([class*='size-control']):not([class*='size-9']):not([class*='size-8']):not([class*='size-7']):not([class*='rounded-full'])]";

const dialogFooterButtonClassName = dialogActionButtonClassName
  .split(/\s+/)
  .filter(Boolean)
  .map((className) => `${dialogFooterButtonSlotSelector}:${className.replace(/!/g, "\\!")}`)
  .join(" ");

/** Shared label style for form fields inside dialogs (SpaceEditorDialog, CreateProjectDialog). */
const dialogFieldLabelClassName = "text-ui-sm font-medium text-foreground/80";

/**
 * Inputs inside project dialogs share one minimum height + radius so every control
 * reads as the same size (mirrors EditProfileDialog's field styling).
 */
const PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME =
  "min-h-control rounded-control border-foreground/12";

const dialogPanelFieldClassName =
  "[&_[data-slot=textarea-control]]:min-h-24 [&_[data-slot=textarea-control]_[data-slot=textarea]]:px-2.5 [&_[data-slot=textarea-control]_[data-slot=textarea]]:py-2";

function DialogPopup({
  backdropClassName,
  viewportClassName,
  className,
  children,
  showCloseButton: showCloseButtonProp,
  bottomStickOnMobile: bottomStickOnMobileProp,
  layout = "default",
  ...props
}: DialogPrimitive.Popup.Props & {
  /** Optional per-dialog backdrop treatment for source-faithful feature surfaces. */
  backdropClassName?: string;
  /** Optional viewport treatment (e.g. insets that keep window chrome uncovered). */
  viewportClassName?: string;
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  /** A viewport-sized modal with the same portal, focus trap, and focus restoration. */
  layout?: "default" | "fullscreen";
  /** Legacy Moss callers use `surface="solid"`; this popup is always opaque now. */
  surface?: "solid";
}) {
  const { t } = useTranslation();
  const showCloseButton = showCloseButtonProp ?? true;
  const fullscreen = layout === "fullscreen";
  const bottomStickOnMobile = !fullscreen && (bottomStickOnMobileProp ?? true);
  return (
    <DialogPortal>
      <DialogBackdrop
        className={cn(fullscreen && DISCLOSURE_FADE_MOTION_CLASS, backdropClassName)}
      />
      <DialogViewport
        className={cn(
          fullscreen && "flex p-0",
          bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
          viewportClassName,
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            fullscreen
              ? cn(
                  "relative flex h-full w-full min-h-0 min-w-0 flex-col bg-popover outline-none data-ending-style:opacity-0 data-starting-style:opacity-0",
                  DISCLOSURE_FADE_MOTION_CLASS,
                )
              : dialogPopupClassName,
            bottomStickOnMobile &&
              "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4",
            className,
          )}
          data-slot="dialog-popup"
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label={t("dialog.close")}
              className="absolute end-2 top-2"
              render={<Button size="icon-sm" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

// Compatibility alias for the pre-Base-UI Moss dialog API. Keep the wrapper centralized so
// plugin parity surfaces retain their existing DOM geometry while newer callers use DialogPopup.
const DialogContent = DialogPopup;

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5 px-ui-pad-lg pt-ui-pad-lg pb-ui-pad-sm in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-1",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant: variantProp,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
}) {
  const variant = variantProp ?? "default";
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-ui-gap-xs sm:flex-row sm:flex-wrap sm:justify-end",
        dialogFooterButtonClassName,
        variant === "default" &&
          "px-ui-pad-lg py-ui-pad-md in-[[data-slot=dialog-panel]]:px-0 in-[[data-slot=dialog-panel]]:pb-0",
        variant === "bare" &&
          "px-ui-pad-lg pt-ui-pad-md pb-ui-pad-lg in-[[data-slot=dialog-panel]]:px-0 in-[[data-slot=dialog-panel]]:pb-0",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("min-w-0 break-words font-heading font-semibold text-ui-lg", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-ui", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollFade: scrollFadeProp,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  const scrollFade = scrollFadeProp ?? true;
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "px-ui-pad-lg pb-ui-pad-lg pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-0 in-[[data-slot=dialog-popup]:has(>[data-slot=dialog-footer])]:pb-ui-pad-md",
          dialogPanelFieldClassName,
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  dialogFieldLabelClassName,
  dialogFooterButtonClassName,
  PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME,
  DialogCreateHandle,
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogPopup,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
