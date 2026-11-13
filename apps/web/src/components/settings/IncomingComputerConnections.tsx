// FILE: IncomingComputerConnections.tsx
// Purpose: Owner-controlled one-time pairing codes and revocable client access.
// Layer: Connection settings UI
import type { AuthClientSession, AuthPairingLink, NativeApi } from "@moss/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "~/components/ui/alert-dialog";
import { CopyIcon, EyeIcon, RefreshCwIcon, TrashCanIcon } from "~/lib/icons";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsCard } from "./SettingsPanelPrimitives";
import { pairingExpiryLabel } from "./remoteComputerSettingsModel";
import { isPhonePairingLink } from "./phonePairingModel";

type RevokeTarget =
  | { readonly kind: "code"; readonly id: string; readonly label: string }
  | {
      readonly kind: "client";
      readonly id: AuthClientSession["sessionId"];
      readonly label: string;
    };
export function IncomingComputerConnections({ active }: { readonly active: boolean }) {
  const { t, format, locale } = useTranslation();
  const [owner, setOwner] = useState(false),
    [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState<string | undefined>();
  const [links, setLinks] = useState<ReadonlyArray<AuthPairingLink>>([]);
  const [clients, setClients] = useState<ReadonlyArray<AuthClientSession>>([]);
  const [loadError, setLoadError] = useState(false),
    [actionError, setActionError] = useState(false);
  const [creating, setCreating] = useState(false),
    [copied, setCopied] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [revoking, setRevoking] = useState<RevokeTarget | null>(null);
  const [revokePending, setRevokePending] = useState(false),
    [revokeError, setRevokeError] = useState(false);
  const mounted = useRef(false),
    activeRef = useRef(active),
    sequence = useRef(0),
    createVersion = useRef(0);
  activeRef.current = active;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      createVersion.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const api = ensureNativeApi().server;
      const session = await api.getAuthSession();
      if (!mounted.current || !activeRef.current || request !== sequence.current) return;
      const isOwner = session.authenticated && session.role === "owner";
      setOwner(isOwner);
      if (!isOwner) {
        setLinks([]);
        setClients([]);
        setOrigin(undefined);
        setLoadError(false);
        return;
      }
      const [config, nextLinks, nextClients] = await Promise.all([
        api.getConfig(),
        api.listAuthPairingLinks(),
        api.listAuthClients(),
      ]);
      if (!mounted.current || !activeRef.current || request !== sequence.current) return;
      setOrigin(config.shareableOrigin);
      // Phone codes have their own tab; this list is for other computers.
      setLinks(nextLinks.filter((link) => !isPhonePairingLink(link)));
      setClients(nextClients.filter((client) => client.role === "client" && !client.current));
      setLoadError(false);
      return nextLinks;
    } catch {
      if (mounted.current && activeRef.current && request === sequence.current) setLoadError(true);
    } finally {
      if (mounted.current && activeRef.current && request === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!active) {
      sequence.current++;
      createVersion.current++;
      setLinks([]);
      setClients([]);
      setRevealed(new Set());
      setCopied(null);
      setCreating(false);
      setRevoking(null);
      setOrigin(undefined);
      setOwner(false);
      return;
    }
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  const revokeUnshownCode = async (api: NativeApi["server"], id: string) => {
    try {
      await api.revokeAuthPairingLink({ id });
    } catch {
      if (mounted.current && activeRef.current) setActionError(true);
      else
        toastManager.add({ type: "error", title: t("settings.connections.incoming.cleanupError") });
    }
  };
  const create = async () => {
    if (!owner || creating) return;
    const version = ++createVersion.current;
    setCreating(true);
    setActionError(false);
    try {
      const api = ensureNativeApi().server;
      const result = await api.createAuthPairingToken({
        label: t("settings.connections.incoming.codeLabel"),
      });
      if (!mounted.current || !activeRef.current || version !== createVersion.current) {
        // A code created after leaving the page must not become an orphaned grant.
        await revokeUnshownCode(api, result.id);
        return;
      }
      const visibleLinks = await refresh();
      if (
        !mounted.current ||
        !activeRef.current ||
        version !== createVersion.current ||
        !visibleLinks?.some((link) => link.id === result.id)
      ) {
        await revokeUnshownCode(api, result.id);
        if (mounted.current && activeRef.current && version === createVersion.current)
          setActionError(true);
      }
    } catch {
      if (mounted.current && activeRef.current && version === createVersion.current)
        setActionError(true);
    } finally {
      if (mounted.current && activeRef.current && version === createVersion.current)
        setCreating(false);
    }
  };
  const copy = async (id: string, value: string) => {
    try {
      await copyTextToClipboard(value);
      if (mounted.current) setCopied(id);
    } catch {
      if (mounted.current) setActionError(true);
    }
  };
  const revoke = async () => {
    if (!revoking || revokePending) return;
    setRevokePending(true);
    setRevokeError(false);
    try {
      const api = ensureNativeApi().server;
      if (revoking.kind === "code") await api.revokeAuthPairingLink({ id: revoking.id });
      else await api.revokeAuthClient({ sessionId: revoking.id });
      setRevoking(null);
      setCopied(null);
      await refresh();
    } catch {
      setRevokeError(true);
    } finally {
      setRevokePending(false);
    }
  };
  const requestRevoke = (target: RevokeTarget) => {
    setRevokeError(false);
    setRevoking(target);
  };
  if (!active) return null;
  return (
    <section className="space-y-4" data-testid="incoming-computer-connections">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-ui-lg font-semibold">{t("settings.connections.incoming.title")}</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("settings.connections.incoming.refresh")}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-ui-icon-sm" />
        </Button>
      </div>
      <p className="text-ui text-muted-foreground">
        {t("settings.connections.incoming.description")}
      </p>
      {loading ? (
        <p role="status" className="text-ui text-muted-foreground">
          {t("settings.ssh.loading")}
        </p>
      ) : null}
      {loadError || actionError ? (
        <p role="alert" className="text-ui text-destructive">
          {t("settings.connections.incoming.error")}
        </p>
      ) : null}
      {!loading && !owner ? (
        <p className="text-ui text-muted-foreground">
          {t("settings.connections.incoming.ownerOnly")}
        </p>
      ) : null}
      {owner ? (
        <>
          <SettingsCard>
            <div className="space-y-3 px-5 py-4">
              {origin ? (
                <>
                  <p className="text-ui font-medium">{t("settings.connections.remote.origin")}</p>
                  <div className="flex items-center gap-3">
                    <Input
                      readOnly
                      aria-label={t("settings.connections.incoming.address")}
                      value={origin}
                    />
                    <Button size="sm" variant="outline" onClick={() => void copy("origin", origin)}>
                      {t(
                        copied === "origin"
                          ? "settings.connections.incoming.copied"
                          : "settings.connections.incoming.copyAddress",
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-ui text-muted-foreground">
                  {t("settings.connections.incoming.localOnly")}
                </p>
              )}
              <p className="text-ui-sm text-muted-foreground">
                {t("settings.connections.incoming.codeWarning")}
              </p>
              <Button size="sm" disabled={creating} onClick={() => void create()}>
                {t(
                  creating
                    ? "settings.connections.incoming.creating"
                    : "settings.connections.incoming.create",
                )}
              </Button>
            </div>
          </SettingsCard>
          {links.length ? (
            <SettingsCard>
              {links.map((link) => (
                <div className="space-y-2 px-5 py-4" key={link.id} data-pairing-link={link.id}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-ui font-medium">
                      {link.label ?? t("settings.connections.incoming.codeLabel")}
                    </p>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("settings.connections.incoming.revokeCode")}
                      onClick={() =>
                        requestRevoke({
                          kind: "code",
                          id: link.id,
                          label: link.label ?? t("settings.connections.incoming.codeLabel"),
                        })
                      }
                    >
                      <TrashCanIcon className="size-ui-icon-sm" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      type={revealed.has(link.id) ? "text" : "password"}
                      autoComplete="off"
                      aria-label={t("settings.connections.remote.credential")}
                      value={link.credential}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t(
                        revealed.has(link.id)
                          ? "settings.connections.incoming.hideCode"
                          : "settings.connections.incoming.showCode",
                      )}
                      aria-pressed={revealed.has(link.id)}
                      onClick={() =>
                        setRevealed((current) => {
                          const next = new Set(current);
                          if (next.has(link.id)) next.delete(link.id);
                          else next.add(link.id);
                          return next;
                        })
                      }
                    >
                      <EyeIcon className="size-ui-icon-sm" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void copy(link.id, link.credential)}
                    >
                      <CopyIcon className="size-ui-icon-sm" />
                      {t(
                        copied === link.id
                          ? "settings.connections.incoming.copied"
                          : "settings.connections.incoming.copyCode",
                      )}
                    </Button>
                  </div>
                  <p className="text-ui-sm text-muted-foreground">
                    {format("settings.connections.remote.expiry", {
                      time:
                        pairingExpiryLabel(link.expiresAt, locale) ??
                        t("settings.connections.incoming.unknownExpiry"),
                    })}
                  </p>
                </div>
              ))}
            </SettingsCard>
          ) : null}
          <h3 className="text-ui-lg font-semibold">{t("settings.connections.incoming.clients")}</h3>
          {clients.length ? (
            <SettingsCard>
              {clients.map((client) => {
                const label =
                  client.client.label ??
                  client.client.os ??
                  t("settings.connections.incoming.unnamedClient");
                return (
                  <div
                    className="flex items-center justify-between gap-4 px-5 py-4"
                    key={client.sessionId}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-ui font-medium">{label}</p>
                      <p className="text-ui-sm text-muted-foreground">
                        {t(
                          client.connected
                            ? "settings.connections.remote.connected"
                            : "settings.connections.remote.disconnected",
                        )}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => requestRevoke({ kind: "client", id: client.sessionId, label })}
                    >
                      {t("settings.connections.incoming.revokeClient")}
                    </Button>
                  </div>
                );
              })}
            </SettingsCard>
          ) : (
            <p className="text-ui text-muted-foreground">
              {t("settings.connections.incoming.noClients")}
            </p>
          )}
        </>
      ) : null}
      <AlertDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => {
          if (!open && !revokePending) setRevoking(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.connections.incoming.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {format(
                revoking?.kind === "client"
                  ? "settings.connections.incoming.revokeClientDescription"
                  : "settings.connections.incoming.revokeCodeDescription",
                { name: revoking?.label ?? "" },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError ? (
            <p role="alert" className="px-5 text-ui text-destructive">
              {t("settings.connections.incoming.error")}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={revokePending} />}>
              {t("settings.ssh.cancel")}
            </AlertDialogClose>
            <Button variant="destructive" disabled={revokePending} onClick={() => void revoke()}>
              {t("settings.connections.incoming.revoke")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
