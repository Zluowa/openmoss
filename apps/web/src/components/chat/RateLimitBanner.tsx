// FILE: RateLimitBanner.tsx
// Purpose: Derives and renders provider rate-limit warnings for the active chat.
// Layer: Chat status presentation
// Exports: RateLimitBanner and rate-limit derivation helpers.

import type { OrchestrationThreadActivity } from "@moss/contracts";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { formatRateLimitResetCountdown } from "~/lib/rateLimits";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export type RateLimitStatus = {
  status: "rejected" | "allowed_warning";
  resetsAt?: string;
  utilization?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function deriveLatestRateLimitStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): RateLimitStatus | null {
  const now = Date.now();
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (!activity || activity.kind !== "account.rate-limited") continue;
    const payload = asRecord(activity.payload);
    if (!payload) continue;
    const status = payload.status;
    if (status !== "rejected" && status !== "allowed_warning") continue;
    // If resetsAt is in the past, the limit has expired — skip
    if (typeof payload.resetsAt === "string") {
      const resetsAtMs = Date.parse(payload.resetsAt);
      if (!Number.isNaN(resetsAtMs) && resetsAtMs < now) continue;
    }
    return {
      status,
      ...(typeof payload.resetsAt === "string" ? { resetsAt: payload.resetsAt } : {}),
      ...(typeof payload.utilization === "number" ? { utilization: payload.utilization } : {}),
    };
  }
  return null;
}

// A dismissed banner stays hidden; the "Rate limit warnings" setting hides only the early
// warning, so a reached limit always shows.
export function resolveVisibleRateLimitStatus(
  status: RateLimitStatus | null,
  options: { readonly dismissed: boolean; readonly showWarnings: boolean },
): RateLimitStatus | null {
  if (!status || options.dismissed) return null;
  if (status.status === "allowed_warning" && !options.showWarnings) return null;
  return status;
}

// Share the usage popovers' countdown so a weekly limit reads "Resets in 6d 6h", not "9044m".
export function formatResetsAt(resetsAt: string): string {
  const countdown = formatRateLimitResetCountdown(resetsAt);
  return countdown ? ` ${countdown}.` : "";
}

export const RateLimitBanner = function RateLimitBanner({
  onDismiss,
  rateLimitStatus,
}: {
  onDismiss?: () => void;
  rateLimitStatus: RateLimitStatus | null;
}) {
  if (!rateLimitStatus) return null;

  const { status, resetsAt, utilization } = rateLimitStatus;
  const isRejected = status === "rejected";

  const message = isRejected
    ? `Rate limit reached.${resetsAt ? formatResetsAt(resetsAt) : ""}`
    : `Approaching rate limit${utilization !== undefined ? ` (${Math.round(utilization * 100)}% used)` : ""}.${resetsAt ? formatResetsAt(resetsAt) : ""}`;

  return (
    <ChatColumnBannerFrame>
      <Alert variant={isRejected ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertDescription>{message}</AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <IconButton
              label="Dismiss rate limit status"
              title="Dismiss rate limit status"
              onClick={onDismiss}
            >
              <XIcon className="size-4" />
            </IconButton>
          </AlertAction>
        ) : null}
      </Alert>
    </ChatColumnBannerFrame>
  );
};
