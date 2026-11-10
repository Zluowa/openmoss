// FILE: ForgeRefChip.tsx
// Purpose: A GitHub pull request or issue named by its bare link, drawn as the desktop
//          chat draws it: an accent pill with the pull request glyph and
//          "owner/repo#123" (plus "(files)", "(commits)" or "(checks)" for sub-pages).
// Layer: Chat transcript primitive
// Exports: ForgeRefChip

import type { MouseEvent } from "react";

import { GitPullRequestIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { type ForgeRef, forgeRefLabel } from "./forgeRef";

export function ForgeRefChip(props: {
  href: string;
  forgeRef: ForgeRef;
  onClick?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}) {
  const { forgeRef } = props;
  const label = forgeRefLabel(forgeRef);
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={props.onClick}
      data-forge-ref-chip={forgeRef.kind}
      title={props.href}
      className={cn(
        "inline rounded-inline px-1.5 box-decoration-clone align-baseline no-underline",
        "bg-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)] text-[var(--color-text-accent)]",
        "hover:bg-[color-mix(in_srgb,var(--color-text-accent)_18%,transparent)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <GitPullRequestIcon
        aria-hidden
        className="me-1 inline-block size-3 shrink-0 align-[-0.1em]"
      />
      {label}
      {forgeRef.detail ? ` (${forgeRef.detail})` : null}
    </a>
  );
}
