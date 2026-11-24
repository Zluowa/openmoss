"use client";

// UI SDK's autocomplete under Moss's API (UI SDK part A, PR 2b). The look is Base UI's: the
// positioned content is a plain box, Moss's surface sits inside it, and the list scrolls in a
// Moss ScrollArea. The text is the value; callers filter (`mode="none"`, UI SDK's `filter={false}`).

import {
  Autocomplete as AutocompletePrimitive,
  AutocompleteClear as AutocompleteClearPrimitive,
  AutocompleteContent,
  AutocompleteEmpty as AutocompleteEmptyPrimitive,
  AutocompleteGroup as AutocompleteGroupPrimitive,
  AutocompleteGroupLabel as AutocompleteGroupLabelPrimitive,
  AutocompleteInput as AutocompleteInputPrimitive,
  AutocompleteItem as AutocompleteItemPrimitive,
  AutocompleteList as AutocompleteListPrimitive,
  AutocompleteSeparator as AutocompleteSeparatorPrimitive,
  AutocompleteStatus as AutocompleteStatusPrimitive,
  AutocompleteTrigger as AutocompleteTriggerPrimitive,
} from "@ui-sdk/react/autocomplete";
import type * as React from "react";

import { ChevronsUpDownIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { POPUP_INHERITANCE_RESET_CLASS_NAME } from "./tooltip";
import { definedProps, renderOpenTrigger, renderSlotted, toAnchor, type Loose } from "./uiSdkProps";

type Slotted = { className?: string | undefined; children?: React.ReactNode };

/** UI SDK forces its own `data-slot` on parts; Moss's name goes back on through `render`. */
const slotted = (slot: string) => (props: Record<string, unknown>) => (
  <div {...props} data-slot={slot} />
);

type AutocompleteProps = Omit<
  Loose<React.ComponentProps<typeof AutocompletePrimitive>>,
  "items" | "onValueChange"
> & {
  /** The suggestions, for UI SDK's empty and status parts; callers render the rows. */
  items?: readonly string[] | undefined;
  /** Base UI's filter mode: `"none"` leaves filtering to the caller (all Moss callers). */
  mode?: "none" | "list" | "both" | "inline" | undefined;
  /** Base UI's name for opening the suggestions when the field is pressed. */
  openOnInputClick?: boolean | undefined;
  onValueChange?: ((value: string, details: unknown) => void) | undefined;
};

function Autocomplete({
  mode,
  openOnInputClick,
  items,
  onValueChange,
  ...props
}: AutocompleteProps) {
  return (
    <AutocompletePrimitive
      {...definedProps<object, React.ComponentProps<typeof AutocompletePrimitive>>({
        ...props,
        items: items ? [...items] : undefined,
        filter: mode === undefined || mode === "none" ? false : "contains",
        openOnFocus: props.openOnFocus ?? openOnInputClick,
        onValueChange,
      })}
    />
  );
}

const END_CONTROL_CLASS_NAME =
  "autocomplete-end-control -translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 items-center justify-center rounded-control border border-transparent opacity-80 outline-none transition-colors pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=autocomplete-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg,&_[data-slot=central-icon]]:pointer-events-none [&_svg,&_[data-slot=central-icon]]:shrink-0";

type AutocompleteInputProps = Omit<
  Loose<React.ComponentProps<typeof AutocompleteInputPrimitive>>,
  "size" | "className"
> & {
  className?: string | undefined;
  showTrigger?: boolean | undefined;
  showClear?: boolean | undefined;
  startAddon?: React.ReactNode;
  size?: "sm" | "default" | "lg" | number | undefined;
  variant?: "default" | "soft" | undefined;
};

function AutocompleteInput({
  className,
  showTrigger: showTriggerProp,
  showClear: showClearProp,
  startAddon,
  size,
  variant: variantProp,
  ...props
}: AutocompleteInputProps) {
  const showTrigger = showTriggerProp ?? false;
  const showClear = showClearProp ?? false;
  const variant = variantProp ?? "default";
  const sizeValue = (size ?? "default") as "sm" | "default" | "lg" | number;

  return (
    <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
      {startAddon && (
        <div
          aria-hidden="true"
          className="[&_svg,&_[data-slot=central-icon]]:-mx-0.5 pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="autocomplete-start-addon"
        >
          {startAddon}
        </div>
      )}
      <AutocompleteInputPrimitive
        {...definedProps<object, React.ComponentProps<typeof AutocompleteInputPrimitive>>(props)}
        render={(inputProps) => (
          <Input
            {...(inputProps as React.ComponentProps<typeof Input>)}
            className={cn(
              startAddon &&
                "data-[size=sm]:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(7.5)-1px)] *:data-[slot=autocomplete-input]:ps-[calc(--spacing(8.5)-1px)] sm:data-[size=sm]:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(7)-1px)] sm:*:data-[slot=autocomplete-input]:ps-[calc(--spacing(8)-1px)]",
              sizeValue === "sm"
                ? "[&:has(+.autocomplete-end-control)_input]:pe-6.5"
                : "[&:has(+.autocomplete-end-control)_input]:pe-7",
              className,
            )}
            data-slot="autocomplete-input"
            nativeInput
            size={sizeValue}
            variant={variant}
          />
        )}
      />
      {showTrigger && (
        <AutocompleteTrigger
          className={cn(END_CONTROL_CLASS_NAME, sizeValue === "sm" ? "end-0" : "end-0.5")}
        >
          <span data-slot="autocomplete-icon">
            <ChevronsUpDownIcon />
          </span>
        </AutocompleteTrigger>
      )}
      {showClear && (
        <AutocompleteClear
          className={cn(END_CONTROL_CLASS_NAME, sizeValue === "sm" ? "end-0" : "end-0.5")}
        />
      )}
    </div>
  );
}

type AutocompletePopupProps = Omit<
  Loose<React.ComponentProps<typeof AutocompleteContent>>,
  "className" | "anchor" | "children"
> & {
  className?: string | undefined;
  children?: React.ReactNode;
  anchor?: Parameters<typeof toAnchor>[0];
};

function AutocompletePopup({
  className,
  children,
  side: sideProp,
  sideOffset: sideOffsetProp,
  align: alignProp,
  anchor,
  ...props
}: AutocompletePopupProps) {
  return (
    <AutocompleteContent
      {...definedProps<object, React.ComponentProps<typeof AutocompleteContent>>({
        ...props,
        anchor: toAnchor(anchor),
      })}
      align={alignProp ?? "start"}
      side={sideProp ?? "bottom"}
      sideOffset={sideOffsetProp ?? 4}
      // Base UI kept popups 5px from the window's edge; UI SDK's default is 8px.
      collisionPadding={(props as { collisionPadding?: number }).collisionPadding ?? 5}
      className={cn(POPUP_INHERITANCE_RESET_CLASS_NAME, "z-50 select-none outline-none")}
      render={(contentProps) => <div {...contentProps} data-slot="autocomplete-positioner" />}
    >
      <span
        className={cn(
          "relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-popover border border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] shadow-lg/5 transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-popover)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          className,
        )}
      >
        <div
          className="flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"
          data-slot="autocomplete-popup"
        >
          {children}
        </div>
      </span>
    </AutocompleteContent>
  );
}

type AutocompleteItemProps = Omit<
  Loose<React.ComponentProps<typeof AutocompleteItemPrimitive>>,
  "className" | "onClick"
> & {
  className?: string | undefined;
  /** Runs when the suggestion is pressed (choosing by Enter reaches the root's onValueChange). */
  onClick?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
};

// Match Input and Select sizing, including changes to the app typography setting.
function AutocompleteItem({ className, onClick, ...props }: AutocompleteItemProps) {
  return (
    <AutocompleteItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof AutocompleteItemPrimitive>>({
        ...props,
        // Choosing a suggestion reaches the root's onValueChange; the row's own click runs too.
        onClick: onClick as React.MouseEventHandler<HTMLDivElement> | undefined,
      })}
      className={cn(
        "flex min-h-8 select-none items-center rounded-control px-2 py-1 text-ui outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:opacity-64 sm:min-h-7 sm:text-ui",
        className,
      )}
      render={slotted("autocomplete-item")}
    />
  );
}

function AutocompleteSeparator({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <AutocompleteSeparatorPrimitive
      {...props}
      className={cn("mx-2 my-1 h-px bg-border last:hidden", className)}
      render={slotted("autocomplete-separator")}
    />
  );
}

function AutocompleteGroup({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <AutocompleteGroupPrimitive
      {...props}
      className={cn("[[role=group]+&]:mt-1.5", className)}
      render={slotted("autocomplete-group")}
    />
  );
}

function AutocompleteGroupLabel({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <AutocompleteGroupLabelPrimitive
      {...props}
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-ui-xs", className)}
      render={slotted("autocomplete-group-label")}
    />
  );
}

function AutocompleteEmpty({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <AutocompleteEmptyPrimitive
      {...props}
      className={cn(
        "not-empty:p-2 text-center text-ui text-muted-foreground sm:text-ui",
        className,
      )}
      render={slotted("autocomplete-empty")}
    />
  );
}

function AutocompleteList({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <AutocompleteListPrimitive
        {...props}
        className={cn("not-empty:scroll-py-1 not-empty:p-1 in-data-has-overflow-y:pe-3", className)}
        render={slotted("autocomplete-list")}
      />
    </ScrollArea>
  );
}

function AutocompleteClear({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <AutocompleteClearPrimitive
      aria-label="Clear"
      {...props}
      className={cn(
        "-translate-y-1/2 absolute end-0.5 top-1/2 inline-flex size-8 shrink-0 items-center justify-center rounded-control border border-transparent opacity-80 outline-none transition-[color,background-color,box-shadow,opacity] pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg,&_[data-slot=central-icon]]:pointer-events-none [&_svg,&_[data-slot=central-icon]]:shrink-0",
        className,
      )}
      render={renderSlotted("button", "autocomplete-clear")}
    >
      <XIcon />
    </AutocompleteClearPrimitive>
  );
}

function AutocompleteStatus({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <AutocompleteStatusPrimitive
      {...props}
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-ui-xs empty:m-0 empty:p-0",
        className,
      )}
      render={slotted("autocomplete-status")}
    />
  );
}

function AutocompleteTrigger({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <AutocompleteTriggerPrimitive
      {...definedProps<object, React.ComponentProps<typeof AutocompleteTriggerPrimitive>>({
        ...props,
        className,
      })}
      render={renderOpenTrigger(undefined, "button", "autocomplete-trigger")}
    />
  );
}

export {
  Autocomplete,
  AutocompleteInput,
  AutocompleteTrigger,
  AutocompletePopup,
  AutocompleteItem,
  AutocompleteSeparator,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteEmpty,
  AutocompleteList,
  AutocompleteClear,
  AutocompleteStatus,
};
