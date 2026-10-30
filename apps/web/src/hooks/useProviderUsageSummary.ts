// FILE: useProviderUsageSummary.ts
// Purpose: Merge usage signals from thread activities, server-side local archives,
// and provider-specific snapshots into one UI-friendly summary.

import type {
  OrchestrationThread,
  ProviderInstanceId,
  ProviderKind,
  ServerCodexResetCredits,
  ServerGetProviderUsageSnapshotResult,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import { useTranslation } from "~/localization";
import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
  type OpenUsageUsageLine,
} from "~/lib/openUsageRateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
import {
  isProviderUsageSnapshotNonOk,
  normalizeServerProviderUsageLines,
  normalizeServerProviderUsageRateLimit,
  providerUsageSnapshotInstanceId,
} from "~/lib/providerUsageSnapshot";
import {
  deriveProviderUsageLearnMoreHref,
  deriveRateLimitLearnMoreHref,
  deriveAccountRateLimits,
  mergeProviderRateLimits,
  type ProviderRateLimit,
} from "~/lib/rateLimits";
import {
  serverAllProviderUsageQueryOptions,
  serverProviderUsageSnapshotQueryOptions,
} from "~/lib/serverReactQuery";

export interface ProviderUsageSummaryData {
  readonly learnMoreHref: string | null;
  readonly rateLimits: ReadonlyArray<ProviderRateLimit>;
  readonly usageLines: ReadonlyArray<OpenUsageUsageLine>;
  readonly usageNotice: string | undefined;
  readonly resetCredits?: ServerCodexResetCredits | undefined;
}

export function resolveProviderUsageSummary(input: {
  provider: ProviderKind | null;
  accountRateLimits: ReadonlyArray<ProviderRateLimit>;
  authoritativeLiveSnapshot: ServerGetProviderUsageSnapshotResult;
  localUsageSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  openUsageSnapshot?: unknown;
}): ProviderUsageSummaryData {
  const blocksFallback = isProviderUsageSnapshotNonOk(input.authoritativeLiveSnapshot);
  if (blocksFallback) {
    return {
      learnMoreHref: deriveProviderUsageLearnMoreHref(input.provider),
      rateLimits: [],
      usageLines: [],
      usageNotice: undefined,
      resetCredits: undefined,
    };
  }

  const derivedRateLimits = input.accountRateLimits.filter((rateLimit) =>
    input.provider ? rateLimit.provider === input.provider : true,
  );
  const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(input.authoritativeLiveSnapshot);
  const localUsageRateLimit = normalizeServerProviderUsageRateLimit(input.localUsageSnapshot);
  const openUsageRateLimit = normalizeOpenUsageSnapshot(input.openUsageSnapshot, input.provider);
  const rateLimits = mergeProviderRateLimits(
    derivedRateLimits,
    mergeProviderRateLimits(
      liveUsageRateLimit ? [liveUsageRateLimit] : [],
      mergeProviderRateLimits(
        localUsageRateLimit ? [localUsageRateLimit] : [],
        openUsageRateLimit ? [openUsageRateLimit] : [],
      ),
    ),
  );

  const liveUsageLines = normalizeServerProviderUsageLines(input.authoritativeLiveSnapshot);
  const localUsageLines = normalizeServerProviderUsageLines(input.localUsageSnapshot);
  const usageLines =
    liveUsageLines.length > 0
      ? liveUsageLines
      : localUsageLines.length > 0
        ? localUsageLines
        : normalizeOpenUsageUsageLines(input.openUsageSnapshot);
  const detail = input.authoritativeLiveSnapshot?.detail?.trim();

  return {
    learnMoreHref:
      deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(input.provider),
    rateLimits,
    usageLines,
    usageNotice: detail ? detail : undefined,
    resetCredits:
      input.authoritativeLiveSnapshot?.provider === "codex"
        ? input.authoritativeLiveSnapshot.resetCredits
        : undefined,
  };
}

export function useProviderUsageSummary(input: {
  provider: ProviderKind | null | undefined;
  providerInstanceId?: ProviderInstanceId | null;
  /** Upstream alias for providerInstanceId (upstream call sites pass instanceId). */
  instanceId?: ProviderInstanceId | undefined;
  accountRef?: string | null;
  threads?: ReadonlyArray<Pick<OrchestrationThread, "activities">>;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  /** Legacy caller shape; never forwarded as archive filesystem authority. */
  codexHomePath?: string | null;
  providerSnapshot?: ServerGetProviderUsageSnapshotResult | undefined;
  fetchOpenUsageData?: boolean | undefined;
}) {
  const { t } = useTranslation();
  const provider = input.provider ?? null;
  const effectiveProviderInstanceId =
    input.providerInstanceId ??
    input.instanceId ??
    (input.providerSnapshot ? providerUsageSnapshotInstanceId(input.providerSnapshot) : null);
  const shouldFetchLiveProviderUsage = provider !== null && input.providerSnapshot === undefined;
  const needsCodexAccountDiscovery =
    provider === "codex" && input.accountRef === undefined && shouldFetchLiveProviderUsage;
  const providerUsageIdentityQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled: needsCodexAccountDiscovery,
      ...(effectiveProviderInstanceId !== undefined
        ? { providerInstanceId: effectiveProviderInstanceId }
        : {}),
    }),
  );
  const discoveredAccountRef = providerUsageIdentityQuery.data?.find(
    (snapshot) =>
      snapshot.provider === provider &&
      (effectiveProviderInstanceId === null ||
        providerUsageSnapshotInstanceId(snapshot) === effectiveProviderInstanceId),
  )?.accountRef;
  const effectiveAccountRef = input.accountRef ?? discoveredAccountRef;
  const shouldFetchLocalProviderUsage =
    shouldFetchLiveProviderUsage && (provider !== "codex" || effectiveAccountRef !== undefined);
  // The unscoped query above is identity bootstrap only. Codex rows are rendered exclusively from
  // a provider-instance + opaque-account-ref query, so a previous login's cache cannot paint while
  // the current account identity is being established.
  const allProviderUsageQuery = useQuery(
    serverAllProviderUsageQueryOptions({
      enabled:
        shouldFetchLiveProviderUsage &&
        (!needsCodexAccountDiscovery || effectiveAccountRef !== undefined),
      ...(effectiveProviderInstanceId !== undefined
        ? { providerInstanceId: effectiveProviderInstanceId }
        : {}),
      ...(effectiveAccountRef !== undefined ? { accountRef: effectiveAccountRef } : {}),
    }),
  );
  const localUsageSnapshotQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider,
      ...(effectiveProviderInstanceId !== undefined
        ? { providerInstanceId: effectiveProviderInstanceId }
        : {}),
      ...(effectiveAccountRef !== undefined ? { accountRef: effectiveAccountRef } : {}),
      enabled: shouldFetchLocalProviderUsage,
    }),
  );
  const openUsageSnapshotQuery = useQuery(
    openUsageProviderSnapshotQueryOptions(provider, {
      enabled: input.fetchOpenUsageData ?? true,
    }),
  );
  const liveProviderSnapshot = (allProviderUsageQuery.data ?? []).find(
    (snapshot) =>
      snapshot.provider === provider &&
      (effectiveProviderInstanceId === null ||
        providerUsageSnapshotInstanceId(snapshot) === effectiveProviderInstanceId) &&
      (!effectiveAccountRef || snapshot.accountRef === effectiveAccountRef),
  );
  const authoritativeLiveSnapshot = liveProviderSnapshot ?? input.providerSnapshot ?? null;
  // Explicit live failures are authoritative; only fall back when no live snapshot exists.
  const blocksProviderUsageFallback = isProviderUsageSnapshotNonOk(authoritativeLiveSnapshot);
  const accountRateLimits = input.threadRateLimits ?? deriveAccountRateLimits(input.threads ?? []);
  const queriedLocalSnapshot = shouldFetchLocalProviderUsage
    ? (localUsageSnapshotQuery.data ?? null)
    : null;
  const localSnapshot =
    provider === "codex" && queriedLocalSnapshot?.accountRef !== effectiveAccountRef
      ? null
      : queriedLocalSnapshot;
  let usesLocalSnapshot = false;

  let rateLimits: ReadonlyArray<ProviderRateLimit> = [];
  if (!blocksProviderUsageFallback) {
    const derivedRateLimits = accountRateLimits.filter((rateLimit) =>
      provider ? rateLimit.provider === provider : true,
    );
    const liveUsageRateLimit = normalizeServerProviderUsageRateLimit(authoritativeLiveSnapshot);
    const localUsageRateLimit = normalizeServerProviderUsageRateLimit(localSnapshot);
    usesLocalSnapshot ||= localUsageRateLimit !== null;
    const openUsageSnapshot = normalizeOpenUsageSnapshot(openUsageSnapshotQuery.data, provider);
    rateLimits = mergeProviderRateLimits(
      derivedRateLimits,
      mergeProviderRateLimits(
        liveUsageRateLimit ? [liveUsageRateLimit] : [],
        mergeProviderRateLimits(
          localUsageRateLimit ? [localUsageRateLimit] : [],
          openUsageSnapshot ? [openUsageSnapshot] : [],
        ),
      ),
    );
  }

  let usageLines: ReturnType<typeof normalizeServerProviderUsageLines> = [];
  if (blocksProviderUsageFallback && authoritativeLiveSnapshot?.usageAuthority === "lower-bound") {
    usageLines = normalizeServerProviderUsageLines(authoritativeLiveSnapshot);
  } else if (!blocksProviderUsageFallback) {
    const liveUsageLines = normalizeServerProviderUsageLines(authoritativeLiveSnapshot);
    if (liveUsageLines.length > 0) {
      usageLines = liveUsageLines;
    } else {
      const localUsageLines = normalizeServerProviderUsageLines(localSnapshot);
      if (localUsageLines.length > 0) {
        usageLines = localUsageLines;
        usesLocalSnapshot = true;
      } else {
        usageLines = normalizeOpenUsageUsageLines(openUsageSnapshotQuery.data);
      }
    }
  }

  // A throttle/staleness note the server rides on an otherwise-ok snapshot (e.g. Claude serving the
  // last values while Anthropic rate-limits). Only surfaced when the snapshot is actually shown —
  // non-ok snapshots hide the section entirely, so their `detail` would never be seen anyway.
  const usageNotice =
    blocksProviderUsageFallback && authoritativeLiveSnapshot?.usageAuthority === "lower-bound"
      ? authoritativeLiveSnapshot.detail?.trim()
      : blocksProviderUsageFallback
        ? undefined
        : [
            authoritativeLiveSnapshot?.detail?.trim(),
            authoritativeLiveSnapshot?.archiveScan?.complete === false
              ? t("settings.usage.archiveIncomplete")
              : undefined,
            usesLocalSnapshot && localSnapshot?.archiveScan?.complete === false
              ? t("settings.usage.archiveIncomplete")
              : usesLocalSnapshot
                ? localSnapshot?.detail?.trim()
                : undefined,
          ]
            .filter((detail): detail is string => Boolean(detail))
            .filter((detail, index, details) => details.indexOf(detail) === index)
            .join(" ") || undefined;

  const learnMoreHref =
    deriveRateLimitLearnMoreHref(rateLimits) ?? deriveProviderUsageLearnMoreHref(provider);

  const isLoading =
    shouldFetchLiveProviderUsage &&
    allProviderUsageQuery.isPending &&
    localUsageSnapshotQuery.isPending &&
    rateLimits.length === 0 &&
    usageLines.length === 0;

  const resetCredits =
    authoritativeLiveSnapshot?.provider === "codex"
      ? authoritativeLiveSnapshot.resetCredits
      : undefined;

  return {
    isLoading,
    learnMoreHref,
    rateLimits,
    usageLines,
    usageNotice,
    resetCredits,
  } as const;
}
