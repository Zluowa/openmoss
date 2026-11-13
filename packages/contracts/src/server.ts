import { Effect, Schema, SchemaTransformation } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { KeybindingCommand, KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import {
  ModelSelection,
  ProviderKind,
  ProviderStartOptions,
  SupportedProviderKind,
} from "./orchestration";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance";
import { KeepAwakeMode, ServerSettingsPatch, ServerSettingsView } from "./settings";
import { ExecutionEnvironmentDescriptor } from "./environment";
import { AutomationCompletionPolicy, AutomationMode, AutomationSchedule } from "./automation";

export const SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BASE64_CHARS = 14_000_000;
const SERVER_VOICE_OPERATION_ID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
);

/** Owner-only diagnostic pages reuse the provider diagnostic readers and sanitizer. */
export const ServerReadThreadDiagnosticsInput = Schema.Struct({
  source: Schema.Literals(["events", "runtime"]),
  threadId: ThreadId.check(Schema.isMaxLength(256)),
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  eventTypes: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
      Schema.isMaxLength(64),
    ),
  ),
  turnId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  payloadMode: Schema.optional(Schema.Literals(["none", "summary", "full"])),
  includeDetails: Schema.optional(Schema.Boolean),
});
export type ServerReadThreadDiagnosticsInput = typeof ServerReadThreadDiagnosticsInput.Type;

/**
 * RPC JSON codecs must describe JSON values explicitly. `Schema.Unknown`
 * has no JSON representation and encodes successful pages as null.
 * The existing diagnostic readers own payload redaction and bounded detail.
 */
export const ServerReadThreadDiagnosticsResult = Schema.Struct({
  threadId: ThreadId.check(Schema.isMaxLength(256)),
  events: Schema.Array(Schema.Json).check(Schema.isMaxLength(200)),
  coverage: Schema.Union([
    Schema.Struct({
      source: Schema.Literal("orchestration_events"),
      highWaterSequence: NonNegativeInt,
      durableSourceComplete: Schema.Literal(true),
      pageHasOlder: Schema.Boolean,
      coalescingScanTruncated: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({
      source: Schema.Literal("provider_runtime_events"),
      highWaterSequence: NonNegativeInt,
      oldestRetainedSequence: Schema.NullOr(NonNegativeInt),
      retainedForThread: NonNegativeInt,
      globalAcceptedEventCap: PositiveInt,
      sourceComplete: Schema.Literal(false),
      pageHasOlder: Schema.Boolean,
    }),
  ]),
  nextCursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  requestedLimit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  appliedLimit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type ServerReadThreadDiagnosticsResult = typeof ServerReadThreadDiagnosticsResult.Type;

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderLoginStatus = Schema.Literals([
  "starting",
  "waiting_browser",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ServerProviderLoginStatus = typeof ServerProviderLoginStatus.Type;

const ServerProviderLoginState = Schema.Struct({
  status: ServerProviderLoginStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});

/**
 * Whether a person can use this agent right now, decided by the server so every
 * surface (picker, settings) shows the same answer.
 *
 * - `ready`: the binary (the person's own install, one Moss installed, or the one
 *   Moss ships) runs and it has a usable sign-in, or needs none.
 * - `needsLogin`: installed, but needs a sign-in first. `reason` is
 *   `moss-sign-in` for Moss's own provider and `agent-sign-in` for a local CLI.
 * - `notInstalled`: no binary. `install` says what the one 安装 button does:
 *   `oneClick` runs `server.installProvider`; `externalPage` opens `installUrl`
 *   (the agent's official install page) in the system browser.
 * - `error`: installed but unusable; `reason` is one of `failed-to-run`,
 *   `version-unsupported`, `moss-runtime-damaged`, `moss-unavailable`,
 *   `home-unavailable`, `needs-git-bash`, `unsupported-driver`, `disabled`.
 * - `checking`: the first probe has not finished.
 *
 * `reason` is a stable code for the web to translate. It is never shown raw and
 * never holds a machine path, a command or a secret.
 */
export const ServerProviderReadinessState = Schema.Literals([
  "ready",
  "needsLogin",
  "notInstalled",
  "error",
  "checking",
]);
export type ServerProviderReadinessState = typeof ServerProviderReadinessState.Type;

export const ServerProviderInstallMode = Schema.Literals(["oneClick", "externalPage"]);
export type ServerProviderInstallMode = typeof ServerProviderInstallMode.Type;

export const ServerProviderReadiness = Schema.Struct({
  state: ServerProviderReadinessState,
  install: Schema.optional(ServerProviderInstallMode),
  installUrl: Schema.optional(TrimmedNonEmptyString),
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderReadiness = typeof ServerProviderReadiness.Type;

/**
 * Progress of a one-click install, pushed with the provider statuses. `source`
 * is where the package came from (`cn-mirror` = npmmirror, `official` = publisher).
 * A failed install's `reason` is one of `npm-unavailable`, `download-failed`,
 * `verify-failed`, `cleanup-unproven`, `timed-out`, `not-installable`, `disabled`.
 */
export const ServerProviderInstallState = Schema.Struct({
  status: Schema.Literals(["queued", "running", "succeeded", "failed"]),
  phase: Schema.NullOr(Schema.Literals(["installing", "verifying"])),
  source: Schema.NullOr(Schema.Literals(["official", "cn-mirror"])),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  version: Schema.NullOr(TrimmedNonEmptyString),
  reason: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderInstallState = typeof ServerProviderInstallState.Type;

const ServerProviderStatusWire = Schema.Struct({
  provider: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  readiness: Schema.optional(ServerProviderReadiness),
  availability: Schema.optional(Schema.Literals(["available", "unavailable"])),
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  authStatus: ServerProviderAuthStatus,
  authType: Schema.optional(TrimmedNonEmptyString),
  authLabel: Schema.optional(TrimmedNonEmptyString),
  voiceTranscriptionAvailable: Schema.optional(Schema.Boolean),
  supportsAutoRuntimeMode: Schema.optional(Schema.Boolean),
  autoRuntimeModeBinaryPath: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  versionAdvisory: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["unknown", "current", "behind_latest"]),
      currentVersion: Schema.NullOr(TrimmedNonEmptyString),
      latestVersion: Schema.NullOr(TrimmedNonEmptyString),
      // False when Moss has no registry to learn the latest version from (a
      // self-updating CLI like `cursor-agent`), so `status` can never leave
      // "unknown" no matter how current the install is. Absent on older servers,
      // where callers must assume a source exists and keep the legacy behavior.
      latestVersionKnowable: Schema.optional(Schema.Boolean),
      // Where this machine's version checks and updates download from. Absent means official.
      packageChannel: Schema.optional(Schema.Literals(["official", "cn-mirror"])),
      updateCommand: Schema.NullOr(TrimmedNonEmptyString),
      canUpdate: Schema.Boolean,
      checkedAt: Schema.NullOr(IsoDateTime),
      message: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  updateState: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["idle", "queued", "running", "succeeded", "failed", "unchanged"]),
      startedAt: Schema.NullOr(IsoDateTime),
      finishedAt: Schema.NullOr(IsoDateTime),
      message: Schema.NullOr(TrimmedNonEmptyString),
      output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
    }),
  ),
  loginState: Schema.optionalKey(ServerProviderLoginState),
  installState: Schema.optionalKey(ServerProviderInstallState),
});

const ServerProviderStatusSource = Schema.Struct({
  provider: Schema.optionalKey(ProviderDriverKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
  driver: Schema.optionalKey(ProviderDriverKind),
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  readiness: Schema.optional(ServerProviderReadiness),
  availability: Schema.optional(Schema.Literals(["available", "unavailable"])),
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  authStatus: ServerProviderAuthStatus,
  authType: Schema.optional(TrimmedNonEmptyString),
  authLabel: Schema.optional(TrimmedNonEmptyString),
  voiceTranscriptionAvailable: Schema.optional(Schema.Boolean),
  supportsAutoRuntimeMode: Schema.optional(Schema.Boolean),
  autoRuntimeModeBinaryPath: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  versionAdvisory: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["unknown", "current", "behind_latest"]),
      currentVersion: Schema.NullOr(TrimmedNonEmptyString),
      latestVersion: Schema.NullOr(TrimmedNonEmptyString),
      latestVersionKnowable: Schema.optional(Schema.Boolean),
      // Where this machine's version checks and updates download from. Absent means official.
      packageChannel: Schema.optional(Schema.Literals(["official", "cn-mirror"])),
      updateCommand: Schema.NullOr(TrimmedNonEmptyString),
      canUpdate: Schema.Boolean,
      checkedAt: Schema.NullOr(IsoDateTime),
      message: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  updateState: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["idle", "queued", "running", "succeeded", "failed", "unchanged"]),
      startedAt: Schema.NullOr(IsoDateTime),
      finishedAt: Schema.NullOr(IsoDateTime),
      message: Schema.NullOr(TrimmedNonEmptyString),
      output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
    }),
  ),
  loginState: Schema.optionalKey(ServerProviderLoginState),
  installState: Schema.optionalKey(ServerProviderInstallState),
});

export const ServerProviderStatus = ServerProviderStatusSource.pipe(
  Schema.decodeTo(
    ServerProviderStatusWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        const driver = raw.driver ?? raw.provider;
        const instanceId = raw.instanceId ?? driver;
        return Effect.succeed({
          ...raw,
          provider: driver,
          driver,
          instanceId,
        } as typeof ServerProviderStatusWire.Encoded);
      },
      encode: (value) => Effect.succeed(value as typeof ServerProviderStatusSource.Encoded),
    }),
  ),
);
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

export type ServerProviderVersionAdvisory = NonNullable<ServerProviderStatus["versionAdvisory"]>;
export type ServerProviderUpdateState = NonNullable<ServerProviderStatus["updateState"]>;
export type ServerProviderLoginState = NonNullable<ServerProviderStatus["loginState"]>;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerConfig = Schema.Struct({
  /** Explicitly configured secure address; a loopback listener is not shareable. */
  shareableOrigin: Schema.optional(TrimmedNonEmptyString),
  /**
   * Plain-HTTP origins a device on the same network can open, present only while
   * the server listens beyond loopback (for example `--host 0.0.0.0`).
   */
  lanOrigins: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  cwd: TrimmedNonEmptyString,
  homeDir: Schema.optional(TrimmedNonEmptyString),
  chatWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  studioWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  groupsWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  worktreesDir: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  // The shipped bindings, so the shortcut editor can tell customized commands from
  // untouched ones and give a new binding its command's default condition.
  defaultKeybindings: Schema.optional(ResolvedKeybindingsConfig),
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerManagedWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type ServerManagedWorktree = typeof ServerManagedWorktree.Type;

export const ServerListWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(ServerManagedWorktree),
});
export type ServerListWorktreesResult = typeof ServerListWorktreesResult.Type;

export const ServerProviderUsageLimit = Schema.Struct({
  windowId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  window: TrimmedNonEmptyString,
  usedPercent: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageLimit = typeof ServerProviderUsageLimit.Type;

export const ServerProviderUsageLine = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
  subtitle: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageLine = typeof ServerProviderUsageLine.Type;

// Lifecycle of a live provider usage fetch. Absent status is treated as "ok" so
// existing local-archive snapshots stay valid without setting it.
//   ok          – fetched fresh usage from the provider backend
//   needs-auth  – no/expired credential, or the backend rejected the token (read-only mode never refreshes)
//   unsupported – the provider has no fetchable usage source for the current auth (e.g. API-key-only)
//   error       – the fetch failed unexpectedly (network/parse); detail carries the reason
export const ProviderUsageStatus = Schema.Literals(["ok", "needs-auth", "unsupported", "error"]);
export type ProviderUsageStatus = typeof ProviderUsageStatus.Type;

// Account usage is intentionally separate from request billing. Provider-authoritative totals
// are safe to display as account statistics, while archive-derived totals are only lower bounds
// and must never be promoted into billable deltas.
export const ProviderUsageAuthority = Schema.Literals([
  "authoritative",
  "lower-bound",
  "unavailable",
]);
export type ProviderUsageAuthority = typeof ProviderUsageAuthority.Type;

// Coverage of bounded local-archive reads. `complete: false` means any totals in
// `usageLines` are explicitly lower bounds; consumers must surface `detail` with them.
export const ServerProviderUsageArchiveScan = Schema.Struct({
  complete: Schema.Boolean,
  filesDiscovered: NonNegativeInt,
  filesSelected: NonNegativeInt,
  filesResolved: NonNegativeInt,
  filesIncomplete: NonNegativeInt,
  bytesRead: NonNegativeInt,
  recordsInspected: NonNegativeInt,
});
export type ServerProviderUsageArchiveScan = typeof ServerProviderUsageArchiveScan.Type;

export const ServerCodexResetCreditStatus = Schema.Literals([
  "available",
  "redeeming",
  "redeemed",
  "unknown",
]);
export type ServerCodexResetCreditStatus = typeof ServerCodexResetCreditStatus.Type;

export const ServerCodexResetCredit = Schema.Struct({
  id: TrimmedNonEmptyString,
  status: Schema.optional(ServerCodexResetCreditStatus),
  grantedAt: Schema.optional(IsoDateTime),
  expiresAt: Schema.optional(IsoDateTime),
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type ServerCodexResetCredit = typeof ServerCodexResetCredit.Type;

export const ServerCodexResetCredits = Schema.Struct({
  accountId: Schema.optional(TrimmedNonEmptyString),
  canUse: Schema.optional(Schema.Boolean),
  availableCount: NonNegativeInt,
  credits: Schema.optional(Schema.Array(ServerCodexResetCredit)),
});
export type ServerCodexResetCredits = typeof ServerCodexResetCredits.Type;

export const CodexResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type CodexResetCreditOutcome = typeof CodexResetCreditOutcome.Type;

export const ServerConsumeCodexResetCreditInput = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  creditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerConsumeCodexResetCreditInput = typeof ServerConsumeCodexResetCreditInput.Type;

export const ServerConsumeCodexResetCreditResult = Schema.Struct({
  outcome: CodexResetCreditOutcome,
});
export type ServerConsumeCodexResetCreditResult = typeof ServerConsumeCodexResetCreditResult.Type;

export const ServerProviderUsageSnapshot = Schema.Struct({
  provider: ProviderKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  // Upstream alias for the same account route; readers accept either field.
  instanceId: Schema.optional(ProviderInstanceId),
  // Opaque, server-derived identity. It deliberately cannot contain the provider's account id.
  accountRef: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(/^acct_[A-Za-z0-9_-]+$/)),
  ),
  updatedAt: IsoDateTime,
  limits: Schema.Array(ServerProviderUsageLimit),
  usageLines: Schema.Array(ServerProviderUsageLine),
  source: TrimmedNonEmptyString,
  status: Schema.optional(ProviderUsageStatus),
  planName: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  archiveScan: Schema.optional(ServerProviderUsageArchiveScan),
  usageAuthority: Schema.optional(ProviderUsageAuthority),
  resetCredits: Schema.optional(ServerCodexResetCredits),
  // True when this is a re-served last-good snapshot (e.g. the provider is rate-limiting live
  // fetches) rather than a fresh read; `updatedAt` then still reflects the original fetch time.
  stale: Schema.optional(Schema.Boolean),
});
export type ServerProviderUsageSnapshot = typeof ServerProviderUsageSnapshot.Type;

export const ServerGetProviderUsageSnapshotInput = Schema.Struct({
  provider: ProviderKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  // Legacy wire compatibility only. Filesystem authority comes from the
  // server-owned provider settings, never from this renderer-supplied value.
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type ServerGetProviderUsageSnapshotInput = typeof ServerGetProviderUsageSnapshotInput.Type;

export const ServerGetProviderUsageSnapshotResult = Schema.NullOr(ServerProviderUsageSnapshot);
export type ServerGetProviderUsageSnapshotResult = typeof ServerGetProviderUsageSnapshotResult.Type;

// Batch live-usage fetch for supported providers, powering the Settings → Usage section and
// provider-scoped usage chips. Unfiltered requests return one entry per enabled supported instance
// (including needs-auth/error) so the UI can render a row each.
export const ServerListProviderUsageInput = Schema.Struct({
  forceRefresh: Schema.optional(Schema.Boolean),
  provider: Schema.optional(SupportedProviderKind),
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type ServerListProviderUsageInput = typeof ServerListProviderUsageInput.Type;

export const ServerListProviderUsageResult = Schema.Array(ServerProviderUsageSnapshot);
export type ServerListProviderUsageResult = typeof ServerListProviderUsageResult.Type;

export const ServerLocalServerAddress = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: PositiveInt,
  family: Schema.Literals(["tcp4", "tcp6", "tcp"]),
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerLocalServerAddress = typeof ServerLocalServerAddress.Type;

export const ServerLocalServerProcess = Schema.Struct({
  id: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: Schema.optional(PositiveInt),
  command: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  pageTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  // Working directory of the listening process, when resolvable. Surfaced in the
  // UI and used to attribute manually-started dev servers to a project by folder.
  // Windows can't read another process's working directory cheaply, so there it is
  // the project folder named on the server's (or its parents') command line.
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  // True when the Moss server is among the process's ancestors: an agent's shell or a
  // Moss terminal started it.
  launchedByMoss: Schema.optional(Schema.Boolean),
  args: Schema.String.check(Schema.isMaxLength(1_000)),
  ports: Schema.Array(PositiveInt),
  addresses: Schema.Array(ServerLocalServerAddress),
  isStoppable: Schema.Boolean,
  stopDisabledReason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ServerLocalServerProcess = typeof ServerLocalServerProcess.Type;

export const ServerListLocalServersResult = Schema.Struct({
  generatedAt: IsoDateTime,
  servers: Schema.Array(ServerLocalServerProcess),
});
export type ServerListLocalServersResult = typeof ServerListLocalServersResult.Type;

export const ServerStopLocalServerInput = Schema.Struct({
  pid: PositiveInt,
  port: PositiveInt,
});
export type ServerStopLocalServerInput = typeof ServerStopLocalServerInput.Type;

export const ServerStopLocalServerResult = Schema.Struct({
  pid: PositiveInt,
  stopped: Schema.Boolean,
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ServerStopLocalServerResult = typeof ServerStopLocalServerResult.Type;

export const ServerDiagnosticsMemory = Schema.Struct({
  rssBytes: NonNegativeInt,
  heapTotalBytes: NonNegativeInt,
  heapUsedBytes: NonNegativeInt,
  externalBytes: NonNegativeInt,
  arrayBuffersBytes: NonNegativeInt,
});
export type ServerDiagnosticsMemory = typeof ServerDiagnosticsMemory.Type;

export const ServerDiagnosticsChildProcess = Schema.Struct({
  pid: NonNegativeInt,
  ppid: NonNegativeInt,
  rssBytes: NonNegativeInt,
  virtualSizeBytes: NonNegativeInt,
  command: Schema.String,
  args: Schema.String,
});
export type ServerDiagnosticsChildProcess = typeof ServerDiagnosticsChildProcess.Type;

export const ServerDiagnosticsResult = Schema.Struct({
  generatedAt: IsoDateTime,
  process: Schema.Struct({
    pid: NonNegativeInt,
    uptimeSeconds: NonNegativeInt,
    memory: ServerDiagnosticsMemory,
  }),
  childProcesses: Schema.Array(ServerDiagnosticsChildProcess),
  childProcessTotalCount: NonNegativeInt,
  childProcessTotalRssBytes: NonNegativeInt,
  projection: Schema.Struct({
    projectCount: NonNegativeInt,
    threadCount: NonNegativeInt,
  }),
});
export type ServerDiagnosticsResult = typeof ServerDiagnosticsResult.Type;

export const ServerVoicePrewarmInput = Schema.Struct({
  provider: ProviderKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  providerOptions: Schema.optional(ProviderStartOptions),
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
});
export type ServerVoicePrewarmInput = typeof ServerVoicePrewarmInput.Type;

export const ServerVoicePrewarmResult = Schema.Struct({
  ready: Schema.Boolean,
});
export type ServerVoicePrewarmResult = typeof ServerVoicePrewarmResult.Type;

export const ServerVoiceTranscriptionInput = Schema.Struct({
  provider: ProviderKind,
  operationId: Schema.optional(SERVER_VOICE_OPERATION_ID),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  providerOptions: Schema.optional(ProviderStartOptions),
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sampleRateHz: NonNegativeInt,
  durationMs: NonNegativeInt,
  audioBase64: TrimmedNonEmptyString.check(
    Schema.isMaxLength(SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BASE64_CHARS),
  ),
});
export type ServerVoiceTranscriptionInput = typeof ServerVoiceTranscriptionInput.Type;

export const ServerVoiceTranscriptionResult = Schema.Struct({
  text: TrimmedNonEmptyString,
});
export type ServerVoiceTranscriptionResult = typeof ServerVoiceTranscriptionResult.Type;

// Compact, stateless recap generation. The caller owns debounce/cache policy so
// this endpoint never participates in the hot transcript projection path.
export const ServerGenerateThreadRecapInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  previousRecap: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
  newMaterial: Schema.String.check(Schema.isMaxLength(16_000)),
  currentState: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
  providerOptions: Schema.optional(ProviderStartOptions),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  textGenerationModelSelection: Schema.optional(ModelSelection),
});
export type ServerGenerateThreadRecapInput = typeof ServerGenerateThreadRecapInput.Type;

export const ServerGenerateThreadRecapResult = Schema.Struct({
  recap: TrimmedNonEmptyString,
});
export type ServerGenerateThreadRecapResult = typeof ServerGenerateThreadRecapResult.Type;

// Schema-validated automation intent extraction for composer-triggered creation.
// The UI still owns confirmation/error copy; this result only describes what the model understood.
export const ServerAutomationIntentMissingField = Schema.Literals([
  "schedule",
  "taskPrompt",
  "name",
  "mode",
]);
export type ServerAutomationIntentMissingField = typeof ServerAutomationIntentMissingField.Type;

export const ServerGenerateAutomationIntentInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  defaultMode: Schema.optional(AutomationMode),
  nowIso: IsoDateTime,
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
  providerOptions: Schema.optional(ProviderStartOptions),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString),
  textGenerationModelSelection: Schema.optional(ModelSelection),
});
export type ServerGenerateAutomationIntentInput = typeof ServerGenerateAutomationIntentInput.Type;

export const ServerGenerateAutomationIntentResult = Schema.Struct({
  isAutomation: Schema.Boolean,
  confidence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(1),
  ),
  language: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  name: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  taskPrompt: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64_000))),
  schedule: Schema.NullOr(AutomationSchedule),
  mode: Schema.NullOr(AutomationMode),
  maxIterations: Schema.optional(Schema.NullOr(PositiveInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  completionPolicy: Schema.optional(AutomationCompletionPolicy).pipe(
    Schema.withDecodingDefault(() => ({ type: "none" as const })),
  ),
  missingFields: Schema.Array(ServerAutomationIntentMissingField),
  needsConfirmation: Schema.Boolean,
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});
export type ServerGenerateAutomationIntentResult = typeof ServerGenerateAutomationIntentResult.Type;

export const ServerUpsertKeybindingInput = Schema.Struct({
  rule: KeybindingRule,
  replacing: Schema.optional(KeybindingRule),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const MAX_KEYBINDING_EDITS = 64;

/**
 * One step of a shortcut-editor change. `set` adds a binding (replacing exactly
 * `replacing` when given, leaving the command's other bindings alone), `remove` drops
 * one binding and leaves the command unassigned when it was the last, and `reset`
 * restores the shipped bindings for one command or, without `command`, for every
 * built-in command.
 */
export const ServerKeybindingEdit = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("set"),
    rule: KeybindingRule,
    replacing: Schema.optional(KeybindingRule),
  }),
  Schema.Struct({ type: Schema.Literal("remove"), rule: KeybindingRule }),
  Schema.Struct({ type: Schema.Literal("reset"), command: Schema.optional(KeybindingCommand) }),
]);
export type ServerKeybindingEdit = typeof ServerKeybindingEdit.Type;

export const ServerEditKeybindingsInput = Schema.Struct({
  edits: Schema.Array(ServerKeybindingEdit).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_KEYBINDING_EDITS),
  ),
});
export type ServerEditKeybindingsInput = typeof ServerEditKeybindingsInput.Type;

export const ServerEditKeybindingsResult = ServerUpsertKeybindingResult;
export type ServerEditKeybindingsResult = typeof ServerEditKeybindingsResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerProviderStatusesUpdatedPayload = Schema.Struct({
  providers: ServerProviderStatuses,
});
export type ServerProviderStatusesUpdatedPayload = typeof ServerProviderStatusesUpdatedPayload.Type;

export const ServerSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettingsView,
});
export type ServerSettingsUpdatedPayload = typeof ServerSettingsUpdatedPayload.Type;

export const ServerKeepAwakeState = Schema.Struct({
  available: Schema.Boolean,
  mode: KeepAwakeMode,
  active: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type ServerKeepAwakeState = typeof ServerKeepAwakeState.Type;

export const ServerKeepAwakeUpdatedPayload = Schema.Struct({
  keepAwake: ServerKeepAwakeState,
});
export type ServerKeepAwakeUpdatedPayload = typeof ServerKeepAwakeUpdatedPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  homeDir: Schema.optional(TrimmedNonEmptyString),
  chatWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  studioWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  groupsWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("welcome"),
    payload: ServerLifecycleWelcomePayload,
  }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    payload: Schema.Struct({
      at: IsoDateTime,
    }),
  }),
  // Only older servers send this: it reported the age-based archiving Moss no longer does.
  // Kept so a newer client still reads their lifecycle stream; nothing acts on it.
  Schema.Struct({
    type: Schema.Literal("maintenance"),
    payload: Schema.Struct({
      task: Schema.Literal("thread-retention"),
      state: Schema.Literals(["started", "progress", "completed", "failed"]),
      at: IsoDateTime,
      deletedCount: Schema.optional(Schema.Number),
      totalCount: Schema.optional(Schema.Number),
      error: Schema.optional(Schema.String),
    }),
  }),
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    config: ServerConfig,
  }),
  Schema.Struct({
    type: Schema.Literal("configUpdated"),
    payload: ServerConfigUpdatedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("providerStatuses"),
    payload: ServerProviderStatusesUpdatedPayload,
  }),
  Schema.Struct({
    type: Schema.Literal("settingsUpdated"),
    payload: ServerSettingsUpdatedPayload,
  }),
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerRefreshProvidersResult = ServerProviderStatusesUpdatedPayload;
export type ServerRefreshProvidersResult = typeof ServerRefreshProvidersResult.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderKind,
  instanceId: Schema.optional(ProviderInstanceId),
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

export class ServerProviderUpdateError extends Schema.TaggedErrorClass<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderKind,
    instanceId: Schema.optional(ProviderInstanceId),
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    const target = this.instanceId ? `${this.provider}/${this.instanceId}` : this.provider;
    return `Provider update failed for ${target}: ${this.reason}`;
  }
}

export const ServerProviderUpdateResult = ServerProviderStatusesUpdatedPayload;
export type ServerProviderUpdateResult = typeof ServerProviderUpdateResult.Type;

/** One-click install of an agent CLI into a Moss-managed folder; progress arrives as `installState`. */
export const ServerProviderInstallInput = Schema.Struct({
  provider: ProviderKind,
  instanceId: Schema.optional(ProviderInstanceId),
});
export type ServerProviderInstallInput = typeof ServerProviderInstallInput.Type;

export class ServerProviderInstallError extends Schema.TaggedErrorClass<ServerProviderInstallError>()(
  "ServerProviderInstallError",
  {
    provider: ProviderKind,
    instanceId: Schema.optional(ProviderInstanceId),
    reason: TrimmedNonEmptyString,
    /** A PROVIDER_INSTALLATION_ERROR_CODES value the settings UI explains in plain words. */
    code: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const target = this.instanceId ? `${this.provider}/${this.instanceId}` : this.provider;
    return `Provider install failed for ${target}: ${this.reason}`;
  }
}

export const ServerProviderInstallResult = ServerProviderStatusesUpdatedPayload;
export type ServerProviderInstallResult = typeof ServerProviderInstallResult.Type;

/** Why managing a Moss-installed agent copy was refused; clients localize by code. */
export const PROVIDER_INSTALLATION_ERROR_CODES = {
  agentEnabled: "PROVIDER_INSTALLATION_AGENT_ENABLED",
  sessionsRunning: "PROVIDER_INSTALLATION_SESSIONS_RUNNING",
  busy: "PROVIDER_INSTALLATION_BUSY",
  inUse: "PROVIDER_INSTALLATION_IN_USE",
  notFound: "PROVIDER_INSTALLATION_NOT_FOUND",
  modified: "PROVIDER_INSTALLATION_MODIFIED",
  changesDisabled: "PROVIDER_INSTALLATION_CHANGES_DISABLED",
} as const;
export type ProviderInstallationErrorCode =
  (typeof PROVIDER_INSTALLATION_ERROR_CODES)[keyof typeof PROVIDER_INSTALLATION_ERROR_CODES];

export const ServerProviderInstallationInput = Schema.Struct({
  provider: ProviderKind,
  action: Schema.Literals(["inspect", "uninstall"]),
});
export type ServerProviderInstallationInput = typeof ServerProviderInstallationInput.Type;
export const ServerProviderInstallationResult = Schema.Struct({
  provider: ProviderKind,
  source: Schema.Literals(["bundled", "moss", "external", "missing"]),
  path: Schema.NullOr(TrimmedNonEmptyString),
  managedPath: Schema.NullOr(TrimmedNonEmptyString),
  canUninstall: Schema.Boolean,
  removed: Schema.Boolean,
});
export type ServerProviderInstallationResult = typeof ServerProviderInstallationResult.Type;

export const ServerProviderLoginInput = Schema.Struct({
  provider: ProviderKind,
  instanceId: ProviderInstanceId,
});
export type ServerProviderLoginInput = typeof ServerProviderLoginInput.Type;

export class ServerProviderLoginError extends Schema.TaggedErrorClass<ServerProviderLoginError>()(
  "ServerProviderLoginError",
  {
    provider: ProviderKind,
    instanceId: ProviderInstanceId,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Provider sign-in failed for ${this.provider}/${this.instanceId}: ${this.reason}`;
  }
}

export const ServerProviderLoginResult = ServerProviderStatusesUpdatedPayload;
export type ServerProviderLoginResult = typeof ServerProviderLoginResult.Type;

export const ServerGetSettingsResult = ServerSettingsView;
export type ServerGetSettingsResult = typeof ServerGetSettingsResult.Type;

export const ServerGetEnvironmentResult = ExecutionEnvironmentDescriptor;
export type ServerGetEnvironmentResult = typeof ServerGetEnvironmentResult.Type;

export const ServerUpdateSettingsInput = ServerSettingsPatch;
export type ServerUpdateSettingsInput = typeof ServerUpdateSettingsInput.Type;

export const ServerUpdateSettingsResult = ServerSettingsView;
export type ServerUpdateSettingsResult = typeof ServerUpdateSettingsResult.Type;

/** Aggregate runtime counters only: safe for the unauthenticated health route. */
const RuntimeMilliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const ServerRuntimeStatus = Schema.Struct({
  available: Schema.Boolean,
  sampleWindowMs: RuntimeMilliseconds,
  sampleCount: NonNegativeInt,
  delayP50Ms: RuntimeMilliseconds,
  delayP99Ms: RuntimeMilliseconds,
  delayMaxMs: RuntimeMilliseconds,
  utilization: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  stallWindowCount: NonNegativeInt,
  maxStallMs: RuntimeMilliseconds,
  /** Ambiguous suspend/scheduling gaps excluded from active-stall percentiles. */
  discardedIdleGapCount: Schema.optional(NonNegativeInt),
  discardedIdleGapMs: Schema.optional(RuntimeMilliseconds),
  lastStall: Schema.NullOr(
    Schema.Struct({ durationMs: RuntimeMilliseconds, ageMs: RuntimeMilliseconds }),
  ),
});
export type ServerRuntimeStatus = typeof ServerRuntimeStatus.Type;
