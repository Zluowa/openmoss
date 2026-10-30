/**
 * Moss SessionStart hook invocation shaping (ported from 1code
 * `moss-source/session-start.ts`, adapted to moss session vocabulary).
 *
 * `buildMossSessionStartHookOptions` produces the exact `RunMossHooksOptions`
 * fired when ProviderService starts or resumes a provider session. The event
 * is always the canonical {@link MOSS_SESSION_START_EVENT} so it matches
 * `.moss` hook frontmatter (including the bootstrapped starter hook).
 *
 * Payload semantics: moss compiles a Moss launch plan before the provider
 * session starts, so `mossLaunchPlanHash` is the stable configuration
 * fingerprint (1code hashes the prompt for the same purpose — moss has no
 * prompt at session start). The payload carries identifiers and hashes only,
 * never raw prompt/config content.
 *
 * `projectPath`/`cwd` use the same resolution as
 * `loadMossLaunchPlanCanonicalProjection` (`startInput.cwd ?? process.cwd()`),
 * so hooks and the launch plan always see the same `.moss` tree.
 */
import type { ProviderKind, ProviderSessionStartInput, ThreadId } from "@synara/contracts";
import {
  MOSS_SESSION_START_EVENT,
  type MossHookRunResult,
  type MossHookRunSummary,
  type RunMossHooksOptions,
} from "@synara/shared/mossHooks";

export interface MossSessionStartHookInvocationParams {
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
  /** True when the session was recovered/resumed rather than freshly started. */
  readonly resumed: boolean;
  /** Same fallback as the launch-plan compiler so both read one `.moss` tree. */
  readonly cwd?: string | undefined;
  readonly launchPlanHash?: string | undefined;
}

export function buildMossSessionStartHookOptions(
  params: MossSessionStartHookInvocationParams,
): RunMossHooksOptions {
  const cwd = params.cwd?.trim() ? params.cwd : process.cwd();
  return {
    projectPath: cwd,
    cwd,
    event: MOSS_SESSION_START_EVENT,
    provider: params.provider,
    payload: {
      threadId: String(params.threadId),
      provider: params.provider,
      runtimeMode: params.runtimeMode,
      resumed: params.resumed,
      // Optional fields are dropped (not null-padded) so the payload hash is
      // stable for hooks that key on it.
      ...(params.launchPlanHash ? { mossLaunchPlanHash: params.launchPlanHash } : {}),
    },
  };
}

type MossSessionStartHookResultLogEntry = Pick<
  MossHookRunResult,
  | "resourceId"
  | "name"
  | "status"
  | "commandHash"
  | "exitCode"
  | "elapsedMs"
  | "stdout"
  | "stderr"
  | "error"
  | "timedOut"
>;

export interface MossSessionStartHookLogPayload {
  readonly event: string;
  readonly provider: ProviderKind;
  readonly projectPath: string;
  readonly status: MossHookRunSummary["status"];
  readonly matchedCount: number;
  readonly executedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly timedOutCount: number;
  readonly payloadHash: string;
  readonly warnings: ReadonlyArray<string>;
  readonly results: ReadonlyArray<MossSessionStartHookResultLogEntry>;
}

/**
 * Shapes a hook run summary for the server log. `runMossHooks` already
 * redacted and bounded every command/stdout/stderr/error surface, so the
 * payload is safe to log verbatim; this only trims per-result fields down to
 * the observability set (dropping the redacted command text — the
 * `commandHash` fingerprint is the stable identifier).
 */
export function toMossSessionStartHookLogPayload(
  summary: MossHookRunSummary,
): MossSessionStartHookLogPayload {
  return {
    event: summary.event,
    provider: summary.provider,
    projectPath: summary.projectPath,
    status: summary.status,
    matchedCount: summary.matchedCount,
    executedCount: summary.executedCount,
    skippedCount: summary.skippedCount,
    failedCount: summary.failedCount,
    timedOutCount: summary.timedOutCount,
    payloadHash: summary.payloadHash,
    warnings: summary.warnings,
    results: summary.results.map((result) => ({
      resourceId: result.resourceId,
      name: result.name,
      status: result.status,
      ...(result.commandHash !== undefined ? { commandHash: result.commandHash } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      elapsedMs: result.elapsedMs,
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
    })),
  };
}
