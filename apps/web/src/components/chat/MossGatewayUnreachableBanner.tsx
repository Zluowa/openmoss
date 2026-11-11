// FILE: MossGatewayUnreachableBanner.tsx
// Purpose: Says plainly, above a chat on a Moss lane, that Moss's service can't be reached
//          right now and reconnects on its own, so an outage never reads as being signed out.
// Layer: Chat status presentation

import type { ProviderInstanceId } from "@moss/contracts";

import { isMossManagedSourceInstanceId } from "./providerAccountSources";
import { useMossGatewayUnreachable } from "../auth/useMossGatewayUnreachable";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "../ui/notificationSurface";
import { TriangleAlertIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export function MossGatewayUnreachableBanner(props: {
  /** The account the chat runs on; only Moss lanes show this banner. */
  instanceId: ProviderInstanceId | null | undefined;
}) {
  const { t } = useTranslation();
  const unreachable = useMossGatewayUnreachable();
  if (!unreachable || !props.instanceId || !isMossManagedSourceInstanceId(props.instanceId)) {
    return null;
  }
  return (
    <ChatColumnBannerFrame>
      <Alert
        className={EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME}
        variant="warning"
        data-moss-gateway-unreachable=""
      >
        <TriangleAlertIcon className={NOTIFICATION_ICON_CLASS_NAME} />
        <AlertTitle className="font-normal text-[var(--notification-fg)]">
          {t("chat.mossGatewayUnreachable.title")}
        </AlertTitle>
        <AlertDescription className="text-[var(--notification-fg)]/72">
          {t("chat.mossGatewayUnreachable.description")}
        </AlertDescription>
      </Alert>
    </ChatColumnBannerFrame>
  );
}
