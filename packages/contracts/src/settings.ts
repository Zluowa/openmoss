import { Schema } from "effect";
import { IsoDateTime, TrimmedString } from "./baseSchemas";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "./model";
import { ModelSelection, ProviderKind, ThreadEnvironmentMode } from "./orchestration";
import { ProviderInstanceConfigMap, ProviderInstanceId } from "./providerInstance";

const StringSetting = TrimmedString.check(Schema.isMaxLength(4096));
const CustomModels = Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
  Schema.withDecodingDefault(() => []),
);
export const DEFAULT_CODEX_ACCOUNT_ID = "default";

// How long an idle side chat stays usable before the server expires it.
export const SidechatExpiry = Schema.Literals(["1h", "24h", "never"]);
export type SidechatExpiry = typeof SidechatExpiry.Type;

export const SourceControlWritingStyle = Schema.Literals(["repository", "conventional", "custom"]);
export type SourceControlWritingStyle = typeof SourceControlWritingStyle.Type;
export const MAX_SOURCE_CONTROL_CUSTOM_INSTRUCTIONS_LENGTH = 4096;
export const SourceControlCustomInstructions = Schema.String.check(
  Schema.isMaxLength(MAX_SOURCE_CONTROL_CUSTOM_INSTRUCTIONS_LENGTH),
);

export const CodexAccountId = TrimmedString.check(Schema.isMaxLength(64));
export type CodexAccountId = typeof CodexAccountId.Type;

export const CodexAccountConfig = Schema.Struct({
  id: CodexAccountId,
  label: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  homePath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  shadowHomePath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type CodexAccountConfig = typeof CodexAccountConfig.Type;

const CodexAccountConfigs = Schema.Array(CodexAccountConfig).pipe(
  Schema.withDecodingDefault(() => []),
);

const ProviderSettingsBase = {
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  customModels: CustomModels,
};

export const CodexServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "codex")),
  homePath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  accounts: CodexAccountConfigs,
  selectedAccountId: CodexAccountId.pipe(
    Schema.withDecodingDefault(() => DEFAULT_CODEX_ACCOUNT_ID),
  ),
});
export type CodexServerProviderSettings = typeof CodexServerProviderSettings.Type;

export const ClaudeServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "claude")),
  homePath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  launchArgs: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(() => ""),
  ),
  // Claude Code keeps Artifact publishing (and `/design`, `/slides`) off for
  // Agent SDK sessions unless the host opts in.
  enableArtifacts: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type ClaudeServerProviderSettings = typeof ClaudeServerProviderSettings.Type;

export const AntigravityServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "agy")),
});
export type AntigravityServerProviderSettings = typeof AntigravityServerProviderSettings.Type;

export const GrokServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "grok")),
});
export type GrokServerProviderSettings = typeof GrokServerProviderSettings.Type;

export const DroidServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "droid")),
});
export type DroidServerProviderSettings = typeof DroidServerProviderSettings.Type;

export const CursorServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "cursor-agent")),
  apiEndpoint: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type CursorServerProviderSettings = typeof CursorServerProviderSettings.Type;

export const OpenCodeServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "opencode")),
  serverUrl: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  serverPasswordConfigured: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  experimentalWebSockets: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type OpenCodeServerProviderSettings = typeof OpenCodeServerProviderSettings.Type;

export const PiServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "pi")),
  agentDir: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type PiServerProviderSettings = typeof PiServerProviderSettings.Type;
export const OmpServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "omp")),
  agentDir: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type OmpServerProviderSettings = typeof OmpServerProviderSettings.Type;

export const GeminiServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "gemini")),
});
export type GeminiServerProviderSettings = typeof GeminiServerProviderSettings.Type;

export const HermesServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "hermes")),
  homePath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type HermesServerProviderSettings = typeof HermesServerProviderSettings.Type;

export const DevinServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "devin")),
});
export type DevinServerProviderSettings = typeof DevinServerProviderSettings.Type;

// Kimi Code, MiniMax Code, and ZCode are optional ACP providers: disabled until
// the user opts in, with `homePath` reserved for a Moss-managed private home.
const acpAgentServerProviderSettings = (binaryPath: string) =>
  Schema.Struct({
    ...ProviderSettingsBase,
    enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
    binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => binaryPath)),
    homePath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  });
export const KimiServerProviderSettings = acpAgentServerProviderSettings("kimi");
export type KimiServerProviderSettings = typeof KimiServerProviderSettings.Type;
export const MinimaxServerProviderSettings = acpAgentServerProviderSettings("mcode");
export type MinimaxServerProviderSettings = typeof MinimaxServerProviderSettings.Type;
export const ZcodeServerProviderSettings = acpAgentServerProviderSettings("zcode-acp-server");
export type ZcodeServerProviderSettings = typeof ZcodeServerProviderSettings.Type;

const DisabledSkillNames = Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
  Schema.withDecodingDefault(() => []),
);

// User-level skill toggles. Skills are keyed by lowercased name because the
// unified catalog dedupes provider copies of the same skill by name.
export const SkillsServerSettings = Schema.Struct({
  disabled: DisabledSkillNames,
});
export type SkillsServerSettings = typeof SkillsServerSettings.Type;

// Keep-awake behaviour for macOS `caffeinate`. "agent" keeps the machine awake
// only while at least one agent turn is running.
export const KeepAwakeMode = Schema.Literals(["always", "agent", "off"]);
export type KeepAwakeMode = typeof KeepAwakeMode.Type;
export const DEFAULT_KEEP_AWAKE_MODE: KeepAwakeMode = "off";

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  keepAwakeMode: KeepAwakeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_KEEP_AWAKE_MODE)),
  lowerProviderProcessPriority: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  defaultThreadEnvMode: ThreadEnvironmentMode.pipe(Schema.withDecodingDefault(() => "local")),
  addProjectBaseDirectory: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  // The GitHub inbox reads one repository per project (the preferred remote). When true it also
  // reads the project's other GitHub remotes, such as the upstream of a fork.
  githubInboxIncludeUpstreams: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  sidechatExpiry: SidechatExpiry.pipe(Schema.withDecodingDefault(() => "1h")),
  sourceControlWritingStyle: SourceControlWritingStyle.pipe(
    Schema.withDecodingDefault(() => "repository"),
  ),
  sourceControlCustomInstructions: SourceControlCustomInstructions.pipe(
    Schema.withDecodingDefault(() => ""),
  ),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: "codex" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
    })),
  ),
  providers: Schema.Struct({
    codex: CodexServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    cursor: CursorServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    gemini: GeminiServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    devin: DevinServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    antigravity: AntigravityServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    grok: GrokServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    droid: DroidServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    opencode: OpenCodeServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    pi: PiServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    hermes: HermesServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    omp: OmpServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    kimi: KimiServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    minimax: MinimaxServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    zcode: ZcodeServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
  providerInstances: ProviderInstanceConfigMap.pipe(Schema.withDecodingDefault(() => ({}))),
  skills: SkillsServerSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  // When the first-run welcome tour was completed or skipped. Server-backed so a
  // browser-storage reset does not replay setup on an already configured install.
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

/**
 * Returns whether a legacy provider settings bucket carries user-owned state.
 *
 * The schema defaults are a catalog/runtime probe baseline, not an instruction
 * to expose every provider as a selectable account. Reserved Moss Codex
 * accounts are represented by their explicit provider instances and therefore
 * do not, by themselves, make the legacy `codex` default user-configured.
 */
export function hasConfiguredLegacyProviderSettings(
  settings: Pick<ServerSettings, "providers">,
  provider: ProviderKind,
): boolean {
  if (provider === "codex") {
    const {
      accounts: _accounts,
      selectedAccountId: _selectedAccountId,
      ...current
    } = settings.providers.codex;
    const {
      accounts: _defaultAccounts,
      selectedAccountId: _defaultSelectedAccountId,
      ...defaults
    } = DEFAULT_SERVER_SETTINGS.providers.codex;
    if (JSON.stringify(current) !== JSON.stringify(defaults)) {
      return true;
    }
    return (
      settings.providers.codex.accounts.some(
        (account) => account.id !== "moss" && account.id !== "byok",
      ) ||
      (settings.providers.codex.selectedAccountId !== DEFAULT_CODEX_ACCOUNT_ID &&
        settings.providers.codex.selectedAccountId !== "moss" &&
        settings.providers.codex.selectedAccountId !== "byok")
    );
  }
  const bucket = (settings.providers as Record<string, unknown>)[provider];
  if (bucket === undefined) {
    return false;
  }
  return (
    JSON.stringify(bucket) !==
    JSON.stringify((DEFAULT_SERVER_SETTINGS.providers as Record<string, unknown>)[provider])
  );
}

// Public settings are structurally separate so the RPC contract can remain an
// explicitly redacted boundary if server-only settings gain more fields later.
export const ServerSettingsView = ServerSettings;
export type ServerSettingsView = typeof ServerSettingsView.Type;

export const DEFAULT_SERVER_SETTINGS_VIEW: ServerSettingsView = Schema.decodeSync(
  ServerSettingsView,
)({});

const ModelSelectionPatch = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  options: Schema.optionalKey(Schema.Unknown),
});

const ProviderSettingsBasePatch = {
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(StringSetting),
  customModels: Schema.optionalKey(CustomModels),
};
const AcpAgentServerProviderSettingsPatch = Schema.Struct({
  ...ProviderSettingsBasePatch,
  homePath: Schema.optionalKey(StringSetting),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  keepAwakeMode: Schema.optionalKey(KeepAwakeMode),
  lowerProviderProcessPriority: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvironmentMode),
  addProjectBaseDirectory: Schema.optionalKey(StringSetting),
  githubInboxIncludeUpstreams: Schema.optionalKey(Schema.Boolean),
  sidechatExpiry: Schema.optionalKey(SidechatExpiry),
  sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyle),
  sourceControlCustomInstructions: Schema.optionalKey(SourceControlCustomInstructions),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          homePath: Schema.optionalKey(StringSetting),
          accounts: Schema.optionalKey(CodexAccountConfigs),
          selectedAccountId: Schema.optionalKey(CodexAccountId),
        }),
      ),
      claudeAgent: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          homePath: Schema.optionalKey(StringSetting),
          launchArgs: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
          enableArtifacts: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      cursor: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          apiEndpoint: Schema.optionalKey(StringSetting),
        }),
      ),
      gemini: Schema.optionalKey(Schema.Struct(ProviderSettingsBasePatch)),
      antigravity: Schema.optionalKey(Schema.Struct(ProviderSettingsBasePatch)),
      grok: Schema.optionalKey(Schema.Struct(ProviderSettingsBasePatch)),
      droid: Schema.optionalKey(Schema.Struct(ProviderSettingsBasePatch)),
      opencode: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          serverUrl: Schema.optionalKey(StringSetting),
          serverPassword: Schema.optionalKey(StringSetting),
          serverPasswordRedacted: Schema.optionalKey(Schema.Boolean),
          experimentalWebSockets: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      pi: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          binaryPath: Schema.optionalKey(StringSetting),
          agentDir: Schema.optionalKey(StringSetting),
        }),
      ),
      hermes: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          homePath: Schema.optionalKey(StringSetting),
        }),
      ),
      devin: Schema.optionalKey(Schema.Struct(ProviderSettingsBasePatch)),
      omp: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          binaryPath: Schema.optionalKey(StringSetting),
          agentDir: Schema.optionalKey(StringSetting),
        }),
      ),
      kimi: Schema.optionalKey(AcpAgentServerProviderSettingsPatch),
      minimax: Schema.optionalKey(AcpAgentServerProviderSettingsPatch),
      zcode: Schema.optionalKey(AcpAgentServerProviderSettingsPatch),
    }),
  ),
  providerInstances: Schema.optionalKey(ProviderInstanceConfigMap),
  skills: Schema.optionalKey(
    Schema.Struct({
      disabled: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(256)))),
    }),
  ),
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}
