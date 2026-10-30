import type { SVGProps } from "react";

/**
 * The model-rerouted warning keeps its own information glyph rather than
 * Moss's general Tabler icon, so restyling the general icon cannot change it.
 */
export function ModelReroutedInfoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={21}
      height={21}
      viewBox="0 0 21 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M9.8 10.2a.7.7 0 0 1 1.4 0v3.4a.7.7 0 0 1-1.4 0Z" fill="currentColor" />
      <path d="M10.5 6.2a.95.95 0 1 1 0 1.9a.95.95 0 0 1 0-1.9Z" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.5 3a7.5 7.5 0 1 1 0 15a7.5 7.5 0 0 1 0-15Zm0 1.4a6.1 6.1 0 1 0 0 12.2a6.1 6.1 0 0 0 0-12.2Z"
        fill="currentColor"
      />
    </svg>
  );
}
