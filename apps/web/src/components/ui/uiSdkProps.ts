// FILE: uiSdkProps.ts
// Purpose: The seam between Moss's wrapper props and UI SDK's part props. Moss callers pass
//          optional props as `disabled={maybe}` (possibly `undefined`), the way Base UI accepted
//          them; UI SDK's option types, under `exactOptionalPropertyTypes`, take a value or no key.
// Layer: components/ui internals (not for app code).

import { renderElement as renderElementFn } from "@ui-sdk/react/primitive";

/**
 * UI SDK registers `--available-height` and `--available-width` as non-inheriting
 * (`CSS.registerProperty`, `inherits: false`) the first time it positions a popup, for the whole
 * page. Moss's surfaces, themes and the Base UI popups still in use size themselves from these
 * below the positioner, as Base UI allowed, and lose their height cap without inheritance.
 * Registering them first, inheriting, keeps that: UI SDK ignores a name that is already
 * registered. Runs when the first wrapper module loads, before any popup can open.
 */
export function keepRoomVariablesInherited(): void {
  if (typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return;
  for (const name of ["--available-height", "--available-width"]) {
    try {
      CSS.registerProperty({ name, syntax: "*", inherits: true });
    } catch {
      // Already registered (a second copy of this module, or a test page that reloaded it).
    }
  }
}
keepRoomVariablesInherited();

/** A part's props where every optional prop may also be passed as `undefined`. */
export type Loose<Props> = { [Key in keyof Props]?: Props[Key] | undefined };

/** The same props without the keys whose value is `undefined`, for a UI SDK part. */
export function definedProps<Props extends object, Target = Props>(props: Props): Target {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined as Target;
}

/**
 * A `render` prop as Moss callers write it: any element (Base UI accepted `ReactElement<unknown>`)
 * or a function of the part's props and state.
 */
export type LooseRender<State = unknown> =
  | import("react").ReactElement<any>
  | ((props: Record<string, any>, state: State) => import("react").ReactElement);

type RectLike = Pick<DOMRect, "top" | "left" | "width" | "height"> & Partial<DOMRect>;
type Boxed = { getBoundingClientRect: () => RectLike };

/**
 * An `anchor` as Moss callers pass it (Base UI took a ref or a function too), as UI SDK takes it:
 * something with `getBoundingClientRect()`, read on every placement check.
 */
export function toAnchor(
  anchor:
    | Element
    | Boxed
    | string
    | { current: Element | null }
    | (() => Element | Boxed | null | undefined)
    | null
    | undefined,
): Element | Boxed | string | null | undefined {
  if (anchor == null || typeof anchor === "string" || anchor instanceof Element) return anchor;
  if (typeof anchor === "function") {
    return {
      getBoundingClientRect: () => anchor()?.getBoundingClientRect() ?? new DOMRect(),
    };
  }
  if ("current" in anchor) {
    return {
      getBoundingClientRect: () => anchor.current?.getBoundingClientRect() ?? new DOMRect(),
    };
  }
  return anchor;
}

/** A focus target as Moss callers pass it (a ref too), as UI SDK takes it (a function of one). */
export function toFocusTarget<Target>(
  target: Target | { current: HTMLElement | null } | null | undefined,
): Target | (() => HTMLElement | null) | null | undefined {
  if (target && typeof target === "object" && "current" in target) {
    const ref = target as { current: HTMLElement | null };
    return () => ref.current;
  }
  return target as Target | null | undefined;
}

/**
 * Renders a part as the plain native element `tag` with Moss's slot name (UI SDK's part forces its
 * own), for parts with no open state, such as a clear button.
 */
export function renderSlotted<State>(
  tag: string,
  slot: string,
): (props: Record<string, any>, state: State) => import("react").ReactElement {
  return (props, state) =>
    renderElementFn(tag, { ...props, "data-slot": slot }, undefined as never, state as never);
}

/**
 * A trigger's `render` that also marks it `data-popup-open` while its popup is open, as Base UI
 * did (UI SDK writes `data-open`); Moss styles open triggers by that attribute. A caller's own
 * `render` (an element or a function) still decides the element.
 */
export function renderOpenTrigger(
  render: LooseRender<any> | undefined,
  tag: string = "button",
  slot?: string,
): (props: Record<string, any>, state: { open?: boolean }) => import("react").ReactElement {
  return (props, state) =>
    renderElementFn(
      tag,
      {
        ...props,
        // Moss's slot name, where UI SDK's part has another (CSS and tests select by it).
        ...(slot ? { "data-slot": slot } : {}),
        "data-popup-open": state.open ? "" : undefined,
      },
      render as never,
      state,
    );
}
