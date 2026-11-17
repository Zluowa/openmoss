"use client";

import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { mergeProps, renderElement, type RenderProp } from "@ui-sdk/react/primitive";
import {
  Select as SelectPrimitive,
  SelectContent,
  SelectGroup as SelectGroupPrimitive,
  SelectGroupLabel as SelectGroupLabelPrimitive,
  SelectItem as SelectItemPrimitive,
  SelectItemText,
  SelectList,
  SelectSeparator as SelectSeparatorPrimitive,
  SelectTrigger as SelectTriggerPrimitive,
  SelectValue as SelectValuePrimitive,
} from "@ui-sdk/react/select";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDownIcon, ChevronsUpDownIcon, ChevronUpIcon } from "~/lib/icons";
import * as React from "react";

import { cn } from "~/lib/utils";
import {
  APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
  COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
  COMPOSER_PICKER_MENU_POPUP_VIEWPORT_CLASS_NAME,
  COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME,
  COMPOSER_PICKER_SELECT_OPTION_CLASS_NAME,
  COMPOSER_SURFACE_SHADOW_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { POPUP_INHERITANCE_RESET_CLASS_NAME } from "./tooltip";
import {
  definedProps,
  renderOpenTrigger,
  toAnchor,
  type Loose,
  type LooseRender,
} from "./uiSdkProps";

/**
 * The select's props as Moss callers use them (Base UI's surface). UI SDK's own props are generic
 * over single and multiple selection; values that are not strings are keyed by their string form.
 */
interface SelectProps {
  value?: unknown;
  defaultValue?: unknown;
  onValueChange?: ((value: any, details: any) => void) | undefined;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean, details: any) => void) | undefined;
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  name?: string | undefined;
  form?: string | undefined;
  modal?: boolean | "pointer" | undefined;
  multiple?: boolean | undefined;
  placeholder?: string | undefined;
  /**
   * The labels for values, as Base UI took them: a record of value to label, or a list of
   * `{ value, label }`. The trigger shows the selected value's label.
   */
  items?:
    | Record<string, React.ReactNode>
    | ReadonlyArray<{ value: unknown; label: React.ReactNode }>
    | undefined;
  itemToValue?: ((value: any) => string) | undefined;
  children?: React.ReactNode;
}

function toListData(items: SelectProps["items"]): unknown {
  if (!items) return undefined;
  const entries = Array.isArray(items)
    ? (items as ReadonlyArray<{ value: unknown; label: React.ReactNode }>)
    : Object.entries(items as Record<string, React.ReactNode>).map(([value, label]) => ({
        value,
        label,
      }));
  return entries.map((entry) => ({
    value: entry.value,
    label: typeof entry.label === "string" ? entry.label : String(entry.value),
  }));
}

const keyOf = (value: unknown) => (typeof value === "string" ? value : String(value));

function Select({ items, itemToValue, ...props }: SelectProps) {
  const Root = SelectPrimitive as unknown as React.ComponentType<Record<string, unknown>>;
  return (
    <Root
      {...definedProps<object, Record<string, unknown>>({
        ...props,
        items: toListData(items),
        itemToValue: itemToValue ?? keyOf,
      })}
    />
  );
}

// Every select popup uses a shared picker shell: "composer" is the app-wide
// frosted picker (ComposerPickerSelectPopup), "settings" the settings variant
// (SettingsSelectPopup). The legacy unstyled default surface was removed on
// purpose — do not add it back.
type SelectPopupSurface = "composer" | "settings";

const settingsSelectOptionClassName = `[&>svg,&>[data-slot=central-icon]]:-mx-0.5 flex cursor-default select-none items-center ${COMPOSER_PICKER_OPTION_RADIUS_CLASS_NAME} text-ui text-[var(--color-text-foreground)] outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:opacity-64 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg,&>[data-slot=central-icon]]:pointer-events-none [&>svg,&>[data-slot=central-icon]]:shrink-0 grid in-data-align-trigger:min-w-[calc(var(--anchor-width)+1.25rem)]`;

const SelectPopupSurfaceContext = React.createContext<SelectPopupSurface>("composer");

// Keep neutral select chrome on the same token families Codex uses for menus and list hover.
const selectTriggerVariants = cva(
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-ui-gap-xs border rounded-control text-left text-ui outline-none transition-[color,background-color] data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-ui [&_svg,&_[data-slot=central-icon]]:pointer-events-none [&_svg,&_[data-slot=central-icon]]:shrink-0 [&_svg:not([class*='size-'])]:size-ui-icon",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      variant: {
        default: `${GLASS_RAISED_SURFACE_CLASS_NAME} w-full min-w-36 border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] text-[var(--color-text-foreground)] ring-[color:var(--color-border-focus)]/16 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 focus-visible:border-[color:var(--color-border-focus)] focus-visible:ring-2 aria-invalid:border-destructive/30 focus-visible:aria-invalid:border-destructive/50 focus-visible:aria-invalid:ring-destructive/12 dark:aria-invalid:ring-destructive/20 [&_svg:not([class*='opacity-'])]:opacity-80`,
        ghost:
          "border-transparent text-[var(--color-text-foreground-secondary)] focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]/60 data-pressed:bg-[var(--color-background-elevated-secondary)] [:hover,[data-pressed]]:bg-[var(--color-background-elevated-secondary)] [:hover,[data-pressed]]:text-[var(--color-text-foreground)]",
      },
      size: {
        default: "min-h-control px-ui-pad-md py-1",
        lg: "min-h-control-lg px-ui-pad-lg py-2",
        sm: "min-h-control-sm gap-1.5 px-ui-pad-sm py-0.5 [&_svg:not([class*='size-'])]:size-ui-icon-sm",
        xs: "min-h-control-xs gap-1 rounded-control-xs px-ui-pad-xs py-0.5 text-ui-sm sm:text-ui-sm [&_svg:not([class*='size-'])]:size-ui-icon-sm",
      },
    },
  },
);

const selectTriggerIconClassName = "-me-1 size-4 opacity-80 sm:size-4";

interface SelectButtonProps extends Omit<React.ComponentProps<"button">, "type"> {
  type?: "button" | "submit" | "reset";
  render?: RenderProp | undefined;
  size?: VariantProps<typeof selectTriggerVariants>["size"];
  variant?: VariantProps<typeof selectTriggerVariants>["variant"];
}

function SelectButton({ className, size, variant, render, children, ...props }: SelectButtonProps) {
  const defaultProps = {
    children: (
      <>
        <span className="flex-1 truncate in-data-placeholder:text-muted-foreground/72">
          {children}
        </span>
        {variant === "ghost" ? (
          <ChevronDownIcon className="size-3 opacity-50" />
        ) : (
          <ChevronsUpDownIcon className={selectTriggerIconClassName} />
        )}
      </>
    ),
    className: cn(selectTriggerVariants({ size, variant }), "min-w-0", className),
    "data-slot": "select-button",
    type: render ? undefined : "button",
  };

  return renderElement("button", mergeProps(defaultProps, props), render);
}

type SelectTriggerProps = Omit<
  Loose<React.ComponentProps<typeof SelectTriggerPrimitive>>,
  "className" | "render" | "children"
> &
  VariantProps<typeof selectTriggerVariants> & {
    className?: string | undefined;
    render?: LooseRender | undefined;
    children?: React.ReactNode;
  };

function SelectTrigger({
  className,
  size: sizeProp,
  variant: variantProp,
  children,
  ...props
}: SelectTriggerProps) {
  const size = sizeProp === undefined ? "default" : sizeProp;
  const variant = variantProp === undefined ? "default" : variantProp;
  return (
    <SelectTriggerPrimitive
      {...definedProps<object, React.ComponentProps<typeof SelectTriggerPrimitive>>({
        ...props,
        render: renderOpenTrigger(props.render, "button", "select-trigger"),
      })}
      className={cn(selectTriggerVariants({ size, variant }), className)}
      data-slot="select-trigger"
    >
      {children}
      {/* A plain span, as Base UI's icon part was (its layout places the chevron). */}
      <span aria-hidden="true" data-slot="select-icon">
        <ChevronDownIcon className="size-3 opacity-50" />
      </span>
    </SelectTriggerPrimitive>
  );
}

function SelectValue({
  className,
  ...props
}: Omit<Loose<React.ComponentProps<typeof SelectValuePrimitive>>, "className"> & {
  className?: string | undefined;
}) {
  return (
    <SelectValuePrimitive
      {...definedProps<object, React.ComponentProps<typeof SelectValuePrimitive>>(props)}
      className={cn("flex-1 truncate data-placeholder:text-muted-foreground", className)}
      data-slot="select-value"
    />
  );
}

type SelectPopupProps = Omit<
  Loose<React.ComponentProps<typeof SelectContent>>,
  "className" | "anchor" | "children"
> & {
  className?: string | undefined;
  children?: React.ReactNode;
  anchor?: Parameters<typeof toAnchor>[0];
  surface: SelectPopupSurface;
  /** Size/shell classes applied to the composer picker viewport wrapper. */
  shellClassName?: string | undefined;
};

/**
 * Base UI's scroll arrows, rebuilt (UI SDK has none): a fade and a chevron at the edge where the
 * list can scroll further, scrolling while the pointer rests on it. Hidden from assistive
 * technology, which reaches every option anyway.
 */
function SelectScrollArrow({
  direction,
  list,
  surfaceClassName,
}: {
  direction: "up" | "down";
  list: HTMLElement | null;
  surfaceClassName: string;
}) {
  const [more, setMore] = React.useState(false);
  const frame = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!list) return;
    const update = () =>
      setMore(
        direction === "down"
          ? list.scrollTop + list.clientHeight < list.scrollHeight - 1
          : list.scrollTop > 1,
      );
    update();
    list.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(list);
    return () => {
      list.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [direction, list]);
  const stop = React.useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  React.useEffect(() => stop, [stop]);
  if (!more || !list) return null;
  const start = () => {
    stop();
    const step = () => {
      list.scrollTop += direction === "down" ? 6 : -6;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };
  const Icon = direction === "down" ? ChevronDownIcon : ChevronUpIcon;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "absolute z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:h-[200%] before:from-50%",
        direction === "down"
          ? "bottom-0 before:bottom-px before:rounded-b-[calc(var(--radius-popover)-1px)] before:bg-linear-to-t"
          : "top-0 before:top-px before:rounded-t-[calc(var(--radius-popover)-1px)] before:bg-linear-to-b",
        surfaceClassName,
      )}
      data-slot={`select-scroll-${direction}-arrow`}
      onPointerEnter={start}
      onPointerLeave={stop}
    >
      <Icon className="relative size-3" />
    </div>
  );
}

// Base UI's shape, kept on purpose: UI SDK's content part is the positioner (a top-layer stacking
// context) and the Moss surface sits inside it. The list scrolls inside the capped viewport, with
// Base UI's scroll arrows at its edges.
function SelectPopup({
  className,
  shellClassName,
  children,
  side: sideProp,
  sideOffset: sideOffsetProp,
  align: alignProp,
  alignOffset: alignOffsetProp,
  alignItemWithTrigger: alignItemWithTriggerProp,
  anchor,
  surface,
  ...props
}: SelectPopupProps) {
  const viewportClassName = cn(
    COMPOSER_PICKER_MENU_POPUP_VIEWPORT_CLASS_NAME,
    surface === "settings"
      ? cn(
          APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
          "rounded-popover",
          COMPOSER_SURFACE_SHADOW_CLASS_NAME,
        )
      : COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
    shellClassName,
  );
  const [list, setList] = React.useState<HTMLElement | null>(null);
  const scrollArrowSurfaceClassName =
    surface === "settings"
      ? "before:from-[var(--app-settings-surface)]"
      : "before:from-[var(--composer-surface)]";
  const listClassName = cn(
    COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
    "max-h-[min(var(--available-height),28rem)]",
    className,
  );

  return (
    <SelectPopupSurfaceContext.Provider value={surface}>
      <SelectContent
        {...definedProps<object, React.ComponentProps<typeof SelectContent>>({
          ...props,
          anchor: toAnchor(anchor),
        })}
        align={alignProp ?? "start"}
        alignItemWithTrigger={alignItemWithTriggerProp ?? true}
        alignOffset={alignOffsetProp ?? 0}
        side={sideProp ?? "bottom"}
        sideOffset={sideOffsetProp ?? 4}
        // Base UI kept popups 5px from the window's edge; UI SDK's default is 8px.
        collisionPadding={(props as { collisionPadding?: number }).collisionPadding ?? 5}
        className={cn(POPUP_INHERITANCE_RESET_CLASS_NAME, "z-50 select-none outline-none")}
        // Base UI marked a list laid over its trigger with data-side="none", and its options take
        // the trigger's width plus a little there; UI SDK writes no such side, so Moss marks it.
        render={(contentProps) => (
          <div
            {...contentProps}
            data-align-trigger={(alignItemWithTriggerProp ?? true) ? "" : undefined}
            data-slot="select-positioner"
          />
        )}
      >
        <div
          className="relative flex origin-(--transform-origin) text-[var(--color-text-foreground)]"
          data-slot="select-popup"
        >
          <SelectScrollArrow
            direction="up"
            list={list}
            surfaceClassName={scrollArrowSurfaceClassName}
          />
          {/* Keep a hard popup viewport cap so long theme lists can always scroll
              fully to both edges even when the positioner reports a tight height. */}
          <div className={viewportClassName}>
            <SelectList
              className={cn(listClassName, "relative z-1")}
              render={(listProps) => (
                <div
                  {...listProps}
                  ref={(element: HTMLDivElement | null) => {
                    const forwarded = (listProps as { ref?: React.Ref<HTMLDivElement> }).ref;
                    if (typeof forwarded === "function") forwarded(element);
                    else if (forwarded)
                      (forwarded as React.MutableRefObject<HTMLDivElement | null>).current =
                        element;
                    setList(element);
                  }}
                  data-slot="menu-popup-body"
                />
              )}
            >
              {children}
            </SelectList>
          </div>
          <SelectScrollArrow
            direction="down"
            list={list}
            surfaceClassName={scrollArrowSurfaceClassName}
          />
        </div>
      </SelectContent>
    </SelectPopupSurfaceContext.Provider>
  );
}

type SelectItemProps = Omit<
  Loose<React.ComponentProps<typeof SelectItemPrimitive>>,
  "className" | "children" | "value"
> & {
  className?: string | undefined;
  children?: React.ReactNode;
  value: unknown;
  hideIndicator?: boolean | undefined;
  /** The item's text for typeahead and the trigger, when its content is not plain text. */
  label?: string | undefined;
};

/** The text of React content, as a person reads it (hidden parts left out). */
function nodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode; "aria-hidden"?: unknown }>(node)) {
    return node.props["aria-hidden"] ? "" : nodeText(node.props.children);
  }
  return "";
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text of rendered content, as a person reads it (hidden parts left out). */
function readableText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return Array.from(node.childNodes, readableText).join("");
}

// The check is drawn from the item's state, not with SelectItemIndicator, whose presence code
// restyles the page each time the list opens.
function SelectItem({
  className,
  children,
  hideIndicator: hideIndicatorProp,
  label: labelProp,
  ...props
}: SelectItemProps) {
  const hideIndicator = hideIndicatorProp ?? false;
  // UI SDK's item text shows only the item's label (or value) unless its content is a string, so
  // the content is handed over as a function and its text becomes the label. Content drawn by a
  // component (an icon and a name) has no text in its props: that text is read once rendered.
  const declaredLabel = labelProp ?? (collapse(nodeText(children)) || undefined);
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [renderedLabel, setRenderedLabel] = React.useState<string | undefined>(undefined);
  React.useLayoutEffect(() => {
    if (declaredLabel !== undefined) return;
    const text = (textRef.current && collapse(readableText(textRef.current))) || undefined;
    if (text !== renderedLabel) setRenderedLabel(text);
  }, [children, declaredLabel, renderedLabel]);
  const label = declaredLabel ?? renderedLabel;
  const popupSurface = React.useContext(SelectPopupSurfaceContext);
  const optionBaseClassName =
    popupSurface === "settings"
      ? settingsSelectOptionClassName
      : COMPOSER_PICKER_SELECT_OPTION_CLASS_NAME;

  return (
    <SelectItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof SelectItemPrimitive>>({
        ...props,
        label,
      })}
      className={cn(
        optionBaseClassName,
        hideIndicator ? "grid-cols-[1fr] ps-3 pe-3" : "grid-cols-[1fr_auto] gap-3 px-2.5",
        className,
      )}
      data-slot="select-item"
    >
      {(state) => (
        <>
          <SelectItemText
            className="col-start-1 min-w-0"
            render={(textProps) => <span {...textProps} data-slot="select-item-text" />}
          >
            {() => (
              <span ref={textRef} className="contents">
                {children}
              </span>
            )}
          </SelectItemText>
          {hideIndicator || !state.selected ? null : (
            <span className="col-start-2 justify-self-end" data-slot="select-item-indicator">
              <svg
                className="size-3"
                fill="none"
                height="24"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                width="24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
              </svg>
            </span>
          )}
        </>
      )}
    </SelectItemPrimitive>
  );
}

function SelectSeparator({
  className,
  ...props
}: Omit<Loose<React.ComponentProps<typeof SelectSeparatorPrimitive>>, "className"> & {
  className?: string | undefined;
}) {
  return (
    <SelectSeparatorPrimitive
      {...definedProps<object, React.ComponentProps<typeof SelectSeparatorPrimitive>>(props)}
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="select-separator"
    />
  );
}

function SelectGroup(props: Loose<React.ComponentProps<typeof SelectGroupPrimitive>>) {
  return (
    <SelectGroupPrimitive
      {...definedProps<object, React.ComponentProps<typeof SelectGroupPrimitive>>(props)}
      // UI SDK hides a group none of whose items match a search; Moss selects have no search, and a
      // group may hold only a note (no remote hosts yet), shown as on Base UI.
      render={(groupProps) => <div {...groupProps} hidden={undefined} />}
      data-slot="select-group"
    />
  );
}

function SelectGroupLabel(props: Loose<React.ComponentProps<typeof SelectGroupLabelPrimitive>>) {
  return (
    <SelectGroupLabelPrimitive
      {...definedProps<object, React.ComponentProps<typeof SelectGroupLabelPrimitive>>(props)}
      className="px-2 py-1.5 font-medium text-muted-foreground text-ui-xs"
      data-slot="select-group-label"
    />
  );
}

export {
  Select,
  SelectTrigger,
  SelectButton,
  selectTriggerVariants,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectSeparator,
  SelectGroup,
  SelectGroupLabel,
};
