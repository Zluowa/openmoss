import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useTranslation, type TranslationKey } from "../../localization";
import { isProviderUsageSnapshotNonOk } from "../../lib/providerUsageSnapshot";
import { serverProviderUsageSnapshotQueryOptions } from "../../lib/serverReactQuery";
import type { WorkLogEntry } from "../../workLog";
import { TranscriptNotice } from "./TranscriptNotice";
import { TRANSCRIPT_DIVIDER_DEFAULT_CLASS_NAME } from "./TranscriptDivider";
import {
  formatSystemErrorResetDate,
  resolveSystemErrorPresentation,
  selectSystemErrorResetAt,
  shouldQuerySystemErrorUsage,
  type SystemErrorUsageVariant,
} from "./systemErrorPresentation";
import { resolveComposerAccountSourceKind } from "./providerAccountSources";
import type { CapacityRetryState } from "./MessagesTimeline.logic";
import { Button } from "../ui/button";
import type { ProviderTurnTrigger, TurnId } from "@synara/contracts";

const USAGE_COPY_KEYS: Record<
  SystemErrorUsageVariant,
  { readonly later: TranslationKey; readonly at: TranslationKey }
> = {
  managed: {
    later: "chat.systemError.usageLimit.managed",
    at: "chat.systemError.usageLimit.managedAt",
  },
  upgrade: {
    later: "chat.systemError.usageLimit.upgrade",
    at: "chat.systemError.usageLimit.upgradeAt",
  },
  "upgrade-or-add-credits": {
    later: "chat.systemError.usageLimit.upgradeOrAddCredits",
    at: "chat.systemError.usageLimit.upgradeOrAddCreditsAt",
  },
  "add-credits": {
    later: "chat.systemError.usageLimit.addCredits",
    at: "chat.systemError.usageLimit.addCreditsAt",
  },
  retry: {
    later: "chat.systemError.usageLimit.retry",
    at: "chat.systemError.usageLimit.retryAt",
  },
};

function SystemErrorIcon(props: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="currentColor"
      height="16"
      viewBox="0 0 16 16"
      width="16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8 4.6a.65.65 0 0 1 .65.65v3.1a.65.65 0 0 1-1.3 0v-3.1A.65.65 0 0 1 8 4.6Zm0 5.5a.8.8 0 1 1 0 1.6a.8.8 0 0 1 0-1.6Z" />
      <path
        clipRule="evenodd"
        d="M8 1.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13Zm0 1.25a5.25 5.25 0 1 0 0 10.5a5.25 5.25 0 0 0 0-10.5Z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function usageSnapshotForRow(
  snapshot: ServerProviderUsageSnapshot | null | undefined,
): ServerProviderUsageSnapshot | null {
  return snapshot && !isProviderUsageSnapshotNonOk(snapshot) ? snapshot : null;
}

const SYSTEM_ERROR_PRIVATE_DETAIL_PATTERN =
  /https?:\/\/|(?:authorization|cookie|x-api-key|api[-_ ]?key|bearer|request[-_ ]?id|account[-_ ]?(?:id|email)|(?:token|secret|password)\s*[:=]|(?:sk|pk|rk|sess|req|acct)_[A-Za-z0-9_-]+)/iu;

function safeSystemErrorContent(value: string | undefined): string | undefined {
  const content = value?.trim();
  if (!content || SYSTEM_ERROR_PRIVATE_DETAIL_PATTERN.test(content)) {
    return undefined;
  }
  return content.length <= 500 ? content : `${content.slice(0, 497).trimEnd()}...`;
}

export const TimelineSystemErrorRow = memo(function TimelineSystemErrorRow(props: {
  readonly entry: WorkLogEntry;
  readonly fontSizePx: number;
  readonly capacityRetryState?: CapacityRetryState | null;
  readonly capacityRetryInFlightTurnId?: TurnId | null;
  readonly onCapacityRetry?: (
    turnId: TurnId,
    trigger: ProviderTurnTrigger,
  ) => void | Promise<unknown>;
}) {
  const { format, locale, t } = useTranslation();
  const { capacityRetryState, capacityRetryInFlightTurnId, onCapacityRetry } = props;
  const systemError = props.entry.systemError;
  const provider = systemError?.provider as ProviderKind | undefined;
  const providerInstanceId = systemError?.providerInstanceId;
  const sourceKind =
    provider && providerInstanceId
      ? resolveComposerAccountSourceKind({ provider, instanceId: providerInstanceId })
      : "profile";
  const wantsUsage = systemError?.errorInfo === "usageLimitExceeded";
  const shouldQueryUsage = Boolean(
    wantsUsage &&
    provider &&
    shouldQuerySystemErrorUsage({
      provider,
      sourceKind,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    }),
  );
  const usageQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider: provider ?? null,
      ...(providerInstanceId ? { providerInstanceId } : {}),
      enabled: shouldQueryUsage,
    }),
  );
  const snapshot = usageSnapshotForRow(usageQuery.data);
  const presentation = resolveSystemErrorPresentation({
    sourceKind,
    ...(systemError?.errorInfo ? { errorInfo: systemError.errorInfo } : {}),
    ...(snapshot?.planName ? { planName: snapshot.planName } : {}),
  });

  const capacityRetry =
    capacityRetryState?.turnId === props.entry.turnId ? capacityRetryState : null;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(
    () => capacityRetry?.delaySeconds ?? null,
  );
  const [deadlineMs, setDeadlineMs] = useState<number | null>(() =>
    capacityRetry?.delaySeconds === null || capacityRetry === null || capacityRetry === undefined
      ? null
      : Date.now() + capacityRetry.delaySeconds * 1_000,
  );
  const [retryPending, setRetryPending] = useState(false);
  const [retryFallback, setRetryFallback] = useState(false);
  const retryKeyRef = useRef<string | null>(null);
  const autoAttemptedKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const capacityRetryKey = capacityRetry
    ? `${capacityRetry.turnId}:${capacityRetry.delaySeconds ?? "manual"}`
    : null;
  useEffect(() => {
    if (!capacityRetry || capacityRetryKey === null) {
      retryKeyRef.current = null;
      setSecondsRemaining(null);
      setDeadlineMs(null);
      setRetryPending(false);
      setRetryFallback(false);
      return;
    }
    if (retryKeyRef.current === capacityRetryKey) return;
    retryKeyRef.current = capacityRetryKey;
    autoAttemptedKeyRef.current = null;
    setRetryPending(false);
    setRetryFallback(false);
    if (capacityRetry.delaySeconds === null) {
      setSecondsRemaining(null);
      setDeadlineMs(null);
      return;
    }
    setSecondsRemaining(capacityRetry.delaySeconds);
    setDeadlineMs(Date.now() + capacityRetry.delaySeconds * 1_000);
  }, [capacityRetry, capacityRetryKey]);

  const externallyPending =
    capacityRetry != null && capacityRetryInFlightTurnId === capacityRetry.turnId;
  const isRetryPending = retryPending || externallyPending;
  const wasExternallyPendingRef = useRef(false);
  useEffect(() => {
    if (wasExternallyPendingRef.current && !externallyPending) {
      setRetryPending(false);
      setRetryFallback(true);
      setDeadlineMs(null);
      setSecondsRemaining(null);
    }
    wasExternallyPendingRef.current = externallyPending;
  }, [externallyPending]);
  const dispatchRetry = useCallback(
    (trigger: ProviderTurnTrigger) => {
      if (!capacityRetry || !onCapacityRetry || isRetryPending) return;
      setRetryPending(true);
      if (trigger === "capacity_retry_manual") {
        setDeadlineMs(null);
        setSecondsRemaining(null);
        setRetryFallback(false);
      }
      try {
        Promise.resolve(onCapacityRetry(capacityRetry.turnId, trigger)).catch(() => {
          if (!mountedRef.current) return;
          setRetryPending(false);
          setRetryFallback(true);
          setDeadlineMs(null);
          setSecondsRemaining(null);
        });
      } catch {
        if (!mountedRef.current) return;
        setRetryPending(false);
        setRetryFallback(true);
        setDeadlineMs(null);
        setSecondsRemaining(null);
      }
    },
    [capacityRetry, isRetryPending, onCapacityRetry],
  );

  useEffect(() => {
    if (
      !capacityRetry ||
      capacityRetry.delaySeconds === null ||
      deadlineMs === null ||
      retryFallback ||
      isRetryPending
    ) {
      return;
    }
    const tick = () => {
      const nextSeconds = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1_000));
      setSecondsRemaining(nextSeconds);
      if (nextSeconds === 0) {
        const key = capacityRetryKey;
        if (key !== null && autoAttemptedKeyRef.current !== key) {
          autoAttemptedKeyRef.current = key;
          dispatchRetry("capacity_retry_automatic");
        }
      }
    };
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [capacityRetry, capacityRetryKey, deadlineMs, dispatchRetry, isRetryPending, retryFallback]);

  if (
    capacityRetry &&
    systemError?.provider === "codex" &&
    systemError.errorInfo === "serverOverloaded" &&
    onCapacityRetry
  ) {
    const totalSeconds = capacityRetry.delaySeconds;
    const progress =
      totalSeconds !== null && secondsRemaining !== null
        ? Math.min(1, Math.max(0, (totalSeconds - secondsRemaining) / totalSeconds))
        : 0;
    const retryLabel =
      secondsRemaining === null
        ? t("chat.systemError.capacityRetry.retry")
        : format("chat.systemError.capacityRetry.retryIn", { seconds: secondsRemaining });
    return (
      <TranscriptNotice
        as="aside"
        className="border-primary-outline text-default items-center gap-4 max-[400px]:items-start max-[400px]:gap-2"
        data-system-error="true"
        data-system-error-layout="capacityRetry"
      >
        <div className="flex h-full w-full items-center gap-2">
          <SystemErrorIcon className="icon-sm shrink-0 max-[400px]:hidden" />
          <div className="flex min-w-0 grow flex-row items-center justify-between gap-2 max-[400px]:flex-col max-[400px]:items-start">
            <span
              className="wrap-anywhere min-w-0 text-pretty"
              data-system-error-content="true"
              style={{ fontSize: `${props.fontSizePx}px` }}
            >
              {safeSystemErrorContent(systemError.content) ?? t("chat.systemError.generic")}
            </span>
            <div className="flex shrink-0 gap-2 max-[400px]:w-full max-[400px]:shrink max-[400px]:flex-wrap max-[400px]:justify-center">
              <Button
                variant="outline"
                className="relative overflow-hidden"
                disabled={isRetryPending}
                data-capacity-retry-button="true"
                onClick={() => dispatchRetry("capacity_retry_manual")}
              >
                {totalSeconds !== null && secondsRemaining !== null ? (
                  reducedMotion ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 origin-left bg-text-info/15 rtl:origin-right"
                      style={{ transform: `scaleX(${progress})` }}
                    />
                  ) : (
                    <motion.span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 origin-left bg-text-info/15 rtl:origin-right"
                      initial={false}
                      animate={{ scaleX: progress }}
                    />
                  )
                ) : null}
                <span className="relative z-10 tabular-nums">{retryLabel}</span>
              </Button>
            </div>
          </div>
        </div>
      </TranscriptNotice>
    );
  }

  if (!systemError || presentation.kind === "generic") {
    const rawContent = safeSystemErrorContent(systemError?.content);
    const content =
      !rawContent || rawContent === "Task encountered a system error"
        ? t("codex.localTaskRow.systemError")
        : rawContent;
    return (
      <TranscriptNotice
        as="aside"
        className="border-primary-outline text-default items-center gap-3"
        data-system-error="true"
        data-system-error-layout="verticalIcon"
      >
        <div
          aria-hidden="true"
          className="flex items-center self-center"
          data-system-error-icon-wrapper="true"
        >
          <SystemErrorIcon className="icon-sm shrink-0" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="electron:leading-relaxed min-w-0 flex-1 text-pretty">
            <span
              className="wrap-anywhere"
              data-system-error-content="true"
              style={{ fontSize: `${props.fontSizePx}px` }}
            >
              {content}
            </span>
          </div>
        </div>
      </TranscriptNotice>
    );
  }

  const resetAt = snapshot ? selectSystemErrorResetAt(snapshot.limits) : null;
  const resetDate = formatSystemErrorResetDate(resetAt, locale);
  const copyKeys = USAGE_COPY_KEYS[presentation.variant];
  const message = resetDate ? format(copyKeys.at, { resetDate }) : t(copyKeys.later);
  return (
    <div
      className="flex items-center gap-2 text-codex-secondary"
      data-system-error="true"
      data-system-error-layout="divider"
      data-system-error-usage-variant={presentation.variant}
      data-system-error-reset-at={resetAt ?? undefined}
    >
      <div className={TRANSCRIPT_DIVIDER_DEFAULT_CLASS_NAME} />
      <span className="min-w-0 text-center">
        <span className="inline-flex min-w-0 gap-1.5 items-center">
          <SystemErrorIcon className="size-4 shrink-0" />
          <span className="min-w-0" style={{ fontSize: `${props.fontSizePx}px` }}>
            {message}
          </span>
        </span>
      </span>
      <div className={TRANSCRIPT_DIVIDER_DEFAULT_CLASS_NAME} />
    </div>
  );
});
