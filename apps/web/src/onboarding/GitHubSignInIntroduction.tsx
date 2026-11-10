import { useMutationState, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect } from "react";

import { AnnouncementSheet } from "../components/AnnouncementSheet";
import { hasAuthenticatedMossAccount } from "../components/AuthenticatedAppSnapWelcomeDialog";
import {
  mossServerMutationKeys,
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossEnterpriseKeyStateQueryOptions,
} from "../components/auth/mossServerReactQuery";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { GitHubIcon } from "../lib/icons";
import { useMossImagesAccountBoundary } from "../lib/mossImagesAccountBoundary";
import { ensureNativeApi } from "../nativeApi";

const introduction = Schema.Literals(["unseen", "pending", "done"]);
const signInKeys = new Set(
  [
    mossServerMutationKeys.mossPhoneLogin(),
    mossServerMutationKeys.mossCloudSignIn(),
    mossServerMutationKeys.mossCloudSignUp(),
    mossServerMutationKeys.mossCloudExchangeCode(),
    mossServerMutationKeys.mossCloudExchangeGoogleOAuthCode(),
    mossServerMutationKeys.mossEnterpriseKeySignIn(),
  ].map((key) => JSON.stringify(key)),
);

function authenticated(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if ("authenticated" in result) return result.authenticated === true;
  return "state" in result && authenticated(result.state);
}

/** Existing signed-in installs stay quiet on upgrade. An actual successful sign-in queues the optional
 * invitation; its dismiss/confirm choice survives reloads without persisting any account identifier. */
export function GitHubSignInIntroduction() {
  const [choice, setChoice] = useLocalStorage(
    "moss:github-sign-in-introduction:v1",
    "unseen",
    introduction,
  );
  const logins = useMutationState({
    filters: {
      status: "success",
      predicate: (mutation) => signInKeys.has(JSON.stringify(mutation.options.mutationKey)),
    },
    select: (mutation) => authenticated(mutation.state.data),
  });
  const account = useMossImagesAccountBoundary();
  const navigate = useNavigate();
  // Observe the existing account queries without fetching them. A passive read through the
  // stable QueryClient can be memoized at the signed-out value in a compiled desktop build.
  const phone = useQuery(serverMossAccountSessionQueryOptions({ enabled: false }));
  const cloud = useQuery(serverMossCloudAccountStateQueryOptions({ enabled: false }));
  const enterprise = useQuery(serverMossEnterpriseKeyStateQueryOptions({ enabled: false }));
  const isSignedIn = hasAuthenticatedMossAccount({
    phone: phone.data,
    cloud: cloud.data,
    enterprise: enterprise.data,
  });
  useEffect(() => {
    if (choice === "unseen" && isSignedIn && logins.includes(true)) setChoice("pending");
  }, [choice, isSignedIn, logins, setChoice]);
  const probe = useQuery({
    queryKey: ["github-sign-in-introduction", account.key],
    queryFn: () => ensureNativeApi().githubInbox.connection({ op: "status" }),
    enabled: choice === "pending" && isSignedIn && !account.transitioning,
    retry: false,
    staleTime: 60_000,
    gcTime: 0,
  });
  useEffect(() => {
    if (choice === "pending" && account.isCurrent() && probe.data?.state === "connected")
      setChoice("done");
  }, [account.isCurrent, choice, probe.data, setChoice]);
  const offered =
    choice === "pending" &&
    isSignedIn &&
    !account.transitioning &&
    probe.isSuccess &&
    probe.data.state !== "connected";
  return (
    <AnnouncementSheet
      open={offered}
      hero={<GitHubIcon className="size-12 text-foreground" />}
      title="Connect GitHub to Moss"
      description="Connect the GitHub account on this computer to see pull requests and issues. You can skip this and start chatting."
      confirmLabel="Set up GitHub"
      dismissLabel="Skip for now"
      onDismiss={() => setChoice("done")}
      onConfirm={() => {
        setChoice("done");
        void navigate({ to: "/pull-requests" });
      }}
    />
  );
}
