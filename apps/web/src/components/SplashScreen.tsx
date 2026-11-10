// FILE: SplashScreen.tsx
// Purpose: Render the branded startup face while the app is still booting a route or session.
// Layer: Shared app loading presentation

import { Button } from "~/components/ui/button";
import { MossLogo } from "~/components/MossLogo";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";

export function SplashScreen({
  errorMessage,
  onRetry,
}: {
  errorMessage?: string | null;
  onRetry?: (() => void) | null;
}) {
  const showRetry = Boolean(errorMessage && onRetry);

  return (
    <RouteInsetSurface>
      <div
        data-moss-startup-splash
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-[var(--moss-boot-background)]"
      >
        <div className="flex flex-col items-center gap-5 select-none">
          {/* Match the first-paint mark without covering navigation during route loads. */}
          <MossLogo
            aria-label="Moss"
            className={
              errorMessage
                ? "size-[72px]"
                : "pointer-events-none fixed top-1/2 left-1/2 size-[72px] -translate-x-1/2 -translate-y-1/2"
            }
          />

          {errorMessage ? (
            <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
              <span className="text-ui-lg text-muted-foreground/75">{errorMessage}</span>
              {showRetry ? (
                <Button
                  variant="outline"
                  size="default"
                  type="button"
                  className="transition-colors"
                  onClick={onRetry ?? undefined}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </RouteInsetSurface>
  );
}
