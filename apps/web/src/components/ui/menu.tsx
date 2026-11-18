"use client";

import {
  createMenuController,
  Menu as MenuPrimitive,
  MenuCheckboxItem as MenuCheckboxItemPrimitive,
  MenuContent,
  MenuGroup as MenuGroupPrimitive,
  MenuGroupLabel as MenuGroupLabelPrimitive,
  MenuItem as MenuItemPrimitive,
  MenuRadioGroup as MenuRadioGroupPrimitive,
  MenuRadioItem as MenuRadioItemPrimitive,
  MenuSeparator as MenuSeparatorPrimitive,
  MenuSub as MenuSubPrimitive,
  MenuSubContent,
  MenuSubTrigger as MenuSubTriggerPrimitive,
  MenuTrigger as MenuTriggerPrimitive,
} from "@ui-sdk/react/menu";
import { ChevronRightIcon } from "~/lib/icons";
import * as React from "react";

import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { cn } from "~/lib/utils";
import { observeNativeSurfaceOverlay } from "~/lib/nativeSurfaceOcclusion";
import {
  APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
  COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
  COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
} from "../chat/composerPickerStyles";
import {
  CHECKBOX_BOX_CLASS_NAME,
  CHECKBOX_INDICATOR_CLASS_NAME,
  CheckboxCheckGlyph,
} from "./checkbox";
import { ShortcutKbd } from "./kbd";
import { SWITCH_THUMB_CLASS_NAME, SWITCH_TRACK_CLASS_NAME } from "./switch";
import { POPUP_INHERITANCE_RESET_CLASS_NAME } from "./tooltip";
import {
  definedProps,
  renderOpenTrigger,
  toAnchor,
  type Loose,
  type LooseRender,
} from "./uiSdkProps";

/** Detached triggers: UI SDK connects a trigger outside the menu through a controller. */
const MenuCreateHandle = createMenuController;

type MenuChangeDetails = Parameters<
  NonNullable<React.ComponentProps<typeof MenuPrimitive>["onOpenChange"]>
>[1];

type MenuProps = Loose<Omit<React.ComponentProps<typeof MenuPrimitive>, "onOpenChange">> & {
  /** As Base UI typed it: `details.event` is always an event (an empty one for a controller). */
  onOpenChange?:
    | ((open: boolean, details: Omit<MenuChangeDetails, "event"> & { event: Event }) => void)
    | undefined;
  /** Keep a controlled menu open while one of its submenus is being entered. */
  keepOpenOnSubmenuInteraction?: boolean | undefined;
  /** Base UI option; UI SDK highlights items under the pointer already. */
  highlightItemOnHover?: boolean | undefined;
};

function withEvent(
  details: MenuChangeDetails,
): Omit<MenuChangeDetails, "event"> & { event: Event } {
  return details.event
    ? (details as Omit<MenuChangeDetails, "event"> & { event: Event })
    : { ...details, event: new Event("programmatic"), cancel: () => details.cancel() };
}

/** Closes the whole menu tree from inside it (an item that must close the menu itself). */
const MenuRootClose = React.createContext<((event: Event) => void) | null>(null);

/**
 * Open root menus, each able to close itself. A dialog that opens over an open menu (a row asked
 * for confirmation) closes them: a UI SDK menu keeps focus and swallows the next press outside,
 * so the dialog's first press would only close the menu. Base UI's menu let it through.
 */
const openMenus = new Set<() => void>();

/** Closes every open Moss menu (a dialog is taking over). */
export function closeOpenMenus(): void {
  for (const close of [...openMenus]) close();
}

function useRegisterOpenMenu(open: boolean, close: () => void): void {
  const latestClose = React.useRef(close);
  latestClose.current = close;
  React.useEffect(() => {
    if (!open) return;
    const entry = () => latestClose.current();
    openMenus.add(entry);
    return () => {
      openMenus.delete(entry);
    };
  }, [open]);
}

function Menu({
  keepOpenOnSubmenuInteraction: keepOpenOnSubmenuInteractionProp,
  highlightItemOnHover: _highlightItemOnHover,
  onOpenChange,
  ...props
}: MenuProps) {
  const keepOpenOnSubmenuInteraction = keepOpenOnSubmenuInteractionProp ?? false;
  // A menu driven by a controller keeps UI SDK's own state.
  const own = (props as { controller?: unknown }).controller === undefined;
  const [ownOpen, setOwnOpen] = React.useState(Boolean(props.defaultOpen));
  const open = props.open ?? ownOpen;
  useRegisterOpenMenu(own && open, () => {
    setOwnOpen(false);
    onOpenChange?.(false, {
      reason: "imperative-action",
      event: new Event("dialog-opened"),
      cancel: () => {},
    } as unknown as Omit<MenuChangeDetails, "event"> & { event: Event });
  });
  const closeTree = React.useCallback(
    (event: Event) => {
      setOwnOpen(false);
      onOpenChange?.(false, {
        reason: "item-press",
        event,
        cancel: () => {},
      } as unknown as Omit<MenuChangeDetails, "event"> & { event: Event });
    },
    [onOpenChange],
  );
  return (
    <MenuRootClose.Provider value={own ? closeTree : null}>
      <MenuPrimitive
        {...definedProps<object, React.ComponentProps<typeof MenuPrimitive>>({
          ...props,
          ...(own ? { open, defaultOpen: undefined } : {}),
          onOpenChange: (nextOpen: boolean, details: MenuChangeDetails) => {
            if (
              !nextOpen &&
              keepOpenOnSubmenuInteraction &&
              (details.reason === "submenu-switch" ||
                details.reason === "trigger-hover" ||
                details.reason === "focus-out")
            ) {
              details.cancel();
              return;
            }
            setOwnOpen(nextOpen);
            onOpenChange?.(nextOpen, withEvent(details));
          },
        })}
      />
    </MenuRootClose.Provider>
  );
}

/** Kept for callers: UI SDK renders menus in place, in the top layer, so there is no portal. */
function MenuPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

type MenuTriggerProps = Loose<Omit<React.ComponentProps<typeof MenuTriggerPrimitive>, "render">> & {
  render?: LooseRender | undefined;
  /** Accepted for callers written against Base UI. */
  nativeButton?: boolean | undefined;
};

function MenuTrigger({ nativeButton: _nativeButton, ...props }: MenuTriggerProps) {
  return (
    <MenuTriggerPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuTriggerPrimitive>>({
        ...props,
        render: renderOpenTrigger(props.render, "button", "menu-trigger"),
      })}
      data-slot="menu-trigger"
    />
  );
}

type MenuContentProps = Omit<
  Loose<React.ComponentProps<typeof MenuContent>>,
  "className" | "anchor" | "children" | "alignOffset"
> & {
  /** Pixels, or a function read once the popup's contents exist (Base UI read it on placement). */
  alignOffset?: number | (() => number) | undefined;
  className?: string | undefined;
  children?: React.ReactNode;
  /** An element, a ref, a function returning one, or anything with getBoundingClientRect(). */
  anchor?: Parameters<typeof toAnchor>[0];
  /** Base UI option; UI SDK flips and shifts on its own, so it is accepted only. */
  collisionAvoidance?: unknown;
  surface?: "default" | "composer" | undefined;
  pickerSize?: "small" | "normal" | undefined;
};

/** An offset that may be a function of the mounted popup, re-read after every render. */
function useResolvedOffset(offset: number | (() => number) | undefined): number | undefined {
  const [resolved, setResolved] = React.useState(() =>
    typeof offset === "function" ? undefined : offset,
  );
  React.useLayoutEffect(() => {
    const next = typeof offset === "function" ? offset() : offset;
    setResolved((current) => (current === next ? current : next));
  });
  return resolved;
}

/**
 * The popup shell both root menus and submenus share. Base UI's shape is kept on purpose: UI
 * SDK's content part is the positioner (a top-layer element, so a stacking context) and Moss's
 * surface (`menu-popup`) is a plain child, so the surface's `::before` blur stays behind its
 * background. The positioner is also what the native-surface occlusion observer watches.
 */
/** Sides that open a menu beside its anchor rather than above or below it. */
const SIDEWAYS = new Set<string>(["left", "right", "start", "end", "inline-start", "inline-end"]);

/**
 * Base UI (Floating UI) moved a menu that opens to the side below its anchor when it fit on
 * neither side; UI SDK only flips to the other side, so on a narrow window (a phone, a rail menu
 * at the window's edge) such a menu could hang off the screen and its rows could not be pressed.
 * Once UI SDK has placed it, a sideways menu that still overflows opens below, where UI SDK keeps
 * it on screen.
 */
function useBelowWhenNoRoom(enabled: boolean): [boolean, (element: HTMLDivElement | null) => void] {
  const [below, setBelow] = React.useState(false);
  const tracked = React.useRef<{ element: HTMLDivElement; observer: MutationObserver } | null>(
    null,
  );
  React.useEffect(() => () => tracked.current?.observer.disconnect(), []);
  const track = React.useCallback(
    (element: HTMLDivElement | null) => {
      if (element === (tracked.current?.element ?? null)) return;
      tracked.current?.observer.disconnect();
      tracked.current = null;
      if (!element) {
        setBelow(false);
        return;
      }
      if (!enabled) return;
      const check = () => {
        const box = element.getBoundingClientRect();
        if (box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1)) setBelow(true);
      };
      // UI SDK writes the position into the element's style, so each placement is a style change.
      const observer = new MutationObserver(check);
      observer.observe(element, { attributes: true, attributeFilter: ["style"] });
      tracked.current = { element, observer };
      check();
    },
    [enabled],
  );
  return [below, track];
}

/**
 * Where a mouse or pen last moved on the page, for telling a person's leave from a popup's move.
 * A popup that moves or shrinks out from under a resting pointer (its first placement, a view
 * switch) gets a real `pointerleave` from Chrome although nobody moved. UI SDK answers every leave
 * by dropping the highlight and focusing the popup, so a keyboard user's place was lost and their
 * next key went to the popup: the Power picker's slider item missed its arrow. A person's leave
 * comes at the pointer's new spot, before the move there is reported; a leave at the spot where
 * the pointer last moved (or before any move was seen) is the popup moving, and is ignored.
 */
let lastPointerMove: { x: number; y: number } | null = null;
let trackingPointerMoves = false;

function trackPointerMoves(): void {
  if (trackingPointerMoves) return;
  trackingPointerMoves = true;
  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "touch") lastPointerMove = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
}

function leftByMoving(event: PointerEvent): boolean {
  if (event.pointerType === "touch") return true;
  return (
    lastPointerMove !== null &&
    (lastPointerMove.x !== event.clientX || lastPointerMove.y !== event.clientY)
  );
}

const guardedPositioners = new WeakSet<HTMLElement>();

/**
 * UI SDK listens for the leave on the positioner itself, in the bubble phase; a capture listener
 * on the same element runs first and keeps a leave nobody made from reaching it.
 */
function ignoreRestingLeave(element: HTMLElement): void {
  if (guardedPositioners.has(element)) return;
  guardedPositioners.add(element);
  element.addEventListener(
    "pointerleave",
    (event) => {
      if (event.target === element && !leftByMoving(event)) event.stopImmediatePropagation();
    },
    { capture: true },
  );
}

function menuShell(
  Part: typeof MenuContent | typeof MenuSubContent,
  {
    children,
    className,
    surface: surfaceProp,
    pickerSize,
    sideOffset,
    align,
    alignOffset,
    side,
    anchor,
    collisionAvoidance: _collisionAvoidance,
    ...props
  }: MenuContentProps,
  defaults: {
    side: NonNullable<MenuContentProps["side"]>;
    align: NonNullable<MenuContentProps["align"]>;
    sideOffset: number;
  },
) {
  const surface = surfaceProp ?? "default";
  const isComposerSurface = surface === "composer";
  const resolvedAlignOffset = useResolvedOffset(alignOffset);
  const requestedSide = side ?? defaults.side;
  const sideways = SIDEWAYS.has(requestedSide);
  const [noRoomSideways, trackPositioner] = useBelowWhenNoRoom(sideways);
  const below = sideways && noRoomSideways;
  React.useEffect(trackPointerMoves, []);
  const popupSurfaceClassName = isComposerSurface
    ? COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME
    : APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME;
  return (
    <Part
      {...definedProps<object, React.ComponentProps<typeof MenuContent>>({
        ...props,
        anchor: toAnchor(anchor),
        alignOffset: below ? 0 : resolvedAlignOffset,
      })}
      align={below ? "start" : (align ?? defaults.align)}
      side={below ? "bottom" : requestedSide}
      sideOffset={sideOffset ?? defaults.sideOffset}
      // Base UI kept popups 5px from the window's edge; UI SDK's default is 8px.
      collisionPadding={(props as { collisionPadding?: number }).collisionPadding ?? 5}
      className={cn(
        POPUP_INHERITANCE_RESET_CLASS_NAME,
        "z-50 min-w-32 outline-none",
        isComposerSurface ? undefined : className,
      )}
      render={(contentProps) => (
        <div
          {...contentProps}
          ref={(element: HTMLDivElement | null) => {
            const forwarded = (contentProps as { ref?: React.Ref<HTMLDivElement> }).ref;
            if (typeof forwarded === "function") forwarded(element);
            else if (forwarded)
              (forwarded as React.MutableRefObject<HTMLDivElement | null>).current = element;
            observeNativeSurfaceOverlay(element);
            trackPositioner(element);
            if (element) ignoreRestingLeave(element);
          }}
          data-slot="menu-positioner"
        />
      )}
    >
      <div
        className={cn(
          "relative flex origin-(--transform-origin) text-[var(--color-text-foreground)] outline-none focus:outline-none",
          isComposerSurface ? "min-w-0 max-w-[92vw]" : "w-full min-w-full",
          popupSurfaceClassName,
          // Last so a caller's className can override surface tokens (e.g. a rounder radius).
          isComposerSurface ? className : null,
        )}
        data-slot="menu-popup"
      >
        {isComposerSurface ? (
          <div
            className={cn(
              COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
              "relative z-1 max-h-(--available-height)",
            )}
            data-picker-size={pickerSize}
            data-slot="menu-popup-body"
          >
            {children}
          </div>
        ) : (
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        )}
      </div>
    </Part>
  );
}

/** Low-level popup foundation. App surfaces should use ComposerPickerMenuPopup instead. */
function MenuPopupBase(props: MenuContentProps) {
  return menuShell(MenuContent, props, { side: "bottom", align: "center", sideOffset: 4 });
}

function MenuGroup(props: Loose<React.ComponentProps<typeof MenuGroupPrimitive>>) {
  return (
    <MenuGroupPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuGroupPrimitive>>(props)}
      data-slot="menu-group"
    />
  );
}

type MenuItemProps = Omit<
  Loose<React.ComponentProps<typeof MenuItemPrimitive>>,
  "className" | "onClick" | "render"
> & {
  className?: string | undefined;
  inset?: boolean | undefined;
  variant?: "default" | "destructive" | undefined;
  render?: LooseRender | undefined;
  /**
   * Runs when the item is chosen, by pointer or keyboard, as Base UI's item click did. UI SDK
   * calls it `onSelect`; the event is the DOM event that chose it.
   */
  onClick?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
  /** Whether choosing the item closes the menu (Base UI's name for `closeOnSelect`). */
  closeOnClick?: boolean | undefined;
};

/**
 * The DOM event UI SDK chose an item with, seen as the React event Base UI handed `onClick`.
 * Handlers merged into an item (a tooltip trigger around it, say) read `nativeEvent` and the
 * React event methods.
 */
function asReactEvent(event: Event | undefined): React.MouseEvent<HTMLElement> {
  const native = event ?? new MouseEvent("click");
  let propagationStopped = false;
  const extra: Record<PropertyKey, unknown> = {
    nativeEvent: native,
    isDefaultPrevented: () => native.defaultPrevented,
    isPropagationStopped: () => propagationStopped,
    persist: () => {},
    stopPropagation: () => {
      propagationStopped = true;
      native.stopPropagation();
    },
  };
  return new Proxy(native, {
    get(target, key) {
      if (key in extra) return extra[key];
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as React.MouseEvent<HTMLElement>;
}

/**
 * Base UI let an item's click run before the menu closed; UI SDK's `onSelect` is that moment.
 * A handler that prevents the default (taking the press over, as the sidebar's PR opener does)
 * kept the menu open on UI SDK; Base UI closed a plain row anyway, so the row closes the tree.
 */
function toSelect(
  onClick: MenuItemProps["onClick"],
  closesOnChoice: boolean,
  closeTree: ((event: Event) => void) | null,
): ((event: Event) => void) | undefined {
  return onClick
    ? (event: Event | undefined) => {
        onClick(asReactEvent(event));
        if (closesOnChoice && event?.defaultPrevented && closeTree) closeTree(event);
      }
    : undefined;
}

function MenuItem({
  className,
  inset,
  variant: variantProp,
  onClick,
  closeOnClick,
  ...props
}: MenuItemProps) {
  const variant = variantProp ?? "default";
  const closeTree = React.useContext(MenuRootClose);
  return (
    <MenuItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuItemPrimitive>>({
        ...props,
        ...NESTED_CONTROL_HANDLERS,
        onSelect:
          props.onSelect ??
          toSelect(onClick, (props.closeOnSelect ?? closeOnClick) !== false, closeTree),
        closeOnSelect: props.closeOnSelect ?? closeOnClick,
        "data-inset": inset ? "" : undefined,
        "data-variant": variant,
      })}
      className={cn(
        COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
        // text-destructive (not -foreground): these items sit on the popup surface, so they
        // need the red accent itself — the foreground token is for text on a destructive fill.
        "data-inset:ps-8 data-[variant=destructive]:text-destructive",
        className,
      )}
      data-slot="menu-item"
    />
  );
}

/**
 * A row may hold its own control (a star button, a toggle). Base UI chose an item on click, which
 * that control stopped; UI SDK chooses on the press, so presses that start on a nested control
 * skip the item's own handling (UI SDK skips a part's built-in handler after preventDefault).
 */
const NESTED_CONTROL_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="checkbox"]';

function skipNestedControl(event: React.SyntheticEvent<HTMLElement>): void {
  const target = event.target as Element | null;
  const control = target?.closest?.(NESTED_CONTROL_SELECTOR);
  if (control && control !== event.currentTarget && event.currentTarget.contains(control)) {
    event.preventDefault();
  }
}

const NESTED_CONTROL_HANDLERS = {
  onPointerDown: skipNestedControl,
  onPointerUp: skipNestedControl,
  onClick: skipNestedControl,
};

const CHECK_PATH = "M5.252 12.7 10.2 18.63 18.748 5.37";

function CheckMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn("size-3", className)}
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
      <path d={CHECK_PATH} />
    </svg>
  );
}

/** The check/radio state attributes Moss styles by, for indicators drawn from item state. */
function checkedAttributes(checked: boolean) {
  return { "data-checked": checked ? "" : undefined, "data-unchecked": checked ? undefined : "" };
}

type MenuCheckboxItemProps = Omit<
  Loose<React.ComponentProps<typeof MenuCheckboxItemPrimitive>>,
  "className" | "value" | "children"
> & {
  className?: string | undefined;
  children?: React.ReactNode;
  /** Identifies the item in the menu's onCheckedChange; generated when not given. */
  value?: string | undefined;
  closeOnClick?: boolean | undefined;
  /**
   * `default`: a trailing ✓ only while checked. `switch`: a trailing toggle.
   * `checkbox`: a visible box in the leading icon slot, empty while unchecked, so the row
   * reads as an opt-in setting rather than a selected option.
   */
  variant?: "default" | "switch" | "checkbox" | undefined;
};

// Indicators are drawn from the item's state, not with UI SDK's MenuItemIndicator: that part runs
// its presence code (an attribute write, then getAnimations(), which restyles the page) for every
// checked row each time the menu opens, and Moss's checks do not animate.
function MenuCheckboxItem({
  className,
  children,
  variant: variantProp,
  value,
  closeOnClick,
  ...props
}: MenuCheckboxItemProps) {
  const variant = variantProp ?? "default";
  const generatedValue = React.useId();
  return (
    <MenuCheckboxItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuCheckboxItemPrimitive>>({
        ...props,
        value: value ?? generatedValue,
        // Checkbox and radio rows keep the menu open unless asked (UI SDK's default, as Base UI).
        closeOnSelect: props.closeOnSelect ?? closeOnClick,
      })}
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          "grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] py-1 ps-2",
        ),
        variant === "switch"
          ? "grid-cols-[1fr_auto] gap-4 pe-1.5"
          : variant === "checkbox"
            ? "flex gap-2 pe-2"
            : "grid-cols-[1fr_auto] gap-3 px-2.5",
        className,
      )}
      data-slot="menu-checkbox-item"
    >
      {(state) =>
        variant === "checkbox" ? (
          <>
            {/* Sized and inset like a MenuItem's leading icon so labels stay aligned. */}
            <span aria-hidden className={cn(CHECKBOX_BOX_CLASS_NAME, "-mx-0.5")}>
              {state.checked ? (
                <span className={CHECKBOX_INDICATOR_CLASS_NAME} {...checkedAttributes(true)}>
                  <CheckboxCheckGlyph />
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
          </>
        ) : variant === "switch" ? (
          <>
            <span className="col-start-1">{children}</span>
            <span
              aria-hidden
              className={cn(
                SWITCH_TRACK_CLASS_NAME,
                "inset-shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-1",
              )}
              {...checkedAttributes(state.checked)}
            >
              <span
                className={cn(
                  SWITCH_THUMB_CLASS_NAME,
                  "in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[var(--thumb-size)] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.10)]",
                )}
              />
            </span>
          </>
        ) : (
          <>
            <span className="col-start-1 min-w-0">{children}</span>
            {state.checked ? (
              <span className="col-start-2 justify-self-end" {...checkedAttributes(true)}>
                <CheckMark />
              </span>
            ) : null}
          </>
        )
      }
    </MenuCheckboxItemPrimitive>
  );
}

/**
 * Moss radio menus choose numbers too (stroke widths), as Base UI allowed; UI SDK's values are
 * strings. Items register the value they stand for, and the group hands it back unchanged.
 */
type RadioGroupState = {
  /** The value each item key stands for. */
  values: Map<string, unknown>;
  /** The key chosen now. */
  chosenKey: () => string | undefined;
  /** Reports a press on the item already chosen, as a choice (Base UI did; UI SDK does not). */
  chooseAgain: (key: string, event: Event) => void;
};

const RadioValues = React.createContext<RadioGroupState | null>(null);

type MenuRadioGroupProps = Omit<
  Loose<React.ComponentProps<typeof MenuRadioGroupPrimitive>>,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: unknown;
  defaultValue?: unknown;
  onValueChange?: ((value: any, details: any) => void) | undefined;
};

const toKey = (raw: unknown) => (raw === undefined || raw === null ? undefined : String(raw));

function MenuRadioGroup({ value, defaultValue, onValueChange, ...props }: MenuRadioGroupProps) {
  const values = React.useRef(new Map<string, unknown>()).current;
  const uncontrolledKey = React.useRef(toKey(defaultValue));
  const latest = React.useRef({ value, onValueChange });
  latest.current = { value, onValueChange };
  const state = React.useMemo<RadioGroupState>(
    () => ({
      values,
      chosenKey: () =>
        latest.current.value !== undefined ? toKey(latest.current.value) : uncontrolledKey.current,
      chooseAgain: (key, event) =>
        latest.current.onValueChange?.(values.has(key) ? values.get(key) : key, {
          reason: "item-press",
          event,
        }),
    }),
    [values],
  );
  return (
    <RadioValues.Provider value={state}>
      <MenuRadioGroupPrimitive
        {...definedProps<object, React.ComponentProps<typeof MenuRadioGroupPrimitive>>({
          ...props,
          value: value === undefined || value === null ? value : String(value),
          defaultValue:
            defaultValue === undefined || defaultValue === null
              ? defaultValue
              : String(defaultValue),
          onValueChange: (next: string, details: unknown) => {
            uncontrolledKey.current = next;
            onValueChange?.(values.has(next) ? values.get(next) : next, details);
          },
        })}
        data-slot="menu-radio-group"
      />
    </RadioValues.Provider>
  );
}

/** The string UI SDK keys a radio item by, remembering the value it stands for. */
function useRadioValue(value: unknown): [string, RadioGroupState | null] {
  const group = React.useContext(RadioValues);
  const key = String(value);
  group?.values.set(key, value);
  return [key, group];
}

type MenuRadioItemBaseProps = Omit<
  Loose<React.ComponentProps<typeof MenuRadioItemPrimitive>>,
  "className" | "children" | "value"
> & {
  value: unknown;
  className?: string | undefined;
  children?: React.ReactNode;
  closeOnClick?: boolean | undefined;
  /** Runs when the item is chosen, as on Base UI; the group's onValueChange also runs. */
  onClick?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
};

/**
 * Base UI ran an item's click after the item was chosen, by pointer or by Enter/Space. UI SDK
 * runs a caller's handler before its own, so the caller's runs on the next microtask instead,
 * once the choice is recorded (a handler that closes the menu would otherwise lose it).
 */
function afterChoice(
  onClick: ((event: React.MouseEvent<HTMLElement>) => void) | undefined,
  again?: { group: RadioGroupState | null; key: string; disabled: boolean | undefined },
): Pick<React.HTMLAttributes<HTMLElement>, "onClick" | "onKeyDown"> {
  if (!onClick && !again?.group) return {};
  const chosen = (event: React.SyntheticEvent<HTMLElement>) => {
    // Read before UI SDK records the choice: a press on the item already chosen changes nothing
    // there, so the group hears it from here.
    const repeat =
      again?.group && !again.disabled && again.group.chosenKey() === again.key ? again.group : null;
    queueMicrotask(() => {
      repeat?.chooseAgain(again!.key, event.nativeEvent);
      onClick?.(event as React.MouseEvent<HTMLElement>);
    });
  };
  return {
    onClick: chosen,
    onKeyDown: (event) => {
      // The Enter that confirms an input-method candidate never chooses (lib/imeKeyEvent.ts).
      if (isImeComposingKeyEvent(event)) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      chosen(event);
    },
  };
}

/** A radio option drawn as one cell in a row of choices (a colour swatch, a stroke width):
 *  just its content, no check mark. Style the chosen cell with `data-checked:`. */
function MenuRadioCell({
  className,
  closeOnClick,
  onClick,
  value,
  ...props
}: MenuRadioItemBaseProps) {
  const [key, group] = useRadioValue(value);
  return (
    <MenuRadioItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuRadioItemPrimitive>>({
        ...props,
        value: key,
        // Checkbox and radio rows keep the menu open unless asked (UI SDK's default, as Base UI).
        closeOnSelect: props.closeOnSelect ?? closeOnClick,
        ...afterChoice(onClick, { group, key, disabled: props.disabled }),
      })}
      className={cn(
        "flex cursor-default select-none items-center justify-center outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-disabled:opacity-64",
        className,
      )}
      render={(cellProps) => <div {...cellProps} data-slot="menu-radio-cell" />}
    />
  );
}

function MenuRadioItem({
  className,
  children,
  preserveChildLayout: preserveChildLayoutProp,
  trailing,
  closeOnClick,
  onClick,
  value,
  ...props
}: MenuRadioItemBaseProps & {
  preserveChildLayout?: boolean | undefined;
  trailing?: React.ReactNode;
}) {
  const preserveChildLayout = preserveChildLayoutProp ?? false;
  const [key, group] = useRadioValue(value);
  return (
    <MenuRadioItemPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuRadioItemPrimitive>>({
        ...props,
        value: key,
        // Checkbox and radio rows keep the menu open unless asked (UI SDK's default, as Base UI).
        closeOnSelect: props.closeOnSelect ?? closeOnClick,
        ...afterChoice(onClick, { group, key, disabled: props.disabled }),
      })}
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          preserveChildLayout
            ? "grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] grid-cols-[minmax(0,1fr)_2.5rem] gap-x-1.5 gap-y-0 px-2"
            : "w-full min-w-0 px-2.5",
        ),
        className,
      )}
      data-slot="menu-radio-item"
    >
      {(state) =>
        preserveChildLayout ? (
          <>
            <span className="col-start-1 min-w-0">{children}</span>
            <div className="col-start-2 flex shrink-0 items-center justify-end gap-0.5">
              {state.checked ? (
                <span className="shrink-0" {...checkedAttributes(true)}>
                  <CheckMark />
                </span>
              ) : null}
              {trailing}
            </div>
          </>
        ) : (
          <span className="flex w-full min-w-0 items-center gap-2">
            {children}
            {state.checked ? (
              <span className="ml-auto shrink-0" {...checkedAttributes(true)}>
                <CheckMark />
              </span>
            ) : null}
          </span>
        )
      }
    </MenuRadioItemPrimitive>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: Omit<Loose<React.ComponentProps<typeof MenuGroupLabelPrimitive>>, "className"> & {
  className?: string | undefined;
  inset?: boolean | undefined;
}) {
  return (
    <MenuGroupLabelPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuGroupLabelPrimitive>>({
        ...props,
        "data-inset": inset ? "" : undefined,
      })}
      // Shared section/group label style: matches the composer picker section
      // headers (e.g. "Effort"). Picker menus may still override padding-block
      // via the `--picker-section-py` token on `[data-slot="menu-label"]`.
      className={cn(
        "px-2 py-1.5 font-normal text-ui leading-snug text-muted-foreground/45 data-inset:ps-9 sm:data-inset:ps-8",
        className,
      )}
      render={(labelProps) => <div {...labelProps} data-slot="menu-label" />}
    />
  );
}

function MenuSeparator({
  className,
  ...props
}: Omit<Loose<React.ComponentProps<typeof MenuSeparatorPrimitive>>, "className"> & {
  className?: string | undefined;
}) {
  return (
    <MenuSeparatorPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuSeparatorPrimitive>>(props)}
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="menu-separator"
    />
  );
}

function MenuShortcut({ className, children, ...props }: React.ComponentProps<"kbd">) {
  if (typeof children === "string") {
    return (
      <ShortcutKbd
        shortcutLabel={children}
        data-slot="menu-shortcut"
        groupClassName={cn("ms-auto", className)}
        {...props}
      />
    );
  }
  return (
    <kbd
      className={cn("ms-auto font-medium font-sans text-muted-foreground/72 text-ui-xs", className)}
      data-slot="menu-shortcut"
      {...props}
    >
      {children}
    </kbd>
  );
}

type MenuSubProps = Loose<React.ComponentProps<typeof MenuSubPrimitive>> & {
  /** Keep a hover-open submenu open when focus moves into it. */
  keepOpenOnFocusOut?: boolean | undefined;
};

function MenuSub({
  keepOpenOnFocusOut: keepOpenOnFocusOutProp,
  onOpenChange,
  ...props
}: MenuSubProps) {
  const keepOpenOnFocusOut = keepOpenOnFocusOutProp ?? false;
  return (
    <MenuSubPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuSubPrimitive>>({
        ...props,
        onOpenChange: (nextOpen: boolean, details: MenuChangeDetails) => {
          // Let the parent menu's outside handling own real dismissal while focus moves in.
          if (keepOpenOnFocusOut && !nextOpen && details.reason === "focus-out") {
            details.cancel();
            return;
          }
          onOpenChange?.(nextOpen, details);
        },
      })}
    />
  );
}

type MenuSubTriggerProps = Omit<
  Loose<React.ComponentProps<typeof MenuSubTriggerPrimitive>>,
  "className" | "render" | "onClick"
> & {
  className?: string | undefined;
  render?: LooseRender | undefined;
  onClick?: React.MouseEventHandler<HTMLElement> | undefined;
};

function subTriggerHandlers(onClick: React.MouseEventHandler<HTMLElement> | undefined) {
  return {
    onPointerDown: skipNestedControl,
    onPointerUp: skipNestedControl,
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      skipNestedControl(event);
      onClick?.(event);
    },
  };
}

/** Unstyled submenu trigger for bespoke layouts (e.g. the effort slider card's stacked
 *  model label). Prefer `MenuSubTrigger` for regular option rows. */
function MenuSubTriggerBase({ onClick, ...props }: MenuSubTriggerProps) {
  return (
    <MenuSubTriggerPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuSubTriggerPrimitive>>({
        ...props,
        ...subTriggerHandlers(onClick),
        render: renderOpenTrigger(props.render, "div", "menu-sub-trigger-base"),
      })}
      data-slot="menu-sub-trigger-base"
    />
  );
}

function MenuSubTrigger({
  className,
  inset,
  children,
  onClick,
  ...props
}: MenuSubTriggerProps & {
  inset?: boolean | undefined;
}) {
  return (
    <MenuSubTriggerPrimitive
      {...definedProps<object, React.ComponentProps<typeof MenuSubTriggerPrimitive>>({
        ...props,
        ...subTriggerHandlers(onClick),
        "data-inset": inset ? "" : undefined,
        render: renderOpenTrigger(props.render, "div", "menu-sub-trigger"),
      })}
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          "data-popup-open:bg-[var(--color-background-button-secondary-hover)] data-popup-open:text-[var(--color-text-foreground)] data-inset:ps-8",
        ),
        className,
      )}
      data-slot="menu-sub-trigger"
    >
      {children as React.ReactNode}
      <ChevronRightIcon className="-me-0.5 shrink-0" />
    </MenuSubTriggerPrimitive>
  );
}

function MenuSubPopup({
  side: sideProp,
  align: alignProp,
  alignOffset,
  ...props
}: Omit<MenuContentProps, "side"> & {
  /** Cascade direction; `inline-start` when the parent menu already opened toward the start. */
  side?: "inline-end" | "inline-start" | undefined;
}) {
  const align = alignProp ?? "start";
  return menuShell(
    MenuSubContent,
    {
      ...props,
      side: sideProp === "inline-start" ? "start" : "end",
      align,
      alignOffset: alignOffset ?? (align !== "center" ? -5 : undefined),
    },
    { side: "end", align: "start", sideOffset: 0 },
  );
}

export {
  MenuCreateHandle,
  Menu,
  Menu as DropdownMenu,
  MenuPortal,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopupBase,
  MenuGroup,
  MenuItem,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioCell,
  MenuRadioItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubTriggerBase,
  MenuSubPopup,
};
