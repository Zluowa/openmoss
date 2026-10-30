/**
 * `moss.config.projected` event shaping (SY3 A4).
 *
 * When ProviderService refreshes a workspace's `.moss` projections just before
 * a provider session (re)starts, it programmatically emits one
 * `moss.config.projected` record. Emission goes through the same server log
 * channel as SY5's `moss.hooks.session_start` / the runtime `session.configured`
 * event (`Effect.logInfo`, landing in the provider event NDJSON /
 * `ServerConfig.providerEventLogPath` file log) — deliberately NOT the
 * final-shell parity ledger `.moss/ledger/events.jsonl`, which the moss-task
 * loop owns exclusively (mossSourceLayout `never bootstrapped`).
 *
 * This module only *shapes* the payload (and derives the deterministic
 * `eventId` from the launch plan) so the shaping is unit-testable without a
 * live server. `buildMossConfigProjectedLogPayload` is the exact object logged.
 */
import type { MossProjectEventType, ProviderKind, ThreadId } from "@synara/contracts";
import type { MossProjectionEngineFingerprintSummary } from "@synara/shared/mossProjectionFingerprint";

/** Canonical event type literal (from `MossProjectEventType`). */
export const MOSS_CONFIG_PROJECTED_EVENT_TYPE =
  "moss.config.projected" satisfies MossProjectEventType;

export interface MossConfigProjectedEventParams {
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  /** Launch plan id — used as the correlation id (A4). */
  readonly planId: string;
  /** Stable materialize projection fingerprint (`sha256:<hex>`). */
  readonly projectionFingerprint: string;
  /** True when the session was recovered/resumed rather than freshly started. */
  readonly resumed: boolean;
  /** Per-engine created/updated/skipped/conflict/unsupported roll-up. */
  readonly engines: ReadonlyArray<MossProjectionEngineFingerprintSummary>;
  /** Degraded-projection notices, if any (A3). */
  readonly warnings?: ReadonlyArray<string> | undefined;
  /** Set when the refresh itself threw and the session degraded (A3). */
  readonly degraded?: boolean | undefined;
}

/**
 * Deterministic, program-generated event id derived from the correlation id and
 * fingerprint (parallels `makeMossConfiguredEventId`). Sanitized to the
 * `EventId` charset so it decodes without transformation.
 */
export function makeMossConfigProjectedEventId(params: {
  readonly planId: string;
  readonly projectionFingerprint: string;
}): string {
  const fingerprintSuffix = params.projectionFingerprint.replace(/[^A-Za-z0-9_-]/g, "-");
  const planSuffix = params.planId.replace(/[^A-Za-z0-9_-]/g, "-");
  return `moss-config-projected-${planSuffix}-${fingerprintSuffix}`;
}

export interface MossConfigProjectedLogPayload {
  readonly type: typeof MOSS_CONFIG_PROJECTED_EVENT_TYPE;
  readonly eventId: string;
  readonly provider: ProviderKind;
  readonly threadId: string;
  readonly correlationId: string;
  readonly projectionFingerprint: string;
  readonly resumed: boolean;
  readonly degraded: boolean;
  readonly engines: ReadonlyArray<MossProjectionEngineFingerprintSummary>;
  readonly warnings: ReadonlyArray<string>;
}

export function buildMossConfigProjectedLogPayload(
  params: MossConfigProjectedEventParams,
): MossConfigProjectedLogPayload {
  return {
    type: MOSS_CONFIG_PROJECTED_EVENT_TYPE,
    eventId: makeMossConfigProjectedEventId({
      planId: params.planId,
      projectionFingerprint: params.projectionFingerprint,
    }),
    provider: params.provider,
    threadId: String(params.threadId),
    correlationId: params.planId,
    projectionFingerprint: params.projectionFingerprint,
    resumed: params.resumed,
    degraded: Boolean(params.degraded),
    engines: params.engines,
    warnings: params.warnings ?? [],
  };
}
