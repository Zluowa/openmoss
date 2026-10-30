import { Schema, Struct, Tuple } from "effect";
import {
  PagesCommentsInput,
  PagesListInput,
  PagesMutateInput,
  PagesReadInput,
  PagesScopeInput,
  PagesVersionsInput,
} from "./pages";
import {
  LoadProjectImportHistoryInput,
  ImportProjectInput,
  ListProjectImportsInput,
} from "./projectImport";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

import {
  AutomationCancelRunInput,
  AutomationArchiveRunInput,
  AutomationCreateInput,
  AutomationDeleteInput,
  AutomationGetMemoryInput,
  AutomationListInput,
  AutomationMarkRunReadInput,
  AutomationResolveProposalInput,
  AutomationRunNowInput,
  AutomationStreamEvent,
  AutomationUpdateInput,
} from "./automation";
import { TodoCreateInput, TodoDeleteInput, TodoStreamEvent, TodoUpdateInput } from "./todo";
import {
  LibraryCreateFolderInput,
  LibraryDeleteFolderInput,
  LibraryDeleteInput,
  LibraryFavoriteInput,
  LibraryImportInput,
  LibraryListInput,
  LibraryMoveInput,
  LibraryRegisterInput,
  LibraryRenameFolderInput,
  LibraryRenameInput,
  LibraryRestoreInput,
  LibraryTrashInput,
} from "./library";
import {
  ProjectAgentConfigureInput,
  ProjectAgentLinkProjectInput,
  ProjectAgentUnlinkProjectInput,
  ProjectAgentExportDocumentsInput,
  ProjectAgentGetOverviewInput,
  ProjectAgentListSummariesInput,
  ProjectAgentGoalControlInput,
  ProjectAgentListActivityInput,
  ProjectAgentListDocumentsInput,
  ProjectAgentListTasksInput,
  ProjectAgentReadDocumentInput,
  ProjectAgentRefreshDigestInput,
  ProjectAgentStartGoalInput,
  ProjectAgentStreamEvent,
  ProjectAgentSubscribeInput,
  ProjectAgentUpdateGoalInput,
  ProjectAgentUpdateTaskInput,
  ProjectAgentWriteDocumentInput,
  ProjectAgentCreateTaskInput,
  ProjectAgentExcludeThreadInput,
  ProjectAgentBackfillInput,
  ProjectAgentListThreadIndexInput,
  ProjectAgentListEvidenceInput,
  ProjectAgentLibraryDeleteInput,
  ProjectAgentLibraryHistoryInput,
  ProjectAgentLibraryListInput,
  ProjectAgentLibraryMkdirInput,
  ProjectAgentLibraryRenameInput,
  ProjectAgentLibraryRestoreInput,
  ProjectAgentDeleteGroupInput,
  ProjectAgentGroupControlInput,
  ProjectAgentLibraryStatusInput,
  ProjectAgentResolveWorkerInput,
} from "./projectAgent";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationImportThreadInput,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
  OrchestrationUnsubscribeShellInput,
  OrchestrationUnsubscribeThreadInput,
  ORCHESTRATION_WS_CHANNELS,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetThreadDetailSnapshotInput,
  OrchestrationSearchThreadsInput,
  OrchestrationGetShellSnapshotInput,
  OrchestrationRepairStateInput,
  ORCHESTRATION_WS_METHODS,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsInput,
  OrchestrationPredictNextMessageInput,
  OrchestrationRegenerateThreadTitleInput,
  OrchestrationSettleTurnDispatchInput,
} from "./orchestration";
import { OrchestrationGetInlineVisualInput } from "./inlineVisual";
import {
  GitActionProgressEvent,
  GitBlameLineInput,
  GitReadFileAtRevInput,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitHubRepositoryInput,
  GitHandoffThreadInput,
  GitPreparePullRequestThreadInput,
  GitCreateWorktreeInput,
  GitInitInput,
  GitListBranchesInput,
  GitListRecentCommitsInput,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitReadWorkingTreeDiffInput,
  GitRemoveWorktreeInput,
  GitRemoveIndexLockInput,
  GitRunStackedActionInput,
  GitStageFilesInput,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStatusInput,
  GitSummarizeDiffInput,
  GitUnstageFilesInput,
  GitWorktreeSetupProgressEvent,
} from "./git";
import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./terminal";
import { KeybindingRule } from "./keybindings";
import {
  MossCanonicalResourceMutationPrepareInput,
  MossCreateResourceInput,
  MossDeleteResourceInput,
  MossUpdateResourceInput,
  MossSubscribeNormalizedSessionEventsInput,
} from "./moss";
import {
  MossResourceImportApplyInput,
  MossResourceImportInventoryInput,
  MossResourceImportPlanInput,
  MossResourceImportRollbackInput,
} from "./mossResourceImport";
import {
  WorkspaceImportApplyInput,
  WorkspaceImportProbeInput,
  WorkspaceImportSyncInput,
} from "./workspaceImport";
import { MossCatalogSelectionInput } from "./providerMarketplaceTicket";
import {
  MossAccountSelectRealmInput,
  MossAccountStartPhoneLoginInput,
  MossAccountVerifyPhoneLoginInput,
} from "./mossAccount";
import {
  MossCloudExchangeGoogleOAuthCodeInput,
  MossCloudExchangeCodeInput,
  MossCloudRemoveAccountInput,
  MossCloudRequestPasswordResetInput,
  MossCloudSelectAccountInput,
  MossCloudSignInInput,
  MossCloudSignUpInput,
  MossCloudUpdatePasswordInput,
} from "./mossCloudAccount";
import { MossEnterpriseKeySignInInput } from "./mossEnterpriseKey";
import { MossPayCreateOrderInput, MossPayGetOrderInput } from "./mossPay";
import {
  RealtimeVoiceAppendSpeechInput,
  RealtimeVoiceAppendTextInput,
  RealtimeVoiceClaimInput,
  RealtimeVoiceGetStateInput,
  RealtimeVoiceListVoicesInput,
  RealtimeVoiceReleaseClaimInput,
  RealtimeVoiceReportClientStateInput,
  RealtimeVoiceResolveScreenContextInput,
  RealtimeVoiceStartInput,
  RealtimeVoiceStopInput,
  RealtimeVoiceSubscribeInput,
} from "./realtimeVoice";
import {
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectDevServerEvent,
  ProjectDiscoverScriptsInput,
  ProjectListDirectoriesInput,
  ProjectReadFileInput,
  ProjectWatchFileInput,
  ProjectPrewarmSearchIndexInput,
  ProjectResolveWorkspaceFileReferencesInput,
  ProjectResolveOutOfRootFileReferenceInput,
  ProjectRunDevServerInput,
  ProjectSearchEntriesInput,
  ProjectSearchContentInput,
  ProjectSearchLocalEntriesInput,
  ProjectStopDevServerInput,
  ProjectWriteFileInput,
} from "./project";
import { StudioListThreadOutputsInput } from "./studio";
import { FilesystemBrowseInput } from "./filesystem";
import {
  ComputerHistoryClearHistoryInput,
  ComputerHistoryGetSettingsInput,
  ComputerHistoryGetStateInput,
  ComputerHistoryListHistoryInput,
  ComputerHistoryListSuggestionsInput,
  ComputerHistoryListSummaryIntervalsInput,
  ComputerHistoryRevealInFinderInput,
  ComputerHistoryResolveApplicationsInput,
  ComputerHistorySetEnabledInput,
  ComputerHistoryUpdateSettingsInput,
} from "./computerHistory";
import {
  ComputerGetStateInput,
  ComputerProvisionInput,
  ComputerSetControlEnabledInput,
} from "./computer";
import {
  DEVICE_WS_CHANNELS,
  DEVICE_WS_METHODS,
  DeviceAttachInput,
  DeviceBootInput,
  DeviceDescribeUiInput,
  DeviceScrollToElementInput,
  DeviceDetachInput,
  DeviceEvent,
  DeviceInstallAppInput,
  DeviceKeyEventInput,
  DeviceLaunchAppInput,
  DeviceListInput,
  DeviceOpenUrlInput,
  DevicePressButtonInput,
  DeviceScreenshotInput,
  DeviceStartRecordingInput,
  DeviceStopRecordingInput,
  DeviceShutdownInput,
  DeviceSwipeInput,
  DeviceTapInput,
  DeviceThreadInput,
  DeviceTypeTextInput,
} from "./device";
import { COMPUTER_WS_CHANNELS, ComputerEvent } from "./computer";
import { OpenInEditorInput } from "./editor";
import {
  ServerConfigUpdatedPayload,
  ServerEditKeybindingsInput,
  ServerReadThreadDiagnosticsInput,
  ServerGenerateAutomationIntentInput,
  ServerGenerateThreadRecapInput,
  ServerKeepAwakeUpdatedPayload,
  ServerLifecycleStreamEvent,
  ServerProviderLoginInput,
  ServerProviderUpdateInput,
  ServerUpdateSettingsInput,
  ServerConsumeCodexResetCreditInput,
  ServerGetProviderUsageSnapshotInput,
  ServerListProviderUsageInput,
  ServerProviderStatusesUpdatedPayload,
  ServerSettingsUpdatedPayload,
  ServerStopLocalServerInput,
  ServerVoicePrewarmInput,
  ServerVoiceTranscriptionInput,
} from "./server";
import {
  StatsGetProfileStatsInput,
  StatsGetProfileTokenStatsInput,
  StatsGetRecapInput,
} from "./stats";
import {
  ProviderAddMarketplaceInput,
  ProviderListAppsInput,
  ProviderReadAppToolsInput,
  ProviderReadAppConnectorInput,
  ProviderReadAppConnectorTermsInput,
  ProviderStartAppConnectionInput,
  ProviderCompleteAppConnectionInput,
  ProviderListCommandsInput,
  ProviderGetComposerCapabilitiesInput,
  ProviderInstallPluginInput,
  ProviderListPluginsInput,
  ProviderListModelsInput,
  ProviderListAgentsInput,
  ProviderListMcpInput,
  ProviderReadPluginInput,
  ProviderRemoveMarketplaceInput,
  ProviderSetAppEnabledInput,
  ProviderSetPluginEnabledInput,
  ProviderUpgradeMarketplaceInput,
  ProviderUninstallPluginInput,
  ProviderListSkillsInput,
  ProviderReadSkillInput,
  ProviderSkillsCatalogInput,
} from "./providerDiscovery";
import {
  ProviderCompactThreadInput,
  ProviderGetLaunchPlanInput,
  ProviderGetLoopLedgerDashboardSnapshotInput,
  ProviderSubmitPermissionActionInput,
} from "./provider";
import {
  PullRequestActionInput,
  PullRequestCommentInput,
  PullRequestDetailInput,
  PullRequestSetPinnedInput,
} from "./pullRequests";
import { PullRequestAutoFixGetInput, PullRequestAutoFixSetInput } from "./pullRequestAutoFix";
import {
  GitHubInboxListInput,
  GitHubIssueCommentInput,
  GitHubIssueDetailInput,
} from "./githubInbox";
import {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpRefreshPairingInput,
  ExternalMcpRevokeIntegrationInput,
} from "./externalMcp";
import { McpConnectorConnectInput, McpConnectorDisconnectInput } from "./mcpConnectors";
import {
  MossAppsConnectFieldsInput,
  MossAppsConnectInput,
  MossAppsDisconnectInput,
  MossAppsListToolkitsInput,
} from "./mossApps";
import {
  GitHubProjectProvisionInput,
  GitHubProjectProvisionProgressEvent,
} from "./githubProjectProvisioning";

// ── WebSocket RPC Method Names ───────────────────────────────────────

export const WS_METHODS = {
  // Project registry methods
  projectsDiscoverScripts: "projects.discoverScripts",
  projectsListDirectories: "projects.listDirectories",
  projectsSearchEntries: "projects.searchEntries",
  projectsSearchLocalEntries: "projects.searchLocalEntries",
  projectsSearchContent: "projects.searchContent",
  projectsPrewarmSearchIndex: "projects.prewarmSearchIndex",
  projectsReadFile: "projects.readFile",
  projectsSubscribeFileChange: "projects.subscribeFileChange",
  projectsResolveWorkspaceFileReferences: "projects.resolveWorkspaceFileReferences",
  projectsResolveOutOfRootFileReference: "projects.resolveOutOfRootFileReference",
  projectsCreateLocalFilePreviewGrant: "projects.createLocalFilePreviewGrant",
  projectsWriteFile: "projects.writeFile",
  projectsRunDevServer: "projects.runDevServer",
  projectsStopDevServer: "projects.stopDevServer",
  projectsListDevServers: "projects.listDevServers",
  subscribeProjectDevServerEvents: "projects.subscribeDevServerEvents",
  projectsProvisionFromGitHub: "projects.provisionFromGitHub",

  // Studio methods
  studioListThreadOutputs: "studio.listThreadOutputs",

  // Filesystem browse methods
  filesystemBrowse: "filesystem.browse",

  // Native dialog methods (the server raises OS dialogs on behalf of browsers)
  dialogsPickFolder: "dialogs.pickFolder",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitGithubRepository: "git.githubRepository",
  gitStatus: "git.status",
  gitReadWorkingTreeDiff: "git.readWorkingTreeDiff",
  gitBlameLine: "git.blameLine",
  gitReadFileAtRev: "git.readFileAtRev",
  gitWorkingTreeDiffStats: "git.workingTreeDiffStats",
  gitSummarizeDiff: "git.summarizeDiff",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitListRecentCommits: "git.listRecentCommits",
  gitCreateWorktree: "git.createWorktree",
  gitCreateDetachedWorktree: "git.createDetachedWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitStashAndCheckout: "git.stashAndCheckout",
  gitStashDrop: "git.stashDrop",
  gitStashInfo: "git.stashInfo",
  gitRemoveIndexLock: "git.removeIndexLock",
  gitInit: "git.init",
  gitStageFiles: "git.stageFiles",
  gitUnstageFiles: "git.unstageFiles",
  gitHandoffThread: "git.handoffThread",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPullRequestSnapshot: "git.pullRequestSnapshot",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // GitHub inbox and global pull request methods
  githubInboxList: "githubInbox.list",
  githubInboxIssueDetail: "githubInbox.issueDetail",
  githubInboxIssueComment: "githubInbox.issueComment",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsDiff: "pullRequests.diff",
  pullRequestsAction: "pullRequests.action",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsSetPinned: "pullRequests.setPinned",
  pullRequestsGetAutoFix: "pullRequests.getAutoFix",
  pullRequestsSetAutoFix: "pullRequests.setAutoFix",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalAckOutput: "terminal.ackOutput",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetRuntimeStatus: "server.getRuntimeStatus",
  serverGetConfig: "server.getConfig",
  serverGetEnvironment: "server.getEnvironment",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverStartProviderLogin: "server.startProviderLogin",
  serverCancelProviderLogin: "server.cancelProviderLogin",
  serverListExternalMcpIntegrations: "server.listExternalMcpIntegrations",
  serverCreateExternalMcpIntegration: "server.createExternalMcpIntegration",
  serverRevokeExternalMcpIntegration: "server.revokeExternalMcpIntegration",
  serverRefreshExternalMcpPairing: "server.refreshExternalMcpPairing",
  serverListMcpConnectors: "server.listMcpConnectors",
  serverConnectMcpConnector: "server.connectMcpConnector",
  serverDisconnectMcpConnector: "server.disconnectMcpConnector",
  serverGetMcpConnectorSetup: "server.getMcpConnectorSetup",
  mossAppsGetStatus: "mossApps.getStatus",
  mossAppsListToolkits: "mossApps.listToolkits",
  mossAppsListConnections: "mossApps.listConnections",
  mossAppsConnectFields: "mossApps.connectFields",
  mossAppsConnect: "mossApps.connect",
  mossAppsDisconnect: "mossApps.disconnect",
  serverListWorktrees: "server.listWorktrees",
  serverListLocalServers: "server.listLocalServers",
  serverStopLocalServer: "server.stopLocalServer",
  serverGetProviderUsageSnapshot: "server.getProviderUsageSnapshot",
  serverListProviderUsage: "server.listProviderUsage",
  serverConsumeCodexResetCredit: "server.consumeCodexResetCredit",
  statsGetProfileStats: "stats.getProfileStats",
  statsGetProfileTokenStats: "stats.getProfileTokenStats",
  statsGetRecap: "stats.getRecap",
  serverGetDiagnostics: "server.getDiagnostics",
  serverWorkspaceImportProbe: "server.workspaceImport.probe",
  serverWorkspaceImportApply: "server.workspaceImport.apply",
  serverWorkspaceImportSync: "server.workspaceImport.sync",
  serverReadThreadDiagnostics: "server.readThreadDiagnostics",
  serverPrewarmVoice: "server.prewarmVoice",
  serverTranscribeVoice: "server.transcribeVoice",
  serverGenerateThreadRecap: "server.generateThreadRecap",
  serverGenerateAutomationIntent: "server.generateAutomationIntent",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverMossAccountSession: "server.mossAccount.session",
  serverMossAccountSelectRealm: "server.mossAccount.selectRealm",
  serverMossAccountStartPhoneLogin: "server.mossAccount.startPhoneLogin",
  serverMossAccountVerifyPhoneLogin: "server.mossAccount.verifyPhoneLogin",
  serverMossAccountLogout: "server.mossAccount.logout",
  serverMossCloudAccountState: "server.mossCloudAccount.state",
  serverMossCloudAccountList: "server.mossCloudAccount.list",
  serverMossCloudAccountSelect: "server.mossCloudAccount.select",
  serverMossCloudAccountRemove: "server.mossCloudAccount.remove",
  serverMossCloudAccountSignUp: "server.mossCloudAccount.signUp",
  serverMossCloudAccountSignIn: "server.mossCloudAccount.signIn",
  serverMossCloudAccountRefresh: "server.mossCloudAccount.refresh",
  serverMossCloudAccountStartGoogleOAuth: "server.mossCloudAccount.startGoogleOAuth",
  serverMossCloudAccountExchangeGoogleOAuthCode: "server.mossCloudAccount.exchangeGoogleOAuthCode",
  serverMossCloudAccountRequestPasswordReset: "server.mossCloudAccount.requestPasswordReset",
  serverMossCloudAccountExchangeCode: "server.mossCloudAccount.exchangeCode",
  serverMossCloudAccountUpdatePassword: "server.mossCloudAccount.updatePassword",
  serverMossCloudAccountLogout: "server.mossCloudAccount.logout",
  serverMossEnterpriseKeyState: "server.mossEnterpriseKey.state",
  serverMossEnterpriseKeySignIn: "server.mossEnterpriseKey.signIn",
  serverMossEnterpriseKeyActivate: "server.mossEnterpriseKey.activate",
  serverMossEnterpriseKeySignOut: "server.mossEnterpriseKey.signOut",
  serverMossPayCatalog: "server.mossPay.catalog",
  serverMossPayQuota: "server.mossPay.quota",
  serverMossPayCreateOrder: "server.mossPay.createOrder",
  serverMossPayGetOrder: "server.mossPay.getOrder",
  serverEditKeybindings: "server.editKeybindings",
  subscribeServerLifecycle: "server.subscribeLifecycle",
  subscribeServerConfig: "server.subscribeConfig",
  subscribeServerProviderStatuses: "server.subscribeProviderStatuses",
  subscribeServerKeepAwake: "server.subscribeKeepAwake",
  subscribeServerSettings: "server.subscribeSettings",

  // Realtime Voice
  realtimeVoiceListVoices: "thread.realtime.listVoices",
  realtimeVoiceClaim: "thread.realtime.claim",
  realtimeVoiceReleaseClaim: "thread.realtime.releaseClaim",
  realtimeVoiceStart: "thread.realtime.start",
  realtimeVoiceReportClientState: "thread.realtime.reportClientState",
  realtimeVoiceResolveScreenContext: "thread.realtime.resolveScreenContext",
  realtimeVoiceAppendText: "thread.realtime.appendText",
  realtimeVoiceAppendSpeech: "thread.realtime.appendSpeech",
  realtimeVoiceStop: "thread.realtime.stop",
  realtimeVoiceGetState: "thread.realtime.getState",
  realtimeVoiceSubscribe: "thread.realtime.subscribe",

  // Streaming subscriptions
  subscribeTerminalEvents: "terminal.subscribeEvents",
  subscribeOrchestrationDomainEvents: "orchestration.subscribeDomainEvents",

  // Provider discovery
  providerGetComposerCapabilities: "provider.getComposerCapabilities",
  providerCompactThread: "provider.compactThread",
  providerListCommands: "provider.listCommands",
  providerListSkills: "provider.listSkills",
  providerReadSkill: "provider.readSkill",
  providerListSkillsCatalog: "provider.listSkillsCatalog",
  providerListPlugins: "provider.listPlugins",
  providerReadPlugin: "provider.readPlugin",
  providerAddMarketplace: "provider.addMarketplace",
  providerRemoveMarketplace: "provider.removeMarketplace",
  providerUpgradeMarketplace: "provider.upgradeMarketplace",
  providerInstallPlugin: "provider.installPlugin",
  providerUninstallPlugin: "provider.uninstallPlugin",
  providerSetPluginEnabled: "provider.setPluginEnabled",
  providerListApps: "provider.listApps",
  providerSetAppEnabled: "provider.setAppEnabled",
  providerReadAppTools: "provider.readAppTools",
  providerReadAppConnector: "provider.readAppConnector",
  providerReadAppConnectorTerms: "provider.readAppConnectorTerms",
  providerStartAppConnection: "provider.startAppConnection",
  providerCompleteAppConnection: "provider.completeAppConnection",
  providerListModels: "provider.listModels",
  providerListAgents: "provider.listAgents",
  providerListMcp: "provider.listMcp",
  providerCatalogSelection: "provider.catalogSelection",
  providerResourceImportInventory: "provider.resourceImport.inventory",
  providerResourceImportPlan: "provider.resourceImport.plan",
  providerResourceImportApply: "provider.resourceImport.apply",
  providerResourceImportRollback: "provider.resourceImport.rollback",
  providerPrepareMossResourceMutation: "provider.prepareMossResourceMutation",
  providerCreateMossResource: "provider.createMossResource",
  providerDeleteMossResource: "provider.deleteMossResource",
  providerUpdateMossResource: "provider.updateMossResource",
  providerListSessions: "provider.listSessions",
  providerGetLaunchPlan: "provider.getLaunchPlan",
  providerGetLoopLedgerDashboardSnapshot: "provider.getLoopLedgerDashboardSnapshot",
  providerSubmitPermissionAction: "provider.submitPermissionAction",
  providerSubscribeNormalizedSessionEvents: "provider.subscribeNormalizedSessionEvents",

  // Automation methods
  automationList: "automation.list",
  automationGetMemory: "automation.getMemory",
  automationCreate: "automation.create",
  automationUpdate: "automation.update",
  automationDelete: "automation.delete",
  automationRunNow: "automation.runNow",
  automationCancelRun: "automation.cancelRun",
  automationMarkRunRead: "automation.markRunRead",
  automationArchiveRun: "automation.archiveRun",
  automationResolveProposal: "automation.resolveProposal",
  subscribeAutomationEvents: "automation.subscribe",

  // Local Computer History (read-only history query plus explicit lifecycle UI)
  computerHistoryGetState: "computerHistory.getState",
  computerHistoryGetSettings: "computerHistory.getSettings",
  computerHistoryUpdateSettings: "computerHistory.updateSettings",
  computerHistoryListApplications: "computerHistory.listApplications",
  computerHistoryResolveApplications: "computerHistory.resolveApplications",
  computerHistorySetEnabled: "computerHistory.setEnabled",
  computerHistoryRetryActivation: "computerHistory.retryActivation",
  computerHistoryPause: "computerHistory.pause",
  computerHistoryResume: "computerHistory.resume",
  computerHistoryListHistory: "computerHistory.listHistory",
  computerHistoryListSuggestions: "computerHistory.listSuggestions",
  computerHistoryListSummaryIntervals: "computerHistory.listSummaryIntervals",
  computerHistoryRevealInFinder: "computerHistory.revealInFinder",
  computerHistoryClearHistory: "computerHistory.clearHistory",

  // Computer Use (macOS beta; Linux is an explicit unsupported-platform result)
  computerGetStatus: "computer.getStatus",
  computerProvision: "computer.provision",
  computerGetState: "computer.getState",
  computerSetControlEnabled: "computer.setControlEnabled",
  computerPerformAction: "computer.performAction",

  // Todo methods (the Tasks view)
  todoList: "todo.list",
  todoCreate: "todo.create",
  todoUpdate: "todo.update",
  todoDelete: "todo.delete",
  subscribeTodoEvents: "todo.subscribe",

  // Secret requests (an agent's private "Save securely" card)
  secretRequestAnswer: "secretRequest.answer",

  // Library methods (Moss 资料库 local multi-agent index)
  pagesSpaces: "pages.spaces",
  pagesList: "pages.list",
  pagesRead: "pages.read",
  pagesVersions: "pages.versions",
  pagesComments: "pages.comments",
  pagesMutate: "pages.mutate",
  libraryList: "library.list",
  librarySync: "library.sync",
  libraryFavorite: "library.favorite",
  libraryMove: "library.move",
  libraryRename: "library.rename",
  libraryTrash: "library.trash",
  libraryRestore: "library.restore",
  libraryDelete: "library.delete",
  libraryCreateFolder: "library.createFolder",
  libraryRenameFolder: "library.renameFolder",
  libraryDeleteFolder: "library.deleteFolder",
  libraryRegister: "library.register",
  libraryImport: "library.import",
  projectAgentGetOverview: "projectAgent.getOverview",
  projectAgentListSummaries: "projectAgent.listSummaries",
  projectAgentConfigure: "projectAgent.configure",
  projectAgentLinkProject: "projectAgent.linkProject",
  projectAgentUnlinkProject: "projectAgent.unlinkProject",
  projectAgentStartGoal: "projectAgent.startGoal",
  projectAgentUpdateGoal: "projectAgent.updateGoal",
  projectAgentPauseGoal: "projectAgent.pauseGoal",
  projectAgentResumeGoal: "projectAgent.resumeGoal",
  projectAgentStopGoal: "projectAgent.stopGoal",
  projectAgentListTasks: "projectAgent.listTasks",
  projectAgentUpdateTask: "projectAgent.updateTask",
  projectAgentCreateTask: "projectAgent.createTask",
  projectAgentListEvidence: "projectAgent.listEvidence",
  projectAgentListThreadIndex: "projectAgent.listThreadIndex",
  projectAgentExcludeThread: "projectAgent.excludeThread",
  projectAgentBackfillSummaries: "projectAgent.backfillSummaries",
  projectAgentListActivity: "projectAgent.listActivity",
  projectAgentListDocuments: "projectAgent.listDocuments",
  projectAgentReadDocument: "projectAgent.readDocument",
  projectAgentWriteDocument: "projectAgent.writeDocument",
  projectAgentExportDocuments: "projectAgent.exportDocuments",
  projectAgentRefreshDigest: "projectAgent.refreshDigest",
  projectAgentPauseGroup: "projectAgent.pause",
  projectAgentResumeGroup: "projectAgent.resume",
  projectAgentArchiveGroup: "projectAgent.archive",
  projectAgentUnarchiveGroup: "projectAgent.unarchive",
  projectAgentRestartCoordinator: "projectAgent.restartCoordinator",
  projectAgentDeleteGroup: "projectAgent.delete",
  projectAgentLibraryList: "projectAgent.library.list",
  projectAgentLibraryMkdir: "projectAgent.library.mkdir",
  projectAgentLibraryRename: "projectAgent.library.rename",
  projectAgentLibraryDelete: "projectAgent.library.delete",
  projectAgentLibraryHistory: "projectAgent.library.history",
  projectAgentLibraryRestore: "projectAgent.library.restore",
  projectAgentLibraryStatus: "projectAgent.library.status",
  projectAgentResolveWorker: "projectAgent.resolveWorker",
  subscribeProjectAgentEvents: "projectAgent.subscribe",
} as const;

// ── Push Event Channels ──────────────────────────────────────────────

export const WS_CHANNELS = {
  automationEvent: "automation.event",
  todoEvent: "todo.event",
  gitActionProgress: "git.actionProgress",
  gitWorktreeSetupProgress: "git.worktreeSetupProgress",
  projectProvisionProgress: "project.provisionProgress",
  terminalEvent: "terminal.event",
  projectDevServerEvent: "project.devServerEvent",
  projectAgentEvent: "projectAgent.event",
  serverWelcome: "server.welcome",
  serverMaintenanceUpdated: "server.maintenanceUpdated",
  serverConfigUpdated: "server.configUpdated",
  serverProviderStatusesUpdated: "server.providerStatusesUpdated",
  serverKeepAwakeUpdated: "server.keepAwakeUpdated",
  serverSettingsUpdated: "server.settingsUpdated",
} as const;

// -- Tagged Union of all request body schemas ─────────────────────────

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(
    Struct.assign({ _tag: Schema.tag(tag) }),
    // PreserveChecks is safe here. No existing schema should have checks depending on the tag
    { unsafePreserveChecks: true },
  );

const WebSocketRequestBody = Schema.Union([
  // Orchestration methods
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    Schema.Struct({ command: ClientOrchestrationCommand }),
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.importThread, OrchestrationImportThreadInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.settleTurnDispatch, OrchestrationSettleTurnDispatchInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.listProjectImports, ListProjectImportsInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.importProject, ImportProjectInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.loadProjectImportHistory, LoadProjectImportHistoryInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.regenerateThreadTitle,
    OrchestrationRegenerateThreadTitleInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.predictNextMessage, OrchestrationPredictNextMessageInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getSnapshot, OrchestrationGetSnapshotInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getShellSnapshot, OrchestrationGetShellSnapshotInput),
  tagRequestBody(
    ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
    OrchestrationGetThreadDetailSnapshotInput,
  ),
  tagRequestBody(ORCHESTRATION_WS_METHODS.searchThreads, OrchestrationSearchThreadsInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.repairState, OrchestrationRepairStateInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getTurnDiff, OrchestrationGetTurnDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getInlineVisual, OrchestrationGetInlineVisualInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.getFullThreadDiff, OrchestrationGetFullThreadDiffInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.replayEvents, OrchestrationReplayEventsInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.subscribeShell, OrchestrationSubscribeShellInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.unsubscribeShell, OrchestrationUnsubscribeShellInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.subscribeThread, OrchestrationSubscribeThreadInput),
  tagRequestBody(ORCHESTRATION_WS_METHODS.unsubscribeThread, OrchestrationUnsubscribeThreadInput),

  // Project Search
  tagRequestBody(WS_METHODS.projectsDiscoverScripts, ProjectDiscoverScriptsInput),
  tagRequestBody(WS_METHODS.projectsListDirectories, ProjectListDirectoriesInput),
  tagRequestBody(WS_METHODS.projectsSearchEntries, ProjectSearchEntriesInput),
  tagRequestBody(WS_METHODS.projectsSearchLocalEntries, ProjectSearchLocalEntriesInput),
  tagRequestBody(WS_METHODS.projectsSearchContent, ProjectSearchContentInput),
  tagRequestBody(WS_METHODS.projectsPrewarmSearchIndex, ProjectPrewarmSearchIndexInput),
  tagRequestBody(WS_METHODS.projectsReadFile, ProjectReadFileInput),
  tagRequestBody(WS_METHODS.projectsSubscribeFileChange, ProjectWatchFileInput),
  tagRequestBody(
    WS_METHODS.projectsResolveWorkspaceFileReferences,
    ProjectResolveWorkspaceFileReferencesInput,
  ),
  tagRequestBody(
    WS_METHODS.projectsResolveOutOfRootFileReference,
    ProjectResolveOutOfRootFileReferenceInput,
  ),
  tagRequestBody(
    WS_METHODS.projectsCreateLocalFilePreviewGrant,
    ProjectCreateLocalFilePreviewGrantInput,
  ),
  tagRequestBody(WS_METHODS.projectsWriteFile, ProjectWriteFileInput),
  tagRequestBody(WS_METHODS.projectsRunDevServer, ProjectRunDevServerInput),
  tagRequestBody(WS_METHODS.projectsStopDevServer, ProjectStopDevServerInput),
  tagRequestBody(WS_METHODS.projectsListDevServers, Schema.Struct({})),
  tagRequestBody(WS_METHODS.subscribeProjectDevServerEvents, Schema.Struct({})),
  tagRequestBody(WS_METHODS.projectsProvisionFromGitHub, GitHubProjectProvisionInput),

  // Filesystem browse
  // Studio
  tagRequestBody(WS_METHODS.studioListThreadOutputs, StudioListThreadOutputsInput),

  tagRequestBody(WS_METHODS.filesystemBrowse, FilesystemBrowseInput),

  // Native dialogs
  tagRequestBody(WS_METHODS.dialogsPickFolder, Schema.Struct({})),

  // Device pane (macOS only; the server refuses these off darwin)
  tagRequestBody(DEVICE_WS_METHODS.list, DeviceListInput),
  tagRequestBody(DEVICE_WS_METHODS.boot, DeviceBootInput),
  tagRequestBody(DEVICE_WS_METHODS.shutdown, DeviceShutdownInput),
  tagRequestBody(DEVICE_WS_METHODS.attach, DeviceAttachInput),
  tagRequestBody(DEVICE_WS_METHODS.detach, DeviceDetachInput),
  tagRequestBody(DEVICE_WS_METHODS.getThreadState, DeviceThreadInput),
  tagRequestBody(DEVICE_WS_METHODS.tap, DeviceTapInput),
  tagRequestBody(DEVICE_WS_METHODS.swipe, DeviceSwipeInput),
  tagRequestBody(DEVICE_WS_METHODS.typeText, DeviceTypeTextInput),
  tagRequestBody(DEVICE_WS_METHODS.keyEvent, DeviceKeyEventInput),
  tagRequestBody(DEVICE_WS_METHODS.pressButton, DevicePressButtonInput),
  tagRequestBody(DEVICE_WS_METHODS.installApp, DeviceInstallAppInput),
  tagRequestBody(DEVICE_WS_METHODS.launchApp, DeviceLaunchAppInput),
  tagRequestBody(DEVICE_WS_METHODS.openUrl, DeviceOpenUrlInput),
  tagRequestBody(DEVICE_WS_METHODS.screenshot, DeviceScreenshotInput),
  tagRequestBody(DEVICE_WS_METHODS.startRecording, DeviceStartRecordingInput),
  tagRequestBody(DEVICE_WS_METHODS.stopRecording, DeviceStopRecordingInput),
  tagRequestBody(DEVICE_WS_METHODS.describeUi, DeviceDescribeUiInput),
  tagRequestBody(DEVICE_WS_METHODS.scrollToElement, DeviceScrollToElementInput),
  tagRequestBody(DEVICE_WS_METHODS.subscribeEvents, Schema.Struct({})),

  // Shell methods
  tagRequestBody(WS_METHODS.shellOpenInEditor, OpenInEditorInput),

  // Git methods
  tagRequestBody(WS_METHODS.gitPull, GitPullInput),
  tagRequestBody(WS_METHODS.gitGithubRepository, GitHubRepositoryInput),
  tagRequestBody(WS_METHODS.gitStatus, GitStatusInput),
  tagRequestBody(WS_METHODS.gitReadWorkingTreeDiff, GitReadWorkingTreeDiffInput),
  tagRequestBody(WS_METHODS.gitBlameLine, GitBlameLineInput),
  tagRequestBody(WS_METHODS.gitReadFileAtRev, GitReadFileAtRevInput),
  tagRequestBody(WS_METHODS.gitWorkingTreeDiffStats, GitReadWorkingTreeDiffInput),
  tagRequestBody(WS_METHODS.gitSummarizeDiff, GitSummarizeDiffInput),
  tagRequestBody(WS_METHODS.gitRunStackedAction, GitRunStackedActionInput),
  tagRequestBody(WS_METHODS.gitListBranches, GitListBranchesInput),
  tagRequestBody(WS_METHODS.gitListRecentCommits, GitListRecentCommitsInput),
  tagRequestBody(WS_METHODS.gitCreateWorktree, GitCreateWorktreeInput),
  tagRequestBody(WS_METHODS.gitCreateDetachedWorktree, GitCreateDetachedWorktreeInput),
  tagRequestBody(WS_METHODS.gitRemoveWorktree, GitRemoveWorktreeInput),
  tagRequestBody(WS_METHODS.gitCreateBranch, GitCreateBranchInput),
  tagRequestBody(WS_METHODS.gitCheckout, GitCheckoutInput),
  tagRequestBody(WS_METHODS.gitStashAndCheckout, GitStashAndCheckoutInput),
  tagRequestBody(WS_METHODS.gitStashDrop, GitStashDropInput),
  tagRequestBody(WS_METHODS.gitStashInfo, GitStashInfoInput),
  tagRequestBody(WS_METHODS.gitRemoveIndexLock, GitRemoveIndexLockInput),
  tagRequestBody(WS_METHODS.gitInit, GitInitInput),
  tagRequestBody(WS_METHODS.gitStageFiles, GitStageFilesInput),
  tagRequestBody(WS_METHODS.gitUnstageFiles, GitUnstageFilesInput),
  tagRequestBody(WS_METHODS.gitHandoffThread, GitHandoffThreadInput),
  tagRequestBody(WS_METHODS.gitResolvePullRequest, GitPullRequestRefInput),
  tagRequestBody(WS_METHODS.gitPullRequestSnapshot, GitPullRequestSnapshotInput),
  tagRequestBody(WS_METHODS.gitPreparePullRequestThread, GitPreparePullRequestThreadInput),

  // Global pull requests
  tagRequestBody(WS_METHODS.pullRequestsDetail, PullRequestDetailInput),
  tagRequestBody(WS_METHODS.pullRequestsDiff, PullRequestDetailInput),
  tagRequestBody(WS_METHODS.pullRequestsAction, PullRequestActionInput),
  tagRequestBody(WS_METHODS.pullRequestsComment, PullRequestCommentInput),
  tagRequestBody(WS_METHODS.pullRequestsSetPinned, PullRequestSetPinnedInput),
  tagRequestBody(WS_METHODS.pullRequestsGetAutoFix, PullRequestAutoFixGetInput),
  tagRequestBody(WS_METHODS.pullRequestsSetAutoFix, PullRequestAutoFixSetInput),

  // GitHub inbox (pull requests and issues)
  tagRequestBody(WS_METHODS.githubInboxList, GitHubInboxListInput),
  tagRequestBody(WS_METHODS.githubInboxIssueDetail, GitHubIssueDetailInput),
  tagRequestBody(WS_METHODS.githubInboxIssueComment, GitHubIssueCommentInput),

  // Terminal methods
  tagRequestBody(WS_METHODS.terminalOpen, TerminalOpenInput),
  tagRequestBody(WS_METHODS.terminalWrite, TerminalWriteInput),
  tagRequestBody(WS_METHODS.terminalAckOutput, TerminalAckOutputInput),
  tagRequestBody(WS_METHODS.terminalResize, TerminalResizeInput),
  tagRequestBody(WS_METHODS.terminalClear, TerminalClearInput),
  tagRequestBody(WS_METHODS.terminalRestart, TerminalRestartInput),
  tagRequestBody(WS_METHODS.terminalClose, TerminalCloseInput),

  // Server meta
  tagRequestBody(WS_METHODS.serverGetRuntimeStatus, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetConfig, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetEnvironment, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverGetSettings, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverWorkspaceImportProbe, WorkspaceImportProbeInput),
  tagRequestBody(WS_METHODS.serverWorkspaceImportApply, WorkspaceImportApplyInput),
  tagRequestBody(WS_METHODS.serverWorkspaceImportSync, WorkspaceImportSyncInput),
  tagRequestBody(WS_METHODS.serverUpdateSettings, ServerUpdateSettingsInput),
  tagRequestBody(WS_METHODS.serverRefreshProviders, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverUpdateProvider, ServerProviderUpdateInput),
  tagRequestBody(WS_METHODS.serverStartProviderLogin, ServerProviderLoginInput),
  tagRequestBody(WS_METHODS.serverCancelProviderLogin, ServerProviderLoginInput),
  tagRequestBody(WS_METHODS.serverListExternalMcpIntegrations, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverCreateExternalMcpIntegration, ExternalMcpCreateIntegrationInput),
  tagRequestBody(WS_METHODS.serverRevokeExternalMcpIntegration, ExternalMcpRevokeIntegrationInput),
  tagRequestBody(WS_METHODS.serverRefreshExternalMcpPairing, ExternalMcpRefreshPairingInput),
  tagRequestBody(WS_METHODS.serverListMcpConnectors, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverConnectMcpConnector, McpConnectorConnectInput),
  tagRequestBody(WS_METHODS.serverDisconnectMcpConnector, McpConnectorDisconnectInput),
  tagRequestBody(WS_METHODS.serverGetMcpConnectorSetup, Schema.Struct({})),
  tagRequestBody(WS_METHODS.mossAppsGetStatus, Schema.Struct({})),
  tagRequestBody(WS_METHODS.mossAppsListToolkits, MossAppsListToolkitsInput),
  tagRequestBody(WS_METHODS.mossAppsListConnections, Schema.Struct({})),
  tagRequestBody(WS_METHODS.mossAppsConnectFields, MossAppsConnectFieldsInput),
  tagRequestBody(WS_METHODS.mossAppsConnect, MossAppsConnectInput),
  tagRequestBody(WS_METHODS.mossAppsDisconnect, MossAppsDisconnectInput),
  tagRequestBody(WS_METHODS.serverListWorktrees, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverListLocalServers, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverStopLocalServer, ServerStopLocalServerInput),
  tagRequestBody(WS_METHODS.serverGetProviderUsageSnapshot, ServerGetProviderUsageSnapshotInput),
  tagRequestBody(WS_METHODS.serverListProviderUsage, ServerListProviderUsageInput),
  tagRequestBody(WS_METHODS.serverConsumeCodexResetCredit, ServerConsumeCodexResetCreditInput),
  tagRequestBody(WS_METHODS.statsGetProfileStats, StatsGetProfileStatsInput),
  tagRequestBody(WS_METHODS.statsGetProfileTokenStats, StatsGetProfileTokenStatsInput),
  tagRequestBody(WS_METHODS.statsGetRecap, StatsGetRecapInput),
  tagRequestBody(WS_METHODS.serverGetDiagnostics, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverReadThreadDiagnostics, ServerReadThreadDiagnosticsInput),
  tagRequestBody(WS_METHODS.serverPrewarmVoice, ServerVoicePrewarmInput),
  tagRequestBody(WS_METHODS.serverTranscribeVoice, ServerVoiceTranscriptionInput),
  tagRequestBody(WS_METHODS.serverGenerateThreadRecap, ServerGenerateThreadRecapInput),
  tagRequestBody(WS_METHODS.serverGenerateAutomationIntent, ServerGenerateAutomationIntentInput),
  tagRequestBody(WS_METHODS.serverUpsertKeybinding, KeybindingRule),
  tagRequestBody(WS_METHODS.serverMossAccountSession, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossAccountSelectRealm, MossAccountSelectRealmInput),
  tagRequestBody(WS_METHODS.serverMossAccountStartPhoneLogin, MossAccountStartPhoneLoginInput),
  tagRequestBody(WS_METHODS.serverMossAccountVerifyPhoneLogin, MossAccountVerifyPhoneLoginInput),
  tagRequestBody(WS_METHODS.serverMossAccountLogout, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossCloudAccountState, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossCloudAccountList, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossCloudAccountSelect, MossCloudSelectAccountInput),
  tagRequestBody(WS_METHODS.serverMossCloudAccountRemove, MossCloudRemoveAccountInput),
  tagRequestBody(WS_METHODS.serverMossCloudAccountSignUp, MossCloudSignUpInput),
  tagRequestBody(WS_METHODS.serverMossCloudAccountSignIn, MossCloudSignInInput),
  tagRequestBody(WS_METHODS.serverMossCloudAccountRefresh, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossCloudAccountStartGoogleOAuth, Schema.Struct({})),
  tagRequestBody(
    WS_METHODS.serverMossCloudAccountExchangeGoogleOAuthCode,
    MossCloudExchangeGoogleOAuthCodeInput,
  ),
  tagRequestBody(
    WS_METHODS.serverMossCloudAccountRequestPasswordReset,
    MossCloudRequestPasswordResetInput,
  ),
  tagRequestBody(WS_METHODS.serverMossCloudAccountExchangeCode, MossCloudExchangeCodeInput),
  tagRequestBody(WS_METHODS.serverMossCloudAccountUpdatePassword, MossCloudUpdatePasswordInput),
  tagRequestBody(WS_METHODS.serverMossCloudAccountLogout, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossEnterpriseKeyState, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossEnterpriseKeySignIn, MossEnterpriseKeySignInInput),
  tagRequestBody(WS_METHODS.serverMossEnterpriseKeyActivate, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossEnterpriseKeySignOut, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossPayCatalog, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossPayQuota, Schema.Struct({})),
  tagRequestBody(WS_METHODS.serverMossPayCreateOrder, MossPayCreateOrderInput),
  tagRequestBody(WS_METHODS.serverMossPayGetOrder, MossPayGetOrderInput),

  // Realtime Voice
  tagRequestBody(WS_METHODS.realtimeVoiceListVoices, RealtimeVoiceListVoicesInput),
  tagRequestBody(WS_METHODS.realtimeVoiceClaim, RealtimeVoiceClaimInput),
  tagRequestBody(WS_METHODS.realtimeVoiceReleaseClaim, RealtimeVoiceReleaseClaimInput),
  tagRequestBody(WS_METHODS.realtimeVoiceStart, RealtimeVoiceStartInput),
  tagRequestBody(WS_METHODS.realtimeVoiceReportClientState, RealtimeVoiceReportClientStateInput),
  tagRequestBody(
    WS_METHODS.realtimeVoiceResolveScreenContext,
    RealtimeVoiceResolveScreenContextInput,
  ),
  tagRequestBody(WS_METHODS.realtimeVoiceAppendText, RealtimeVoiceAppendTextInput),
  tagRequestBody(WS_METHODS.realtimeVoiceAppendSpeech, RealtimeVoiceAppendSpeechInput),
  tagRequestBody(WS_METHODS.realtimeVoiceStop, RealtimeVoiceStopInput),
  tagRequestBody(WS_METHODS.realtimeVoiceGetState, RealtimeVoiceGetStateInput),
  tagRequestBody(WS_METHODS.realtimeVoiceSubscribe, RealtimeVoiceSubscribeInput),
  tagRequestBody(WS_METHODS.serverEditKeybindings, ServerEditKeybindingsInput),

  // Provider discovery
  tagRequestBody(WS_METHODS.providerGetComposerCapabilities, ProviderGetComposerCapabilitiesInput),
  tagRequestBody(WS_METHODS.providerCompactThread, ProviderCompactThreadInput),
  tagRequestBody(WS_METHODS.providerListCommands, ProviderListCommandsInput),
  tagRequestBody(WS_METHODS.providerListSkills, ProviderListSkillsInput),
  tagRequestBody(WS_METHODS.providerReadSkill, ProviderReadSkillInput),
  tagRequestBody(WS_METHODS.providerListSkillsCatalog, ProviderSkillsCatalogInput),
  tagRequestBody(WS_METHODS.providerListPlugins, ProviderListPluginsInput),
  tagRequestBody(WS_METHODS.providerReadPlugin, ProviderReadPluginInput),
  tagRequestBody(WS_METHODS.providerAddMarketplace, ProviderAddMarketplaceInput),
  tagRequestBody(WS_METHODS.providerRemoveMarketplace, ProviderRemoveMarketplaceInput),
  tagRequestBody(WS_METHODS.providerUpgradeMarketplace, ProviderUpgradeMarketplaceInput),
  tagRequestBody(WS_METHODS.providerInstallPlugin, ProviderInstallPluginInput),
  tagRequestBody(WS_METHODS.providerUninstallPlugin, ProviderUninstallPluginInput),
  tagRequestBody(WS_METHODS.providerSetPluginEnabled, ProviderSetPluginEnabledInput),
  tagRequestBody(WS_METHODS.providerListApps, ProviderListAppsInput),
  tagRequestBody(WS_METHODS.providerSetAppEnabled, ProviderSetAppEnabledInput),
  tagRequestBody(WS_METHODS.providerReadAppTools, ProviderReadAppToolsInput),
  tagRequestBody(WS_METHODS.providerReadAppConnector, ProviderReadAppConnectorInput),
  tagRequestBody(WS_METHODS.providerReadAppConnectorTerms, ProviderReadAppConnectorTermsInput),
  tagRequestBody(WS_METHODS.providerStartAppConnection, ProviderStartAppConnectionInput),
  tagRequestBody(WS_METHODS.providerCompleteAppConnection, ProviderCompleteAppConnectionInput),
  tagRequestBody(WS_METHODS.providerListModels, ProviderListModelsInput),
  tagRequestBody(WS_METHODS.providerListAgents, ProviderListAgentsInput),
  tagRequestBody(WS_METHODS.providerListMcp, ProviderListMcpInput),
  tagRequestBody(WS_METHODS.providerCatalogSelection, MossCatalogSelectionInput),
  tagRequestBody(WS_METHODS.providerResourceImportInventory, MossResourceImportInventoryInput),
  tagRequestBody(WS_METHODS.providerResourceImportPlan, MossResourceImportPlanInput),
  tagRequestBody(WS_METHODS.providerResourceImportApply, MossResourceImportApplyInput),
  tagRequestBody(WS_METHODS.providerResourceImportRollback, MossResourceImportRollbackInput),
  tagRequestBody(
    WS_METHODS.providerPrepareMossResourceMutation,
    MossCanonicalResourceMutationPrepareInput,
  ),
  tagRequestBody(WS_METHODS.providerCreateMossResource, MossCreateResourceInput),
  tagRequestBody(WS_METHODS.providerDeleteMossResource, MossDeleteResourceInput),
  tagRequestBody(WS_METHODS.providerUpdateMossResource, MossUpdateResourceInput),
  tagRequestBody(WS_METHODS.providerListSessions, Schema.Struct({})),
  tagRequestBody(WS_METHODS.providerGetLaunchPlan, ProviderGetLaunchPlanInput),
  tagRequestBody(
    WS_METHODS.providerGetLoopLedgerDashboardSnapshot,
    ProviderGetLoopLedgerDashboardSnapshotInput,
  ),
  tagRequestBody(WS_METHODS.providerSubmitPermissionAction, ProviderSubmitPermissionActionInput),
  tagRequestBody(
    WS_METHODS.providerSubscribeNormalizedSessionEvents,
    MossSubscribeNormalizedSessionEventsInput,
  ),

  // Automation methods
  tagRequestBody(WS_METHODS.automationList, AutomationListInput),
  tagRequestBody(WS_METHODS.automationGetMemory, AutomationGetMemoryInput),
  tagRequestBody(WS_METHODS.automationCreate, AutomationCreateInput),
  tagRequestBody(WS_METHODS.automationUpdate, AutomationUpdateInput),
  tagRequestBody(WS_METHODS.automationDelete, AutomationDeleteInput),
  tagRequestBody(WS_METHODS.automationRunNow, AutomationRunNowInput),
  tagRequestBody(WS_METHODS.automationCancelRun, AutomationCancelRunInput),
  tagRequestBody(WS_METHODS.automationMarkRunRead, AutomationMarkRunReadInput),
  tagRequestBody(WS_METHODS.automationArchiveRun, AutomationArchiveRunInput),
  tagRequestBody(WS_METHODS.automationResolveProposal, AutomationResolveProposalInput),
  tagRequestBody(WS_METHODS.subscribeAutomationEvents, Schema.Struct({})),

  // Computer History
  tagRequestBody(WS_METHODS.computerHistoryGetState, ComputerHistoryGetStateInput),
  tagRequestBody(WS_METHODS.computerHistoryGetSettings, ComputerHistoryGetSettingsInput),
  tagRequestBody(WS_METHODS.computerHistoryUpdateSettings, ComputerHistoryUpdateSettingsInput),
  tagRequestBody(WS_METHODS.computerHistoryListApplications, Schema.Struct({})),
  tagRequestBody(
    WS_METHODS.computerHistoryResolveApplications,
    ComputerHistoryResolveApplicationsInput,
  ),
  tagRequestBody(WS_METHODS.computerHistorySetEnabled, ComputerHistorySetEnabledInput),
  tagRequestBody(WS_METHODS.computerHistoryRetryActivation, Schema.Struct({})),
  tagRequestBody(WS_METHODS.computerHistoryPause, Schema.Struct({})),
  tagRequestBody(WS_METHODS.computerHistoryResume, Schema.Struct({})),
  tagRequestBody(WS_METHODS.computerHistoryListHistory, ComputerHistoryListHistoryInput),
  tagRequestBody(WS_METHODS.computerHistoryListSuggestions, ComputerHistoryListSuggestionsInput),
  tagRequestBody(
    WS_METHODS.computerHistoryListSummaryIntervals,
    ComputerHistoryListSummaryIntervalsInput,
  ),
  tagRequestBody(WS_METHODS.computerHistoryRevealInFinder, ComputerHistoryRevealInFinderInput),
  tagRequestBody(WS_METHODS.computerHistoryClearHistory, ComputerHistoryClearHistoryInput),

  tagRequestBody(WS_METHODS.computerGetStatus, Schema.Struct({})),
  tagRequestBody(WS_METHODS.computerProvision, ComputerProvisionInput),
  tagRequestBody(WS_METHODS.computerGetState, ComputerGetStateInput),
  tagRequestBody(WS_METHODS.computerSetControlEnabled, ComputerSetControlEnabledInput),
  tagRequestBody(
    WS_METHODS.computerPerformAction,
    Schema.Struct({
      action: TrimmedNonEmptyString,
      x: Schema.optional(Schema.Number),
      y: Schema.optional(Schema.Number),
      text: Schema.optional(Schema.String),
      key: Schema.optional(Schema.String),
      button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
      clickCount: Schema.optional(Schema.Number),
    }),
  ),

  // Todo methods
  tagRequestBody(WS_METHODS.todoList, Schema.Struct({})),
  tagRequestBody(WS_METHODS.todoCreate, TodoCreateInput),
  tagRequestBody(WS_METHODS.todoUpdate, TodoUpdateInput),
  tagRequestBody(WS_METHODS.todoDelete, TodoDeleteInput),
  tagRequestBody(WS_METHODS.subscribeTodoEvents, Schema.Struct({})),

  tagRequestBody(WS_METHODS.pagesSpaces, PagesScopeInput),
  tagRequestBody(WS_METHODS.pagesList, PagesListInput),
  tagRequestBody(WS_METHODS.pagesRead, PagesReadInput),
  tagRequestBody(WS_METHODS.pagesVersions, PagesVersionsInput),
  tagRequestBody(WS_METHODS.pagesComments, PagesCommentsInput),
  PagesMutateInput.mapMembers(
    Tuple.map(Schema.fieldsAssign({ _tag: Schema.tag(WS_METHODS.pagesMutate) })),
  ),

  // Library methods
  tagRequestBody(WS_METHODS.libraryList, LibraryListInput),
  tagRequestBody(WS_METHODS.librarySync, Schema.Struct({})),
  tagRequestBody(WS_METHODS.libraryFavorite, LibraryFavoriteInput),
  tagRequestBody(WS_METHODS.libraryMove, LibraryMoveInput),
  tagRequestBody(WS_METHODS.libraryRename, LibraryRenameInput),
  tagRequestBody(WS_METHODS.libraryTrash, LibraryTrashInput),
  tagRequestBody(WS_METHODS.libraryRestore, LibraryRestoreInput),
  tagRequestBody(WS_METHODS.libraryDelete, LibraryDeleteInput),
  tagRequestBody(WS_METHODS.libraryCreateFolder, LibraryCreateFolderInput),
  tagRequestBody(WS_METHODS.libraryRenameFolder, LibraryRenameFolderInput),
  tagRequestBody(WS_METHODS.libraryDeleteFolder, LibraryDeleteFolderInput),
  tagRequestBody(WS_METHODS.libraryRegister, LibraryRegisterInput),
  tagRequestBody(WS_METHODS.libraryImport, LibraryImportInput),
  tagRequestBody(WS_METHODS.projectAgentGetOverview, ProjectAgentGetOverviewInput),
  tagRequestBody(WS_METHODS.projectAgentListSummaries, ProjectAgentListSummariesInput),
  tagRequestBody(WS_METHODS.projectAgentConfigure, ProjectAgentConfigureInput),
  tagRequestBody(WS_METHODS.projectAgentLinkProject, ProjectAgentLinkProjectInput),
  tagRequestBody(WS_METHODS.projectAgentUnlinkProject, ProjectAgentUnlinkProjectInput),
  tagRequestBody(WS_METHODS.projectAgentStartGoal, ProjectAgentStartGoalInput),
  tagRequestBody(WS_METHODS.projectAgentUpdateGoal, ProjectAgentUpdateGoalInput),
  tagRequestBody(WS_METHODS.projectAgentPauseGoal, ProjectAgentGoalControlInput),
  tagRequestBody(WS_METHODS.projectAgentResumeGoal, ProjectAgentGoalControlInput),
  tagRequestBody(WS_METHODS.projectAgentStopGoal, ProjectAgentGoalControlInput),
  tagRequestBody(WS_METHODS.projectAgentListTasks, ProjectAgentListTasksInput),
  tagRequestBody(WS_METHODS.projectAgentUpdateTask, ProjectAgentUpdateTaskInput),
  tagRequestBody(WS_METHODS.projectAgentCreateTask, ProjectAgentCreateTaskInput),
  tagRequestBody(WS_METHODS.projectAgentListEvidence, ProjectAgentListEvidenceInput),
  tagRequestBody(WS_METHODS.projectAgentListThreadIndex, ProjectAgentListThreadIndexInput),
  tagRequestBody(WS_METHODS.projectAgentExcludeThread, ProjectAgentExcludeThreadInput),
  tagRequestBody(WS_METHODS.projectAgentBackfillSummaries, ProjectAgentBackfillInput),
  tagRequestBody(WS_METHODS.projectAgentListActivity, ProjectAgentListActivityInput),
  tagRequestBody(WS_METHODS.projectAgentListDocuments, ProjectAgentListDocumentsInput),
  tagRequestBody(WS_METHODS.projectAgentReadDocument, ProjectAgentReadDocumentInput),
  tagRequestBody(WS_METHODS.projectAgentWriteDocument, ProjectAgentWriteDocumentInput),
  tagRequestBody(WS_METHODS.projectAgentExportDocuments, ProjectAgentExportDocumentsInput),
  tagRequestBody(WS_METHODS.projectAgentRefreshDigest, ProjectAgentRefreshDigestInput),
  tagRequestBody(WS_METHODS.projectAgentPauseGroup, ProjectAgentGroupControlInput),
  tagRequestBody(WS_METHODS.projectAgentResumeGroup, ProjectAgentGroupControlInput),
  tagRequestBody(WS_METHODS.projectAgentArchiveGroup, ProjectAgentGroupControlInput),
  tagRequestBody(WS_METHODS.projectAgentUnarchiveGroup, ProjectAgentGroupControlInput),
  tagRequestBody(WS_METHODS.projectAgentRestartCoordinator, ProjectAgentGroupControlInput),
  tagRequestBody(WS_METHODS.projectAgentDeleteGroup, ProjectAgentDeleteGroupInput),
  tagRequestBody(WS_METHODS.projectAgentLibraryList, ProjectAgentLibraryListInput),
  tagRequestBody(WS_METHODS.projectAgentLibraryMkdir, ProjectAgentLibraryMkdirInput),
  tagRequestBody(WS_METHODS.projectAgentLibraryRename, ProjectAgentLibraryRenameInput),
  tagRequestBody(WS_METHODS.projectAgentLibraryDelete, ProjectAgentLibraryDeleteInput),
  tagRequestBody(WS_METHODS.projectAgentLibraryHistory, ProjectAgentLibraryHistoryInput),
  tagRequestBody(WS_METHODS.projectAgentLibraryRestore, ProjectAgentLibraryRestoreInput),
  tagRequestBody(WS_METHODS.projectAgentLibraryStatus, ProjectAgentLibraryStatusInput),
  tagRequestBody(WS_METHODS.projectAgentResolveWorker, ProjectAgentResolveWorkerInput),
  tagRequestBody(WS_METHODS.subscribeProjectAgentEvents, ProjectAgentSubscribeInput),
]);

export const WebSocketRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: WebSocketRequestBody,
});
export type WebSocketRequest = typeof WebSocketRequest.Type;

export const WebSocketResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type WebSocketResponse = typeof WebSocketResponse.Type;

export const WsPushSequence = NonNegativeInt;
export type WsPushSequence = typeof WsPushSequence.Type;

export const WsWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  homeDir: Schema.optional(TrimmedNonEmptyString),
  chatWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  studioWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  groupsWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type WsWelcomePayload = typeof WsWelcomePayload.Type;

export interface WsPushPayloadByChannel {
  readonly [WS_CHANNELS.serverWelcome]: WsWelcomePayload;
  readonly [WS_CHANNELS.serverMaintenanceUpdated]: ServerLifecycleStreamEvent;
  readonly [WS_CHANNELS.serverConfigUpdated]: typeof ServerConfigUpdatedPayload.Type;
  readonly [WS_CHANNELS.serverProviderStatusesUpdated]: typeof ServerProviderStatusesUpdatedPayload.Type;
  readonly [WS_CHANNELS.serverKeepAwakeUpdated]: typeof ServerKeepAwakeUpdatedPayload.Type;
  readonly [WS_CHANNELS.serverSettingsUpdated]: typeof ServerSettingsUpdatedPayload.Type;
  readonly [WS_CHANNELS.automationEvent]: typeof AutomationStreamEvent.Type;
  readonly [WS_CHANNELS.todoEvent]: typeof TodoStreamEvent.Type;
  readonly [WS_CHANNELS.projectAgentEvent]: typeof ProjectAgentStreamEvent.Type;
  readonly [WS_CHANNELS.gitActionProgress]: typeof GitActionProgressEvent.Type;
  readonly [WS_CHANNELS.gitWorktreeSetupProgress]: typeof GitWorktreeSetupProgressEvent.Type;
  readonly [WS_CHANNELS.projectProvisionProgress]: typeof GitHubProjectProvisionProgressEvent.Type;
  readonly [WS_CHANNELS.terminalEvent]: typeof TerminalEvent.Type;
  readonly [WS_CHANNELS.projectDevServerEvent]: typeof ProjectDevServerEvent.Type;
  readonly [DEVICE_WS_CHANNELS.event]: typeof DeviceEvent.Type;
  readonly [COMPUTER_WS_CHANNELS.event]: typeof ComputerEvent.Type;
  readonly [ORCHESTRATION_WS_CHANNELS.domainEvent]: OrchestrationEvent;
  readonly [ORCHESTRATION_WS_CHANNELS.shellEvent]: OrchestrationShellStreamItem;
  readonly [ORCHESTRATION_WS_CHANNELS.threadEvent]: OrchestrationThreadStreamItem;
}

export type WsPushChannel = keyof WsPushPayloadByChannel;
export type WsPushData<C extends WsPushChannel> = WsPushPayloadByChannel[C];

const makeWsPushSchema = <const Channel extends string, Payload extends Schema.Schema<any>>(
  channel: Channel,
  payload: Payload,
) =>
  Schema.Struct({
    type: Schema.Literal("push"),
    sequence: WsPushSequence,
    channel: Schema.Literal(channel),
    data: payload,
  });

export const WsPushServerWelcome = makeWsPushSchema(WS_CHANNELS.serverWelcome, WsWelcomePayload);
export const WsPushServerMaintenanceUpdated = makeWsPushSchema(
  WS_CHANNELS.serverMaintenanceUpdated,
  ServerLifecycleStreamEvent,
);
export const WsPushServerConfigUpdated = makeWsPushSchema(
  WS_CHANNELS.serverConfigUpdated,
  ServerConfigUpdatedPayload,
);
export const WsPushServerProviderStatusesUpdated = makeWsPushSchema(
  WS_CHANNELS.serverProviderStatusesUpdated,
  ServerProviderStatusesUpdatedPayload,
);
export const WsPushServerSettingsUpdated = makeWsPushSchema(
  WS_CHANNELS.serverSettingsUpdated,
  ServerSettingsUpdatedPayload,
);
export const WsPushServerKeepAwakeUpdated = makeWsPushSchema(
  WS_CHANNELS.serverKeepAwakeUpdated,
  ServerKeepAwakeUpdatedPayload,
);
export const WsPushAutomationEvent = makeWsPushSchema(
  WS_CHANNELS.automationEvent,
  AutomationStreamEvent,
);
export const WsPushTodoEvent = makeWsPushSchema(WS_CHANNELS.todoEvent, TodoStreamEvent);
export const WsPushProjectAgentEvent = makeWsPushSchema(
  WS_CHANNELS.projectAgentEvent,
  ProjectAgentStreamEvent,
);
export const WsPushGitActionProgress = makeWsPushSchema(
  WS_CHANNELS.gitActionProgress,
  GitActionProgressEvent,
);
export const WsPushGitWorktreeSetupProgress = makeWsPushSchema(
  WS_CHANNELS.gitWorktreeSetupProgress,
  GitWorktreeSetupProgressEvent,
);
export const WsPushProjectProvisionProgress = makeWsPushSchema(
  WS_CHANNELS.projectProvisionProgress,
  GitHubProjectProvisionProgressEvent,
);
export const WsPushTerminalEvent = makeWsPushSchema(WS_CHANNELS.terminalEvent, TerminalEvent);
export const WsPushProjectDevServerEvent = makeWsPushSchema(
  WS_CHANNELS.projectDevServerEvent,
  ProjectDevServerEvent,
);
export const WsPushDeviceEvent = makeWsPushSchema(DEVICE_WS_CHANNELS.event, DeviceEvent);
export const WsPushComputerEvent = makeWsPushSchema(COMPUTER_WS_CHANNELS.event, ComputerEvent);
export const WsPushOrchestrationDomainEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  OrchestrationEvent,
);
export const WsPushOrchestrationShellEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.shellEvent,
  OrchestrationShellStreamItem,
);
export const WsPushOrchestrationThreadEvent = makeWsPushSchema(
  ORCHESTRATION_WS_CHANNELS.threadEvent,
  OrchestrationThreadStreamItem,
);

export const WsPushChannelSchema = Schema.Literals([
  WS_CHANNELS.gitActionProgress,
  WS_CHANNELS.gitWorktreeSetupProgress,
  WS_CHANNELS.projectProvisionProgress,
  WS_CHANNELS.serverWelcome,
  WS_CHANNELS.serverMaintenanceUpdated,
  WS_CHANNELS.serverConfigUpdated,
  WS_CHANNELS.serverProviderStatusesUpdated,
  WS_CHANNELS.serverKeepAwakeUpdated,
  WS_CHANNELS.serverSettingsUpdated,
  WS_CHANNELS.automationEvent,
  WS_CHANNELS.todoEvent,
  WS_CHANNELS.projectAgentEvent,
  WS_CHANNELS.terminalEvent,
  WS_CHANNELS.projectDevServerEvent,
  DEVICE_WS_CHANNELS.event,
  COMPUTER_WS_CHANNELS.event,
  ORCHESTRATION_WS_CHANNELS.domainEvent,
  ORCHESTRATION_WS_CHANNELS.shellEvent,
  ORCHESTRATION_WS_CHANNELS.threadEvent,
]);
export type WsPushChannelSchema = typeof WsPushChannelSchema.Type;

export const WsPush = Schema.Union([
  WsPushServerWelcome,
  WsPushServerMaintenanceUpdated,
  WsPushServerConfigUpdated,
  WsPushServerProviderStatusesUpdated,
  WsPushServerKeepAwakeUpdated,
  WsPushServerSettingsUpdated,
  WsPushAutomationEvent,
  WsPushTodoEvent,
  WsPushProjectAgentEvent,
  WsPushGitActionProgress,
  WsPushGitWorktreeSetupProgress,
  WsPushProjectProvisionProgress,
  WsPushTerminalEvent,
  WsPushProjectDevServerEvent,
  WsPushDeviceEvent,
  WsPushComputerEvent,
  WsPushOrchestrationDomainEvent,
  WsPushOrchestrationShellEvent,
  WsPushOrchestrationThreadEvent,
]);
export type WsPush = typeof WsPush.Type;

export type WsPushMessage<C extends WsPushChannel> = Extract<WsPush, { channel: C }>;

export const WsPushEnvelopeBase = Schema.Struct({
  type: Schema.Literal("push"),
  sequence: WsPushSequence,
  channel: WsPushChannelSchema,
  data: Schema.Unknown,
});
export type WsPushEnvelopeBase = typeof WsPushEnvelopeBase.Type;

// ── Union of all server → client messages ─────────────────────────────

export const WsResponse = Schema.Union([WebSocketResponse, WsPush]);
export type WsResponse = typeof WsResponse.Type;
