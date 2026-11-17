"use client";

import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { Textarea as TextareaPrimitive } from "@ui-sdk/react/textarea";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { definedProps } from "./uiSdkProps";

type TextareaProps = React.ComponentProps<"textarea"> & {
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
};

function Textarea({
  className,
  size: sizeProp,
  unstyled: unstyledProp,
  // A submit event never reaches a textarea, while UI SDK reads `onSubmit` as its submit-shortcut
  // handler; it is dropped so Enter keeps adding a line, as it always has.
  onSubmit: _onSubmit,
  ...props
}: TextareaProps) {
  const size = sizeProp ?? "default";
  const unstyled = unstyledProp ?? false;
  return (
    <span
      className={
        cn(
          !unstyled &&
            `${GLASS_RAISED_SURFACE_CLASS_NAME} relative inline-flex w-full rounded-control border border-input bg-background text-ui text-foreground has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:border-foreground/30 has-disabled:opacity-64 sm:text-ui dark:bg-input/32`,
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="textarea-control"
    >
      <TextareaPrimitive
        {...definedProps<object, React.ComponentProps<typeof TextareaPrimitive>>({
          ...props,
          value: typeof props.value === "number" ? String(props.value) : props.value,
          defaultValue:
            typeof props.defaultValue === "number"
              ? String(props.defaultValue)
              : props.defaultValue,
        })}
        className={cn(
          "font-system-ui field-sizing-content min-h-17.5 w-full resize-none rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5",
          size === "sm" &&
            "min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5",
          size === "lg" && "min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5",
        )}
        data-slot="textarea"
      />
    </span>
  );
}

export { Textarea, type TextareaProps };
