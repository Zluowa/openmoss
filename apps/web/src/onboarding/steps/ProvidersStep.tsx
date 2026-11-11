// FILE: ProvidersStep.tsx
// Purpose: Provider grid for the welcome tour: one card per agent with the server's answer
//          for it (connected, sign in, install), an enable/disable checkbox bound to the
//          server-backed `disabledProviders` setting, and the one action each card needs:
//          登录 runs the agent's own sign-in in the browser, 安装 installs it in place.
//          Nothing here opens a terminal or shows a command.
// Layer: Web UI component

import type { ProviderKind, ServerProviderStatus } from "@moss/contracts";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../../betaFeatures";
import { useQuery } from "@tanstack/react-query";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { getCustomBinaryPathForProvider, useAppSettings } from "~/appSettings";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Checkbox } from "~/components/ui/checkbox";
import { Skeleton } from "~/components/ui/skeleton";
import { StatusDot } from "~/components/ui/status-chip";
import { readAgentInstallState, useAgentInstall } from "~/lib/agentInstall";
import { supportsAgentSignIn, useAgentSignIn } from "~/lib/agentSignIn";
import { Loader2Icon, RefreshCwIcon } from "~/lib/icons";
import {
  type AgentReadiness,
  findProviderStatus,
  normalizeProviderStatusForLocalConfig,
  resolveAgentReadiness,
} from "~/lib/providerAvailability";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  isProviderKind,
  isLocalProviderInstalled,
  prioritizeInstalledProviders,
} from "~/providerOrdering";
import { ONBOARDING_TILE_CLASS_NAME } from "../layout";
import { providersServedByMoss } from "~/components/chat/providerAccountSources";
import { classifyProviderSetup, summarizeProviderSetup, type ProviderSetupState } from "../logic";
import type { ProviderDetection } from "../useProviderDetection";

const EMPTY_STATUSES: readonly ServerProviderStatus[] = [];

/** Status as a dot + word; the dot carries the colour, the copy stays muted. */
const STATE_PRESENTATION: Record<ProviderSetupState, { label: string; dotClassName: string }> = {
  connected: { label: "Connected", dotClassName: "bg-status-success" },
  "needs-sign-in": { label: "Needs sign-in", dotClassName: "bg-warning" },
  "not-installed": { label: "Not installed", dotClassName: "bg-muted-foreground/40" },
  unavailable: { label: "Can't start", dotClassName: "bg-warning" },
  detecting: { label: "Detecting", dotClassName: "bg-muted-foreground/40" },
  "check-failed": { label: "Could not check", dotClassName: "bg-warning" },
  disabled: { label: "Disabled", dotClassName: "bg-muted-foreground/40" },
};

const INLINE_ACTION_CLASS_NAME =
  "cursor-pointer text-foreground underline decoration-foreground/40 underline-offset-[3px] transition-colors hover:decoration-foreground motion-reduce:transition-none";

const STATE_LABEL_KEYS = {
  connected: "provider.readiness.ready",
  "needs-sign-in": "provider.readiness.signInAction",
  "not-installed": "provider.readiness.installAction",
  unavailable: "onboarding.providers.unavailable",
  detecting: "onboarding.providers.detectingShort",
  "check-failed": "onboarding.providers.failedShort",
  disabled: "settings.providers.activity.disabled",
} as const;

/**
 * Raw detection statuses with custom-binary overrides applied but *without* folding the
 * disabled flag in: this step must keep showing "installed" for a provider the user just
 * unchecked, otherwise the card appears to lose its CLI.
 */
function useDetectedProviderStatuses(): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providers = serverConfigQuery.data?.providers ?? EMPTY_STATUSES;
  return useMemo(
    () =>
      providers.flatMap((status) => {
        const provider = status.driver ?? status.provider;
        if (!isProviderKind(provider) || (status.instanceId ?? status.provider) !== provider) {
          return [];
        }
        const normalized = normalizeProviderStatusForLocalConfig({
          provider,
          status,
          customBinaryPath: getCustomBinaryPathForProvider(settings, provider),
        });
        return normalized ? [normalized] : [];
      }),
    [providers, settings],
  );
}

/**
 * Optimistic disabled-provider selection. `disabledProviders` is server-owned and is not
 * applied to local settings until the round-trip completes, so deriving each write from
 * `settings.disabledProviders` would let a second toggle rebuild the list without the
 * first change. Every write instead comes from this draft, and the draft only resyncs
 * from the server once no write is in flight (e.g. after a failed request is rolled back).
 */
function useDisabledProvidersDraft(): {
  readonly disabled: ReadonlySet<ProviderKind>;
  readonly setProviderDisabled: (provider: ProviderKind, disabled: boolean) => void;
} {
  const { settings, updateSettingsAndWait } = useAppSettings();
  const [draft, setDraft] = useState<ReadonlySet<ProviderKind>>(
    () => new Set(settings.disabledProviders),
  );
  const draftRef = useRef(draft);
  // State, not a ref: a rejected write refetches settings *before* the count drops, so the
  // resync must run again once the final write settles or the draft would stay rolled
  // forward on the rejected value.
  const [pendingWrites, setPendingWrites] = useState(0);
  const serverDisabledProviders = settings.disabledProviders;

  useEffect(() => {
    if (pendingWrites > 0) return;
    const next = new Set(serverDisabledProviders);
    draftRef.current = next;
    setDraft(next);
  }, [pendingWrites, serverDisabledProviders]);

  const setProviderDisabled = (provider: ProviderKind, disabled: boolean) => {
    const next = new Set(draftRef.current);
    if (disabled) {
      next.add(provider);
    } else {
      next.delete(provider);
    }
    draftRef.current = next;
    setDraft(next);
    setPendingWrites((count) => count + 1);
    void updateSettingsAndWait({ disabledProviders: [...next] }).finally(() => {
      setPendingWrites((count) => count - 1);
    });
  };

  return { disabled: draft, setProviderDisabled };
}

/** A link-styled action inside the card's label; it must not toggle the checkbox. */
function InlineAction(props: { onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      className={INLINE_ACTION_CLASS_NAME}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}

function BusyLine(props: { children: ReactNode }) {
  return (
    <>
      <Loader2Icon aria-hidden className="size-3 shrink-0 animate-spin" />
      <span className="truncate" role="status">
        {props.children}
      </span>
    </>
  );
}

/** The card's one status line: the state, and the action that changes it. */
function ProviderCardStatus(props: {
  readonly provider: ProviderKind;
  readonly label: string;
  readonly state: ProviderSetupState;
  readonly status: ServerProviderStatus | null;
  readonly readiness: AgentReadiness | null;
  readonly fallbackInstallUrl: string;
}) {
  const { t, format } = useTranslation();
  const signIn = useAgentSignIn({ provider: props.provider, status: props.status });
  const install = useAgentInstall(props.provider, props.fallbackInstallUrl);
  const presentation = STATE_PRESENTATION[props.state];
  const serverInstall = readAgentInstallState(props.status);
  // The server's own report wins while it runs; this card's click covers the gap before.
  const installState =
    serverInstall === "installing" || install.state === "idle"
      ? (serverInstall ?? install.state)
      : install.state;

  // How either ended arrives with the agent's next status: the server re-checks it.
  const signingIn = signIn.state === "signingIn" || signIn.state === "verifying";

  if (props.state === "detecting") {
    return (
      <>
        <Skeleton aria-hidden className="h-2.5 w-20 rounded-full" />
        <span className="sr-only">{t(STATE_LABEL_KEYS[props.state])}</span>
      </>
    );
  }

  if (props.state === "needs-sign-in" && supportsAgentSignIn(props.provider, props.status)) {
    if (signingIn) {
      return (
        <>
          <BusyLine>
            {signIn.state === "verifying"
              ? t("provider.signIn.verifying")
              : t("provider.signIn.waitingShort")}
          </BusyLine>
          {signIn.state === "signingIn" ? (
            <InlineAction onClick={() => void signIn.cancel()}>
              {t("provider.signIn.cancel")}
            </InlineAction>
          ) : null}
        </>
      );
    }
    return (
      <>
        <StatusDot aria-hidden className={presentation.dotClassName} />
        {signIn.state === "failed" ? (
          <span className="truncate">{t("provider.signIn.failedShort")}</span>
        ) : null}
        <InlineAction
          label={format("chat.modelSource.signInFor", { provider: props.label })}
          onClick={() => void signIn.start()}
        >
          {signIn.state === "failed"
            ? t("provider.install.retry")
            : t("provider.readiness.signInAction")}
        </InlineAction>
      </>
    );
  }

  if (props.state === "not-installed" && props.readiness?.state === "notInstalled") {
    const readiness = props.readiness;
    if (installState === "installing") {
      return <BusyLine>{t("provider.install.installingShort")}</BusyLine>;
    }
    return (
      <>
        <StatusDot
          aria-hidden
          className={installState === "failed" ? "bg-destructive" : presentation.dotClassName}
        />
        {installState === "failed" ? (
          <span className="truncate">{t("provider.install.failedShort")}</span>
        ) : null}
        <InlineAction
          label={`${t("provider.readiness.installAction")} ${props.label}`}
          onClick={() => void install.install(readiness)}
        >
          {installState === "failed"
            ? t("provider.install.retry")
            : t("provider.readiness.installAction")}
        </InlineAction>
      </>
    );
  }

  return (
    <>
      <StatusDot aria-hidden className={presentation.dotClassName} />
      <span className="truncate">{t(STATE_LABEL_KEYS[props.state])}</span>
    </>
  );
}

export function ProvidersStep(props: { readonly detection: ProviderDetection }) {
  const { t, format } = useTranslation();
  const { detection } = props;
  const statuses = useDetectedProviderStatuses();
  const { disabled: disabledSet, setProviderDisabled } = useDisabledProvidersDraft();
  // Retain installation knowledge when disabling stops that agent's health checks.
  const installedRef = useRef(new Set<ProviderKind>());
  for (const status of statuses) {
    const provider = status.driver ?? status.provider;
    if (isLocalProviderInstalled(status) && isProviderKind(provider)) {
      installedRef.current.add(provider);
    }
  }

  // Probe once on entry so a CLI installed while the intro was open shows up.
  const refreshedOnEntryRef = useRef(false);
  useEffect(() => {
    if (refreshedOnEntryRef.current) return;
    refreshedOnEntryRef.current = true;
    void detection.detect({ silent: true });
  }, [detection]);

  const descriptorByKind = new Map<ProviderKind, (typeof VISIBLE_PROVIDER_DESCRIPTORS)[number]>(
    VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor]),
  );
  const servedByMoss = providersServedByMoss(statuses);
  const rows = prioritizeInstalledProviders(
    VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.kind),
    installedRef.current,
  ).flatMap((provider) => {
    const descriptor = descriptorByKind.get(provider);
    if (!descriptor) return [];
    if (!isProviderKind(descriptor.kind)) return [];
    const status = findProviderStatus(statuses, descriptor.kind, descriptor.kind);
    const readiness = status ? resolveAgentReadiness(status) : null;
    const state = classifyProviderSetup({
      readiness,
      disabled: disabledSet.has(descriptor.kind),
      servedByMoss: servedByMoss.has(descriptor.kind),
      detecting: detection.detecting,
      detectionFailed: detection.failed,
    });
    return [{ descriptor, provider: descriptor.kind, status, readiness, state }];
  });
  const summary = summarizeProviderSetup(
    rows.map((row) => ({ provider: row.provider, state: row.state })),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid min-h-0 grid-cols-1 gap-2 overflow-y-auto pr-1 pb-1 min-[480px]:grid-cols-2 sm:grid-cols-3">
        {rows.map(({ descriptor, status, readiness, state }) => {
          const enabled = state !== "disabled";
          const checkboxId = `onboarding-provider-${descriptor.kind}`;
          return (
            <div
              key={descriptor.kind}
              data-onboarding-agent={descriptor.kind}
              data-onboarding-agent-state={state}
              className={cn(
                "flex min-h-[calc(3.5rem*var(--app-ui-scale,1))] items-center gap-ui-gap-sm px-ui-pad-md py-1",
                ONBOARDING_TILE_CLASS_NAME,
                enabled && "border-primary/60 bg-primary/5",
              )}
            >
              <ProviderIcon provider={descriptor.kind} className="size-ui-icon shrink-0" />
              <label
                htmlFor={checkboxId}
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
              >
                <span className="truncate text-ui-lg font-medium text-foreground">
                  {descriptor.displayName}
                </span>
                <span className="flex h-lh min-w-0 items-center gap-1.5 whitespace-nowrap text-ui-sm text-muted-foreground">
                  <ProviderCardStatus
                    provider={descriptor.kind}
                    label={descriptor.displayName}
                    state={state}
                    status={status}
                    readiness={readiness}
                    fallbackInstallUrl={descriptor.setupDocsHref}
                  />
                </span>
              </label>
              <Checkbox
                id={checkboxId}
                render={<button type="button" />}
                nativeButton
                checked={enabled}
                className="cursor-pointer border-foreground/50 dark:not-data-checked:bg-background"
                aria-label={format(
                  enabled
                    ? "settings.providers.activity.disableAria"
                    : "settings.providers.activity.enableAria",
                  { provider: descriptor.displayName },
                )}
                onCheckedChange={(checked) =>
                  setProviderDisabled(descriptor.kind, checked !== true)
                }
              />
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-ui-gap-sm text-ui text-muted-foreground">
        <span aria-live="polite">
          {summary.detecting > 0
            ? t("onboarding.providers.detecting")
            : summary.checkFailed > 0
              ? t("onboarding.providers.failed")
              : format("onboarding.providers.summary", {
                  connected: summary.connected,
                  login: summary.needsSignIn,
                  missing: summary.notInstalled,
                })}
        </span>
        <button
          type="button"
          disabled={detection.detecting}
          className="inline-flex cursor-pointer items-center gap-1.5 text-foreground/70 transition-colors hover:text-foreground disabled:opacity-60 motion-reduce:transition-none"
          onClick={() => void detection.detect()}
        >
          <RefreshCwIcon
            className={cn("size-ui-icon-sm", detection.detecting && "animate-spin")}
            aria-hidden
          />
          {t("onboarding.providers.redetect")}
        </button>
      </div>
    </div>
  );
}
