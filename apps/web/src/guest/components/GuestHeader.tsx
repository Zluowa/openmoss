// FILE: GuestHeader.tsx
// Purpose: The shared thread's top bar: the Moss mark, the title, the model, and the expiry.
// Layer: Guest page UI
// Why: Built from the chat header's own tokens so it lines up with the owner's chat chrome; the
//      owner-only controls (git, panels, handoff) are simply absent.

import type { GuestThreadModel } from "@synara/contracts";

import { ProviderIcon } from "~/components/ProviderIcon";
import { MossLogoMark } from "~/components/MossLogoMark";
import {
  CHAT_HEADER_CONTROL_CLASS_NAME,
  CHAT_SURFACE_CHIP_ICON_CLASS_NAME,
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
} from "~/components/chat/chatHeaderControls";
import { useNowMs } from "~/hooks/useNowMs";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { formatProviderModelOptionName } from "~/providerModelOptions";

import { expiryRemaining } from "../guestStream.logic";

export function guestModelLabel(model: GuestThreadModel): string {
  return model.provider === null
    ? model.name
    : formatProviderModelOptionName({ provider: model.provider, slug: model.name });
}

function ExpiryLabel({ expiresAt }: { readonly expiresAt: string }) {
  const { t, format } = useTranslation();
  const now = useNowMs(true, 60_000);
  const remaining = expiryRemaining(expiresAt, now);
  return (
    <span className="shrink-0 text-ui-xs text-muted-foreground tabular-nums">
      {remaining === null
        ? t("guest.expiry.expired")
        : format(remaining.unit === "hours" ? "guest.expiry.hours" : "guest.expiry.minutes", {
            value: remaining.value,
          })}
    </span>
  );
}

export function GuestHeader({
  title,
  model,
  expiresAt,
}: {
  readonly title: string;
  readonly model: GuestThreadModel;
  readonly expiresAt: string;
}) {
  const { t, format } = useTranslation();
  const modelLabel = guestModelLabel(model);
  return (
    <div className="shrink-0 pt-[env(safe-area-inset-top,0px)]">
      <header
        className={cn(
          CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
          CHAT_SURFACE_HEADER_PADDING_X_CLASS,
          "gap-2",
        )}
      >
        <MossLogoMark className="size-4 shrink-0" aria-label="Moss" />
        <h1 className="min-w-0 flex-1 truncate text-ui font-medium" title={title}>
          {title !== "" ? title : t("guest.page.untitled")}
        </h1>
        <span
          className={cn(
            CHAT_HEADER_CONTROL_CLASS_NAME,
            CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
            "inline-flex min-w-0 max-w-[40%] items-center gap-1.5 px-1.5 text-ui-sm",
          )}
          aria-label={format("guest.model", { label: modelLabel })}
          title={modelLabel}
        >
          <ProviderIcon provider={model.provider} className={CHAT_SURFACE_CHIP_ICON_CLASS_NAME} />
          <span className="min-w-0 truncate">{modelLabel}</span>
        </span>
        <ExpiryLabel expiresAt={expiresAt} />
      </header>
    </div>
  );
}
