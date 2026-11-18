"use client";

// Moss's combobox: a trigger that opens a popup with a search field over a list of choices
// (UI SDK part A, PR 2b). UI SDK's own combobox is a text field with suggestions, and its select
// does not highlight the first match as the person types; Moss's shape is UI SDK's popover holding
// UI SDK's command list, which does (Base UI's `autoHighlight`), runs the highlighted row on Enter,
// leaves filtering to the caller and reports the highlight with its index (for a virtualized list).
// Same API and look as the Base UI version: the positioned content is a plain box with Moss's
// surface inside, the list scrolls in a Moss ScrollArea.

import {
  CommandEmpty as CommandEmptyPrimitive,
  CommandGroup as CommandGroupPrimitive,
  CommandGroupLabel as CommandGroupLabelPrimitive,
  CommandItem as CommandItemPrimitive,
  CommandList as CommandListPrimitive,
  CommandSeparator as CommandSeparatorPrimitive,
  CommandStatus as CommandStatusPrimitive,
} from "@ui-sdk/react/command";
import {
  Popover as PopoverPrimitive,
  PopoverContent,
  PopoverTrigger as PopoverTriggerPrimitive,
} from "@ui-sdk/react/popover";
import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import * as React from "react";

import { CheckIcon, ChevronsUpDownIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
  COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME,
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { Command, CommandSearchInput } from "./command";
import { POPUP_INHERITANCE_RESET_CLASS_NAME } from "./tooltip";
import {
  definedProps,
  renderOpenTrigger,
  renderSlotted,
  toAnchor,
  type Loose,
  type LooseRender,
} from "./uiSdkProps";

type Slotted = { className?: string | undefined; children?: React.ReactNode };

/** UI SDK forces its own `data-slot` on parts; Moss's name goes back on through `render`. */
const slotted = (slot: string) => (props: Record<string, unknown>) => (
  <div {...props} data-slot={slot} />
);

type ComboboxState = {
  /** The selected value (or values, with `multiple`). */
  value: unknown;
  /** Chooses a row: the value changes and the popup closes (or stays, with `multiple`). */
  choose: (value: unknown, event: Event | undefined) => void;
  /** The value each row key stands for (row keys are strings; values may not be). */
  values: Map<string, unknown>;
  onItemHighlighted: ((value: unknown, details: { index: number }) => void) | undefined;
};

const ComboboxContext = React.createContext<ComboboxState | null>(null);

type ComboboxProps = {
  children?: React.ReactNode;
  /** Base UI's rows as data; callers render the rows, so it is accepted only. */
  items?: readonly unknown[] | undefined;
  /** Base UI's filtered rows; callers render exactly these, so it is accepted only. */
  filteredItems?: readonly unknown[] | undefined;
  /** Base UI option; the first shown row is highlighted as the person types anyway. */
  autoHighlight?: boolean | undefined;
  /** Base UI option; a caller's virtualizer scrolls on `onItemHighlighted`'s index. */
  virtualized?: boolean | undefined;
  value?: unknown;
  defaultValue?: unknown;
  onValueChange?: ((value: any, details: { event: Event | undefined }) => void) | undefined;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, details: unknown) => void) | undefined;
  /** The highlighted row's value and its index among the shown rows. */
  onItemHighlighted?: ((value: unknown, details: { index: number }) => void) | undefined;
  multiple?: boolean | undefined;
};

function Combobox({
  children,
  items: _items,
  filteredItems: _filteredItems,
  autoHighlight: _autoHighlight,
  virtualized: _virtualized,
  value: valueProp,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen,
  onOpenChange,
  onItemHighlighted,
  multiple,
}: ComboboxProps) {
  const [ownValue, setOwnValue] = React.useState<unknown>(defaultValue ?? (multiple ? [] : null));
  const value = valueProp === undefined ? ownValue : valueProp;
  const [ownOpen, setOwnOpen] = React.useState(Boolean(defaultOpen));
  const open = openProp ?? ownOpen;
  const values = React.useRef(new Map<string, unknown>()).current;
  const setOpen = React.useCallback(
    (next: boolean, details: unknown) => {
      setOwnOpen(next);
      onOpenChange?.(next, details);
    },
    [onOpenChange],
  );
  const state = React.useMemo<ComboboxState>(
    () => ({
      value,
      values,
      onItemHighlighted,
      choose: (chosen, event) => {
        const next = multiple
          ? Array.isArray(value) && value.includes(chosen)
            ? value.filter((entry) => entry !== chosen)
            : [...(Array.isArray(value) ? value : []), chosen]
          : chosen;
        setOwnValue(next);
        onValueChange?.(next, { event });
        if (!multiple) setOpen(false, { reason: "item-press", event });
      },
    }),
    [multiple, onItemHighlighted, onValueChange, setOpen, value, values],
  );
  return (
    <ComboboxContext.Provider value={state}>
      <PopoverPrimitive
        modal={false}
        open={open}
        onOpenChange={(next: boolean, details: unknown) => setOpen(next, details)}
      >
        {children}
      </PopoverPrimitive>
    </ComboboxContext.Provider>
  );
}

const END_CONTROL_CLASS_NAME =
  "combobox-end-control -translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg,&_[data-slot=central-icon]]:pointer-events-none [&_svg,&_[data-slot=central-icon]]:shrink-0";

type ComboboxInputProps = Omit<
  React.ComponentProps<typeof CommandSearchInput>,
  "render" | "size"
> & {
  className?: string | undefined;
  inputClassName?: string | undefined;
  showTrigger?: boolean | undefined;
  showClear?: boolean | undefined;
  startAddon?: React.ReactNode;
  size?: "sm" | "default" | "lg" | number | undefined;
  /** Drops the field chrome (border, fill, ring) — for search rows that are only a divider. */
  unstyled?: boolean | undefined;
};

/** The search field inside the popup; the caller keeps its text (`value` + `onChange`). */
function ComboboxInput({
  className,
  inputClassName,
  showTrigger: showTriggerProp,
  showClear: showClearProp,
  startAddon,
  size,
  unstyled: unstyledProp,
  ...props
}: ComboboxInputProps) {
  const showTrigger = showTriggerProp ?? true;
  const showClear = showClearProp ?? false;
  const unstyled = unstyledProp ?? false;
  const sizeValue = (size ?? "default") as "sm" | "default" | "lg" | number;

  return (
    <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
      {startAddon && (
        <div
          aria-hidden="true"
          className="[&_svg,&_[data-slot=central-icon]]:-mx-0.5 pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      <CommandSearchInput
        autoFocus
        {...props}
        render={
          <Input
            className={cn(
              startAddon &&
                "data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7.5)-1px)] *:data-[slot=combobox-input]:ps-[calc(--spacing(8.5)-1px)] sm:data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(8)-1px)]",
              sizeValue === "sm"
                ? "[&:has(+.combobox-end-control)_input]:pe-6.5"
                : "[&:has(+.combobox-end-control)_input]:pe-7",
              "has-disabled:opacity-100",
              inputClassName,
              className,
            )}
            data-slot="combobox-input"
            nativeInput
            size={sizeValue}
            unstyled={unstyled}
          />
        }
      />
      {showTrigger && (
        <span
          aria-hidden="true"
          className={cn(
            END_CONTROL_CLASS_NAME,
            "pointer-events-none",
            sizeValue === "sm" ? "end-0" : "end-0.5",
          )}
          data-slot="combobox-icon"
        >
          <ChevronsUpDownIcon />
        </span>
      )}
      {showClear && (
        <ComboboxClear
          className={cn(END_CONTROL_CLASS_NAME, sizeValue === "sm" ? "end-0" : "end-0.5")}
        />
      )}
    </div>
  );
}

type ComboboxTriggerProps = Omit<
  React.ComponentProps<typeof PopoverTriggerPrimitive>,
  "render" | "className" | "children"
> & {
  className?: string | undefined;
  children?: React.ReactNode;
  render?: LooseRender | undefined;
};

function ComboboxTrigger({ className, render, ...props }: ComboboxTriggerProps) {
  return (
    <PopoverTriggerPrimitive
      {...definedProps<object, React.ComponentProps<typeof PopoverTriggerPrimitive>>({
        ...props,
        className,
        render: renderOpenTrigger(render, "button", "combobox-trigger"),
      })}
    />
  );
}

type ComboboxPopupProps = {
  className?: string | undefined;
  children?: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end" | undefined;
  align?: "start" | "center" | "end" | undefined;
  sideOffset?: number | undefined;
  alignOffset?: number | undefined;
  anchor?: Parameters<typeof toAnchor>[0];
  collisionPadding?: number | undefined;
};

function ComboboxPopup({
  className,
  children,
  side: sideProp,
  sideOffset: sideOffsetProp,
  align: alignProp,
  alignOffset,
  anchor,
  collisionPadding,
}: ComboboxPopupProps) {
  const combobox = React.useContext(ComboboxContext);
  return (
    <PopoverContent
      {...definedProps<object, React.ComponentProps<typeof PopoverContent>>({
        anchor: toAnchor(anchor),
        alignOffset,
        align: alignProp ?? "start",
        side: sideProp ?? "bottom",
        sideOffset: sideOffsetProp ?? 4,
        // Base UI kept popups 5px from the window's edge; UI SDK's default is 8px.
        collisionPadding: collisionPadding ?? 5,
      })}
      className={cn(POPUP_INHERITANCE_RESET_CLASS_NAME, "z-50 select-none outline-none")}
      render={(contentProps) => <div {...contentProps} data-slot="combobox-positioner" />}
    >
      <span
        className={cn(
          APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
          "relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) not-dark:bg-clip-padding shadow-lg/5 transition-[scale,opacity]",
          COMPOSER_PICKER_RADIUS_CLASS_NAME,
          className,
        )}
      >
        <Command
          autoHighlight
          mode="none"
          onItemHighlighted={(key, details) =>
            combobox?.onItemHighlighted?.(
              key === undefined ? undefined : (combobox.values.get(key) ?? key),
              { index: details.index ?? -1 },
            )
          }
        >
          <div
            className="flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"
            data-slot="combobox-popup"
          >
            {children}
          </div>
        </Command>
      </span>
    </PopoverContent>
  );
}

type ComboboxItemProps = Omit<
  Loose<React.ComponentProps<typeof CommandItemPrimitive>>,
  "className" | "children" | "value" | "onSelect" | "onClick"
> & {
  className?: string | undefined;
  children?: React.ReactNode;
  value: unknown;
  hideIndicator?: boolean | undefined;
  onClick?: ((event: Event) => void) | undefined;
};

// Match Input and Select sizing, including changes to the app typography setting. The row draws
// what the caller gave it; the check is drawn from the chosen value (no presence cost).
function ComboboxItem({
  className,
  children,
  hideIndicator: hideIndicatorProp,
  value,
  onClick,
  ...props
}: ComboboxItemProps) {
  const hideIndicator = hideIndicatorProp ?? false;
  const combobox = React.useContext(ComboboxContext);
  const key = String(value);
  combobox?.values.set(key, value);
  const chosen = Array.isArray(combobox?.value)
    ? combobox.value.includes(value)
    : combobox?.value === value;
  return (
    <CommandItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof CommandItemPrimitive>>({
        ...props,
        value: key,
        onSelect: (event: Event) => {
          onClick?.(event);
          combobox?.choose(value, event);
        },
      })}
      aria-selected={chosen}
      className={cn(
        `grid min-h-[1.625rem] cursor-default grid-cols-[1fr_auto] items-center gap-3 ${COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME} px-2.5 py-px text-ui text-[var(--color-text-foreground)] outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:opacity-64 sm:min-h-6 sm:text-ui [&_svg:not([class*='size-'])]:size-3 [&_svg,&_[data-slot=central-icon]]:pointer-events-none [&_svg,&_[data-slot=central-icon]]:shrink-0`,
        className,
      )}
      render={(itemProps) => (
        <div {...itemProps} data-selected={chosen ? "" : undefined} data-slot="combobox-item" />
      )}
    >
      <div className={hideIndicator ? "col-start-1 col-span-full" : "col-start-1 min-w-0"}>
        {children}
      </div>
      {hideIndicator || !chosen ? null : (
        <span className="col-start-2 justify-self-end" data-slot="combobox-item-indicator">
          <CheckIcon className="size-3" />
        </span>
      )}
    </CommandItemPrimitive>
  );
}

function ComboboxSeparator({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandSeparatorPrimitive
      {...props}
      className={cn("mx-2 my-1 h-px bg-border last:hidden", className)}
      render={slotted("combobox-separator")}
    />
  );
}

function ComboboxGroup({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandGroupPrimitive
      {...props}
      className={cn("[[role=group]+&]:mt-1.5", className)}
      render={slotted("combobox-group")}
    />
  );
}

function ComboboxGroupLabel({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandGroupLabelPrimitive
      {...props}
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-ui-xs", className)}
      render={slotted("combobox-group-label")}
    />
  );
}

function ComboboxEmpty({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandEmptyPrimitive
      {...props}
      className={cn(
        "not-empty:p-2 text-center text-ui text-muted-foreground sm:text-ui",
        className,
      )}
      render={slotted("combobox-empty")}
    />
  );
}

function ComboboxList({
  className,
  ...props
}: Slotted & { ref?: React.Ref<HTMLDivElement> | undefined } & Record<string, unknown>) {
  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <CommandListPrimitive
        {...props}
        className={cn("not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1", className)}
        render={slotted("combobox-list")}
      />
    </ScrollArea>
  );
}

/** Empties the selection. */
function ComboboxClear({ className, ...props }: Slotted & Record<string, unknown>) {
  const combobox = React.useContext(ComboboxContext);
  return (
    <ButtonPrimitive
      type="button"
      aria-label="Clear"
      {...definedProps<object, React.ComponentProps<typeof ButtonPrimitive>>({
        ...props,
        className,
      })}
      onClick={(event: React.MouseEvent<HTMLElement>) => combobox?.choose(null, event.nativeEvent)}
      render={renderSlotted("button", "combobox-clear")}
    >
      <XIcon />
    </ButtonPrimitive>
  );
}

function ComboboxStatus({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandStatusPrimitive
      {...props}
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-ui-xs empty:m-0 empty:p-0",
        className,
      )}
      render={slotted("combobox-status")}
    />
  );
}

export {
  Combobox,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxSeparator,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxEmpty,
  ComboboxList,
  ComboboxClear,
  ComboboxStatus,
};
