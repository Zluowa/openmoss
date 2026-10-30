// FILE: GuestShareDialog.tsx
// Purpose: "Share with guest": create the one-time link, copy it, watch who joined and
//          whether the relay is reachable, and stop sharing.
// Layer: Chat UI
// Exports: GuestShareDialog
// Depends on: guestShareStore (share state), nativeApi guestShare calls

import type { GuestShareOwnerErrorCode, ThreadGuestShare, ThreadId } from "@synara/contracts";
import { useState } from "react";

import { selectThreadGuestShare, useGuestShareStore } from "~/guestShareStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMs } from "~/hooks/useNowMs";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { ensureGuestShareApi } from "~/nativeApi";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { StatusDot } from "../../ui/status-chip";
import { toastManager } from "../../ui/toast";
import {
  describeGuestShareError,
  formatGuestShareRemaining,
  GUEST_SHARE_INDICATOR_DOT_CLASS_NAME,
  resolveGuestShareIndicatorTone,
  resolveGuestSharePhase,
} from "./guestShare.logic";

/** The expiry line and the status dot only need to move once a minute. */
const STATUS_TICK_MS = 60_000;

export interface GuestShareDialogProps {
  threadId: ThreadId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens Moss account sign-in; links are issued only to signed-in owners. */
  onSignIn: () => void;
}

export function GuestShareDialog({
  threadId,
  open,
  onOpenChange,
  onSignIn,
}: GuestShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        {/* Request state lives below DialogPopup, which unmounts its children after the
            close transition, so every open starts idle. */}
        <GuestShareDialogContent
          threadId={threadId}
          onClose={() => onOpenChange(false)}
          onSignIn={onSignIn}
        />
      </DialogPopup>
    </Dialog>
  );
}

type RequestState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "closing" }
  | { status: "failed"; code: GuestShareOwnerErrorCode | null; message: string };

function GuestShareDialogContent({
  threadId,
  onClose,
  onSignIn,
}: {
  threadId: ThreadId;
  onClose: () => void;
  onSignIn: () => void;
}) {
  const { t } = useTranslation();
  const share = useGuestShareStore(selectThreadGuestShare(threadId));
  const nowMs = useNowMs(share !== null, STATUS_TICK_MS);
  const [request, setRequest] = useState<RequestState>({ status: "idle" });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: () => toastManager.add({ type: "error", title: t("chat.guestShare.copyFailed") }),
  });

  const phase = share === null ? null : resolveGuestSharePhase(share, nowMs);
  const liveShare = share !== null && phase !== "expired" ? share : null;
  const busy = request.status === "creating" || request.status === "closing";

  const run = async (status: "creating" | "closing", action: () => Promise<void>) => {
    setRequest({ status });
    try {
      await action();
      setRequest({ status: "idle" });
    } catch (error) {
      setRequest({ status: "failed", ...describeGuestShareError(error, t) });
    }
  };
  const createLink = () =>
    run("creating", async () => {
      const result = await ensureGuestShareApi().create({ threadId });
      // Show the link at once; the stream's upsert carries the same share a moment later.
      useGuestShareStore.getState().applyEvent({ type: "upsert", share: result.share });
    });
  const stopSharing = () =>
    run("closing", async () => {
      if (!liveShare) return;
      await ensureGuestShareApi().close({ threadId });
      useGuestShareStore.getState().applyEvent({ type: "remove", threadId, shareId: liveShare.id });
    });

  const inviteUrl = liveShare?.inviteUrl ?? null;
  const note =
    phase === "expired"
      ? t("chat.guestShare.status.expired")
      : liveShare
        ? t("chat.guestShare.newLinkReplaces")
        : t("chat.guestShare.linkOnce");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("chat.guestShare.title")}</DialogTitle>
        <DialogDescription>{t("chat.guestShare.description")}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-3">
        {liveShare ? <GuestShareStatus share={liveShare} nowMs={nowMs} /> : null}
        {inviteUrl ? (
          <div className="flex items-center gap-2">
            <Input
              readOnly
              size="sm"
              aria-label={t("chat.guestShare.linkLabel")}
              value={inviteUrl}
              className="min-w-0 flex-1"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => copyToClipboard(inviteUrl)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
              {isCopied ? t("chat.guestShare.copied") : t("chat.guestShare.copy")}
            </Button>
          </div>
        ) : null}
        <p className="text-ui-sm text-muted-foreground">{note}</p>
        {request.status === "failed" ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ui-sm text-destructive"
          >
            <span>{request.message}</span>
            {request.code === "guest_share.account_required" ? (
              <Button type="button" size="xs" variant="outline" onClick={onSignIn}>
                {t("chat.guestShare.signIn")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {liveShare ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void stopSharing()}
            >
              {request.status === "closing"
                ? t("chat.guestShare.stopping")
                : t("chat.guestShare.stopSharing")}
            </Button>
            {/* Once the guest has spent the link, a fresh one is the only way to invite again. */}
            {inviteUrl === null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void createLink()}
              >
                {request.status === "creating"
                  ? t("chat.guestShare.creating")
                  : t("chat.guestShare.newLink")}
              </Button>
            ) : null}
            <Button type="button" size="sm" disabled={busy} onClick={onClose}>
              {t("chat.guestShare.done")}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>
              {t("chat.guestShare.cancel")}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void createLink()}>
              {request.status === "creating"
                ? t("chat.guestShare.creating")
                : t("chat.guestShare.createLink")}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function GuestShareStatus({ share, nowMs }: { share: ThreadGuestShare; nowMs: number }) {
  const { format, locale, t } = useTranslation();
  const tone = resolveGuestShareIndicatorTone(share, nowMs);
  const joined = resolveGuestSharePhase(share, nowMs) === "joined";
  return (
    <div className="rounded-xl border border-border/70 px-3 py-2.5 text-ui-sm">
      <div className="flex items-center gap-2 font-medium text-foreground">
        {tone ? (
          <StatusDot
            className={GUEST_SHARE_INDICATOR_DOT_CLASS_NAME[tone]}
            pulse={share.relayStatus === "connecting"}
          />
        ) : null}
        <span className="min-w-0 truncate">
          {joined && share.guestName !== null
            ? format("chat.guestShare.status.joined", { name: share.guestName })
            : t("chat.guestShare.status.waiting")}
        </span>
      </div>
      <p className="mt-1 text-muted-foreground">
        {format("chat.guestShare.expiresIn", {
          duration: formatGuestShareRemaining(share.expiresAt, nowMs, locale),
        })}
        {" · "}
        {t(`chat.guestShare.relay.${share.relayStatus}`)}
      </p>
    </div>
  );
}
