import type { GitHubConnectionResult, GitHubInboxListResult } from "@moss/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { RouteSurfaceHeader } from "../RouteSurface";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { GitHubIcon } from "~/lib/icons";
import { isMacPlatform } from "~/lib/utils";
import {
  readMossImagesAccountBoundary,
  useMossImagesAccountBoundary,
} from "~/lib/mossImagesAccountBoundary";
import { githubInboxQueryKeys } from "~/lib/githubInboxQueryOptions";
import { pullRequestQueryKeys } from "~/lib/pullRequestQueryOptions";
import { ensureNativeApi } from "~/nativeApi";

const deviceUrl = "https://github.com/login/device";
/** Where the person can still get GitHub CLI when the one-click install cannot finish. */
const GITHUB_CLI_PAGE = "https://cli.github.com/";

type InstallResult<State extends GitHubConnectionResult["state"]> = Extract<
  GitHubConnectionResult,
  { state: State }
>;

const INSTALL_PHASE_COPY: Record<InstallResult<"installing">["phase"], string> = {
  downloading: "Downloading GitHub CLI…",
  // Windows unpacks into Moss's own folder; only macOS opens the system Installer.
  installing: "Setting up GitHub CLI for Moss…",
  verifying: "Checking the installation…",
};
const MAC_INSTALLING_COPY = "Installing GitHub CLI. If an installer window opens, finish it there.";

const onMac = () => typeof navigator !== "undefined" && isMacPlatform(navigator.platform ?? "");

const INSTALL_FAILURE_COPY: Record<InstallResult<"installFailed">["reason"], string> = {
  unsupported:
    "Moss can't install GitHub CLI on this computer by itself. Get it from the GitHub CLI website, then check again.",
  "download-failed":
    "The download didn't finish. Check your network and try again, or get it from the GitHub CLI website.",
  "install-failed":
    "The installer didn't finish. Try again, or get it from the GitHub CLI website.",
  "verify-failed":
    "GitHub CLI was installed, but Moss couldn't start it. Try again, or get it from the GitHub CLI website.",
};

export function GitHubConnectionGate({ children }: { children: ReactNode }) {
  const account = useMossImagesAccountBoundary();
  if (account.transitioning) return null;
  return (
    <HostConnection key={account.key} current={account.isCurrent}>
      {children}
    </HostConnection>
  );
}

function HostConnection({ children, current }: { children: ReactNode; current: () => boolean }) {
  const client = useQueryClient();
  const connection = ensureNativeApi().githubInbox?.connection;
  const [result, setResult] = useState<GitHubConnectionResult | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [retry, setRetry] = useState(0);
  const [openError, setOpenError] = useState(false);
  const ticket = useRef<string | null>(null);
  /** Set while this window follows a GitHub CLI install; clearing it stops following. */
  const installRun = useRef<string | null>(null);
  const mounted = useRef(false);
  const serial = useRef(0);
  const discardGitHubQueries = useCallback(async () => {
    for (const key of [githubInboxQueryKeys.all, pullRequestQueryKeys.all]) {
      await client.cancelQueries({ queryKey: key });
      client.removeQueries({ queryKey: key });
    }
  }, [client]);
  useEffect(() => {
    mounted.current = true;
    let previous = readMossImagesAccountBoundary(client);
    const onAccount = () => {
      const now = readMossImagesAccountBoundary(client);
      if (previous === now) return;
      previous = now;
      ++serial.current;
      const requestId = ticket.current;
      ticket.current = null;
      installRun.current = null;
      if (requestId) void connection?.({ op: "cancel", requestId }).catch(() => {});
      setResult(null);
      setRetry((value) => value + 1);
    };
    const offQueries = client.getQueryCache().subscribe(onAccount);
    const offMutations = client.getMutationCache().subscribe(onAccount);
    return () => {
      offQueries();
      offMutations();
      mounted.current = false;
      ++serial.current;
      const requestId = ticket.current;
      ticket.current = null;
      // The install itself keeps running on the computer; only this window stops following it.
      installRun.current = null;
      if (requestId) void connection?.({ op: "cancel", requestId }).catch(() => {});
    };
  }, [client, connection]);

  /**
   * Starts the one-click GitHub CLI install (or follows one already running) and polls until it
   * ends; the gate then shows the next step by itself, usually 连接 GitHub.
   */
  const followInstall = useCallback(
    async (running?: GitHubConnectionResult) => {
      if (!connection || ticket.current || installRun.current || !current()) return;
      const run = crypto.randomUUID();
      installRun.current = run;
      ++serial.current;
      const valid = () => mounted.current && current() && installRun.current === run;
      setOpenError(false);
      setResult(running ?? { state: "installing", phase: "installing" });
      try {
        let state = running ?? (await connection({ op: "install" }));
        while (valid() && state.state === "installing") {
          setResult(state);
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          if (!valid()) return;
          state = await connection({ op: "status" });
        }
        if (!valid()) return;
        if (state.state === "connected") await discardGitHubQueries();
        if (valid()) setResult(state);
      } catch {
        if (valid()) setResult({ state: "installFailed", reason: "install-failed" });
      } finally {
        if (installRun.current === run) installRun.current = null;
      }
    },
    [connection, current, discardGitHubQueries],
  );

  useEffect(() => {
    if (!connection) return;
    let gone = false;
    const check = async () => {
      if (ticket.current || installRun.current || !current()) return;
      const n = ++serial.current;
      try {
        const state = await connection({ op: "status" });
        if (gone || !current() || serial.current !== n || ticket.current || installRun.current)
          return;
        // An install started earlier (another window, or before a reload) is still running.
        if (state.state === "installing") {
          void followInstall(state);
          return;
        }
        const previous = client.getQueriesData<GitHubInboxListResult>({
          queryKey: ["github-inbox", "list"],
        });
        if (
          previous.some(
            ([, data]) =>
              data?.viewer &&
              (state.state !== "connected" ||
                data.viewer.toLowerCase() !== state.login.toLowerCase()),
          )
        ) {
          await discardGitHubQueries();
        }
        if (!gone && current() && serial.current === n && !ticket.current) setResult(state);
      } catch (error) {
        if (gone || !current() || serial.current !== n) return;
        const message =
          error instanceof Error
            ? error.message
            : String((error as { message?: string })?.message ?? "");
        // Existing paired clients can continue to read the inbox using their existing permissions.
        if (
          /owner authorization|computer running Moss|unavailable on this server build/i.test(
            message,
          )
        )
          setReadOnly(true);
        else setResult({ state: "unavailable" });
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      gone = true;
      window.removeEventListener("focus", check);
    };
  }, [client, connection, current, discardGitHubQueries, followInstall, retry]);

  async function start() {
    if (!connection || ticket.current || installRun.current || !current()) return;
    const requestId = crypto.randomUUID();
    const valid = () => mounted.current && current() && ticket.current === requestId;
    ++serial.current;
    ticket.current = requestId;
    setOpenError(false);
    setResult({ state: "pending", code: null });
    try {
      let state = await connection({ op: "start", requestId });
      while (valid() && state.state === "pending") {
        setResult(state);
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (!valid()) break;
        state = await connection({ op: "poll", requestId });
      }
      if (!valid()) {
        await connection({ op: "cancel", requestId }).catch(() => {});
        return;
      }
      if (state.state === "connected") {
        await discardGitHubQueries();
      }
      if (valid()) setResult(state);
    } catch {
      if (valid()) setResult({ state: "failed" });
      await connection({ op: "cancel", requestId }).catch(() => {});
    } finally {
      if (ticket.current === requestId) ticket.current = null;
    }
  }
  const cancel = () => {
    const requestId = ticket.current;
    ticket.current = null;
    if (requestId) void connection?.({ op: "cancel", requestId }).catch(() => {});
    setResult({ state: "cancelled" });
  };
  const openPage = async (url: string) => {
    setOpenError(false);
    try {
      await ensureNativeApi().shell.openExternal(url);
    } catch {
      if (mounted.current && current()) setOpenError(true);
    }
  };
  if (!connection || readOnly || result?.state === "connected") return <>{children}</>;
  const pending = result?.state === "pending";
  const installing = result?.state === "installing";
  const installFailed = result?.state === "installFailed";
  const title = !result
    ? "Checking GitHub connection…"
    : pending
      ? "Authorize Moss with GitHub"
      : result.state === "missing"
        ? "GitHub CLI is required"
        : result.state === "installing"
          ? "Installing GitHub CLI…"
          : result.state === "installFailed"
            ? "GitHub CLI could not be installed"
            : result.state === "unavailable"
              ? "Could not check the GitHub connection"
              : result.state === "busy"
                ? "Another GitHub sign-in is in progress"
                : result.state === "failed"
                  ? "GitHub sign-in could not be confirmed"
                  : "Sign in to GitHub";
  const description = pending
    ? "Enter this one-time code on GitHub and return here after approving access."
    : result?.state === "missing"
      ? "Moss uses GitHub CLI to load pull requests and issues. Install it here in one step."
      : result?.state === "installing"
        ? result.phase === "installing" && onMac()
          ? MAC_INSTALLING_COPY
          : INSTALL_PHASE_COPY[result.phase]
        : result?.state === "installFailed"
          ? INSTALL_FAILURE_COPY[result.reason]
          : result?.state === "disconnected"
            ? "Sign in once, and Code review lists the pull requests and issues you opened, that await your review, or that are assigned to you."
            : "Moss uses the GitHub account on this computer to load pull requests and issues.";
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <RouteSurfaceHeader
        divider={false}
        className="app-top-bar shrink-0"
        rowClassName="h-[var(--app-top-strip-height)]"
      />
      <Empty className="mx-auto max-w-md px-5 py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitHubIcon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {pending && result.code && (
          <div className="font-mono text-ui-lg tracking-widest" aria-label="GitHub device code">
            {result.code}
          </div>
        )}
        <EmptyContent>
          {pending ? (
            <>
              {result.code && (
                <Button size="sm" onClick={() => void openPage(deviceUrl)}>
                  Open GitHub
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </>
          ) : installing ? (
            result.phase === "downloading" && result.percent !== undefined ? (
              <div
                role="progressbar"
                aria-label="GitHub CLI download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={result.percent}
                className="flex w-48 items-center gap-2"
              >
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-foreground transition-[width] duration-300"
                    style={{ width: `${result.percent}%` }}
                  />
                </div>
                <span className="w-8 text-right text-ui-sm tabular-nums text-muted-foreground">
                  {result.percent}%
                </span>
              </div>
            ) : (
              <div
                role="status"
                className="flex items-center gap-2 text-ui text-muted-foreground"
                aria-label="Installing GitHub CLI"
              >
                <Spinner />
              </div>
            )
          ) : (
            result && (
              <>
                {result.state === "missing" ||
                (installFailed && result.reason !== "unsupported") ? (
                  <Button size="sm" onClick={() => void followInstall()}>
                    {installFailed ? "Try again" : "Install GitHub CLI"}
                  </Button>
                ) : (
                  !installFailed &&
                  result.state !== "unavailable" &&
                  result.state !== "busy" && (
                    <Button size="sm" onClick={() => void start()}>
                      Sign in to GitHub
                    </Button>
                  )
                )}
                {installFailed && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openPage(GITHUB_CLI_PAGE)}
                  >
                    Open the GitHub CLI website
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={installFailed ? "ghost" : "outline"}
                  onClick={() => setRetry((n) => n + 1)}
                >
                  Check again
                </Button>
              </>
            )
          )}
          {openError && (
            <p role="alert" className="text-ui-sm text-destructive">
              The browser could not open. Try again or visit the address below.
            </p>
          )}
          {openError && <code className="text-ui-sm">{pending ? deviceUrl : GITHUB_CLI_PAGE}</code>}
        </EmptyContent>
      </Empty>
    </div>
  );
}
