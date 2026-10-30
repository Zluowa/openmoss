// FILE: MossLogo.tsx
// Purpose: Compatibility shim for upstream Moss-mark call sites; renders the
// Moss brand mark so the product identity stays Moss after the upstream merge.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { MOSS_LOGO_PATHS } from "~/assets/mossLogoPath";
import { cn } from "~/lib/utils";

export function MossLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="0 0 470 504"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      {MOSS_LOGO_PATHS.map((path) => (
        <path key={path} d={path} fill="currentColor" />
      ))}
    </svg>
  );
}
