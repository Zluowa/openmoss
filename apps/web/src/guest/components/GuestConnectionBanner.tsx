// FILE: GuestConnectionBanner.tsx
// Purpose: The strip under the header that says the page is reconnecting, the owner is offline,
//          or the share has ended.
// Layer: Guest page UI

import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import type { GuestConnectionStatus } from "../connection";
import { GUEST_END_REASON_KEY, describeGuestFailure } from "../guestCopy";

export function GuestConnectionBanner({
  status,
  onRetry,
}: {
  readonly status: GuestConnectionStatus;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  let tone: "muted" | "warning" | "ended" = "muted";
  let text: string | null = null;
  let retry = false;
  switch (status.kind) {
    case "reconnecting":
      text = t("guest.reconnecting");
      retry = status.attempt > 1;
      break;
    case "offline":
      tone = "warning";
      text = t("guest.ownerOffline");
      retry = status.attempt > 1;
      break;
    case "ended":
      tone = "ended";
      text = `${t("guest.ended.title")} · ${t(GUEST_END_REASON_KEY[status.reason])}`;
      break;
    case "lost":
      tone = "ended";
      text = `${t("guest.ended.title")} · ${describeGuestFailure(status.failure, t)}`;
      break;
    case "connecting":
    case "live":
      break;
  }
  return (
    <DisclosureRegion open={text !== null} className="shrink-0">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center justify-center gap-3 px-4 py-1.5 text-center text-ui-xs",
          tone === "muted" && "bg-secondary text-muted-foreground",
          tone === "warning" && "bg-warning/12 text-warning",
          tone === "ended" && "bg-secondary text-foreground",
        )}
      >
        <span>{text}</span>
        {retry ? (
          <button
            type="button"
            className="shrink-0 font-medium underline underline-offset-2"
            onClick={onRetry}
          >
            {t("guest.retryNow")}
          </button>
        ) : null}
      </div>
    </DisclosureRegion>
  );
}
