// FILE: MossAppConnectDialog.tsx
// Purpose: Moss's own sign-in step for an app plugin. Rather than a backend's
//          hosted connect page, Moss explains the connection beside its own
//          mark and then, by how the app signs in: opens the app's consent page
//          and waits for the connection, asks for the user's own key or login
//          in a Moss form, or says the app needs an OAuth app set up first.
// Layer: Web dialog
// Exports: MossAppConnectDialog, MossAppConnectTarget

import type { MossAppSignIn } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { activeMossAppConnection } from "~/lib/mossAppsPlugins";
import {
  MOSS_APP_CONNECTIONS_QUERY_KEY,
  mossAppConnectFieldsQueryOptions,
  mossAppConnectionsQueryOptions,
} from "~/lib/mossAppsReactQuery";
import { PluginIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { MossLogo } from "./MossLogo";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle, dialogFieldLabelClassName } from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

export interface MossAppConnectTarget {
  readonly slug: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly signIn: MossAppSignIn;
}

type ConnectStage = "intro" | "waiting" | "failed";

/** A sign-in left open longer than this is treated as abandoned. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

function errorText(cause: unknown): string | null {
  return cause instanceof Error && cause.message.trim() ? cause.message : null;
}

function LogoTile({ children }: { readonly children: React.ReactNode }) {
  return (
    <span className="flex size-14 items-center justify-center overflow-hidden rounded-2xl bg-card shadow-xs ring-1 ring-border/70 ring-inset">
      {children}
    </span>
  );
}

function AppLogo({ target }: { readonly target: MossAppConnectTarget }) {
  const [failed, setFailed] = useState(false);
  if (!target.logoUrl || failed) {
    return <PluginIcon aria-hidden="true" className="size-7 text-muted-foreground" />;
  }
  return (
    <img
      src={target.logoUrl}
      alt=""
      className="size-9 object-contain"
      onError={() => setFailed(true)}
    />
  );
}

export function MossAppConnectDialog({
  target,
  onOpenChange,
  onConnected,
}: {
  readonly target: MossAppConnectTarget | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnected?: ((slug: string) => void) | undefined;
}) {
  const { format, t } = useTranslation();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<ConnectStage>("intro");
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const startedAt = useRef(0);
  const slug = target?.slug ?? null;
  const usesCredentials = target?.signIn === "credentials";
  const needsSetup = target?.signIn === "setup";

  useEffect(() => {
    setStage("intro");
    setSignInUrl(null);
    setFailure(null);
    setValues({});
  }, [slug]);

  const form = useQuery(
    mossAppConnectFieldsQueryOptions({ toolkitSlug: slug, enabled: usesCredentials }),
  );
  const waiting = target !== null && stage === "waiting";
  const connections = useQuery(
    mossAppConnectionsQueryOptions({ enabled: waiting, polling: waiting }),
  );
  const connected =
    target !== null &&
    connections.data !== undefined &&
    activeMossAppConnection(connections.data.connections, target.slug) !== null;

  const finish = (name: string, appSlug: string) => {
    toastManager.add({ type: "success", title: format("apps.toast.connected", { name }) });
    void queryClient.invalidateQueries({ queryKey: MOSS_APP_CONNECTIONS_QUERY_KEY });
    onConnected?.(appSlug);
    onOpenChange(false);
  };

  useEffect(() => {
    if (!target || stage !== "waiting") return;
    if (connected) {
      finish(target.name, target.slug);
      return;
    }
    const remaining = SIGN_IN_TIMEOUT_MS - (Date.now() - startedAt.current);
    const timer = window.setTimeout(
      () => {
        setStage("failed");
        setFailure(t("apps.connect.timedOut"));
      },
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(timer);
    // `finish` closes over the latest target; re-running on it would re-toast.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, stage, target]);

  const openSignIn = (url: string) => {
    void ensureNativeApi().shell.openExternal(url);
  };

  const start = useMutation({
    mutationFn: (input: {
      readonly appSlug: string;
      readonly credentials?: Readonly<Record<string, string>>;
    }) =>
      ensureNativeApi().server.connectMossApp({
        toolkitSlug: input.appSlug,
        ...(input.credentials ? { credentials: { ...input.credentials } } : {}),
      }),
    onSuccess: (result) => {
      if (!target) return;
      if (!result.signInUrl || result.connection.status === "active") {
        finish(target.name, target.slug);
        return;
      }
      setSignInUrl(result.signInUrl);
      startedAt.current = Date.now();
      setStage("waiting");
      openSignIn(result.signInUrl);
    },
    onError: (cause) => {
      setStage("failed");
      setFailure(errorText(cause));
    },
  });

  if (!target) return null;
  const fields = form.data?.fields ?? [];
  const missingRequired = fields.some((field) => field.required && !values[field.name]?.trim());
  const canContinue = usesCredentials
    ? form.isSuccess && fields.length > 0 && !missingRequired
    : !needsSetup;
  const submit = () => {
    if (!canContinue || start.isPending) return;
    start.mutate(
      usesCredentials ? { appSlug: target.slug, credentials: values } : { appSlug: target.slug },
    );
  };

  const title =
    stage === "waiting"
      ? format("apps.connect.waiting", { name: target.name })
      : format("apps.connect.title", { name: target.name });
  const body =
    stage === "waiting"
      ? t("apps.connect.waitingHint")
      : stage === "failed" && !usesCredentials
        ? (failure ?? format("apps.toast.failed", { name: target.name }))
        : needsSetup
          ? format("apps.connect.setupBody", { name: target.name })
          : usesCredentials
            ? format("apps.connect.credentialsBody", { name: target.name })
            : format("apps.connect.body", { name: target.name });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onOpenChange(false);
      }}
    >
      <DialogPopup className="max-w-[420px] gap-0 p-0" data-testid="moss-app-connect-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col items-center gap-5 px-8 pt-9 pb-7 text-center">
            <div className="flex items-center gap-3" aria-hidden="true">
              <LogoTile>
                <MossLogo className="size-9" />
              </LogoTile>
              <span className="flex items-center gap-1">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className={
                      stage === "waiting"
                        ? "size-1.5 rounded-full bg-foreground/25 motion-safe:animate-pulse"
                        : "size-1.5 rounded-full bg-foreground/25"
                    }
                    style={stage === "waiting" ? { animationDelay: `${dot * 180}ms` } : undefined}
                  />
                ))}
              </span>
              <LogoTile>
                <AppLogo target={target} />
              </LogoTile>
            </div>
            <div className="flex flex-col gap-2">
              <DialogTitle className="text-[20px] font-semibold leading-7 text-balance">
                {title}
              </DialogTitle>
              <p
                className={
                  stage === "failed" && !usesCredentials
                    ? "text-ui-lg leading-6 text-destructive"
                    : "text-ui-lg leading-6 text-muted-foreground"
                }
                role={stage === "failed" && !usesCredentials ? "alert" : undefined}
              >
                {body}
              </p>
              {stage === "intro" && !needsSetup ? (
                <p className="text-ui leading-5 text-muted-foreground/80">
                  {t("apps.connect.manageHint")}
                </p>
              ) : null}
            </div>
            {usesCredentials && stage !== "waiting" ? (
              <div className="flex w-full flex-col gap-3 text-left">
                {form.isPending ? (
                  <span className="flex justify-center py-2" role="status">
                    <Spinner className="size-4 text-muted-foreground" />
                  </span>
                ) : form.isError ? (
                  <p className="text-ui text-destructive" role="alert">
                    {errorText(form.error) ?? format("apps.toast.failed", { name: target.name })}
                  </p>
                ) : (
                  fields.map((field) => (
                    <label key={field.name} className="block space-y-1.5">
                      <span className={dialogFieldLabelClassName}>
                        {field.label}
                        {field.required ? null : (
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            {t("apps.connect.optional")}
                          </span>
                        )}
                      </span>
                      <Input
                        type={field.secret ? "password" : "text"}
                        value={values[field.name] ?? ""}
                        maxLength={8192}
                        autoComplete="off"
                        spellCheck={false}
                        data-testid={`moss-app-connect-field-${field.name}`}
                        onChange={(event) => {
                          const next = event.target.value;
                          setValues((current) => ({ ...current, [field.name]: next }));
                        }}
                      />
                      {field.description ? (
                        <span className="block text-ui-sm leading-5 text-muted-foreground">
                          {field.description}
                        </span>
                      ) : null}
                    </label>
                  ))
                )}
                {form.data?.helpUrl ? (
                  <button
                    type="button"
                    className="self-start text-ui-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() => openSignIn(form.data.helpUrl!)}
                  >
                    {t("apps.connect.helpLink")}
                  </button>
                ) : null}
                {stage === "failed" ? (
                  <p className="text-ui text-destructive" role="alert">
                    {failure ?? format("apps.toast.failed", { name: target.name })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/60 px-6 py-4">
            {stage === "waiting" && signInUrl ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto h-8 px-2 text-ui-lg sm:h-8"
                onClick={() => openSignIn(signInUrl)}
              >
                {t("apps.connect.reopen")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg px-3 text-ui-lg sm:h-8"
              onClick={() => onOpenChange(false)}
            >
              {t("apps.connect.cancel")}
            </Button>
            {stage === "waiting" ? (
              <span className="inline-flex h-8 items-center px-2" role="status">
                <Spinner className="size-4 text-muted-foreground" />
              </span>
            ) : needsSetup ? null : (
              <Button
                type="submit"
                size="sm"
                className="h-8 rounded-lg px-3.5 text-ui-lg font-medium sm:h-8"
                disabled={start.isPending || !canContinue}
                aria-busy={start.isPending || undefined}
                data-testid="moss-app-connect-continue"
              >
                {start.isPending ? <Spinner className="size-4" /> : null}
                {stage === "failed" ? t("apps.connect.retry") : t("apps.connect.continue")}
              </Button>
            )}
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
