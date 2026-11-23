// FILE: text-link.tsx
// Purpose: A link in running text: the accent colour, underlined on hover and keyboard focus.
//          The values of links in a reply (`.chat-markdown a` in index.css).
// Layer: UI primitive
// Exports: TextLink

import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

export function TextLink({ className, ...props }: ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "text-[var(--color-token-text-link-foreground)] no-underline decoration-from-font underline-offset-[0.18em] outline-none hover:text-[var(--color-token-text-link-active-foreground)] hover:underline focus-visible:text-[var(--color-token-text-link-active-foreground)] focus-visible:underline",
        className,
      )}
      data-slot="text-link"
      {...props}
    />
  );
}
