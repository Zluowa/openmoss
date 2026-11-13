// FILE: PhoneSettingsPanel.tsx
// Purpose: Pair the owner's phone with this Moss by scanning one QR code, and revoke it later.
// Layer: Connection settings UI
//
// The phone runs the same Moss web app this server already serves, so every feature
// (chats, approvals, diffs, terminal, plugins) is there without a separate client. In
// the desktop app a switch makes Moss reachable from the phone; then the panel mints a
// one-time owner-device code, shows it as a QR for the phone camera, and lists the
// phones that have paired. Only the desktop app on this computer can mint a code (the
// server refuses everyone else), so anywhere else the panel says where to go instead.
// A code left on screen is withdrawn when the panel closes, so an owner-level grant
// never outlives the moment it was shown for.
import type { AuthClientSession, AuthPairingLink, NativeApi } from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { QrCode } from "~/components/ui/qr-code";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { CopyIcon, DeviceMobileIcon, RefreshCwIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { PhoneAccessCard } from "./PhoneAccessCard";
import { SettingsCard } from "./SettingsPanelPrimitives";
import {
  isPairedPhoneSession,
  isPlaintextOrigin,
  phoneOriginLabel,
  phonePairingOrigins,
  phonePairingUrl,
} from "./phonePairingModel";
import { pairingExpiryLabel } from "./remoteComputerSettingsModel";

const PHONE_REFRESH_MS = 4000;
// After the desktop restarts its background service the connection needs a moment.
const PHONE_RECONNECT_ATTEMPTS = 20;
const PHONE_RECONNECT_INTERVAL_MS = 750;

interface ShownCode {
  readonly id: string;
  readonly credential: string;
  readonly expiresAt: unknown;
  readonly phonesBefore: number;
}

export function PhoneSettingsPanel({ active }: { readonly active: boolean }) {
  const { t, format, locale } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [owner, setOwner] = useState(false);
  const [origins, setOrigins] = useState<ReadonlyArray<string>>([]);
  const [origin, setOrigin] = useState<string | null>(null);
  const [phones, setPhones] = useState<ReadonlyArray<AuthClientSession>>([]);
  const [shown, setShown] = useState<ShownCode | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const shownRef = useRef<ShownCode | null>(null);
  const sequence = useRef(0);
  // While the desktop restarts Moss, failed requests are expected, not an error.
  const restarting = useRef(false);
  const phoneAccess = typeof window === "undefined" ? undefined : window.desktopBridge?.phoneAccess;
  shownRef.current = shown;

  const refresh = useCallback(async (): Promise<boolean> => {
    const request = ++sequence.current;
    try {
      const api = ensureNativeApi().server;
      const session = await api.getAuthSession();
      if (request !== sequence.current) return false;
      const isOwner = session.authenticated && session.role === "owner";
      setOwner(isOwner);
      if (!isOwner) return true;
      const [config, links, clients] = await Promise.all([
        api.getConfig(),
        api.listAuthPairingLinks(),
        api.listAuthClients(),
      ]);
      if (request !== sequence.current) return false;
      const nextOrigins = phonePairingOrigins(config);
      const nextPhones = clients.filter(isPairedPhoneSession);
      setOrigins(nextOrigins);
      setOrigin((current) =>
        current && nextOrigins.includes(current) ? current : (nextOrigins[0] ?? null),
      );
      setPhones(nextPhones);
      setError(false);
      const current = shownRef.current;
      if (current && !links.some((link: AuthPairingLink) => link.id === current.id)) {
        // The phone redeemed the single-use code (or it expired): take it off screen.
        setShown(null);
        if (nextPhones.length > current.phonesBefore) {
          toastManager.add({ type: "success", title: t("settings.phone.paired") });
        }
      }
      return true;
    } catch {
      if (request === sequence.current && !restarting.current) setError(true);
      return false;
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [t]);

  const beginRestart = useCallback(() => {
    restarting.current = true;
    setError(false);
    setShown(null);
    // The addresses belong to the service that is going away.
    setOrigins([]);
  }, []);
  const finishRestart = useCallback(async () => {
    for (let attempt = 0; attempt < PHONE_RECONNECT_ATTEMPTS; attempt++) {
      if (await refresh()) break;
      await new Promise((resolve) => window.setTimeout(resolve, PHONE_RECONNECT_INTERVAL_MS));
    }
    restarting.current = false;
  }, [refresh]);

  // A refresh still in flight when the panel closes must not write into it.
  const invalidateRefresh = useCallback(() => {
    sequence.current++;
  }, []);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), PHONE_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      invalidateRefresh();
    };
  }, [active, refresh, invalidateRefresh]);

  // Never leave an owner-level code alive behind a closed panel.
  useEffect(() => {
    if (active) return;
    const current = shownRef.current;
    if (current) void withdraw(ensureNativeApi().server, current.id);
    setShown(null);
  }, [active]);
  useEffect(
    () => () => {
      const current = shownRef.current;
      if (current) void withdraw(ensureNativeApi().server, current.id);
    },
    [],
  );

  const create = async () => {
    if (!owner || creating) return;
    setCreating(true);
    setError(false);
    try {
      const api = ensureNativeApi().server;
      const previous = shownRef.current;
      if (previous) await withdraw(api, previous.id);
      const result = await api.createAuthPairingToken({
        label: t("settings.phone.codeLabel"),
        access: "ownerDevice",
      });
      setShown({
        id: result.id,
        credential: result.credential,
        expiresAt: result.expiresAt,
        phonesBefore: phones.length,
      });
    } catch {
      setError(true);
    } finally {
      setCreating(false);
    }
  };

  const cancel = async () => {
    const current = shownRef.current;
    setShown(null);
    if (current) await withdraw(ensureNativeApi().server, current.id);
  };

  const revokePhone = async (sessionId: AuthClientSession["sessionId"]) => {
    try {
      await ensureNativeApi().server.revokeAuthClient({ sessionId });
      await refresh();
    } catch {
      setError(true);
    }
  };

  const copy = async (key: string, value: string) => {
    try {
      await copyTextToClipboard(value);
      setCopied(key);
    } catch {
      setError(true);
    }
  };

  if (!active) return null;
  const link = shown && origin ? phonePairingUrl(origin, shown.credential) : null;
  return (
    <section className="space-y-4" data-testid="phone-settings">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-ui-lg font-medium">{t("settings.phone.title")}</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("settings.phone.refresh")}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-ui-icon-sm" />
        </Button>
      </div>
      <p className="text-ui text-muted-foreground">{t("settings.phone.description")}</p>
      {loading ? (
        <p role="status" className="text-ui text-muted-foreground">
          {t("settings.ssh.loading")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui text-destructive">
          {t("settings.phone.error")}
        </p>
      ) : null}
      {!loading && !owner ? (
        <p className="text-ui text-muted-foreground">{t("settings.phone.ownerOnly")}</p>
      ) : null}
      {owner && phoneAccess ? (
        <PhoneAccessCard
          bridge={phoneAccess}
          onRestarting={beginRestart}
          onRestarted={finishRestart}
        />
      ) : null}
      {owner && !loading && !phoneAccess ? (
        <SettingsCard>
          <div className="space-y-1 px-5 py-4" data-testid="phone-settings-local-only">
            <p className="text-ui font-medium">{t("settings.phone.localOnly.title")}</p>
            <p className="text-ui-sm text-muted-foreground">
              {t("settings.phone.localOnly.description")}
            </p>
          </div>
        </SettingsCard>
      ) : null}
      {owner && phoneAccess && origins.length > 0 ? (
        <SettingsCard>
          <div className="space-y-4 px-5 py-4">
            {origins.length > 1 ? (
              <div className="space-y-2">
                <p className="text-ui-sm text-muted-foreground">{t("settings.phone.address")}</p>
                <div className="flex flex-wrap gap-2" role="radiogroup">
                  {origins.map((candidate) => (
                    <Button
                      key={candidate}
                      type="button"
                      role="radio"
                      aria-checked={candidate === origin}
                      onClick={() => setOrigin(candidate)}
                      shape="capsule"
                      size="sm"
                      variant={candidate === origin ? "default" : "outline"}
                      className="font-mono"
                    >
                      {phoneOriginLabel(candidate)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
            {link && shown ? (
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                <QrCode
                  value={link}
                  size={196}
                  alt={t("settings.phone.qrAlt")}
                  failedLabel={t("settings.phone.qrFailed")}
                />
                <div className="w-full min-w-0 flex-1 space-y-2">
                  <ol className="list-decimal space-y-1 ps-5 text-ui-sm text-muted-foreground">
                    <li>{t("settings.phone.step.scan")}</li>
                    <li>{t("settings.phone.step.open")}</li>
                    <li>{t("settings.phone.step.install")}</li>
                  </ol>
                  <p className="text-ui-sm text-muted-foreground">
                    {format("settings.phone.expiry", {
                      time:
                        pairingExpiryLabel(shown.expiresAt, locale) ??
                        t("settings.connections.incoming.unknownExpiry"),
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void copy("link", link)}>
                      <CopyIcon className="size-ui-icon-sm" />
                      {t(copied === "link" ? "settings.phone.copied" : "settings.phone.copyLink")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void cancel()}>
                      {t("settings.phone.cancel")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <DeviceMobileIcon className="size-5 shrink-0 text-muted-foreground" />
                <p className="min-w-0 flex-1 text-ui-sm text-muted-foreground">
                  {t("settings.phone.codeWarning")}
                </p>
                <Button size="sm" disabled={creating} onClick={() => void create()}>
                  {t(creating ? "settings.phone.creating" : "settings.phone.create")}
                </Button>
              </div>
            )}
            {origin && isPlaintextOrigin(origin) ? (
              <p className="text-ui-sm text-muted-foreground">{t("settings.phone.plaintext")}</p>
            ) : null}
          </div>
        </SettingsCard>
      ) : null}
      {owner ? (
        <>
          <h3 className="text-ui-lg font-medium">{t("settings.phone.paired.title")}</h3>
          {phones.length ? (
            <SettingsCard>
              {phones.map((phone) => {
                const label =
                  phone.client.label ?? phone.client.os ?? t("settings.phone.unnamedPhone");
                const detail = [phone.client.os, phone.client.browser].filter(Boolean).join(" · ");
                return (
                  <div
                    className="flex items-center justify-between gap-4 px-5 py-4"
                    key={phone.sessionId}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-ui font-medium">{label}</p>
                      <p className="truncate text-ui-sm text-muted-foreground">
                        {[
                          t(
                            phone.connected
                              ? "settings.connections.remote.connected"
                              : "settings.connections.remote.disconnected",
                          ),
                          detail,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void revokePhone(phone.sessionId)}
                    >
                      {t("settings.connections.incoming.revokeClient")}
                    </Button>
                  </div>
                );
              })}
            </SettingsCard>
          ) : (
            <p className="text-ui text-muted-foreground">{t("settings.phone.paired.none")}</p>
          )}
        </>
      ) : null}
    </section>
  );
}

async function withdraw(api: NativeApi["server"], id: string): Promise<void> {
  try {
    await api.revokeAuthPairingLink({ id });
  } catch {
    // Already redeemed or expired; nothing left to withdraw.
  }
}
