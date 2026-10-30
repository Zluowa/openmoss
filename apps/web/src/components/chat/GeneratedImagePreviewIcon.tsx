// FILE: GeneratedImagePreviewIcon.tsx
// Purpose: Image-preview tab glyph.
// Layer: Chat right-dock UI primitive

import type { SVGProps } from "react";

export const GENERATED_IMAGE_PREVIEW_ICON_VIEW_BOX = "0 0 24 24" as const;
export const GENERATED_IMAGE_PREVIEW_ICON_PATHS = [
  "M3.5 6.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3Z",
  "M4 16.5l4.25-4 3.25 3 2.75-2.5 5.75 5.25",
  "M10.25 9a1.75 1.75 0 1 1-3.5 0a1.75 1.75 0 1 1 3.5 0Z",
] as const;

export function GeneratedImagePreviewIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      width="24"
      height="24"
      viewBox={GENERATED_IMAGE_PREVIEW_ICON_VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={props["aria-hidden"] ?? true}
      data-generated-image-icon="preview"
    >
      <path
        d={GENERATED_IMAGE_PREVIEW_ICON_PATHS[0]}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d={GENERATED_IMAGE_PREVIEW_ICON_PATHS[1]}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d={GENERATED_IMAGE_PREVIEW_ICON_PATHS[2]}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
