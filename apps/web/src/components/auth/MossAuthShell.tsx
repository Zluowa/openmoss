import { type ReactNode, useLayoutEffect } from "react";

import { MossLogo } from "~/components/MossLogo";

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
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  useMossOpaqueSurface();

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-y-auto bg-background px-4 py-8 text-foreground sm:px-6">
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
