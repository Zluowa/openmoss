// FILE: AccountSignInRequestHost.tsx
// Purpose: Mounts the one app-wide confirmation for phones that ask for this computer through
//   the Moss account, whatever page is open, and points the system notification at it when
//   the Moss window is not in front.
// Layer: Auth UI host
// Exports: AccountSignInRequestHost
// Depends on: nativeApi accountSignIn (`auth.accountSignIn.*`), desktop notifications
//
// Only the Moss desktop window subscribes: the server admits nothing but the local owner,
// and a phone or browser elsewhere has no confirmation to show.
import type { AuthAccountPendingRequests } from "@moss/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "~/localization";
import { ensureAccountSignInApi, isNativeApiDetached } from "~/nativeApi";
import { toastManager } from "../ui/toast";
import { AccountSignInRequestDialog } from "./AccountSignInRequestDialog";
import {
  freshAccountSignInRequestIds,
  lapsedAccountSignInRequest,
  shouldNotifyAccountSignIn,
  waitingAccountSignInRequests,
} from "./accountSignInRequestModel";

const EMPTY: AuthAccountPendingRequests = { requests: [] };

function isDesktopWindow(): boolean {
  return typeof window !== "undefined" && Boolean(window.desktopBridge) && !isNativeApiDetached();
}

export function AccountSignInRequestHost() {
  const { t } = useTranslation();
  const [enabled] = useState(isDesktopWindow);
  const [snapshot, setSnapshot] = useState<AuthAccountPendingRequests>(EMPTY);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failedRequestId, setFailedRequestId] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const decidedHere = useRef(new Set<string>());
  const shown = useRef<{ readonly requestId: string; readonly expiresAtMs: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return ensureAccountSignInApi().onRequests((next) => {
      setNowMs(Date.now());
      setSnapshot(next);
    });
  }, [enabled]);

  const hasRequests = snapshot.requests.length > 0;
  useEffect(() => {
    if (!hasRequests) return;
    // The countdown, and closing the dialog once a request lapses.
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRequests]);

  const waiting = useMemo(() => waitingAccountSignInRequests(snapshot, nowMs), [snapshot, nowMs]);

  useEffect(() => {
    const fresh = freshAccountSignInRequestIds(seen.current, waiting);
    if (!shouldNotifyAccountSignIn(fresh, document.hasFocus())) return;
    void window.desktopBridge?.notifications
      .show({
        title: t("auth.accountSignIn.notification.title"),
        body: t("auth.accountSignIn.notification.body"),
        suppressWhenForeground: true,
      })
      .catch(() => false);
  }, [waiting, t]);

  useEffect(() => {
    // The request on screen ran out unanswered: the dialog closes, and one line says why.
    if (
      lapsedAccountSignInRequest({
        shown: shown.current,
        waiting,
        decidedHere: decidedHere.current,
        nowMs,
      })
    ) {
      toastManager.add({ type: "info", title: t("auth.accountSignIn.expired") });
    }
    const next = waiting[0] ?? null;
    shown.current = next ? { requestId: next.requestId, expiresAtMs: next.expiresAtMs } : null;
  }, [waiting, nowMs, t]);

  const decide = useCallback((operation: "approve" | "deny", requestId: string) => {
    decidedHere.current.add(requestId);
    setBusy(true);
    setFailedRequestId(null);
    void ensureAccountSignInApi()
      [operation]({ requestId })
      .catch(() => setFailedRequestId(requestId))
      .finally(() => setBusy(false));
  }, []);

  if (!enabled) return null;
  const current = waiting[0] ?? null;
  return (
    <AccountSignInRequestDialog
      request={current}
      othersWaiting={Math.max(0, waiting.length - 1)}
      nowMs={nowMs}
      busy={busy}
      failed={current !== null && failedRequestId === current.requestId}
      onAllow={(requestId) => decide("approve", requestId)}
      onDeny={(requestId) => decide("deny", requestId)}
    />
  );
}
