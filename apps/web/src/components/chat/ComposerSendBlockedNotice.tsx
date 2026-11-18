// FILE: ComposerSendBlockedNotice.tsx
// Purpose: Tells the person, right above the composer, why their message was not sent (the
//          selected model is not signed in, turned off or unavailable) and what to do, with
//          the action as a button. Replaces the toast at the top of the window, which covered
//          the title bar, cut the advice off and was easy to miss. The draft stays in the box.
// Layer: Chat composer UI
// Exports: ComposerSendBlockedNotice

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import {
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "../ui/notificationSurface";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

export function ComposerSendBlockedNotice(props: {
  /** The whole advice; it wraps and is never cut off. */
  message: string;
  /** Not signed in to Moss either: signing in lets Moss serve this model. */
  onSignInMoss?: (() => void) | undefined;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Alert
      role="alert"
      data-testid="composer-send-blocked-notice"
      variant="error"
      className={cn(EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME, "pointer-events-auto mb-2 pr-10")}
    >
      <CircleAlertIcon className={NOTIFICATION_ICON_CLASS_NAME} />
      <AlertDescription className="whitespace-normal break-words text-[var(--notification-fg)]">
        {props.message}
      </AlertDescription>
      <AlertAction className="flex-wrap items-center gap-2">
        {props.onSignInMoss ? (
          <Button size="xs" onClick={props.onSignInMoss}>
            {t("provider.send.blocked.signInMoss")}
          </Button>
        ) : null}
        <Button size="xs" variant="outline" onClick={props.onOpenSettings}>
          {t("provider.send.blocked.openSettings")}
        </Button>
      </AlertAction>
      <IconButton
        className="absolute top-2 right-2 size-6 rounded-full text-[var(--notification-fg)]/65 hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:ring-[var(--notification-fg)]/35 sm:size-6"
        label={t("provider.send.blocked.dismiss")}
        title={t("provider.send.blocked.dismiss")}
        onClick={props.onDismiss}
      >
        <XIcon className="size-4" />
      </IconButton>
    </Alert>
  );
}
