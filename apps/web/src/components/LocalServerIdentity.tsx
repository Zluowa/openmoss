// FILE: LocalServerIdentity.tsx
// Purpose: Shared name + "address · folder" identity column for a detected local dev server.
// Layer: Web UI primitive (shared between the Environment menu and the in-app browser home).
// Depends on: shared local-server presentation helpers.

import type { ServerLocalServerProcess } from "@synara/contracts";
import {
  localServerAddressLabel,
  localServerFolderLabel,
  localServerPrimaryLabel,
} from "@synara/shared/localServers";

import { cn } from "~/lib/utils";

/**
 * Visual context the identity column renders into. Both surfaces share an
 * identical structure — a truncating primary label above a horizontal
 * "address · folder" meta line — and differ only in typography/color tokens:
 * - "menu": the Environment panel's Local Servers popup (app font tokens, muted foreground).
 * - "browser": the in-app browser's local-servers home (larger cards on the theme sheet).
 */
export type LocalServerIdentityTone = "menu" | "browser";

interface LocalServerIdentityToneTokens {
  primary: string;
  meta: string;
  address: string;
  separator: string;
  folder: string;
}

const IDENTITY_TONE: Record<LocalServerIdentityTone, LocalServerIdentityToneTokens> = {
  menu: {
    primary: "text-ui font-normal text-[var(--color-text-foreground)]",
    meta: "text-ui-xs text-muted-foreground/65",
    address: "tabular-nums",
    separator: "text-muted-foreground/30",
    folder: "text-muted-foreground/45",
  },
  browser: {
    primary: "text-ui-lg font-semibold text-foreground",
    meta: "text-ui text-muted-foreground",
    address: "",
    separator: "text-muted-foreground/40",
    folder: "text-muted-foreground/70",
  },
};

/**
 * Name + "address · folder" identity column for a detected local dev server.
 * The folder (cwd basename) disambiguates servers whose live page titles collide
 * — e.g. two apps both titled "Moss" started from different directories.
 */
export function LocalServerIdentity({
  server,
  tone,
}: {
  server: ServerLocalServerProcess;
  tone: LocalServerIdentityTone;
}) {
  const tokens = IDENTITY_TONE[tone];
  const primaryLabel = localServerPrimaryLabel(server);
  const addressLabel = localServerAddressLabel(server);
  const folderLabel = localServerFolderLabel(server);

  return (
    <span className="min-w-0">
      <span
        className={cn("block truncate leading-tight", tokens.primary)}
        title={primaryLabel}
        data-translation-skip="true"
      >
        {primaryLabel}
      </span>
      <span className={cn("mt-0.5 flex items-center gap-1.5 leading-tight", tokens.meta)}>
        <span className={cn("shrink-0", tokens.address)} data-translation-skip="true">
          {addressLabel}
        </span>
        {folderLabel ? (
          <>
            <span className={tokens.separator} aria-hidden>
              ·
            </span>
            <span
              className={cn("truncate", tokens.folder)}
              title={server.cwd}
              data-translation-skip="true"
            >
              {folderLabel}
            </span>
          </>
        ) : null}
      </span>
    </span>
  );
}
