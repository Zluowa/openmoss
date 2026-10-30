import path from "node:path";
/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import {
  AsyncUserInputQuestions,
  type ChatAttachment,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ModelSelection,
  type ProviderComposerCapabilities,
  type ProviderEvent,
  type ProviderAddMarketplaceResult,
  type ProviderCompleteAppConnectionResult,
  type ProviderInstallPluginResult,
  type ProviderListAppsResult,
  type ProviderListModelsResult,
  type ProviderListPluginsResult,
  type ProviderReadAppConnectorResult,
  type ProviderReadAppConnectorTermsResult,
  type ProviderReadAppToolsResult,
  type ProviderReadPluginResult,
  CodexMcpToolCallProjection,
  CodexWebMcpCall,
  type CodexMcpAppDescriptor,
  type CodexMcpToolCallProjection as CodexMcpToolCallProjectionData,
  type CodexWebMcpCall as CodexWebMcpCallData,
  type McpProjectionAnnotations,
  type McpToolResultContentBlock,
  CODEX_MCP_TOOL_CALL_PROJECTION_KIND,
  CODEX_MCP_TOOL_CALL_PROJECTION_VERSION,
  type ProviderRemoveMarketplaceResult,
  type ProviderSetAppEnabledResult,
  type ProviderSetPluginEnabledResult,
  type ProviderStartAppConnectionResult,
  type ProviderUninstallPluginResult,
  type ProviderUpgradeMarketplaceResult,
  type ProviderSendTurnInput,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderInstanceId,
  type ServerVoiceTranscriptionResult,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderApprovalDecision,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Cause, Effect, Layer, Option, Queue, Schema, ServiceMap, Stream } from "effect";
import { isCodexDiagnosticWarningMessage } from "@synara/shared/codexDiagnostics";
import { isMossAppsServer, mossAppsToolTitle } from "@synara/shared/mossAppsPresentation";
import { decodeSubagentActivity, normalizeSubagentToolData } from "@synara/shared/subagentTool";
import { NEXT_MESSAGE_PREDICTION_CODEX_REASONING_EFFORT } from "@synara/shared/nextMessagePrediction";
import { assertServerResolvedVoiceRouteAuthority } from "../../voiceTranscriptionGateway.ts";
import { sanitizeUserFacingErrorMessage } from "@synara/shared/errorMessages";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  CODEX_MANUAL_COMPACTION_MARKER,
  CodexAppServerManager,
  CodexSessionAuthInvalidatedError,
  parseCodexUserInputQuestions,
  readResumeCursorThreadId,
  type CodexAppServerSendTurnInput,
  type CodexAppServerStartSessionInput,
  type CodexSessionInspection,
} from "../../codexAppServerManager.ts";
import {
  evaluateAcpTurnIdleTick,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  evaluateCodexMossFirstActivityTick,
  isCodexMossFirstActivityProgressEvent,
  resolveCodexMossFirstActivityTimeoutMs,
} from "../codexMossFirstActivityWatchdog.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { sanitizeDiagnosticValue } from "../../agentGateway/diagnosticSanitizer.ts";
import {
  acquireAgentGatewaySessionLease,
  AGENT_GATEWAY_NO_CAPABILITIES,
  captureAgentGatewayCapabilityInput,
} from "../../agentGateway/sessionLease.ts";
import { filterProviderPromptImageAttachments } from "../promptAttachments.ts";
import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import {
  codexGeneratedImageArtifact,
  type CodexGeneratedImageHomeCandidate,
  type CodexGeneratedImageHomeContext,
  extractCodexGeneratedImageReference,
  firstStringValue,
  isCodexGeneratedImageItemType,
  sanitizeNestedCodexGeneratedImagePayloads,
} from "../../codexGeneratedImages.ts";
import {
  CodexSessionStartError,
  codexErrorMessage,
  isNonFatalCodexErrorMessage,
} from "../../codexErrorClassification.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { readManagedCodexHomeAuthority } from "../../account/mossManagedHomeAuthority.ts";
import { resolveCodexServiceTier } from "../../codexServiceTier.ts";
import { makeRuntimeTaskListItem } from "../runtimeTaskList.ts";
import { extractProposedPlanMarkdown } from "../planMode.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { ensureMossBundledSkills, mossSkillsDir } from "../skillsCatalog.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import { assignDerivedProviderRuntimeEventIds } from "../providerRuntimeEventIdentity.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES,
} from "../providerRuntimeEventIngress.ts";
import {
  makeUnmappedProviderEventGate,
  sanitizeUnmappedProviderData,
  sanitizeUnmappedProviderDetail,
  sanitizeUnmappedProviderEvent,
  sanitizeUnmappedProviderNativeType,
} from "../unmappedProviderEvents.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "codex" as const;
const CODEX_RUNTIME_WARNING_METHODS = new Set(["guardianWarning", "warning"]);

// Backstop for an alive-but-silent codex app-server: if a turn produces no
// activity at all for this long, abort it instead of showing "Working" forever.
// Every turn-scoped event (reasoning, tool output, deltas) resets the clock and
// a pending question/approval pauses it, so only a wedged child trips this.
// Generous by design; override with MOSS_CODEX_TURN_IDLE_TIMEOUT_MS.
const CODEX_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "MOSS_CODEX_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 900_000,
});
const CODEX_TURN_WATCHDOG_INTERVAL_MS = 15_000;

const CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_MS = resolveCodexMossFirstActivityTimeoutMs();

interface CodexTurnWatchdogEntry {
  readonly turnId: TurnId;
  lastActivityAt: number;
  firstActivityStartedAt: number | null;
}

const stampEvent = (event: ProviderEvent, instanceId: string | undefined): ProviderEvent =>
  event.providerInstanceId === undefined && instanceId
    ? { ...event, providerInstanceId: instanceId }
    : event;

type CodexRuntimeIngressItem = {
  readonly nativeEvent: ProviderEvent;
  readonly inspect: () => Promise<CodexSessionInspection | undefined>;
  readonly isAuthRejected: () => boolean;
  readonly validationKey: object | undefined;
  readonly rejectInspection: () => void;
  readonly trustedClose: boolean;
  readonly runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>;
  readonly bytes: number;
};

function compactCodexNativeEventForIngress(event: ProviderEvent): {
  readonly event: ProviderEvent;
  readonly bytes: number;
} {
  let originalBytes: number;
  try {
    originalBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    originalBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES + 1;
  }
  if (originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES) {
    return { event, bytes: originalBytes };
  }
  const compactedEvent: ProviderEvent = {
    ...event,
    payload: {
      mossTruncated: true,
      reason: "Codex native event exceeded the callback ingress size limit",
      originalBytes,
    },
  };
  let compactedBytes: number;
  try {
    compactedBytes = Buffer.byteLength(JSON.stringify(compactedEvent), "utf8");
  } catch {
    compactedBytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES;
  }
  return { event: compactedEvent, bytes: compactedBytes };
}

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const CODEX_MOSS_MANAGED_INSTANCE_ID_PREFIX = "codex_moss";

function isCodexMossManagedProviderInstanceId(
  providerInstanceId: ProviderInstanceId | undefined,
): boolean {
  return (
    providerInstanceId?.toLowerCase().startsWith(CODEX_MOSS_MANAGED_INSTANCE_ID_PREFIX) ?? false
  );
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return sanitizeUserFacingErrorMessage(cause.message, fallback);
  }
  return fallback;
}

function composeCodexInputWithFileAttachments(input: {
  readonly input: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
}): string | undefined {
  return appendFileAttachmentsPromptBlock({
    text: input.input,
    attachments: input.attachments,
    attachmentsDir: input.attachmentsDir,
    include: "all-files",
  });
}

function codexModelSelectionOverrides(
  modelSelection: ModelSelection | undefined,
): Pick<CodexAppServerSendTurnInput, "model" | "effort"> &
  Pick<CodexAppServerStartSessionInput, "serviceTier"> {
  if (modelSelection?.provider !== PROVIDER) {
    return {};
  }

  const serviceTier = resolveCodexServiceTier(modelSelection);
  return {
    model: modelSelection.model,
    ...(modelSelection.options?.reasoningEffort !== undefined
      ? { effort: modelSelection.options.reasoningEffort }
      : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
  };
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  // A closed stdin is the transport-level signature of a dead app-server
  // process; treat it as a closed session so callers recover via resume
  // instead of surfacing a raw request failure.
  if (normalized.includes("session is closed") || normalized.includes("stdin closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  const stringValue = asString(value)?.trim();
  return stringValue ? stringValue : undefined;
}

function codexErrorCode(value: unknown): string | undefined {
  const error = asObject(value);
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  const code = asTrimmedString(info);
  if (code) return code === "serverOverloaded" ? "server_overloaded" : code;
  const tagged = asObject(info);
  const tag = tagged ? Object.keys(tagged).find((key) => key.trim()) : undefined;
  if (!tag) return undefined;
  return tag === "serverOverloaded" ? "server_overloaded" : tag;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function codexDiscoveryOptions(input: {
  readonly binaryPath?: string | undefined;
  readonly homePath?: string | undefined;
  readonly shadowHomePath?: string | undefined;
  readonly accountId?: string | undefined;
  readonly runtimeGeneration?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}) {
  return {
    ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    ...(input.homePath ? { homePath: input.homePath } : {}),
    ...(input.shadowHomePath ? { shadowHomePath: input.shadowHomePath } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.runtimeGeneration ? { runtimeGeneration: input.runtimeGeneration } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  };
}

const MCP_TOOL_RESULT_MAX_BLOCKS = 12;
const MCP_TOOL_RESULT_MAX_DISPLAY_CHARS = 2_000;
const MCP_TOOL_RESULT_MAX_REPRESENTATION_CHARS = 4_000;
const MCP_TOOL_RESULT_MAX_JSON_CHARS = 12_000;
const MCP_TOOL_RESULT_ID_MAX_CHARS = 200;
const MCP_TOOL_RESULT_MIME_MAX_CHARS = 200;
const MCP_TOOL_RESULT_MAX_ARRAY_ITEMS = 24;
const MCP_TOOL_RESULT_MAX_OBJECT_KEYS = 64;
const MCP_TOOL_RESULT_MAX_DEPTH = 6;
const MCP_TOOL_RESULT_COMPACT_ARRAY_ITEMS = 12;
const MCP_TOOL_RESULT_COMPACT_OBJECT_KEYS = 32;
const MCP_TOOL_RESULT_COMPACT_DEPTH = 4;
const MCP_TOOL_RESULT_COMPACT_STRING_CHARS = 800;
const MCP_TOOL_RESULT_TRUNCATION_SUFFIX = "... [truncated]";
const MCP_BINARY_MARKER_KEY = "mossBinaryDeferred";
const MCP_BINARY_MARKER = Object.freeze({ [MCP_BINARY_MARKER_KEY]: true });
const MCP_WEB_MCP_MAX_CALLS = 8;
const MCP_WEB_MCP_NAME_MAX_CHARS = 200;
const MCP_WEB_MCP_TITLE_MAX_CHARS = 200;
const MCP_WEB_MCP_DESCRIPTION_MAX_CHARS = 1_000;
const MCP_WEB_MCP_HOSTNAME_MAX_CHARS = 253;
const MCP_WEB_MCP_JSON_MAX_CHARS = 2_000;
const MCP_WEB_MCP_URL_REPLACE_PATTERN = /\b(?:https?|ftp):\/\/[^\s"'<>]+/giu;
const MCP_WEB_MCP_URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s"'<>]+/iu;
const MCP_WEB_MCP_DATA_URL_PATTERN = /\b(?:data|blob|file):[^\s"'<>]+/iu;
const MCP_WEB_MCP_HTML_PATTERN = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/u;
const MCP_WEB_MCP_HTML_REPLACE_PATTERN = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/gu;
const MCP_WEB_MCP_CONTROL_PATTERN = /[\p{Cc}]/u;
const MCP_WEB_MCP_HOSTNAME_FORBIDDEN_PATTERN = /[\p{Cc}\s/:?#@\\]/u;
const MCP_WEB_MCP_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/u;

type WebMcpProjectionLimits = {
  readonly maxCalls: number;
  readonly titleChars: number;
  readonly descriptionChars: number;
  readonly jsonChars: number;
  readonly arrayItems: number;
  readonly objectKeys: number;
  readonly depth: number;
  readonly stringChars: number;
};

const MCP_WEB_MCP_DEFAULT_LIMITS: WebMcpProjectionLimits = {
  maxCalls: MCP_WEB_MCP_MAX_CALLS,
  titleChars: MCP_WEB_MCP_TITLE_MAX_CHARS,
  descriptionChars: MCP_WEB_MCP_DESCRIPTION_MAX_CHARS,
  jsonChars: MCP_WEB_MCP_JSON_MAX_CHARS,
  arrayItems: 24,
  objectKeys: 64,
  depth: 6,
  stringChars: 1_000,
};

const MCP_WEB_MCP_COMPACT_LIMITS: WebMcpProjectionLimits = {
  maxCalls: 4,
  titleChars: 120,
  descriptionChars: 500,
  jsonChars: 800,
  arrayItems: 8,
  objectKeys: 12,
  depth: 4,
  stringChars: 240,
};

type McpProjectionLimits = {
  readonly displayChars: number;
  readonly representationChars: number;
  readonly arrayItems: number;
  readonly objectKeys: number;
  readonly depth: number;
};

const MCP_TOOL_RESULT_DEFAULT_LIMITS: McpProjectionLimits = {
  displayChars: MCP_TOOL_RESULT_MAX_DISPLAY_CHARS,
  representationChars: MCP_TOOL_RESULT_MAX_REPRESENTATION_CHARS,
  arrayItems: MCP_TOOL_RESULT_MAX_ARRAY_ITEMS,
  objectKeys: MCP_TOOL_RESULT_MAX_OBJECT_KEYS,
  depth: MCP_TOOL_RESULT_MAX_DEPTH,
};

const MCP_TOOL_RESULT_COMPACT_LIMITS: McpProjectionLimits = {
  displayChars: MCP_TOOL_RESULT_COMPACT_STRING_CHARS,
  representationChars: MCP_TOOL_RESULT_COMPACT_STRING_CHARS,
  arrayItems: MCP_TOOL_RESULT_COMPACT_ARRAY_ITEMS,
  objectKeys: MCP_TOOL_RESULT_COMPACT_OBJECT_KEYS,
  depth: MCP_TOOL_RESULT_COMPACT_DEPTH,
};

const MCP_SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|credential|password|passphrase|secret|token|api[-_ ]?key|private[-_ ]?key|access[-_ ]?key|client[-_ ]?secret)/iu;
const MCP_BINARY_KEY_PATTERN = /^(?:base64|blob|bytes)$/iu;
const MCP_DATA_MEDIA_URL_PATTERN = /\bdata:[^,\s;]+(?:;[^,\s]*)*,[^\s]*/iu;

function isSensitiveMcpKey(key: string): boolean {
  return MCP_SENSITIVE_KEY_PATTERN.test(key);
}

function isMcpJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isMcpJsonValue(entry, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every((entry) => isMcpJsonValue(entry, ancestors))
    );
  } finally {
    ancestors.delete(value);
  }
}

type McpSanitizedValue = {
  readonly value: unknown;
  readonly truncated: boolean;
  readonly deferredBinary: boolean;
};

type McpSanitizerOptions = {
  readonly binaryKeyPattern?: RegExp;
  readonly binaryUriPattern?: RegExp;
  readonly parseJsonStrings?: boolean;
  readonly redactHttpUrls?: boolean;
  readonly redactHtml?: boolean;
};

const DEFAULT_MCP_SANITIZER_OPTIONS: McpSanitizerOptions = {};

const WEB_MCP_SANITIZER_OPTIONS: McpSanitizerOptions = {
  binaryKeyPattern: /^(?:base64|blob|bytes)$/iu,
  binaryUriPattern: MCP_WEB_MCP_DATA_URL_PATTERN,
  redactHttpUrls: true,
  redactHtml: true,
};

function sanitizeMcpTextDetails(
  value: string,
  options: McpSanitizerOptions = DEFAULT_MCP_SANITIZER_OPTIONS,
): McpSanitizedValue {
  if (MCP_DATA_MEDIA_URL_PATTERN.test(value) || options.binaryUriPattern?.test(value) === true) {
    return { value: MCP_BINARY_MARKER, truncated: false, deferredBinary: true };
  }
  const sanitized = sanitizeDiagnosticValue(value);
  const safeValue = typeof sanitized === "string" ? sanitized : "[REDACTED]";
  const redactedUrls = options.redactHttpUrls
    ? safeValue.replace(MCP_WEB_MCP_URL_REPLACE_PATTERN, "[URL REDACTED]")
    : safeValue;
  const redactedHtml = options.redactHtml
    ? redactedUrls.replace(MCP_WEB_MCP_HTML_REPLACE_PATTERN, "[HTML REDACTED]")
    : redactedUrls;
  if (
    options.parseJsonStrings !== false &&
    value.length <= MCP_TOOL_RESULT_MAX_REPRESENTATION_CHARS
  ) {
    try {
      const parsed = JSON.parse(value) as unknown;
      const parsedDetails = sanitizeMcpJsonDetails(parsed, new Set<object>(), false, options);
      if (parsedDetails.deferredBinary) {
        return { value: MCP_BINARY_MARKER, truncated: true, deferredBinary: true };
      }
    } catch {
      // Ordinary text is not required to be JSON.
    }
  }
  return {
    value: redactedHtml,
    truncated: /\[truncated \d+ chars\]$/u.test(redactedHtml) || redactedHtml !== safeValue,
    deferredBinary: false,
  };
}

function sanitizeMcpJsonDetails(
  value: unknown,
  ancestors = new Set<object>(),
  binaryContext = false,
  options: McpSanitizerOptions = DEFAULT_MCP_SANITIZER_OPTIONS,
): McpSanitizedValue {
  if (typeof value === "string") {
    return sanitizeMcpTextDetails(value, options);
  }
  if (value === null || typeof value === "boolean") {
    return { value, truncated: false, deferredBinary: false };
  }
  if (typeof value === "number") {
    return {
      value: Number.isFinite(value) ? value : null,
      truncated: !Number.isFinite(value),
      deferredBinary: false,
    };
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return { value: "[Circular]", truncated: true, deferredBinary: false };
    }
    ancestors.add(value);
    try {
      let truncated = false;
      let deferredBinary = false;
      const sanitized = value.map((entry) => {
        const details = sanitizeMcpJsonDetails(entry, ancestors, binaryContext, options);
        truncated ||= details.truncated;
        deferredBinary ||= details.deferredBinary;
        return details.value;
      });
      return { value: sanitized, truncated, deferredBinary };
    } finally {
      ancestors.delete(value);
    }
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) {
      return { value: "[Circular]", truncated: true, deferredBinary: false };
    }
    ancestors.add(value);
    const result: Record<string, unknown> = {};
    let truncated = false;
    let deferredBinary = false;
    try {
      const record = value as Record<string, unknown>;
      const objectType = asString(record.type)?.trim().toLowerCase();
      const mimeType = asString(record.mimeType ?? record.mime_type)
        ?.trim()
        .toLowerCase();
      const objectBinaryContext =
        binaryContext ||
        objectType === "image" ||
        objectType === "audio" ||
        objectType === "blob" ||
        mimeType?.startsWith("image/") === true ||
        mimeType?.startsWith("audio/") === true;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (
          (options.binaryKeyPattern ?? MCP_BINARY_KEY_PATTERN).test(key) ||
          (objectBinaryContext && key === "data")
        ) {
          result[MCP_BINARY_MARKER_KEY] = true;
          deferredBinary = true;
          continue;
        }
        const details = isSensitiveMcpKey(key)
          ? { value: "[REDACTED]", truncated: false, deferredBinary: false }
          : sanitizeMcpJsonDetails(entry, ancestors, objectBinaryContext, options);
        const safeKey = options.redactHtml
          ? key.replace(MCP_WEB_MCP_HTML_REPLACE_PATTERN, "[HTML REDACTED]")
          : key;
        result[safeKey] = details.value;
        truncated ||= details.truncated;
        truncated ||= safeKey !== key;
        deferredBinary ||= details.deferredBinary;
      }
      return { value: result, truncated, deferredBinary };
    } finally {
      ancestors.delete(value);
    }
  }
  return { value: null, truncated: true, deferredBinary: false };
}

function sanitizeMcpJson(value: unknown): unknown {
  return sanitizeMcpJsonDetails(value).value;
}

function jsonChars(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "null").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function jsonEscapedChars(value: string): number {
  let chars = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      chars += 2;
    } else if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      chars += 2;
    } else if (code < 0x20) {
      chars += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        chars += 2;
        index += 1;
      } else {
        chars += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      chars += 6;
    } else {
      chars += 1;
    }
  }
  return chars;
}

function boundedJsonChars(value: unknown, ancestors = new Set<object>()): number {
  if (value === null) return 4;
  if (typeof value === "string") return jsonEscapedChars(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value !== "object") return 4;
  if (ancestors.has(value)) return MCP_TOOL_RESULT_MAX_JSON_CHARS + 1;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return MCP_TOOL_RESULT_MAX_JSON_CHARS + 1;
  }
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    return MCP_TOOL_RESULT_MAX_JSON_CHARS + 1;
  }
  if (!Array.isArray(value) && typeof (value as Record<string, unknown>).toJSON === "function") {
    return MCP_TOOL_RESULT_MAX_JSON_CHARS + 1;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        2 +
        value.reduce((total, entry) => total + boundedJsonChars(entry, ancestors), 0) +
        Math.max(0, value.length - 1)
      );
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) =>
        entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
    );
    return (
      2 +
      entries.reduce(
        (total, [key, entry]) =>
          total + jsonEscapedChars(key) + 1 + boundedJsonChars(entry, ancestors),
        0,
      ) +
      Math.max(0, entries.length - 1)
    );
  } finally {
    ancestors.delete(value);
  }
}

function truncateMcpString(
  value: string,
  limit: number,
): {
  readonly value: string;
  readonly truncated: boolean;
} {
  if (value.length <= limit) {
    return { value, truncated: false };
  }
  const keep = Math.max(0, limit - MCP_TOOL_RESULT_TRUNCATION_SUFFIX.length);
  return {
    value: `${value.slice(0, keep)}${MCP_TOOL_RESULT_TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

function boundMcpJsonValue(
  value: unknown,
  limits: McpProjectionLimits,
  depth = 0,
  ancestors = new Set<object>(),
): { readonly value: unknown; readonly truncated: boolean } {
  if (typeof value === "string") {
    return truncateMcpString(value, limits.displayChars);
  }
  if (value === null || typeof value === "boolean") {
    return { value, truncated: false };
  }
  if (typeof value === "number") {
    return { value: Number.isFinite(value) ? value : null, truncated: !Number.isFinite(value) };
  }
  if (!value || typeof value !== "object") {
    return { value: null, truncated: true };
  }
  if (ancestors.has(value)) {
    return { value: "[Circular]", truncated: true };
  }
  if (depth >= limits.depth) {
    return { value: Array.isArray(value) ? [] : {}, truncated: true };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      let truncated = value.length > limits.arrayItems;
      const result: unknown[] = [];
      for (const entry of value.slice(0, limits.arrayItems)) {
        const bounded = boundMcpJsonValue(entry, limits, depth + 1, ancestors);
        result.push(bounded.value);
        truncated ||= bounded.truncated;
      }
      return { value: result, truncated };
    }
    const entries = Object.entries(value as Record<string, unknown>);
    let truncated = entries.length > limits.objectKeys;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, limits.objectKeys)) {
      const bounded = boundMcpJsonValue(entry, limits, depth + 1, ancestors);
      result[key] = bounded.value;
      truncated ||= bounded.truncated;
    }
    return { value: result, truncated };
  } finally {
    ancestors.delete(value);
  }
}

function boundedMcpJson(
  value: unknown,
  limits: McpProjectionLimits,
): {
  readonly value: unknown;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly deferredBinary: boolean;
} {
  const sanitized = sanitizeMcpJsonDetails(value);
  const originalChars = jsonChars(sanitized.value);
  const bounded = boundMcpJsonValue(sanitized.value, limits);
  return {
    value: bounded.value,
    truncated: sanitized.truncated || bounded.truncated || originalChars > jsonChars(bounded.value),
    originalChars,
    deferredBinary: sanitized.deferredBinary,
  };
}

function boundedMcpRepresentation(
  value: unknown,
  limits: McpProjectionLimits,
): {
  readonly json: string;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly deferredBinary: boolean;
} {
  const bounded = boundedMcpJson(value, limits);
  const serialized = JSON.stringify(bounded.value) ?? "null";
  if (serialized.length <= limits.representationChars) {
    return {
      json: serialized,
      truncated: bounded.truncated,
      originalChars: bounded.originalChars,
      deferredBinary: bounded.deferredBinary,
    };
  }
  const sanitized = sanitizeMcpJsonDetails(value);
  const compact = boundMcpJsonValue(sanitized.value, {
    ...limits,
    displayChars: Math.min(limits.displayChars, 400),
    representationChars: limits.representationChars,
    arrayItems: Math.min(limits.arrayItems, 8),
    objectKeys: Math.min(limits.objectKeys, 12),
    depth: Math.min(limits.depth, 4),
  });
  const compactSerialized = JSON.stringify(compact.value) ?? "null";
  if (compactSerialized.length <= limits.representationChars) {
    return {
      json: compactSerialized,
      truncated: true,
      originalChars: bounded.originalChars,
      deferredBinary: bounded.deferredBinary || sanitized.deferredBinary,
    };
  }
  return {
    json: Array.isArray(value) ? "[]" : "{}",
    truncated: true,
    originalChars: bounded.originalChars,
    deferredBinary: bounded.deferredBinary || sanitized.deferredBinary,
  };
}

type McpStringField = {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly deferredBinary: boolean;
};

function mcpStringFieldDetails(value: unknown, limit: number): McpStringField | undefined {
  const stringValue = asString(value);
  if (!stringValue) {
    return undefined;
  }
  const sanitized = sanitizeMcpTextDetails(stringValue);
  if (typeof sanitized.value !== "string") {
    return {
      value: "[binary deferred]",
      truncated: true,
      originalChars: stringValue.length,
      deferredBinary: true,
    };
  }
  const truncated = truncateMcpString(sanitized.value, limit);
  return {
    value: truncated.value,
    truncated: sanitized.truncated || truncated.truncated,
    originalChars: stringValue.length,
    deferredBinary: sanitized.deferredBinary,
  };
}

function sanitizeWebMcpStringDetails(value: string, parseJsonStrings = true): McpSanitizedValue {
  return sanitizeMcpTextDetails(value, {
    ...WEB_MCP_SANITIZER_OPTIONS,
    parseJsonStrings,
  });
}

/**
 * WebMCP payloads use the existing MCP sanitizer with a narrower binary-key and
 * URL policy. Keeping one recursive implementation prevents the durable MCP
 * and WebMCP projections from drifting on redaction/circular-value behavior.
 */
function sanitizeWebMcpJsonDetails(value: unknown): McpSanitizedValue {
  return sanitizeMcpJsonDetails(value, new Set<object>(), false, WEB_MCP_SANITIZER_OPTIONS);
}

function webMcpBoundedJsonString(
  value: unknown,
  limits: WebMcpProjectionLimits,
): {
  readonly value: string;
  readonly truncated: boolean;
  readonly deferredBinary: boolean;
} {
  const sanitized = sanitizeWebMcpJsonDetails(value);
  const bounded = boundMcpJsonValue(sanitized.value, {
    displayChars: limits.stringChars,
    representationChars: limits.jsonChars,
    arrayItems: limits.arrayItems,
    objectKeys: limits.objectKeys,
    depth: limits.depth,
  });
  let serialized = JSON.stringify(bounded.value) ?? "null";
  let truncated = sanitized.truncated || sanitized.deferredBinary || bounded.truncated;
  if (serialized.length > limits.jsonChars) {
    const compact = boundMcpJsonValue(sanitized.value, {
      displayChars: Math.min(limits.stringChars, 160),
      representationChars: limits.jsonChars,
      arrayItems: Math.min(limits.arrayItems, 4),
      objectKeys: Math.min(limits.objectKeys, 8),
      depth: Math.min(limits.depth, 3),
    });
    serialized = JSON.stringify(compact.value) ?? "null";
    truncated = true;
  }
  if (serialized.length > limits.jsonChars) {
    serialized = Array.isArray(sanitized.value) ? "[]" : "{}";
    truncated = true;
  }
  return { value: serialized, truncated, deferredBinary: sanitized.deferredBinary };
}

function webMcpJsonStringField(
  value: unknown,
  nativeTruncated: boolean,
  limits: WebMcpProjectionLimits,
): {
  readonly value?: string;
  readonly truncated: boolean;
  readonly deferredBinary: boolean;
} {
  if (typeof value !== "string" || value.length === 0) {
    return {
      truncated: value !== undefined && value !== "",
      deferredBinary: false,
    };
  }
  if (nativeTruncated) {
    const sanitized = sanitizeWebMcpStringDetails(value, false);
    const rawValue =
      typeof sanitized.value === "string"
        ? sanitized.value
        : (JSON.stringify(sanitized.value) ?? "[binary deferred]");
    const bounded = truncateMcpString(rawValue, limits.jsonChars);
    return {
      value: bounded.value,
      truncated: true,
      deferredBinary: sanitized.deferredBinary,
    };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isMcpJsonValue(parsed)) {
      return webMcpBoundedJsonString(parsed, limits);
    }
  } catch {
    // Preserve malformed JSON as a sanitized string, as the renderer does.
  }
  const sanitized = sanitizeWebMcpStringDetails(value);
  const rawValue =
    typeof sanitized.value === "string"
      ? sanitized.value
      : (JSON.stringify(sanitized.value) ?? "[binary deferred]");
  const bounded = truncateMcpString(rawValue, limits.jsonChars);
  return {
    value: bounded.value,
    truncated: sanitized.truncated || bounded.truncated,
    deferredBinary: sanitized.deferredBinary,
  };
}

function normalizeMcpHostname(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MCP_WEB_MCP_HOSTNAME_MAX_CHARS
  ) {
    return undefined;
  }
  if (value !== value.trim() || MCP_WEB_MCP_HOSTNAME_FORBIDDEN_PATTERN.test(value)) {
    return undefined;
  }
  try {
    const hostname = new URL(`https://${value}`).hostname;
    if (!hostname || hostname.length > MCP_WEB_MCP_HOSTNAME_MAX_CHARS) return undefined;
    if (MCP_WEB_MCP_HOSTNAME_FORBIDDEN_PATTERN.test(hostname)) return undefined;
    if (!MCP_WEB_MCP_HOSTNAME_PATTERN.test(hostname)) return undefined;
    return hostname;
  } catch {
    return undefined;
  }
}

function hostnameFromHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return normalizeMcpHostname(parsed.hostname);
  } catch {
    return undefined;
  }
}

function webMcpOptionalText(
  value: unknown,
  limit: number,
): { readonly value?: string; readonly truncated: boolean; readonly deferredBinary: boolean } {
  if (value === undefined) {
    return { truncated: false, deferredBinary: false };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { truncated: value !== "", deferredBinary: false };
  }
  if (
    value !== value.trim() ||
    MCP_WEB_MCP_CONTROL_PATTERN.test(value) ||
    MCP_WEB_MCP_HTML_PATTERN.test(value) ||
    MCP_WEB_MCP_DATA_URL_PATTERN.test(value) ||
    MCP_WEB_MCP_URL_PATTERN.test(value)
  ) {
    return {
      truncated: true,
      deferredBinary: MCP_WEB_MCP_DATA_URL_PATTERN.test(value),
    };
  }
  const sanitized = sanitizeWebMcpStringDetails(value);
  if (
    typeof sanitized.value !== "string" ||
    sanitized.deferredBinary ||
    sanitized.value !== value
  ) {
    return { truncated: true, deferredBinary: sanitized.deferredBinary };
  }
  const bounded = truncateMcpString(sanitized.value, limit);
  return {
    value: bounded.value,
    truncated: sanitized.truncated || bounded.truncated,
    deferredBinary: sanitized.deferredBinary,
  };
}

type WebMcpProjection = {
  readonly calls?: ReadonlyArray<CodexWebMcpCallData>;
  readonly fallbackHostname?: string;
  readonly omittedCalls?: number;
  readonly truncated: boolean;
  readonly deferredBinary: boolean;
};

function webMcpFallbackHostname(
  resultRecord: Record<string, unknown>,
  toolSurface: Record<string, unknown>,
): { readonly hostname?: string; readonly truncated: boolean } {
  const resultMeta = asObject(resultRecord["_meta"]);
  const browserUse = asObject(resultMeta?.browser_use);
  const browserUseHostname = hostnameFromHttpUrl(browserUse?.url);
  if (browserUseHostname) return { hostname: browserUseHostname, truncated: false };
  const browserUseCandidate = browserUse?.url;
  const screenshot = asObject(toolSurface.screenshot);
  const screenshotHostname = hostnameFromHttpUrl(screenshot?.pageUrl);
  if (screenshotHostname) {
    return {
      hostname: screenshotHostname,
      truncated: browserUseCandidate !== undefined,
    };
  }
  return {
    truncated: browserUseCandidate !== undefined || screenshot?.pageUrl !== undefined,
  };
}

function projectWebMcpCalls(
  source: Record<string, unknown>,
  resultRecord: Record<string, unknown>,
  status: "inProgress" | "completed" | "failed",
  limits: WebMcpProjectionLimits,
): WebMcpProjection {
  if (
    status !== "completed" ||
    (source.server !== "node_repl" && source.server !== "cua_repl") ||
    source.tool !== "js"
  ) {
    return { truncated: false, deferredBinary: false };
  }
  const resultMeta = asObject(resultRecord["_meta"]);
  const toolSurface = asObject(resultMeta?.["codex/toolSurface"]);
  const nativeCalls = toolSurface?.webMcpCalls;
  if (
    toolSurface?.kind !== "browserUse" ||
    !Array.isArray(nativeCalls) ||
    nativeCalls.length === 0
  ) {
    return { truncated: false, deferredBinary: false };
  }

  const calls: CodexWebMcpCallData[] = [];
  let omittedCalls = 0;
  let truncated = false;
  let deferredBinary = false;
  for (const entry of nativeCalls) {
    const record = asObject(entry);
    if (!record) {
      omittedCalls += 1;
      truncated = true;
      continue;
    }
    const optionalStringKeys = [
      "title",
      "description",
      "sourceHostname",
      "inputJson",
      "outputJson",
    ] as const;
    const invalidOptionalString = optionalStringKeys.some(
      (key) => Object.hasOwn(record, key) && typeof record[key] !== "string",
    );
    const invalidOptionalBoolean =
      Object.hasOwn(record, "readOnlyHint") && typeof record.readOnlyHint !== "boolean";
    const invalidTruncationFlag =
      (Object.hasOwn(record, "inputTruncated") && record.inputTruncated !== true) ||
      (Object.hasOwn(record, "outputTruncated") && record.outputTruncated !== true);
    if (invalidOptionalString || invalidOptionalBoolean || invalidTruncationFlag) {
      omittedCalls += 1;
      truncated = true;
      continue;
    }
    const kind = record.kind;
    const rawName = record.name;
    let name: string | undefined;
    if (kind === "listTools") {
      if (rawName !== "webmcp_list_tools") {
        omittedCalls += 1;
        truncated = true;
        continue;
      }
      name = "webmcp_list_tools";
    } else if (kind === "invokeTool") {
      if (typeof rawName !== "string" || MCP_WEB_MCP_HTML_PATTERN.test(rawName)) {
        omittedCalls += 1;
        truncated = true;
        continue;
      }
      const candidate = mcpIdentity(rawName);
      if (!candidate || candidate.length > MCP_WEB_MCP_NAME_MAX_CHARS) {
        omittedCalls += 1;
        truncated = true;
        continue;
      }
      name = candidate;
    } else {
      omittedCalls += 1;
      truncated = true;
      continue;
    }
    if (calls.length >= limits.maxCalls) {
      omittedCalls += 1;
      truncated = true;
      continue;
    }

    const title = webMcpOptionalText(record.title, limits.titleChars);
    const description = webMcpOptionalText(record.description, limits.descriptionChars);
    const sourceHostname =
      record.sourceHostname === undefined || record.sourceHostname === ""
        ? { value: undefined, truncated: false }
        : (() => {
            const normalized = normalizeMcpHostname(record.sourceHostname);
            return normalized
              ? { value: normalized, truncated: false }
              : { value: undefined, truncated: true };
          })();
    const readOnlyHint =
      typeof record.readOnlyHint === "boolean"
        ? { value: record.readOnlyHint, truncated: false }
        : { value: undefined, truncated: record.readOnlyHint !== undefined };
    const outputTruncated = record.outputTruncated === true;
    if (record.outputTruncated !== undefined && typeof record.outputTruncated !== "boolean") {
      truncated = true;
    }
    const output = webMcpJsonStringField(record.outputJson, outputTruncated, limits);
    const input =
      kind === "invokeTool"
        ? webMcpJsonStringField(record.inputJson, record.inputTruncated === true, limits)
        : undefined;
    if (record.inputTruncated !== undefined && typeof record.inputTruncated !== "boolean") {
      truncated = true;
    }
    truncated ||= outputTruncated || record.inputTruncated === true;
    truncated ||= title.truncated || description.truncated || sourceHostname.truncated;
    truncated ||= readOnlyHint.truncated || output.truncated || (input?.truncated ?? false);
    deferredBinary ||= title.deferredBinary || description.deferredBinary;
    deferredBinary ||= output.deferredBinary || (input?.deferredBinary ?? false);
    const common = {
      ...(title.value ? { title: title.value } : {}),
      ...(description.value ? { description: description.value } : {}),
      ...(readOnlyHint.value !== undefined ? { readOnlyHint: readOnlyHint.value } : {}),
      ...(sourceHostname.value ? { sourceHostname: sourceHostname.value } : {}),
      ...(output.value ? { outputJson: output.value } : {}),
      ...(outputTruncated || output.truncated ? { outputTruncated: true as const } : {}),
    };
    const call =
      kind === "listTools"
        ? { kind: "listTools" as const, name, ...common }
        : {
            kind: "invokeTool" as const,
            name,
            ...common,
            ...(input?.value ? { inputJson: input.value } : {}),
            ...(record.inputTruncated === true || input?.truncated
              ? { inputTruncated: true as const }
              : {}),
          };
    const decoded = Schema.decodeUnknownOption(CodexWebMcpCall)(call);
    if (Option.isNone(decoded)) {
      omittedCalls += 1;
      truncated = true;
      continue;
    }
    calls.push(decoded.value);
  }
  const fallback = webMcpFallbackHostname(resultRecord, toolSurface);
  truncated ||= fallback.truncated;
  return {
    ...(calls.length > 0 ? { calls } : {}),
    ...(calls.length > 0 && fallback.hostname ? { fallbackHostname: fallback.hostname } : {}),
    ...(omittedCalls > 0 ? { omittedCalls } : {}),
    truncated,
    deferredBinary,
  };
}

function mcpIdentity(value: unknown): string | undefined {
  const rawValue = asString(value);
  const stringValue = rawValue?.trim();
  if (
    !stringValue ||
    rawValue !== stringValue ||
    stringValue.length > MCP_TOOL_RESULT_ID_MAX_CHARS
  ) {
    return undefined;
  }
  const sanitized = sanitizeMcpTextDetails(stringValue);
  if (
    sanitized.deferredBinary ||
    typeof sanitized.value !== "string" ||
    sanitized.value !== stringValue
  ) {
    return undefined;
  }
  const normalized = sanitized.value.trim();
  return normalized && normalized.length <= MCP_TOOL_RESULT_ID_MAX_CHARS ? normalized : undefined;
}

function mcpDisplayTitle(source: Record<string, unknown>): string {
  const appContext = asObject(source.appContext);
  const appAction = asTrimmedString(appContext?.actionName);
  const appName = asTrimmedString(appContext?.appName);
  if (appAction) {
    // Connector-authored action ("Read the screen" in "Safari") beats the raw
    // server:tool label for computer-use MCP rows.
    return appName && !appAction.toLowerCase().includes(appName.toLowerCase())
      ? `${appAction} in ${appName}`
      : appAction;
  }
  const server = mcpIdentity(source.server);
  const tool = mcpIdentity(source.tool);
  const args = asObject(source.arguments);
  if (tool?.toLowerCase() === "js" && typeof args?.title === "string" && args.title.trim()) {
    const title = args.title.trim().replace(/\s+/g, " ");
    return title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`;
  }
  if (tool && isMossAppsServer(server)) {
    return mossAppsToolTitle(tool);
  }
  if (server && tool) {
    const humanize = (value: string) =>
      value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
    return `${humanize(server)}: ${humanize(tool)}`;
  }
  return "MCP tool call";
}

type McpAnnotationsProjection = {
  readonly value: McpProjectionAnnotations;
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly deferredBinary: boolean;
};

function mcpAnnotations(value: unknown): McpAnnotationsProjection | undefined {
  const record = asObject(value);
  if (!record) {
    return undefined;
  }
  let truncated = false;
  let deferredBinary = false;
  let originalChars = boundedJsonChars(value);
  const audience = Array.isArray(record.audience)
    ? record.audience
        .slice(0, 4)
        .map((entry) => {
          const field = mcpStringFieldDetails(entry, MCP_TOOL_RESULT_MAX_DISPLAY_CHARS);
          truncated ||= field?.truncated ?? false;
          deferredBinary ||= field?.deferredBinary ?? false;
          originalChars = Math.max(originalChars, field?.originalChars ?? 0);
          return field?.value;
        })
        .filter((entry): entry is string => entry !== undefined)
    : (() => {
        const field = mcpStringFieldDetails(record.audience, MCP_TOOL_RESULT_MAX_DISPLAY_CHARS);
        truncated ||= field?.truncated ?? false;
        deferredBinary ||= field?.deferredBinary ?? false;
        originalChars = Math.max(originalChars, field?.originalChars ?? 0);
        return field?.value;
      })();
  if (Array.isArray(record.audience) && record.audience.length > 4) {
    truncated = true;
  }
  const priority =
    typeof record.priority === "number" && Number.isFinite(record.priority)
      ? record.priority
      : (() => {
          const field = mcpStringFieldDetails(record.priority, MCP_TOOL_RESULT_MAX_DISPLAY_CHARS);
          truncated ||= field?.truncated ?? false;
          deferredBinary ||= field?.deferredBinary ?? false;
          originalChars = Math.max(originalChars, field?.originalChars ?? 0);
          return field?.value;
        })();
  const lastModifiedField = mcpStringFieldDetails(
    record.lastModified ?? record.last_modified,
    MCP_TOOL_RESULT_MAX_DISPLAY_CHARS,
  );
  truncated ||= lastModifiedField?.truncated ?? false;
  deferredBinary ||= lastModifiedField?.deferredBinary ?? false;
  originalChars = Math.max(originalChars, lastModifiedField?.originalChars ?? 0);
  const lastModified = lastModifiedField?.value;
  if (audience === undefined || (Array.isArray(audience) && audience.length === 0)) {
    if (priority === undefined && lastModified === undefined && !truncated && !deferredBinary) {
      return undefined;
    }
  }
  const annotations: McpProjectionAnnotations = {
    ...(audience !== undefined && (!Array.isArray(audience) || audience.length > 0)
      ? { audience }
      : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
    ...(truncated ? { truncated: true, originalChars } : {}),
  };
  return {
    value: annotations,
    truncated,
    originalChars,
    deferredBinary,
  };
}

function mcpOriginalTypeDetails(value: unknown): McpStringField | undefined {
  const rawValue = asString(value);
  const field = mcpStringFieldDetails(value, 80);
  if (!field || field.deferredBinary) {
    return undefined;
  }
  return MCP_SENSITIVE_KEY_PATTERN.test(rawValue ?? field.value)
    ? { ...field, value: "[REDACTED]", truncated: false }
    : field;
}

function mcpBinaryDeferredBlock(
  originalType: string | undefined,
  source: Record<string, unknown>,
): McpToolResultContentBlock {
  const nested = asObject(source.resource) ?? source;
  const uri = mcpStringFieldDetails(nested.uri ?? nested.url, MCP_TOOL_RESULT_MAX_DISPLAY_CHARS);
  const mimeType = mcpStringFieldDetails(
    nested.mimeType ?? nested.mime_type,
    MCP_TOOL_RESULT_MIME_MAX_CHARS,
  );
  const annotations = mcpAnnotations(source.annotations ?? nested.annotations);
  const originalTypeField = mcpOriginalTypeDetails(originalType);
  const truncated =
    originalTypeField?.truncated === true ||
    uri?.truncated === true ||
    mimeType?.truncated === true ||
    annotations?.truncated === true;
  const originalChars = Math.max(
    originalTypeField?.originalChars ?? 0,
    uri?.originalChars ?? 0,
    mimeType?.originalChars ?? 0,
    annotations?.originalChars ?? 0,
  );
  return {
    type: "binary_deferred",
    ...(originalTypeField?.value ? { originalType: originalTypeField.value } : {}),
    ...(uri?.value ? { uri: uri.value } : {}),
    ...(mimeType?.value ? { mimeType: mimeType.value } : {}),
    ...(annotations?.value ? { annotations: annotations.value } : {}),
    ...(truncated ? { truncated: true, originalChars } : {}),
    reason: "artifact-unavailable",
    state: "binary_deferred",
  };
}

function projectMcpContentBlock(
  value: unknown,
  limits: McpProjectionLimits,
): {
  readonly block: McpToolResultContentBlock;
  readonly truncated: boolean;
  readonly deferred: boolean;
} {
  const source = asObject(value);
  if (!source) {
    const representation = boundedMcpRepresentation(value, limits);
    if (representation.deferredBinary) {
      const block = {
        ...mcpBinaryDeferredBlock(undefined, {}),
      } as McpToolResultContentBlock;
      return {
        block,
        truncated: true,
        deferred: true,
      };
    }
    return {
      block: {
        type: "unknown",
        json: representation.json,
        truncated: representation.truncated,
        ...(representation.truncated ? { originalChars: representation.originalChars } : {}),
      },
      truncated: representation.truncated,
      deferred: false,
    };
  }

  const type = asString(source.type);
  const sourceSanitized = sanitizeMcpJsonDetails(source);
  if (type === "image" || type === "audio" || type === "blob" || sourceSanitized.deferredBinary) {
    const block = mcpBinaryDeferredBlock(type, source);
    return { block, truncated: block.truncated === true, deferred: true };
  }

  if (type === "text") {
    if (typeof source.text !== "string") {
      const representation = boundedMcpRepresentation(source, limits);
      if (representation.deferredBinary) {
        const block = mcpBinaryDeferredBlock(type, source);
        return { block, truncated: block.truncated === true, deferred: true };
      }
      return {
        block: {
          type: "unknown",
          json: representation.json,
          originalType: "text",
          truncated: true,
          originalChars: representation.originalChars,
        },
        truncated: true,
        deferred: false,
      };
    }
    const text = mcpStringFieldDetails(source.text, limits.displayChars);
    if (!text) {
      const block = mcpBinaryDeferredBlock(type, source);
      return { block, truncated: block.truncated === true, deferred: true };
    }
    const annotations = mcpAnnotations(source.annotations);
    const truncated = text.truncated || annotations?.truncated === true;
    const originalChars = Math.max(text.originalChars, annotations?.originalChars ?? 0);
    return {
      block: {
        type: "text",
        text: text.value,
        ...(annotations?.value ? { annotations: annotations.value } : {}),
        ...(truncated ? { truncated: true, originalChars } : {}),
      },
      truncated,
      deferred: false,
    };
  }

  if (type === "resource_link") {
    const uri = mcpStringFieldDetails(source.uri, limits.displayChars);
    if (uri?.value) {
      const name = mcpStringFieldDetails(source.name, limits.displayChars);
      const title = mcpStringFieldDetails(source.title, limits.displayChars);
      const description = mcpStringFieldDetails(source.description, limits.displayChars);
      const mimeType = mcpStringFieldDetails(
        source.mimeType ?? source.mime_type,
        MCP_TOOL_RESULT_MIME_MAX_CHARS,
      );
      const annotations = mcpAnnotations(source.annotations);
      const truncated =
        uri.truncated ||
        name?.truncated === true ||
        title?.truncated === true ||
        description?.truncated === true ||
        mimeType?.truncated === true ||
        annotations?.truncated === true;
      const originalChars = Math.max(
        uri.originalChars,
        name?.originalChars ?? 0,
        title?.originalChars ?? 0,
        description?.originalChars ?? 0,
        mimeType?.originalChars ?? 0,
        annotations?.originalChars ?? 0,
      );
      return {
        block: {
          type: "resource_link",
          uri: uri.value,
          ...(name?.value ? { name: name.value } : {}),
          ...(title?.value ? { title: title.value } : {}),
          ...(description?.value ? { description: description.value } : {}),
          ...(mimeType?.value ? { mimeType: mimeType.value } : {}),
          ...(annotations?.value ? { annotations: annotations.value } : {}),
          ...(truncated ? { truncated: true, originalChars } : {}),
        },
        truncated,
        deferred: false,
      };
    }
  }

  if (type === "embedded_resource" || type === "resource") {
    const nested = asObject(source.resource) ?? source;
    const textValue = nested.text;
    if (typeof textValue === "string") {
      const text = mcpStringFieldDetails(textValue, limits.representationChars);
      if (!text) {
        const block = mcpBinaryDeferredBlock(type, source);
        return { block, truncated: block.truncated === true, deferred: true };
      }
      const uri = mcpStringFieldDetails(nested.uri, limits.displayChars);
      const mimeType = mcpStringFieldDetails(
        nested.mimeType ?? nested.mime_type,
        MCP_TOOL_RESULT_MIME_MAX_CHARS,
      );
      const annotations = mcpAnnotations(source.annotations ?? nested.annotations);
      const truncated =
        text.truncated ||
        uri?.truncated === true ||
        mimeType?.truncated === true ||
        annotations?.truncated === true;
      const originalChars = Math.max(
        text.originalChars,
        uri?.originalChars ?? 0,
        mimeType?.originalChars ?? 0,
        annotations?.originalChars ?? 0,
      );
      return {
        block: {
          type: "embedded_resource",
          ...(uri?.value ? { uri: uri.value } : {}),
          ...(mimeType?.value ? { mimeType: mimeType.value } : {}),
          text: text.value,
          ...(annotations?.value ? { annotations: annotations.value } : {}),
          ...(truncated ? { truncated: true, originalChars } : {}),
        },
        truncated,
        deferred: false,
      };
    }
  }

  const originalType = mcpOriginalTypeDetails(type);
  const safeSource =
    type !== undefined && originalType?.value ? { ...source, type: originalType.value } : source;
  const representation = boundedMcpRepresentation(safeSource, limits);
  if (representation.deferredBinary) {
    const block = mcpBinaryDeferredBlock(type, source);
    return { block, truncated: block.truncated === true, deferred: true };
  }
  const truncated = representation.truncated || originalType?.truncated === true;
  const originalChars = Math.max(representation.originalChars, originalType?.originalChars ?? 0);
  return {
    block: {
      type: "unknown",
      json: representation.json,
      ...(originalType?.value ? { originalType: originalType.value } : {}),
      ...(truncated ? { truncated: true, originalChars } : {}),
    },
    truncated,
    deferred: representation.deferredBinary,
  };
}

function mcpProjectionStatus(
  source: Record<string, unknown>,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): "inProgress" | "completed" | "failed" {
  if (lifecycle === "item.started") {
    return "inProgress";
  }
  if (lifecycle === "item.updated") {
    return source.status === "failed"
      ? "failed"
      : source.status === "completed"
        ? "completed"
        : "inProgress";
  }
  return source.status === "failed" ? "failed" : "completed";
}

const MCP_APP_RESOURCE_URI_MAX_CHARS = 2_000;
const MCP_APP_DESCRIPTOR_FIELD_MAX_CHARS = 200;

function boundedMcpAppDescriptorString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > limit ||
    normalized.includes("\0") ||
    normalized.includes("\r") ||
    normalized.includes("\n") ||
    MCP_DATA_MEDIA_URL_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  const sanitized = sanitizeMcpTextDetails(normalized);
  return sanitized.deferredBinary || sanitized.value !== normalized ? undefined : normalized;
}

function mcpAppDescriptorFromSource(
  source: Record<string, unknown>,
): CodexMcpAppDescriptor | undefined {
  const appContext = asObject(source.appContext);
  const connectorId = boundedMcpAppDescriptorString(
    appContext?.connectorId,
    MCP_APP_DESCRIPTOR_FIELD_MAX_CHARS,
  );
  const contextResourceUri =
    connectorId === undefined
      ? undefined
      : boundedMcpAppDescriptorString(appContext?.resourceUri, MCP_APP_RESOURCE_URI_MAX_CHARS);
  const result = asObject(source.result);
  const resultMeta = asObject(result?.["_meta"]);
  const resultMetaUi = asObject(resultMeta?.ui);
  const resultMetaResourceUri =
    boundedMcpAppDescriptorString(resultMetaUi?.resourceUri, MCP_APP_RESOURCE_URI_MAX_CHARS) ??
    boundedMcpAppDescriptorString(resultMeta?.["ui/resourceUri"], MCP_APP_RESOURCE_URI_MAX_CHARS) ??
    boundedMcpAppDescriptorString(
      resultMeta?.["openai/outputTemplate"],
      MCP_APP_RESOURCE_URI_MAX_CHARS,
    );
  const legacyResourceUri = boundedMcpAppDescriptorString(
    source.mcpAppResourceUri,
    MCP_APP_RESOURCE_URI_MAX_CHARS,
  );
  const resourceUri = contextResourceUri ?? resultMetaResourceUri ?? legacyResourceUri;
  if (resourceUri === undefined) return undefined;

  const sourceKind: CodexMcpAppDescriptor["source"] =
    contextResourceUri !== undefined
      ? "appContext"
      : resultMetaResourceUri !== undefined
        ? "resultMeta"
        : "legacy";
  const linkId = boundedMcpAppDescriptorString(
    appContext?.linkId,
    MCP_APP_DESCRIPTOR_FIELD_MAX_CHARS,
  );
  const appName = boundedMcpAppDescriptorString(
    appContext?.appName,
    MCP_APP_DESCRIPTOR_FIELD_MAX_CHARS,
  );
  const actionName = boundedMcpAppDescriptorString(
    appContext?.actionName,
    MCP_APP_DESCRIPTOR_FIELD_MAX_CHARS,
  );
  const pluginId = boundedMcpAppDescriptorString(
    source.pluginId,
    MCP_APP_DESCRIPTOR_FIELD_MAX_CHARS,
  );
  return {
    resourceUri,
    source: sourceKind,
    ...(connectorId !== undefined ? { connectorId } : {}),
    ...(linkId !== undefined ? { linkId } : {}),
    ...(appName !== undefined ? { appName } : {}),
    ...(actionName !== undefined ? { actionName } : {}),
    ...(pluginId !== undefined ? { pluginId } : {}),
  };
}

export function projectCodexMcpAppDescriptor(
  source: Record<string, unknown>,
): CodexMcpAppDescriptor | undefined {
  return mcpAppDescriptorFromSource(source);
}

function buildCodexMcpToolCallProjection(
  source: Record<string, unknown>,
  lifecycle: "item.started" | "item.updated" | "item.completed",
  limits: McpProjectionLimits,
  originalJsonChars: number,
): CodexMcpToolCallProjectionData | undefined {
  const callId = mcpIdentity(source.id);
  const server = mcpIdentity(source.server);
  const tool = mcpIdentity(source.tool);
  if (!callId || !server || !tool || !Object.prototype.hasOwnProperty.call(source, "arguments")) {
    return undefined;
  }
  if (!isMcpJsonValue(source.arguments)) {
    return undefined;
  }

  const sourceSafety = sanitizeMcpJsonDetails(source);
  const boundedArguments = boundedMcpJson(source.arguments, limits);
  const status = mcpProjectionStatus(source, lifecycle);
  // Codex sends every optional field, so a call still running carries
  // `result: null` and `error: null`: null means absent, not malformed.
  const rawResult = source.result ?? undefined;
  const rawError = source.error ?? undefined;
  let webMcp: WebMcpProjection = {
    truncated: false,
    deferredBinary: false,
  };
  let result: CodexMcpToolCallProjectionData["result"];
  let resultTruncated = sourceSafety.truncated;
  let deferredBinary = sourceSafety.deferredBinary || boundedArguments.deferredBinary;
  if (rawResult !== undefined) {
    const resultRecord = asObject(rawResult);
    if (!resultRecord || !Array.isArray(resultRecord.content)) {
      return undefined;
    }
    const content = resultRecord.content.slice(0, MCP_TOOL_RESULT_MAX_BLOCKS).map((entry) => {
      const projected = projectMcpContentBlock(entry, limits);
      resultTruncated ||= projected.truncated;
      deferredBinary ||= projected.deferred;
      return projected.block;
    });
    if (resultRecord.content.length > MCP_TOOL_RESULT_MAX_BLOCKS) {
      resultTruncated = true;
    }
    let structuredContent: Schema.Json | undefined;
    if (Object.prototype.hasOwnProperty.call(resultRecord, "structuredContent")) {
      if (!isMcpJsonValue(resultRecord.structuredContent)) {
        return undefined;
      }
      const boundedStructured = boundedMcpJson(resultRecord.structuredContent, {
        ...limits,
        displayChars: limits.representationChars,
      });
      structuredContent = boundedStructured.value as Schema.Json;
      resultTruncated ||= boundedStructured.truncated;
      deferredBinary ||= boundedStructured.deferredBinary;
    }
    result = {
      content,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
    webMcp = projectWebMcpCalls(
      source,
      resultRecord,
      status,
      limits.representationChars <= MCP_TOOL_RESULT_COMPACT_LIMITS.representationChars
        ? MCP_WEB_MCP_COMPACT_LIMITS
        : MCP_WEB_MCP_DEFAULT_LIMITS,
    );
    resultTruncated ||= webMcp.truncated;
    deferredBinary ||= webMcp.deferredBinary;
  }

  let error: CodexMcpToolCallProjectionData["error"];
  if (rawError !== undefined) {
    const errorRecord = asObject(rawError);
    if (!errorRecord) return undefined;
    const message = mcpStringFieldDetails(errorRecord.message, limits.displayChars);
    if (!message?.value) {
      return undefined;
    }
    resultTruncated ||= message.truncated;
    deferredBinary ||= message.deferredBinary;
    error = { message: message.value };
  }
  if (status === "failed" && !error) {
    return undefined;
  }

  const durationMs =
    typeof source.durationMs === "number" &&
    Number.isSafeInteger(source.durationMs) &&
    source.durationMs >= 0
      ? source.durationMs
      : undefined;
  const truncated = boundedArguments.truncated || resultTruncated || webMcp.truncated;
  const rawResultRecord = asObject(rawResult);
  const omittedBlocks = Array.isArray(rawResultRecord?.content)
    ? Math.max(0, rawResultRecord.content.length - MCP_TOOL_RESULT_MAX_BLOCKS)
    : undefined;
  const app = mcpAppDescriptorFromSource(source);
  return {
    kind: CODEX_MCP_TOOL_CALL_PROJECTION_KIND,
    version: CODEX_MCP_TOOL_CALL_PROJECTION_VERSION,
    callId,
    server,
    tool,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    arguments: boundedArguments.value,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    ...(app ? { app } : {}),
    ...(webMcp.calls ? { webMcpCalls: webMcp.calls } : {}),
    ...(webMcp.fallbackHostname ? { webMcpFallbackHostname: webMcp.fallbackHostname } : {}),
    truncation: {
      truncated,
      deferredBinary,
      ...(originalJsonChars > MCP_TOOL_RESULT_MAX_JSON_CHARS || truncated
        ? { originalJsonChars }
        : {}),
      ...(omittedBlocks ? { omittedBlocks } : {}),
      ...(webMcp.omittedCalls ? { omittedWebMcpCalls: webMcp.omittedCalls } : {}),
    },
  } as CodexMcpToolCallProjectionData;
}

/**
 * Projects one native Codex `mcpToolCall` item into the bounded durable shape.
 * Undefined means the item was malformed/partial and must remain a generic,
 * fail-closed MCP row.
 */
export function projectCodexMcpToolCall(
  source: Record<string, unknown>,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): CodexMcpToolCallProjectionData | undefined {
  if (source.type !== "mcpToolCall") {
    return undefined;
  }
  const sanitizedSource = sanitizeMcpJson(source);
  const sourceJsonChars = boundedJsonChars(source);
  const originalJsonChars = Math.max(sourceJsonChars, boundedJsonChars(sanitizedSource));
  const first = buildCodexMcpToolCallProjection(
    source,
    lifecycle,
    MCP_TOOL_RESULT_DEFAULT_LIMITS,
    originalJsonChars,
  );
  if (!first) {
    return undefined;
  }

  const firstDecoded = Schema.decodeUnknownOption(CodexMcpToolCallProjection)(first);
  if (
    Option.isSome(firstDecoded) &&
    jsonChars(firstDecoded.value) <= MCP_TOOL_RESULT_MAX_JSON_CHARS
  ) {
    return firstDecoded.value;
  }

  const compact = buildCodexMcpToolCallProjection(
    source,
    lifecycle,
    MCP_TOOL_RESULT_COMPACT_LIMITS,
    originalJsonChars,
  );
  if (!compact) {
    return undefined;
  }
  const compactDecoded = Schema.decodeUnknownOption(CodexMcpToolCallProjection)(compact);
  if (
    Option.isSome(compactDecoded) &&
    jsonChars(compactDecoded.value) <= MCP_TOOL_RESULT_MAX_JSON_CHARS
  ) {
    return compactDecoded.value;
  }

  // Keep the identity, invocation and terminal error/result state while
  // dropping only oversized content. The representation stays valid JSON and
  // the truncation marker makes the loss explicit to the UI/raw dialog.
  const fallbackContent = compact.result?.content.slice(0, 1);
  const sourceResult = asObject(source.result);
  const rawContentCount = Array.isArray(sourceResult?.content)
    ? sourceResult.content.length
    : undefined;
  const omittedBlocks =
    rawContentCount !== undefined && fallbackContent !== undefined
      ? Math.max(0, rawContentCount - fallbackContent.length)
      : compact.truncation.omittedBlocks;
  const compactWebMcpCount =
    (compact.webMcpCalls?.length ?? 0) + (compact.truncation.omittedWebMcpCalls ?? 0);
  const fallbackWebMcp = compactWebMcpCount > 0;
  const fallback = {
    ...compact,
    arguments: {},
    ...(fallbackWebMcp
      ? {
          webMcpCalls: undefined,
          webMcpFallbackHostname: undefined,
        }
      : {}),
    ...(compact.result
      ? {
          result: {
            content: fallbackContent ?? [],
            ...(compact.result.structuredContent !== undefined ? { structuredContent: null } : {}),
          },
        }
      : {}),
    truncation: {
      ...compact.truncation,
      truncated: true,
      originalJsonChars,
      ...(omittedBlocks ? { omittedBlocks } : {}),
      ...(fallbackWebMcp ? { omittedWebMcpCalls: compactWebMcpCount } : {}),
    },
  };
  const fallbackDecoded = Schema.decodeUnknownOption(CodexMcpToolCallProjection)(fallback);
  return Option.isSome(fallbackDecoded) &&
    jsonChars(fallbackDecoded.value) <= MCP_TOOL_RESULT_MAX_JSON_CHARS
    ? fallbackDecoded.value
    : undefined;
}

function mcpSourceForEvent(event: ProviderEvent): Record<string, unknown> | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  for (const source of [item, payload]) {
    if (source?.type === "mcpToolCall" || source?.kind === "mcpToolCall") {
      return source;
    }
  }
  return undefined;
}

function isExplicitMcpNativeMethod(method: string): boolean {
  return method === "mcpToolCall" || method.includes("mcpToolCall");
}

function isMcpNativeEvent(event: ProviderEvent): boolean {
  return mcpSourceForEvent(event) !== undefined || isExplicitMcpNativeMethod(event.method);
}

// Keep manager-emitted stderr lines visible without escalating them into a fatal thread error.
function providerErrorMapsToWarning(event: ProviderEvent): boolean {
  return (
    event.kind === "error" &&
    (event.method === "process/stderr" ||
      event.method === "mcpServer/elicitation/request/unrenderable" ||
      (event.method === "error" &&
        typeof event.message === "string" &&
        isNonFatalCodexErrorMessage(event.message)))
  );
}

function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asObject(value);
  const totalUsage = asObject(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asObject(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens);
  const usedTokens =
    asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.model_context_window) ?? asNumber(usage?.modelContextWindow);
  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens);
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens);

  const totalInput = asNumber(totalUsage?.input_tokens) ?? asNumber(totalUsage?.inputTokens);
  const totalOutput = asNumber(totalUsage?.output_tokens) ?? asNumber(totalUsage?.outputTokens);
  const totalCached =
    asNumber(totalUsage?.cached_input_tokens) ?? asNumber(totalUsage?.cachedInputTokens);
  const totalWrites =
    asNumber(totalUsage?.cacheWriteInputTokens) ?? asNumber(totalUsage?.cache_write_input_tokens);
  return {
    usedTokens,
    ...(totalInput !== undefined && totalOutput !== undefined
      ? {
          cumulativeUsage: {
            inputTokens: totalInput,
            outputTokens: totalOutput,
            ...(totalCached !== undefined ? { cachedInputTokens: totalCached } : {}),
            ...(totalWrites !== undefined ? { cacheCreationInputTokens: totalWrites } : {}),
          },
        }
      : {}),
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (isCodexGeneratedImageItemType(raw)) return "image_generation";
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab") || type === "sub agent activity") return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered") || type.includes("entered review")) return "review_entered";
  if (type.includes("review exited") || type.includes("exited review")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function toolItemTitle(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const appContext = asObject(item.appContext);
  const action =
    asTrimmedString(appContext?.actionName) ??
    asTrimmedString(item.title) ??
    asTrimmedString(item.tool) ??
    asTrimmedString(item.name);
  if (!action) return undefined;

  const appName = asTrimmedString(appContext?.appName);
  if (!appName || action.toLowerCase().includes(appName.toLowerCase())) {
    return action;
  }
  return `${action} in ${appName}`;
}

function itemTitle(
  itemType: CanonicalItemType,
  item?: Record<string, unknown>,
): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return toolItemTitle(item) ?? "MCP tool call";
    case "dynamic_tool_call":
      return toolItemTitle(item) ?? "Tool call";
    case "web_search":
      return "Web search";
    case "image_generation":
      return "Generated image";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function joinedTextParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const object = asObject(entry);
      return asString(object?.text) ?? asString(object?.summary);
    })
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function reasoningSummaryDetail(item: Record<string, unknown>): string | undefined {
  return asString(item.summary)?.trim() || joinedTextParts(item.summary);
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    joinedTextParts(item.summary),
    joinedTextParts(item.content),
    asString(item.review),
    asString(item.text),
    asString(item.saved_path),
    asString(item.savedPath),
    asString(item.path),
    asString(item.file_path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function itemStatus(
  lifecycle: "item.started" | "item.updated" | "item.completed",
  rawStatus: unknown,
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  if (lifecycle === "item.started") {
    return "inProgress";
  }
  if (lifecycle === "item.updated") {
    return undefined;
  }
  return rawStatus === "failed" || rawStatus === "declined" ? rawStatus : "completed";
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "item/permissions/requestApproval":
      return "permissions_approval";
    case "mcpServer/elicitation/request":
      return "tool_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "permissions":
      return "permissions_approval";
    case "tool":
      return "tool_approval";
    default:
      return "unknown";
  }
}

function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  const result: Record<string, string | ReadonlyArray<string> | null> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      result[questionId] = value;
      continue;
    }

    if (Array.isArray(value)) {
      const normalized = value.filter((entry): entry is string => typeof entry === "string");
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }

    const nestedAnswers = asArray(asObject(value)?.answers);
    if (nestedAnswers) {
      const normalized = nestedAnswers.filter(
        (entry): entry is string => typeof entry === "string",
      );
      result[questionId] = normalized.length === 1 ? normalized[0]! : normalized;
      continue;
    }
  }
  return result;
}

function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

function codexGeneratedImageThreadId(
  event: ProviderEvent,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const msg = codexEventMessage(payload);
  const nestedEvent = asObject(payload?.event);
  return (
    firstStringValue(msg, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(nestedEvent, ["thread_id", "threadId", "threadID", "thread"]) ??
    firstStringValue(payload, ["thread_id", "threadId", "threadID", "thread"]) ??
    event.providerThreadId ??
    event.threadId
  );
}

function sanitizeGeneratedImagePayload(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
): unknown {
  const payload = asObject(event.payload);
  return sanitizeNestedCodexGeneratedImagePayloads({
    value: event.payload ?? {},
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
    ...(codexHome ? { codexHome } : {}),
  });
}

function withSanitizedGeneratedImageRaw(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...base,
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: sanitizeGeneratedImagePayload(event, canonicalThreadId, codexHome),
    },
  };
}

function generatedImageEventCandidate(event: ProviderEvent): Record<string, unknown> | undefined {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const item = asObject(payload?.item);
  const nestedEvent = asObject(payload?.event);
  if (item) {
    return item;
  }
  if (msg) {
    return {
      ...msg,
      type: asString(msg.type) ?? "image_generation_end",
    };
  }
  if (nestedEvent) {
    return {
      ...nestedEvent,
      type: asString(nestedEvent.type) ?? "image_generation_end",
    };
  }
  if (payload) {
    return {
      ...payload,
      type: asString(payload.type) ?? "image_generation_end",
    };
  }
  return undefined;
}

function mapGeneratedImageEndEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
): ProviderRuntimeEvent | undefined {
  if (
    event.method !== "codex/event/image_generation_end" &&
    event.method !== "image_generation_end"
  ) {
    return undefined;
  }
  const payload = asObject(event.payload);
  const candidate = generatedImageEventCandidate(event);
  const reference = extractCodexGeneratedImageReference({
    value: candidate,
    threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
    ...(codexHome ? { codexHome } : {}),
  });
  if (!reference) {
    return undefined;
  }

  const turnId =
    event.turnId ??
    toTurnId(
      firstStringValue(candidate, ["turn_id", "turnId"]) ??
        firstStringValue(payload, ["turn_id", "turnId"]),
    );
  const itemId =
    event.itemId ??
    toProviderItemId(
      firstStringValue(candidate, ["item_id", "itemId", "call_id", "callId", "id"]) ??
        firstStringValue(payload, ["item_id", "itemId", "call_id", "callId", "id"]),
    );
  const base = withSanitizedGeneratedImageRaw(
    {
      ...runtimeEventBase(
        {
          ...event,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
        },
        canonicalThreadId,
      ),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    },
    event,
    canonicalThreadId,
    codexHome,
  );

  return {
    ...base,
    type: "item.completed",
    payload: {
      itemType: "image_generation",
      status: "completed",
      title: "Generated image",
      detail: reference.path,
      data: codexGeneratedImageArtifact(reference),
    },
  };
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.providerThreadId) refs.providerThreadId = event.providerThreadId;
  if (event.providerParentThreadId) refs.providerParentThreadId = event.providerParentThreadId;
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.parentTurnId) refs.parentProviderTurnId = event.parentTurnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: event.lifecycleGeneration }
      : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function runtimeDeltaEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return withMinimalRawPayload(runtimeEventBase(event, canonicalThreadId), event);
}

function codexDeltaEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return withMinimalRawPayload(codexEventBase(event, canonicalThreadId), event);
}

function withMinimalRawPayload(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...base,
    raw: {
      source: base.raw?.source ?? eventRawSource(event),
      ...(base.raw?.method !== undefined ? { method: base.raw.method } : {}),
      ...(base.raw?.messageType !== undefined ? { messageType: base.raw.messageType } : {}),
      payload: {},
    },
  };
}

function withMinimalMcpRawPayload(
  base: Omit<ProviderRuntimeEvent, "type" | "payload">,
  event: ProviderEvent,
  source: Record<string, unknown>,
  projection: CodexMcpToolCallProjectionData | undefined,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const callId = projection?.callId ?? mcpIdentity(source.id);
  return {
    ...base,
    raw: {
      source: base.raw?.source ?? eventRawSource(event),
      ...(base.raw?.method !== undefined ? { method: base.raw.method } : {}),
      ...(base.raw?.messageType !== undefined ? { messageType: base.raw.messageType } : {}),
      payload: {
        mossSanitized: true,
        itemType: "mcpToolCall",
        projectionKind: CODEX_MCP_TOOL_CALL_PROJECTION_KIND,
        projectionVersion: CODEX_MCP_TOOL_CALL_PROJECTION_VERSION,
        ...(callId ? { callId } : {}),
        ...(projection === undefined ? { malformed: true } : {}),
      },
    },
  };
}

// Codex multi-agent v2 announces each spawned child with a subAgentActivity
// item (kind "started"/"completed", agentThreadId, agentPath "/root/<task>")
// instead of a collabAgentToolCall naming receivers, and its spawn prompt is
// encrypted. Present it as a collab call so the shared subagent machinery
// creates the child thread, names it after its task, and records its outcome.
function codexSubAgentActivityCollabItem(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (source.type !== "subAgentActivity") {
    return undefined;
  }
  const agentThreadId = asString(source.agentThreadId);
  if (!agentThreadId) {
    return undefined;
  }
  const kind = asString(source.kind);
  const agentPath = asString(source.agentPath);
  const taskName = agentPath
    ?.split("/")
    .map((segment) => segment.trim())
    .findLast((segment) => segment.length > 0);
  const model = asString(source.model);
  const effort = asString(source.reasoningEffort);
  const settled = kind !== undefined && kind !== "started";
  return {
    type: "collabAgentToolCall",
    ...(asString(source.id) ? { id: asString(source.id) } : {}),
    tool: settled ? "subAgentSettled" : "spawnAgent",
    status: "completed",
    receiverThreadIds: [agentThreadId],
    receiverAgents: [
      {
        threadId: agentThreadId,
        ...(taskName ? { agentNickname: taskName } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    ],
    ...(settled ? { agentsStates: { [agentThreadId]: { status: kind } } } : {}),
    ...(agentPath ? { agentPath } : {}),
  };
}

export function mapCodexItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
  codexHome?: CodexGeneratedImageHomeContext,
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const subAgentCollabItem = codexSubAgentActivityCollabItem(source);
  if (subAgentCollabItem) {
    return {
      ...runtimeEventBase(event, canonicalThreadId),
      type: lifecycle,
      payload: {
        itemType: "collab_agent_tool_call",
        status: lifecycle === "item.started" ? "inProgress" : "completed",
        title: "Subagent",
        data: { ...payload, item: subAgentCollabItem },
      },
    };
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (source.type === "subAgentActivity" && !decodeSubagentActivity(source)) return undefined;
  if (
    itemType === "unknown" &&
    lifecycle !== "item.updated" &&
    source.type !== "mcpToolCall" &&
    source.kind !== "mcpToolCall"
  ) {
    return undefined;
  }
  // Native Codex MCP items are the only source eligible for the typed result
  // projection. Keep malformed/partial native items visible as generic MCP
  // rows, but never carry their original payload into the runtime journal.
  if (source.type === "mcpToolCall" || source.kind === "mcpToolCall") {
    const projection =
      source.type === "mcpToolCall" ? projectCodexMcpToolCall(source, lifecycle) : undefined;
    const status = itemStatus(lifecycle, source.status);
    const mcpRawBase = withMinimalMcpRawPayload(
      runtimeEventBase(event, canonicalThreadId),
      event,
      source,
      projection,
    );
    return {
      ...mcpRawBase,
      type: lifecycle,
      payload: {
        itemType: "mcp_tool_call",
        ...(status ? { status } : {}),
        title: mcpDisplayTitle(source),
        ...(projection
          ? { data: projection }
          : {
              data: {
                kind: "codex.mcp_tool_call.invalid",
                version: CODEX_MCP_TOOL_CALL_PROJECTION_VERSION,
                ...(mcpIdentity(source.id) ? { callId: mcpIdentity(source.id) } : {}),
                malformed: true,
              },
            }),
      },
    };
  }
  const generatedImageReference =
    itemType === "image_generation"
      ? extractCodexGeneratedImageReference({
          value: source,
          threadId: codexGeneratedImageThreadId(event, payload) ?? canonicalThreadId,
          ...(codexHome ? { codexHome } : {}),
        })
      : undefined;
  if (
    lifecycle === "item.completed" &&
    itemType === "image_generation" &&
    !generatedImageReference
  ) {
    return undefined;
  }

  const canonicalItemType =
    lifecycle === "item.completed" && itemType === "review_exited" ? "assistant_message" : itemType;

  // Only the provider-authored summary is user-visible reasoning. Raw content
  // may contain model trace data and must not leak into transcript activities.
  const detail =
    itemType === "reasoning" ? reasoningSummaryDetail(source) : itemDetail(source, payload ?? {});
  const status =
    source.type === "subAgentActivity" ? "completed" : itemStatus(lifecycle, source.status);
  const title = itemTitle(canonicalItemType, source);
  const asyncQuestions =
    itemType === "assistant_message" && Array.isArray(source.questions)
      ? Schema.decodeUnknownOption(AsyncUserInputQuestions)(
          source.questions.map((value: unknown) => {
            const question = asObject(value);
            return question
              ? question.options == null
                ? { title: question.title }
                : { title: question.title, options: question.options }
              : value;
          }),
        )
      : Option.none();

  return {
    ...(generatedImageReference
      ? withSanitizedGeneratedImageRaw(
          runtimeEventBase(event, canonicalThreadId),
          event,
          canonicalThreadId,
          codexHome,
        )
      : runtimeEventBase(event, canonicalThreadId)),
    type: lifecycle,
    payload: {
      itemType: canonicalItemType,
      ...(Option.isSome(asyncQuestions) ? { asyncQuestions: asyncQuestions.value } : {}),
      ...(status ? { status } : {}),
      ...(canonicalItemType === "context_compaction" &&
      payload?.[CODEX_MANUAL_COMPACTION_MARKER] === true
        ? { source: "manual" as const }
        : {}),
      ...(title ? { title } : {}),
      ...(generatedImageReference
        ? { detail: generatedImageReference.path }
        : detail
          ? { detail }
          : {}),
      ...(generatedImageReference
        ? { data: codexGeneratedImageArtifact(generatedImageReference) }
        : event.payload !== undefined
          ? { data: event.payload }
          : {}),
    },
  };
}

type CodexHookRunStatus = "completed" | "failed" | "blocked" | "stopped";

function toCodexHookRunStatus(value: unknown): CodexHookRunStatus | undefined {
  return value === "completed" || value === "failed" || value === "blocked" || value === "stopped"
    ? value
    : undefined;
}

function toHookOutcome(status: CodexHookRunStatus | undefined): "success" | "error" | "cancelled" {
  if (status === "completed") return "success";
  if (status === "blocked" || status === "stopped") return "cancelled";
  return "error";
}

function hookRunOutput(run: Record<string, unknown>): string | undefined {
  if (!Array.isArray(run.entries)) {
    return undefined;
  }
  const output = run.entries
    .flatMap((entry) => {
      const record = asObject(entry);
      const text = asTrimmedString(record?.text);
      if (!text) return [];
      const kind = asTrimmedString(record?.kind);
      return [kind ? `${kind}: ${text}` : text];
    })
    .join("\n");
  return output ? sanitizeUnmappedProviderDetail(output) : undefined;
}

function withSanitizedHookRaw(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    ...runtimeEventBase(event, canonicalThreadId),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: { mossSanitized: true },
    },
  };
}

function mapCodexHookEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent | undefined {
  if (event.method !== "hook/started" && event.method !== "hook/completed") {
    return undefined;
  }
  const run = asObject(asObject(event.payload)?.run);
  const hookId = asTrimmedString(run?.id);
  const hookEvent = asTrimmedString(run?.eventName);
  if (!run || !hookId || !hookEvent) {
    return undefined;
  }
  const hookName = asTrimmedString(run.sourcePath) ?? asTrimmedString(run.handlerType) ?? hookEvent;
  const statusMessage = sanitizeUnmappedProviderDetail(asTrimmedString(run.statusMessage));
  const data = sanitizeUnmappedProviderData(run);
  const base = withSanitizedHookRaw(event, canonicalThreadId);

  if (event.method === "hook/started") {
    return {
      ...base,
      type: "hook.started",
      payload: {
        hookId,
        hookName,
        hookEvent,
        ...(statusMessage ? { statusMessage } : {}),
        data,
      },
    };
  }

  const status = toCodexHookRunStatus(run.status);
  const durationCandidate = asNumber(run.durationMs);
  const durationMs =
    durationCandidate !== undefined && Number.isInteger(durationCandidate) && durationCandidate >= 0
      ? durationCandidate
      : undefined;
  const output = hookRunOutput(run);
  return {
    ...base,
    type: "hook.completed",
    payload: {
      hookId,
      hookName,
      hookEvent,
      outcome: toHookOutcome(status),
      ...(status ? { status } : {}),
      ...(statusMessage ? { statusMessage } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(output ? { output } : {}),
      data,
    },
  };
}

// Internal metadata and configuration/lifecycle bookkeeping stay in native diagnostics.
const DIAGNOSTIC_ONLY_CODEX_METHODS = new Set([
  "turn/moderationMetadata",
  "item/autoApprovalReview/started",
  "remoteControl/status/changed",
  "skills/changed",
  "session/threadOpenRequested",
  "thread/readState/changed",
]);

function mapUnmappedCodexEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ProviderRuntimeEvent {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const nativeType = sanitizeUnmappedProviderNativeType(event.method);
  const detail = sanitizeUnmappedProviderDetail(
    asTrimmedString(payload?.message) ??
      asTrimmedString(msg?.summary) ??
      asTrimmedString(payload?.reason) ??
      asTrimmedString(payload?.summary) ??
      asTrimmedString(msg?.status) ??
      asTrimmedString(payload?.detail) ??
      asTrimmedString(payload?.status),
  );
  return {
    ...runtimeEventBase(event, canonicalThreadId),
    raw: {
      source: eventRawSource(event),
      method: nativeType,
      payload: { mossSanitized: true },
    },
    type: "event.unmapped",
    payload: {
      nativeType,
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: sanitizeUnmappedProviderData(event.payload) } : {}),
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  codexHome?: CodexGeneratedImageHomeContext,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);
  const generatedImageEndEvent = mapGeneratedImageEndEvent(event, canonicalThreadId, codexHome);
  if (generatedImageEndEvent) {
    return [generatedImageEndEvent];
  }
  const hookEvent = mapCodexHookEvent(event, canonicalThreadId);
  if (hookEvent) {
    return [hookEvent];
  }

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    const treatAsWarning = providerErrorMapsToWarning(event);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: treatAsWarning ? "runtime.warning" : "runtime.error",
        payload: {
          message: event.message,
          ...(!treatAsWarning ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      // The manager refuses (and answers) unrenderable requests, so reaching
      // this branch with no questions means nothing is parked on the reply.
      const questions = parseCodexUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail =
      asString(payload?.command) ??
      asString(payload?.reason) ??
      asString(payload?.prompt) ??
      asString(payload?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/autoApprovalReview/completed") {
    const review = asObject(payload?.review) ?? payload;
    const status = asString(review?.status);
    if (status !== "denied" && status !== "aborted") {
      return [];
    }
    const rationale =
      asString(review?.rationale) ??
      asString(review?.reason) ??
      `Automatic approval review ${status} this action.`;
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.warning",
        payload: {
          message: rationale,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (event.method === "thread/compacting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Context compaction",
          detail: event.message ?? "Compacting context",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = codexErrorMessage(turn?.error);
    const errorCode = codexErrorCode(turn?.error);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(errorCode ? { errorCode } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.tasks.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          tasks: steps.flatMap((entry) => {
            const taskEntry = asObject(entry);
            if (!taskEntry) {
              return [];
            }
            const item = makeRuntimeTaskListItem(
              asString(taskEntry.step) ?? "task",
              taskEntry.status,
            );
            return item ? [item] : [];
          }),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    // Keep the cumulative body once. Metadata records its original UTF-8 size
    // so a journal-compacted prefix cannot masquerade as a complete patch.
    const unifiedDiff =
      asString(payload?.unifiedDiff) ?? asString(payload?.diff) ?? asString(payload?.patch) ?? "";
    const base = runtimeDeltaEventBase(event, canonicalThreadId);
    return [
      {
        ...base,
        type: "turn.diff.updated",
        payload: { unifiedDiff },
        raw: {
          source: base.raw?.source ?? eventRawSource(event),
          method: event.method,
          payload: { unifiedDiffBytes: Buffer.byteLength(unifiedDiff, "utf8") },
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapCodexItemLifecycle(event, canonicalThreadId, "item.started", codexHome);
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(source, payload ?? {});
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapCodexItemLifecycle(event, canonicalThreadId, "item.completed", codexHome);
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    const updated = mapCodexItemLifecycle(event, canonicalThreadId, "item.updated", codexHome);
    return updated ? [updated] : [];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeDeltaEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeDeltaEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const toolUseId = asString(payload?.toolUseId) ?? asString(payload?.itemId);
    const summary = asString(payload?.summary) ?? asString(payload?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(toolUseId ? { toolUseId } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(summary ? { summary } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexDeltaEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    const details = asTrimmedString(payload?.details);
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asTrimmedString(payload?.summary) ?? "Deprecation notice",
          ...(details ? { details } : {}),
        },
      },
    ];
  }

  if (CODEX_RUNTIME_WARNING_METHODS.has(event.method)) {
    const message = asTrimmedString(payload?.message);
    if (
      event.method === "guardianWarning" &&
      message?.startsWith("Automatic approval review approved (")
    ) {
      return [];
    }
    if (event.method === "warning" && message && isCodexDiagnosticWarningMessage(message)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...withMinimalRawPayload(runtimeEventBase(event, canonicalThreadId), event),
        payload: {
          message: sanitizeUnmappedProviderDetail(message, 2_000) ?? "Codex runtime warning",
          ...(event.payload !== undefined
            ? { detail: sanitizeUnmappedProviderData(event.payload) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const details = asTrimmedString(payload?.details);
    const path = asTrimmedString(payload?.path);
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asTrimmedString(payload?.summary) ?? "Configuration warning",
          ...(details ? { details } : {}),
          ...(path ? { path } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeDeltaEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const message = codexErrorMessage(payload?.error) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    const errorCode = codexErrorCode(payload?.error);
    const treatAsWarning = willRetry || isNonFatalCodexErrorMessage(message);
    return [
      {
        type: treatAsWarning ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!treatAsWarning ? { class: "provider_error" as const } : {}),
          ...(!treatAsWarning && errorCode ? { errorCode } : {}),
          ...(willRetry ? { willRetry: true } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  // No explicit mapping matched: keep the event visible instead of dropping
  // it. The raw native method becomes the row title and the raw payload the
  // preview, so a provider protocol addition degrades to a readable row rather
  // than silence.
  return [mapUnmappedCodexEvent(event, canonicalThreadId)];
}

const makeCodexAdapter = (options?: CodexAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettings = Option.getOrUndefined(
      yield* Effect.serviceOption(ServerSettingsService),
    );
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the moss_* MCP tools.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const manager = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (options?.manager) {
          return options.manager;
        }
        // Codex reads the portable root as an extra skill root; Moss's bundled
        // skills (Plugin Creator) must be on disk before the first listing.
        yield* Effect.promise(() => ensureMossBundledSkills(serverConfig.baseDir));
        const services = yield* Effect.services<never>();
        return (
          options?.makeManager?.(services) ??
          new CodexAppServerManager(services, {
            mossSkillsDir: mossSkillsDir(serverConfig.baseDir),
            managedCodexHomePath: path.join(serverConfig.stateDir, "moss-codex-home"),
            readManagedHomeAuthority: (codexOptions) =>
              serverSettings
                ? readManagedCodexHomeAuthority({
                    stateDir: serverConfig.stateDir,
                    readSettings: () => Effect.runPromise(serverSettings.getSettings),
                    readSettingsSync: () => Effect.runSync(serverSettings.getSettings),
                    input: {
                      ...codexOptions,
                      env: { ...process.env, ...codexOptions?.environment },
                    },
                  })
                : Promise.resolve(undefined),
            ...(agentGatewayCredentials
              ? {
                  agentGatewayMcp: {
                    endpointUrl: () => agentGatewayCredentials.mcpEndpointUrl,
                    // Codex leases inside the app-server manager, which owns
                    // session restarts. The manager carries the start input's
                    // capability facts; review runtimes request none.
                    acquireSessionLease: (threadId, capabilityInput) =>
                      acquireAgentGatewaySessionLease(
                        agentGatewayCredentials,
                        threadId,
                        PROVIDER,
                        capabilityInput ?? AGENT_GATEWAY_NO_CAPABILITIES,
                      )!,
                  },
                }
              : {}),
          })
        );
      }),
      (manager) => Effect.promise(() => manager.stopAll()),
    );

    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const shouldSurfaceUnmappedEvent = makeUnmappedProviderEventGate();

    // Idle-progress backstop for codex turns. Same semantics as
    // AcpTurnIdleWatchdog (any inbound activity resets it, a pending human
    // decision pauses it), driven by one shared ticker because codex activity
    // arrives on a single manager event stream instead of per-session fibers.
    const turnWatchdogs = new Map<ThreadId, CodexTurnWatchdogEntry>();
    const sessionProviderInstanceIds = new Map<ThreadId, ProviderInstanceId>();

    const getSessionProviderInstanceId = (threadId: ThreadId): ProviderInstanceId | undefined => {
      const cachedProviderInstanceId = sessionProviderInstanceIds.get(threadId);
      if (cachedProviderInstanceId !== undefined) {
        return cachedProviderInstanceId;
      }
      const providerInstanceId = manager
        .listSessions()
        .find((session) => session.threadId === threadId)?.providerInstanceId;
      if (providerInstanceId !== undefined) {
        sessionProviderInstanceIds.set(threadId, providerInstanceId);
      }
      return providerInstanceId;
    };

    const armTurnWatchdog = (threadId: ThreadId, turnId: TurnId): void => {
      turnWatchdogs.set(threadId, {
        turnId,
        lastActivityAt: Date.now(),
        // Moss managed (CN) providers get a fail-fast first-activity deadline;
        // everything else keeps the generic idle watchdog only.
        firstActivityStartedAt: isCodexMossManagedProviderInstanceId(
          getSessionProviderInstanceId(threadId),
        )
          ? Date.now()
          : null,
      });
    };

    const trackTurnWatchdogActivity = (
      threadId: ThreadId,
      runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>,
    ): void => {
      const entry = turnWatchdogs.get(threadId);
      if (entry) {
        entry.lastActivityAt = Date.now();
      }
      for (const runtimeEvent of runtimeEvents) {
        if (runtimeEvent.type === "turn.started" && runtimeEvent.turnId) {
          armTurnWatchdog(threadId, runtimeEvent.turnId);
        }
        if (isCodexMossFirstActivityProgressEvent(runtimeEvent)) {
          const refreshedEntry = turnWatchdogs.get(threadId);
          if (refreshedEntry !== undefined && refreshedEntry.firstActivityStartedAt !== null) {
            refreshedEntry.firstActivityStartedAt = null;
          }
        }
      }
    };

    const abandonStalledTurn = (
      threadId: ThreadId,
      turnId: TurnId,
      idleMs: number,
      detail?: string,
    ): void => {
      const idleSeconds = Math.round(idleMs / 1000);
      void manager
        .abandonTurn(
          threadId,
          turnId,
          detail ??
            `Codex stopped responding (no activity for ${idleSeconds}s); the turn was aborted.`,
        )
        .catch((cause: unknown) => {
          void Effect.runPromise(
            Effect.logError("Codex idle turn abandon failed", {
              threadId,
              turnId,
              idleMs,
              cause,
            }),
          );
        });
    };

    const evaluateTurnWatchdogs = (): void => {
      const now = Date.now();
      for (const [threadId, entry] of turnWatchdogs) {
        const idleMs = now - entry.lastActivityAt;
        const decision = evaluateAcpTurnIdleTick({
          isTurnActive: manager.isTurnActive(threadId, entry.turnId),
          isAwaitingHuman: manager.isAwaitingHumanResponse(threadId),
          idleMs,
          idleTimeoutMs: CODEX_TURN_IDLE_TIMEOUT_MS,
        });
        if (decision === "continue") {
          continue;
        }
        if (decision === "touch") {
          // Blocked on a human, not hung: keep the clock fresh so the turn
          // cannot trip the watchdog the instant it resumes.
          entry.lastActivityAt = now;
          continue;
        }
        // Both "stop" (the turn already settled) and "timeout" disarm; a timeout
        // disarms first so a slow interrupt cannot let the next tick re-fire.
        turnWatchdogs.delete(threadId);
        if (decision === "timeout") {
          abandonStalledTurn(threadId, entry.turnId, idleMs);
        }
      }
    };

    const evaluateMossFirstActivityWatchdogs = (): void => {
      const now = Date.now();
      for (const [threadId, entry] of turnWatchdogs) {
        if (entry.firstActivityStartedAt === null) {
          continue;
        }
        const decision = evaluateCodexMossFirstActivityTick({
          firstActivityStartedAt: entry.firstActivityStartedAt,
          now,
          timeoutMs: CODEX_MOSS_FIRST_ACTIVITY_TIMEOUT_MS,
          isTurnActive: manager.isTurnActive(threadId, entry.turnId),
          isAwaitingHuman: manager.isAwaitingHumanResponse(threadId),
        });
        if (decision === "continue") {
          continue;
        }
        if (decision === "touch") {
          entry.firstActivityStartedAt = now;
          continue;
        }
        turnWatchdogs.delete(threadId);
        if (decision === "abort") {
          abandonStalledTurn(
            threadId,
            entry.turnId,
            now - entry.firstActivityStartedAt,
            "The provider could not complete this request. Try again shortly.",
          );
        }
      }
    };

    const prepareCodexManagerTurnInput = (
      input: ProviderSendTurnInput,
      method: "turn/start" | "turn/steer",
    ): Effect.Effect<CodexAppServerSendTurnInput, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const nativeCodexAttachments = yield* Effect.forEach(
          filterProviderPromptImageAttachments(input.attachments),
          (attachment) => {
            const attachmentPath = resolveProviderAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              const cause = new Error(`Invalid attachment id '${attachment.id}'.`);
              return Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method,
                  detail: cause.message,
                  cause,
                }),
              );
            }
            return Effect.succeed({ type: "localImage" as const, path: attachmentPath });
          },
          { concurrency: 1 },
        );
        const composedInput = composeCodexInputWithFileAttachments({
          input: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        return {
          threadId: input.threadId,
          ...(composedInput !== undefined ? { input: composedInput } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
          ...codexModelSelectionOverrides(input.modelSelection),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(nativeCodexAttachments.length > 0 ? { attachments: nativeCodexAttachments } : {}),
        } satisfies CodexAppServerSendTurnInput;
      });

    const startSession: CodexAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input.expectedCodexContinuationGeneration
          ? { expectedCodexContinuationGeneration: input.expectedCodexContinuationGeneration }
          : {}),
        ...(input.forkSourceResumeCursor !== undefined
          ? { forkSourceResumeCursor: input.forkSourceResumeCursor }
          : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.additionalDirectories !== undefined
          ? { additionalDirectories: input.additionalDirectories }
          : {}),
        agentGatewayCapabilityInput: captureAgentGatewayCapabilityInput(input),
        ...(input.autoApproveMossTools !== undefined
          ? { autoApproveMossTools: input.autoApproveMossTools }
          : {}),
        runtimeMode: input.runtimeMode,
        ...codexModelSelectionOverrides(input.modelSelection),
      };

      return Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            ...(cause instanceof CodexSessionStartError
              ? { reason: "startup-failed" as const }
              : {}),
            cause,
          }),
      });
    };

    const sendTurn: CodexAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/start");

        return yield* Effect.tryPromise({
          try: () => manager.sendTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
        }).pipe(
          // Armed here as well as on `turn.started`, so a child that goes silent
          // before its first notification is still covered.
          Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const steerTurn: CodexAdapterShape["steerTurn"] = (input) =>
      Effect.gen(function* () {
        const managerInput = yield* prepareCodexManagerTurnInput(input, "turn/steer");

        return yield* Effect.tryPromise({
          try: () => manager.steerTurn(managerInput),
          catch: (cause) => toRequestError(input.threadId, "turn/steer", cause),
        }).pipe(
          Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
          // The `turn/steer` response carries no runtime event and the model
          // only consumes injected input at its next turn boundary, so without
          // this a landed steer is indistinguishable from a dropped one.
          Effect.tap((result) => {
            const message = input.input?.trim();
            if (!message) {
              return Effect.void;
            }
            return Queue.offer(runtimeEventQueue, {
              type: "turn.steered",
              eventId: EventId.makeUnsafe(crypto.randomUUID()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: result.turnId,
              createdAt: new Date().toISOString(),
              payload: { message, target: "turn" },
            });
          }),
          Effect.map((result) => ({
            ...result,
            threadId: input.threadId,
          })),
        );
      });

    const startReview: CodexAdapterShape["startReview"] = (input) =>
      Effect.tryPromise({
        try: () => manager.startReview(input),
        catch: (cause) => toRequestError(input.threadId, "review/start", cause),
      }).pipe(
        Effect.tap((result) => Effect.sync(() => armTurnWatchdog(input.threadId, result.turnId))),
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );

    const interruptTurn: CodexAdapterShape["interruptTurn"] = (
      threadId,
      turnId,
      providerThreadId,
    ) =>
      Effect.tryPromise({
        try: () => manager.interruptTurn(threadId, turnId, providerThreadId),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

    const readThread: CodexAdapterShape["readThread"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.readThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/read", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const readExternalThread: NonNullable<CodexAdapterShape["readExternalThread"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readExternalThread({
            externalThreadId: input.externalThreadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/read",
            detail: toMessage(cause, "Failed to read external Codex thread."),
            cause,
          }),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId: ThreadId.makeUnsafe(snapshot.threadId),
          turns: snapshot.turns,
          cwd: snapshot.cwd ?? null,
        })),
      );

    const readExternalThreadPage: NonNullable<CodexAdapterShape["readExternalThreadPage"]> = (
      input,
    ) =>
      Effect.tryPromise({
        try: () =>
          manager.readExternalThreadPage({
            externalThreadId: input.externalThreadId,
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
          }),
        catch: (cause) =>
          toRequestError(ThreadId.makeUnsafe(input.externalThreadId), "thread/turns/list", cause),
      }).pipe(Effect.map((page) => ({ ...page, threadId: ThreadId.makeUnsafe(page.threadId) })));

    const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          }),
        );
      }

      return Effect.tryPromise({
        try: () => manager.rollbackThread(threadId, numTurns),
        catch: (cause) => toRequestError(threadId, "thread/revert", cause),
      }).pipe(
        Effect.map((snapshot) => ({
          threadId,
          turns: snapshot.turns,
        })),
      );
    };

    const compactThread: NonNullable<CodexAdapterShape["compactThread"]> = (threadId) =>
      Effect.tryPromise({
        try: () => manager.compactThread(threadId),
        catch: (cause) => toRequestError(threadId, "thread/compact/start", cause),
      });

    const forkThread: CodexAdapterShape["forkThread"] = (input) =>
      Effect.tryPromise({
        try: (signal) => manager.forkThread(input, signal),
        catch: (cause) => toRequestError(input.sourceThreadId, "thread/fork", cause),
      });

    const predictNextUserMessage: NonNullable<CodexAdapterShape["predictNextUserMessage"]> = (
      threadId,
      input,
    ) =>
      Effect.tryPromise({
        try: (signal) =>
          manager.predictNextUserMessage(
            threadId,
            { ...input, effort: NEXT_MESSAGE_PREDICTION_CODEX_REASONING_EFFORT },
            signal,
          ),
        catch: (cause) => toRequestError(threadId, "thread/fork", cause),
      });

    const respondToRequest: CodexAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToRequest(threadId, requestId, decision),
        catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
      });

    const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: () => manager.respondToUserInput(threadId, requestId, answers),
        catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
      });

    const stopAccountContextsAndWait: CodexAdapterShape["stopAccountContextsAndWait"] = (input) =>
      Effect.tryPromise({
        try: () => manager.stopAccountContextsAndWait(input),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "account/runtime/stop",
            detail: toMessage(cause, "Failed to stop Codex account runtimes."),
            cause,
          }),
      });

    const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: () => manager.stopSession(threadId),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to stop Codex adapter session."),
            cause,
          }),
      });

    const listSessions: CodexAdapterShape["listSessions"] = () =>
      Effect.sync(() => manager.listSessions());

    const listGeneratedImageHomePaths: NonNullable<
      CodexAdapterShape["listGeneratedImageHomePaths"]
    > = (input) =>
      Effect.sync(() => {
        const homePaths = new Map<string, CodexGeneratedImageHomeCandidate>();
        for (const { session, codexOptions } of manager.inspectSessions()) {
          const instanceId = session.providerInstanceId ?? (PROVIDER as ProviderInstanceId);
          if (
            input?.enabledProviderInstanceIds &&
            !input.enabledProviderInstanceIds.has(instanceId)
          ) {
            continue;
          }
          if (!codexOptions) {
            continue;
          }
          const candidateKey =
            typeof codexOptions === "string"
              ? `path:${codexOptions}`
              : JSON.stringify(codexOptions);
          homePaths.set(candidateKey, codexOptions);
        }
        return [...homePaths.values()];
      });

    const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => manager.hasSession(threadId));

    const stopAll: CodexAdapterShape["stopAll"] = () =>
      Effect.tryPromise({
        try: () => manager.stopAll(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.makeUnsafe("codex:all"),
            detail: toMessage(cause, "Failed to stop all Codex app-server processes."),
            cause,
          }),
      });

    const getComposerCapabilities: NonNullable<CodexAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed(manager.getComposerCapabilities() satisfies ProviderComposerCapabilities);

    const listSkills: NonNullable<CodexAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listSkills({
            cwd: input.cwd,
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skills/list",
            detail: toMessage(cause, "skills/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListSkillsResult));

    const listPlugins: NonNullable<CodexAdapterShape["listPlugins"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listPlugins({
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
            ...(input.marketplaceKinds !== undefined
              ? { marketplaceKinds: input.marketplaceKinds }
              : {}),
            ...(input.forceRemoteSync !== undefined
              ? { forceRemoteSync: input.forceRemoteSync }
              : {}),
            ...(input.forceReload !== undefined ? { forceReload: input.forceReload } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/list",
            detail: toMessage(cause, "plugin/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListPluginsResult));

    const readPlugin: NonNullable<CodexAdapterShape["readPlugin"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readPlugin({
            marketplacePath: input.marketplacePath,
            pluginName: input.pluginName,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/read",
            detail: toMessage(cause, "plugin/read failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderReadPluginResult));

    const installPlugin: NonNullable<CodexAdapterShape["installPlugin"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.installPlugin({
            ...(input.marketplacePath !== undefined
              ? { marketplacePath: input.marketplacePath }
              : {}),
            ...(input.remoteMarketplaceName !== undefined
              ? { remoteMarketplaceName: input.remoteMarketplaceName }
              : {}),
            pluginName: input.pluginName,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/install",
            detail: toMessage(cause, "plugin/install failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderInstallPluginResult));

    const addMarketplace: NonNullable<CodexAdapterShape["addMarketplace"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.addMarketplace({
            source: input.source,
            refName: input.refName,
            sparsePaths: input.sparsePaths,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "marketplace/add",
            detail: toMessage(cause, "marketplace/add failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderAddMarketplaceResult));

    const removeMarketplace: NonNullable<CodexAdapterShape["removeMarketplace"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.removeMarketplace({
            marketplaceName: input.marketplaceName,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "marketplace/remove",
            detail: toMessage(cause, "marketplace/remove failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderRemoveMarketplaceResult));

    const upgradeMarketplace: NonNullable<CodexAdapterShape["upgradeMarketplace"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.upgradeMarketplace({
            ...(input.marketplaceName !== undefined
              ? { marketplaceName: input.marketplaceName }
              : {}),
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "marketplace/upgrade",
            detail: toMessage(cause, "marketplace/upgrade failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderUpgradeMarketplaceResult));

    const uninstallPlugin: NonNullable<CodexAdapterShape["uninstallPlugin"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.uninstallPlugin({
            pluginId: input.pluginId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "plugin/uninstall",
            detail: toMessage(cause, "plugin/uninstall failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderUninstallPluginResult));

    const setPluginEnabled: NonNullable<CodexAdapterShape["setPluginEnabled"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.setPluginEnabled({
            pluginId: input.pluginId,
            enabled: input.enabled,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "config/batchWrite",
            detail: toMessage(cause, "config/batchWrite failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderSetPluginEnabledResult));

    const listApps: NonNullable<CodexAdapterShape["listApps"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listApps({
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            ...(input.forceRefetch !== undefined ? { forceRefetch: input.forceRefetch } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "app/list",
            detail: toMessage(cause, "app/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListAppsResult));

    const setAppEnabled: NonNullable<CodexAdapterShape["setAppEnabled"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.setAppEnabled({
            appId: input.appId,
            enabled: input.enabled,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "config/batchWrite",
            detail: toMessage(cause, "config/batchWrite failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderSetAppEnabledResult));

    const readAppTools: NonNullable<CodexAdapterShape["readAppTools"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readAppTools({
            appId: input.appId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "connector/readTools",
            detail: toMessage(cause, "connector/readTools failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderReadAppToolsResult));

    const readAppConnector: NonNullable<CodexAdapterShape["readAppConnector"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.readAppConnector({
            appId: input.appId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "connector/read",
            detail: toMessage(cause, "connector/read failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderReadAppConnectorResult));

    const readAppConnectorTerms: NonNullable<CodexAdapterShape["readAppConnectorTerms"]> = (
      input,
    ) =>
      Effect.tryPromise({
        try: () =>
          manager.readAppConnectorTerms({
            appId: input.appId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "connector/readTerms",
            detail: toMessage(cause, "connector/readTerms failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderReadAppConnectorTermsResult));

    const startAppConnection: NonNullable<CodexAdapterShape["startAppConnection"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.startAppConnection({
            appId: input.appId,
            callbackUrl: input.callbackUrl,
            postAuthUrl: input.postAuthUrl,
            reauthentication: input.reauthentication,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "connector/connect",
            detail: toMessage(cause, "connector/connect failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderStartAppConnectionResult));

    const completeAppConnection: NonNullable<CodexAdapterShape["completeAppConnection"]> = (
      input,
    ) =>
      Effect.tryPromise({
        try: () =>
          manager.completeAppConnection({
            fullRedirectUrl: input.fullRedirectUrl,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "connector/complete",
            detail: toMessage(cause, "connector/complete failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderCompleteAppConnectionResult));

    const listModels: NonNullable<CodexAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.listModels({
            ...(input.cwd ? { cwd: input.cwd } : {}),
            codexOptions: codexDiscoveryOptions(input),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "model/list failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ProviderListModelsResult));

    const transcribeVoice: NonNullable<CodexAdapterShape["transcribeVoice"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          manager.transcribeVoice({
            ...input,
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "voice/transcribe",
            detail: toMessage(cause, "voice/transcribe failed"),
            cause,
          }),
      }).pipe(Effect.map((result) => result satisfies ServerVoiceTranscriptionResult));

    const prewarmVoice: NonNullable<CodexAdapterShape["prewarmVoice"]> = (input) =>
      Effect.tryPromise({
        try: () => {
          assertServerResolvedVoiceRouteAuthority({
            provider: input.provider,
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
            ...(input.serverResolvedVoiceRouteAuthority
              ? {
                  serverResolvedVoiceRouteAuthority: input.serverResolvedVoiceRouteAuthority,
                }
              : {}),
          });
          return manager.prewarmVoice({
            cwd: input.cwd,
            ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            ...(input.providerOptions?.codex ? { codexOptions: input.providerOptions.codex } : {}),
            ...(input.serverResolvedVoiceRouteAuthority
              ? {
                  serverResolvedVoiceRouteAuthority: input.serverResolvedVoiceRouteAuthority,
                }
              : {}),
          });
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "voice/prewarm",
            detail: toMessage(cause, "voice/prewarm failed"),
            cause,
          }),
      });

    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const writeNativeEvent = (event: ProviderEvent) =>
          Effect.gen(function* () {
            if (!nativeEventLogger) {
              return;
            }
            yield* nativeEventLogger.write(event, event.threadId);
          });
        const filterRuntimeEvents = (
          event: ProviderEvent,
          events: ReadonlyArray<ProviderRuntimeEvent>,
        ) =>
          events.filter(
            (runtimeEvent) =>
              runtimeEvent.type !== "event.unmapped" ||
              (!DIAGNOSTIC_ONLY_CODEX_METHODS.has(event.method) &&
                shouldSurfaceUnmappedEvent(event)),
          );

        const ingress = yield* makeBoundedCallbackIngress<
          CodexRuntimeIngressItem,
          never,
          never,
          CodexSessionInspection | null | undefined
        >(
          (item, inspection) =>
            Effect.gen(function* () {
              if (!item.trustedClose && (inspection === null || item.isAuthRejected())) return;
              yield* writeNativeEvent(item.nativeEvent).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Codex native event logging failed", {
                    threadId: item.nativeEvent.threadId,
                    method: item.nativeEvent.method,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
              const runtimeEvents = item.runtimeEvents;
              if (runtimeEvents.length === 0) {
                yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                  method: item.nativeEvent.method,
                  threadId: item.nativeEvent.threadId,
                  turnId: item.nativeEvent.turnId,
                  itemId: item.nativeEvent.itemId,
                });
                return;
              }
              if (item.trustedClose || !item.isAuthRejected())
                yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
            }),
          {
            prepareConcurrency: 8,
            prepareKey: (item) => (item.trustedClose ? undefined : item.validationKey),
            prepare: ({
              inspect,
              trustedClose,
              isAuthRejected,
              rejectInspection,
              nativeEvent: { threadId },
            }) => {
              if (trustedClose) return Promise.resolve(undefined);
              if (isAuthRejected()) return Promise.resolve(null);
              return Promise.resolve()
                .then(inspect)
                .catch((error: unknown) => {
                  if (error instanceof CodexSessionAuthInvalidatedError) return null;
                  rejectInspection();
                  void Effect.runPromise(
                    Effect.logError("Codex callback auth inspection failed; origin rejected", {
                      threadId,
                    }),
                  );
                  return null;
                });
            },
            capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
            maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
            terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
            isTerminal: (item) => item.runtimeEvents.some(isTerminalProviderRuntimeEvent),
            sizeOf: (item) => item.bytes,
          },
        );
        let nextDroppedWarning = 1;
        const listener = (event: ProviderEvent) => {
          const origin = manager.getSessionEventOrigin(event.threadId, event.lifecycleGeneration);
          const stampedEvent = stampEvent(event, origin.providerInstanceId);
          const mappedRuntimeEvents = assignDerivedProviderRuntimeEventIds(
            mapToRuntimeEvents(stampedEvent, stampedEvent.threadId, origin.codexOptions),
          );
          const hasUnmappedEvent = mappedRuntimeEvents.some(
            (runtimeEvent) => runtimeEvent.type === "event.unmapped",
          );
          const sizedRuntimeEvents = filterRuntimeEvents(stampedEvent, mappedRuntimeEvents).map(
            compactProviderRuntimeEventForIngress,
          );
          const runtimeEvents = sizedRuntimeEvents.map((item) => item.event);
          trackTurnWatchdogActivity(stampedEvent.threadId, runtimeEvents);
          const nativeEvent = compactCodexNativeEventForIngress(
            hasUnmappedEvent || CODEX_RUNTIME_WARNING_METHODS.has(stampedEvent.method)
              ? sanitizeUnmappedProviderEvent(stampedEvent)
              : stampedEvent,
          );
          const result = ingress.offer({
            nativeEvent: nativeEvent.event,
            inspect: origin.inspect,
            isAuthRejected: origin.isAuthRejected,
            validationKey: origin.validationKey,
            rejectInspection: origin.rejectInspection,
            // This notice is authored by the manager, not by provider stdout.
            // Stale auth must suppress provider output but still durably close its session.
            trustedClose: event.kind === "session" && event.method === "session/closed",
            runtimeEvents,
            bytes:
              nativeEvent.bytes + sizedRuntimeEvents.reduce((total, item) => total + item.bytes, 0),
          });
          if (result === "dropped" || result === "evicted-for-terminal") {
            const status = ingress.status();
            // Report the first loss and exponentially spaced totals, not one warning per delta.
            if (status.dropped >= nextDroppedWarning) {
              while (nextDroppedWarning <= status.dropped) nextDroppedWarning *= 2;
              void Effect.runPromise(
                Effect.logWarning("Codex callback ingress dropped provider events", {
                  threadId: stampedEvent.threadId,
                  method: stampedEvent.method,
                  status,
                }),
              );
            }
          }
          if (result === "terminal-overflow") {
            // This means the reserved terminal budget itself was exhausted.
            // The runtime reconciler remains the final recovery fence.
            void Effect.runPromise(
              Effect.logError("Codex callback ingress exhausted terminal reserve", {
                threadId: stampedEvent.threadId,
                method: stampedEvent.method,
                status: ingress.status(),
              }),
            );
          }
        };
        manager.on("event", listener);
        const watchdogTicker = setInterval(() => {
          evaluateTurnWatchdogs();
          evaluateMossFirstActivityWatchdogs();
        }, CODEX_TURN_WATCHDOG_INTERVAL_MS);
        watchdogTicker.unref();
        return { ingress, listener, watchdogTicker };
      }),
      ({ ingress, listener, watchdogTicker }) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            clearInterval(watchdogTicker);
            turnWatchdogs.clear();
            manager.off("event", listener);
          });
          yield* ingress.abort;
          yield* Queue.shutdown(runtimeEventQueue);
        }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
        supportsLiveTurnDiffPatch: true,
      },
      startSession,
      didResumeSession: (input, session) => {
        const requestedThreadId = readResumeCursorThreadId(input.resumeCursor);
        return (
          requestedThreadId !== undefined &&
          readResumeCursorThreadId(session.resumeCursor) === requestedThreadId
        );
      },
      sendTurn,
      steerTurn,
      startReview,
      interruptTurn,
      readThread,
      readExternalThread,
      readExternalThreadPage,
      rollbackThread,
      compactThread,
      predictNextUserMessage,
      forkThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopAccountContextsAndWait,
      renewAgentGatewayCredential: (threadId) =>
        Effect.tryPromise({
          try: () => manager.renewAgentGatewayCredential(threadId),
          catch: (cause) => toRequestError(threadId, "thread/resume", cause),
        }),
      listSessions,
      listGeneratedImageHomePaths,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listSkills,
      listPlugins,
      readPlugin,
      installPlugin,
      addMarketplace,
      removeMarketplace,
      upgradeMarketplace,
      uninstallPlugin,
      setPluginEnabled,
      listApps,
      setAppEnabled,
      readAppTools,
      readAppConnector,
      readAppConnectorTerms,
      startAppConnection,
      completeAppConnection,
      listModels,
      prewarmVoice,
      transcribeVoice,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
      // App-server notifications get a fresh local UUID; this queue has no replay.
      runtimeEventDelivery: "fresh-ids-once",
    } satisfies CodexAdapterShape;
  });

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
