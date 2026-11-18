"use client";

import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import {
  Command as CommandPrimitive,
  CommandEmpty as CommandEmptyPrimitive,
  CommandGroup as CommandGroupPrimitive,
  CommandGroupLabel as CommandGroupLabelPrimitive,
  CommandInput as CommandInputPrimitive,
  CommandItem as CommandItemPrimitive,
  CommandList as CommandListPrimitive,
  CommandSeparator as CommandSeparatorPrimitive,
  CommandStatus as CommandStatusPrimitive,
} from "@ui-sdk/react/command";
import * as React from "react";

import { SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { definedProps, type Loose } from "./uiSdkProps";
import { keepOpenForInnerPopupEscape, useCloseMenusWhenOpen } from "./innerPopupEscape";
import { ShortcutKbd } from "./kbd";

type Slotted = { className?: string | undefined; children?: React.ReactNode };

/** UI SDK forces its own `data-slot` on parts; Moss's name goes back on through `render`. */
const slotted = (slot: string) => (props: Record<string, unknown>) => (
  <div {...props} data-slot={slot} />
);

function CommandDialog(props: React.ComponentProps<typeof CommandDialogPrimitive.Root>) {
  useCloseMenusWhenOpen(props.open);
  // Escape while one of its UI SDK menus, selects or popovers shows closes only that popup.
  return (
    <CommandDialogPrimitive.Root
      {...props}
      onOpenChange={keepOpenForInnerPopupEscape(props.onOpenChange)}
    />
  );
}

const CommandDialogPortal = CommandDialogPrimitive.Portal;

const CommandCreateHandle = CommandDialogPrimitive.createHandle;

function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogBackdrop({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/60 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function CommandDialogViewport({ className, ...props }: CommandDialogPrimitive.Viewport.Props) {
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 flex flex-col items-center justify-center px-4 py-[max(--spacing(4),4vh)] sm:pb-[15vh]",
        className,
      )}
      data-slot="command-dialog-viewport"
      {...props}
    />
  );
}

// Shared popup surface for command palettes and palette-styled dialogs (e.g. the quit confirm):
// same bg, border, overlay, shadow and nested-dialog motion as the ⌘P palette.
const commandDialogPopupClassName =
  "palette-surface squircle relative row-start-2 flex max-h-105 min-h-0 w-full min-w-0 max-w-xl flex-col rounded-dialog border border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] text-[var(--color-text-foreground)] shadow-lg/5 outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-dialog)-1px)] before:bg-[var(--color-background-elevated-secondary)]/72 before:shadow-[0_1px_--theme(--color-black/4%)] data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-1 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]";

function CommandDialogPopup({ className, children, ...props }: CommandDialogPrimitive.Popup.Props) {
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          className={cn(commandDialogPopupClassName, className)}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

/**
 * The search text a `CommandInput` (or `CommandSearchInput`) controls, lifted to the root: Moss
 * callers control it on the field (`value` + `onChange`), UI SDK on the command (`query`).
 */
const CommandQuery = React.createContext<((query: string | undefined) => void) | null>(null);

type CommandProps = {
  children?: React.ReactNode;
  className?: string | undefined;
  /** Base UI's option: `"always"` (or true) highlights the first row while nothing else is. */
  autoHighlight?: boolean | "always" | undefined;
  /** Base UI option; UI SDK keeps the highlight while the pointer leaves anyway. */
  keepHighlight?: boolean | undefined;
  /** Base UI's filter mode: `"none"` leaves filtering to the caller (all Moss callers). */
  mode?: "none" | "list" | "both" | "inline" | undefined;
  /** Base UI's rows as data; Moss callers render the rows, so it is accepted only. */
  items?: readonly unknown[] | undefined;
  /** The highlighted row's value, as the highlight moves (Base UI's `onItemHighlighted`). */
  onItemHighlighted?:
    | ((value: string | undefined, details: { index?: number | undefined }) => void)
    | undefined;
  /**
   * An Escape pressed while the search field has text. UI SDK's command spends that Escape on
   * clearing the text and marks it handled, so a popover around the list ignores it; Base UI left
   * the text and let the popup close. Moss keeps Base UI's behaviour: the text stays, and the popup
   * around the list closes itself here (a dialog around it closes on the same Escape anyway).
   */
  onEscape?: ((event: Event | undefined) => void) | undefined;
};

/**
 * An always-open list of rows under a search field (UI SDK's `Command`). Rows run on press or
 * Enter; the field keeps focus while arrows move the highlight. UI SDK renders a `div` around the
 * field and the list where Base UI rendered nothing; it lays out as if absent (`contents`).
 */
function Command({
  children,
  className,
  autoHighlight,
  keepHighlight: _keepHighlight,
  mode,
  items: _items,
  onItemHighlighted,
  onEscape,
}: CommandProps) {
  const [query, setQuery] = React.useState<string | undefined>(undefined);
  return (
    <CommandQuery.Provider value={setQuery}>
      <CommandPrimitive
        {...definedProps<object, React.ComponentProps<typeof CommandPrimitive>>({
          query,
          // The typed text becomes the query in the same render, so UI SDK's write-back into the
          // field always matches what is there (and never disturbs an input method's composition).
          onQueryChange: (next: string, details?: { reason?: string; event?: Event }) => {
            if (details?.reason === "escape-key") {
              onEscape?.(details.event);
              return;
            }
            setQuery(next);
          },
          filter: mode === undefined || mode === "none" ? false : "contains",
          autoHighlight: autoHighlight === undefined ? true : autoHighlight !== false,
          onValueChange: onItemHighlighted
            ? (value: string | null, details: { index?: number }) =>
                onItemHighlighted(value ?? undefined, { index: details?.index })
            : undefined,
        })}
        className={cn("contents", className)}
        render={slotted("command")}
      >
        {children}
      </CommandPrimitive>
    </CommandQuery.Provider>
  );
}

type CommandSearchInputProps = Omit<
  Loose<React.ComponentProps<typeof CommandInputPrimitive>>,
  "value" | "onChange" | "render"
> & {
  value?: string | undefined;
  onChange?: ((event: React.ChangeEvent<HTMLInputElement>) => void) | undefined;
  render?: React.ReactElement | undefined;
};

/**
 * The bare search field of a command (the palettes draw their own field chrome). The caller's
 * `value` becomes the command's query, except while an input method composes: UI SDK writes the
 * query back into the field, which would break the composition (the pinyin doubled up). The
 * caller's onChange still runs then; the composed text is handed over when composition ends.
 */
function CommandSearchInput({
  value,
  onChange,
  render,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: CommandSearchInputProps) {
  const setQuery = React.useContext(CommandQuery);
  const composing = React.useRef(false);
  React.useLayoutEffect(() => {
    if (!composing.current) setQuery?.(value);
  }, [setQuery, value]);
  return (
    <CommandInputPrimitive
      {...definedProps<object, React.ComponentProps<typeof CommandInputPrimitive>>({
        ...props,
        onChange,
        onCompositionStart: (event: React.CompositionEvent<HTMLInputElement>) => {
          composing.current = true;
          onCompositionStart?.(event);
        },
        onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement>) => {
          composing.current = false;
          if (value !== undefined) setQuery?.(event.currentTarget.value);
          onCompositionEnd?.(event);
        },
      })}
      render={(inputProps) =>
        render ? (
          React.cloneElement(render as React.ReactElement<Record<string, unknown>>, {
            ...inputProps,
            "data-slot": "command-input",
          })
        ) : (
          <input {...inputProps} data-slot="command-input" />
        )
      }
    />
  );
}

function CommandInput({
  className,
  placeholder,
  ...props
}: CommandSearchInputProps & { className?: string | undefined }) {
  return (
    <div className="px-2.5 py-1.5">
      <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
        <div
          aria-hidden="true"
          className="[&_svg,&_[data-slot=central-icon]]:-mx-0.5 pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="autocomplete-start-addon"
        >
          <SearchIcon />
        </div>
        <CommandSearchInput
          autoFocus
          placeholder={placeholder}
          {...props}
          render={
            <Input
              className={cn(
                "data-[size=sm]:*:data-[slot=command-input]:ps-[calc(--spacing(7.5)-1px)] *:data-[slot=command-input]:ps-[calc(--spacing(8.5)-1px)] sm:data-[size=sm]:*:data-[slot=command-input]:ps-[calc(--spacing(7)-1px)] sm:*:data-[slot=command-input]:ps-[calc(--spacing(8)-1px)]",
                "border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0",
                className,
              )}
              nativeInput
              size="lg"
            />
          }
        />
      </div>
    </div>
  );
}

function CommandList({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <CommandListPrimitive
        {...props}
        className={cn(
          "not-empty:scroll-py-1 not-empty:p-1 in-data-has-overflow-y:pe-3",
          "not-empty:scroll-py-1 not-empty:p-1",
          className,
        )}
        render={slotted("command-list")}
      />
    </ScrollArea>
  );
}

// Caller-gated status/empty message for palettes whose callers filter: a polite live region,
// rendered as a SIBLING of CommandList so non-option content never sits inside the listbox; keep
// it mounted and swap its children.
function CommandStatus({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandStatusPrimitive
      {...props}
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-ui-xs empty:m-0 empty:p-0",
        "p-1 font-normal",
        className,
      )}
      render={slotted("command-status")}
    />
  );
}

function CommandEmpty({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandEmptyPrimitive
      {...props}
      className={cn(
        "not-empty:p-2 text-center text-ui text-muted-foreground sm:text-ui",
        "not-empty:py-6",
        className,
      )}
      render={slotted("command-empty")}
    />
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "-mx-px not-has-[+[data-slot=command-footer]]:-mb-px relative min-h-0 rounded-t-dialog not-has-[+[data-slot=command-footer]]:rounded-b-dialog border border-b-0 border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] shadow-xs/5 [clip-path:inset(0_1px)] not-has-[+[data-slot=command-footer]]:[clip-path:inset(0_1px_1px_1px_round_0_0_calc(var(--radius-2xl)-1px)_calc(var(--radius-2xl)-1px))] before:pointer-events-none before:absolute before:inset-0 before:rounded-t-[calc(var(--radius-dialog)-1px)] **:data-[slot=scroll-area-scrollbar]:mt-2",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandGroupPrimitive
      {...props}
      className={cn("[[role=group]+&]:mt-1.5", className)}
      render={slotted("command-group")}
    />
  );
}

function CommandGroupLabel({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandGroupLabelPrimitive
      {...props}
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-ui-xs", className)}
      render={slotted("command-group-label")}
    />
  );
}

type CommandItemProps = Omit<
  Loose<React.ComponentProps<typeof CommandItemPrimitive>>,
  "className" | "onClick" | "onSelect" | "value"
> & {
  className?: string | undefined;
  value: string;
  /** Runs when the row runs, by press or Enter (UI SDK's `onSelect`). */
  onClick?: ((event: Event) => void) | undefined;
  onMouseDown?: React.MouseEventHandler<HTMLElement> | undefined;
  onMouseMove?: React.MouseEventHandler<HTMLElement> | undefined;
  ref?: React.Ref<HTMLElement> | undefined;
};

function CommandItem({ className, onClick, ...props }: CommandItemProps) {
  return (
    <CommandItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof CommandItemPrimitive>>({
        ...props,
        onSelect: onClick,
      })}
      className={cn(
        "flex min-h-8 cursor-default select-none items-center rounded-control px-2 py-1 text-ui outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:opacity-64 sm:min-h-7 sm:text-ui",
        "py-1.5",
        className,
      )}
      render={slotted("command-item")}
    />
  );
}

function CommandSeparator({ className, ...props }: Slotted & Record<string, unknown>) {
  return (
    <CommandSeparatorPrimitive
      {...props}
      className={cn("mx-2 my-1 h-px bg-border last:hidden", "my-2", className)}
      render={slotted("command-separator")}
    />
  );
}

function CommandShortcut({ className, children, ...props }: React.ComponentProps<"kbd">) {
  if (typeof children === "string") {
    return (
      <ShortcutKbd
        shortcutLabel={children}
        data-slot="command-shortcut"
        groupClassName={cn("ms-auto", className)}
        {...props}
      />
    );
  }
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-muted-foreground/72 text-ui leading-snug",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    >
      {children}
    </kbd>
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-dialog)-1px)] border-t px-5 py-3 text-muted-foreground text-ui leading-snug",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

export {
  commandDialogPopupClassName,
  CommandCreateHandle,
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSearchInput,
  CommandSeparator,
  CommandShortcut,
  CommandStatus,
};
