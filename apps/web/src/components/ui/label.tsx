"use client";

import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { definedProps, type Loose } from "./uiSdkProps";

type LabelProps = Loose<Omit<ComponentProps<typeof LabelPrimitive>, "className">> & {
  className?: string | undefined;
};

function Label({ className, ...props }: LabelProps) {
  return (
    <LabelPrimitive
      {...definedProps<object, ComponentProps<typeof LabelPrimitive>>(props)}
      className={cn(
        "inline-flex items-center gap-2 text-ui leading-4.5 sm:text-ui sm:leading-4 font-medium text-foreground",
        className,
      )}
      data-slot="label"
    />
  );
}

export { Label, type LabelProps };
