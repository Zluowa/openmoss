// FILE: MossLogoMark.tsx
// Purpose: Render the Moss mark as an inline SVG that inherits `currentColor`.
// Layer: Shared app branding primitive
// Why: Surfaces that cannot load `/moss-logo-coral.png` (the share relay's guest page only serves
//      `GUEST_STATIC_DIRS`) need the mark bundled into the script rather than fetched.

import type { SVGProps } from "react";
import { MOSS_LOGO_PATHS } from "~/assets/mossLogoPath";
import { cn } from "~/lib/utils";

export function MossLogoMark({ className, ...props }: SVGProps<SVGSVGElement>) {
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
