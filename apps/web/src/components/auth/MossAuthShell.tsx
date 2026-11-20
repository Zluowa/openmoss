import { type ReactNode, useLayoutEffect } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { goBackInAppHistory } from "~/appNavigation";
import { isElectron } from "~/env";
import { DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS } from "~/hooks/useDesktopTopBarGutter";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { MossLogo } from "~/components/MossLogo";
import { Button } from "~/components/ui/button";
import { ArrowLeftIcon, ChevronLeftIcon } from "~/lib/icons";

const OPAQUE_SURFACE_CLASS = "moss-opaque-surface";
let opaqueSurfaceMountCount = 0;

export function useMossOpaqueSurface() {
  useLayoutEffect(() => {
    opaqueSurfaceMountCount += 1;
    document.documentElement.classList.add(OPAQUE_SURFACE_CLASS);

    return () => {
      opaqueSurfaceMountCount = Math.max(0, opaqueSurfaceMountCount - 1);
      if (opaqueSurfaceMountCount === 0) {
        document.documentElement.classList.remove(OPAQUE_SURFACE_CLASS);
      }
    };
  }, []);
}

export function MossAuthShell({
  title,
  description,
  children,
  footer,
  backToApp = false,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  /** A 返回 control in the title bar, for pages a person reaches from inside the app. */
  readonly backToApp?: boolean;
}) {
  useMossOpaqueSurface();

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-y-auto bg-background px-4 py-8 text-foreground sm:px-6">
      {backToApp ? <MossAuthBackBar /> : null}
      <div className="mx-auto flex w-full max-w-[360px] flex-col items-stretch">
        <div className="mb-6 flex justify-center" aria-hidden="true">
          <MossLogo className="size-10" />
        </div>
        <section aria-labelledby="moss-auth-title" className="w-full min-w-0">
          <header className="mb-6 text-center">
            <h1
              id="moss-auth-title"
              className="text-balance text-2xl font-medium leading-tight tracking-[-0.02em]"
            >
              {title}
            </h1>
            {description ? (
              <p className="mt-2 text-pretty text-ui-lg leading-5 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </header>
          {children}
        </section>
        {footer ? (
          <footer className="mt-6 text-center text-ui-lg leading-5 text-muted-foreground">
            {footer}
          </footer>
        ) : null}
      </div>
    </main>
  );
}

export function MossAuthLoading({ label }: { readonly label: string }) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-28 items-center justify-center text-ui-lg text-muted-foreground"
      role="status"
    >
      {label}
    </div>
  );
}

/**
 * Back to where the person was (the chat they came from); to the chats when the page was
 * opened directly and the app has no earlier entry to return to.
 */
export function useMossGoBackToApp(): () => void {
  const router = useRouter();
  const navigate = useNavigate();
  return () => {
    if (router.history.canGoBack()) goBackInAppHistory(router.history);
    else void navigate({ to: "/" });
  };
}

/** The top-left 「← 返回 Moss」 of the full-page account and membership screens. */
export function MossBackToAppButton({
  children,
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly "data-testid"?: string;
}) {
  const goBack = useMossGoBackToApp();
  return (
    <Button
      aria-label={ariaLabel}
      className={className}
      data-testid={testId}
      onClick={goBack}
      size="default"
      type="button"
      variant="ghost"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-4" />
      {children}
    </Button>
  );
}

/** Back to where the person was; to the chats when the page was opened directly. */
function MossAuthBackBar() {
  const goBack = useMossGoBackToApp();
  return (
    <div
      data-moss-auth-back
      // On macOS the traffic lights sit at the top left; the band starts after them.
      className={cn(
        "drag-region fixed inset-x-0 top-0 z-10 flex h-11 items-center pr-36 pl-2",
        isElectron && isMacNavigatorPlatform() && DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CLASS,
      )}
    >
      <Button type="button" variant="ghost" size="sm" onClick={goBack}>
        <ChevronLeftIcon className="size-4" />
        返回
      </Button>
    </div>
  );
}
