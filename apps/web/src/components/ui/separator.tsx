import { Separator as SeparatorPrimitive } from "@ui-sdk/react/separator";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { definedProps, type Loose } from "./uiSdkProps";

type SeparatorProps = Loose<Omit<ComponentProps<typeof SeparatorPrimitive>, "className">> & {
  className?: string | undefined;
};

function Separator({ className, orientation: orientationProp, ...props }: SeparatorProps) {
  const orientation = orientationProp ?? "horizontal";
  return (
    <SeparatorPrimitive
      {...definedProps<object, ComponentProps<typeof SeparatorPrimitive>>(props)}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-slot="separator"
      orientation={orientation}
    />
  );
}

export { Separator };
