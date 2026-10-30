// FILE: MossLogo.tsx
// Purpose: Render the shared Moss app mark.
// Layer: Shared app branding primitive

import type { ImgHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

export function MossLogo({
  alt,
  className,
  draggable,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const ariaLabel = props["aria-label"];
  const ariaHidden = ariaLabel || alt ? props["aria-hidden"] : (props["aria-hidden"] ?? true);

  return (
    <img
      {...props}
      src="/moss-logo-coral.png"
      alt={alt ?? (typeof ariaLabel === "string" ? ariaLabel : "")}
      aria-hidden={ariaHidden}
      draggable={draggable ?? false}
      className={cn("inline-block shrink-0 object-contain", className)}
    />
  );
}
