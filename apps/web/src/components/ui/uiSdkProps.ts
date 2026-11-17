// FILE: uiSdkProps.ts
// Purpose: The seam between Moss's wrapper props and UI SDK's part props. Moss callers pass
//          optional props as `disabled={maybe}` (possibly `undefined`), the way Base UI accepted
//          them; UI SDK's option types, under `exactOptionalPropertyTypes`, take a value or no key.
// Layer: components/ui internals (not for app code).

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
