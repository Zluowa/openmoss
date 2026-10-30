// FILE: GuestApp.tsx
// Purpose: The guest page's flow: find the share, check for a session, join once, then watch.
// Layer: Guest page UI

import { useEffect, useState } from "react";

import { useTranslation } from "~/localization";

import { describeGuestFailure } from "../guestCopy";
import type { GuestFailure, GuestTransport } from "../transport";
import { clearStoredInvite, type GuestEntry } from "../url";
import { GuestNameForm } from "./GuestNameForm";
import { GuestNotice } from "./GuestNotice";
import { GuestThread } from "./GuestThread";

type Stage =
  | { readonly kind: "probing" }
  | { readonly kind: "name"; readonly invite: string }
  | { readonly kind: "joined" }
  | { readonly kind: "blocked"; readonly failure: GuestFailure };

const isFinal = (failure: GuestFailure) =>
  failure.kind === "http" && (failure.status === 403 || failure.status === 426);

export function GuestApp({
  entry,
  transport,
}: {
  readonly entry: GuestEntry;
  readonly transport: GuestTransport | null;
}) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ kind: "probing" });
  const { shareId, invite } = entry;

  useEffect(() => {
    if (transport === null) return;
    let live = true;
    void transport.probeSession().then((probe) => {
      if (!live) return;
      if (probe.ok) {
        setStage({ kind: "joined" });
      } else if (invite !== null) {
        // No session yet, so the name form spends the invite. If the owner is offline or the
        // network is down, joining reports it when the guest tries.
        setStage({ kind: "name", invite });
      } else if (isFinal(probe.failure)) {
        setStage({ kind: "blocked", failure: probe.failure });
      } else {
        // Offline owner or a network blip with no invite: the stream's reconnect loop reports.
        setStage({ kind: "joined" });
      }
    });
    return () => {
      live = false;
    };
  }, [transport, invite]);

  if (shareId === null || transport === null) {
    return (
      <GuestNotice title={t("guest.link.notShareTitle")} detail={t("guest.link.notShareDetail")} />
    );
  }
  switch (stage.kind) {
    case "probing":
      return <GuestNotice title={t("guest.connecting")} busy />;
    case "name":
      return (
        <GuestNameForm
          invite={stage.invite}
          transport={transport}
          onJoined={() => {
            clearStoredInvite(shareId);
            setStage({ kind: "joined" });
          }}
        />
      );
    case "joined":
      return <GuestThread shareId={shareId} transport={transport} />;
    case "blocked":
      return (
        <GuestNotice
          title={t("guest.link.invalidTitle")}
          detail={describeGuestFailure(stage.failure, t)}
        />
      );
  }
}
