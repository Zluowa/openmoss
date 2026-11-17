"use client";

// FILE: triggerOptions.tsx
// Purpose: Moss callers set hover timing on a popup's trigger (`<TooltipTrigger delay={0}>`,
//          `<PopoverTrigger openOnHover>`), where Base UI read it. UI SDK reads the same options on
//          the popup's root. A trigger hands its options to the root through this context, so the
//          wrappers keep the props where callers already put them.
// Layer: components/ui internals (not for app code).

import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

export interface TriggerOptions {
  delay?: number | undefined;
  closeDelay?: number | undefined;
  openOnHover?: boolean | undefined;
  closeOnClick?: boolean | undefined;
}

const SetTriggerOptions = createContext<((options: TriggerOptions) => void) | null>(null);

/** Root side: the options the trigger inside it set, merged under the root's own props. */
export function useTriggerOptions(): [TriggerOptions, (children: ReactNode) => ReactNode] {
  const [options, setOptions] = useState<TriggerOptions>({});
  const provide = (children: ReactNode) => (
    <SetTriggerOptions.Provider value={setOptions}>{children}</SetTriggerOptions.Provider>
  );
  return [options, provide];
}

/** Trigger side: hand this trigger's options to the root it sits in. */
export function useProvideTriggerOptions(options: TriggerOptions): void {
  const set = useContext(SetTriggerOptions);
  const { delay, closeDelay, openOnHover, closeOnClick } = options;
  useLayoutEffect(() => {
    if (!set) return;
    set({ delay, closeDelay, openOnHover, closeOnClick });
  }, [set, delay, closeDelay, openOnHover, closeOnClick]);
}
