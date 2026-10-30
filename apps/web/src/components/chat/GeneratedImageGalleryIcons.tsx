// FILE: GeneratedImageGalleryIcons.tsx
// Purpose: Generated-image gallery glyphs.
// Layer: Web chat presentation icons

import type { SVGProps } from "react";

export const CODEX_GENERATED_IMAGE_STACK_VIEW_BOX = "0 0 21 21" as const;
export const CODEX_GENERATED_IMAGE_STACK_PATHS = [
  "M8.1 9.9a1.15 1.15 0 1 1-2.3 0a1.15 1.15 0 1 1 2.3 0Z",
  "M3 9a2.25 2.25 0 0 1 2.25-2.25h7A2.25 2.25 0 0 1 14.5 9v7.25a2.25 2.25 0 0 1-2.25 2.25h-7A2.25 2.25 0 0 1 3 16.25ZM3.25 15.5l3-2.75 2.25 1.9 2.25-2.15 3.5 3.25",
  "M6.75 4.5a2 2 0 0 1 2-1.75h7.25A2.25 2.25 0 0 1 18.25 5v7.5a2 2 0 0 1-1.75 2",
] as const;

export const CODEX_GENERATED_IMAGE_CHEVRON_VIEW_BOX = "0 0 20 21" as const;
export const CODEX_GENERATED_IMAGE_CHEVRON_PATH = "M4.75 8l5.25 5.25L15.25 8" as const;

export function GeneratedImageStackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      width="21"
      height="21"
      viewBox={CODEX_GENERATED_IMAGE_STACK_VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={props["aria-hidden"] ?? true}
      data-generated-image-icon="stack"
    >
      <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
        <path d={CODEX_GENERATED_IMAGE_STACK_PATHS[0]} />
        <path d={CODEX_GENERATED_IMAGE_STACK_PATHS[1]} />
        <path d={CODEX_GENERATED_IMAGE_STACK_PATHS[2]} />
      </g>
    </svg>
  );
}

export function GeneratedImageChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      width="20"
      height="21"
      viewBox={CODEX_GENERATED_IMAGE_CHEVRON_VIEW_BOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={props["aria-hidden"] ?? true}
      data-generated-image-icon="chevron"
    >
      <path
        d={CODEX_GENERATED_IMAGE_CHEVRON_PATH}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
