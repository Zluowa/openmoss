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
import { useTranslation, type TranslationKey } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";

const deviceUrl = "https://github.com/login/device";
/** Where the person can still get GitHub CLI when the one-click install cannot finish. */
const GITHUB_CLI_PAGE = "https://cli.github.com/";

type InstallResult<State extends GitHubConnectionResult["state"]> = Extract<
  GitHubConnectionResult,
  { state: State }
>;

const INSTALL_PHASE_COPY: Record<InstallResult<"installing">["phase"], TranslationKey> = {
  downloading: "codeReview.gh.install.downloading",
  // Windows unpacks into Moss's own folder; only macOS opens the system Installer.
  installing: "codeReview.gh.install.installing",
  verifying: "codeReview.gh.install.verifying",
};
const MAC_INSTALLING_COPY: TranslationKey = "codeReview.gh.install.mac";

const onMac = () => typeof navigator !== "undefined" && isMacPlatform(navigator.platform ?? "");

const INSTALL_FAILURE_COPY: Record<InstallResult<"installFailed">["reason"], TranslationKey> = {
  unsupported: "codeReview.gh.installFailed.unsupported",
  "download-failed": "codeReview.gh.installFailed.download",
  "install-failed": "codeReview.gh.installFailed.install",
  "verify-failed": "codeReview.gh.installFailed.verify",
};

export interface GitHubConnectionGateRenderState {
  /** True when the page rendered via another connected issue source while GitHub is not signed in. */
  readonly githubUnavailable: boolean;
  /** Calm inline GitHub connection card for the list column while GitHub is not signed in. */
  readonly githubNotice: ReactNode;
}

type GitHubConnectionGateChildren =
  | ReactNode
  | ((state: GitHubConnectionGateRenderState) => ReactNode);

export function GitHubConnectionGate({
  children,
  allowChildrenWhenDisconnected = false,
}: {
  children: GitHubConnectionGateChildren;
  /** Keep the code review surface usable (with a calm inline GitHub notice) when Linear or Jira is connected. */
  allowChildrenWhenDisconnected?: boolean;
}) {
  const account = useMossImagesAccountBoundary();
  if (account.transitioning) return null;
  return (
    <HostConnection
      key={account.key}
      current={account.isCurrent}
      allowChildrenWhenDisconnected={allowChildrenWhenDisconnected}
    >
      {children}
    </HostConnection>
  );
}

function HostConnection({
  children,
  current,
  allowChildrenWhenDisconnected,
}: {
  children: GitHubConnectionGateChildren;
  current: () => boolean;
  allowChildrenWhenDisconnected: boolean;
}) {
  const client = useQueryClient();
  const connection = ensureNativeApi().githubInbox?.connection;
  const { t } = useTranslation();
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
  const renderChildren = (state: GitHubConnectionGateRenderState) =>
    typeof children === "function" ? children(state) : children;

  if (!connection || readOnly || result?.state === "connected") {
    return <>{renderChildren({ githubUnavailable: false, githubNotice: null })}</>;
  }
  const pending = result?.state === "pending";
  const installing = result?.state === "installing";
  const installFailed = result?.state === "installFailed";
  const title = t(
    !result
      ? "codeReview.gh.checking"
      : pending
        ? "codeReview.gh.authorize"
        : result.state === "missing"
          ? "codeReview.gh.required"
          : result.state === "installing"
            ? "codeReview.gh.installingTitle"
            : result.state === "installFailed"
              ? "codeReview.gh.installFailedTitle"
              : result.state === "unavailable"
                ? "codeReview.gh.unavailableTitle"
                : result.state === "busy"
                  ? "codeReview.gh.busy"
                  : result.state === "failed"
                    ? "codeReview.gh.failed"
                    : "codeReview.gh.signInTitle",
  );
  const description = t(
    pending
      ? "codeReview.gh.codeHint"
      : result?.state === "missing"
        ? "codeReview.gh.missingHint"
        : result?.state === "installing"
          ? result.phase === "installing" && onMac()
            ? MAC_INSTALLING_COPY
            : INSTALL_PHASE_COPY[result.phase]
          : result?.state === "installFailed"
            ? INSTALL_FAILURE_COPY[result.reason]
            : result?.state === "disconnected"
              ? "codeReview.gh.disconnectedHint"
              : "codeReview.gh.accountHint",
  );
  const controls = pending ? (
    <>
      {result.code && (
        <Button size="sm" onClick={() => void openPage(deviceUrl)}>
          {t("codeReview.gh.openGitHub")}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={cancel}>
        {t("codeReview.cancel")}
      </Button>
    </>
  ) : installing ? (
    result.phase === "downloading" && result.percent !== undefined ? (
      <div
        role="progressbar"
        aria-label={t("codeReview.gh.download")}
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
        aria-label={t("codeReview.gh.installingAria")}
      >
        <Spinner />
      </div>
    )
  ) : (
    result && (
      <>
        {result.state === "missing" || (installFailed && result.reason !== "unsupported") ? (
          <Button size="sm" onClick={() => void followInstall()}>
            {installFailed ? t("codeReview.empty.retry") : t("codeReview.gh.installCli")}
          </Button>
        ) : (
          !installFailed &&
          result.state !== "unavailable" &&
          result.state !== "busy" && (
            <Button size="sm" onClick={() => void start()}>
              {t("codeReview.gh.signInTitle")}
            </Button>
          )
        )}
        {installFailed && (
          <Button size="sm" variant="outline" onClick={() => void openPage(GITHUB_CLI_PAGE)}>
            {t("codeReview.gh.openWebsite")}
          </Button>
        )}
        <Button
          size="sm"
          variant={installFailed ? "ghost" : "outline"}
          onClick={() => setRetry((n) => n + 1)}
        >
          {t("codeReview.gh.checkAgain")}
        </Button>
      </>
    )
  );

  if (allowChildrenWhenDisconnected) {
    const githubNotice = result ? (
      <div
        data-github-connection-notice=""
        className="flex flex-col gap-2.5 rounded-card border border-border/60 bg-card/50 p-3.5 text-left"
      >
        <div className="flex items-start gap-2.5">
          <GitHubIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="m-0 text-ui-sm font-medium text-foreground">{title}</p>
            <p className="m-0 text-ui-xs leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        {pending && result.code ? (
          <div
            className="font-mono text-ui tracking-widest text-foreground"
            aria-label={t("codeReview.gh.deviceCode")}
          >
            {result.code}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">{controls}</div>
        {openError ? (
          <div className="space-y-1">
            <p role="alert" className="m-0 text-ui-xs text-destructive">
              {t("codeReview.gh.browserFailed")}
            </p>
            <code className="block break-all text-ui-xs">
              {pending ? deviceUrl : GITHUB_CLI_PAGE}
            </code>
          </div>
        ) : null}
      </div>
    ) : null;
    return <>{renderChildren({ githubUnavailable: true, githubNotice })}</>;
  }

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
          <div
            className="font-mono text-ui-lg tracking-widest"
            aria-label={t("codeReview.gh.deviceCode")}
          >
            {result.code}
          </div>
        )}
        <EmptyContent>
          {controls}
          {openError && (
            <p role="alert" className="text-ui-sm text-destructive">
              {t("codeReview.gh.browserFailed")}
            </p>
          )}
          {openError && <code className="text-ui-sm">{pending ? deviceUrl : GITHUB_CLI_PAGE}</code>}
        </EmptyContent>
      </Empty>
    </div>
  );
}
