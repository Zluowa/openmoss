// FILE: AppConnectDialog.tsx
// Purpose: Native Codex-style connector disclosure and connection flow for an App.

import type {
  ProviderAppConnectorDetail,
  ProviderAppConnectorTerms,
  ProviderStartAppConnectionInput,
  ProviderStartAppConnectionResult,
} from "@synara/contracts";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "~/localization";
import {
  APP_CONNECTOR_OAUTH_CALLBACK_URL,
  buildAppManageUrl,
  resolveStartedAppConnection,
} from "~/lib/appToolsModel";
import { AppsIcon, CircleCheckIcon, ExternalLinkIcon, RefreshCwIcon } from "~/lib/icons";
import { OpenAI } from "./Icons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";

const CONNECTION_DETAIL_SKELETON_ROWS = ["first", "second", "third"] as const;

export interface AppConnectTarget {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly installUrl: string | null;
  readonly isAccessible: boolean;
  readonly logoUrl: string | null;
  readonly logoUrlDark: string | null;
}

export interface AppConnectionOpened {
  readonly appId: string;
  readonly redirectUrl: string | null;
}

type ConnectionStartInput = Pick<ProviderStartAppConnectionInput, "callbackUrl" | "postAuthUrl"> & {
  readonly reauthentication: null;
};

export interface AppConnectDialogProps {
  readonly app: AppConnectTarget | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly readConnector: (app: AppConnectTarget) => Promise<ProviderAppConnectorDetail>;
  readonly readTerms: (app: AppConnectTarget) => Promise<ProviderAppConnectorTerms>;
  readonly startConnection: (
    input: ConnectionStartInput,
  ) => Promise<ProviderStartAppConnectionResult>;
  readonly onOpenAppUrl: (url: string) => Promise<boolean>;
  readonly onConnected: () => Promise<void>;
  readonly onConnectionOpened?: ((connection: AppConnectionOpened) => void) | undefined;
}

export function AppConnectDialog({
  app,
  open,
  onOpenChange,
  readConnector,
  readTerms,
  startConnection,
  onOpenAppUrl,
  onConnected,
  onConnectionOpened,
}: AppConnectDialogProps) {
  const { format, t } = useTranslation();
  const [connector, setConnector] = useState<ProviderAppConnectorDetail | null>(null);
  const [terms, setTerms] = useState<ProviderAppConnectorTerms | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activationInFlightRef = useRef(false);

  useEffect(() => {
    if (!open || !app) return;
    let active = true;
    setConnector(null);
    setTerms(null);
    setError(null);
    setLoading(true);
    void Promise.all([readConnector(app), readTerms(app)])
      .then(([nextConnector, nextTerms]) => {
        if (!active) return;
        setConnector(nextConnector);
        setTerms(nextTerms);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [app, open, readConnector, readTerms]);

  useEffect(() => {
    if (open) return;
    activationInFlightRef.current = false;
    setStarting(false);
  }, [open]);

  if (!app) return null;
  const manageUrl = buildAppManageUrl(app, false);
  const browserFallbackUrl = buildAppManageUrl(app, true);
  const disabledByAdmin = connector?.status === "DISABLED_BY_ADMIN";
  const browserRequired =
    !loading &&
    (error !== null ||
      connector === null ||
      connector.requiresLinkParameters ||
      connector.authMode === "UNSUPPORTED");
  const blurbs =
    terms && terms.blurbs.length > 0
      ? terms.blurbs
      : [
          {
            title: t("settings.mcp.appConnectModal.permissionsTitle"),
            description: t("settings.mcp.appConnectModal.permissionsDescription"),
          },
          {
            title: t("settings.mcp.appConnectModal.dataTitle"),
            description: t("settings.mcp.appConnectModal.dataDescription"),
          },
          {
            title: t("settings.mcp.appConnectModal.riskTitle"),
            description: t("settings.mcp.appConnectModal.riskDescription"),
          },
        ];
  const appLogo = app.logoUrl ?? app.logoUrlDark;
  const connectorName = connector?.name ?? app.name;
  const approvedByAdmin = connector !== null && !disabledByAdmin;
  const connectionStatus = loading ? (
    <span className="flex items-center justify-center gap-2">
      <RefreshCwIcon className="size-4 animate-spin" />
      {t("settings.mcp.appConnectModal.loading")}
    </span>
  ) : error !== null ? (
    t("settings.mcp.appConnectModal.loadError")
  ) : connector?.requiresLinkParameters ? (
    t("settings.mcp.appConnectModal.linkParameters")
  ) : connector?.authMode === "UNSUPPORTED" ? (
    t("settings.mcp.appConnectModal.unsupportedAuth")
  ) : null;
  const buttonLabel = app.isAccessible
    ? t("settings.mcp.appConnectModal.manage")
    : disabledByAdmin
      ? t("settings.mcp.appConnectModal.disabledByAdmin")
      : browserRequired
        ? t("settings.mcp.appConnectModal.openBrowser")
        : connector?.authMode === "OAUTH"
          ? format("settings.mcp.appConnectModal.continue", { appName: app.name })
          : format("settings.mcp.appConnectModal.connect", { appName: app.name });

  const activate = async () => {
    if (loading || starting || disabledByAdmin || activationInFlightRef.current) return;
    activationInFlightRef.current = true;
    setStarting(true);
    try {
      if (app.isAccessible) {
        if (manageUrl && (await onOpenAppUrl(manageUrl))) onOpenChange(false);
        return;
      }
      if (browserRequired) {
        if (browserFallbackUrl && (await onOpenAppUrl(browserFallbackUrl))) {
          onConnectionOpened?.({ appId: app.id, redirectUrl: null });
          onOpenChange(false);
        }
        return;
      }
      if (!manageUrl) return;
      const result = await startConnection({
        callbackUrl: APP_CONNECTOR_OAUTH_CALLBACK_URL,
        postAuthUrl: manageUrl,
        reauthentication: null,
      });
      const resolution = await resolveStartedAppConnection({
        result,
        browserFallbackUrl,
        openExternal: onOpenAppUrl,
        connected: onConnected,
      });
      if (resolution === "oauth-started" || resolution === "browser-fallback") {
        onConnectionOpened?.({
          appId: app.id,
          redirectUrl: result.kind === "oauthStarted" ? result.redirectUrl : null,
        });
      }
      if (resolution !== "failed") onOpenChange(false);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      activationInFlightRef.current = false;
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(720px,calc(100vh-2rem))] max-w-[480px] overflow-hidden"
        aria-describedby={undefined}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 pt-8 pb-6">
          <DialogHeader className="items-center gap-4 p-0 text-center">
            <div className="flex items-center gap-3">
              <span className="flex size-14 items-center justify-center rounded-xl bg-black text-white shadow-sm">
                <OpenAI className="size-12" />
              </span>
              <span className="flex items-center gap-2" aria-hidden="true">
                <span className="size-1.5 rounded-full bg-border" />
                <span className="size-1.5 rounded-full bg-border" />
                <span className="size-1.5 rounded-full bg-border" />
              </span>
              <span className="flex size-14 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted shadow-sm">
                {appLogo ? (
                  <img
                    src={appLogo}
                    alt={format("settings.mcp.appConnectModal.logoAlt", {
                      appName: app.name,
                    })}
                    className="size-full object-contain"
                  />
                ) : (
                  <AppsIcon className="size-5 text-muted-foreground" />
                )}
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <DialogTitle>
                {format("settings.mcp.appConnectModal.title", { appName: connectorName })}
              </DialogTitle>
            </div>
            {approvedByAdmin ? (
              <div className="flex items-center gap-2 text-base text-green-600">
                <CircleCheckIcon className="size-4 shrink-0" />
                {t("settings.mcp.appConnectModal.adminApproved")}
              </div>
            ) : null}
          </DialogHeader>
          <DialogPanel className="px-0 pt-0 pb-0">
            {loading ? (
              <div className="rounded-2xl border border-border px-4 py-2">
                {CONNECTION_DETAIL_SKELETON_ROWS.map((row) => (
                  <div
                    key={row}
                    className="flex flex-col gap-1 border-b border-border py-2.5 last:border-none"
                  >
                    <div className="h-3 w-36 rounded bg-border" />
                    <div className="h-2.5 w-full rounded bg-border" />
                    <div className="h-2.5 w-4/5 rounded bg-border" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-border px-4 py-2">
                {blurbs.map((blurb) => (
                  <div
                    key={`${blurb.title}\u0000${blurb.description}`}
                    className="border-b border-border py-2.5 last:border-none"
                  >
                    <div className="text-ui-lg font-medium text-foreground">{blurb.title}</div>
                    <div className="text-ui-sm text-muted-foreground">{blurb.description}</div>
                  </div>
                ))}
              </div>
            )}
            {connectionStatus ? (
              <div className="mt-4 text-center text-ui-lg text-muted-foreground">
                {connectionStatus}
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter className="flex-col p-0">
            <Button
              className="w-full justify-center"
              disabled={loading || starting || disabledByAdmin}
              onClick={() => void activate()}
            >
              {starting ? t("settings.mcp.appConnectModal.finishing") : buttonLabel}
              {(app.isAccessible || browserRequired) && !disabledByAdmin ? (
                <ExternalLinkIcon className="size-4" />
              ) : null}
            </Button>
            {browserRequired && !loading ? (
              <div className="text-center text-ui-sm text-muted-foreground">
                {t("settings.mcp.appConnectModal.browserHelper")}
              </div>
            ) : null}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
