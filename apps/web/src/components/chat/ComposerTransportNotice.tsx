import { useEffect, useState } from "react";

import { StatusDot } from "~/components/ui/status-chip";
import {
  type ComposerTransportNoticeKind,
  subscribeComposerTransportStatus,
} from "~/lib/composerTransportStatus";
import { useTranslation } from "~/localization";
import { ComposerCapsule } from "./ComposerCapsule";

const NOTICE_TEXT_KEYS = {
  connecting: "chat.transport.connecting",
  reconnecting: "chat.transport.reconnecting",
  incompatible: "chat.transport.incompatible",
  disconnected: "chat.transport.disconnected",
} as const satisfies Record<ComposerTransportNoticeKind, string>;

/** Transport presentation stays local; it must not become a transcript activity signal. */
export function ComposerTransportNotice() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<ComposerTransportNoticeKind | null>(null);
  useEffect(() => subscribeComposerTransportStatus(setNotice), []);

  if (notice === null) return null;

  // Like the other capsules, mount without motion and remove immediately on recovery.
  return (
    <ComposerCapsule role="status" icon={<StatusDot aria-hidden className="bg-amber-500" />}>
      <span className="text-muted-foreground">{t(NOTICE_TEXT_KEYS[notice])}</span>
    </ComposerCapsule>
  );
}
