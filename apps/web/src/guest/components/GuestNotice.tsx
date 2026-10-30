// FILE: GuestNotice.tsx
// Purpose: Full-page states of the guest page: connecting, invalid link, ended before any data.
// Layer: Guest page UI

import type { ReactNode } from "react";

import { MossLogo } from "~/components/SynaraLogo";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

export function WhatIsMossLink({ className }: { readonly className?: string }) {
  const { t } = useTranslation();
  return (
    <a
      href="https://trymoss.com"
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "text-ui-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
        className,
      )}
    >
      {t("guest.brand.whatIsMoss")}
    </a>
  );
}

export function GuestNotice({
  title,
  detail,
  children,
  busy = false,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly children?: ReactNode;
  readonly busy?: boolean;
}) {
  return (
    <div className={cn("flex h-dvh flex-col text-foreground", CHAT_BACKGROUND_CLASS_NAME)}>
      <div className="m-auto flex w-full max-w-sm flex-col items-center gap-5 px-6 py-10 text-center">
        <MossLogo className={cn("size-10", busy && "animate-pulse motion-reduce:animate-none")} />
        <div className="flex flex-col gap-1.5">
          <p className="text-ui-lg font-medium" role={busy ? "status" : undefined}>
            {title}
          </p>
          {detail ? <p className="text-ui-sm text-muted-foreground">{detail}</p> : null}
        </div>
        {children}
        <WhatIsMossLink />
      </div>
    </div>
  );
}
