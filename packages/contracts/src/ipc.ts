import { Schema } from "effect";
import type {
  PagesCommentsInput,
  PagesCommentsResult,
  PagesListInput,
  PagesListResult,
  PagesMutateInput,
  PagesMutateResult,
  PagesReadInput,
  PagesReadResult,
  PagesScopeInput,
  PagesSpacesResult,
  PagesVersionsInput,
  PagesVersionsResult,
} from "./pages";
import type {
  HtmlPreviewDescriptor,
  HtmlPreviewRegisterInput,
  HtmlPreviewUnregisterInput,
} from "./htmlPreview";
import type {
  OrchestrationGetInlineVisualInput,
  OrchestrationGetInlineVisualResult,
} from "./inlineVisual";
import type { BrowserVaultMethods } from "./browserVault";
import type {
  LoadProjectImportHistoryInput,
  LoadProjectImportHistoryResult,
  ImportProjectInput,
  ImportProjectResult,
  ListProjectImportsInput,
  ListProjectImportsResult,
} from "./projectImport";

import type {
  AuthBearerBootstrapResult,
  AuthBootstrapInput,
  AuthBootstrapResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthLogoutResult,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "./auth";
import type {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpCreateIntegrationResult,
  ExternalMcpIntegration,
  ExternalMcpRefreshPairingInput,
  ExternalMcpRevokeIntegrationInput,
} from "./externalMcp";
import type {
  McpAppSandboxDescriptor,
  McpAppSandboxRegisterInput,
  McpAppSandboxUnregisterInput,
} from "./mcpAppSandbox";
import type {
  McpConnector,
  McpConnectorConnectInput,
  McpConnectorConnectResult,
  McpConnectorDisconnectInput,
  McpConnectorDisconnectResult,
  McpConnectorSetup,
} from "./mcpConnectors";
import type {
  MossAppsConnectFieldsInput,
  MossAppsConnectFieldsResult,
  MossAppsConnectInput,
  MossAppsConnectResult,
  MossAppsDisconnectInput,
  MossAppsDisconnectResult,
  MossAppsListConnectionsResult,
  MossAppsListToolkitsInput,
  MossAppsListToolkitsResult,
  MossAppsStatus,
} from "./mossApps";
import type {
  AutomationCancelRunInput,
  AutomationCancelRunResult,
  AutomationArchiveRunInput,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationDeleteInput,
  AutomationGetMemoryInput,
  AutomationListInput,
  AutomationListResult,
  AutomationMarkRunReadInput,
  AutomationMemory,
  AutomationResolveProposalInput,
  AutomationResolveProposalResult,
  AutomationRunActionResult,
  AutomationRunNowInput,
  AutomationRunNowResult,
  AutomationStreamEvent,
  AutomationUpdateInput,
} from "./automation";
import type {
  Todo,
  TodoCreateInput,
  TodoDeleteInput,
  TodoListResult,
  TodoStreamEvent,
  TodoUpdateInput,
} from "./todo";
import type { SecretRequestAnswerInput } from "./secretRequest";
import type {
  LibraryCreateFolderInput,
  LibraryDeleteFolderInput,
  LibraryDeleteInput,
  LibraryFavoriteInput,
  LibraryFolderResult,
  LibraryImportInput,
  LibraryImportResult,
  LibraryItemsResult,
  LibraryListInput,
  LibraryListResult,
  LibraryMoveInput,
  LibraryRegisterInput,
  LibraryRenameFolderInput,
  LibraryRenameInput,
  LibraryRestoreInput,
  LibrarySyncResult,
  LibraryTrashInput,
} from "./library";
import type {
  ProjectAgentConfigureInput,
  ProjectAgentLinkProjectInput,
  ProjectAgentUnlinkProjectInput,
  ProjectAgentExportDocumentsInput,
  ProjectAgentExportDocumentsResult,
  ProjectAgentGetOverviewInput,
  ProjectAgentDeleteGroupInput,
  ProjectAgentGroupControlInput,
  ProjectAgentDeleteGroupResult,
  ProjectAgentListSummariesInput,
  ProjectAgentListSummariesResult,
  ProjectAgentGoalControlInput,
  ProjectAgentListActivityInput,
  ProjectAgentListActivityResult,
  ProjectAgentListDocumentsInput,
  ProjectAgentListDocumentsResult,
  ProjectAgentListTasksInput,
  ProjectAgentListTasksResult,
  ProjectAgentOverview,
  ProjectAgentReadDocumentInput,
  ProjectAgentReadDocumentResult,
  ProjectAgentRefreshDigestInput,
  ProjectAgentStartGoalInput,
  ProjectAgentStreamEvent,
  ProjectAgentUpdateGoalInput,
  ProjectAgentUpdateTaskInput,
  ProjectAgentWriteDocumentInput,
  ProjectAgentCreateTaskInput,
  ProjectAgentExcludeThreadInput,
  ProjectAgentBackfillInput,
  ProjectAgentListThreadIndexInput,
  ProjectAgentListThreadIndexResult,
  ProjectAgentListEvidenceInput,
  ProjectAgentListEvidenceResult,
  ProjectAgentLibraryDeleteInput,
  ProjectAgentLibraryHistoryInput,
  ProjectAgentLibraryHistoryResult,
  ProjectAgentLibraryListInput,
  ProjectAgentLibraryListResult,
  ProjectAgentLibraryMkdirInput,
  ProjectAgentLibraryMutationResult,
  ProjectAgentLibraryRenameInput,
  ProjectAgentLibraryRestoreInput,
  ProjectAgentLibraryStatusInput,
  ProjectAgentLibraryStatusResult,
  ProjectAgentResolveWorkerInput,
  ProjectAgentResolveWorkerResult,
  ProjectDocumentRevision,
  ProjectGoal,
  ProjectTask,
  ProjectThreadIndexEntry,
} from "./projectAgent";
import type {
  GitCheckoutInput,
  GitActionProgressEvent,
  GitWorktreeSetupProgressEvent,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitCreateDetachedWorktreeResult,
  GitHubRepositoryInput,
  GitHubRepositoryResult,
  GitHandoffThreadInput,
  GitHandoffThreadResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitPullRequestSnapshotResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitReadFileAtRevInput,
  GitReadFileAtRevResult,
  GitBlameLineInput,
  GitBlameLineResult,
  GitListRecentCommitsInput,
  GitListRecentCommitsResult,
  GitWorkingTreeDiffStatsResult,
  GitRemoveIndexLockInput,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStageFilesInput,
  GitStageFilesResult,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStashInfoResult,
  GitStatusInput,
  GitStatusResult,
  GitSummarizeDiffInput,
  GitSummarizeDiffResult,
  GitUnstageFilesInput,
  GitUnstageFilesResult,
} from "./git";
import type {
  GitHubProjectProvisionInput,
  GitHubProjectProvisionProgressEvent,
  GitHubProjectProvisionResult,
} from "./githubProjectProvisioning";
import type {
  PullRequestActionInput,
  PullRequestActionResult,
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
} from "./pullRequests";
import type {
  PullRequestAutoFixGetInput,
  PullRequestAutoFixListResult,
  PullRequestAutoFixResult,
  PullRequestAutoFixSetInput,
} from "./pullRequestAutoFix";
import type {
  GitHubInboxListInput,
  GitHubInboxListResult,
  GitHubIssueCommentInput,
  GitHubIssueCommentResult,
  GitHubIssueDetail,
  GitHubIssueDetailInput,
} from "./githubInbox";
import type {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectCreateLocalFilePreviewGrantResult,
  ProjectDevServerEvent,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectListDevServersResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectFileChangeEvent,
  ProjectWatchFileInput,
  ProjectPrewarmSearchIndexInput,
  ProjectPrewarmSearchIndexResult,
  ProjectResolveWorkspaceFileReferencesInput,
  ProjectResolveWorkspaceFileReferencesResult,
  ProjectResolveOutOfRootFileReferenceInput,
  ProjectResolveOutOfRootFileReferenceResult,
  ProjectRunDevServerInput,
  ProjectRunDevServerResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchContentInput,
  ProjectSearchContentResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
  ProjectStopDevServerInput,
  ProjectStopDevServerResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import type {
  ComputerHistoryApplicationListResult,
  ComputerHistoryClearHistoryInput,
  ComputerHistoryClearHistoryResult,
  ComputerHistoryGetSettingsInput,
  ComputerHistoryGetStateInput,
  ComputerHistoryListHistoryInput,
  ComputerHistoryListHistoryResult,
  ComputerHistoryListSuggestionsInput,
  ComputerHistoryListSuggestionsResult,
  ComputerHistoryListSummaryIntervalsInput,
  ComputerHistoryListSummaryIntervalsResult,
  ComputerHistoryRevealInFinderInput,
  ComputerHistoryRevealInFinderResult,
  ComputerHistoryResolveApplicationsInput,
  ComputerHistoryResolveApplicationsResult,
  ComputerHistorySetEnabledInput,
  ComputerHistorySettings,
  ComputerHistoryState,
  ComputerHistoryUpdateSettingsInput,
} from "./computerHistory";
import type {
  DeviceAttachInput,
  DeviceBootInput,
  DeviceBootResult,
  DeviceDescribeUiInput,
  DeviceScrollToElementInput,
  DeviceScrollToElementResult,
  DeviceDescribeUiResult,
  DeviceDetachInput,
  DeviceEvent,
  DeviceInstallAppInput,
  DeviceInstallAppResult,
  DeviceKeyEventInput,
  DeviceLaunchAppInput,
  DeviceLaunchAppResult,
  DeviceListInput,
  DeviceListResult,
  DeviceOpenUrlInput,
  DevicePressButtonInput,
  DeviceScreenshotInput,
  DeviceScreenshotResult,
  DeviceStartRecordingInput,
  DeviceStartRecordingResult,
  DeviceStopRecordingInput,
  DeviceStopRecordingResult,
  DeviceShutdownInput,
  DeviceSwipeInput,
  DeviceTapInput,
  DeviceThreadInput,
  DeviceTypeTextInput,
  ThreadDeviceState,
} from "./device";
import type {
  ComputerActionResult,
  ComputerControlEnabledResult,
  ComputerEvent,
  ComputerGetStateInput,
  ComputerGetStatusInput,
  ComputerInputClickInput,
  ComputerInputKeyInput,
  ComputerInputScrollInput,
  ComputerListWindowsInput,
  ComputerListWindowsResult,
  ComputerProvisionInput,
  ComputerProvisionResult,
  ComputerSetControlEnabledInput,
  ComputerState,
  ComputerStatusResult,
  ComputerThreadInput,
  ThreadComputerState,
} from "./computer";
import type { ComputerGetAuditHistoryInput, ComputerGetAuditHistoryResult } from "./computerAudit";
import type { StudioListThreadOutputsInput, StudioListThreadOutputsResult } from "./studio";
import type {
  ServerConfig,
  ServerDiagnosticsResult,
  ServerReadThreadDiagnosticsInput,
  ServerReadThreadDiagnosticsResult,
  ServerGenerateAutomationIntentInput,
  ServerGenerateAutomationIntentResult,
  ServerGenerateThreadRecapInput,
  ServerGenerateThreadRecapResult,
  ServerGetEnvironmentResult,
  ServerConsumeCodexResetCreditInput,
  ServerConsumeCodexResetCreditResult,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerGetSettingsResult,
  ServerListLocalServersResult,
  ServerListWorktreesResult,
  ServerProviderLoginInput,
  ServerProviderLoginResult,
  ServerProviderUpdateInput,
  ServerProviderUpdateResult,
  ServerRefreshProvidersResult,
  ServerStopLocalServerInput,
  ServerStopLocalServerResult,
  ServerUpdateSettingsInput,
  ServerUpdateSettingsResult,
  ServerEditKeybindingsInput,
  ServerEditKeybindingsResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  ServerVoicePrewarmInput,
  ServerVoicePrewarmResult,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "./server";
import type {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type {
  RealtimeVoiceAppendSpeechInput,
  RealtimeVoiceAppendTextInput,
  RealtimeVoiceActivity,
  RealtimeVoiceClaimInput,
  RealtimeVoiceClaimResult,
  RealtimeVoiceCommandResult,
  RealtimeVoiceEvent,
  RealtimeVoiceListVoicesResult,
  RealtimeVoicePhase,
  RealtimeVoiceReleaseClaimInput,
  RealtimeVoiceReportClientStateInput,
  RealtimeVoiceResolveScreenContextInput,
  RealtimeVoiceStartInput,
  RealtimeVoiceStartResult,
  RealtimeVoiceState,
  RealtimeVoiceStopInput,
} from "./realtimeVoice";
import type {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetThreadDetailSnapshotInput,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationGetThreadDetailSnapshotResult,
  OrchestrationImportThreadInput,
  OrchestrationImportThreadResult,
  OrchestrationRegenerateThreadTitleInput,
  OrchestrationRegenerateThreadTitleResult,
  OrchestrationPredictNextMessageInput,
  OrchestrationPredictNextMessageResult,
  OrchestrationListProviderDeliveryBlockersInput,
  OrchestrationListProviderDeliveryBlockersResult,
  OrchestrationReconcileProviderDeliveryInput,
  OrchestrationReconcileProviderDeliveryResult,
  OrchestrationPrepareQuitResumeInput,
  OrchestrationPrepareQuitResumeResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
  OrchestrationUnsubscribeThreadInput,
} from "./orchestration";
import type {
  MossCanonicalResourceMutationPlanResult,
  MossCanonicalResourceMutationPrepareInput,
  MossCreateResourceInput,
  MossCreateResourceResult,
  MossDeleteResourceInput,
  MossDeleteResourceResult,
  MossNormalizedSessionEvent,
  MossSubscribeNormalizedSessionEventsInput,
  MossUpdateResourceInput,
  MossUpdateResourceResult,
} from "./moss";
import type {
  MossResourceImportApplyInput,
  MossResourceImportApplyResult,
  MossResourceImportInventoryInput,
  MossResourceImportInventoryResult,
  MossResourceImportPlanInput,
  MossResourceImportPlanResult,
  MossResourceImportRollbackInput,
  MossResourceImportRollbackResult,
} from "./mossResourceImport";
import type {
  WorkspaceImportApplyInput,
  WorkspaceImportApplyResult,
  WorkspaceImportProbeInput,
  WorkspaceImportProbeResult,
  WorkspaceImportSyncInput,
  WorkspaceImportSyncResult,
} from "./workspaceImport";
import type {
  MossCatalogSelectionInput,
  MossCatalogSelectionResult,
} from "./providerMarketplaceTicket";
import type {
  MossAccountLogoutResult,
  MossAccountSessionState,
  MossAccountActiveRealmState,
  MossAccountSelectRealmInput,
  MossAccountStartPhoneLoginInput,
  MossAccountStartPhoneLoginResult,
  MossAccountVerifyPhoneLoginInput,
  MossAccountVerifyPhoneLoginResult,
} from "./mossAccount";
import type {
  MossCloudListAccountsResult,
  MossCloudAccountState,
  MossCloudExchangeGoogleOAuthCodeInput,
  MossCloudExchangeCodeInput,
  MossCloudLogoutResult,
  MossCloudMutationResult,
  MossCloudRemoveAccountInput,
  MossCloudRemoveAccountResult,
  MossCloudRequestPasswordResetInput,
  MossCloudSelectAccountInput,
  MossCloudSignInInput,
  MossCloudSignInResult,
  MossCloudSignUpInput,
  MossCloudSignUpResult,
  MossCloudStartGoogleOAuthResult,
  MossCloudUpdatePasswordInput,
} from "./mossCloudAccount";
import type { MossEnterpriseKeySignInInput, MossEnterpriseKeyState } from "./mossEnterpriseKey";
import type {
  MossPayCatalog,
  MossPayCreateOrderInput,
  MossPayGetOrderInput,
  MossPayOrder,
  MossPayQuota,
} from "./mossPay";
import type { EditorId } from "./editor";
import type { ThreadId } from "./baseSchemas";
import type {
  ProviderAddMarketplaceInput,
  ProviderAddMarketplaceResult,
  ProviderComposerCapabilities,
  ProviderGetComposerCapabilitiesInput,
  ProviderInstallPluginInput,
  ProviderInstallPluginResult,
  ProviderListAppsInput,
  ProviderListAppsResult,
  ProviderReadAppToolsInput,
  ProviderReadAppToolsResult,
  ProviderReadAppConnectorInput,
  ProviderReadAppConnectorResult,
  ProviderReadAppConnectorTermsInput,
  ProviderReadAppConnectorTermsResult,
  ProviderStartAppConnectionInput,
  ProviderStartAppConnectionResult,
  ProviderCompleteAppConnectionInput,
  ProviderCompleteAppConnectionResult,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListMcpInput,
  ProviderListMcpResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderReadSkillInput,
  ProviderReadSkillResult,
  ProviderSkillsCatalogInput,
  ProviderSkillsCatalogResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
  ProviderRemoveMarketplaceInput,
  ProviderRemoveMarketplaceResult,
  ProviderSetAppEnabledInput,
  ProviderSetAppEnabledResult,
  ProviderSetPluginEnabledInput,
  ProviderSetPluginEnabledResult,
  ProviderUninstallPluginInput,
  ProviderUninstallPluginResult,
  ProviderUpgradeMarketplaceInput,
  ProviderUpgradeMarketplaceResult,
} from "./providerDiscovery";
import type {
  ProviderCompactThreadInput,
  ProviderGetLaunchPlanInput,
  ProviderGetLaunchPlanResult,
  ProviderGetLoopLedgerDashboardSnapshotInput,
  ProviderGetLoopLedgerDashboardSnapshotResult,
  ProviderListSessionsResult,
  ProviderSubmitPermissionActionInput,
  ProviderSubmitPermissionActionResult,
} from "./provider";
import type {
  StatsGetProfileStatsInput,
  StatsGetProfileStatsResult,
  StatsGetProfileTokenStatsInput,
  StatsGetProfileTokenStatsResult,
  StatsGetRecapInput,
  StatsGetRecapResult,
} from "./stats";
import type { BrowserAnnotationMethods } from "./browserAnnotations";
import { type KeybindingCommand, MAX_KEYBINDING_VALUE_LENGTH } from "./keybindings";

/** Closed, semantic artwork vocabulary accepted by the context-menu bridge. */
export type ContextMenuIconKey =
  | "pin"
  | "rename"
  | "mark-unread"
  | "clear-notification"
  | "archive"
  | "handoff"
  | "copy"
  | "copy-path"
  | "copy-thread-id"
  | "open-with"
  | "open-path-in-terminal"
  | "return-to-single-chat"
  | "delete";

/** Closed, semantic shortcut vocabulary accepted by the context-menu bridge. */
export type ContextMenuShortcutKey = "pin" | "rename" | "mark-unread" | "archive";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  /** Starts a new visual group before this actionable row. */
  separatorBefore?: boolean;
  destructive?: boolean;
  /** Central icon basename from the reversed set (e.g. `"pencil"`) or inline `<svg>` markup. */
  icon?: string;
  /**
   * Opens a submenu instead of resolving this row. Related actions (handoff targets, copy
   * variants, fork targets) belong in one parent row rather than a flat run of siblings.
   * Only leaf ids are ever returned; the parent `id` just identifies the group.
   */
  children?: readonly ContextMenuItem<T>[];
}

/**
 * A non-actionable context-menu parent. `children` is the canonical wire shape;
 * the `items` and `submenu` variants keep the boundary tolerant of callers that
 * use the terminology from other menu implementations. The desktop boundary
 * normalizes all variants to `children` before handing data to Electron.
 */
interface ContextMenuSubmenuMetadata {
  label: string;
  separatorBefore?: boolean;
  destructive?: boolean;
  /** Optional trusted semantic artwork key; never a path or renderer markup. */
  iconKey?: ContextMenuIconKey;
  /** Optional discriminators accepted by typed callers; normalization is authoritative. */
  kind?: "submenu";
  type?: "submenu";
}

export type ContextMenuSubmenu<T extends string = string> =
  | (ContextMenuSubmenuMetadata & {
      children: readonly ContextMenuNode<T>[];
    })
  | (ContextMenuSubmenuMetadata & {
      items: readonly ContextMenuNode<T>[];
    })
  | (ContextMenuSubmenuMetadata & {
      submenu: readonly ContextMenuNode<T>[];
    });

/** A leaf action or a non-actionable recursive submenu parent. */
export type ContextMenuNode<T extends string = string> = ContextMenuItem<T> | ContextMenuSubmenu<T>;

/** Context menu row sent over the desktop bridge with its icon pre-rasterized by the renderer. */
export interface DesktopContextMenuItem<T extends string = string> extends ContextMenuItem<T> {
  /** `data:image/png;base64,` template image rendered at 2x for a 16pt menu icon. */
  iconDataUrl?: string;
  children?: readonly DesktopContextMenuItem<T>[];
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

/** Largest desktop blur radius the translucent window shell accepts, in points. */
export const DESKTOP_WINDOW_BLUR_RADIUS_MAX = 64;
/** Smallest one: an unblurred desktop behind a clear window reads as a hole, not as glass. */
export const DESKTOP_WINDOW_BLUR_RADIUS_MIN = 1;

/**
 * Window backing the renderer asks for. `translucent` removes macOS vibrancy and sets the
 * desktop blur to `blurRadius`; `opaque` restores vibrancy and ignores `blurRadius`.
 */
export interface DesktopWindowMaterial {
  material: "opaque" | "translucent";
  blurRadius: number;
}

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  installFailureCount: number;
  // Build flavor of the running desktop app ("production" | "beta" | "canary" | "cua").
  // The web UI uses it for beta-only branding; production builds never see it.
  flavor: "production" | "beta" | "canary" | "cua";
  // Public URL where the user can manually download the release when the
  // in-app updater cannot apply it (silent installer failure, unsigned build,
  // read-only install location, unsupported platform). Null when no GitHub
  // update source is configured.
  releaseUrl: string | null;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

/** In-flight or failed beta download/install reported by the stable side. */
export interface DesktopBetaInstallProgress {
  readonly phase: "downloading" | "verifying" | "installing" | "opening" | "error";
  /** 0-100 while the download reports a content length; null when indeterminate. */
  readonly percent: number | null;
  readonly message?: string;
}

/** Result of a stable-side probe for a parallel Moss Beta install. */
export interface DesktopBetaChannelState {
  /** False on web builds and unsupported probing environments. */
  readonly supported: boolean;
  /** Flavor of the running desktop app; the card only acts on "production". */
  readonly flavor: "production" | "beta" | "canary" | "cua";
  readonly installed: boolean;
  readonly version: string | null;
  /** True when this platform can install beta in place (macOS today). */
  readonly canInstall: boolean;
  /** Beta's server pid is alive (its launch marker/runtime file says so). */
  readonly running: boolean;
  /** Timestamp of the last completed data import reported by the beta app. */
  readonly lastImportAt: string | null;
  readonly lastImportError: string | null;
  /** Public download page handed to the user when beta is not installed. */
  readonly downloadUrl: string;
  /** Live download/install progress; an `error` phase stays until the next attempt. */
  readonly install: DesktopBetaInstallProgress | null;
  /** Beta only: a stable Moss app was found to switch back to. */
  readonly stableInstalled: boolean;
  /** Beta only: leaving can also move the beta app to the Trash (macOS). */
  readonly canMoveBetaToTrash: boolean;
  /** Stable download page offered from beta when stable is not installed. */
  readonly stableDownloadUrl: string;
}

export type DesktopBetaActionError =
  | "not-supported"
  | "not-installed"
  | "beta-running"
  | "install-failed"
  | "launch-failed"
  | "internal";

export interface DesktopBetaActionResult {
  readonly ok: boolean;
  readonly error?: DesktopBetaActionError;
  readonly message?: string;
}

export interface BrowserTabState {
  openerTabId?: string;
  id: string;
  url: string;
  title: string;
  /**
   * Agent-owned tabs use a main-process WebContentsView so the exact page can
   * stay alive while its chat route is not mounted. Older snapshots omit this
   * field and are treated as renderer-owned by the web app.
   */
  runtimeSurface?: "native" | "renderer";
  status: "live" | "suspended";
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastCommittedUrl: string | null;
  lastError: string | null;
}

export interface ThreadBrowserState {
  threadId: ThreadId;
  version: number;
  open: boolean;
  activeTabId: string | null;
  tabs: BrowserTabState[];
  lastError: string | null;
}

export interface BrowserOpenInput {
  threadId: ThreadId;
  initialUrl?: string;
}

export interface BrowserThreadInput {
  threadId: ThreadId;
}

export interface BrowserTabInput {
  threadId: ThreadId;
  tabId: string;
}

export interface BrowserNavigateInput {
  threadId: ThreadId;
  tabId?: string;
  url: string;
}

export interface BrowserNewTabInput {
  threadId: ThreadId;
  url?: string;
  activate?: boolean;
}

export interface BrowserPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSetPanelBoundsInput {
  threadId: ThreadId;
  bounds: BrowserPanelBounds | null;
  surface?: "native" | "renderer";
  /** Guest page zoom for a presentation surface; omitted/1 keeps the normal 100% viewport. */
  pageZoomFactor?: number;
  preview?: boolean;
  occluded?: boolean;
}

export interface BrowserAttachWebviewInput extends BrowserTabInput {
  webContentsId: number;
}

export interface BrowserDetachWebviewInput extends BrowserTabInput {
  webContentsId: number;
}

export interface BrowserCaptureScreenshotResult {
  name: string;
  mimeType: "image/png";
  sizeBytes: number;
  bytes: Uint8Array;
}

export type DesktopAppSnapPlatform = "macos" | "windows" | "linux" | "other";
export type DesktopAppSnapPermission =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";
export type DesktopAppSnapStatus =
  | "unsupported"
  | "disabled"
  | "permission-required"
  | "starting"
  | "ready"
  | "error";

export type DesktopAppSnapShortcutModifier = "command" | "control" | "option" | "shift";

export interface DesktopAppSnapKeyChord {
  kind: "key-chord";
  modifier: DesktopAppSnapShortcutModifier;
  /** A physical DOM KeyboardEvent.code, such as `KeyS` or `Space`. */
  key: string;
}

export type DesktopAppSnapShortcut = { kind: "both-option-keys" } | DesktopAppSnapKeyChord;

export interface DesktopAppSnapShortcutAvailability {
  available: boolean;
  reason: string | null;
}

export interface DesktopAppSnapShortcutUpdateResult {
  state: DesktopAppSnapState;
  availability: DesktopAppSnapShortcutAvailability;
}

export type DesktopAppSnapSettingsPane = "accessibility" | "input-monitoring" | "screen-recording";

/** A macOS privacy grant the AppSnap helper can check or request. */
export type DesktopAppSnapPermissionKind = "accessibility" | "inputMonitoring" | "screenRecording";

export type DesktopAppSnapPermissionGuideState = "closed" | "granted";

export interface DesktopAppSnapState {
  platform: DesktopAppSnapPlatform;
  supported: boolean;
  enabled: boolean;
  status: DesktopAppSnapStatus;
  shortcut: DesktopAppSnapShortcut | null;
  /**
   * Only present once a caller asked about Accessibility; the helper reports
   * just the grants it was queried for, so an absent field means "not asked".
   */
  accessibilityPermission?: DesktopAppSnapPermission;
  inputMonitoringPermission: DesktopAppSnapPermission;
  screenRecordingPermission: DesktopAppSnapPermission;
  message: string | null;
  /** Explicit setup failure; unrelated AppSnap capture errors do not set this. */
  permissionSetupErrorCode?:
    | "permission_setup_bundle_unavailable"
    | "permission_setup_registration_unresolved"
    | "permission_setup_identity_mismatch";
  /** Name macOS shows for this build in System Settings permission lists. */
  appDisplayName: string;
}

export interface DesktopAppSnapWindowEntry {
  windowId: number;
  appName: string | null;
  bundleIdentifier: string | null;
  title?: string | null;
  windowTitle?: string | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  iconDataUrl?: string | null;
  appIconDataUrl?: string | null;
}

export interface DesktopAppSnapCapture {
  id: string;
  capturedAt: string;
  name: string;
  mimeType: "image/png";
  sizeBytes: number;
  bytes: Uint8Array;
  sourceAppName: string | null;
  sourceBundleIdentifier: string | null;
  sourceAppIconDataUrl: string | null;
  sourceWindowTitle: string | null;
}

export type DesktopSafariAccessInfo =
  | { supported: false }
  | { supported: true; appName: string; appPath: string | null };

export interface DesktopAppSnapErrorEvent {
  code: string;
  message: string;
  capturedAt: string;
}

// Pushed from the desktop main process when the in-app browser copy-link chord fires
// while the native page (not the React chrome) holds keyboard focus.
export interface BrowserCopyLinkEvent {
  threadId: ThreadId;
  url: string;
}

// Pushed after the desktop browser host has accepted an agent request. Keeping
// the requested thread in the event prevents whichever chat happens to be
// visible from stealing the browser session.
export interface BrowserUseOpenPanelRequest {
  threadId: ThreadId;
}

interface BrowserControlMethods {
  open: (input: BrowserOpenInput) => Promise<ThreadBrowserState>;
  close: (input: BrowserThreadInput) => Promise<ThreadBrowserState>;
  hide: (input: BrowserThreadInput) => Promise<void>;
  getState: (input: BrowserThreadInput) => Promise<ThreadBrowserState>;
  setPanelBounds: (input: BrowserSetPanelBoundsInput) => Promise<void>;
  attachWebview: (input: BrowserAttachWebviewInput) => Promise<ThreadBrowserState>;
  detachWebview: (input: BrowserDetachWebviewInput) => Promise<void>;
  copyLink: (input: BrowserTabInput) => Promise<void>;
  copyScreenshotToClipboard: (input: BrowserTabInput) => Promise<void>;
  captureScreenshot: (input: BrowserTabInput) => Promise<BrowserCaptureScreenshotResult>;
  navigate: (input: BrowserNavigateInput) => Promise<ThreadBrowserState>;
  reload: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  goBack: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  goForward: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  newTab: (input: BrowserNewTabInput) => Promise<ThreadBrowserState>;
  closeTab: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  selectTab: (input: BrowserTabInput) => Promise<ThreadBrowserState>;
  openDevTools: (input: BrowserTabInput) => Promise<void>;
  capturePreview?: (input: BrowserTabInput) => Promise<unknown | null>;
  vault?: BrowserVaultMethods;
  onState: (listener: (state: ThreadBrowserState) => void) => () => void;
}

export interface DesktopNotificationInput {
  title: string;
  body?: string;
  silent?: boolean;
  suppressWhenForeground?: boolean;
  threadId?: ThreadId;
}

export interface DesktopWindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
}

export const DESKTOP_DOCK_ICON_PREFERENCES = ["app-default", "moss-black", "moss-coral"] as const;
export type DesktopDockIconPreference = (typeof DESKTOP_DOCK_ICON_PREFERENCES)[number];

export const DESKTOP_UI_LOCALES = ["en", "zh-CN"] as const;
export type DesktopUiLocale = (typeof DESKTOP_UI_LOCALES)[number];

/** Main → renderer: ask whether quit should proceed while chats are running. */
export type DesktopQuitConfirmationPresentation = "native" | "in-app";

export interface DesktopQuitConfirmationRequest {
  readonly requestId: string;
  readonly presentation: DesktopQuitConfirmationPresentation;
}

export interface DesktopQuitConfirmationChat {
  readonly id: string;
  readonly title: string;
}

/**
 * Renderer → main: first ack that the UI received the request, then the user's
 * Stay / Quit decision. `ready` with `runningCount === 0` is treated as allow.
 */
export type DesktopQuitConfirmationResponse =
  | {
      readonly requestId: string;
      readonly phase: "ready";
      readonly runningCount: number;
      readonly chats: ReadonlyArray<DesktopQuitConfirmationChat>;
    }
  | {
      readonly requestId: string;
      readonly phase: "decision";
      readonly allow: boolean;
    };

/** Windows/Linux frameless title bar preference vs the live BrowserWindow frame. */
export interface DesktopCustomTitleBarState {
  supported: boolean;
  preference: boolean;
  active: boolean;
  restartRequired: boolean;
}

export const DesktopAppIcon = Schema.Literals(["default", "icon", "dark", "beta"]);
export type DesktopAppIcon = typeof DesktopAppIcon.Type;

/** Keybinding commands whose effective shortcut is mirrored onto a native application menu item. */
export const DESKTOP_MENU_SHORTCUT_COMMANDS = [
  "terminal.new",
  "sidebar.toggle",
  "browser.toggle",
] as const satisfies ReadonlyArray<KeybindingCommand>;
export type DesktopMenuShortcutCommand = (typeof DESKTOP_MENU_SHORTCUT_COMMANDS)[number];

// Same fields as KeybindingShortcut, but `key` is not trimmed: the space key is " ".
const DesktopMenuShortcut = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_KEYBINDING_VALUE_LENGTH)),
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
});

/** The user's shortcut for each menu command; null leaves that menu item without an accelerator. */
export const DesktopMenuShortcuts = Schema.Struct({
  "terminal.new": Schema.NullOr(DesktopMenuShortcut),
  "sidebar.toggle": Schema.NullOr(DesktopMenuShortcut),
  "browser.toggle": Schema.NullOr(DesktopMenuShortcut),
});
export type DesktopMenuShortcuts = typeof DesktopMenuShortcuts.Type;

export interface MossStorageSnapshot {
  readonly version: 1;
  readonly exportedAt: string;
  readonly entries: Readonly<Record<string, string>>;
}

/**
 * One-shot connector callback delivered by the desktop shell. The nested URL
 * remains opaque here; account/state/code are interpreted only by the caller
 * that completes the OAuth exchange.
 */
export interface DesktopConnectorOAuthCallback {
  readonly fullRedirectUrl: string;
  readonly returnTo: string | null;
}

export type DesktopPluginDeepLinkRoute = `/skills/plugins/${string}`;
export type DesktopPluginDeepLinkSource = "initial-argv" | "open-url" | "second-instance";

export interface DesktopPluginDeepLinkNavigation {
  readonly deliveryId: string;
  readonly route: DesktopPluginDeepLinkRoute;
  /**
   * Cold delivery seeds a deterministic `/skills` history baseline before the
   * renderer PUSHes detail. Warm delivery preserves the current history entry.
   */
  readonly coldStart: boolean;
  readonly source: DesktopPluginDeepLinkSource;
}

/**
 * Process-lifetime single-slot receipt for late-attaching packaged smoke. It
 * intentionally excludes routes, plugin ids, raw URLs, and raw delivery ids.
 */
export interface DesktopPluginDeepLinkAudit {
  readonly deliveryIdSha256: string;
  readonly coldStart: boolean;
  readonly source: DesktopPluginDeepLinkSource;
  readonly rendererAcknowledged: boolean;
}

export interface DesktopPluginDeepLinkNavigationResult {
  readonly deliveryId: string;
  readonly accepted: boolean;
}

/**
 * Sanitized renderer-owned voice state that may be mirrored into the desktop
 * always-on-top surface. Session, thread, transcript, model, and WebRTC details
 * intentionally never cross this bridge.
 */
export interface DesktopRealtimeVoiceOverlayAudioSignal {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
  readonly overall: number;
}

export interface DesktopRealtimeVoiceOverlaySnapshot {
  readonly phase: RealtimeVoicePhase;
  readonly activity: RealtimeVoiceActivity | null;
  readonly inputMuted: boolean;
  readonly outputMuted: boolean;
  readonly error: string | null;
  /** Four bounded display-only energy bands; raw audio never crosses IPC. */
  readonly audioSignal?: DesktopRealtimeVoiceOverlayAudioSignal | null;
}

export type DesktopRealtimeVoiceOverlayCommand =
  | "toggle"
  | "stop"
  | "focus"
  | "handoff"
  | "toggle-input-mute"
  | "toggle-output-mute";

export interface DesktopRealtimeVoiceOverlayHandoffOrigin {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopRealtimeVoiceOverlayHandoffVelocity {
  readonly x: number;
  readonly y: number;
}

/** Screen-space motion used to preserve continuity while switching surfaces. */
export interface DesktopRealtimeVoiceOverlayHandoff {
  readonly sequence: number;
  readonly from: "main-thread" | "global-overlay";
  readonly origin: DesktopRealtimeVoiceOverlayHandoffOrigin | null;
  readonly velocity: DesktopRealtimeVoiceOverlayHandoffVelocity | null;
}

/** Renderer publication keeps media ownership separate from overlay visibility. */
export interface DesktopRealtimeVoiceOverlayPublication {
  readonly snapshot: DesktopRealtimeVoiceOverlaySnapshot | null;
  readonly mediaOwnerActive: boolean;
  readonly handoff: DesktopRealtimeVoiceOverlayHandoff | null;
}

/** Main-process revision lets a loading/reloaded overlay ignore stale async replay. */
export interface DesktopRealtimeVoiceOverlayPresentation {
  readonly revision: number;
  readonly generation: number;
  readonly mediaOwnerActive: boolean;
  readonly handoff: DesktopRealtimeVoiceOverlayHandoff | null;
  readonly snapshot: DesktopRealtimeVoiceOverlaySnapshot | null;
}

export interface DesktopRealtimeVoiceOverlayCommandRequest {
  readonly command: DesktopRealtimeVoiceOverlayCommand;
  readonly revision: number;
  readonly generation: number;
}

/**
 * The deliberately narrow bridge exposed only inside the overlay renderer.
 * It cannot discover the local server or invoke the media/session APIs.
 */
export interface DesktopRealtimeVoiceOverlayBridge {
  getState: () => Promise<DesktopRealtimeVoiceOverlayPresentation>;
  sendCommand: (request: DesktopRealtimeVoiceOverlayCommandRequest) => Promise<boolean>;
  onState: (listener: (state: DesktopRealtimeVoiceOverlayPresentation) => void) => () => void;
}

/**
 * One frame of the desktop app's native computer preview tap: a complete JPEG
 * of the driven window. `seq` is monotonic per host process; the first frame
 * marks stream start and frames simply stop when the tap ends or dies. Sent
 * over the desktop bridge only, never through the computer WebSocket path.
 */
export interface DesktopComputerPreviewFrame {
  readonly windowId: number;
  readonly seq: number;
  readonly jpeg: Uint8Array;
}

/** Sound the message trail follows: the Mac's audio output, the microphone, or both. */
export type DesktopAudioLevelSource = "system" | "microphone" | "both";

/** A Mac input device the message trail can listen to. `id` is the Core Audio UID. */
export interface DesktopAudioInputDevice {
  readonly id: string;
  readonly name: string;
  readonly bluetooth: boolean;
  readonly default: boolean;
}

/**
 * Whether the desktop is reading audio levels. "unsupported" means this host
 * can never provide them (not macOS); "unavailable" means
 * the reader failed, for example on macOS before 14.2 or without microphone
 * access.
 */
export type DesktopAudioLevelStatus = "active" | "off" | "unsupported" | "unavailable";

/**
 * Agent cursor colors mirrored from the renderer to the desktop main process.
 * Each channel is a `#rrggbb` string; an omitted channel keeps the driver's
 * stock treatment for it, and `null` is the stock monochrome cursor.
 */
export interface DesktopAgentCursorStyle {
  readonly fill?: string;
  readonly rim?: string;
  readonly shadow?: string;
}

export const DESKTOP_RENDERER_ERROR_MESSAGE_MAX_LENGTH = 1024;
export const DESKTOP_RENDERER_ERROR_STACK_MAX_LENGTH = 8 * 1024;

/** Fixed, bounded exception fields accepted by Beta's diagnostics IPC. */
export interface DesktopRendererError {
  readonly message: string;
  readonly stack?: string | undefined;
}

/** Fixed categories only: never carry RPC arguments, DOM text, paths, or IDs. */
export const DesktopDiagnosticActivity = Schema.Literals([
  "chat.send",
  "chat.stop",
  "chat.open",
  "chat.unblock",
  "workspace.change",
  "project.create",
  "project.import",
  "project.import.preview",
  "project.import.catalog",
  "workspace.search",
  "workspace.read",
  "browser.open",
  "browser.navigate",
  "browser.resize",
  "window.resize",
  "transport.reconnect",
  "renderer.ready",
]);
export type DesktopDiagnosticActivity = typeof DesktopDiagnosticActivity.Type;
export const DesktopDiagnosticBreadcrumb = Schema.Struct({
  activity: DesktopDiagnosticActivity,
  phase: Schema.Literals(["started", "succeeded", "failed"]),
});
export type DesktopDiagnosticBreadcrumb = typeof DesktopDiagnosticBreadcrumb.Type;

/** Handled failures carry fixed categories, never exception text or operation arguments. */
export const DesktopDiagnosticIssue = Schema.Struct({
  code: Schema.Literals([
    "server.event-loop.stall",
    "git.request.failed",
    "git.branch.failed",
    "git.commit.failed",
    "git.push.failed",
    "git.pr.failed",
    "voice.record.failed",
    "voice.transcribe.failed",
    "claude.compaction.request-failed",
    "claude.compaction.uncertain",
    "claude.cache.request-failed",
    "claude.cache.failed",
    "claude.cache.uncertain",
    "startup.database-locked",
    "startup.migration-recovery-required",
    "startup.migration-divergence-consent-required",
    "startup.migration-runtime-identity-mismatch",
    "startup.migration-schema-too-new",
    "startup.migration-startup-block-invalid",
  ]),
  reason: Schema.optional(
    Schema.Literals([
      "unknown",
      "auth",
      "invalid-response",
      "timeout",
      "output-limit",
      "live-owner",
      "unknown-owner",
    ]),
  ),
  durationMs: Schema.optional(Schema.Finite),
});
export type DesktopDiagnosticIssue = typeof DesktopDiagnosticIssue.Type;
export const DESKTOP_DIAGNOSTIC_ISSUE_PREFIX = "MOSS_DIAGNOSTIC_ISSUE ";
export type DesktopDiagnosticReportStatus = "queued" | "sent" | "unavailable";

export interface DesktopBridge {
  /** Present only when the desktop main process enables baked-in Beta diagnostics. */
  betaDiagnostics?: {
    rendererReady: () => void;
    reportError: (error: DesktopRendererError) => void;
    recordActivity?: (breadcrumb: DesktopDiagnosticBreadcrumb) => void;
    reportIssue?: (issue: DesktopDiagnosticIssue) => Promise<string | null>;
    getReportStatus?: (id: string) => Promise<DesktopDiagnosticReportStatus>;
  };
  safariAccess?: {
    getInfo: () => Promise<DesktopSafariAccessInfo>;
    openSettings: () => Promise<boolean>;
    revealApp: () => Promise<boolean>;
  };
  getWsUrl: () => string | null;
  /**
   * Absolute filesystem path for a File from drag/drop or file inputs.
   * Electron only (`webUtils.getPathForFile`). Returns null when unavailable.
   */
  getPathForFile?: (file: File) => string | null;
  pickFolder: () => Promise<string | null>;
  saveFile?: (input: {
    defaultFilename: string;
    contents: string;
    filters?: ReadonlyArray<{ name: string; extensions: ReadonlyArray<string> }>;
  }) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  /** Keeps Electron-owned menus and dialogs aligned with the renderer language. */
  setUiLocale?: (locale: DesktopUiLocale) => Promise<void>;
  setDockIconPreference?: (preference: DesktopDockIconPreference) => Promise<void>;
  /** macOS only; resolves false when the adjustable blur is unavailable. */
  setWindowMaterial?: (input: DesktopWindowMaterial) => Promise<boolean>;
  getAppIcon?: () => Promise<DesktopAppIcon>;
  setAppIcon: (icon: DesktopAppIcon) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  /** Opens an existing native application menu from the custom Windows title bar. */
  showApplicationMenu?: (
    menu: "file" | "edit" | "view" | "help",
    position: { x: number; y: number },
  ) => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
  openMossCanvasApp?: (input?: { surface?: string }) => Promise<boolean>;
  showInFolder: (path: string) => Promise<void>;
  shell?: {
    showInFolder: (path: string) => Promise<void>;
  };
  clipboard?: {
    writeImagePngDataUrl: (dataUrl: string) => Promise<boolean>;
  };
  windowControls?: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<DesktopWindowState>;
    close: () => Promise<void>;
    getState: () => Promise<DesktopWindowState>;
    onState: (listener: (state: DesktopWindowState) => void) => () => void;
  };
  /**
   * Windows/Linux only. `frame` is fixed at BrowserWindow creation, so changing
   * the preference requires a relaunch before `active` catches up.
   */
  customTitleBar?: {
    getState: () => Promise<DesktopCustomTitleBarState>;
    setPreference: (enabled: boolean) => Promise<DesktopCustomTitleBarState>;
    relaunch: () => Promise<void>;
  };
  /**
   * Live desktop frames from the native computer frame tap, desktop app only.
   * Plain browser clients never see this member; their preview keeps drawing
   * the WebSocket stills stream.
   */
  computerPreview?: {
    onFrame: (listener: (frame: DesktopComputerPreviewFrame) => void) => () => void;
  };
  /**
   * Desktop-owned computer preferences. `setCursorStyle` mirrors the agent
   * cursor colors to the main process, which persists them for the next Cua
   * driver session and live-pushes them when a session is already open.
   * `null` restores the stock cursor. Plain browser clients never see this
   * member; their settings stay local and the driver is not running there.
   */
  computer?: {
    setCursorStyle: (style: DesktopAgentCursorStyle | null) => Promise<void>;
  };
  /**
   * Loudness of the Mac's audio output and/or the microphone, in 0..1, for the
   * message trail. Desktop on macOS only, in Stable and Beta; the main process
   * refuses it elsewhere. Levels stream only while this window has a source set
   * (`null` stops), and silence arrives once as 0. `microphoneId` picks the
   * input device by `DesktopAudioInputDevice.id`; omitted or `null` follows
   * the Mac's default input.
   */
  audioLevel?: {
    setSource: (
      source: DesktopAudioLevelSource | null,
      microphoneId?: string | null,
    ) => Promise<DesktopAudioLevelStatus>;
    listMicrophones: () => Promise<readonly DesktopAudioInputDevice[]>;
    onLevel: (listener: (level: number) => void) => () => void;
  };
  onMenuAction: (listener: (action: string) => void) => () => void;
  /**
   * Mirrors the user's keybindings onto the native menu accelerators. Absent on
   * builds that predate it; until a window reports, the menu keeps its defaults.
   */
  setMenuShortcuts?: (shortcuts: DesktopMenuShortcuts) => Promise<void>;
  onQuitConfirmationRequest: (
    listener: (request: DesktopQuitConfirmationRequest) => void,
  ) => () => void;
  replyQuitConfirmation: (response: DesktopQuitConfirmationResponse) => void;
  /** Current `webContents` page zoom (1 = 100%). Used to keep macOS traffic-light gutter aligned. */
  getZoomFactor: () => number;
  onZoomFactorChange: (listener: (zoomFactor: number) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  connectorOAuth?: {
    onCallback: (listener: (callback: DesktopConnectorOAuthCallback) => void) => () => void;
  };
  /**
   * Main sends only strictly validated canonical plugin-detail routes. Resolving
   * true ACKs and consumes the route; false/rejection retains it for retry.
   */
  pluginDeepLinks?: {
    onNavigate: (
      listener: (navigation: DesktopPluginDeepLinkNavigation) => boolean | Promise<boolean>,
    ) => () => void;
    getLastAudit: () => Promise<DesktopPluginDeepLinkAudit | null>;
  };
  /** Stable→Beta opt-in surface. Absent on builds that do not ship it. */
  beta?: {
    getState: () => Promise<DesktopBetaChannelState>;
    /** Downloads and installs Moss Beta when missing (macOS), then opens it. */
    install: () => Promise<DesktopBetaActionResult>;
    /**
     * Installs Moss Beta when missing (macOS), writes the import marker, and
     * launches it to consume the import.
     */
    importAndLaunch: () => Promise<DesktopBetaActionResult>;
    launch: () => Promise<DesktopBetaActionResult>;
    /**
     * Beta only: opens stable Moss, optionally moves the beta app to the
     * Trash (macOS), then quits beta. Beta data stays in the beta home.
     */
    leave: (input: { readonly moveToTrash: boolean }) => Promise<DesktopBetaActionResult>;
  };
  notifications: {
    isSupported: () => Promise<boolean>;
    show: (input: DesktopNotificationInput) => Promise<boolean>;
  };
  realtimeVoice?: {
    setGlobalShortcut: (
      shortcut: string | null,
    ) => Promise<{ registered: boolean; shortcut: string | null; reason: string | null }>;
    captureScreenContext: () => Promise<DesktopAppSnapCapture>;
    onToggle: (listener: () => void) => () => void;
    overlay?: {
      publish: (publication: DesktopRealtimeVoiceOverlayPublication) => Promise<void>;
      onCommand: (
        listener: (
          command: DesktopRealtimeVoiceOverlayCommand,
          handoff: DesktopRealtimeVoiceOverlayHandoff | null,
        ) => void,
      ) => () => void;
    };
  };
  appSnap: {
    captureCurrentApp: (requestId: string) => Promise<DesktopAppSnapCapture>;
    cancelCapture: (requestId: string) => Promise<void>;
    getState: (
      permissions?: readonly DesktopAppSnapPermissionKind[],
    ) => Promise<DesktopAppSnapState>;
    setEnabled: (enabled: boolean) => Promise<DesktopAppSnapState>;
    checkShortcut: (
      shortcut: DesktopAppSnapShortcut,
    ) => Promise<DesktopAppSnapShortcutAvailability>;
    setShortcut: (shortcut: DesktopAppSnapShortcut) => Promise<DesktopAppSnapShortcutUpdateResult>;
    requestPermissions: (
      permissions?: readonly DesktopAppSnapPermissionKind[],
    ) => Promise<DesktopAppSnapState>;
    /**
     * Reads current grants without prompting, then walks the floating permission
     * coach through each pane still missing a grant — opening its System
     * Settings page and raising that pane's prompt as each step begins, so macOS
     * never shows several permission dialogs at once.
     */
    startPermissionSetup: (
      permissions: readonly DesktopAppSnapPermissionKind[],
    ) => Promise<DesktopAppSnapState>;
    listPendingCaptures: () => Promise<DesktopAppSnapCapture[]>;
    acknowledgeCapture: (captureId: string) => Promise<void>;
    listWindows: () => Promise<DesktopAppSnapWindowEntry[]>;
    captureWindow: (input: { windowId: number }) => Promise<DesktopAppSnapCapture>;
    openPermissionSettings: (pane: DesktopAppSnapSettingsPane) => Promise<boolean>;
    restartApp: () => Promise<void>;
    showPermissionGuide: (pane: DesktopAppSnapSettingsPane) => Promise<void>;
    hidePermissionGuide: () => Promise<void>;
    onPermissionGuideState: (
      listener: (state: DesktopAppSnapPermissionGuideState) => void,
    ) => () => void;
    onCaptured: (listener: (capture: DesktopAppSnapCapture) => void) => () => void;
    onError: (listener: (error: DesktopAppSnapErrorEvent) => void) => () => void;
    onState: (listener: (state: DesktopAppSnapState) => void) => () => void;
  };
  computerHistory?: {
    getState: (input?: ComputerHistoryGetStateInput) => Promise<ComputerHistoryState>;
    getSettings: (input?: ComputerHistoryGetSettingsInput) => Promise<ComputerHistorySettings>;
    updateSettings: (input: ComputerHistoryUpdateSettingsInput) => Promise<ComputerHistoryState>;
    listApplications: () => Promise<ComputerHistoryApplicationListResult>;
    resolveApplications: (
      input: ComputerHistoryResolveApplicationsInput,
    ) => Promise<ComputerHistoryResolveApplicationsResult>;
    setEnabled: (input: ComputerHistorySetEnabledInput) => Promise<ComputerHistoryState>;
    retryActivation: () => Promise<ComputerHistoryState>;
    pause: () => Promise<ComputerHistoryState>;
    resume: () => Promise<ComputerHistoryState>;
    listHistory: (
      input?: ComputerHistoryListHistoryInput,
    ) => Promise<ComputerHistoryListHistoryResult>;
    listHistorySuggestions: (
      input?: ComputerHistoryListSuggestionsInput,
    ) => Promise<ComputerHistoryListSuggestionsResult>;
    listHistorySummaryIntervals: (
      input: ComputerHistoryListSummaryIntervalsInput,
    ) => Promise<ComputerHistoryListSummaryIntervalsResult>;
    revealInFinder: (
      input: ComputerHistoryRevealInFinderInput,
    ) => Promise<ComputerHistoryRevealInFinderResult>;
    clearHistory: (
      input: ComputerHistoryClearHistoryInput,
    ) => Promise<ComputerHistoryClearHistoryResult>;
  };
  storageMigration: {
    readSnapshot: () => MossStorageSnapshot | null;
    acknowledgeSnapshot: () => Promise<void>;
  };
  server?: {
    transcribeVoice: (
      input: ServerVoiceTranscriptionInput,
    ) => Promise<ServerVoiceTranscriptionResult>;
  };
  browser: BrowserControlMethods & {
    annotations: BrowserAnnotationMethods;
    onBrowserUseOpenPanelRequest: (
      listener: (request: BrowserUseOpenPanelRequest) => void,
    ) => () => void;
    onBrowserCopyLink: (listener: (event: BrowserCopyLinkEvent) => void) => () => void;
  };
  /** Narrow host registration surface for isolated MCP App guests. */
  mcpApps?: {
    register: (input: McpAppSandboxRegisterInput) => Promise<McpAppSandboxDescriptor | null>;
    unregister: (input: McpAppSandboxUnregisterInput) => Promise<boolean>;
  };
  /** Disposable desktop-only rich HTML preview; no guest bridge is exposed. */
  htmlPreview?: {
    register: (input: HtmlPreviewRegisterInput) => Promise<HtmlPreviewDescriptor>;
    unregister: (input: HtmlPreviewUnregisterInput) => Promise<boolean>;
  };
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    saveFile?: (input: {
      defaultFilename: string;
      contents: string;
      filters?: ReadonlyArray<{ name: string; extensions: ReadonlyArray<string> }>;
    }) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    ackOutput: (input: TerminalAckOutputInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    discoverScripts: (input: ProjectDiscoverScriptsInput) => Promise<ProjectDiscoverScriptsResult>;
    listDirectories: (input: ProjectListDirectoriesInput) => Promise<ProjectListDirectoriesResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    searchLocalEntries: (
      input: ProjectSearchLocalEntriesInput,
    ) => Promise<ProjectSearchLocalEntriesResult>;
    searchContent: (input: ProjectSearchContentInput) => Promise<ProjectSearchContentResult>;
    prewarmSearchIndex: (
      input: ProjectPrewarmSearchIndexInput,
    ) => Promise<ProjectPrewarmSearchIndexResult>;
    readFile: (
      input: ProjectReadFileInput,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<ProjectReadFileResult>;
    onFileChange?: (
      input: ProjectWatchFileInput,
      callback: (event: ProjectFileChangeEvent) => void,
    ) => () => void;
    resolveWorkspaceFileReferences: (
      input: ProjectResolveWorkspaceFileReferencesInput,
    ) => Promise<ProjectResolveWorkspaceFileReferencesResult>;
    resolveOutOfRootFileReference: (
      input: ProjectResolveOutOfRootFileReferenceInput,
    ) => Promise<ProjectResolveOutOfRootFileReferenceResult>;
    createLocalFilePreviewGrant: (
      input: ProjectCreateLocalFilePreviewGrantInput,
    ) => Promise<ProjectCreateLocalFilePreviewGrantResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    runDevServer: (input: ProjectRunDevServerInput) => Promise<ProjectRunDevServerResult>;
    stopDevServer: (input: ProjectStopDevServerInput) => Promise<ProjectStopDevServerResult>;
    listDevServers: () => Promise<ProjectListDevServersResult>;
    onDevServerEvent: (callback: (event: ProjectDevServerEvent) => void) => () => void;
    provisionFromGitHub: (
      input: GitHubProjectProvisionInput,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<GitHubProjectProvisionResult>;
    onProvisionProgress: (
      callback: (event: GitHubProjectProvisionProgressEvent) => void,
    ) => () => void;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  studio: {
    listThreadOutputs: (
      input: StudioListThreadOutputsInput,
    ) => Promise<StudioListThreadOutputsResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    showInFolder: (path: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    githubRepository: (input: GitHubRepositoryInput) => Promise<GitHubRepositoryResult>;
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    createDetachedWorktree: (
      input: GitCreateDetachedWorktreeInput,
    ) => Promise<GitCreateDetachedWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    stashAndCheckout: (input: GitStashAndCheckoutInput) => Promise<void>;
    stashDrop: (input: GitStashDropInput) => Promise<void>;
    stashInfo: (input: GitStashInfoInput) => Promise<GitStashInfoResult>;
    removeIndexLock: (input: GitRemoveIndexLockInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    stageFiles: (input: GitStageFilesInput) => Promise<GitStageFilesResult>;
    unstageFiles: (input: GitUnstageFilesInput) => Promise<GitUnstageFilesResult>;
    handoffThread: (input: GitHandoffThreadInput) => Promise<GitHandoffThreadResult>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    pullRequestSnapshot: (
      input: GitPullRequestSnapshotInput,
    ) => Promise<GitPullRequestSnapshotResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    readWorkingTreeDiff: (
      input: GitReadWorkingTreeDiffInput,
    ) => Promise<GitReadWorkingTreeDiffResult>;
    readFileAtRev: (input: GitReadFileAtRevInput) => Promise<GitReadFileAtRevResult>;
    blameLine: (input: GitBlameLineInput) => Promise<GitBlameLineResult>;
    listRecentCommits: (input: GitListRecentCommitsInput) => Promise<GitListRecentCommitsResult>;
    workingTreeDiffStats: (
      input: GitReadWorkingTreeDiffInput,
    ) => Promise<GitWorkingTreeDiffStatsResult>;
    summarizeDiff: (input: GitSummarizeDiffInput) => Promise<GitSummarizeDiffResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
    onActionProgress: (callback: (event: GitActionProgressEvent) => void) => () => void;
    onWorktreeSetupProgress: (
      callback: (event: GitWorktreeSetupProgressEvent) => void,
    ) => () => void;
  };
  githubInbox: {
    list: (input: GitHubInboxListInput) => Promise<GitHubInboxListResult>;
    issueDetail: (input: GitHubIssueDetailInput) => Promise<GitHubIssueDetail>;
    issueComment: (input: GitHubIssueCommentInput) => Promise<GitHubIssueCommentResult>;
  };
  pullRequests: {
    detail: (input: PullRequestDetailInput) => Promise<PullRequestDetail>;
    diff: (input: PullRequestDetailInput) => Promise<PullRequestDiffResult>;
    action: (input: PullRequestActionInput) => Promise<PullRequestActionResult>;
    comment: (input: PullRequestCommentInput) => Promise<PullRequestActionResult>;
    setPinned: (input: PullRequestSetPinnedInput) => Promise<PullRequestSetPinnedResult>;
    getAutoFix: (input: PullRequestAutoFixGetInput) => Promise<PullRequestAutoFixListResult>;
    setAutoFix: (input: PullRequestAutoFixSetInput) => Promise<PullRequestAutoFixResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    getEnvironment: () => Promise<ServerGetEnvironmentResult>;
    getSettings: () => Promise<ServerGetSettingsResult>;
    probeWorkspaceImport: (
      input?: WorkspaceImportProbeInput,
    ) => Promise<WorkspaceImportProbeResult>;
    applyWorkspaceImport: (input: WorkspaceImportApplyInput) => Promise<WorkspaceImportApplyResult>;
    syncWorkspaceImport: (input: WorkspaceImportSyncInput) => Promise<WorkspaceImportSyncResult>;
    updateSettings: (input: ServerUpdateSettingsInput) => Promise<ServerUpdateSettingsResult>;
    getAuthSession: () => Promise<AuthSessionState>;
    bootstrapAuth: (input: AuthBootstrapInput) => Promise<AuthBootstrapResult>;
    bootstrapBearerAuth: (input: AuthBootstrapInput) => Promise<AuthBearerBootstrapResult>;
    issueAuthWebSocketToken: () => Promise<AuthWebSocketTokenResult>;
    createAuthPairingToken: (
      input?: AuthCreatePairingCredentialInput,
    ) => Promise<AuthPairingCredentialResult>;
    listAuthPairingLinks: () => Promise<ReadonlyArray<AuthPairingLink>>;
    revokeAuthPairingLink: (input: AuthRevokePairingLinkInput) => Promise<{ revoked: boolean }>;
    listAuthClients: () => Promise<ReadonlyArray<AuthClientSession>>;
    revokeAuthClient: (input: AuthRevokeClientSessionInput) => Promise<{ revoked: boolean }>;
    revokeOtherAuthClients: () => Promise<{ revokedCount: number }>;
    logoutAuthSession: () => Promise<AuthLogoutResult>;
    listExternalMcpIntegrations: () => Promise<ReadonlyArray<ExternalMcpIntegration>>;
    createExternalMcpIntegration: (
      input: ExternalMcpCreateIntegrationInput,
    ) => Promise<ExternalMcpCreateIntegrationResult>;
    revokeExternalMcpIntegration: (
      input: ExternalMcpRevokeIntegrationInput,
    ) => Promise<{ revoked: boolean }>;
    refreshExternalMcpPairing: (
      input: ExternalMcpRefreshPairingInput,
    ) => Promise<ExternalMcpCreateIntegrationResult>;
    listMcpConnectors: () => Promise<ReadonlyArray<McpConnector>>;
    connectMcpConnector: (input: McpConnectorConnectInput) => Promise<McpConnectorConnectResult>;
    disconnectMcpConnector: (
      input: McpConnectorDisconnectInput,
    ) => Promise<McpConnectorDisconnectResult>;
    getMcpConnectorSetup: () => Promise<McpConnectorSetup>;
    getMossAppsStatus: () => Promise<MossAppsStatus>;
    listMossAppToolkits: (input: MossAppsListToolkitsInput) => Promise<MossAppsListToolkitsResult>;
    listMossAppConnections: () => Promise<MossAppsListConnectionsResult>;
    getMossAppConnectFields: (
      input: MossAppsConnectFieldsInput,
    ) => Promise<MossAppsConnectFieldsResult>;
    connectMossApp: (input: MossAppsConnectInput) => Promise<MossAppsConnectResult>;
    disconnectMossApp: (input: MossAppsDisconnectInput) => Promise<MossAppsDisconnectResult>;
    refreshProviders: () => Promise<ServerRefreshProvidersResult>;
    updateProvider: (input: ServerProviderUpdateInput) => Promise<ServerProviderUpdateResult>;
    startProviderLogin: (input: ServerProviderLoginInput) => Promise<ServerProviderLoginResult>;
    cancelProviderLogin: (input: ServerProviderLoginInput) => Promise<ServerProviderLoginResult>;
    listWorktrees: () => Promise<ServerListWorktreesResult>;
    listLocalServers: () => Promise<ServerListLocalServersResult>;
    stopLocalServer: (input: ServerStopLocalServerInput) => Promise<ServerStopLocalServerResult>;
    getProviderUsageSnapshot: (
      input: ServerGetProviderUsageSnapshotInput,
    ) => Promise<ServerGetProviderUsageSnapshotResult>;
    listProviderUsage: (
      input: ServerListProviderUsageInput,
    ) => Promise<ServerListProviderUsageResult>;
    consumeCodexResetCredit: (
      input: ServerConsumeCodexResetCreditInput,
    ) => Promise<ServerConsumeCodexResetCreditResult>;
    getDiagnostics: () => Promise<ServerDiagnosticsResult>;
    readThreadDiagnostics: (
      input: ServerReadThreadDiagnosticsInput,
    ) => Promise<ServerReadThreadDiagnosticsResult>;
    generateThreadRecap: (
      input: ServerGenerateThreadRecapInput,
    ) => Promise<ServerGenerateThreadRecapResult>;
    generateAutomationIntent: (
      input: ServerGenerateAutomationIntentInput,
    ) => Promise<ServerGenerateAutomationIntentResult>;
    prewarmVoice?: (input: ServerVoicePrewarmInput) => Promise<ServerVoicePrewarmResult>;
    transcribeVoice: (
      input: ServerVoiceTranscriptionInput,
    ) => Promise<ServerVoiceTranscriptionResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getMossAccountSession: () => Promise<MossAccountSessionState>;
    selectMossAccountRealm: (
      input: MossAccountSelectRealmInput,
    ) => Promise<MossAccountActiveRealmState>;
    startMossPhoneLogin: (
      input: MossAccountStartPhoneLoginInput,
    ) => Promise<MossAccountStartPhoneLoginResult>;
    verifyMossPhoneLogin: (
      input: MossAccountVerifyPhoneLoginInput,
    ) => Promise<MossAccountVerifyPhoneLoginResult>;
    logoutMossAccount: () => Promise<MossAccountLogoutResult>;
    getMossCloudAccountState: () => Promise<MossCloudAccountState>;
    listMossCloudAccounts: () => Promise<MossCloudListAccountsResult>;
    selectMossCloudAccount: (input: MossCloudSelectAccountInput) => Promise<MossCloudAccountState>;
    removeMossCloudAccount: (
      input: MossCloudRemoveAccountInput,
    ) => Promise<MossCloudRemoveAccountResult>;
    signUpMossCloudAccount: (input: MossCloudSignUpInput) => Promise<MossCloudSignUpResult>;
    signInMossCloudAccount: (input: MossCloudSignInInput) => Promise<MossCloudSignInResult>;
    refreshMossCloudAccount: () => Promise<MossCloudAccountState>;
    startMossCloudGoogleOAuth: () => Promise<MossCloudStartGoogleOAuthResult>;
    exchangeMossCloudGoogleOAuthCode: (
      input: MossCloudExchangeGoogleOAuthCodeInput,
    ) => Promise<MossCloudAccountState>;
    requestMossCloudPasswordReset: (
      input: MossCloudRequestPasswordResetInput,
    ) => Promise<MossCloudMutationResult>;
    exchangeMossCloudAuthCode: (
      input: MossCloudExchangeCodeInput,
    ) => Promise<MossCloudAccountState>;
    updateMossCloudPassword: (
      input: MossCloudUpdatePasswordInput,
    ) => Promise<MossCloudMutationResult>;
    logoutMossCloudAccount: () => Promise<MossCloudLogoutResult>;
    getMossEnterpriseKeyState: () => Promise<MossEnterpriseKeyState>;
    signInMossEnterpriseKey: (
      input: MossEnterpriseKeySignInInput,
    ) => Promise<MossEnterpriseKeyState>;
    /** Hand the managed Moss surface back to the saved enterprise key. */
    activateMossEnterpriseKey: () => Promise<MossEnterpriseKeyState>;
    signOutMossEnterpriseKey: () => Promise<MossEnterpriseKeyState>;
    getMossPayCatalog: () => Promise<MossPayCatalog>;
    getMossPayQuota: () => Promise<MossPayQuota>;
    createMossPayOrder: (input: MossPayCreateOrderInput) => Promise<MossPayOrder>;
    getMossPayOrder: (input: MossPayGetOrderInput) => Promise<MossPayOrder>;
  };
  realtimeVoice: {
    listVoices: () => Promise<RealtimeVoiceListVoicesResult>;
    claim: (input: RealtimeVoiceClaimInput) => Promise<RealtimeVoiceClaimResult>;
    releaseClaim: (input: RealtimeVoiceReleaseClaimInput) => Promise<RealtimeVoiceCommandResult>;
    start: (input: RealtimeVoiceStartInput) => Promise<RealtimeVoiceStartResult>;
    reportClientState: (input: RealtimeVoiceReportClientStateInput) => Promise<RealtimeVoiceState>;
    resolveScreenContext: (
      input: RealtimeVoiceResolveScreenContextInput,
    ) => Promise<RealtimeVoiceCommandResult>;
    appendText: (input: RealtimeVoiceAppendTextInput) => Promise<RealtimeVoiceCommandResult>;
    appendSpeech: (input: RealtimeVoiceAppendSpeechInput) => Promise<RealtimeVoiceCommandResult>;
    stop: (input: RealtimeVoiceStopInput) => Promise<RealtimeVoiceCommandResult>;
    getState: () => Promise<RealtimeVoiceState>;
    onEvent: (callback: (event: RealtimeVoiceEvent) => void) => () => void;
    editKeybindings: (input: ServerEditKeybindingsInput) => Promise<ServerEditKeybindingsResult>;
  };
  stats: {
    getProfileStats: (input: StatsGetProfileStatsInput) => Promise<StatsGetProfileStatsResult>;
    getProfileTokenStats: (
      input: StatsGetProfileTokenStatsInput,
    ) => Promise<StatsGetProfileTokenStatsResult>;
    getRecap: (input: StatsGetRecapInput) => Promise<StatsGetRecapResult>;
  };
  computerHistory?: {
    getState: (input?: ComputerHistoryGetStateInput) => Promise<ComputerHistoryState>;
    getSettings: (input?: ComputerHistoryGetSettingsInput) => Promise<ComputerHistorySettings>;
    updateSettings: (input: ComputerHistoryUpdateSettingsInput) => Promise<ComputerHistoryState>;
    listApplications: () => Promise<ComputerHistoryApplicationListResult>;
    resolveApplications: (
      input: ComputerHistoryResolveApplicationsInput,
    ) => Promise<ComputerHistoryResolveApplicationsResult>;
    setEnabled: (input: ComputerHistorySetEnabledInput) => Promise<ComputerHistoryState>;
    retryActivation: () => Promise<ComputerHistoryState>;
    pause: () => Promise<ComputerHistoryState>;
    resume: () => Promise<ComputerHistoryState>;
    listHistory: (
      input?: ComputerHistoryListHistoryInput,
    ) => Promise<ComputerHistoryListHistoryResult>;
    listHistorySuggestions: (
      input?: ComputerHistoryListSuggestionsInput,
    ) => Promise<ComputerHistoryListSuggestionsResult>;
    listHistorySummaryIntervals: (
      input: ComputerHistoryListSummaryIntervalsInput,
    ) => Promise<ComputerHistoryListSummaryIntervalsResult>;
    revealInFinder: (
      input: ComputerHistoryRevealInFinderInput,
    ) => Promise<ComputerHistoryRevealInFinderResult>;
    clearHistory: (
      input: ComputerHistoryClearHistoryInput,
    ) => Promise<ComputerHistoryClearHistoryResult>;
  };
  provider: {
    getComposerCapabilities: (
      input: ProviderGetComposerCapabilitiesInput,
    ) => Promise<ProviderComposerCapabilities>;
    compactThread: (input: ProviderCompactThreadInput) => Promise<void>;
    listCommands: (input: ProviderListCommandsInput) => Promise<ProviderListCommandsResult>;
    listSkills: (input: ProviderListSkillsInput) => Promise<ProviderListSkillsResult>;
    readSkill: (input: ProviderReadSkillInput) => Promise<ProviderReadSkillResult>;
    listSkillsCatalog: (input: ProviderSkillsCatalogInput) => Promise<ProviderSkillsCatalogResult>;
    listPlugins: (input: ProviderListPluginsInput) => Promise<ProviderListPluginsResult>;
    readPlugin: (input: ProviderReadPluginInput) => Promise<ProviderReadPluginResult>;
    addMarketplace: (input: ProviderAddMarketplaceInput) => Promise<ProviderAddMarketplaceResult>;
    removeMarketplace: (
      input: ProviderRemoveMarketplaceInput,
    ) => Promise<ProviderRemoveMarketplaceResult>;
    upgradeMarketplace: (
      input: ProviderUpgradeMarketplaceInput,
    ) => Promise<ProviderUpgradeMarketplaceResult>;
    installPlugin: (input: ProviderInstallPluginInput) => Promise<ProviderInstallPluginResult>;
    uninstallPlugin: (
      input: ProviderUninstallPluginInput,
    ) => Promise<ProviderUninstallPluginResult>;
    setPluginEnabled: (
      input: ProviderSetPluginEnabledInput,
    ) => Promise<ProviderSetPluginEnabledResult>;
    listApps: (input: ProviderListAppsInput) => Promise<ProviderListAppsResult>;
    setAppEnabled: (input: ProviderSetAppEnabledInput) => Promise<ProviderSetAppEnabledResult>;
    readAppTools: (input: ProviderReadAppToolsInput) => Promise<ProviderReadAppToolsResult>;
    readAppConnector: (
      input: ProviderReadAppConnectorInput,
    ) => Promise<ProviderReadAppConnectorResult>;
    readAppConnectorTerms: (
      input: ProviderReadAppConnectorTermsInput,
    ) => Promise<ProviderReadAppConnectorTermsResult>;
    startAppConnection: (
      input: ProviderStartAppConnectionInput,
    ) => Promise<ProviderStartAppConnectionResult>;
    completeAppConnection: (
      input: ProviderCompleteAppConnectionInput,
    ) => Promise<ProviderCompleteAppConnectionResult>;
    listModels: (input: ProviderListModelsInput) => Promise<ProviderListModelsResult>;
    listAgents: (input: ProviderListAgentsInput) => Promise<ProviderListAgentsResult>;
    listMcp: (input: ProviderListMcpInput) => Promise<ProviderListMcpResult>;
    catalogSelection: (input: MossCatalogSelectionInput) => Promise<MossCatalogSelectionResult>;
    resourceImportInventory: (
      input: MossResourceImportInventoryInput,
    ) => Promise<MossResourceImportInventoryResult>;
    resourceImportPlan: (
      input: MossResourceImportPlanInput,
    ) => Promise<MossResourceImportPlanResult>;
    resourceImportApply: (
      input: MossResourceImportApplyInput,
    ) => Promise<MossResourceImportApplyResult>;
    resourceImportRollback: (
      input: MossResourceImportRollbackInput,
    ) => Promise<MossResourceImportRollbackResult>;
    prepareMossResourceMutation: (
      input: MossCanonicalResourceMutationPrepareInput,
    ) => Promise<MossCanonicalResourceMutationPlanResult>;
    createMossResource: (input: MossCreateResourceInput) => Promise<MossCreateResourceResult>;
    deleteMossResource: (input: MossDeleteResourceInput) => Promise<MossDeleteResourceResult>;
    updateMossResource: (input: MossUpdateResourceInput) => Promise<MossUpdateResourceResult>;
    listSessions: () => Promise<ProviderListSessionsResult>;
    getLaunchPlan: (input: ProviderGetLaunchPlanInput) => Promise<ProviderGetLaunchPlanResult>;
    getLoopLedgerDashboardSnapshot: (
      input: ProviderGetLoopLedgerDashboardSnapshotInput,
    ) => Promise<ProviderGetLoopLedgerDashboardSnapshotResult>;
    submitPermissionAction: (
      input: ProviderSubmitPermissionActionInput,
    ) => Promise<ProviderSubmitPermissionActionResult>;
    subscribeNormalizedSessionEvents: (
      input: MossSubscribeNormalizedSessionEventsInput,
      callback: (event: MossNormalizedSessionEvent) => void,
    ) => () => void;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    getShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    getThreadDetailSnapshot: (
      input: OrchestrationGetThreadDetailSnapshotInput,
    ) => Promise<OrchestrationGetThreadDetailSnapshotResult>;
    searchThreads: (
      input: OrchestrationSearchThreadsInput,
    ) => Promise<OrchestrationSearchThreadsResult>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<DispatchResult>;
    importThread: (
      input: OrchestrationImportThreadInput,
    ) => Promise<OrchestrationImportThreadResult>;
    listProjectImports: (input: ListProjectImportsInput) => Promise<ListProjectImportsResult>;
    importProject: (input: ImportProjectInput) => Promise<ImportProjectResult>;
    loadProjectImportHistory: (
      input: LoadProjectImportHistoryInput,
    ) => Promise<LoadProjectImportHistoryResult>;
    regenerateThreadTitle: (
      input: OrchestrationRegenerateThreadTitleInput,
    ) => Promise<OrchestrationRegenerateThreadTitleResult>;
    predictNextMessage: (
      input: OrchestrationPredictNextMessageInput,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<OrchestrationPredictNextMessageResult>;
    repairState: () => Promise<OrchestrationReadModel>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getInlineVisual: (
      input: OrchestrationGetInlineVisualInput,
    ) => Promise<OrchestrationGetInlineVisualResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (
      fromSequenceExclusive: number,
      threadId?: ThreadId,
    ) => Promise<OrchestrationEvent[]>;
    listProviderDeliveryBlockers: (
      input?: OrchestrationListProviderDeliveryBlockersInput,
    ) => Promise<OrchestrationListProviderDeliveryBlockersResult>;
    reconcileProviderDelivery: (
      input: OrchestrationReconcileProviderDeliveryInput,
    ) => Promise<OrchestrationReconcileProviderDeliveryResult>;
    prepareQuitResume: (
      input: OrchestrationPrepareQuitResumeInput,
    ) => Promise<OrchestrationPrepareQuitResumeResult>;
    subscribeShell: () => Promise<void>;
    unsubscribeShell: () => Promise<void>;
    subscribeThread: (input: OrchestrationSubscribeThreadInput) => Promise<void>;
    unsubscribeThread: (input: OrchestrationUnsubscribeThreadInput) => Promise<void>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
    onShellEvent: (callback: (event: OrchestrationShellStreamItem) => void) => () => void;
    onThreadEvent: (callback: (event: OrchestrationThreadStreamItem) => void) => () => void;
  };
  projectAgent: {
    getOverview: (input: ProjectAgentGetOverviewInput) => Promise<ProjectAgentOverview>;
    listSummaries: (
      input?: ProjectAgentListSummariesInput,
    ) => Promise<ProjectAgentListSummariesResult>;
    configure: (input: ProjectAgentConfigureInput) => Promise<ProjectAgentOverview>;
    linkProject: (input: ProjectAgentLinkProjectInput) => Promise<ProjectAgentOverview>;
    unlinkProject: (input: ProjectAgentUnlinkProjectInput) => Promise<ProjectAgentOverview>;
    startGoal: (input: ProjectAgentStartGoalInput) => Promise<ProjectGoal>;
    updateGoal: (input: ProjectAgentUpdateGoalInput) => Promise<ProjectGoal>;
    pauseGoal: (input: ProjectAgentGoalControlInput) => Promise<ProjectGoal>;
    resumeGoal: (input: ProjectAgentGoalControlInput) => Promise<ProjectGoal>;
    stopGoal: (input: ProjectAgentGoalControlInput) => Promise<ProjectGoal>;
    listTasks: (input: ProjectAgentListTasksInput) => Promise<ProjectAgentListTasksResult>;
    createTask: (input: ProjectAgentCreateTaskInput) => Promise<ProjectTask>;
    updateTask: (input: ProjectAgentUpdateTaskInput) => Promise<ProjectTask>;
    listEvidence: (input: ProjectAgentListEvidenceInput) => Promise<ProjectAgentListEvidenceResult>;
    listThreadIndex: (
      input: ProjectAgentListThreadIndexInput,
    ) => Promise<ProjectAgentListThreadIndexResult>;
    excludeThread: (input: ProjectAgentExcludeThreadInput) => Promise<ProjectThreadIndexEntry>;
    backfillSummaries: (input: ProjectAgentBackfillInput) => Promise<ProjectAgentOverview>;
    listActivity: (input: ProjectAgentListActivityInput) => Promise<ProjectAgentListActivityResult>;
    listDocuments: (
      input: ProjectAgentListDocumentsInput,
    ) => Promise<ProjectAgentListDocumentsResult>;
    readDocument: (input: ProjectAgentReadDocumentInput) => Promise<ProjectAgentReadDocumentResult>;
    writeDocument: (input: ProjectAgentWriteDocumentInput) => Promise<ProjectDocumentRevision>;
    exportDocuments: (
      input: ProjectAgentExportDocumentsInput,
    ) => Promise<ProjectAgentExportDocumentsResult>;
    refreshDigest: (input: ProjectAgentRefreshDigestInput) => Promise<ProjectAgentOverview>;
    pauseGroup: (input: ProjectAgentGroupControlInput) => Promise<ProjectAgentOverview>;
    resumeGroup: (input: ProjectAgentGroupControlInput) => Promise<ProjectAgentOverview>;
    archiveGroup: (input: ProjectAgentGroupControlInput) => Promise<ProjectAgentOverview>;
    unarchiveGroup: (input: ProjectAgentGroupControlInput) => Promise<ProjectAgentOverview>;
    restartCoordinator: (input: ProjectAgentGroupControlInput) => Promise<ProjectAgentOverview>;
    deleteGroup: (input: ProjectAgentDeleteGroupInput) => Promise<ProjectAgentDeleteGroupResult>;
    resolveWorker: (
      input: ProjectAgentResolveWorkerInput,
    ) => Promise<ProjectAgentResolveWorkerResult>;
    library: {
      list: (input: ProjectAgentLibraryListInput) => Promise<ProjectAgentLibraryListResult>;
      mkdir: (input: ProjectAgentLibraryMkdirInput) => Promise<ProjectAgentLibraryMutationResult>;
      rename: (input: ProjectAgentLibraryRenameInput) => Promise<ProjectAgentLibraryMutationResult>;
      delete: (input: ProjectAgentLibraryDeleteInput) => Promise<ProjectAgentLibraryMutationResult>;
      history: (
        input: ProjectAgentLibraryHistoryInput,
      ) => Promise<ProjectAgentLibraryHistoryResult>;
      restore: (
        input: ProjectAgentLibraryRestoreInput,
      ) => Promise<ProjectAgentLibraryMutationResult>;
      status: (input: ProjectAgentLibraryStatusInput) => Promise<ProjectAgentLibraryStatusResult>;
    };
    subscribe: (input: { projectId: string }) => Promise<void>;
    unsubscribe: (input: { projectId: string }) => Promise<void>;
    onEvent: (callback: (event: ProjectAgentStreamEvent) => void) => () => void;
  };
  automation: {
    list: (input?: AutomationListInput) => Promise<AutomationListResult>;
    getMemory: (input: AutomationGetMemoryInput) => Promise<AutomationMemory | null>;
    create: (input: AutomationCreateInput) => Promise<AutomationDefinition>;
    update: (input: AutomationUpdateInput) => Promise<AutomationDefinition>;
    delete: (input: AutomationDeleteInput) => Promise<void>;
    runNow: (input: AutomationRunNowInput) => Promise<AutomationRunNowResult>;
    cancelRun: (input: AutomationCancelRunInput) => Promise<AutomationCancelRunResult>;
    markRunRead: (input: AutomationMarkRunReadInput) => Promise<AutomationRunActionResult>;
    archiveRun: (input: AutomationArchiveRunInput) => Promise<AutomationRunActionResult>;
    resolveProposal: (
      input: AutomationResolveProposalInput,
    ) => Promise<AutomationResolveProposalResult>;
    onEvent: (callback: (event: AutomationStreamEvent) => void) => () => void;
  };
  todo: {
    list: () => Promise<TodoListResult>;
    create: (input: TodoCreateInput) => Promise<Todo>;
    update: (input: TodoUpdateInput) => Promise<Todo>;
    delete: (input: TodoDeleteInput) => Promise<void>;
    onEvent: (callback: (event: TodoStreamEvent) => void) => () => void;
  };
  secretRequests: {
    answer: (input: SecretRequestAnswerInput) => Promise<void>;
  };
  pages: {
    spaces: (input: PagesScopeInput) => Promise<PagesSpacesResult>;
    list: (input: PagesListInput) => Promise<PagesListResult>;
    read: (input: PagesReadInput) => Promise<PagesReadResult>;
    versions: (input: PagesVersionsInput) => Promise<PagesVersionsResult>;
    comments: (input: PagesCommentsInput) => Promise<PagesCommentsResult>;
    mutate: (input: PagesMutateInput) => Promise<PagesMutateResult>;
  };
  library: {
    list: (input?: LibraryListInput) => Promise<LibraryListResult>;
    sync: () => Promise<LibrarySyncResult>;
    favorite: (input: LibraryFavoriteInput) => Promise<LibraryItemsResult>;
    move: (input: LibraryMoveInput) => Promise<LibraryItemsResult>;
    rename: (input: LibraryRenameInput) => Promise<LibraryItemsResult>;
    trash: (input: LibraryTrashInput) => Promise<LibraryItemsResult>;
    restore: (input: LibraryRestoreInput) => Promise<LibraryItemsResult>;
    deletePermanently: (input: LibraryDeleteInput) => Promise<LibraryItemsResult>;
    createFolder: (input: LibraryCreateFolderInput) => Promise<LibraryFolderResult>;
    renameFolder: (input: LibraryRenameFolderInput) => Promise<LibraryFolderResult>;
    deleteFolder: (input: LibraryDeleteFolderInput) => Promise<void>;
    register: (input: LibraryRegisterInput) => Promise<LibraryItemsResult>;
    importFiles: (input: LibraryImportInput) => Promise<LibraryImportResult>;
  };
  browser: BrowserControlMethods & {
    annotations: BrowserAnnotationMethods;
    onCopyLink: (callback: (event: BrowserCopyLinkEvent) => void) => () => void;
  };
  // macOS-only in practice: off darwin the server answers `list`/`getThreadState`
  // with an `unsupported-platform` availability and refuses the rest, so the pane
  // renders its blocked state rather than the client guessing at capabilities.
  device: {
    list: (input: DeviceListInput) => Promise<DeviceListResult>;
    boot: (input: DeviceBootInput) => Promise<DeviceBootResult>;
    shutdown: (input: DeviceShutdownInput) => Promise<void>;
    attach: (input: DeviceAttachInput) => Promise<ThreadDeviceState>;
    detach: (input: DeviceDetachInput) => Promise<ThreadDeviceState>;
    getThreadState: (input: DeviceThreadInput) => Promise<ThreadDeviceState>;
    tap: (input: DeviceTapInput) => Promise<void>;
    swipe: (input: DeviceSwipeInput) => Promise<void>;
    typeText: (input: DeviceTypeTextInput) => Promise<void>;
    keyEvent: (input: DeviceKeyEventInput) => Promise<void>;
    pressButton: (input: DevicePressButtonInput) => Promise<void>;
    installApp: (input: DeviceInstallAppInput) => Promise<DeviceInstallAppResult>;
    launchApp: (input: DeviceLaunchAppInput) => Promise<DeviceLaunchAppResult>;
    openUrl: (input: DeviceOpenUrlInput) => Promise<void>;
    screenshot: (input: DeviceScreenshotInput) => Promise<DeviceScreenshotResult>;
    startRecording: (input: DeviceStartRecordingInput) => Promise<DeviceStartRecordingResult>;
    stopRecording: (input: DeviceStopRecordingInput) => Promise<DeviceStopRecordingResult>;
    describeUi: (input: DeviceDescribeUiInput) => Promise<DeviceDescribeUiResult>;
    scrollToElement: (input: DeviceScrollToElementInput) => Promise<DeviceScrollToElementResult>;
    onEvent: (callback: (event: DeviceEvent) => void) => () => void;
  };
  computer: {
    /** Thread-independent backend status for surfaces outside any conversation. */
    getStatus: (input: ComputerGetStatusInput) => Promise<ComputerStatusResult>;
    getAuditHistory: (
      input: ComputerGetAuditHistoryInput,
    ) => Promise<ComputerGetAuditHistoryResult>;
    provision: (input: ComputerProvisionInput) => Promise<ComputerProvisionResult>;
    setControlEnabled: (
      input: ComputerSetControlEnabledInput,
    ) => Promise<ComputerControlEnabledResult>;
    getThreadState: (input: ComputerThreadInput) => Promise<ThreadComputerState>;
    getState: (input: ComputerGetStateInput) => Promise<ComputerState>;
    /** User input from the computer dock pane; needs no agent turn in flight. */
    inputClick: (input: ComputerInputClickInput) => Promise<ComputerActionResult>;
    inputScroll: (input: ComputerInputScrollInput) => Promise<ComputerActionResult>;
    inputKey: (input: ComputerInputKeyInput) => Promise<ComputerActionResult>;
    onEvent: (callback: (event: ComputerEvent) => void) => () => void;
  };
}
