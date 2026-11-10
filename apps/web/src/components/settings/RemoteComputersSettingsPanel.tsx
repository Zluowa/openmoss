// FILE: RemoteComputersSettingsPanel.tsx
// Purpose: Explicit pairing and isolated remote workspaces using the desktop-owned bridge.
// Layer: Connection settings UI
import type { RemoteComputerConnection, RemoteComputerState } from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "~/components/ui/alert-dialog";
import { DeviceLaptopIcon, Loader2Icon, TrashCanIcon } from "~/lib/icons";
import { useTranslation, type TranslationKey } from "~/localization";
import { LARGE_DIALOG_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { SettingsCard } from "./SettingsPanelPrimitives";
import {
  normalizeRemoteComputerOrigin,
  pairingExpiryLabel,
  REMOTE_COMPUTER_STATUS_KEYS,
  remoteComputerErrorKey,
} from "./remoteComputerSettingsModel";

interface PairDraft {
  readonly id: string;
  readonly previousId?: string;
  readonly displayName: string;
  readonly origin: string;
  readonly credential: string;
}

export function RemoteComputersSettingsPanel({ active }: { readonly active: boolean }) {
  const { t, format, locale } = useTranslation();
  const api = window.desktopBridge?.remoteComputers;
  const [states, setStates] = useState<ReadonlyArray<RemoteComputerState>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [draft, setDraft] = useState<PairDraft | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<TranslationKey | null>(null);
  const [removing, setRemoving] = useState<RemoteComputerConnection | null>(null);
  const [removingPending, setRemovingPending] = useState(false);
  const [removeError, setRemoveError] = useState<TranslationKey | null>(null);
  const mounted = useRef(false),
    sequence = useRef(0),
    pairVersion = useRef(0);
  const pendingPairId = useRef<string | null>(null);
  const operationVersions = useRef(new Map<string, number>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pairVersion.current++;
      if (pendingPairId.current)
        void api?.cancelPairing(pendingPairId.current).catch(() => undefined);
    };
  }, [api]);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const next = await api.list();
      if (mounted.current && request === sequence.current) {
        setStates(next);
        setLoadError(false);
      }
    } catch {
      if (mounted.current && request === sequence.current) setLoadError(true);
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, [api]);
  const cancelPair = useCallback(() => {
    pairVersion.current++;
    const id = pendingPairId.current;
    pendingPairId.current = null;
    setDraft(null); // Remove the password draft on every cancel/navigation path.
    setPairing(false);
    setPairError(null);
    if (id)
      void api?.cancelPairing(id).catch(() => {
        if (mounted.current) setError("settings.connections.remote.error.cancelled");
      });
  }, [api]);
  useEffect(() => {
    if (!active) {
      cancelPair();
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [active, refresh, cancelPair]);
  const openPair = (connection?: RemoteComputerConnection) => {
    setPairError(null);
    setNotice(null);
    setDraft({
      id: crypto.randomUUID(),
      ...(connection ? { previousId: connection.id } : {}),
      displayName: connection?.displayName ?? "",
      origin: connection?.origin ?? "",
      credential: "",
    });
  };
  const pair = async () => {
    if (!api || !draft || pairing) return;
    const origin = normalizeRemoteComputerOrigin(draft.origin);
    if (!origin) {
      setPairError("settings.connections.remote.error.address");
      return;
    }
    if (!draft.displayName.trim() || !draft.credential.trim()) {
      setPairError("settings.connections.remote.error.fields");
      return;
    }
    const version = ++pairVersion.current;
    const current = draft;
    setPairing(true);
    setPairError(null);
    pendingPairId.current = current.id;
    try {
      await api.pair({
        id: current.id,
        displayName: current.displayName.trim(),
        origin,
        credential: current.credential.trim(),
      });
      if (!mounted.current || version !== pairVersion.current) {
        // Main may have persisted the new record just before cancellation reached it.
        // A late reply belongs only to this new UUID, never to the previous pairing.
        try {
          const cleanup = await api.remove(current.id);
          if (mounted.current) {
            if (!cleanup.revoked) setNotice("settings.connections.remote.removedOffline");
            await refresh();
          }
        } catch {
          if (mounted.current) setError("settings.connections.remote.error.cancelCleanup");
          else
            toastManager.add({
              type: "error",
              title: t("settings.connections.remote.error.cancelCleanup"),
            });
        }
        return;
      }
      pendingPairId.current = null;
      setDraft(null); // Main owns the long-lived secret; never retain it in renderer state.
      setNotice("settings.connections.remote.paired");
      if (current.previousId) {
        try {
          await api.remove(current.previousId);
        } catch {
          setError("settings.connections.remote.error.oldConnection");
        }
      }
      await refresh();
    } catch (cause) {
      if (mounted.current && version === pairVersion.current)
        setPairError(remoteComputerErrorKey(cause));
    } finally {
      if (mounted.current && version === pairVersion.current) {
        pendingPairId.current = null;
        setPairing(false);
      }
    }
  };
  const replace = (state: RemoteComputerState) =>
    setStates((items) =>
      items.map((item) => (item.connection.id === state.connection.id ? state : item)),
    );
  const connect = async (connection: RemoteComputerConnection) => {
    if (!api) return;
    const version = (operationVersions.current.get(connection.id) ?? 0) + 1;
    operationVersions.current.set(connection.id, version);
    setError(null);
    setNotice(null);
    replace({ connection, status: "connecting" });
    try {
      const next = await api.connect(connection.id);
      if (mounted.current && operationVersions.current.get(connection.id) === version)
        replace(next);
    } catch (cause) {
      if (mounted.current && operationVersions.current.get(connection.id) === version)
        setError(remoteComputerErrorKey(cause));
    } finally {
      if (mounted.current) await refresh();
    }
  };
  const disconnect = async (id: string) => {
    if (!api) return;
    operationVersions.current.set(id, (operationVersions.current.get(id) ?? 0) + 1);
    try {
      await api.disconnect(id);
      await refresh();
    } catch (cause) {
      setError(remoteComputerErrorKey(cause));
    }
  };
  const remove = async () => {
    if (!api || !removing || removingPending) return;
    setRemovingPending(true);
    setRemoveError(null);
    try {
      const result = await api.remove(removing.id);
      setRemoving(null);
      setNotice(
        result.revoked
          ? "settings.connections.remote.removed"
          : "settings.connections.remote.removedOffline",
      );
      await refresh();
    } catch (cause) {
      setRemoveError(remoteComputerErrorKey(cause));
    } finally {
      setRemovingPending(false);
    }
  };
  if (!active) return null;
  return (
    <div
      role="tabpanel"
      aria-label={t("settings.connections.tabs.devices")}
      className="space-y-5"
      data-testid="remote-computers-settings"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-ui-lg font-semibold">{t("settings.connections.remote.title")}</h2>
        <Button size="sm" className="rounded-full" disabled={!api} onClick={() => openPair()}>
          {t("settings.connections.remote.add")}
        </Button>
      </div>
      <p className="text-ui text-muted-foreground">
        {t(
          api
            ? "settings.connections.remote.description"
            : "settings.connections.remote.desktopOnly",
        )}
      </p>
      {notice ? (
        <p role="status" className="text-ui text-muted-foreground">
          {t(notice)}
        </p>
      ) : null}
      {error || loadError ? (
        <div role="alert" className="flex items-center gap-3 text-ui text-destructive">
          <span>{t(error ?? "settings.connections.remote.error.load")}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              void refresh();
            }}
          >
            {t("settings.ssh.refresh")}
          </Button>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="text-ui text-muted-foreground">
          {t("settings.ssh.loading")}
        </p>
      ) : states.length ? (
        <SettingsCard>
          {states.map((state) => (
            <div
              key={state.connection.id}
              className="flex min-h-20 items-center gap-4 px-5 py-4"
              data-remote-computer={state.connection.id}
            >
              <DeviceLaptopIcon className="size-ui-icon shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui-lg font-semibold">{state.connection.displayName}</p>
                <p className="truncate text-ui text-muted-foreground">{state.connection.origin}</p>
                <p role="status" className="mt-1 text-ui-sm text-muted-foreground">
                  {t(REMOTE_COMPUTER_STATUS_KEYS[state.status])}
                </p>
                {state.errorCode ? (
                  <p className="mt-1 text-ui-sm text-destructive">
                    {t(remoteComputerErrorKey(state.errorCode))}
                  </p>
                ) : null}
                {state.status === "needs-pairing" ? (
                  <p className="text-ui-sm text-muted-foreground">
                    {format("settings.connections.remote.expiry", {
                      time:
                        pairingExpiryLabel(state.connection.expiresAt, locale) ??
                        state.connection.expiresAt,
                    })}
                  </p>
                ) : null}
              </div>
              {state.status === "needs-pairing" ? (
                <Button size="sm" onClick={() => openPair(state.connection)}>
                  {t("settings.connections.remote.pairAgain")}
                </Button>
              ) : state.status === "connecting" || state.status === "connected" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void disconnect(state.connection.id)}
                >
                  {t(
                    state.status === "connecting"
                      ? "settings.connections.remote.cancelConnect"
                      : "settings.ssh.disconnect",
                  )}
                </Button>
              ) : (
                <Button size="sm" onClick={() => void connect(state.connection)}>
                  {t("settings.ssh.connect")}
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={format("settings.connections.remote.removeAria", {
                  name: state.connection.displayName,
                })}
                onClick={() => {
                  setRemoveError(null);
                  setRemoving(state.connection);
                }}
              >
                <TrashCanIcon className="size-ui-icon-sm" />
              </Button>
            </div>
          ))}
        </SettingsCard>
      ) : (
        <SettingsCard>
          <div className="flex min-h-44 flex-col items-center justify-center gap-4 p-7 text-center">
            <DeviceLaptopIcon className="size-ui-icon-lg text-muted-foreground" />
            <p className="text-ui text-muted-foreground">
              {t("settings.connections.remote.empty")}
            </p>
          </div>
        </SettingsCard>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) cancelPair();
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle className={LARGE_DIALOG_TITLE_CLASS_NAME}>
              {t(
                draft?.previousId
                  ? "settings.connections.remote.pairAgain"
                  : "settings.connections.remote.add",
              )}
            </DialogTitle>
            <DialogDescription>{t("settings.connections.remote.consent")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void pair();
            }}
            noValidate
            className="contents"
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {draft?.previousId ? (
                <p className="text-ui text-muted-foreground">
                  {t("settings.connections.remote.repairDescription")}
                </p>
              ) : null}
              <label className="block space-y-2 text-ui font-medium">
                <span>{t("settings.ssh.name")}</span>
                <Input
                  autoFocus
                  maxLength={100}
                  disabled={pairing}
                  value={draft?.displayName ?? ""}
                  onChange={(event) =>
                    setDraft(
                      (current) => current && { ...current, displayName: event.target.value },
                    )
                  }
                />
              </label>
              <label className="block space-y-2 text-ui font-medium">
                <span>{t("settings.connections.remote.origin")}</span>
                <Input
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={2048}
                  disabled={pairing}
                  placeholder="https://moss.example.com"
                  value={draft?.origin ?? ""}
                  onChange={(event) =>
                    setDraft((current) => current && { ...current, origin: event.target.value })
                  }
                />
              </label>
              <label className="block space-y-2 text-ui font-medium">
                <span>{t("settings.connections.remote.credential")}</span>
                <Input
                  type="password"
                  autoComplete="off"
                  maxLength={4096}
                  disabled={pairing}
                  value={draft?.credential ?? ""}
                  onChange={(event) =>
                    setDraft((current) => current && { ...current, credential: event.target.value })
                  }
                />
              </label>
              <p className="text-ui-sm text-muted-foreground">
                {t("settings.connections.remote.addressHint")}
              </p>
              {pairError ? (
                <p role="alert" className="text-ui text-destructive">
                  {t(pairError)}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={cancelPair}>
                {t("settings.ssh.cancel")}
              </Button>
              <Button type="submit" disabled={pairing}>
                {pairing ? <Loader2Icon className="size-ui-icon-sm animate-spin" /> : null}
                {t(
                  pairing
                    ? "settings.connections.remote.pairing"
                    : "settings.connections.remote.pair",
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !removingPending) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.connections.remote.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {format("settings.connections.remote.removeDescription", {
                name: removing?.displayName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? (
            <p role="alert" className="px-5 text-ui text-destructive">
              {t(removeError)}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={removingPending} />}>
              {t("settings.ssh.cancel")}
            </AlertDialogClose>
            <Button variant="destructive" disabled={removingPending} onClick={() => void remove()}>
              {t("settings.connections.remote.remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
