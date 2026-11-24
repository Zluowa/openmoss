"use client";

import {
  createTooltipController,
  Tooltip as TooltipPrimitive,
  TooltipContent,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import {
  APP_TOOLTIP_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { useProvideTriggerOptions, useTriggerOptions } from "./triggerOptions";
import { renderElement as renderElementFn } from "@ui-sdk/react/primitive";
import { isValidElement } from "react";

import { definedProps, type Loose, type LooseRender } from "./uiSdkProps";

/** Detached triggers: UI SDK connects a trigger outside the tooltip through a controller. */
const TooltipCreateHandle = createTooltipController;

/**
 * Kept for callers that wrap a group of tooltips. UI SDK groups tooltips by itself: while one is
 * open, or was a moment ago, the next opens at once.
 */
function TooltipProvider({
  children,
}: {
  children?: ReactNode;
  delay?: number;
  closeDelay?: number;
}) {
  return <>{children}</>;
}

type TooltipRootProps = Loose<ComponentProps<typeof TooltipPrimitive>> & {
  /**
   * `false` marks a tooltip a person uses with the pointer (it scrolls or holds a link): it takes
   * the pointer while open. Any other tooltip is text and lets presses through to what it covers.
   */
  disableHoverablePopup?: boolean | undefined;
};

/** Whether the open tooltip takes the pointer (see `disableHoverablePopup`). */
const TooltipTakesPointer = createContext(false);

/** Content a person presses: a tooltip holding any of it (a hover card's actions, a link) takes the pointer. */
const PRESSABLE_CONTENT =
  "a[href],button,input,select,textarea,summary,[contenteditable='true'],[role='button'],[role='link'],[tabindex]:not([tabindex='-1'])";

/**
 * Whether the tooltip's surface is drawn: while it is open and for its closing animation. UI SDK
 * keeps a closed tooltip's content in the page; Moss draws the surface only while it shows, as on
 * Base UI, so a page full of triggers does not carry every tooltip's content, and a query for
 * "the tooltip" finds the one a person sees.
 */
const TooltipShown = createContext<boolean | null>(null);

/** Longer than the closing transition (duration-120 on the positioner). */
const CLOSING_MS = 200;

function Tooltip({ disableHoverablePopup, children, onOpenChange, ...props }: TooltipRootProps) {
  const [fromTrigger, provide] = useTriggerOptions();
  const [ownOpen, setOwnOpen] = useState(Boolean(props.defaultOpen));
  const open = props.open ?? ownOpen;
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setClosing(true);
      return;
    }
    const timer = setTimeout(() => setClosing(false), CLOSING_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <TooltipTakesPointer.Provider value={disableHoverablePopup === false}>
      <TooltipShown.Provider value={open || closing}>
        <TooltipPrimitive
          {...definedProps<object, ComponentProps<typeof TooltipPrimitive>>({
            ...props,
            delay: props.delay ?? fromTrigger.delay,
            closeDelay: props.closeDelay ?? fromTrigger.closeDelay,
            closeOnPress: props.closeOnPress ?? fromTrigger.closeOnClick,
            onOpenChange: (next: boolean, details: unknown) => {
              setOwnOpen(next);
              (onOpenChange as ((next: boolean, details: unknown) => void) | undefined)?.(
                next,
                details,
              );
            },
          })}
        >
          {provide(children as ReactNode)}
        </TooltipPrimitive>
      </TooltipShown.Provider>
    </TooltipTakesPointer.Provider>
  );
}

/**
 * Tooltip surface variants. Every tooltip in the app is the same `TooltipPopup`;
 * the variant only swaps its chrome, so different tooltips can wear different
 * looks without forking the component. Add a new style here (and a key) to make it
 * available everywhere.
 *
 * - `default`: the frosted sidebar hover-card surface, shared with the
 *   project/thread cards so plain tooltips and the cards read as one system.
 * - `picker`: the composer picker chrome (tighter radius + soft shadow) for
 *   tooltips that sit next to picker menus and should match them.
 * - `rich`: the elevated secondary checklist/card surface used by transcript
 *   primitives that own their internal padding and scrolling.
 */
export type TooltipVariant = "default" | "picker" | "rich" | "command";

const TOOLTIP_SURFACE_BY_VARIANT: Record<TooltipVariant, string> = {
  default: APP_TOOLTIP_SURFACE_CLASS_NAME,
  picker: COMPOSER_PICKER_TOOLTIP_SURFACE_CLASS_NAME,
  rich: "relative overflow-hidden rounded-popover bg-[var(--color-surface-elevated-secondary)]/90 text-[var(--color-text-foreground)] shadow-[0_0_0_0.5px_var(--color-border),0_8px_16px_-4px_#0000001f] ring-[0.5px] ring-border backdrop-blur-sm",
  // Codex command hover: a compact black bubble with the raw command.
  command: "rounded-control bg-[#0d0d0d] text-white shadow-lg",
};

type TooltipTriggerProps = Loose<Omit<ComponentProps<typeof TooltipTriggerPrimitive>, "render">> & {
  render?: LooseRender | undefined;
  /** Milliseconds the pointer rests on the trigger before the tooltip opens. */
  delay?: number | undefined;
  closeDelay?: number | undefined;
  /** Whether pressing the trigger closes the tooltip. */
  closeOnClick?: boolean | undefined;
};

function TooltipTrigger({
  delay,
  closeDelay,
  closeOnClick,
  render,
  ...props
}: TooltipTriggerProps) {
  useProvideTriggerOptions({ delay, closeDelay, closeOnClick });
  // UI SDK describes a trigger by its tooltip. A trigger with a description of its own (a row's
  // PR state) keeps that one, and a closed tooltip describes nothing (Moss draws no surface for
  // it, and Base UI linked none): the link stays only while the tooltip shows.
  const own = props as Record<string, unknown>;
  const fromElement = isValidElement(render) ? (render.props as Record<string, unknown>) : {};
  const ownDescription =
    own["aria-description"] ??
    own["aria-describedby"] ??
    fromElement["aria-description"] ??
    fromElement["aria-describedby"];
  return (
    <TooltipTriggerPrimitive
      {...definedProps<object, ComponentProps<typeof TooltipTriggerPrimitive>>(props)}
      render={(triggerProps: Record<string, any>, state: { open?: boolean }) =>
        renderElementFn(
          "button",
          {
            ...triggerProps,
            "aria-describedby":
              ownDescription !== undefined
                ? (own["aria-describedby"] as string | undefined)
                : state.open
                  ? triggerProps["aria-describedby"]
                  : undefined,
          },
          render as never,
          state,
        )
      }
      data-slot="tooltip-trigger"
    />
  );
}

/**
 * Classes every popup root sets so it does not take type or pointer behaviour from where its
 * trigger sits: UI SDK renders popups in place (in the top layer), so inherited properties come
 * from the trigger's surroundings, where Base UI's portal started from the page body.
 */
export const POPUP_INHERITANCE_RESET_CLASS_NAME =
  "pointer-events-auto visible whitespace-normal text-start not-italic normal-case tracking-normal font-sans font-normal";

type TooltipPopupProps = Omit<Loose<ComponentProps<typeof TooltipContent>>, "className"> & {
  className?: string | undefined;
  // Surface chrome preset; see TOOLTIP_SURFACE_BY_VARIANT. `className` still wins
  // for per-tooltip tweaks (max-width, wrapping) on top of the chosen variant.
  variant?: TooltipVariant | undefined;
  // Kept for callers; the popup itself is the positioned element now, so this joins its classes.
  positionerClassName?: string | undefined;
  // The viewport owns the inner inset (px-2 py-1) for plain text tooltips; rich
  // cards that bring their own padding can zero it here so they don't double up.
  viewportClassName?: string | undefined;
};

const neverChanges = () => () => {};

/** False while React renders to a string (no page), true in the app. */
function useInPage(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );
}

function TooltipPopup({
  className,
  positionerClassName,
  viewportClassName,
  variant: variantProp,
  align: alignProp,
  sideOffset: sideOffsetProp,
  side: sideProp,
  children,
  style,
  ...props
}: TooltipPopupProps) {
  const variant = variantProp ?? "default";
  const shown = useContext(TooltipShown);
  const optedIntoPointer = useContext(TooltipTakesPointer);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [holdsPressables, setHoldsPressables] = useState(false);
  useLayoutEffect(() => {
    if (!surface) return;
    const check = () => setHoldsPressables(surface.querySelector(PRESSABLE_CONTENT) !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(surface, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [surface]);
  const takesPointer = optedIntoPointer || holdsPressables;
  // The surface is drawn only once the tooltip opens, so UI SDK first places it at its empty size
  // (over its own trigger) and corrects that a frame later. For two frames after opening it is
  // invisible and lets presses through, as Base UI never showed an unplaced popup: a press on the
  // trigger landed its release on the tooltip and lost its click.
  const [placing, setPlacing] = useState(false);
  useLayoutEffect(() => {
    if (!shown) return;
    setPlacing(true);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPlacing(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  // UI SDK keeps a closed tooltip in the page (it describes its trigger). Rendered to a string,
  // with no page, there is nothing to describe and UI SDK cannot place it: render nothing there,
  // as Base UI did for a closed tooltip.
  const inPage = useInPage();
  if (!inPage) return null;
  // Base UI's shape, kept on purpose: UI SDK's content part is the positioned element (it sits in
  // the top layer, so it is a stacking context), and Moss's surface is a plain child inside it. The
  // frosted surface draws its blur on a `::before` at z-index -1, which must stay behind the
  // surface's own background; on the top-layer element itself it would paint over it.
  return (
    <TooltipContent
      {...definedProps<object, ComponentProps<typeof TooltipContent>>(props)}
      align={alignProp ?? "center"}
      side={sideProp ?? "top"}
      sideOffset={sideOffsetProp ?? 4}
      // Base UI kept popups 5px from the window's edge; UI SDK's default is 8px.
      collisionPadding={(props as { collisionPadding?: number }).collisionPadding ?? 5}
      className={cn(
        POPUP_INHERITANCE_RESET_CLASS_NAME,
        // A text tooltip lets a press reach the control it covers (one left open by a resting
        // pointer had swallowed clicks on its neighbour). One a person uses with the pointer keeps
        // it: it holds something to press, or opted in with disableHoverablePopup={false}.
        takesPointer ? null : "pointer-events-none",
        "z-50 max-w-(--available-width) outline-none data-placing:pointer-events-none data-placing:invisible",
        "origin-(--transform-origin) transition-[scale,opacity] duration-120 ease-snap motion-reduce:transition-none motion-reduce:duration-0 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
        positionerClassName,
      )}
      render={(contentProps, state) => (
        <div
          {...contentProps}
          // Only a showing tooltip is one to assistive technology and to queries for one: a
          // closed UI SDK tooltip stays in the page, where Base UI left none.
          role={state.open || shown ? (contentProps as { role?: string }).role : undefined}
          data-instant={state.instant ? "" : undefined}
          data-placing={placing ? "" : undefined}
          data-slot="tooltip-positioner"
        />
      )}
    >
      {(state) =>
        // Without a Moss root around it (a detached controller), it follows UI SDK's open state.
        !(state.open || shown) ? null : (
          <div
            className={cn(
              // Structure + type are shared by every tooltip; the variant supplies the
              // surface chrome (frosted card, picker, …) and `className` adds per-tooltip
              // tweaks like max-width or wrapping.
              "flex text-ui leading-[1.125rem]",
              variant === "command" ? "font-mono whitespace-pre-wrap" : "text-balance",
              TOOLTIP_SURFACE_BY_VARIANT[variant],
              className,
            )}
            data-instant={state.instant ? "" : undefined}
            data-slot="tooltip-popup"
            ref={setSurface}
            // Base UI put a popup's style on the popup itself (callers size the surface with it).
            style={typeof style === "function" ? style(state) : style}
          >
            <div
              className={cn(
                "relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)]",
                viewportClassName,
              )}
              data-slot="tooltip-viewport"
            >
              {children as ReactNode}
            </div>
          </div>
        )
      }
    </TooltipContent>
  );
}

export { TooltipCreateHandle, TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup };
