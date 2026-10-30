import type { MossCloudAccountState, MossCloudGoogleOAuthFlowId } from "@synara/contracts";
import {
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudAccountsQueryOptions,
  serverMossCloudExchangeCodeMutationOptions,
  serverMossCloudExchangeGoogleOAuthCodeMutationOptions,
  serverMossCloudLogoutMutationOptions,
  serverMossCloudRemoveAccountMutationOptions,
  serverMossCloudRequestPasswordResetMutationOptions,
  serverMossCloudSelectAccountMutationOptions,
  serverMossCloudSignUpMutationOptions,
  serverMossCloudUpdatePasswordMutationOptions,
} from "./mossServerReactQuery";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { MossLogo } from "~/components/MossLogo";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button, buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { MossAuthLoading, MossAuthShell, useMossOpaqueSurface } from "./MossAuthShell";
import { MossPayPanel } from "./MossPayPanel";
import {
  linkClassName,
  MossCloudForgotPasswordForm,
  MossCloudResetPasswordForm,
  MossCloudSignUpForm,
} from "./MossCloudAuthForms";
import { mossCloudAuthErrorMessage } from "./mossCloudAuth.logic";
import { resolveMossCloudCallbackDestination } from "./mossCloudAuthRoutes.logic";
import {
  activateMossChatSelection,
  MOSS_IMMEDIATE_MODEL_SELECTION,
} from "./activateMossChatSelection";
import { MossGoogleOAuthButton } from "./MossGoogleOAuth";
import { MossAccessLanesPanel } from "./MossAccessLanesPanel";
import { mossAccessLaneSummary } from "./mossAccessLanes.logic";
import { consumeMossGoogleOAuthPurpose } from "./mossGoogleOAuthPurpose";
import { MOSS_POST_AUTH_CHAT_SEARCH, prepareMossPostAuthChatLanding } from "./mossPostAuthLanding";

function ConfigurationUnavailable() {
  return (
    <p className="text-center text-ui-lg leading-5 text-muted-foreground" role="status">
      Moss account sign-in isn’t available right now.
    </p>
  );
}

function QueryFailure({ retry }: { readonly retry: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="error">
        <AlertTitle>Couldn’t connect to Moss</AlertTitle>
        <AlertDescription>Restart Moss and try again.</AlertDescription>
      </Alert>
      <Button onClick={retry} variant="outline">
        Try again
      </Button>
    </div>
  );
}

function useRedirectAuthenticated(
  authenticated: boolean,
  destination: "account" | "fresh-chat" = "account",
  enabled = true,
) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled || !authenticated) return;
    if (destination === "fresh-chat") {
      prepareMossPostAuthChatLanding();
      void navigate({ to: "/", search: MOSS_POST_AUTH_CHAT_SEARCH, replace: true });
      return;
    }
    void navigate({ to: "/account", replace: true });
  }, [authenticated, destination, enabled, navigate]);
}

export function MossCloudLoginPage({ addAccount = false }: { readonly addAccount?: boolean }) {
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  useRedirectAuthenticated(Boolean(accountQuery.data?.authenticated), "fresh-chat", !addAccount);

  return (
    <MossAuthShell
      title={addAccount ? "Add a Moss account" : "Sign in to Moss"}
      description="Continue with Google through the Moss global account service."
      footer={
        addAccount ? (
          <Link className={linkClassName} search={{ accountView: "google" }} to="/account">
            Back to accounts
          </Link>
        ) : (
          <Link className={linkClassName} to="/login">
            Use phone instead
          </Link>
        )
      }
    >
      {accountQuery.isPending ? (
        <MossAuthLoading label="Checking your account…" />
      ) : accountQuery.isError ? (
        <QueryFailure retry={() => void accountQuery.refetch()} />
      ) : !accountQuery.data.configured ? (
        <ConfigurationUnavailable />
      ) : (
        <MossGoogleOAuthButton purpose={addAccount ? "add-account" : "login"} />
      )}
    </MossAuthShell>
  );
}

export function MossCloudSignUpPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const mutation = useMutation(serverMossCloudSignUpMutationOptions({ queryClient }));
  useRedirectAuthenticated(Boolean(accountQuery.data?.authenticated));

  return (
    <MossAuthShell
      title="Create your account"
      footer={
        <span>
          Already have an account?{" "}
          <Link className={linkClassName} to="/login">
            Sign in
          </Link>
        </span>
      }
    >
      {accountQuery.isPending ? (
        <MossAuthLoading label="Checking your account…" />
      ) : accountQuery.isError ? (
        <QueryFailure retry={() => void accountQuery.refetch()} />
      ) : !accountQuery.data.configured ? (
        <ConfigurationUnavailable />
      ) : (
        <MossCloudSignUpForm
          pending={mutation.isPending}
          serverError={mutation.error ? mossCloudAuthErrorMessage(mutation.error, "signUp") : null}
          onSubmit={(values) =>
            mutation.mutate(
              {
                email: values.email,
                password: values.password,
                ...(values.displayName ? { displayName: values.displayName } : {}),
              },
              {
                onSuccess: (result) => {
                  if (result.state.authenticated) {
                    void navigate({ to: "/account", replace: true });
                    return;
                  }
                  void navigate({
                    to: "/verify-email",
                    search: { email: values.email },
                    replace: true,
                  });
                },
              },
            )
          }
        />
      )}
    </MossAuthShell>
  );
}

export function MossCloudForgotPasswordPage() {
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const mutation = useMutation(serverMossCloudRequestPasswordResetMutationOptions());
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  useRedirectAuthenticated(Boolean(accountQuery.data?.authenticated));

  return (
    <MossAuthShell
      title="Reset your password"
      description="We’ll email you a reset link."
      footer={
        <Link className={linkClassName} to="/login">
          Back to sign in
        </Link>
      }
    >
      {accountQuery.isPending ? (
        <MossAuthLoading label="Checking your account…" />
      ) : accountQuery.isError ? (
        <QueryFailure retry={() => void accountQuery.refetch()} />
      ) : !accountQuery.data.configured ? (
        <ConfigurationUnavailable />
      ) : submittedEmail ? (
        <Alert aria-live="polite" role="status" variant="success">
          <AlertTitle>Check your email</AlertTitle>
          <AlertDescription>
            If an account exists for {submittedEmail}, you’ll receive a reset link.
          </AlertDescription>
        </Alert>
      ) : (
        <MossCloudForgotPasswordForm
          pending={mutation.isPending}
          onSubmit={(email) => {
            // Deliberately settle into the same screen for accepted, missing, and provider-error
            // responses so this surface cannot be used to enumerate Moss accounts.
            mutation.mutate({ email }, { onSettled: () => setSubmittedEmail(email) });
          }}
        />
      )}
    </MossAuthShell>
  );
}

export function MossCloudVerifyEmailPage({
  code,
  email,
}: {
  readonly code?: string | undefined;
  readonly email?: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const exchangeMutation = useMutation(serverMossCloudExchangeCodeMutationOptions({ queryClient }));
  const exchangedCodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!code || exchangedCodeRef.current === code || !accountQuery.data?.configured) return;
    exchangedCodeRef.current = code;
    exchangeMutation.mutate(
      { code },
      { onSuccess: () => void navigate({ to: "/account", replace: true }) },
    );
  }, [accountQuery.data?.configured, code, exchangeMutation, navigate]);

  useEffect(() => {
    if (accountQuery.data?.authenticated && accountQuery.data.account?.emailVerified) {
      void navigate({ to: "/account", replace: true });
    }
  }, [accountQuery.data, navigate]);

  const content = useMemo(() => {
    if (accountQuery.isPending) return <MossAuthLoading label="Checking email verification…" />;
    if (accountQuery.isError) {
      return <QueryFailure retry={() => void accountQuery.refetch()} />;
    }
    if (!accountQuery.data.configured) return <ConfigurationUnavailable />;
    if (code && exchangeMutation.isPending) {
      return <MossAuthLoading label="Verifying your email…" />;
    }
    if (code && exchangeMutation.error) {
      return (
        <Alert variant="error">
          <AlertTitle>Verification link unavailable</AlertTitle>
          <AlertDescription>
            {mossCloudAuthErrorMessage(exchangeMutation.error, "exchangeCode")}
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert aria-live="polite" role="status" variant="info">
        <AlertTitle>Check your email</AlertTitle>
        <AlertDescription>
          Moss sent a verification link{email ? ` to ${email}` : ""}. Open it on this device, then
          return to sign in.
        </AlertDescription>
      </Alert>
    );
  }, [accountQuery, code, email, exchangeMutation.error, exchangeMutation.isPending]);

  return (
    <MossAuthShell
      title="Verify your email"
      description="Open the link we sent to finish signing in."
      footer={
        <Link className={linkClassName} to="/login">
          Return to sign in
        </Link>
      }
    >
      {content}
    </MossAuthShell>
  );
}

export function MossCloudAuthCallbackPage({
  code,
  flowId,
}: {
  readonly code?: string | undefined;
  readonly flowId?: MossCloudGoogleOAuthFlowId | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const [verifiedState, setVerifiedState] = useState<MossCloudAccountState | null>(null);
  const exchangeMutation = useMutation(
    serverMossCloudExchangeGoogleOAuthCodeMutationOptions({
      queryClient,
      onVerified: setVerifiedState,
    }),
  );
  const exchangedFlowRef = useRef<string | null>(null);
  const completedFlowRef = useRef<string | null>(null);
  const completedExchangeState = verifiedState ?? exchangeMutation.data ?? null;

  useEffect(() => {
    if (!code || !flowId || exchangedFlowRef.current === flowId || !accountQuery.data?.configured) {
      return;
    }
    exchangedFlowRef.current = flowId;
    exchangeMutation.mutate({ code, flowId });
  }, [accountQuery.data?.configured, code, exchangeMutation, flowId]);

  useEffect(() => {
    if (!completedExchangeState) return;
    const destination = resolveMossCloudCallbackDestination(completedExchangeState);
    if (!destination) return;
    if (destination.to === "/") {
      if (!flowId || completedFlowRef.current === flowId) return;
      completedFlowRef.current = flowId;
      activateMossChatSelection(queryClient, MOSS_IMMEDIATE_MODEL_SELECTION);
      if (consumeMossGoogleOAuthPurpose(flowId) === "add-account") {
        void navigate({ to: "/account", search: { accountView: "google" }, replace: true });
        return;
      }
      prepareMossPostAuthChatLanding();
      void navigate({
        to: destination.to,
        search: MOSS_POST_AUTH_CHAT_SEARCH,
        replace: true,
      });
      return;
    }
    void navigate({ to: destination.to, replace: true });
  }, [completedExchangeState, flowId, navigate, queryClient]);

  let content;
  if (!code || !flowId) {
    content = (
      <Alert variant="error">
        <AlertTitle>Invalid account link</AlertTitle>
        <AlertDescription>This Google sign-in link is incomplete.</AlertDescription>
      </Alert>
    );
  } else if (accountQuery.isPending) {
    content = <MossAuthLoading label="Checking your account…" />;
  } else if (accountQuery.isError) {
    content = <QueryFailure retry={() => void accountQuery.refetch()} />;
  } else if (!accountQuery.data.configured) {
    content = <ConfigurationUnavailable />;
  } else if (exchangeMutation.error) {
    content = (
      <Alert variant="error">
        <AlertTitle>Google sign-in unavailable</AlertTitle>
        <AlertDescription>
          {mossCloudAuthErrorMessage(exchangeMutation.error, "googleOAuth")}
        </AlertDescription>
      </Alert>
    );
  } else if (
    completedExchangeState &&
    !resolveMossCloudCallbackDestination(completedExchangeState)
  ) {
    content = (
      <Alert variant="error">
        <AlertTitle>Google sign-in rejected</AlertTitle>
        <AlertDescription>This sign-in can’t be verified. Start again.</AlertDescription>
      </Alert>
    );
  } else {
    content = <MossAuthLoading label="Completing Google sign-in…" />;
  }

  return (
    <MossAuthShell
      title="Signing in with Google"
      footer={
        !code || !flowId ? (
          <Link className={linkClassName} to="/login">
            Return to sign in
          </Link>
        ) : undefined
      }
    >
      {content}
    </MossAuthShell>
  );
}

export function MossCloudResetPasswordPage({ code }: { readonly code?: string | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const exchangeMutation = useMutation(serverMossCloudExchangeCodeMutationOptions({ queryClient }));
  const updateMutation = useMutation(serverMossCloudUpdatePasswordMutationOptions());
  const exchangedCodeRef = useRef<string | null>(null);
  const trustedRecoverySession =
    accountQuery.data?.authenticated === true && accountQuery.data.lastAuthFlow === "recovery";

  useEffect(() => {
    if (!code || exchangedCodeRef.current === code || !accountQuery.data?.configured) return;
    exchangedCodeRef.current = code;
    exchangeMutation.mutate({ code });
  }, [accountQuery.data?.configured, code, exchangeMutation]);

  let content;
  if (accountQuery.isPending) {
    content = <MossAuthLoading label="Checking the password reset link…" />;
  } else if (accountQuery.isError) {
    content = <QueryFailure retry={() => void accountQuery.refetch()} />;
  } else if (!accountQuery.data.configured) {
    content = <ConfigurationUnavailable />;
  } else if (!code && !trustedRecoverySession) {
    content = (
      <Alert variant="error">
        <AlertTitle>Invalid password reset link</AlertTitle>
        <AlertDescription>Request a new link from the forgot-password page.</AlertDescription>
      </Alert>
    );
  } else if (code && (exchangeMutation.isPending || exchangeMutation.isIdle)) {
    content = <MossAuthLoading label="Opening your secure password reset…" />;
  } else if (code && exchangeMutation.error) {
    content = (
      <Alert variant="error">
        <AlertTitle>Password reset link unavailable</AlertTitle>
        <AlertDescription>
          {mossCloudAuthErrorMessage(exchangeMutation.error, "exchangeCode")}
        </AlertDescription>
      </Alert>
    );
  } else {
    content = (
      <MossCloudResetPasswordForm
        pending={updateMutation.isPending}
        serverError={
          updateMutation.error
            ? mossCloudAuthErrorMessage(updateMutation.error, "updatePassword")
            : null
        }
        onSubmit={(password) =>
          updateMutation.mutate(
            { password },
            {
              onSuccess: () => void navigate({ to: "/account", replace: true }),
            },
          )
        }
      />
    );
  }

  return (
    <MossAuthShell
      title="Choose a new password"
      footer={
        <Link className={linkClassName} to="/forgot-password">
          Request a new link
        </Link>
      }
    >
      {content}
    </MossAuthShell>
  );
}

function formatSessionDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function MossCloudAccountPage() {
  useMossOpaqueSurface();

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountQuery = useQuery(serverMossCloudAccountStateQueryOptions());
  const accountsQuery = useQuery(serverMossCloudAccountsQueryOptions());
  const selectMutation = useMutation(serverMossCloudSelectAccountMutationOptions({ queryClient }));
  const removeMutation = useMutation(serverMossCloudRemoveAccountMutationOptions({ queryClient }));
  const logoutMutation = useMutation(serverMossCloudLogoutMutationOptions({ queryClient }));

  const state = accountQuery.data;
  const account = state?.account;
  const accounts = accountsQuery.data?.accounts ?? [];
  const operationError = selectMutation.error ?? removeMutation.error ?? logoutMutation.error;

  return (
    <main className="min-h-dvh w-full overflow-y-auto bg-background px-4 py-8 text-foreground sm:px-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-7">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-4">
          <Link
            aria-label="Back to Moss chats"
            className="flex items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            to="/"
          >
            <MossLogo className="size-8" />
            <span className="text-lg font-semibold">Moss</span>
          </Link>
          <Link className={linkClassName} to="/settings">
            Settings
          </Link>
        </header>

        {accountQuery.isPending || accountsQuery.isPending ? (
          <MossAuthLoading label="Loading your Moss account…" />
        ) : accountQuery.isError || accountsQuery.isError ? (
          <QueryFailure
            retry={() => {
              void accountQuery.refetch();
              void accountsQuery.refetch();
            }}
          />
        ) : !state?.configured ? (
          <ConfigurationUnavailable />
        ) : (
          <>
            <section aria-labelledby="moss-account-heading" className="min-w-0">
              <p className="text-ui-lg font-medium text-muted-foreground">Moss account</p>
              <h1 id="moss-account-heading" className="mt-1 text-2xl font-semibold tracking-tight">
                {account ? (account.displayName ?? account.email) : "Your accounts"}
              </h1>
              <p className="mt-2 text-ui-lg text-muted-foreground">
                {account
                  ? `${account.emailVerified ? "Verified" : "Verification needed"} · ${
                      state.modelGatewayConfigured ? mossAccessLaneSummary("global") : "Signed in"
                    }`
                  : "Choose a saved account or add another one."}
              </p>
            </section>

            {operationError ? (
              <Alert variant="error">
                <AlertTitle>Account action failed</AlertTitle>
                <AlertDescription>
                  {mossCloudAuthErrorMessage(operationError, "account")}
                </AlertDescription>
              </Alert>
            ) : null}

            {account ? <MossAccessLanesPanel /> : null}

            <section aria-labelledby="saved-accounts-heading" className="min-w-0">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 id="saved-accounts-heading" className="text-ui-lg font-medium">
                    Saved accounts
                  </h2>
                  <p className="mt-1 text-ui-lg text-muted-foreground">
                    Switch without signing out.
                  </p>
                </div>
                <Link
                  className={cn(buttonVariants({ size: "sm", variant: "outline" }), "shrink-0")}
                  search={{ add: true }}
                  to="/login"
                >
                  Add account
                </Link>
              </div>

              {accounts.length === 0 ? (
                <p className="mt-4 rounded-xl border border-dashed p-4 text-ui-lg text-muted-foreground">
                  No saved Moss accounts.
                </p>
              ) : (
                <ul
                  className="mt-4 divide-y overflow-hidden rounded-xl border"
                  aria-label="Saved accounts"
                >
                  {accounts.map((saved) => {
                    const busy =
                      (selectMutation.isPending &&
                        selectMutation.variables?.accountId === saved.id) ||
                      (removeMutation.isPending &&
                        removeMutation.variables?.accountId === saved.id);
                    return (
                      <li className="flex min-w-0 items-center gap-3 p-3" key={saved.id}>
                        <span
                          aria-hidden="true"
                          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-ui-lg font-semibold"
                        >
                          {saved.email.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-ui-lg font-medium">
                            {saved.displayName ?? saved.email}
                          </p>
                          <p className="truncate text-ui-sm text-muted-foreground">
                            {saved.email} ·{" "}
                            {saved.selected
                              ? "Current"
                              : saved.sessionAvailable
                                ? "Ready"
                                : "Sign in again"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {saved.selected ? (
                            <Button
                              aria-label={`Use ${saved.email}`}
                              disabled
                              size="sm"
                              variant="outline"
                            >
                              Current
                            </Button>
                          ) : saved.sessionAvailable ? (
                            <Button
                              aria-label={`Use ${saved.email}`}
                              disabled={
                                busy || selectMutation.isPending || removeMutation.isPending
                              }
                              onClick={() => selectMutation.mutate({ accountId: saved.id })}
                              size="sm"
                              variant="outline"
                            >
                              {selectMutation.isPending &&
                              selectMutation.variables?.accountId === saved.id
                                ? "Switching…"
                                : "Use"}
                            </Button>
                          ) : (
                            <Link
                              aria-label={`Use ${saved.email}`}
                              className={buttonVariants({ size: "sm", variant: "outline" })}
                              search={{ add: true }}
                              to="/login"
                            >
                              Sign in
                            </Link>
                          )}
                          <Button
                            aria-label={`Remove ${saved.email}`}
                            disabled={busy || selectMutation.isPending || removeMutation.isPending}
                            onClick={() => removeMutation.mutate({ accountId: saved.id })}
                            size="sm"
                            variant="ghost"
                          >
                            {removeMutation.isPending &&
                            removeMutation.variables?.accountId === saved.id
                              ? "Removing…"
                              : "Remove"}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="flex min-w-0 items-center justify-between gap-4 rounded-xl border p-4">
              <div className="min-w-0">
                <h2 className="text-ui-lg font-medium">Optional Moss Key</h2>
                <p className="mt-1 text-ui-lg text-muted-foreground">
                  Codex and Claude work after sign-in. Add a key only for a separate key-backed
                  profile.
                </p>
              </div>
              <Link className={linkClassName} to="/login/api-key">
                Manage
              </Link>
            </section>

            {account && state.session ? <MossPayPanel /> : null}
            {account && state.session ? (
              <section className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
                <div className="min-w-0">
                  <h2 className="text-ui-lg font-medium">Usage and credits</h2>
                  <p className="mt-1 text-ui-lg text-muted-foreground">
                    Same as Codex: open Settings → Usage to see quota and buy credits.
                  </p>
                </div>
                <Button
                  onClick={() => void navigate({ to: "/settings", search: { section: "usage" } })}
                  size="sm"
                >
                  Open Usage
                </Button>
              </section>
            ) : null}

            {account && state.session ? (
              <section className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-t pt-5">
                <p aria-live="polite" className="text-ui-lg text-muted-foreground" role="status">
                  {logoutMutation.isPending
                    ? "Signing out…"
                    : `Session expires ${formatSessionDate(state.session.expiresAt)}`}
                </p>
                <Button
                  disabled={
                    logoutMutation.isPending || selectMutation.isPending || removeMutation.isPending
                  }
                  onClick={() => logoutMutation.mutate()}
                  variant="outline"
                >
                  Sign out
                </Button>
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
