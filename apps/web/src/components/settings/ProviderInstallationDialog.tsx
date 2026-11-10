// FILE: ProviderInstallationDialog.tsx
// Purpose: Makes agent locations and safe Moss-managed removal discoverable.
// Layer: Settings UI
// Exports: ProviderInstallationDialog

import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_INSTALLATION_ERROR_CODES,
  type ProviderKind,
  type ServerProviderInstallationResult,
} from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { type TranslationKey, useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const FAILURE_KEYS: Record<string, TranslationKey> = {
  [PROVIDER_INSTALLATION_ERROR_CODES.agentEnabled]:
    "settings.providers.installation.error.agentEnabled",
  [PROVIDER_INSTALLATION_ERROR_CODES.sessionsRunning]:
    "settings.providers.installation.error.sessionsRunning",
  [PROVIDER_INSTALLATION_ERROR_CODES.busy]: "settings.providers.installation.error.busy",
  [PROVIDER_INSTALLATION_ERROR_CODES.inUse]: "settings.providers.installation.error.inUse",
  [PROVIDER_INSTALLATION_ERROR_CODES.notFound]: "settings.providers.installation.error.notFound",
  [PROVIDER_INSTALLATION_ERROR_CODES.modified]: "settings.providers.installation.error.modified",
  [PROVIDER_INSTALLATION_ERROR_CODES.changesDisabled]:
    "settings.providers.installation.error.changesDisabled",
};

/** The plain-words reason for a refused installation change; unknown causes stay generic. */
export function providerInstallationFailureKey(cause: unknown): TranslationKey {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return (
    (typeof code === "string" ? FAILURE_KEYS[code] : undefined) ??
    "settings.providers.installation.failed"
  );
}

export function ProviderInstallationDialog(props: {
  readonly provider: ProviderKind;
  readonly enabled: boolean;
  readonly guideUrl: string;
  readonly onClose: () => void;
  readonly onDisable: () => Promise<void>;
  readonly onChanged: (result: ServerProviderInstallationResult) => Promise<void>;
}) {
  const { t, format } = useTranslation();
  const [installation, setInstallation] = useState<ServerProviderInstallationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<TranslationKey | null>(null);
  const [confirm, setConfirm] = useState(false);
  const busyRef = useRef(false);
  const inspect = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(null);
    try {
      const manage = ensureNativeApi().server.manageProviderInstallation;
      if (!manage) throw new Error("Installation management is unavailable.");
      setInstallation(await manage({ provider: props.provider, action: "inspect" }));
    } catch (cause) {
      setFailed(providerInstallationFailureKey(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [props.provider]);
  useEffect(() => {
    void inspect();
  }, [inspect]);
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(null);
    try {
      await action();
    } catch (cause) {
      setFailed(providerInstallationFailureKey(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {format("settings.providers.installation.title", {
              provider: PROVIDER_DISPLAY_NAMES[props.provider],
            })}
          </DialogTitle>
          <DialogDescription>{t("settings.providers.installation.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-4 py-3 text-ui">
          {installation ? (
            <>
              <p>{t(`settings.providers.installation.source.${installation.source}`)}</p>
              {installation.path || installation.managedPath ? (
                // The folder opens in the system file manager; the path itself is not shown.
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        ensureNativeApi().shell.showInFolder(
                          installation.managedPath ?? installation.path!,
                        ),
                      )
                    }
                  >
                    {t("settings.providers.installation.reveal")}
                  </Button>
                </div>
              ) : null}
              {installation.removed ? (
                <p role="status">{t("settings.providers.installation.removed")}</p>
              ) : null}
              {installation.canUninstall ? (
                <p className="text-ui-sm text-muted-foreground">
                  {t(
                    props.enabled
                      ? "settings.providers.installation.disableFirst"
                      : "settings.providers.installation.preserve",
                  )}
                </p>
              ) : null}
              {confirm ? <p role="status">{t("settings.providers.installation.confirm")}</p> : null}
            </>
          ) : !failed ? (
            <p role="status">{t("settings.providers.installation.loading")}</p>
          ) : null}
          {failed ? (
            <div role="alert" className="space-y-2 text-ui-sm text-destructive">
              <p>{t(failed)}</p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void inspect()}>
                {t("provider.install.retry")}
              </Button>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            {t("dialog.close")}
          </Button>
          {installation?.canUninstall ? (
            props.enabled ? (
              <Button variant="outline" disabled={busy} onClick={() => void run(props.onDisable)}>
                {t("settings.providers.installation.disable")}
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (!confirm) {
                    setConfirm(true);
                    return;
                  }
                  void run(async () => {
                    const result = await ensureNativeApi().server.manageProviderInstallation!({
                      provider: props.provider,
                      action: "uninstall",
                    });
                    setInstallation(result);
                    setConfirm(false);
                    await props.onChanged(result);
                  });
                }}
              >
                {t(
                  busy
                    ? "settings.providers.installation.removing"
                    : confirm
                      ? "settings.providers.installation.confirmButton"
                      : "settings.providers.installation.uninstall",
                )}
              </Button>
            )
          ) : installation?.source === "external" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => ensureNativeApi().shell.openExternal(props.guideUrl))}
            >
              {t("settings.providers.setupGuide")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
