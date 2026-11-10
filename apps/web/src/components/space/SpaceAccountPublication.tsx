import type { PageAccountRecoveryResult, PageSpaceId } from "@moss/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { MenuCheckboxItem, MenuItem } from "../ui/menu";
import { RecoveryAccountBoundary } from "./RecoveryAccountBoundary";

type Publication = Extract<PageAccountRecoveryResult, { kind: "publication" }>;

export function SpaceAccountPublication({ spaceId }: { spaceId: PageSpaceId }) {
  return (
    <RecoveryAccountBoundary>
      {(current) => <PublicationConsent spaceId={spaceId} current={current} />}
    </RecoveryAccountBoundary>
  );
}

function PublicationConsent({
  spaceId,
  current,
}: {
  spaceId: PageSpaceId;
  current: () => boolean;
}) {
  const { t, format, locale } = useTranslation();
  const alive = useRef(false);
  const operation = useRef(0);
  const writing = useRef(false);
  const [state, setState] = useState<Publication | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [failed, setFailed] = useState(false);
  const valid = (n: number) => alive.current && current() && n === operation.current;
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++operation.current;
    };
  }, []);
  useEffect(() => {
    const n = ++operation.current;
    setState(null);
    setConfirmOff(false);
    setFailed(false);
    if (!current()) return;
    void Promise.resolve()
      .then(() => ensureNativeApi().pages.accountRecovery({ op: "publication-status", spaceId }))
      .then((result) => {
        if (alive.current && current() && n === operation.current && result.kind === "publication")
          setState(result);
      })
      .catch(() => {});
  }, [current, spaceId]);
  async function write(enabled: boolean) {
    if (!state?.available || !current() || writing.current) return;
    const n = ++operation.current;
    writing.current = true;
    setBusy(true);
    setFailed(false);
    setConfirmOff(false);
    try {
      const result = await ensureNativeApi().pages.accountRecovery({
        op: "set-publication",
        spaceId,
        enabled,
        observation: state.observation,
      });
      if (!valid(n)) return;
      if (result.kind !== "publication" || !result.available || result.allowed !== enabled)
        throw new Error();
      setState(result);
    } catch {
      if (!valid(n)) return;
      setFailed(true);
      setState(null);
      try {
        const next = await ensureNativeApi().pages.accountRecovery({
          op: "publication-status",
          spaceId,
        });
        if (valid(n) && next.kind === "publication") setState(next);
      } catch {
        /* The failed status remains visible; a new menu opening can retry. */
      }
    } finally {
      writing.current = false;
      if (valid(n)) setBusy(false);
    }
  }
  if (!state?.available && !failed) return null;
  return (
    <>
      {state?.available && (
        <>
          <MenuCheckboxItem
            variant="switch"
            closeOnClick={false}
            checked={state.allowed}
            disabled={busy}
            onCheckedChange={(enabled) => {
              if (enabled) void write(true);
              else setConfirmOff(true);
            }}
          >
            {t("pageRecovery.keep")}
          </MenuCheckboxItem>
          {state.allowed && (
            <div role="status" className="px-2 pb-1 text-ui-xs text-muted-foreground">
              {state.confirmedCount > 0 && state.lastConfirmedAt
                ? format("pageRecovery.confirmedCount", {
                    count: state.confirmedCount,
                    time: new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(state.lastConfirmedAt)),
                  })
                : t("pageRecovery.awaiting")}
            </div>
          )}
          {confirmOff && (
            <>
              <p role="alert" className="px-2 py-1 text-ui-sm text-foreground">
                {t("pageRecovery.revokeWarning")}
              </p>
              <MenuItem closeOnClick={false} onClick={() => setConfirmOff(false)}>
                {t("pageRecovery.cancel")}
              </MenuItem>
              <MenuItem
                variant="destructive"
                closeOnClick={false}
                disabled={busy}
                onClick={() => void write(false)}
              >
                {t("pageRecovery.revoke")}
              </MenuItem>
            </>
          )}
        </>
      )}
      {failed && (
        <div role="alert" className="px-2 py-1 text-ui-sm text-destructive">
          {t("pageRecovery.publicationError")}
        </div>
      )}
    </>
  );
}
