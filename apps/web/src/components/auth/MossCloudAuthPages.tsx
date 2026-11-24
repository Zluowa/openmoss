import type { MossCloudAccountState, MossCloudGoogleOAuthFlowId } from "@moss/contracts";
import {
  serverMossCloudAccountStateQueryOptions,
  serverMossCloudExchangeCodeMutationOptions,
  serverMossCloudExchangeGoogleOAuthCodeMutationOptions,
  serverMossCloudRequestPasswordResetMutationOptions,
  serverMossCloudSignUpMutationOptions,
  serverMossCloudUpdatePasswordMutationOptions,
} from "./mossServerReactQuery";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

import { MossAuthLoading, MossAuthShell } from "./MossAuthShell";
import {
  linkClassName,
  MossCloudForgotPasswordForm,
  MossCloudResetPasswordForm,
  MossCloudSignUpForm,
} from "./MossCloudAuthForms";
import { mossCloudAuthErrorMessage, type MossCloudOAuthCallbackError } from "./mossCloudAuth.logic";
import { resolveMossCloudCallbackDestination } from "./mossCloudAuthRoutes.logic";
import {
  activateMossChatSelection,
  MOSS_IMMEDIATE_MODEL_SELECTION,
} from "./activateMossChatSelection";
import { MossGoogleOAuthButton } from "./MossGoogleOAuth";
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
      backToApp
      title={addAccount ? "Add a Moss account" : "Sign in to Moss"}
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
          {`Moss sent a verification link${email ? ` to ${email}` : ""}. Open it on this device, then return to sign in.`}
        </AlertDescription>
      </Alert>
    );
  }, [accountQuery, code, email, exchangeMutation.error, exchangeMutation.isPending]);

  return (
    <MossAuthShell
      title="Verify your email"
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
  oauthError,
}: {
  readonly code?: string | undefined;
  readonly flowId?: MossCloudGoogleOAuthFlowId | undefined;
  readonly oauthError?: MossCloudOAuthCallbackError | undefined;
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
  if (oauthError) {
    content = (
      <Alert variant="error">
        <AlertTitle>
          {oauthError === "access_denied"
            ? "Google sign-in was cancelled"
            : "Google sign-in unavailable"}
        </AlertTitle>
        <AlertDescription>
          {oauthError === "access_denied"
            ? "You cancelled at Google. Try again when you’re ready."
            : "Google didn’t complete the sign-in. Try again."}
        </AlertDescription>
      </Alert>
    );
  } else if (!code || !flowId) {
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
        <Link className={linkClassName} to="/login">
          Return to sign in
        </Link>
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
