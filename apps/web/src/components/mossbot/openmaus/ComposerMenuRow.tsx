// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export function ComposerMenuRow({
  icon,
  name,
  description,
  kind,
  selected = false,
  className,
  type = "button",
  ...rest
}: {
  icon: ReactNode;
  name: string;
  description?: string | undefined;
  kind: string;
  selected?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-start",
        selected && "bg-accent",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-foreground">{name}</span>
        {description ? (
          <span dir="auto" className="block truncate text-ui-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-end text-ui-xs text-muted-foreground">{kind}</span>
    </button>
  );
}
