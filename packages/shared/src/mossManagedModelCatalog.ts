import {
  isMossModelEnabledOnUpstream,
  MOSS_MANAGED_MODEL_DEFINITIONS,
  MOSS_UPSTREAM_PROVIDERS,
} from "./mossRealmCatalog";

export const MANAGED_GATEWAY_TEXT_ENDPOINTS = [
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses",
] as const;

export const MANAGED_GATEWAY_AUDIO_ENDPOINT = "/v1/audio/transcriptions" as const;

export type ManagedGatewayTextPath = (typeof MANAGED_GATEWAY_TEXT_ENDPOINTS)[number];
export type ManagedGatewayPath =
  | ManagedGatewayTextPath
  | "/v1/models"
  | typeof MANAGED_GATEWAY_AUDIO_ENDPOINT;
export type ManagedGatewayDocumentationSupport =
  | "protocol_documented"
  | "catalog_only"
  | "unsupported_modality";
export type ManagedGatewayValidationStatus = "live_passed" | "needs_probe" | "blocked";

export interface ManagedGatewayModelRecord {
  readonly id: string;
  readonly family: "codex" | "claude" | "openai-chat" | "deepseek" | "kimi" | "other";
  readonly documentationSupport: ManagedGatewayDocumentationSupport;
  readonly validationStatus: ManagedGatewayValidationStatus;
  readonly endpoints: ReadonlyArray<ManagedGatewayTextPath>;
  readonly source:
    | "openrouter-chat-completions-doc"
    | "openrouter-messages-doc"
    | "openrouter-responses-doc"
    | "openrouter-live-catalog";
}

export interface ManagedGatewayAudioEntitlement {
  readonly id: "whisper-1";
  readonly documentationSupport: "protocol_documented";
  readonly validationStatus: "needs_probe" | "live_passed";
  readonly endpoint: typeof MANAGED_GATEWAY_AUDIO_ENDPOINT;
  readonly source: "openrouter-whisper-doc";
}

/**
 * Canonical managed-gateway capability catalog.
 *
 * Documentation/protocol evidence and live validation are independent. Only a
 * `live_passed` record is production-enabled; discovery/UI or documentation
 * without a sanitized successful probe stays `needs_probe`. An intentionally
 * unsupported modality stays `blocked`.
 * The deployable Edge Function keeps a checked mirror because its deployment
 * bundle cannot depend on workspace packages. The adjacent contract test makes
 * any mirror drift a release-gate failure.
 */
const MANAGED_GATEWAY_MODEL_RECORD_DEFINITIONS = [
  {
    id: "gpt-5",
    family: "openai-chat",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-chat-completions-doc",
  },
  {
    id: "gpt-5.1",
    family: "codex",
    validationStatus: "live_passed",
    endpoints: ["/v1/responses"],
    source: "openrouter-live-catalog",
  },
  {
    id: "gpt-5.1-2025-11-13",
    family: "codex",
    validationStatus: "live_passed",
    endpoints: ["/v1/responses"],
    source: "openrouter-live-catalog",
  },
  {
    id: "gpt-5-chat-latest",
    family: "openai-chat",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-live-catalog",
  },
  {
    id: "gpt-5-mini",
    family: "openai-chat",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-live-catalog",
  },
  {
    id: "gpt-5.5",
    family: "codex",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-responses-doc",
  },
  {
    id: "gpt-5.4",
    family: "codex",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-responses-doc",
  },
  {
    id: "gpt-5.4-mini",
    family: "codex",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-responses-doc",
  },
  {
    id: "gpt-5.3-codex",
    family: "codex",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-responses-doc",
  },
  {
    id: "gpt-5.2",
    family: "codex",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-responses-doc",
  },
  ...[
    "gpt-5-codex",
    "gpt-5-pro",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2-codex",
    "gpt-5.2-pro",
    "gpt-5.4-nano",
    "gpt-5.4-pro",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ].map((id) => ({
    id,
    family: "codex" as const,
    validationStatus: "needs_probe" as const,
    endpoints: ["/v1/responses" as const],
    source: "openrouter-live-catalog" as const,
  })),
  {
    id: "claude-opus-4-6",
    family: "claude",
    validationStatus: "needs_probe",
    endpoints: ["/v1/messages"],
    source: "openrouter-messages-doc",
  },
  {
    id: "claude-sonnet-4-6",
    family: "claude",
    validationStatus: "live_passed",
    endpoints: ["/v1/messages"],
    source: "openrouter-messages-doc",
  },
  ...[
    "claude-fable-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5-20251001-thinking",
    "claude-opus-4-5-20251101",
    "claude-opus-4-5-20251101-thinking",
    "claude-opus-4-6-thinking",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5-20250929-thinking",
    "claude-sonnet-4-6-thinking",
    "claude-sonnet-5",
  ].map((id) => ({
    id,
    family: "claude" as const,
    validationStatus: "needs_probe" as const,
    endpoints: ["/v1/messages" as const],
    source: "openrouter-live-catalog" as const,
  })),
  {
    id: "deepseek-v4-pro",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-live-catalog",
  },
  {
    id: "deepseek-v4-flash",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-live-catalog",
  },
  {
    id: "deepseek-v3.2",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-live-catalog",
  },
  {
    id: "deepseek-v3.2-exp",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-live-catalog",
  },
  {
    id: "deepseek-r1-250528",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-chat-completions-doc",
  },
  {
    id: "deepseek-v3-0324",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-chat-completions-doc",
  },
  {
    id: "deepseek-r1",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/chat/completions"],
    source: "openrouter-live-catalog",
  },
  {
    id: "deepseek-r1-0528",
    family: "deepseek",
    validationStatus: "needs_probe",
    endpoints: ["/v1/responses"],
    source: "openrouter-live-catalog",
  },
  ...["deepseek-v3", "deepseek-v3.1", "deepseek-v3.1-terminus", "deepseek-v3.2-think"].map(
    (id) => ({
      id,
      family: "deepseek" as const,
      validationStatus: "needs_probe" as const,
      endpoints: ["/v1/chat/completions" as const],
      source: "openrouter-live-catalog" as const,
    }),
  ),
  {
    id: "deepseek-ocr",
    family: "other",
    validationStatus: "blocked",
    endpoints: [],
    source: "openrouter-live-catalog",
  },
  ...["kimi-k2-instruct", "kimi-k2-thinking"].map((id) => ({
    id,
    family: "kimi" as const,
    validationStatus: "needs_probe" as const,
    endpoints: ["/v1/responses" as const],
    source: "openrouter-live-catalog" as const,
  })),
  ...["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3"].map(
    (id) => ({
      id,
      family: "kimi" as const,
      validationStatus: "needs_probe" as const,
      endpoints: ["/v1/chat/completions" as const],
      source: "openrouter-live-catalog" as const,
    }),
  ),
] as const;

// Sanitized live probes require HTTP 2xx, a protocol-valid output, a usage
// object, and no typed error. Models omitted here stay fail-closed even when
// they appear in upstream discovery catalogs or vendor documentation.
const LIVE_PASSED_TEXT_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.1",
  "gpt-5.1-2025-11-13",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5-pro",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5-20251001-thinking",
  "claude-opus-4-5-20251101",
  "claude-opus-4-5-20251101-thinking",
  "claude-opus-4-6",
  "claude-opus-4-6-thinking",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-5-20250929-thinking",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking",
  "claude-sonnet-5",
  "deepseek-r1",
  "deepseek-r1-0528",
  "deepseek-v3",
  "deepseek-v3.1-terminus",
  "deepseek-v3.2",
  "deepseek-v3.2-exp",
  "deepseek-v3.2-think",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "kimi-k2-instruct",
  "kimi-k2-thinking",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k3",
]);

export const MANAGED_GATEWAY_MODEL_RECORDS: ReadonlyArray<ManagedGatewayModelRecord> =
  MANAGED_GATEWAY_MODEL_RECORD_DEFINITIONS.map((record) => {
    const validationStatus: ManagedGatewayValidationStatus =
      record.validationStatus === "blocked"
        ? "blocked"
        : LIVE_PASSED_TEXT_MODEL_IDS.has(record.id)
          ? "live_passed"
          : "needs_probe";
    return {
      ...record,
      validationStatus,
      documentationSupport:
        validationStatus === "blocked"
          ? "unsupported_modality"
          : record.source === "openrouter-live-catalog"
            ? "catalog_only"
            : "protocol_documented",
    };
  });

export const MANAGED_GATEWAY_AUDIO_ENTITLEMENT: ManagedGatewayAudioEntitlement = {
  id: "whisper-1",
  documentationSupport: "protocol_documented",
  validationStatus: "live_passed",
  endpoint: MANAGED_GATEWAY_AUDIO_ENDPOINT,
  source: "openrouter-whisper-doc",
};

const MANAGED_GATEWAY_MODEL_RECORD_BY_ID: ReadonlyMap<string, ManagedGatewayModelRecord> = new Map(
  MANAGED_GATEWAY_MODEL_RECORDS.map((record) => [record.id, record] as const),
);

export function getManagedGatewayModelRecord(model: string): ManagedGatewayModelRecord | null {
  return MANAGED_GATEWAY_MODEL_RECORD_BY_ID.get(model) ?? null;
}

export function isManagedGatewayModelEnabledForPath(
  model: string,
  path: ManagedGatewayPath,
): boolean {
  if (path === MANAGED_GATEWAY_AUDIO_ENDPOINT) return false;
  if (path === "/v1/models") {
    return getManagedGatewayModelRecord(model)?.validationStatus === "live_passed";
  }
  const record = getManagedGatewayModelRecord(model);
  return record?.validationStatus === "live_passed" && record.endpoints.includes(path)
    ? true
    : false;
}

/**
 * The Moss source directory is intentionally finite even while the historical
 * legacy gateway record mirror retains older rows for decoding and
 * auditability. The realm catalog (`mossRealmCatalog.ts`) is the source of
 * truth for which model each realm's upstream serves on which protocol; the
 * lists below are the cross-realm union that coarse consumers (web filters,
 * discovery) use before the realm-specific runtime narrows them further.
 */
export const MOSS_SOURCE_MODEL_IDS: ReadonlyArray<string> = MOSS_MANAGED_MODEL_DEFINITIONS.filter(
  (definition) => definition.family !== "claude",
).map((definition) => definition.id);

export const MOSS_CODEX_RESPONSES_MODEL_IDS: ReadonlyArray<string> = MOSS_SOURCE_MODEL_IDS.filter(
  (model) =>
    MOSS_UPSTREAM_PROVIDERS.some(
      (provider) =>
        isMossModelEnabledOnUpstream(model, provider, "/v1/responses") ||
        isMossModelEnabledOnUpstream(model, provider, "/v1/chat/completions"),
    ),
);

export function isManagedGatewayAudioModelEnabled(model: string): boolean {
  return (
    model === MANAGED_GATEWAY_AUDIO_ENTITLEMENT.id &&
    MANAGED_GATEWAY_AUDIO_ENTITLEMENT.validationStatus === "live_passed"
  );
}

export function filterManagedGatewayModelsForPath(
  models: readonly string[] | undefined,
  path: ManagedGatewayPath,
): ReadonlyArray<string> {
  return (models ?? []).filter((model) => isManagedGatewayModelEnabledForPath(model, path));
}

/** Managed Codex provisioning is Responses-only; Kimi K3 remains chat-only. */
export const MANAGED_GATEWAY_CODEX_ENABLED_MODELS = MOSS_CODEX_RESPONSES_MODEL_IDS;

export const MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS = MANAGED_GATEWAY_MODEL_RECORDS.filter(
  (record) =>
    record.family === "claude" &&
    record.validationStatus === "live_passed" &&
    record.endpoints.includes("/v1/messages"),
).map((record) => record.id);

/** Chat-capable Moss models of one family across every realm upstream. */
function enabledChatModelIdsForFamily(
  family: "deepseek" | "kimi" | "glm" | "qwen" | "minimax",
): ReadonlyArray<string> {
  return MOSS_MANAGED_MODEL_DEFINITIONS.filter(
    (definition) =>
      definition.family === family &&
      MOSS_UPSTREAM_PROVIDERS.some((provider) =>
        isMossModelEnabledOnUpstream(definition.id, provider, "/v1/chat/completions"),
      ),
  ).map((definition) => definition.id);
}

export const MANAGED_GATEWAY_DEEPSEEK_CHAT_ENABLED_MODEL_IDS =
  enabledChatModelIdsForFamily("deepseek");

export const MANAGED_GATEWAY_KIMI_CHAT_ENABLED_MODEL_IDS = enabledChatModelIdsForFamily("kimi");

/**
 * OpenCode custom-provider slugs keep one stable `moss` provider namespace and
 * present every chat-capable non-Claude model; the regional gateway rejects the
 * few a realm cannot serve.
 */
export const MANAGED_GATEWAY_OPENCODE_ENABLED_MODELS = MOSS_SOURCE_MODEL_IDS.filter((model) =>
  MOSS_UPSTREAM_PROVIDERS.some((provider) =>
    isMossModelEnabledOnUpstream(model, provider, "/v1/chat/completions"),
  ),
).map((model) => `moss/${model}`);

function productionDefault(candidate: string, enabledModels: ReadonlyArray<string>): string | null {
  return enabledModels.includes(candidate) ? candidate : null;
}

export const MANAGED_GATEWAY_CODEX_DEFAULT_MODEL = productionDefault(
  "gpt-5.6-terra",
  MANAGED_GATEWAY_CODEX_ENABLED_MODELS,
);

export const MANAGED_GATEWAY_CLAUDE_DEFAULT_MODEL = productionDefault(
  "claude-sonnet-5",
  MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS,
);

export const MANAGED_GATEWAY_OPENCODE_DEFAULT_MODEL = productionDefault(
  "moss/kimi-k3",
  MANAGED_GATEWAY_OPENCODE_ENABLED_MODELS,
);
