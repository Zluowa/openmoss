// FILE: MossLogoMark.tsx
// Purpose: The Moss mark as inline SVG, for pages that do not serve `public/moss-logo-coral.png`.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { MOSS_LOGO_COLOR, MOSS_LOGO_PATH, MOSS_LOGO_VIEW_BOX } from "~/assets/mossLogoPath";
import { cn } from "~/lib/utils";

export function MossLogoMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox={MOSS_LOGO_VIEW_BOX}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0", className)}
    >
      <path d={MOSS_LOGO_PATH} fill={MOSS_LOGO_COLOR} fillRule="evenodd" />
    </svg>
  );
}
