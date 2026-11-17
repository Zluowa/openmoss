"use client";

import { Radio as RadioPrimitive, RadioGroup as RadioGroupPrimitive } from "@ui-sdk/react/radio";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { definedProps, type Loose } from "./uiSdkProps";

type RadioGroupProps = Loose<Omit<ComponentProps<typeof RadioGroupPrimitive>, "className">> & {
  className?: string | undefined;
};

function RadioGroup({ className, ...props }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive
      {...definedProps<object, ComponentProps<typeof RadioGroupPrimitive>>(props)}
      className={cn("flex flex-col gap-3", className)}
      data-slot="radio-group"
    />
  );
}

type RadioProps = Loose<Omit<ComponentProps<typeof RadioPrimitive>, "className" | "children">> & {
  className?: string | undefined;
  children?: ReactNode;
};

function Radio({ className, children, ...props }: RadioProps) {
  return (
    <RadioPrimitive
      {...definedProps<object, ComponentProps<typeof RadioPrimitive>>(props)}
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-input bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:aria-invalid:ring-destructive/24",
        className,
      )}
      data-slot="radio"
    >
      {/* A plain span from the radio's state, not UI SDK's RadioIndicator: Moss's dot does not
          animate, and that part's presence code restyles the page on every change. */}
      {(state) => (
        <>
          <span
            aria-hidden="true"
            className="-inset-px absolute flex size-4.5 items-center justify-center rounded-full before:size-2 before:rounded-full before:bg-primary-foreground data-unchecked:hidden data-checked:bg-primary sm:size-4 sm:before:size-1.5"
            data-checked={state.checked ? "" : undefined}
            data-slot="radio-indicator"
            data-unchecked={state.checked ? undefined : ""}
          />
          {children}
        </>
      )}
    </RadioPrimitive>
  );
}

export { RadioGroup, Radio, Radio as RadioGroupItem, type RadioGroupProps, type RadioProps };
