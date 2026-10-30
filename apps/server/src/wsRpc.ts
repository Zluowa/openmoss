import { predictNextMessage } from "./git/nextMessagePrediction";
import { readEventLoopStatus } from "./eventLoopMonitor";
import { listMossMediaLibrary } from "./mossMediaLibrary";
import { makeGitActionRunner } from "./git/gitActionRunner";
import { AgentGatewaySessionRegistry } from "./agentGateway/Services/AgentGatewaySessionRegistry";
import { execFile } from "node:child_process";

import {
  CommandId,
  COMPUTER_WS_METHODS,
  TASKS_UNAVAILABLE_ERROR_CODE,
  DEFAULT_TERMINAL_ID,
  GUEST_SHARE_WS_METHODS,
  DEVICE_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  ORCHESTRATION_STREAM_OVERFLOW_CODE,
  ThreadId,
  WS_BOOTSTRAP_METHOD,
  WS_BOOTSTRAP_PATH,
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_METHODS,
  WsBootstrapRpcGroup,
  WsCompatibilityError,
  WsComputerRpcGroup,
  WsDeviceRpcGroup,
  WsFeatureRpcGroup,
  WsProjectAgentRpcGroup,
  WsLibraryRpcGroup,
  WsPagesRpcGroup,
  PagesRpcError,
  WsRpcError,
  SidebarOrderRevision,
  PullRequestsUnavailableError,
  type DeviceEvent,
  type ComputerEvent,
  type GitRemoveWorktreeInput,
  type GitHubProjectProvisionProgressEvent,
  type GitWorktreeSetupProgressEvent,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProject,
  type ProjectDevServerEvent,
  type ProviderStartOptions,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type ProjectId,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ServerConfigStreamEvent,
  type ServerDiagnosticsResult,
  type ServerLifecycleStreamEvent,
  type ServerSettings,
  type ServerSettingsPatch,
  type MossCreateResourceInput,
  type MossCreateResourceResult,
  type MossDeleteResourceInput,
  type MossDeleteResourceResult,
  type MossUpdateResourceInput,
  type MossUpdateResourceResult,
  type MossCanonicalResourceMutationPlanResult,
  type MossResourceImportApplyInput,
  type MossResourceImportApplyResult,
  type MossResourceImportRollbackInput,
  type MossResourceImportRollbackResult,
  type MossOwnershipStore,
  type MossFilesystemCapability,
  type ProviderSubmitPermissionActionInput,
  type MossAccountSelectRealmInput,
  type MossAccountStartPhoneLoginInput,
  type MossAccountVerifyPhoneLoginInput,
  type MossCloudSelectAccountInput,
  type MossCloudRemoveAccountInput,
  type MossCloudSignUpInput,
  type MossCloudSignInInput,
  type MossCloudExchangeGoogleOAuthCodeInput,
  type MossCloudRequestPasswordResetInput,
  type MossCloudExchangeCodeInput,
  type MossCloudUpdatePasswordInput,
  type MossEnterpriseKeySignInInput,
  type MossPayCreateOrderInput,
  type MossPayGetOrderInput,
  type RealtimeVoiceClaimInput,
  type RealtimeVoiceReleaseClaimInput,
  type RealtimeVoiceStartInput,
  type RealtimeVoiceReportClientStateInput,
  type RealtimeVoiceResolveScreenContextInput,
  type RealtimeVoiceAppendTextInput,
  type RealtimeVoiceAppendSpeechInput,
  type RealtimeVoiceStopInput,
  SECRET_REQUEST_ERROR_CODES,
} from "@synara/contracts";
import { clamp } from "effect/Number";
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  Rpc,
  RpcGroup,
  RpcMiddleware,
  RpcSchema,
  RpcSerialization,
  RpcServer,
} from "effect/unstable/rpc";

import { AutomationService } from "./automation/Services/AutomationService";
import { AutomationServiceError } from "./automation/Errors";
import { TodoService } from "./todo/Services/TodoService";
import { SecretRequests } from "./secretRequests/Services/SecretRequests";
import { GuestShareOwnerError } from "./guestShare/Errors";
import { GuestShareService } from "./guestShare/Services/GuestShareService";
import { LibraryServiceError } from "./library/Errors";
import { LibraryService } from "./library/Services/LibraryService";
import {
  LOCAL_PAGES_PRINCIPAL,
  PagesService,
  PagesServiceError,
  type PagesServiceShape,
} from "./pages/Services/PagesService";
import { isServerBetaFeatureEnabled } from "./betaFeatureGate";
import { readInlineVisual } from "./inlineVisualStore";
import { INLINE_VISUALS_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { ProjectAgentService } from "./projectAgent/Services/ProjectAgentService";
import { isGroupCoordinatorHostProject } from "./projectAgent/groupCoordinatorHost";
import {
  GROUPS_BETA_ONLY_MESSAGE,
  isGroupProjectCommand,
  isServerGroupsEnabled,
} from "./projectAgent/groupsBetaGate";
import {
  assertLibraryRootLocation,
  createLibraryDirectory,
  deleteLibraryEntry,
  ensureLibraryRepo,
  listLibraryEntries,
  normalizeLibraryRelativePath,
  renameLibraryEntry,
  resolveLibraryRoot,
} from "./projectAgent/libraryStore";
import {
  commitLibraryChange,
  libraryHistory,
  pushLibraryIfConfigured,
  readLibraryPushStatus,
  restoreLibraryEntry,
  withLibraryQueue,
  withLibraryRootLock,
} from "./projectAgent/libraryGit";
import { ProjectAgentRepository } from "./persistence/Services/ProjectAgentRepository";
import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import {
  ServerAuth,
  type AuthError,
  type AuthRequest,
  type AuthenticatedSession,
  type ServerAuthShape,
} from "./auth/Services/ServerAuth";
import { SessionCredentialService } from "./auth/Services/SessionCredentialService";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { resolveThreadWorkspaceCwd } from "./checkpointing/Utils";
import { ServerConfig, type ServerConfigShape } from "./config";
import { realpathNearestExisting } from "./realpathNearestExisting";
import { pickFolderNativeDialog } from "./systemDialogs";
import { isGroupContainerKind } from "@synara/shared/projectContainers";
import { PROJECT_FOLDERS_WORKTREE_ISSUE } from "@synara/shared/projectFolders";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { WORKSPACE_FILE_WRITE_CONFLICT_CODE } from "@synara/shared/workspaceFileWrite";
import { makeKeyedSingleFlightCache } from "@synara/shared/KeyedSingleFlightCache";
import { NEXT_MESSAGE_PREDICTION_CODEX_REASONING_EFFORT } from "@synara/shared/nextMessagePrediction";
import {
  mergeProviderStartOptions,
  providerStartOptionsFromInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import {
  isThreadDetailEventFor,
  THREAD_DETAIL_EVENT_TYPES,
} from "@synara/shared/threadDetailEvents";
import { listStudioThreadOutputs } from "./studioOutputs";
import {
  ensureStudioWorkspaceInstructionsFiles,
  STUDIO_WORKSPACE_SUBDIRECTORIES,
} from "./studioWorkspaceScaffold";
import { ensureGroupWorkspaceInstructionsFiles } from "./groupWorkspaceScaffold";
import { DevServerManager, findProjectDevServerForLocalServer } from "./devServerManager";
import { DeviceService } from "./device/Services/DeviceService";
import { makeWsDeviceHandlers } from "./device/wsDeviceHandlers";
import { makeDeviceFrameRouteLayer } from "./device/deviceFrameRoute";
import { ComputerService } from "./computer/Services/ComputerService";
import { makeWsComputerHandlers } from "./computer/wsComputerHandlers";
import { makeComputerFrameRouteLayer } from "./computer/computerFrameRoute";
import { ComputerEventInterests } from "./computer/computerEventInterests";
import { GitCore } from "./git/Services/GitCore";
import { GitHubCli } from "./git/Services/GitHubCli";
import { GitManager } from "./git/Services/GitManager";
import { GitHubCliError } from "./git/Errors";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster";
import { TextGeneration } from "./git/Services/TextGeneration";
import {
  beginGitHandoff,
  completeGitHandoff,
  discardPendingGitHandoff,
  gitHandoffMetadataCommand,
  recordGitHandoffResult,
} from "./gitHandoffOperations";
import { DEFAULT_RESOLVED_KEYBINDINGS, Keybindings } from "./keybindings";
import { createLocalPreviewGrant } from "./localImageFiles";
import { listLocalServers, stopLocalServer } from "./localServerMonitor";
import {
  archivedWorktreeHasNoOtherOwners,
  discardEmptyManagedWorktreeParent,
  discardManagedWorktreeResidue,
  isManagedWorktreePathCanonical,
  listManagedWorktrees,
  managedWorktreeSnapshotsDir,
  pruneProjectedArchivedManagedWorktrees,
} from "./managedWorktrees";
import {
  attachmentPrincipalForSession,
  CurrentManagedAttachmentPrincipal,
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
  type ManagedAttachmentPrincipal,
} from "./managedAttachmentPrincipal";
import { Open, resolveAvailableEditors } from "./open";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "./orchestration/Errors";
import { makeDispatchCommandNormalizer } from "./orchestration/dispatchCommandNormalization";
import { sanitizeOrchestrationEventProviderOptions } from "./orchestration/providerOptionsSecurity";
import { prepareQuitResume } from "./orchestration/quitResume";
import { makeImportThreadHandler } from "./orchestration/importThreadRoute";
import { makeProjectImportHandlers } from "./orchestration/projectImportRoute";
import { makeProjectImportRepository } from "./persistence/projectImportRepository";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor";
import { SidechatExpiryReactor } from "./orchestration/Services/SidechatExpiryReactor";
import { ProjectionStateIncompleteError } from "./persistence/Errors";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery";
import { shouldPublishThreadShellForEvent } from "./orchestration/threadShellEvents";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import {
  discoverSkillsCatalog,
  mossSkillsDir,
  readRegisteredSkillContent,
} from "./provider/skillsCatalog";
import { recoverUnregisteredGitHubCheckout } from "./project/githubProjectRegistration";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { consumeCodexResetCreditEffect, listProviderUsage } from "./providerUsage";
import { getProviderUsageSnapshot } from "./providerUsageSnapshot";
import { ProfileStatsQuery } from "./profileStats";
import { RecapStatsQuery } from "./recapStats";
import { ThreadSearchQuery } from "./threadSearch";
import { redactSensitiveProcessArgs } from "./processArgumentRedaction";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { ExternalMcpService } from "./externalMcp/Services/ExternalMcpService";
import { type McpConnectorError, McpConnectors } from "./mcpConnectors/Services/McpConnectors";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup";
import { KeepAwakeService } from "./keepAwake";
import {
  ServerSettingsService,
  toServerSettingsView,
  type ServerSettingsShape,
} from "./serverSettings";
import { protectReservedSettingsPatch } from "./reservedSettingsBoundary";
import { isLoopbackHost } from "./startupAccess";
import { TerminalManager } from "./terminal/Services/Manager";
import { TerminalThreadTitleTracker } from "./terminal/terminalThreadTitleTracker";
import { resolveOutOfRootFileReference } from "./workspace/outOfRootFileReference";
import { watchWorkspaceFile } from "./workspaceFileChanges";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import {
  WorkspaceFileConflictError,
  WorkspaceFileDeletedError,
  WorkspaceFileSystem,
} from "./workspace/Services/WorkspaceFileSystem";
import {
  MAX_STREAMS_PER_RPC_CLIENT,
  MAX_THREAD_STREAMS_PER_RPC_CLIENT,
  makeWsStreamAdmission,
} from "./wsStreamAdmission";
import { ThreadDiagnosticsQuery } from "./diagnostics/Services/ThreadDiagnosticsQuery";
import { makeOwnerThreadDiagnosticReader } from "./diagnostics/ownerThreadDiagnostics";
import { OrchestrationEventStore } from "./persistence/Services/OrchestrationEventStore";
import { ProviderRuntimeEventRepository } from "./persistence/Services/ProviderRuntimeEvents";
import { requireWsOwnerSession } from "./wsOwnerAuthorization";
import { makeWsRequestAdmission } from "./wsRequestAdmission";
import { voiceUploadAdmissionGate } from "./voiceUploadAdmission";
import {
  CurrentWsSessionRole,
  provideWsConnectionSession,
  WS_CONNECTION_SESSION_HEADER,
  WsConnectionSessions,
  WsConnectionSessionsLive,
  type WsConnectionSession,
} from "./wsConnectionSessions";
import {
  negotiateWsCompatibility,
  parseWsNegotiateSearchParams,
  validateWsFeatureCompatibility,
} from "./wsCompatibility";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  requiresWebSocketAuthentication,
  shouldRejectUntrustedRequestOrigin,
} from "./trustedOrigins";
import { bufferLiveUiStream, type LiveUiStreamDropReport } from "./wsStreamBackpressure";
import {
  makeCursorSafeSnapshotLiveStream,
  makeResnapshotEscalationTracker,
} from "./wsSnapshotLiveStream";
import { PullRequestService } from "./pullRequests/Services/PullRequestService";
import { PullRequestAutoFixService } from "./pullRequestAutoFix/Services/PullRequestAutoFixService";
import {
  GitHubInboxRateLimitedError,
  GitHubInboxService,
} from "./githubInbox/Services/GitHubInboxService";
import { resolveGitHubRepository } from "./pullRequests/repositoryResolution";
import {
  GitHubProjectProvisioningError,
  makeGitHubProjectProvisioner,
} from "./project/githubProjectProvisioning";
import * as nodePath from "node:path";
import {
  MossEnterpriseKeyAccount,
  type MossEnterpriseKeyAccountShape,
  MossEnterpriseKeyError,
} from "./account/Services/MossEnterpriseKeyAccount";
import {
  MossCloudAccountService,
  type MossCloudAccountServiceShape,
} from "./account/Services/MossCloudAccountService";
import {
  MossPhoneAccountService,
  type MossPhoneAccountServiceShape,
} from "./account/Services/MossPhoneAccountService";
import { MossPayService, type MossPayServiceShape } from "./account/Services/MossPayService";
import { MossCloudAccountServiceError } from "./account/mossCloudAccountErrors";
import { MossPayError } from "./account/mossPayGateway";
import {
  RealtimeVoiceService,
  type RealtimeVoiceServiceShape,
} from "./realtimeVoice/Services/RealtimeVoiceService";
import {
  resolveAdmittedVoicePrewarmProviderRoute,
  resolveAdmittedVoiceTranscriptionProviderRoute,
  VoiceAccountAdmissionError,
  VoiceTranscriptionExecutionError,
  VoiceTranscriptionProviderRouteError,
} from "./voiceTranscriptionGateway";
import {
  applyMossResourceImport,
  inventoryMossResourceImport,
  MossResourceImportError,
  planMossResourceImport,
  rollbackMossResourceImport,
} from "./provider/mossResourceImport";
import {
  makeMossCatalogSelectionRpc,
  MossCatalogSelectionRpcError,
} from "./provider/mossCatalogSelectionRpc";
import { RealtimeVoiceRuntimeError } from "./realtimeVoice/runtime";
import { browseMossMarketplace } from "./provider/mossMarketplaceAggregation";
import { makeWorkspaceImportWsHandlers } from "./workspaceImport/wsHandlers";
import { validateCanonicalResourcePathHint } from "./provider/mossCanonicalResourcePath";
import { issueMossCanonicalMutationPlan } from "./provider/mossCanonicalMutationIntent";
import { makeMossWorkspaceRegistry } from "./mossWorkspaceRegistry";
import { makeMossCanonicalResourceMutationService } from "./provider/mossCanonicalResourceMutationService";
import {
  CurrentMossProjectionAuthorityContext,
  type MossProjectionAuthorityFactory,
  MossProjectionAuthorityFactoryService,
  type MossProjectionAuthorityHandle,
} from "./provider/mossProjectionAuthorityFactory";
import {
  getProcessComputerHistoryService,
  resolveProcessComputerHistoryKeychainNamespace,
  resolveProcessComputerHistoryRoot,
} from "./computerHistory/shared";

export function canManageExternalMcp(role: "owner" | "client"): boolean {
  return role === "owner";
}

export const ownerRoleRequired = Effect.gen(function* () {
  if ((yield* CurrentWsSessionRole) !== "owner") {
    return yield* Effect.fail(
      new WsRpcError({
        message: "Owner authorization is required for this operation.",
        code: "OWNER_REQUIRED",
        retryable: false,
      }),
    );
  }
});

/** Lazily guards a unary host-global RPC; useful for focused authorization tests. */
export const ownerOnlyWsRpcHandler =
  (
    handler: (input: unknown, options: unknown) => Effect.Effect<unknown, unknown, never>,
    guard: Effect.Effect<void, WsRpcError, never> = ownerRoleRequired,
  ) =>
  (input: unknown, options: unknown) =>
    guard.pipe(Effect.andThen(Effect.suspend(() => handler(input, options))));

export const MOSS_RESOURCE_IMPORT_STATE_DIR_NAME = "resource-import";
export const MOSS_RESOURCE_IMPORT_ISSUER = "moss-server";

export function resolveMossResourceImportServerBinding(authenticatedSessionId: string): {
  readonly issuer: string;
  readonly sessionId: string;
} {
  const sessionId = authenticatedSessionId.trim();
  if (!sessionId) {
    throw new WsRpcError({
      message: "An authenticated connection session is required for resource import.",
      code: "authorization-required",
    });
  }
  return { issuer: MOSS_RESOURCE_IMPORT_ISSUER, sessionId };
}

export function resolveMossResourceImportStateDir(
  config: Pick<ServerConfigShape, "stateDir">,
): string {
  const stateDir = config.stateDir?.trim();
  if (!stateDir) {
    throw new WsRpcError({
      message: "A prepared server state directory is required for resource import.",
      code: "authorization-required",
    });
  }
  return nodePath.join(nodePath.resolve(stateDir), MOSS_RESOURCE_IMPORT_STATE_DIR_NAME);
}

function resolveMossResourceImportStateDirEffect(
  config: Pick<ServerConfigShape, "stateDir">,
): Effect.Effect<string, WsRpcError> {
  return Effect.try({
    try: () => resolveMossResourceImportStateDir(config),
    catch: (cause) =>
      cause instanceof WsRpcError
        ? cause
        : new WsRpcError({
            message: "A prepared server state directory is required for resource import.",
            code: "authorization-required",
          }),
  });
}

export interface MossResourceImportMutationProject {
  readonly id: string;
  readonly kind?: string;
  readonly workspaceRoot: string;
  readonly deletedAt: string | null;
}

export interface WorkspaceAuthorizationRegistry {
  /**
   * Server-owned project/workspace authorization. A project projection alone
   * is not an owner grant, so the default registry fails closed.
   */
  readonly authorize: (input: {
    readonly ownerId: string;
    readonly workspaceId: string;
    readonly workspaceRoot: string;
  }) => boolean;
}

/**
 * Project metadata is the server-owned workspace registry boundary used by the
 * WS handlers. Invalidate the factory binding when that registry retires or
 * replaces a project so already-captured capability methods cannot outlive it.
 */
export function invalidateMossProjectionWorkspaceAuthorityForEvent(
  projectionAuthorityFactory:
    | Pick<MossProjectionAuthorityFactory, "unregisterWorkspace">
    | undefined,
  event: OrchestrationEvent,
): void {
  if (!projectionAuthorityFactory) return;
  switch (event.type) {
    case "project.created":
    case "project.deleted":
      projectionAuthorityFactory.unregisterWorkspace({ id: String(event.payload.projectId) });
      return;
    case "project.meta-updated":
      if (event.payload.workspaceRoot !== undefined || event.payload.kind !== undefined) {
        projectionAuthorityFactory.unregisterWorkspace({ id: String(event.payload.projectId) });
      }
      return;
    default:
      return;
  }
}

export function makeMossProjectionAuthorityConnectionCloseHandler(
  projectionAuthorityFactory: Pick<MossProjectionAuthorityFactory, "unbindSession"> | undefined,
  attachmentPrincipal: ManagedAttachmentPrincipal,
): (() => void) | undefined {
  if (!projectionAuthorityFactory || attachmentPrincipal.ownerKind !== "session") {
    return undefined;
  }
  return () => projectionAuthorityFactory.unbindSession(attachmentPrincipal.ownerId);
}

export const MossResourceImportWorkspaceAuthorizationRegistry =
  ServiceMap.Reference<WorkspaceAuthorizationRegistry>(
    "moss/ws/MossResourceImportWorkspaceAuthorizationRegistry",
    { defaultValue: () => ({ authorize: () => false }) },
  );

/**
 * Test/embedding-only legacy ports for import RPC unit harnesses. The
 * production WS handler map never reads this service; production mutations
 * must resolve a workspace/connection-scoped MossProjectionAuthorityFactory.
 */
export interface MossResourceImportAuthorityProviderTestOnly {
  readonly ownershipStore?: MossOwnershipStore;
  readonly filesystemCapability?: MossFilesystemCapability;
}

export const MossResourceImportAuthorityProviderTestOnly =
  ServiceMap.Reference<MossResourceImportAuthorityProviderTestOnly>(
    "moss/ws/MossResourceImportAuthorityProviderTestOnly",
    { defaultValue: () => ({}) },
  );

export interface MossCanonicalResourceMutationContext {
  readonly cwd: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly issuer: string;
}

export interface MossCanonicalResourceMutationService {
  readonly create: (
    input: MossCreateResourceInput,
    context: MossCanonicalResourceMutationContext,
  ) => Effect.Effect<MossCreateResourceResult, WsRpcError>;
  readonly delete: (
    input: MossDeleteResourceInput,
    context: MossCanonicalResourceMutationContext,
  ) => Effect.Effect<MossDeleteResourceResult, WsRpcError>;
  readonly update: (
    input: MossUpdateResourceInput,
    context: MossCanonicalResourceMutationContext,
  ) => Effect.Effect<MossUpdateResourceResult, WsRpcError>;
}

export function failClosedMossCanonicalResourceMutationError(): WsRpcError {
  return new WsRpcError({
    message: "Canonical resource mutation requires a native filesystem capability.",
    code: "durability-unsupported",
  });
}

export function failClosedMossResourceImportAuthorityError(): WsRpcError {
  return new WsRpcError({
    message: "Resource import mutation requires a server-scoped workspace authority.",
    code: "durability-unsupported",
  });
}

function assertMossProjectionAuthorityLive(
  authority: MossProjectionAuthorityHandle | undefined,
): void {
  if (!authority) throw failClosedMossResourceImportAuthorityError();
  try {
    authority.assertLive();
  } catch (cause) {
    throw new WsRpcError({
      message: "The server-scoped workspace authority handle is stale or revoked.",
      code: "authorization-required",
      cause,
    });
  }
}

function requireMossProjectionAuthorityLive(
  authority: MossProjectionAuthorityHandle | undefined,
): Effect.Effect<void, WsRpcError> {
  return Effect.try({
    try: () => assertMossProjectionAuthorityLive(authority),
    catch: (cause) =>
      cause instanceof WsRpcError
        ? cause
        : new WsRpcError({
            message: "The server-scoped workspace authority handle is stale or revoked.",
            code: "authorization-required",
            cause,
          }),
  });
}

export const MossCanonicalResourceMutationService =
  ServiceMap.Reference<MossCanonicalResourceMutationService>(
    "moss/ws/MossCanonicalResourceMutationService",
    {
      defaultValue: () => ({
        create: () => Effect.fail(failClosedMossCanonicalResourceMutationError()),
        delete: () => Effect.fail(failClosedMossCanonicalResourceMutationError()),
        update: () => Effect.fail(failClosedMossCanonicalResourceMutationError()),
      }),
    },
  );

export function resolveMossResourceImportWorkspace(input: {
  readonly role: "owner" | "client";
  readonly ownerId: string;
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly mutation: boolean;
  readonly projects: readonly MossResourceImportMutationProject[];
  readonly authorizationRegistry?: WorkspaceAuthorizationRegistry;
}): { readonly cwd: string; readonly ownerId: string; readonly workspaceId: string } {
  if (input.mutation && !canManageExternalMcp(input.role)) {
    throw new WsRpcError({
      message: "Owner authorization is required for resource import mutation.",
      code: "authorization-required",
    });
  }
  if (!input.ownerId.trim()) {
    throw new WsRpcError({
      message: "The resource import owner binding is missing.",
      code: "authorization-required",
    });
  }
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) {
    throw new WsRpcError({
      message: "A registered workspace is required for resource import.",
      code: "workspace-unregistered",
    });
  }
  const project = input.projects.find(
    (candidate) =>
      candidate.id === workspaceId && candidate.kind === "project" && candidate.deletedAt === null,
  );
  if (!project) {
    throw new WsRpcError({
      message: "The requested workspace is not registered for this owner.",
      code: "workspace-unregistered",
    });
  }
  const registeredCwd = nodePath.resolve(project.workspaceRoot);
  if (!workspaceRootsEqual(registeredCwd, nodePath.resolve(input.cwd))) {
    throw new WsRpcError({
      message: "The requested workspace path does not match its registration.",
      code: "workspace-unregistered",
    });
  }
  const authorizationRegistry = input.authorizationRegistry ?? {
    authorize: () => false,
  };
  if (
    !authorizationRegistry.authorize({
      ownerId: input.ownerId,
      workspaceId,
      workspaceRoot: registeredCwd,
    })
  ) {
    throw new WsRpcError({
      message: "The requested workspace is not authorized for this owner.",
      code: "workspace-unregistered",
    });
  }
  return { cwd: registeredCwd, ownerId: input.ownerId, workspaceId };
}

/**
 * The importer receives filesystem paths from an RPC client, so mutation
 * authorization must bind both the authenticated owner and the registered
 * project identity. A client-supplied workspaceId alone is never a grant.
 */
export function authorizeMossResourceImportMutation(input: {
  readonly role: "owner" | "client";
  readonly ownerId: string;
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly projects: readonly MossResourceImportMutationProject[];
  readonly authorizationRegistry?: WorkspaceAuthorizationRegistry;
}): { readonly ownerId: string; readonly workspaceId: string } {
  const resolved = resolveMossResourceImportWorkspace({ ...input, mutation: true });
  return { ownerId: resolved.ownerId, workspaceId: resolved.workspaceId };
}

export function toMossResourceImportWsRpcError(cause: unknown): WsRpcError {
  if (cause instanceof MossResourceImportError) {
    return new WsRpcError({ message: "Resource import request was rejected.", code: cause.code });
  }
  if (Schema.is(WsRpcError)(cause)) {
    return new WsRpcError({
      message: "Resource import request was rejected.",
      ...(cause.code ? { code: cause.code } : {}),
    });
  }
  return new WsRpcError({ message: "Resource import request failed.", code: "copy-failed" });
}

const resourceImportRpcEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  _fallbackMessage: string,
) => effect.pipe(Effect.mapError(toMossResourceImportWsRpcError));

export interface MossResourceImportMutationRpcHandlerDependencies {
  readonly apply: (
    input: MossResourceImportApplyInput,
    connectionId: string,
  ) => Effect.Effect<MossResourceImportApplyResult, WsRpcError>;
  readonly rollback: (
    input: MossResourceImportRollbackInput,
    connectionId: string,
  ) => Effect.Effect<MossResourceImportRollbackResult, WsRpcError>;
}

export function makeMossResourceImportMutationRpcHandlers(
  dependencies: MossResourceImportMutationRpcHandlerDependencies,
) {
  return {
    [WS_METHODS.providerResourceImportApply]: (
      input: MossResourceImportApplyInput,
      context: { readonly clientId: string | number },
    ) => dependencies.apply(input, String(context.clientId)),
    [WS_METHODS.providerResourceImportRollback]: (
      input: MossResourceImportRollbackInput,
      context: { readonly clientId: string | number },
    ) => dependencies.rollback(input, String(context.clientId)),
  };
}

const MAX_DIAGNOSTIC_CHILD_PROCESSES = 80;
const MAX_DIAGNOSTIC_ARGS_CHARS = 500;

// Bounded window a thread subscription waits for the projector to commit the
// thread's detail read model before failing with THREAD_SNAPSHOT_NOT_FOUND.
// Covers subscribe-vs-projection races on freshly created threads; a thread
// that truly does not exist still fails, just this much later.
const THREAD_DETAIL_SNAPSHOT_BOOTSTRAP_TIMEOUT_MS = 5_000;
const THREAD_DETAIL_SNAPSHOT_BOOTSTRAP_POLL_MS = 100;

class WsRequestAdmissionMiddleware extends RpcMiddleware.Service<WsRequestAdmissionMiddleware>()(
  "moss/WsRequestAdmissionMiddleware",
  { error: WsRpcError, requiredForClient: false },
) {}

// Optional device, computer, and project-agent link groups are served on the
// same socket: one connection, one admission middleware, one exhaustive
// handler map.
const AdmittedWsFeatureRpcGroup: RpcGroup.RpcGroup<
  Rpc.AddMiddleware<
    | RpcGroup.Rpcs<typeof WsFeatureRpcGroup>
    | RpcGroup.Rpcs<typeof WsDeviceRpcGroup>
    | RpcGroup.Rpcs<typeof WsComputerRpcGroup>
    | RpcGroup.Rpcs<typeof WsProjectAgentRpcGroup>
    | RpcGroup.Rpcs<typeof WsLibraryRpcGroup>
    | RpcGroup.Rpcs<typeof WsPagesRpcGroup>,
    typeof WsRequestAdmissionMiddleware
  >
> = WsFeatureRpcGroup.merge(WsDeviceRpcGroup)
  .merge(WsComputerRpcGroup)
  .merge(WsProjectAgentRpcGroup)
  .merge(WsLibraryRpcGroup)
  .merge(WsPagesRpcGroup)
  .middleware(WsRequestAdmissionMiddleware);

// The admitted union is too wide for the compiler to serialize at each use
// site, so downstream declarations annotate against this explicit expansion.
type AdmittedWsFeatureRpc = RpcGroup.Rpcs<typeof AdmittedWsFeatureRpcGroup>;

// Legacy Moss name kept as an alias: wsRpc.test.ts and external harnesses
// still import WsFeatureAndDeviceRpcGroup; it is the same admitted group.
export const WsFeatureAndDeviceRpcGroup: typeof AdmittedWsFeatureRpcGroup =
  AdmittedWsFeatureRpcGroup;

export function toThreadUnarchivedShellEvent(
  projectionReadModelQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getShellSnapshot" | "getThreadShellById"
  >,
  event: Extract<OrchestrationEvent, { type: "thread.unarchived" }>,
): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>> {
  if (
    event.payload.isArchiveCohortFinal &&
    ((event.payload.restoredSidebarPlacements?.length ?? 0) > 0 ||
      event.payload.restoredSidebarPlacement !== null)
  ) {
    return Effect.all([
      projectionReadModelQuery.getShellSnapshot(),
      projectionReadModelQuery.getThreadShellById(event.payload.threadId),
    ]).pipe(
      Effect.map(([snapshot, thread]) =>
        Option.some({
          kind: "sidebar-sections-updated" as const,
          sequence: event.sequence,
          sections: snapshot.sidebarSections ?? [],
          ...(Option.isSome(thread) ? { thread: thread.value } : {}),
        }),
      ),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
  }
  return projectionReadModelQuery
    .getThreadShellById(ThreadId.makeUnsafe(String(event.aggregateId)))
    .pipe(
      Effect.map((thread) =>
        Option.map(thread, (nextThread) => ({
          kind: "thread-upserted" as const,
          sequence: event.sequence,
          thread: nextThread,
        })),
      ),
      Effect.catch(() => Effect.succeed(Option.none())),
    );
}

const wsRequestAdmissionMiddlewareLayer = Layer.effect(
  WsRequestAdmissionMiddleware,
  Effect.gen(function* () {
    const admission = yield* makeWsRequestAdmission;
    const connectionSessions = yield* WsConnectionSessions;
    return ((effect, options) => {
      // Handler fibers descend from the RPC server fiber (forked at layer build),
      // not from the connection's HTTP upgrade fiber, so connection-scoped
      // services must be re-provided here from the connection-session registry.
      const scoped = provideWsConnectionSession(
        effect,
        connectionSessions.lookup(Headers.get(options.headers, WS_CONNECTION_SESSION_HEADER)),
      );
      return RpcSchema.isStreamSchema(options.rpc.successSchema)
        ? scoped
        : admission.guard(options.clientId, options.rpc._tag, scoped);
    }) satisfies RpcMiddleware.RpcMiddleware<never, WsRpcError, never>;
  }),
);

// Relative subdirectories scaffolded under a freshly created chat container workspace root.
// The Studio layout lives in studioWorkspaceScaffold.ts alongside its instruction files.
const CHAT_WORKSPACE_SUBDIRECTORIES = ["work", "outputs"] as const;

interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly virtualSizeBytes: number;
  readonly command: string;
  readonly args: string;
}

function redactAndTruncateProcessArgs(args: string): string {
  const redacted = redactSensitiveProcessArgs(args, {
    truncateSensitiveEnvironmentRemainder: true,
  });
  return redacted.length > MAX_DIAGNOSTIC_ARGS_CHARS
    ? `${redacted.slice(0, Math.max(0, MAX_DIAGNOSTIC_ARGS_CHARS - 15))}... [truncated]`
    : redacted;
}

function parseProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      virtualSizeBytes: Number(match[4]) * 1024,
      command: match[5] ?? "",
      args: redactAndTruncateProcessArgs(match[6] ?? ""),
    });
  }
  return rows;
}

function collectDescendantProcesses(
  rows: readonly ProcessTableRow[],
  rootPid: number,
): ProcessTableRow[] {
  const childrenByParent = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  const descendants: ProcessTableRow[] = [];
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const row = stack.pop()!;
    descendants.push(row);
    stack.push(...(childrenByParent.get(row.pid) ?? []));
  }
  return descendants.toSorted((left, right) => right.rssBytes - left.rssBytes);
}

function readDescendantProcesses(rootPid: number): Promise<ProcessTableRow[]> {
  if (process.platform === "win32") {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,rss=,vsz=,comm=,args="],
      { maxBuffer: 2 * 1024 * 1024 },
      (_error, stdout) => {
        resolve(collectDescendantProcesses(parseProcessTable(stdout), rootPid));
      },
    );
  });
}

export function toWsRpcError(cause: unknown, fallbackMessage: string) {
  if (Schema.is(WsRpcError)(cause)) {
    return cause;
  }
  if (
    cause instanceof OrchestrationCommandInvariantError ||
    cause instanceof OrchestrationCommandPreviouslyRejectedError
  ) {
    return new WsRpcError({
      message: cause.message,
      code: "ORCHESTRATION_COMMAND_REJECTED",
      retryable: false,
      cause,
    });
  }
  // Missing projector cursors make the snapshot fence underivable. Mark the
  // failure non-retryable with its own code so clients surface a diagnosable
  // fault instead of restarting the stream into the same condition forever.
  if (Schema.is(ProjectionStateIncompleteError)(cause)) {
    return new WsRpcError({
      message: cause.message,
      code: "ORCHESTRATION_PROJECTION_STATE_INCOMPLETE",
      retryable: false,
      cause,
    });
  }
  // Library service errors carry a stable code (e.g. rename-extension refusal)
  // the web surface matches on; preserve it instead of falling back to generic.
  if (cause instanceof LibraryServiceError) {
    return new WsRpcError({
      message: cause.message,
      code: cause.code ?? "LIBRARY_ERROR",
      retryable: false,
      cause,
    });
  }
  if (cause instanceof PagesServiceError) {
    return new WsRpcError({
      message: cause.message,
      code: `PAGES_${cause.code.toUpperCase()}`,
      retryable: false,
      cause,
    });
  }
  if (cause instanceof AutomationServiceError && cause.code === "AUTOMATION_CREATE_REJECTED") {
    return new WsRpcError({ message: cause.message, code: cause.code, retryable: false });
  }
  return new WsRpcError({
    message: cause instanceof Error && cause.message.length > 0 ? cause.message : fallbackMessage,
    cause,
  });
}

// Process-wide so a subscriber's restart chain survives its own reconnects
// (the client id is stable across a socket reconnect), but keyed per
// subscriber inside the tracker — see makeResnapshotEscalationTracker.
const rpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
  effect.pipe(Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)));

/** Owner guest-share failures keep their code; clients localize by it. */
export function toGuestShareWsRpcError(cause: unknown): WsRpcError {
  if (cause instanceof GuestShareOwnerError) {
    return new WsRpcError({ message: cause.message, code: cause.code, retryable: false });
  }
  return toWsRpcError(cause, "Guest share request failed");
}

const guestShareRpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(toGuestShareWsRpcError));

export const serverUpdateSettingsRpcEffect = (
  service: Pick<ServerSettingsShape, "updateSettings">,
  input: ServerSettingsPatch,
) =>
  rpcEffect(
    service
      // Derive from the disk snapshot under the settings write lock: a stale
      // client must not restore a reservation that the server just revoked.
      .updateSettings(input, (current) => protectReservedSettingsPatch(current, input))
      .pipe(Effect.map(toServerSettingsView)),
    "Failed to update server settings",
  );

const resnapshotEscalationTracker = makeResnapshotEscalationTracker();

// Legacy/native callers may pin a text-generation model via the model-only
// `textGenerationModel` field. Downstream routing prefers a model selection
// over the raw model, so the global settings selection must only be injected
// when the caller supplied neither — injecting it alongside an explicit model
// would silently reroute the request to the globally configured model.
function resolveTextGenerationRouting(
  settings: ServerSettings,
  input: {
    readonly textGenerationModel?: string | undefined;
    readonly textGenerationModelSelection?: ModelSelection | undefined;
    readonly providerOptions?: ProviderStartOptions | undefined;
  },
): {
  readonly model: string;
  readonly modelSelection: ModelSelection | undefined;
  readonly providerOptions: ProviderStartOptions | undefined;
} {
  const explicitModel = input.textGenerationModel?.trim();
  if (!input.textGenerationModelSelection && explicitModel) {
    return {
      model: explicitModel,
      modelSelection: undefined,
      providerOptions: input.providerOptions,
    };
  }
  const modelSelection =
    input.textGenerationModelSelection ?? settings.textGenerationModelSelection;
  const instance = resolveProviderInstance(settings, {
    provider: modelSelection.provider,
    instanceId: resolveModelSelectionInstanceId(modelSelection),
  });
  return {
    model: explicitModel || modelSelection.model,
    modelSelection,
    providerOptions: mergeProviderStartOptions(
      input.providerOptions,
      instance ? providerStartOptionsFromInstance(instance) : undefined,
    ),
  };
}

const failLiveUiStreamForSnapshotResync = (report: LiveUiStreamDropReport) =>
  Effect.fail(
    new WsRpcError({
      message: `${report.message}; restarting stream to refresh snapshot.`,
    }),
  );

// Must mirror the cases of toShellStreamEvent: events rejected here are dropped
// before the live-UI buffer so the sliding window only holds events that can
// actually project to a shell update.
function isShellRelevantEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "space.created" ||
    event.type === "space.meta-updated" ||
    event.type === "space.order-updated" ||
    event.type === "space.deleted" ||
    event.type === "project.created" ||
    event.type === "project.meta-updated" ||
    event.type === "project.deleted" ||
    event.type === "thread.deleted" ||
    (event.aggregateKind === "thread" && shouldPublishThreadShellForEvent(event))
  );
}

/** Keeps the two worktree RPCs behind the same project eligibility check. */
export function makeProjectWorktreeGuard<E1, R1, E2, R2>(dependencies: {
  readonly canonicalizeWorkspaceRoot: (cwd: string) => Effect.Effect<string, E1, R1>;
  readonly getActiveProjectByWorkspaceRoot: (
    cwd: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, E2, R2>;
}) {
  return (cwd: string) =>
    dependencies.canonicalizeWorkspaceRoot(cwd).pipe(
      Effect.flatMap(dependencies.getActiveProjectByWorkspaceRoot),
      Effect.flatMap((project) =>
        Option.isSome(project) && (project.value.additionalFolders ?? []).length > 0
          ? Effect.fail(new WsRpcError({ message: PROJECT_FOLDERS_WORKTREE_ISSUE }))
          : Effect.void,
      ),
    );
}

const makeWsRpcHandlersLayer = () =>
  AdmittedWsFeatureRpcGroup.toLayer(
    Effect.gen(function* () {
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const automationService = yield* AutomationService;
      const todoService = yield* TodoService;
      const secretRequests = Option.getOrUndefined(yield* Effect.serviceOption(SecretRequests));
      const guestShareService = yield* GuestShareService;
      const libraryService = yield* LibraryService;
      const pagesService = Option.getOrUndefined(yield* Effect.serviceOption(PagesService));
      const pageOperation = <A>(
        operation: (service: PagesServiceShape) => Effect.Effect<A, PagesServiceError>,
      ) =>
        pagesService
          ? operation(pagesService)
          : Effect.fail(
              new PagesServiceError({ code: "storage", message: "Pages service is unavailable" }),
            );
      const pageRpcEffect = <A>(effect: Effect.Effect<A, PagesServiceError>) =>
        effect.pipe(
          Effect.mapError(
            (error) =>
              new PagesRpcError({
                code: error.code,
                message:
                  error.code === "storage"
                    ? "Pages storage operation failed; retry the same request to confirm its result"
                    : error.message,
                ...(error.currentRevision === undefined
                  ? {}
                  : { currentRevision: error.currentRevision }),
              }),
          ),
        );
      const projectAgentService = yield* ProjectAgentService;
      const projectAgentRepository = yield* ProjectAgentRepository;
      const config = yield* ServerConfig;
      const devServerManager = yield* DevServerManager;
      const fileSystem = yield* FileSystem.FileSystem;
      const externalMcp = yield* ExternalMcpService;
      const mcpConnectors = yield* McpConnectors;
      const git = yield* GitCore;
      const github = yield* GitHubCli;
      const gitManager = yield* GitManager;
      const gitStatusBroadcaster = yield* GitStatusBroadcaster;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const providerCommandReactor = yield* ProviderCommandReactor;
      const sidechatExpiryReactor = yield* SidechatExpiryReactor;
      const path = yield* Path.Path;
      const pullRequests = yield* PullRequestService;
      const pullRequestAutoFix = yield* PullRequestAutoFixService;
      const githubInbox = yield* GitHubInboxService;
      const profileStatsQuery = yield* ProfileStatsQuery;
      const recapStatsQuery = yield* RecapStatsQuery;
      const threadSearchQuery = yield* ThreadSearchQuery;
      const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
      const providerAdapterRegistry = yield* ProviderAdapterRegistry;
      const providerDiscoveryService = yield* ProviderDiscoveryService;
      const providerHealth = yield* ProviderHealth;
      const providerService = yield* ProviderService;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const runtimeStartup = yield* ServerRuntimeStartup;
      const serverEnvironment = yield* ServerEnvironment;
      const serverSettings = yield* ServerSettingsService;
      const keepAwake = yield* KeepAwakeService;
      const terminalManager = yield* TerminalManager;
      const textGeneration = yield* TextGeneration;
      const nextMessagePredictionCache = yield* makeKeyedSingleFlightCache<
        { readonly text: string },
        unknown
      >({
        maxEntries: 64,
        ttlMs: Number.POSITIVE_INFINITY,
      });
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const threadDiagnostics = yield* ThreadDiagnosticsQuery;
      const eventStore = yield* OrchestrationEventStore;
      const providerRuntimeEvents = yield* ProviderRuntimeEventRepository;
      const readOwnerThreadDiagnostics = makeOwnerThreadDiagnosticReader({
        eventStore,
        providerRuntimeEvents,
        requireThreadShell: (threadId) =>
          projectionReadModelQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new Error("Thread was not found.")),
                onSome: Effect.succeed,
              }),
            ),
          ),
      });
      // Optional so route-level tests and non-macOS builds can mount the RPC
      // group without a device engine; the handlers below then refuse cleanly
      // with the same unsupported-platform answer the backend would give.
      const deviceService = Option.getOrUndefined(yield* Effect.serviceOption(DeviceService));
      const computerService = Option.getOrUndefined(yield* Effect.serviceOption(ComputerService));
      const connectionSessions = yield* WsConnectionSessions;
      const computerInterests = new ComputerEventInterests(connectionSessions.onClose);
      const computerHandlers = makeWsComputerHandlers(
        computerService,
        Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewaySessionRegistry)),
      );
      const runGitAction = yield* makeGitActionRunner((input, publish) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const routing = resolveTextGenerationRouting(settings, input);
          yield* gitManager.runStackedAction(
            {
              ...input,
              ...(routing.modelSelection
                ? { textGenerationModelSelection: routing.modelSelection }
                : {}),
              ...(routing.providerOptions ? { providerOptions: routing.providerOptions } : {}),
            },
            { actionId: input.actionId, progressReporter: { publish } },
          );
          yield* refreshGitStatusInBackground(input.cwd);
        }).pipe(
          Effect.catchCause((cause) => Effect.fail(toWsRpcError(cause, "Git action failed"))),
        ),
      );
      const githubProjectProvisioner = yield* makeGitHubProjectProvisioner({
        homeDir: config.homeDir,
        fileSystem,
        path,
        git,
        github,
      });
      const streamAdmission = yield* makeWsStreamAdmission({
        recordRejection: (incident) =>
          threadDiagnostics
            .recordOperationalDiagnostic({
              ...(incident.threadId ? { threadId: incident.threadId } : {}),
              source: "server",
              kind: "ws.stream-admission-rejected",
              severity: "warning",
              code: incident.errorCode,
              detail: {
                reason: incident.reason,
                active: incident.active,
                activeThreads: incident.activeThreads,
                streamLimit: MAX_STREAMS_PER_RPC_CLIENT,
                threadLimit: MAX_THREAD_STREAMS_PER_RPC_CLIENT,
              },
              occurredAt: new Date().toISOString(),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Failed to persist streaming RPC rejection diagnostic.", {
                  error: String(error),
                }),
              ),
            ),
      });
      const trackSidechatVisibility =
        (threadId: ThreadId) =>
        <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
          Stream.unwrap(
            Effect.acquireRelease(sidechatExpiryReactor.viewStarted(threadId), () =>
              sidechatExpiryReactor.viewEnded(threadId),
            ).pipe(Effect.as(stream)),
          );
      const recordThreadStreamOverflow = (threadId: string, report: LiveUiStreamDropReport) =>
        threadDiagnostics
          .recordOperationalDiagnostic({
            threadId,
            source: "server",
            kind: "ws.thread-stream-overflow",
            severity: "warning",
            code: ORCHESTRATION_STREAM_OVERFLOW_CODE,
            detail: {
              label: report.label,
              capacity: report.capacity,
              retainedSerializedBytes: report.retainedSerializedBytes ?? null,
              maxSerializedBytes: report.maxSerializedBytes ?? null,
              retryable: true,
            },
            occurredAt: new Date().toISOString(),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to persist thread stream overflow diagnostic.", {
                error: String(error),
              }),
            ),
          );
      const recordThreadResnapshotRequired = (
        threadId: string,
        report: {
          readonly snapshotSequence: number;
          readonly highWaterSequence: number;
          readonly replayCount: number;
          readonly replayLimit: number;
        },
      ) =>
        threadDiagnostics
          .recordOperationalDiagnostic({
            threadId,
            source: "server",
            kind: "ws.thread-stream-resnapshot-required",
            severity: "warning",
            code: "ORCHESTRATION_RESNAPSHOT_REQUIRED",
            detail: {
              snapshotSequence: report.snapshotSequence,
              highWaterSequence: report.highWaterSequence,
              replayCount: report.replayCount,
              replayLimit: report.replayLimit,
            },
            occurredAt: new Date().toISOString(),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to persist thread resnapshot diagnostic.", {
                error: String(error),
              }),
            ),
          );

      // A thread subscription can race the projector: the client subscribes the
      // moment a create/turn RPC resolves, while the detail read model commits
      // asynchronously behind the journal. Failing straight away with
      // THREAD_SNAPSHOT_NOT_FOUND tears the stream down for a thread the server
      // is actively running. Waiting here is safe because the cursor-safe
      // stream attaches its live tap before evaluating the snapshot effect, so
      // no event that commits during the wait is lost.
      const loadThreadDetailSnapshotWithBootstrapWait = (
        threadId: ThreadId,
        messageWindow?: import("@synara/contracts").OrchestrationThreadMessageWindow,
      ) =>
        Effect.gen(function* () {
          const deadline = Date.now() + THREAD_DETAIL_SNAPSHOT_BOOTSTRAP_TIMEOUT_MS;
          while (true) {
            const detail = yield* projectionReadModelQuery.getThreadDetailSnapshotById(
              threadId,
              messageWindow,
            );
            if (Option.isSome(detail) || Date.now() >= deadline) {
              return detail;
            }
            yield* Effect.sleep(THREAD_DETAIL_SNAPSHOT_BOOTSTRAP_POLL_MS);
          }
        });

      const isGlobalGitHubCliError = (error: unknown): error is GitHubCliError =>
        error instanceof GitHubCliError &&
        (error.reason === "not-installed" || error.reason === "not-authenticated");

      const toPullRequestsRpcError = (cause: unknown, fallbackMessage: string) => {
        if (isGlobalGitHubCliError(cause)) {
          return new PullRequestsUnavailableError({
            reason: cause.reason === "not-installed" ? "gh-not-installed" : "gh-not-authenticated",
            message: cause.detail,
          });
        }
        if (cause instanceof GitHubInboxRateLimitedError) {
          return new PullRequestsUnavailableError({
            reason: "rate-limited",
            message: cause.message,
            retryAt: cause.retryAt,
          });
        }
        if (cause instanceof GitHubCliError && cause.reason === "rate-limited") {
          return new PullRequestsUnavailableError({
            reason: "rate-limited",
            message: cause.detail,
          });
        }
        return toWsRpcError(cause, fallbackMessage);
      };

      const pullRequestsEffect = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
        fallbackMessage: string,
      ) => effect.pipe(Effect.mapError((cause) => toPullRequestsRpcError(cause, fallbackMessage)));
      const canonicalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (
        workspaceRoot: string,
        options: { readonly createIfMissing?: boolean } = {},
      ) {
        const rawWorkspaceRoot = workspaceRoot.trim();
        const expandedWorkspaceRoot =
          rawWorkspaceRoot === "~"
            ? config.homeDir
            : rawWorkspaceRoot.startsWith("~/") || rawWorkspaceRoot.startsWith("~\\")
              ? path.join(config.homeDir, rawWorkspaceRoot.slice(2))
              : rawWorkspaceRoot;
        const normalizedWorkspaceRoot = path.resolve(expandedWorkspaceRoot);
        let workspaceStat = yield* fileSystem
          .stat(normalizedWorkspaceRoot)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!workspaceStat) {
          if (!options.createIfMissing) {
            return yield* new WsRpcError({
              message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
            });
          }
          yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
                  cause,
                }),
            ),
          );
          workspaceStat = yield* fileSystem
            .stat(normalizedWorkspaceRoot)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!workspaceStat) {
            return yield* new WsRpcError({
              message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
            });
          }
        }
        if (workspaceStat.type !== "Directory") {
          return yield* new WsRpcError({
            message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
          });
        }
        return yield* realpathNearestExisting(normalizedWorkspaceRoot).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      });
      // Fail before Git runs; a refused turn must not leave an orphaned worktree.
      const refuseMultiFolderProjectWorktree = makeProjectWorktreeGuard({
        canonicalizeWorkspaceRoot: canonicalizeProjectWorkspaceRoot,
        getActiveProjectByWorkspaceRoot: projectionReadModelQuery.getActiveProjectByWorkspaceRoot,
      });
      // One mkdir loop shared by every container kind; the relative directory set is the
      // only thing that varies (general chats scaffold work/outputs, Studio mirrors the
      // Claude Outbox layout). Keeping a single implementation keeps error handling and
      // idempotency identical across kinds.
      const prepareWorkspaceSubdirectories = Effect.fnUntraced(function* (
        workspaceRoot: string,
        relativeDirnames: readonly string[],
      ) {
        for (const dirname of relativeDirnames) {
          const childPath = path.join(workspaceRoot, dirname);
          yield* fileSystem.makeDirectory(childPath, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: `Failed to create workspace directory: ${childPath}`,
                  cause,
                }),
            ),
          );
        }
      });
      const prepareChatWorkspaceRoot = (workspaceRoot: string) =>
        prepareWorkspaceSubdirectories(workspaceRoot, CHAT_WORKSPACE_SUBDIRECTORIES);
      // Instruction files are best-effort: they steer agents toward the Outbox layout but
      // must never fail (or retry-loop) the container create that scaffolds the folders.
      const prepareStudioWorkspaceRoot = (workspaceRoot: string) =>
        prepareWorkspaceSubdirectories(workspaceRoot, STUDIO_WORKSPACE_SUBDIRECTORIES).pipe(
          Effect.andThen(
            ensureStudioWorkspaceInstructionsFiles(workspaceRoot).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to write studio workspace instructions", {
                  workspaceRoot,
                  cause,
                }),
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
          ),
        );
      const prepareGroupWorkspaceRoot = (workspaceRoot: string) =>
        fileSystem.makeDirectory(workspaceRoot, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new WsRpcError({
                message: `Failed to create hub workspace: ${workspaceRoot}`,
                cause,
              }),
          ),
          Effect.andThen(
            ensureGroupWorkspaceInstructionsFiles(workspaceRoot).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to write hub workspace instructions", {
                  workspaceRoot,
                  cause,
                }),
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
          ),
        );

      const normalizeDispatchCommand = makeDispatchCommandNormalizer<WsRpcError>({
        attachmentsDir: config.attachmentsDir,
        chatWorkspaceRoot: config.chatWorkspaceRoot,
        studioWorkspaceRoot: config.studioWorkspaceRoot,
        groupsWorkspaceRoot: config.groupsWorkspaceRoot,
        fileSystem,
        path,
        canonicalizeProjectWorkspaceRoot,
        listGroupWorkspaceRoots: () =>
          projectionReadModelQuery.getCommandReadModel().pipe(
            Effect.map((readModel) =>
              readModel.projects
                .filter((project) => project.kind === "group" && project.deletedAt === null)
                .map((project) => ({
                  projectId: project.id,
                  workspaceRoot: project.workspaceRoot,
                })),
            ),
            Effect.mapError(
              (cause) =>
                new WsRpcError({
                  message: "Failed to list hub workspace roots.",
                  cause,
                }),
            ),
          ),
        prepareChatWorkspaceRoot,
        prepareStudioWorkspaceRoot,
        prepareGroupWorkspaceRoot,
      });

      const importThread = makeImportThreadHandler({
        fileSystem,
        orchestrationEngine,
        path,
        platform: process.platform,
        projectionSnapshotQuery: projectionReadModelQuery,
        providerAdapterRegistry,
        providerService,
        serverConfig: config,
        serverSettings,
      });
      const projectImports = makeProjectImportHandlers({
        repository: yield* makeProjectImportRepository,
        orchestrationEngine,
        providerService,
        providerAdapterRegistry,
        serverSettings,
        homeDir: config.homeDir,
        stateDir: config.stateDir,
      });

      const dispatchOrchestrationCommand = (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          const attachmentPrincipal = yield* CurrentManagedAttachmentPrincipal;
          return yield* runtimeStartup.enqueueCommand(
            orchestrationEngine.dispatch(command, { attachmentPrincipal }),
          );
        });

      // Terminal-first threads are created with the generic "New terminal" placeholder.
      // The tracker buffers per-terminal input and, once a meaningful command is submitted,
      // surfaces a safe title used to auto-rename the thread on its first command.
      const terminalTitleTracker = new TerminalThreadTitleTracker();
      const resetTerminalTitleBuffer = (threadId: string, terminalId: string | null) =>
        Effect.sync(() => terminalTitleTracker.reset(threadId, terminalId));
      // Terminal auto-titles are best-effort metadata and must never block or fail terminal writes.
      const maybeAutoRenameTerminalThread = Effect.fnUntraced(function* (input: {
        threadId: string;
        terminalId: string;
        data: string;
      }) {
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === input.threadId);
        if (!thread) {
          return;
        }
        const nextTitle = terminalTitleTracker.consumeWrite({
          currentTitle: thread.title,
          data: input.data,
          terminalId: input.terminalId,
          threadId: input.threadId,
        });
        if (!nextTitle) {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`server:terminal-title-rename:${crypto.randomUUID()}`),
          threadId: ThreadId.makeUnsafe(input.threadId),
          title: nextTitle,
        });
      });

      const stopLocalServerAndTrackedProjectRun = Effect.fnUntraced(function* (input: {
        pid: number;
        port: number;
      }) {
        const localServer =
          (yield* Effect.promise(() => listLocalServers())).servers.find(
            (server) => server.pid === input.pid && server.ports.includes(input.port),
          ) ?? null;
        const result = yield* Effect.promise(() => stopLocalServer(input, localServer));
        if (localServer?.isStoppable) {
          const devServers = yield* devServerManager.list;
          const trackedServer = findProjectDevServerForLocalServer({
            localServer,
            devServers: devServers.servers,
          });
          if (trackedServer) {
            yield* devServerManager
              .stop({ projectId: trackedServer.projectId })
              .pipe(Effect.catch(() => Effect.void));
          }
        }
        return result;
      });

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providerStatuses = yield* providerHealth.getStatuses;
        return {
          cwd: config.cwd,
          homeDir: config.homeDir,
          chatWorkspaceRoot: config.chatWorkspaceRoot,
          studioWorkspaceRoot: config.studioWorkspaceRoot,
          groupsWorkspaceRoot: config.groupsWorkspaceRoot,
          worktreesDir: config.worktreesDir,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          defaultKeybindings: DEFAULT_RESOLVED_KEYBINDINGS,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors: resolveAvailableEditors(),
        };
      });

      const refreshGitStatusAfter = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.tap(() =>
            gitStatusBroadcaster.refreshStatus(cwd).pipe(Effect.catchCause(() => Effect.void)),
          ),
        );

      const refreshGitStatusInBackground = (cwd: string) =>
        gitStatusBroadcaster.refreshStatus(cwd).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.forkDetach,
          Effect.asVoid,
        );

      const validateArchiveWorktreeRemoval = (input: GitRemoveWorktreeInput) =>
        Effect.gen(function* () {
          if (!input.archiveCleanup) return;
          const { threadId, archiveSequence } = input.archiveCleanup;
          const events = yield* Stream.runCollect(
            orchestrationEngine.readThreadEventsThrough(
              threadId,
              Math.max(0, archiveSequence - 1),
              archiveSequence,
              ["thread.archived"],
            ),
          );
          const archiveEvent = [...events].find((event) => event.sequence === archiveSequence);
          const shell = Option.getOrUndefined(
            yield* projectionReadModelQuery.getThreadShellById(threadId),
          );
          if (
            archiveEvent?.type !== "thread.archived" ||
            !archiveEvent.payload.archivedAt ||
            !shell ||
            shell.archivedAt !== archiveEvent.payload.archivedAt ||
            (shell.session !== null && shell.session.status !== "stopped")
          ) {
            return yield* Effect.fail(
              new WsRpcError({ message: "Archive cleanup is no longer safe for this task." }),
            );
          }
          if (
            !(yield* isManagedWorktreePathCanonical({
              worktreesDir: config.worktreesDir,
              worktreePath: input.path,
            }))
          ) {
            return yield* Effect.fail(
              new WsRpcError({ message: "Archive cleanup only removes managed worktrees." }),
            );
          }
          // A detached HEAD may contain commits with no branch reference. Do
          // not silently make those commits unreachable through auto-cleanup.
          const branchContext = yield* git.readBranchContext(input.path);
          if (!branchContext.isRepo || branchContext.branch === null) {
            return yield* Effect.fail(
              new WsRpcError({ message: "Archive cleanup kept a worktree without a branch." }),
            );
          }
          const owners = yield* projectionReadModelQuery.listManagedWorktreeThreads();
          if (
            !(yield* archivedWorktreeHasNoOtherOwners({
              worktreePath: input.path,
              threadId,
              threads: owners,
            }))
          ) {
            return yield* Effect.fail(
              new WsRpcError({ message: "Another task still refers to this worktree." }),
            );
          }
          // Archive's terminal reactor is asynchronous. Close only sessions
          // opened before this archive event, preserving a newer restored one.
          yield* terminalManager.closeSessionsOpenedAtOrBefore({
            threadId,
            openedAtOrBefore: archiveEvent.payload.archivedAt,
          });
          const afterTerminalCleanup = Option.getOrUndefined(
            yield* projectionReadModelQuery.getThreadShellById(threadId),
          );
          if (afterTerminalCleanup?.archivedAt !== archiveEvent.payload.archivedAt) {
            return yield* Effect.fail(
              new WsRpcError({ message: "The task was restored during archive cleanup." }),
            );
          }
        });

      const pruneManagedWorktrees = pruneProjectedArchivedManagedWorktrees({
        homeDir: config.homeDir,
        worktreesDir: config.worktreesDir,
        snapshotQuery: projectionReadModelQuery,
        git,
      }).pipe(
        // A retention failure must not present as an empty inventory: fall back
        // to a plain scan so listing callers still see the real worktrees.
        Effect.catchCause((cause) =>
          Effect.logWarning("managed worktree retention failed", {
            cause: String(cause),
          }).pipe(
            Effect.andThen(
              listManagedWorktrees({ worktreesDir: config.worktreesDir, git }).pipe(
                Effect.catchCause((listCause) =>
                  Effect.logWarning("managed worktree inventory scan failed", {
                    cause: String(listCause),
                  }).pipe(Effect.as([])),
                ),
              ),
            ),
          ),
        ),
      );
      const getOrchestrationHighWaterSequence = orchestrationEngine.getEventHighWaterSequence.pipe(
        Effect.mapError((cause) =>
          toWsRpcError(cause, "Failed to capture orchestration high-water sequence"),
        ),
      );

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never> => {
        switch (event.type) {
          case "space.created":
          case "space.meta-updated":
            return projectionReadModelQuery.getSpaceShellById(event.payload.spaceId).pipe(
              Effect.map((space) =>
                Option.map(space, (nextSpace) => ({
                  kind: "space-upserted" as const,
                  sequence: event.sequence,
                  space: nextSpace,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "space.order-updated":
            return Effect.succeed(
              Option.some({
                kind: "space-order-updated" as const,
                sequence: event.sequence,
                orderedSpaceIds: event.payload.orderedSpaceIds,
              }),
            );
          case "space.deleted":
            return Effect.succeed(
              Option.some({
                kind: "space-removed" as const,
                sequence: event.sequence,
                spaceId: event.payload.spaceId,
                updatedAt: event.payload.deletedAt,
              }),
            );
          case "project.created":
          case "project.meta-updated":
            return projectionReadModelQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") return Effect.succeed(Option.none());
            return projectionReadModelQuery
              .getThreadShellById(ThreadId.makeUnsafe(String(event.aggregateId)))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const rpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
        effect.pipe(Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)));

      const tasksEnabled = isServerBetaFeatureEnabled("tasks");
      const tasksUnavailableError = () =>
        new WsRpcError({
          message: "Tasks is unavailable on this server.",
          code: TASKS_UNAVAILABLE_ERROR_CODE,
          retryable: false,
        });
      const whenTasksEnabled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        tasksEnabled ? effect : Effect.fail(tasksUnavailableError());

      const toProjectProvisionRpcError = (cause: unknown) =>
        cause instanceof GitHubProjectProvisioningError
          ? new WsRpcError({
              message: cause.message,
              code: cause.code,
              retryable: cause.retryable,
            })
          : toWsRpcError(cause, "Failed to clone and add the GitHub project");

      const findRegisteredProjectId = (workspaceRoot: string) =>
        orchestrationEngine
          .getReadModel()
          .pipe(
            Effect.map(
              (readModel) =>
                readModel.projects.find(
                  (project) =>
                    project.kind === "project" &&
                    project.deletedAt === null &&
                    workspaceRootsEqual(project.workspaceRoot, workspaceRoot),
                )?.id ?? null,
            ),
          );

      // Resolves the caller's library root while enforcing the same
      // group-container gate ProjectAgentService applies: the project must
      // exist and be a group/studio container. The coordinator config is
      // optional — the library works before setup and honors `libraryPath`
      // overrides when configured.
      const resolveGroupLibrary = (projectId: ProjectId) =>
        Effect.gen(function* () {
          if (!isServerGroupsEnabled()) {
            return yield* new WsRpcError({ message: GROUPS_BETA_ONLY_MESSAGE });
          }
          const shell = yield* projectionReadModelQuery
            .getProjectShellById(projectId)
            .pipe(Effect.mapError(() => new WsRpcError({ message: "Failed to load project." })));
          const allowed =
            Option.isSome(shell) &&
            isGroupCoordinatorHostProject({
              kind: shell.value.kind,
              workspaceRoot: shell.value.workspaceRoot,
              groupsWorkspaceRoot: config.groupsWorkspaceRoot,
              studioWorkspaceRoot: config.studioWorkspaceRoot,
            });
          if (!allowed) {
            return yield* new WsRpcError({
              message: "The hub library is only available on hub containers.",
            });
          }
          const agentConfig = yield* projectAgentRepository
            .getConfig(projectId)
            .pipe(
              Effect.mapError(
                () => new WsRpcError({ message: "Failed to load project coordinator." }),
              ),
            )
            .pipe(Effect.map(Option.getOrNull));
          const root = yield* resolveLibraryRoot({
            stateDir: config.stateDir,
            projectId,
            libraryPath: agentConfig?.libraryPath,
          });
          yield* assertLibraryRootLocation({
            root,
            stateDir: config.stateDir,
            groupsWorkspaceRoot: config.groupsWorkspaceRoot,
            studioWorkspaceRoot: config.studioWorkspaceRoot,
            isCustomPath: agentConfig?.libraryPath !== undefined,
            projectId,
          });
          return {
            root,
            agentConfig,
            libraryIsManaged: agentConfig?.libraryPath === undefined,
          };
        });

      // Push is detached from the request (still serialized on the library
      // root): a dead or credential-prompting remote must not stall writes.
      const pushGroupLibraryInBackground = (
        root: string,
        agentConfig: {
          libraryRemoteUrl?: string | undefined;
          libraryPushOnChange?: boolean | undefined;
        } | null,
      ) =>
        Effect.forkDetach(
          withLibraryQueue(
            root,
            pushLibraryIfConfigured({
              git,
              root,
              libraryRemoteUrl: agentConfig?.libraryRemoteUrl,
              libraryPushOnChange: agentConfig?.libraryPushOnChange,
            }),
          ),
        );

      const requireLoopbackOwner = (message: string) =>
        Effect.gen(function* () {
          yield* requireWsOwnerSession;
          if (!isLoopbackHost(config.host) || config.publicUrl !== undefined) {
            return yield* Effect.fail(new WsRpcError({ message }));
          }
        });
      const requireOwner = requireLoopbackOwner(
        "External MCP management is available only on a loopback-only instance.",
      );
      // Connectors: available in Stable and Beta. Sign-in redirects to this
      // machine's loopback port, so only a loopback-only instance can finish it.
      const requireConnectorsOwner = Effect.gen(function* () {
        if (!mcpConnectors.enabled) {
          return yield* Effect.fail(
            new WsRpcError({
              message: "Connectors are unavailable on this server.",
              code: "mcp-connectors-unavailable",
              retryable: false,
            }),
          );
        }
        yield* requireLoopbackOwner("Connectors can be managed only on the computer running Moss.");
      });
      const connectorRpc = <A>(
        effect: Effect.Effect<A, McpConnectorError>,
        fallbackMessage: string,
      ) =>
        requireConnectorsOwner.pipe(
          Effect.andThen(
            effect.pipe(
              Effect.mapError(
                (error) =>
                  new WsRpcError({
                    message: error.message,
                    ...(error.code ? { code: error.code } : {}),
                  }),
              ),
            ),
          ),
          Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)),
        );
      // Moss Apps sign-ins return to this machine's loopback port as well, but
      // stay available when user-added connectors are a Beta-only feature.
      const mossAppsRpc = <A>(
        effect: Effect.Effect<A, McpConnectorError>,
        fallbackMessage: string,
      ) =>
        requireLoopbackOwner("Apps can be managed only on the computer running Moss.").pipe(
          Effect.andThen(
            effect.pipe(
              Effect.mapError(
                (error) =>
                  new WsRpcError({
                    message: error.message,
                    ...(error.code ? { code: error.code } : {}),
                  }),
              ),
            ),
          ),
          Effect.mapError((cause) => toWsRpcError(cause, fallbackMessage)),
        );

      const sessionCredentialService = yield* SessionCredentialService;
      const projectionAuthorityFactory = yield* MossProjectionAuthorityFactoryService;
      const resourceImportWorkspaceAuthorizationRegistry =
        yield* MossResourceImportWorkspaceAuthorizationRegistry;
      yield* MossCanonicalResourceMutationService;
      // The orchestration projection is the server-owned workspace registry.
      // Keep an owner-scoped snapshot of its registered roots for the
      // synchronous registry adapter; it is refreshed on every resolution and
      // never grants a path that is absent from the current read model.
      const serverWorkspaceAuthorizations = new Map<string, ReadonlyMap<string, string>>();
      const refreshServerWorkspaceAuthorization = (
        ownerId: string,
        projects: readonly { readonly id: string; readonly workspaceRoot: string }[],
      ) =>
        serverWorkspaceAuthorizations.set(
          ownerId,
          new Map(projects.map((project) => [project.id, project.workspaceRoot] as const)),
        );
      const mossWorkspaceRegistry = makeMossWorkspaceRegistry({
        authorize: (input) => {
          const registeredRoot = serverWorkspaceAuthorizations
            .get(input.ownerId)
            ?.get(input.workspaceId);
          const serverAuthorized =
            registeredRoot !== undefined &&
            workspaceRootsEqual(registeredRoot, input.workspaceRoot, {
              platform: process.platform,
            });
          return serverAuthorized || resourceImportWorkspaceAuthorizationRegistry.authorize(input);
        },
      });

      if (projectionAuthorityFactory) {
        yield* orchestrationEngine.streamDomainEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() =>
              invalidateMossProjectionWorkspaceAuthorityForEvent(projectionAuthorityFactory, event),
            ),
          ),
          Effect.forkScoped,
        );
      }

      const resolveProjectionConnectionExpiry = (principalId: string) =>
        Effect.gen(function* () {
          const activeSessions = yield* sessionCredentialService.listActive();
          const session = activeSessions.find(
            (candidate) => String(candidate.sessionId) === principalId,
          );
          if (!session) {
            return yield* Effect.fail(
              new WsRpcError({
                message: "The authenticated workspace connection is unavailable.",
                code: "authorization-required",
              }),
            );
          }
          return DateTime.toEpochMillis(session.expiresAt);
        });

      const bindProjectionConnection = (input: {
        readonly connectionId: string;
        readonly principalId: string;
      }) =>
        Effect.gen(function* () {
          if (!projectionAuthorityFactory) return;
          const expiresAt = yield* resolveProjectionConnectionExpiry(input.principalId);
          projectionAuthorityFactory.bindConnection({
            connectionId: input.connectionId,
            principalId: input.principalId,
            sessionId: input.principalId,
            expiresAt,
          });
        });
      const catalogSelectionRpc = makeMossCatalogSelectionRpc({
        resolveCandidate: async ({ kind, candidateId }) => {
          const page = await browseMossMarketplace({
            kind,
            stateDir: resolveMossResourceImportStateDir(config),
            forceReload: true,
            query: { query: candidateId, includeStale: true, limit: 100 },
          });
          const entry = page.entries.find(
            (candidate) => candidate.id === candidateId && candidate.kind === kind,
          );
          if (!entry)
            throw new MossCatalogSelectionRpcError(
              "ticket-invalid",
              "Catalog candidate is not present in the server revision chain.",
            );
          return { artifact: null, snapshotSha256: page.snapshot, resourceIds: [entry.id] };
        },
        issueTicket: async (selection) => {
          if (!providerDiscoveryService.catalogSelection)
            throw new MossCatalogSelectionRpcError(
              "ticket-invalid",
              "Catalog selection attestation is unavailable on this server.",
            );
          return Effect.runPromise(providerDiscoveryService.catalogSelection.issue(selection));
        },
        verifyTicket: async (selection) => {
          if (!providerDiscoveryService.catalogSelection)
            throw new MossCatalogSelectionRpcError(
              "ticket-invalid",
              "Catalog selection verification is unavailable on this server.",
            );
          return Effect.runPromise(providerDiscoveryService.catalogSelection.verify(selection));
        },
      });
      const catalogSelectionTicketVerifier = {
        verify: async (
          context: Parameters<NonNullable<typeof catalogSelectionRpc.verify>>[0],
          verificationOptions?: { readonly consume?: boolean },
        ) => {
          try {
            await catalogSelectionRpc.verify({
              ...context,
              ...(verificationOptions?.consume === undefined
                ? {}
                : { consume: verificationOptions.consume }),
            });
            return { valid: true as const, securityProfile: "unknown", licenseState: "unknown" };
          } catch (cause) {
            const code =
              cause instanceof MossCatalogSelectionRpcError ? cause.code : "ticket-invalid";
            return {
              valid: false as const,
              code: code === "authorization-required" ? ("ticket-invalid" as const) : code,
            };
          }
        },
      };

      const mossPhoneAccountService = yield* MossPhoneAccountService;
      const mossCloudAccountService = yield* MossCloudAccountService;
      const mossEnterpriseKeyAccount = yield* MossEnterpriseKeyAccount;
      const mossPayService = yield* MossPayService;
      const realtimeVoiceService = yield* RealtimeVoiceService;

      const computerHistory = getProcessComputerHistoryService({
        rootDir: resolveProcessComputerHistoryRoot(config.stateDir),
        ...(process.env.MOSS_APPSNAP_HELPER_PATH
          ? { helperPath: process.env.MOSS_APPSNAP_HELPER_PATH }
          : {}),
        keychainNamespace: resolveProcessComputerHistoryKeychainNamespace(config.stateDir),
      });

      const workspaceImport = makeWorkspaceImportWsHandlers({
        config,
        serverSettings,
        projectionReadModelQuery,
        dispatchOrchestrationCommand,
      });

      // Host-global account/provider/voice operations are available to the
      // authenticated desktop owner regardless of whether the websocket was
      // opened through a public URL.  Keep the loopback/public-url checks in
      // `requireOwner` above for external MCP management; they are not an
      // appropriate gate for normal owner connections.
      const requireOwnerRole = ownerRoleRequired;

      const resolveResourceImportWorkspace = (input: {
        readonly cwd: string;
        readonly workspaceId?: string;
        readonly mutation: boolean;
      }) =>
        Effect.gen(function* () {
          const role = yield* CurrentWsSessionRole;
          const principal = yield* CurrentManagedAttachmentPrincipal;
          if (principal.ownerKind !== "session") {
            return yield* Effect.fail(
              new WsRpcError({
                message: "An authenticated session principal is required for resource import.",
                code: "authorization-required",
              }),
            );
          }
          const readModel = yield* orchestrationEngine.getReadModel();
          const registeredProjects = readModel.projects.filter(
            (project) => project.kind === "project" && project.deletedAt === null,
          );
          refreshServerWorkspaceAuthorization(principal.ownerId, registeredProjects);
          return yield* Effect.try({
            try: () => {
              const resolved = mossWorkspaceRegistry.resolve({
                role,
                ownerId: principal.ownerId,
                cwd: input.cwd,
                ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
                mutation: input.mutation,
                projects: registeredProjects.map((project) => ({
                  id: project.id,
                  workspaceRoot: project.workspaceRoot,
                  deletedAt: project.deletedAt,
                })),
              });
              projectionAuthorityFactory?.registerWorkspace({
                id: resolved.workspaceId,
                ownerId: resolved.ownerId,
                projectId: resolved.workspaceId,
                workspaceRoot: resolved.cwd,
              });
              return resolved;
            },
            catch: (cause) =>
              cause instanceof WsRpcError
                ? cause
                : new WsRpcError({
                    message: "Failed to authorize resource import workspace.",
                    code: "authorization-required",
                  }),
          });
        });

      const resolveResourceImportAuthority = (input: {
        readonly workspace: {
          readonly cwd: string;
          readonly ownerId: string;
          readonly workspaceId: string;
        };
        readonly connectionId: string;
      }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentManagedAttachmentPrincipal;
          if (principal.ownerKind !== "session") {
            return yield* Effect.fail(
              new WsRpcError({
                message: "An authenticated session principal is required for resource import.",
                code: "authorization-required",
              }),
            );
          }
          const binding = resolveMossResourceImportServerBinding(input.connectionId);
          if (!projectionAuthorityFactory) {
            const stateDir = yield* resolveMossResourceImportStateDirEffect(config);
            return {
              authority: undefined,
              binding,
              stateDir,
              sessionId: binding.sessionId,
            };
          }
          projectionAuthorityFactory.registerWorkspace({
            id: input.workspace.workspaceId,
            ownerId: input.workspace.ownerId,
            projectId: input.workspace.workspaceId,
            workspaceRoot: input.workspace.cwd,
          });
          yield* bindProjectionConnection({
            connectionId: input.connectionId,
            principalId: principal.ownerId,
          });
          const authority = yield* Effect.tryPromise(() =>
            projectionAuthorityFactory.resolve({
              registeredWorkspaceId: input.workspace.workspaceId,
              connectionId: input.connectionId,
              sessionId: principal.ownerId,
            }),
          );
          if (!authority) {
            return yield* Effect.fail(
              new WsRpcError({
                message: "The registered workspace or authenticated connection is unavailable.",
                code: "authorization-required",
              }),
            );
          }
          return {
            authority,
            binding,
            stateDir: authority.canonicalAuthority.stateDir,
            sessionId: authority.connection.sessionId,
          };
        });

      const canonicalResourceMutationForAuthority = (
        authority: MossProjectionAuthorityHandle | undefined,
      ): MossCanonicalResourceMutationService => {
        if (!authority) {
          return {
            create: () => Effect.fail(failClosedMossCanonicalResourceMutationError()),
            delete: () => Effect.fail(failClosedMossCanonicalResourceMutationError()),
            update: () => Effect.fail(failClosedMossCanonicalResourceMutationError()),
          };
        }
        const live = makeMossCanonicalResourceMutationService({
          ownershipStore: authority.canonicalAuthority.ownershipStore,
          filesystemCapability: authority.canonicalAuthority.filesystemCapability,
          stateDir: authority.canonicalAuthority.stateDir,
        });
        return {
          create: (input: MossCreateResourceInput, context: MossCanonicalResourceMutationContext) =>
            requireMossProjectionAuthorityLive(authority).pipe(
              Effect.flatMap(() => Effect.tryPromise(() => live.create(input, context))),
              Effect.mapError(toMossResourceImportWsRpcError),
            ),
          delete: (input: MossDeleteResourceInput, context: MossCanonicalResourceMutationContext) =>
            requireMossProjectionAuthorityLive(authority).pipe(
              Effect.flatMap(() => Effect.tryPromise(() => live.delete(input, context))),
              Effect.mapError(toMossResourceImportWsRpcError),
            ),
          update: (input: MossUpdateResourceInput, context: MossCanonicalResourceMutationContext) =>
            requireMossProjectionAuthorityLive(authority).pipe(
              Effect.flatMap(() => Effect.tryPromise(() => live.update(input, context))),
              Effect.mapError(toMossResourceImportWsRpcError),
            ),
        };
      };

      const resourceImportMutationRpcHandlers = makeMossResourceImportMutationRpcHandlers({
        apply: (input, connectionId) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const authorization = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                mutation: true,
                ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace: authorization,
                connectionId,
              });
              if (!authority.authority) {
                return yield* Effect.fail(failClosedMossResourceImportAuthorityError());
              }
              yield* requireMossProjectionAuthorityLive(authority.authority);
              return yield* Effect.tryPromise(() =>
                applyMossResourceImport({
                  cwd: authorization.cwd,
                  plan: input.plan,
                  ...(input.selectionTicket !== undefined
                    ? { selectionTicket: input.selectionTicket }
                    : {}),
                  ...(input.selectionTicket
                    ? { selectionTicketVerifier: catalogSelectionTicketVerifier }
                    : {}),
                  homeDir: config.homeDir,
                  stateDir: authority.stateDir,
                  ownerId: authorization.ownerId,
                  workspaceId: authorization.workspaceId,
                  projectId: authorization.workspaceId,
                  principalId: authorization.ownerId,
                  issuer: authority.binding.issuer,
                  sessionId: authority.sessionId,
                  requireOwner: true,
                  authorizedWorkspace: true,
                  ...(authority.authority
                    ? { ownershipStore: authority.authority.canonicalAuthority.ownershipStore }
                    : {}),
                  ...(authority.authority
                    ? {
                        filesystemCapability:
                          authority.authority.canonicalAuthority.filesystemCapability,
                      }
                    : {}),
                }),
              );
            }),
            "Failed to apply provider resource import",
          ),
        rollback: (input, connectionId) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const authorization = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                mutation: true,
                ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace: authorization,
                connectionId,
              });
              if (!authority.authority) {
                return yield* Effect.fail(failClosedMossResourceImportAuthorityError());
              }
              yield* requireMossProjectionAuthorityLive(authority.authority);
              return yield* Effect.tryPromise(() =>
                rollbackMossResourceImport({
                  cwd: authorization.cwd,
                  transactionId: input.transactionId,
                  homeDir: config.homeDir,
                  stateDir: authority.stateDir,
                  ownerId: authorization.ownerId,
                  workspaceId: authorization.workspaceId,
                  projectId: authorization.workspaceId,
                  principalId: authorization.ownerId,
                  issuer: authority.binding.issuer,
                  sessionId: authority.sessionId,
                  requireOwner: true,
                  authorizedWorkspace: true,
                  ...(authority.authority
                    ? { ownershipStore: authority.authority.canonicalAuthority.ownershipStore }
                    : {}),
                  ...(authority.authority
                    ? {
                        filesystemCapability:
                          authority.authority.canonicalAuthority.filesystemCapability,
                      }
                    : {}),
                }),
              );
            }),
            "Failed to roll back provider resource import",
          ),
      });

      const withProviderProjectionAuthority = <A, E, R>(
        input: { readonly pluginId: string; readonly cwd?: string | undefined },
        connectionId: string,
        operation: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | WsRpcError, R> =>
        Effect.gen(function* () {
          if (!projectionAuthorityFactory || !input.pluginId.startsWith("moss:")) {
            return yield* operation;
          }
          if (!input.cwd) return yield* operation;
          const projectId = yield* findRegisteredProjectId(input.cwd);
          if (!projectId) return yield* operation;
          const workspace = yield* resolveResourceImportWorkspace({
            cwd: input.cwd,
            workspaceId: projectId,
            mutation: true,
          });
          const authority = yield* resolveResourceImportAuthority({
            workspace,
            connectionId,
          }).pipe(Effect.mapError(toMossResourceImportWsRpcError));
          if (!authority.authority) return yield* operation;
          return yield* operation.pipe(
            Effect.provideService(CurrentMossProjectionAuthorityContext, {
              registeredWorkspaceId: workspace.workspaceId,
              connectionId,
              sessionId: authority.sessionId,
            }),
          );
        });

      // The server currently links two Effect-RPC contract copies while the
      // desktop/web migration is in flight. Their handler maps are wire
      // compatible, but branded schema identities make the generated
      // `HandlersFrom` type reject the map at this boundary. Keep the cast at
      // the group adapter so individual handlers remain fully typed above and
      // runtime dispatch is unchanged.
      const handlers: Partial<Parameters<typeof AdmittedWsFeatureRpcGroup.of>[0]> = {
        [ORCHESTRATION_WS_METHODS.settleTurnDispatch]: ({ command }) =>
          rpcEffect(
            Effect.gen(function* () {
              const { command: normalizedCommand } = yield* normalizeDispatchCommand({ command });
              const attachmentPrincipal = yield* CurrentManagedAttachmentPrincipal;
              return yield* runtimeStartup
                .enqueueCommand(
                  orchestrationEngine.dispatch(normalizedCommand, {
                    attachmentPrincipal,
                    settleOnly: true,
                  }),
                )
                .pipe(
                  Effect.map(({ sequence }) => ({ status: "accepted" as const, sequence })),
                  Effect.catchTag("OrchestrationCommandPreviouslyRejectedError", (error) =>
                    Effect.succeed({ status: "rejected" as const, message: error.detail }),
                  ),
                );
            }),
            "Failed to resolve the original message delivery.",
          ),
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          rpcEffect(
            Effect.gen(function* () {
              // Groups is Beta-only: Stable refuses to create or re-kind a group.
              if (!isServerGroupsEnabled() && isGroupProjectCommand(command)) {
                return yield* Effect.fail(new WsRpcError({ message: GROUPS_BETA_ONLY_MESSAGE }));
              }
              const { command: normalizedCommand, prepareWorkspaceRoot } =
                yield* normalizeDispatchCommand({ command });
              // A paused/archived group's coordinator must not run turns —
              // the picker filters them out, but the server enforces it.
              if (normalizedCommand.type === "thread.turn.start") {
                yield* projectAgentService.assertGroupCoordinatorTurnAllowed({
                  threadId: normalizedCommand.threadId,
                });
              }
              const result = yield* dispatchOrchestrationCommand(normalizedCommand);
              // Only scaffold managed workspace-root subdirectories (Inbox/Outbox/work/outputs)
              // AFTER the decider has accepted the command. A rejected dispatch (e.g. a
              // cross-kind workspace-root ownership conflict) must never mutate the filesystem.
              if (prepareWorkspaceRoot) {
                yield* prepareWorkspaceRoot;
              }
              if (normalizedCommand.type === "thread.archive") {
                yield* Effect.forkDetach(pruneManagedWorktrees);
              }
              return {
                sequence: result.sequence,
                // OrchestrationEngine.dispatch still reports the sidebar order
                // revision as a plain number; the RPC contract brands it.
                ...(result.sidebarOrderRevision === undefined
                  ? {}
                  : {
                      sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(
                        result.sidebarOrderRevision,
                      ),
                    }),
              };
            }),
            "Failed to dispatch orchestration command",
          ),
        [ORCHESTRATION_WS_METHODS.importThread]: (input) =>
          rpcEffect(importThread(input), "Failed to import thread"),
        [ORCHESTRATION_WS_METHODS.listProjectImports]: (input) =>
          rpcEffect(projectImports.listProjectImports(input), "Failed to find local projects"),
        [ORCHESTRATION_WS_METHODS.loadProjectImportHistory]: (input) =>
          rpcEffect(
            projectImports.loadProjectImportHistory(input),
            "Failed to load imported history",
          ),
        [ORCHESTRATION_WS_METHODS.importProject]: (input) =>
          rpcEffect(projectImports.importProject(input), "Failed to import project"),
        [ORCHESTRATION_WS_METHODS.regenerateThreadTitle]: (input) =>
          rpcEffect(
            providerCommandReactor.regenerateThreadTitle(input),
            "Failed to regenerate thread title",
          ),
        [ORCHESTRATION_WS_METHODS.predictNextMessage]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const detail = yield* projectionReadModelQuery.getThreadDetailSnapshotById(
                input.threadId,
              );
              if (Option.isNone(detail)) {
                return yield* new WsRpcError({ message: "Thread was not found." });
              }
              const thread = detail.value.thread;
              const modelSelection = thread.modelSelection;
              const settings = yield* serverSettings.getSettings;
              const routing = resolveTextGenerationRouting(settings, {
                textGenerationModelSelection: modelSelection,
              });
              const routedModelSelection = routing.modelSelection ?? modelSelection;
              const text = yield* predictNextMessage({
                request: {
                  threadId: input.threadId,
                  latestTurnId: input.latestTurnId,
                  generationTrigger: input.generationTrigger ?? "catch_up",
                },
                thread,
                modelKey: routedModelSelection.model,
                cache: nextMessagePredictionCache,
                // Codex's prediction fork of the live native thread; it never starts a runtime.
                predictNatively: (prediction) =>
                  providerService.predictNextUserMessage(input.threadId, prediction),
                predictFromTranscript: (transcript) =>
                  textGeneration.generateNextMessagePrediction({
                    cwd: thread.workingDirectory ?? process.cwd(),
                    transcript,
                    modelSelection:
                      routedModelSelection.provider === "codex"
                        ? {
                            ...routedModelSelection,
                            options: {
                              ...routedModelSelection.options,
                              reasoningEffort: NEXT_MESSAGE_PREDICTION_CODEX_REASONING_EFFORT,
                            },
                          }
                        : routedModelSelection,
                    ...(routing.providerOptions
                      ? { providerOptions: routing.providerOptions }
                      : {}),
                  }),
              });
              return { text, latestTurnId: input.latestTurnId };
            }),
            "Failed to predict next message",
          ),
        [ORCHESTRATION_WS_METHODS.getSnapshot]: () =>
          rpcEffect(
            gateOrchestrationReadUntilStartup(
              runtimeStartup,
              projectionReadModelQuery.getSnapshot(),
            ),
            "Failed to load orchestration snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.getShellSnapshot]: () =>
          rpcEffect(
            gateOrchestrationReadUntilStartup(
              runtimeStartup,
              projectionReadModelQuery.getShellSnapshot(),
            ),
            "Failed to load orchestration shell snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot]: (input) =>
          rpcEffect(
            gateOrchestrationReadUntilStartup(
              runtimeStartup,
              projectionReadModelQuery
                .getThreadDetailSnapshotById(input.threadId, input.messageWindow)
                .pipe(Effect.map(Option.getOrNull)),
            ),
            "Failed to load orchestration thread detail snapshot",
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          rpcEffect(threadSearchQuery.searchThreads(input), "Failed to search threads"),
        [ORCHESTRATION_WS_METHODS.repairState]: () =>
          rpcEffect(orchestrationEngine.repairState(), "Failed to repair orchestration state"),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          rpcEffect(checkpointDiffQuery.getTurnDiff(input), "Failed to load turn diff"),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          rpcEffect(
            checkpointDiffQuery.getFullThreadDiff(input),
            "Failed to load full thread diff",
          ),
        [ORCHESTRATION_WS_METHODS.getInlineVisual]: (input) =>
          isServerBetaFeatureEnabled(INLINE_VISUALS_BETA_FEATURE)
            ? rpcEffect(
                Effect.tryPromise(() =>
                  readInlineVisual({
                    attachmentsDir: config.attachmentsDir,
                    threadId: input.threadId,
                    visualId: input.visualId,
                  }),
                ),
                "Failed to load visual",
              ).pipe(
                Effect.flatMap((html) =>
                  html === null
                    ? Effect.fail(
                        new WsRpcError({
                          message: "This visual is no longer available.",
                          code: "inline-visual-missing",
                          retryable: false,
                        }),
                      )
                    : Effect.succeed({ visualId: input.visualId, html }),
                ),
              )
            : Effect.fail(
                new WsRpcError({
                  message: "Inline visuals are unavailable on this server.",
                  code: "inline-visuals-unavailable",
                  retryable: false,
                }),
              ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) => {
          const fromSequenceExclusive = clamp(input.fromSequenceExclusive, {
            maximum: Number.MAX_SAFE_INTEGER,
            minimum: 0,
          });
          const replay =
            input.threadId === undefined
              ? orchestrationEngine.readEvents(fromSequenceExclusive)
              : orchestrationEngine.readThreadEvents(
                  input.threadId,
                  fromSequenceExclusive,
                  THREAD_DETAIL_EVENT_TYPES,
                );
          return rpcEffect(
            Stream.runCollect(
              replay.pipe(Stream.map(sanitizeOrchestrationEventProviderOptions)),
            ).pipe(Effect.map((events) => Array.from(events))),
            "Failed to replay orchestration events",
          );
        },
        [ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers]: (input) =>
          rpcEffect(
            providerCommandReactor.listBlockingDeliveries({
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              limit: input.limit ?? 50,
            }),
            "Failed to load provider delivery blockers",
          ),
        [ORCHESTRATION_WS_METHODS.prepareQuitResume]: (input) =>
          rpcEffect(
            // Gated as a whole (not just its dispatches) so the record can never be
            // written while startup is still claiming the previous quit's record.
            runtimeStartup.enqueueCommand(
              prepareQuitResume({
                request: input,
                recordPath: config.quitResumeStatePath,
                getReadModel: orchestrationEngine.getReadModel,
                dispatch: dispatchOrchestrationCommand,
              }),
            ),
            "Failed to prepare chats for resume after quit",
          ),
        [ORCHESTRATION_WS_METHODS.reconcileProviderDelivery]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const principal = yield* CurrentManagedAttachmentPrincipal;
              const result = yield* providerCommandReactor.reconcileDelivery({
                eventSequence: input.eventSequence,
                threadId: input.threadId,
                expectedState: input.expectedState,
                outcome: input.outcome,
                reconciledBy: `${principal.ownerKind}:${principal.ownerId}`,
                ...(input.note === undefined ? {} : { note: input.note }),
              });
              if (result === null) {
                return yield* new WsRpcError({
                  message:
                    "Provider delivery no longer matches the requested thread and blocking state.",
                  code: "PROVIDER_DELIVERY_RECONCILIATION_CONFLICT",
                  retryable: false,
                });
              }
              return result;
            }),
            "Failed to reconcile provider delivery",
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_, { clientId }) =>
          gateOrchestrationStreamUntilStartup(
            runtimeStartup,
            streamAdmission.guard(
              clientId,
              { key: "orchestration.shell" },
              makeCursorSafeSnapshotLiveStream({
                // Keyed per subscriber: concurrent clients hitting the same
                // stale fence are independent first offenses, not one chain.
                resnapshotEscalation: {
                  streamKey: `${clientId}:orchestration.shell`,
                  tracker: resnapshotEscalationTracker,
                },
                subscribeLive: orchestrationEngine.subscribeDomainEvents.pipe(
                  Effect.map((stream) => stream.pipe(Stream.filter(isShellRelevantEvent))),
                ),
                liveBufferOptions: {
                  label: "orchestration.shell",
                  onDroppedEvents: () => Effect.void,
                },
                snapshot: projectionReadModelQuery
                  .getShellSnapshot()
                  .pipe(
                    Effect.mapError((cause) =>
                      toWsRpcError(cause, "Failed to load shell snapshot"),
                    ),
                  ),
                snapshotSequence: (snapshot) => snapshot.snapshotSequence,
                getHighWaterSequence: getOrchestrationHighWaterSequence,
                replay: (fromSequenceExclusive, throughSequenceInclusive) =>
                  orchestrationEngine
                    .readEventsThrough(fromSequenceExclusive, throughSequenceInclusive)
                    .pipe(
                      Stream.filter(isShellRelevantEvent),
                      Stream.mapError((cause) =>
                        toWsRpcError(cause, "Failed to replay shell events"),
                      ),
                    ),
              }).pipe(
                Stream.mapEffect((item) =>
                  item.kind === "snapshot"
                    ? Effect.succeed(
                        Option.some<OrchestrationShellStreamItem>({
                          kind: "snapshot",
                          snapshot: item.snapshot,
                        }),
                      )
                    : item.kind === "event"
                      ? toShellStreamEvent(item.event)
                      : // The shell stream never opts into batched replay.
                        Effect.succeed(Option.none<OrchestrationShellStreamItem>()),
                ),
                Stream.flatMap((item) =>
                  Option.isSome(item) ? Stream.succeed(item.value) : Stream.empty,
                ),
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeShell]: () => Effect.void,
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input, { clientId }) =>
          gateOrchestrationStreamUntilStartup(
            runtimeStartup,
            streamAdmission.guard(
              clientId,
              {
                key: `orchestration.thread:${input.threadId}`,
                threadId: input.threadId,
              },
              makeCursorSafeSnapshotLiveStream({
                // Keyed per subscriber: concurrent clients hitting the same
                // stale fence are independent first offenses, not one chain.
                resnapshotEscalation: {
                  streamKey: `${clientId}:orchestration.thread:${input.threadId}`,
                  tracker: resnapshotEscalationTracker,
                },
                // Cursor resume: a client holding cached detail replays only the
                // gap. Out-of-range cursors (negative or overflowing gap) fall
                // back to the snapshot inside the stream factory.
                resumeFromSequence: input.afterSequence,
                // Opted-in clients get the whole gap as one item and apply it in a
                // single store update, so a stale cached turn does not replay its
                // intermediate states on screen.
                batchReplay: input.batchReplay,
                // A hard-purged thread leaves no rows to replay while the journal
                // head stays above the cursor, so the gap check alone would
                // accept the resume and stream nothing. Falling through to the
                // snapshot path surfaces THREAD_SNAPSHOT_NOT_FOUND instead.
                // The shell read shares the detail loader's active-thread
                // predicate but skips hydrating and validating the transcript,
                // which the resume path would discard for a boolean anyway.
                resumeSubjectExists: projectionReadModelQuery
                  .getThreadShellById(input.threadId)
                  .pipe(
                    Effect.map(Option.isSome),
                    Effect.mapError((cause) =>
                      toWsRpcError(cause, "Failed to verify thread before cursor resume"),
                    ),
                  ),
                onResnapshotRequired: (report) =>
                  recordThreadResnapshotRequired(input.threadId, report),
                subscribeLive: orchestrationEngine.subscribeDomainEvents.pipe(
                  Effect.map((stream) =>
                    stream.pipe(
                      Stream.filter((event) => isThreadDetailEventFor(event, input.threadId)),
                      Stream.map(sanitizeOrchestrationEventProviderOptions),
                    ),
                  ),
                ),
                liveBufferOptions: {
                  label: "orchestration.thread-detail",
                  onDroppedEvents: (report) => recordThreadStreamOverflow(input.threadId, report),
                },
                snapshot: loadThreadDetailSnapshotWithBootstrapWait(
                  input.threadId,
                  input.messageWindow,
                ).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () =>
                        projectionReadModelQuery.getSnapshotSequence().pipe(
                          Effect.map(({ snapshotSequence }) => ({
                            detail: Option.none<OrchestrationThreadDetailSnapshot>(),
                            snapshotSequence,
                          })),
                        ),
                      onSome: (detail) =>
                        Effect.succeed({
                          detail: Option.some(detail),
                          snapshotSequence: detail.snapshotSequence,
                        }),
                    }),
                  ),
                  Effect.mapError((cause) => toWsRpcError(cause, "Failed to load thread snapshot")),
                ),
                snapshotSequence: (snapshot) => snapshot.snapshotSequence,
                getHighWaterSequence: getOrchestrationHighWaterSequence,
                replay: (fromSequenceExclusive, throughSequenceInclusive) =>
                  orchestrationEngine
                    .readThreadEventsThrough(
                      input.threadId,
                      fromSequenceExclusive,
                      throughSequenceInclusive,
                      THREAD_DETAIL_EVENT_TYPES,
                    )
                    .pipe(
                      Stream.filter((event) => isThreadDetailEventFor(event, input.threadId)),
                      Stream.map(sanitizeOrchestrationEventProviderOptions),
                      Stream.mapError((cause) =>
                        toWsRpcError(cause, "Failed to replay thread events"),
                      ),
                    ),
              }).pipe(
                Stream.flatMap((item) => {
                  if (item.kind === "event") {
                    return Stream.succeed<OrchestrationThreadStreamItem>({
                      kind: "event",
                      event: item.event,
                    });
                  }
                  if (item.kind === "replay") {
                    return Stream.succeed<OrchestrationThreadStreamItem>({
                      kind: "replay",
                      events: item.events,
                      threadId: input.threadId,
                    });
                  }
                  // A silently empty snapshot would leave the client waiting forever
                  // for thread history; fail identifiably so it can surface the state.
                  return Option.isSome(item.snapshot.detail)
                    ? Stream.succeed<OrchestrationThreadStreamItem>({
                        kind: "snapshot",
                        snapshot: item.snapshot.detail.value,
                      })
                    : Stream.fail(
                        new WsRpcError({
                          message: `Thread detail snapshot not found for thread ${input.threadId}.`,
                          code: "THREAD_SNAPSHOT_NOT_FOUND",
                          retryable: false,
                        }),
                      );
                }),
                trackSidechatVisibility(input.threadId),
              ),
            ),
          ),
        [ORCHESTRATION_WS_METHODS.unsubscribeThread]: () => Effect.void,
        [WS_METHODS.subscribeOrchestrationDomainEvents]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "orchestration.domain-events" },
            bufferLiveUiStream(
              orchestrationEngine.streamDomainEvents.pipe(
                Stream.map(sanitizeOrchestrationEventProviderOptions),
              ),
              {
                label: "orchestration.domain-events",
              },
            ),
          ),

        [WS_METHODS.projectsListDirectories]: (input) =>
          rpcEffect(
            workspaceEntries.listDirectories(input),
            "Failed to list workspace directories",
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          rpcEffect(workspaceEntries.search(input), "Failed to search workspace entries"),
        [WS_METHODS.projectsSearchContent]: (input) =>
          rpcEffect(workspaceEntries.searchContent(input), "Failed to search workspace content"),
        [WS_METHODS.projectsPrewarmSearchIndex]: (input) =>
          rpcEffect(
            workspaceEntries.prewarmSearchIndex(input),
            "Failed to prewarm workspace search index",
          ),
        [WS_METHODS.projectsDiscoverScripts]: (input) =>
          rpcEffect(workspaceEntries.discoverScripts(input), "Failed to discover project scripts"),
        [WS_METHODS.projectsSearchLocalEntries]: (input) =>
          rpcEffect(workspaceEntries.searchLocal(input), "Failed to search local entries"),
        [WS_METHODS.projectsReadFile]: (input) =>
          rpcEffect(workspaceFileSystem.readFile(input), "Failed to read workspace file"),
        [WS_METHODS.projectsSubscribeFileChange]: (input, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: `projects.file-change:${input.cwd}\0${input.relativePath}` },
            watchWorkspaceFile(input).pipe(
              Stream.mapError(
                (cause) =>
                  new WsRpcError({
                    message:
                      cause instanceof Error && cause.message.length > 0
                        ? cause.message
                        : "Failed to watch workspace file",
                    code: "PROJECT_FILE_WATCH_FAILED",
                    retryable: false,
                    cause,
                  }),
              ),
            ),
          ),
        [WS_METHODS.projectsResolveWorkspaceFileReferences]: (input) =>
          rpcEffect(
            workspaceEntries.resolveFileReferences(input),
            "Failed to resolve workspace file references",
          ),
        [WS_METHODS.projectsResolveOutOfRootFileReference]: (input) =>
          rpcEffect(
            Effect.promise(async () => ({
              fullPath: await resolveOutOfRootFileReference({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                homeDir: config.homeDir,
              }),
            })),
            "Failed to resolve file reference outside the workspace",
          ),
        [WS_METHODS.projectsCreateLocalFilePreviewGrant]: (input) =>
          rpcEffect(
            Effect.promise(() => createLocalPreviewGrant({ requestedPath: input.path })),
            "Failed to create local file preview grant",
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError((cause) =>
              cause instanceof WorkspaceFileConflictError
                ? new WsRpcError({
                    message: cause.message,
                    code: WORKSPACE_FILE_WRITE_CONFLICT_CODE,
                    retryable: false,
                  })
                : cause instanceof WorkspaceFileDeletedError
                  ? new WsRpcError({
                      message: cause.message,
                      code: "WORKSPACE_FILE_DELETED",
                      retryable: false,
                    })
                  : toWsRpcError(cause, "Failed to write workspace file"),
            ),
          ),
        [WS_METHODS.projectsRunDevServer]: (input) =>
          rpcEffect(devServerManager.run(input), "Failed to start dev server"),
        [WS_METHODS.projectsStopDevServer]: (input) =>
          rpcEffect(devServerManager.stop(input), "Failed to stop dev server"),
        [WS_METHODS.projectsListDevServers]: () =>
          rpcEffect(devServerManager.list, "Failed to list dev servers"),
        [WS_METHODS.subscribeProjectDevServerEvents]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "projects.dev-servers" },
            Stream.concat(
              Stream.fromEffect(
                devServerManager.list.pipe(
                  Effect.map(
                    (result): ProjectDevServerEvent => ({
                      type: "snapshot",
                      servers: result.servers,
                    }),
                  ),
                ),
              ),
              bufferLiveUiStream(devServerManager.stream, {
                label: "projects.dev-servers",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }),
            ),
          ),
        [WS_METHODS.projectsProvisionFromGitHub]: (input) =>
          bufferLiveUiStream(
            Stream.callback<GitHubProjectProvisionProgressEvent, WsRpcError>((queue) =>
              Effect.gen(function* () {
                const checkout = yield* githubProjectProvisioner.provisionCheckout(input, {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                });
                let registrationCommitted = false;
                const registerCheckout = Effect.gen(function* () {
                  yield* Queue.offer(queue, {
                    operationId: input.operationId,
                    kind: "phase",
                    phase: "registering",
                    message: "Adding project to Moss",
                  });

                  const { command: normalizedCommand, prepareWorkspaceRoot } =
                    yield* normalizeDispatchCommand({
                      command: {
                        type: "project.create",
                        commandId: input.commandId,
                        projectId: input.projectId,
                        kind: "project",
                        title: path.basename(checkout.workspaceRoot),
                        workspaceRoot: checkout.workspaceRoot,
                        createWorkspaceRootIfMissing: false,
                        defaultModelSelection: input.defaultModelSelection,
                        spaceId: input.newProjectSpaceId,
                        createdAt: input.createdAt,
                      },
                    });
                  if (normalizedCommand.type !== "project.create") {
                    return yield* Effect.die(
                      new Error("GitHub project provisioning normalized an unexpected command"),
                    );
                  }

                  const existingProjectId = yield* findRegisteredProjectId(
                    normalizedCommand.workspaceRoot,
                  );
                  // Re-adding an existing checkout opens the existing project as-is. In
                  // particular, it must not silently move that project between Spaces;
                  // newProjectSpaceId applies only when project.create runs below.
                  const registration = existingProjectId
                    ? { projectId: existingProjectId, created: false }
                    : yield* dispatchOrchestrationCommand(normalizedCommand).pipe(
                        Effect.map(() => ({ projectId: input.projectId, created: true })),
                        Effect.catch((cause) =>
                          findRegisteredProjectId(normalizedCommand.workspaceRoot).pipe(
                            Effect.flatMap((racedProjectId) =>
                              racedProjectId
                                ? Effect.succeed({ projectId: racedProjectId, created: false })
                                : Effect.fail(cause),
                            ),
                          ),
                        ),
                      );
                  // This assignment is synchronous, so a pending interruption cannot run
                  // recovery between a successful dispatch and recording that fact.
                  registrationCommitted = true;
                  if (registration.created && prepareWorkspaceRoot) {
                    yield* prepareWorkspaceRoot;
                  }

                  return {
                    operationId: input.operationId,
                    repository: checkout.repository,
                    workspaceRoot: normalizedCommand.workspaceRoot,
                    projectId: registration.projectId,
                    checkout: checkout.checkout,
                  } as const;
                }).pipe(
                  Effect.onError(() =>
                    recoverUnregisteredGitHubCheckout({
                      checkout,
                      registrationCommitted,
                      moveWorkspaceRoot: (workspaceRoot, recoveryPath) =>
                        fileSystem.rename(workspaceRoot, recoveryPath),
                    }),
                  ),
                  // Promotion and registration form one critical section. If the client cancels
                  // after cloning, finish registration first so its workspace is never moved out
                  // from under a committed project. Recovery must share the same guarantee.
                  Effect.uninterruptible,
                );

                const result = yield* registerCheckout;
                yield* Queue.offer(queue, {
                  operationId: input.operationId,
                  kind: "completed",
                  result,
                });
                yield* Queue.end(queue);
              }).pipe(
                Effect.catch((cause) =>
                  Queue.fail(queue, toProjectProvisionRpcError(cause)).pipe(Effect.asVoid),
                ),
              ),
            ),
            { label: "projects.github-provision" },
          ),
        [WS_METHODS.studioListThreadOutputs]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              // Self-heal the container folder tree: an accepted create whose deferred scaffold
              // failed (crash, transient FS error) must not leave the workspace without its Outbox
              // forever. mkdir -p is idempotent and cheap, and this endpoint only fires while
              // a group/studio chat's environment panel is actually open. Failures degrade to the
              // empty-list behavior.
              yield* prepareStudioWorkspaceRoot(config.studioWorkspaceRoot).pipe(
                Effect.catch(() => Effect.void),
              );
              // Checkpoints cover Git workspaces; file-change activities preserve the same
              // attribution in the default non-Git container root. Unknown/non-container ids
              // stay empty.
              const context = yield* projectionReadModelQuery.getThreadCheckpointContext(
                input.threadId,
                { includeFileChangeActivityPayloads: true },
              );
              if (Option.isNone(context) || !isGroupContainerKind(context.value.projectKind)) {
                return { entries: [] };
              }
              const workspaceCwd = resolveThreadWorkspaceCwd({
                thread: {
                  projectId: context.value.projectId,
                  envMode: context.value.envMode,
                  worktreePath: context.value.worktreePath,
                  workingDirectory: context.value.workingDirectory,
                },
                projects: [
                  {
                    id: context.value.projectId,
                    kind: context.value.projectKind,
                    workspaceRoot: context.value.workspaceRoot,
                  },
                ],
              });
              if (!workspaceCwd) {
                return { entries: [] };
              }
              return yield* listStudioThreadOutputs({
                workspaceRoot: workspaceCwd,
                checkpoints: context.value.checkpoints,
                ...(context.value.fileChangeActivityPayloads
                  ? { fileChangeActivityPayloads: context.value.fileChangeActivityPayloads }
                  : {}),
              });
            }),
            "Failed to list studio thread outputs",
          ),
        [WS_METHODS.filesystemBrowse]: (input) =>
          rpcEffect(workspaceEntries.browse(input), "Failed to browse filesystem"),
        [WS_METHODS.dialogsPickFolder]: () =>
          rpcEffect(pickFolderNativeDialog(), "Failed to open the folder picker"),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          rpcEffect(open.openInEditor(input), "Failed to open editor"),

        [WS_METHODS.gitGithubRepository]: (input) =>
          rpcEffect(resolveGitHubRepository(git, input.cwd), "Failed to resolve GitHub repository"),
        [WS_METHODS.gitStatus]: (input) =>
          rpcEffect(gitStatusBroadcaster.getStatus(input), "Failed to read git status"),
        [WS_METHODS.gitReadWorkingTreeDiff]: (input) =>
          rpcEffect(gitManager.readWorkingTreeDiff(input), "Failed to read working tree diff"),
        [WS_METHODS.gitBlameLine]: (input) =>
          rpcEffect(gitManager.blameLine(input), "Failed to read git blame"),
        [WS_METHODS.gitReadFileAtRev]: (input) =>
          rpcEffect(gitManager.readFileAtRev(input), "Failed to read file at revision"),
        [WS_METHODS.gitWorkingTreeDiffStats]: (input) =>
          rpcEffect(
            gitManager.readWorkingTreeDiffStats(input),
            "Failed to read working tree diff stats",
          ),
        [WS_METHODS.gitSummarizeDiff]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings;
              const routing = resolveTextGenerationRouting(settings, input);
              return yield* gitManager.summarizeDiff({
                ...input,
                ...(routing.modelSelection
                  ? { textGenerationModelSelection: routing.modelSelection }
                  : {}),
                ...(routing.providerOptions ? { providerOptions: routing.providerOptions } : {}),
              });
            }),
            "Failed to summarize diff",
          ),
        [WS_METHODS.gitPull]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(
              input.cwd,
              git.withMutation(input.cwd, git.pullCurrentBranch(input.cwd)),
            ),
            "Failed to pull branch",
          ),
        [WS_METHODS.gitRunStackedAction]: runGitAction,
        // Summary lookups gate cache misses inside GitHubCli so fresh badge data stays available.
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          rpcEffect(
            gitManager.resolvePullRequest(input, { background: true }),
            "Failed to resolve pull request",
          ),
        // Uncached snapshot polling shares the inbox read queue and rate-limit pause.
        [WS_METHODS.gitPullRequestSnapshot]: (input) =>
          rpcEffect(
            github.withRead(gitManager.pullRequestSnapshot(input)),
            "Failed to load pull request checks and comments",
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(input.cwd, gitManager.preparePullRequestThread(input)),
            "Failed to prepare pull request thread",
          ),
        [WS_METHODS.githubInboxList]: (input) =>
          pullRequestsEffect(
            githubInbox.list(input),
            "Failed to load GitHub pull requests and issues",
          ),
        [WS_METHODS.githubInboxIssueDetail]: (input) =>
          pullRequestsEffect(githubInbox.issueDetail(input), "Failed to load issue"),
        [WS_METHODS.githubInboxIssueComment]: (input) =>
          pullRequestsEffect(githubInbox.issueComment(input), "Could not post the comment"),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          pullRequestsEffect(pullRequests.detail(input), "Failed to load pull request"),
        [WS_METHODS.pullRequestsDiff]: (input) =>
          pullRequestsEffect(pullRequests.diff(input), "Failed to load pull request diff"),
        [WS_METHODS.pullRequestsAction]: (input) =>
          pullRequestsEffect(pullRequests.action(input), "Pull request action failed"),
        [WS_METHODS.pullRequestsComment]: (input) =>
          pullRequestsEffect(pullRequests.comment(input), "Could not post the comment"),
        [WS_METHODS.pullRequestsSetPinned]: (input) =>
          rpcEffect(pullRequests.setPinned(input), "Failed to update pull request pin"),
        [WS_METHODS.pullRequestsGetAutoFix]: (input) =>
          rpcEffect(pullRequestAutoFix.get(input), "Failed to read Auto-fix CI"),
        [WS_METHODS.pullRequestsSetAutoFix]: (input) =>
          rpcEffect(pullRequestAutoFix.set(input), "Failed to update Auto-fix CI"),
        [WS_METHODS.gitListBranches]: (input) =>
          rpcEffect(git.listBranches(input), "Failed to list branches"),
        [WS_METHODS.gitListRecentCommits]: (input) =>
          rpcEffect(git.listRecentCommits(input), "Failed to list recent commits"),
        [WS_METHODS.gitCreateWorktree]: (input) =>
          rpcEffect(
            refuseMultiFolderProjectWorktree(input.cwd).pipe(
              Effect.andThen(
                refreshGitStatusAfter(
                  input.cwd,
                  git.withMutation(input.cwd, git.createWorktree(input)),
                ),
              ),
            ),
            "Failed to create worktree",
          ),
        [WS_METHODS.gitCreateDetachedWorktree]: (input) =>
          bufferLiveUiStream(
            Stream.callback<GitWorktreeSetupProgressEvent, WsRpcError>((queue) => {
              const progressId = input.progressId ?? null;
              return refuseMultiFolderProjectWorktree(input.cwd)
                .pipe(
                  Effect.andThen(
                    refreshGitStatusAfter(
                      input.cwd,
                      git.withMutation(
                        input.cwd,
                        git.createDetachedWorktree(input, {
                          onPhase: (phase) =>
                            Queue.offer(queue, { kind: "phase_started", progressId, phase }).pipe(
                              Effect.asVoid,
                            ),
                        }),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) =>
                      Queue.fail(queue, toWsRpcError(cause, "Failed to create detached worktree")),
                    onSuccess: (result) =>
                      Queue.offer(queue, { kind: "completed", progressId, result }).pipe(
                        Effect.andThen(Queue.end(queue)),
                        Effect.asVoid,
                      ),
                  }),
                );
            }),
            { label: "git.create-detached-worktree" },
          ),
        [WS_METHODS.gitRemoveWorktree]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(
              input.cwd,
              git.withMutation(
                input.cwd,
                validateArchiveWorktreeRemoval(input).pipe(
                  Effect.andThen(
                    git.removeWorktree(
                      input.archiveCleanup
                        ? { ...input, force: false, reclaimTemporaryBranch: false }
                        : input,
                    ),
                  ),
                  // Automatic archive cleanup preserves recovery data; an
                  // explicit removal discards snapshots and empty directories.
                  Effect.tap(() =>
                    isManagedWorktreePathCanonical({
                      worktreesDir: config.worktreesDir,
                      worktreePath: input.path,
                    }).pipe(
                      Effect.flatMap((managed) =>
                        !managed
                          ? Effect.void
                          : input.archiveCleanup
                            ? discardEmptyManagedWorktreeParent({
                                worktreesDir: config.worktreesDir,
                                worktreePath: input.path,
                              })
                            : discardManagedWorktreeResidue({
                                worktreesDir: config.worktreesDir,
                                snapshotsDir: managedWorktreeSnapshotsDir(config.homeDir),
                                worktreePath: input.path,
                              }),
                      ),
                      Effect.catch(() => Effect.void),
                    ),
                  ),
                ),
              ),
            ),
            "Failed to remove worktree",
          ),
        [WS_METHODS.gitCreateBranch]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(input.cwd, git.withMutation(input.cwd, git.createBranch(input))),
            "Failed to create branch",
          ),
        [WS_METHODS.gitCheckout]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(
              input.cwd,
              git.withMutation(input.cwd, Effect.scoped(git.checkoutBranch(input))),
            ),
            "Failed to checkout branch",
          ),
        [WS_METHODS.gitStashAndCheckout]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(
              input.cwd,
              git.withMutation(input.cwd, Effect.scoped(git.stashAndCheckout(input))),
            ),
            "Failed to stash and checkout",
          ),
        [WS_METHODS.gitStashDrop]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(input.cwd, git.withMutation(input.cwd, git.stashDrop(input))),
            "Failed to drop stash",
          ),
        [WS_METHODS.gitStashInfo]: (input) =>
          rpcEffect(git.stashInfo(input), "Failed to read stash"),
        [WS_METHODS.gitRemoveIndexLock]: (input) =>
          rpcEffect(
            git.withMutation(input.cwd, git.removeIndexLock(input)),
            "Failed to remove Git index lock",
          ),
        [WS_METHODS.gitInit]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(input.cwd, git.withMutation(input.cwd, git.initRepo(input))),
            "Failed to initialize repository",
          ),
        [WS_METHODS.gitStageFiles]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(
              input.cwd,
              git.withMutation(input.cwd, git.stageFiles(input.cwd, input.paths)),
            ).pipe(Effect.as({ ok: true })),
            "Failed to stage files",
          ),
        [WS_METHODS.gitUnstageFiles]: (input) =>
          rpcEffect(
            refreshGitStatusAfter(
              input.cwd,
              git.withMutation(input.cwd, git.unstageFiles(input.cwd, input.paths)),
            ).pipe(Effect.as({ ok: true })),
            "Failed to unstage files",
          ),
        [WS_METHODS.gitHandoffThread]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const { commandId, threadId, ...gitInput } = input;
              const operation = yield* beginGitHandoff(input);
              if (operation.phase === "pending" || operation.phase === "uncertain") {
                return yield* new WsRpcError({
                  message:
                    operation.phase === "pending"
                      ? "This Git handoff is already running."
                      : "This Git handoff was interrupted before its filesystem result became durable; inspect the repository before retrying.",
                });
              }
              if (operation.phase === "completed") return operation.result;

              const result =
                operation.phase === "git_applied"
                  ? operation.result
                  : yield* refreshGitStatusAfter(
                      input.cwd,
                      gitManager.handoffThread(gitInput).pipe(
                        Effect.catch((error) =>
                          discardPendingGitHandoff(commandId).pipe(
                            Effect.catch(() => Effect.void),
                            Effect.andThen(Effect.fail(error)),
                          ),
                        ),
                      ),
                    ).pipe(Effect.tap((gitResult) => recordGitHandoffResult(commandId, gitResult)));
              yield* dispatchOrchestrationCommand(
                gitHandoffMetadataCommand({ commandId, threadId }, result),
              );
              yield* completeGitHandoff(commandId);
              return result;
            }),
            "Failed to hand off thread",
          ),

        [WS_METHODS.terminalOpen]: (input) =>
          rpcEffect(
            resetTerminalTitleBuffer(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID).pipe(
              Effect.andThen(terminalManager.open(input)),
            ),
            "Failed to open terminal",
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          rpcEffect(
            terminalManager.write(input).pipe(
              Effect.tap(() =>
                maybeAutoRenameTerminalThread({
                  threadId: input.threadId,
                  terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
                  data: input.data,
                }).pipe(Effect.catch(() => Effect.void)),
              ),
            ),
            "Failed to write terminal",
          ),
        [WS_METHODS.terminalAckOutput]: (input) =>
          rpcEffect(terminalManager.ackOutput(input), "Failed to acknowledge terminal output"),
        [WS_METHODS.terminalResize]: (input) =>
          rpcEffect(terminalManager.resize(input), "Failed to resize terminal"),
        [WS_METHODS.terminalClear]: (input) =>
          rpcEffect(terminalManager.clear(input), "Failed to clear terminal"),
        [WS_METHODS.terminalRestart]: (input) =>
          rpcEffect(
            resetTerminalTitleBuffer(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID).pipe(
              Effect.andThen(terminalManager.restart(input)),
            ),
            "Failed to restart terminal",
          ),
        [WS_METHODS.terminalClose]: (input) =>
          rpcEffect(
            resetTerminalTitleBuffer(input.threadId, input.terminalId ?? null).pipe(
              Effect.andThen(terminalManager.close(input)),
            ),
            "Failed to close terminal",
          ),
        [WS_METHODS.subscribeTerminalEvents]: (_, { clientId }) =>
          // Terminal output is an ordered byte stream with renderer ACK accounting.
          // Keep this lossless: dropping chunks would create holes until reattach.
          streamAdmission.guard(
            clientId,
            { key: "terminal.events" },
            Stream.callback((queue) =>
              Effect.gen(function* () {
                const unsubscribe = yield* terminalManager.subscribe((event) => {
                  Effect.runFork(Queue.offer(queue, event).pipe(Effect.asVoid));
                });
                yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
              }),
            ),
          ),

        [WS_METHODS.serverGetRuntimeStatus]: () =>
          rpcEffect(readEventLoopStatus, "Failed to read runtime status"),
        [WS_METHODS.serverGetConfig]: () =>
          rpcEffect(loadServerConfig, "Failed to load server config"),
        [WS_METHODS.serverGetEnvironment]: () =>
          rpcEffect(serverEnvironment.getDescriptor, "Failed to load server environment"),
        [WS_METHODS.serverGetSettings]: () =>
          rpcEffect(serverSettings.getSettingsView, "Failed to load server settings"),
        [WS_METHODS.serverUpdateSettings]: (input) =>
          serverUpdateSettingsRpcEffect(serverSettings, input),
        [WS_METHODS.serverRefreshProviders]: () =>
          rpcEffect(
            providerHealth.refresh.pipe(Effect.map((providers) => ({ providers }))),
            "Failed to refresh providers",
          ),
        [WS_METHODS.serverUpdateProvider]: (input) => providerHealth.updateProvider(input),
        [WS_METHODS.serverListExternalMcpIntegrations]: () =>
          rpcEffect(
            requireOwner.pipe(Effect.andThen(externalMcp.listIntegrations())),
            "Failed to list external MCP integrations",
          ),
        [WS_METHODS.serverCreateExternalMcpIntegration]: (input) =>
          rpcEffect(
            requireOwner.pipe(Effect.andThen(externalMcp.createIntegration(input))),
            "Failed to create external MCP integration",
          ),
        [WS_METHODS.serverRevokeExternalMcpIntegration]: (input) =>
          rpcEffect(
            requireOwner.pipe(
              Effect.andThen(externalMcp.revokeIntegration(input.integrationId)),
              Effect.map((revoked) => ({ revoked })),
            ),
            "Failed to revoke external MCP integration",
          ),
        [WS_METHODS.serverRefreshExternalMcpPairing]: (input) =>
          rpcEffect(
            requireOwner.pipe(Effect.andThen(externalMcp.refreshPairing(input))),
            "Failed to refresh external MCP pairing",
          ),
        [WS_METHODS.serverListMcpConnectors]: () =>
          connectorRpc(mcpConnectors.list(), "Failed to list connectors"),
        [WS_METHODS.serverConnectMcpConnector]: (input) =>
          connectorRpc(mcpConnectors.connect(input), "Failed to connect"),
        [WS_METHODS.serverGetMcpConnectorSetup]: () =>
          connectorRpc(mcpConnectors.setup(), "Failed to read connector setup"),
        [WS_METHODS.serverDisconnectMcpConnector]: (input) =>
          connectorRpc(
            mcpConnectors
              .disconnect(input.connectorId)
              .pipe(Effect.map((disconnected) => ({ disconnected }))),
            "Failed to disconnect",
          ),
        [WS_METHODS.mossAppsGetStatus]: () =>
          mossAppsRpc(mcpConnectors.mossApps.status(), "Failed to read Moss Apps status"),
        [WS_METHODS.mossAppsListToolkits]: (input) =>
          mossAppsRpc(mcpConnectors.mossApps.listToolkits(input), "Failed to list apps"),
        [WS_METHODS.mossAppsListConnections]: () =>
          mossAppsRpc(
            mcpConnectors.mossApps
              .listConnections()
              .pipe(Effect.map((connections) => ({ connections }))),
            "Failed to list connected apps",
          ),
        [WS_METHODS.mossAppsConnectFields]: (input) =>
          mossAppsRpc(
            mcpConnectors.mossApps.connectFields(input.toolkitSlug),
            "Failed to load the app's sign-in",
          ),
        [WS_METHODS.mossAppsConnect]: (input) =>
          mossAppsRpc(
            mcpConnectors.mossApps.connect(input.toolkitSlug, input.credentials),
            "Failed to connect app",
          ),
        [WS_METHODS.mossAppsDisconnect]: (input) =>
          mossAppsRpc(
            mcpConnectors.mossApps
              .disconnect(input.connectionId)
              .pipe(Effect.map((disconnected) => ({ disconnected }))),
            "Failed to disconnect app",
          ),
        [WS_METHODS.serverListWorktrees]: () =>
          rpcEffect(
            pruneManagedWorktrees.pipe(Effect.map((worktrees) => ({ worktrees }))),
            "Failed to list managed worktrees",
          ),
        [WS_METHODS.serverListLocalServers]: () =>
          rpcEffect(
            Effect.promise(() => listLocalServers()),
            "Failed to list local servers",
          ),
        [WS_METHODS.serverStopLocalServer]: (input) =>
          rpcEffect(stopLocalServerAndTrackedProjectRun(input), "Failed to stop local server"),
        [WS_METHODS.statsGetProfileStats]: (input) =>
          rpcEffect(profileStatsQuery.getProfileStats(input), "Failed to load profile stats"),
        [WS_METHODS.statsGetProfileTokenStats]: (input) =>
          rpcEffect(
            profileStatsQuery.getProfileTokenStats(input),
            "Failed to load profile token stats",
          ),
        [WS_METHODS.statsGetRecap]: (input) =>
          rpcEffect(recapStatsQuery.getRecap(input), "Failed to load the recap"),
        [WS_METHODS.serverGetProviderUsageSnapshot]: (input) =>
          rpcEffect(getProviderUsageSnapshot(input), "Failed to load provider usage"),
        [WS_METHODS.serverListProviderUsage]: (input) =>
          rpcEffect(listProviderUsage(input), "Failed to load provider usage"),
        [WS_METHODS.serverConsumeCodexResetCredit]: (input) =>
          rpcEffect(consumeCodexResetCreditEffect(input), "Failed to use Codex reset"),
        [WS_METHODS.serverGetDiagnostics]: () =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                Effect.gen(function* () {
                  const [projection, fullChildProcesses] = yield* Effect.all([
                    projectionReadModelQuery.getCounts(),
                    Effect.promise(() => readDescendantProcesses(process.pid)),
                  ]);
                  const memory = process.memoryUsage();
                  const diagnostics: ServerDiagnosticsResult = {
                    generatedAt: new Date().toISOString(),
                    process: {
                      pid: process.pid,
                      uptimeSeconds: Math.max(0, Math.round(process.uptime())),
                      memory: {
                        rssBytes: Math.max(0, Math.round(memory.rss)),
                        heapTotalBytes: Math.max(0, Math.round(memory.heapTotal)),
                        heapUsedBytes: Math.max(0, Math.round(memory.heapUsed)),
                        externalBytes: Math.max(0, Math.round(memory.external)),
                        arrayBuffersBytes: Math.max(0, Math.round(memory.arrayBuffers)),
                      },
                    },
                    childProcesses: fullChildProcesses.slice(0, MAX_DIAGNOSTIC_CHILD_PROCESSES),
                    childProcessTotalCount: fullChildProcesses.length,
                    childProcessTotalRssBytes: fullChildProcesses.reduce(
                      (total, processRow) => total + processRow.rssBytes,
                      0,
                    ),
                    projection,
                  };
                  return diagnostics;
                }),
                "Failed to load server diagnostics",
              ),
            ),
          ),
        [WS_METHODS.serverReadThreadDiagnostics]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(readOwnerThreadDiagnostics(input), "Failed to read thread diagnostics"),
            ),
          ),
        [WS_METHODS.serverPrewarmVoice]: (input) =>
          voiceRpcEffect(
            Effect.gen(function* () {
              const route = yield* resolveAdmittedVoicePrewarmProviderRoute(
                {
                  provider: input.provider,
                  ...(input.providerInstanceId
                    ? { providerInstanceId: input.providerInstanceId }
                    : {}),
                },
                {
                  awaitAccountStartup: runtimeStartup.enqueueRead(Effect.void),
                  getSettings: () => serverSettings.getSettings,
                  getPhoneAuthorityCredential: () =>
                    mossPhoneAccountService.getAuthorityCredential(),
                  getCloudAuthorityCredential: () =>
                    mossCloudAccountService.getAuthorityCredential(),
                  enterpriseKey: mossEnterpriseKeyAccount,
                },
              );
              const adapter = yield* providerAdapterRegistry.getByProvider(route.provider);
              if (!adapter.prewarmVoice)
                return yield* Effect.fail(
                  new Error(`Voice transcription is unavailable for provider '${input.provider}'.`),
                );
              return yield* adapter.prewarmVoice({
                ...input,
                providerInstanceId: route.providerInstanceId,
                ...(route.providerOptions ? { providerOptions: route.providerOptions } : {}),
                ...(route.serverResolvedVoiceRouteAuthority
                  ? { serverResolvedVoiceRouteAuthority: route.serverResolvedVoiceRouteAuthority }
                  : {}),
              });
            }),
            "Voice transcription prewarm failed",
          ),
        [WS_METHODS.serverTranscribeVoice]: (input) =>
          voiceRpcEffect(
            voiceUploadAdmissionGate.run(
              Effect.gen(function* () {
                const route = yield* resolveAdmittedVoiceTranscriptionProviderRoute(
                  {
                    provider: input.provider,
                    ...(input.providerInstanceId
                      ? { providerInstanceId: input.providerInstanceId }
                      : {}),
                  },
                  {
                    awaitAccountStartup: runtimeStartup.enqueueRead(Effect.void),
                    getSettings: () => serverSettings.getSettings,
                    getPhoneAuthorityCredential: () =>
                      mossPhoneAccountService.getAuthorityCredential(),
                    getCloudAuthorityCredential: () =>
                      mossCloudAccountService.getAuthorityCredential(),
                    enterpriseKey: mossEnterpriseKeyAccount,
                  },
                );
                const adapter = yield* providerAdapterRegistry.getByProvider(route.provider);
                if (!adapter.transcribeVoice)
                  return yield* Effect.fail(
                    new Error(
                      `Voice transcription is unavailable for provider '${input.provider}'.`,
                    ),
                  );
                const { providerOptions: _ignoredProviderOptions, ...transcriptionInput } = input;
                return yield* adapter.transcribeVoice({
                  ...transcriptionInput,
                  providerInstanceId: route.providerInstanceId,
                  ...(route.providerOptions ? { providerOptions: route.providerOptions } : {}),
                  ...(route.serverResolvedVoiceRouteAuthority
                    ? { serverResolvedVoiceRouteAuthority: route.serverResolvedVoiceRouteAuthority }
                    : {}),
                });
              }),
            ),
            "Voice transcription failed",
          ),
        [WS_METHODS.serverGenerateThreadRecap]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings;
              const routing = resolveTextGenerationRouting(settings, input);
              return yield* textGeneration.generateThreadRecap({
                cwd: input.cwd,
                newMaterial: input.newMaterial,
                ...(input.previousRecap ? { previousRecap: input.previousRecap } : {}),
                ...(input.currentState ? { currentState: input.currentState } : {}),
                ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
                model: routing.model,
                ...(routing.modelSelection ? { modelSelection: routing.modelSelection } : {}),
                ...(routing.providerOptions ? { providerOptions: routing.providerOptions } : {}),
              });
            }),
            "Failed to generate thread recap",
          ),
        [WS_METHODS.serverGenerateAutomationIntent]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings;
              const routing = resolveTextGenerationRouting(settings, input);
              return yield* textGeneration.generateAutomationIntent({
                cwd: input.cwd,
                message: input.message,
                ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
                nowIso: input.nowIso,
                ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
                model: routing.model,
                ...(routing.modelSelection ? { modelSelection: routing.modelSelection } : {}),
                ...(routing.providerOptions ? { providerOptions: routing.providerOptions } : {}),
              });
            }),
            "Failed to generate automation intent",
          ),
        [WS_METHODS.serverUpsertKeybinding]: (input) =>
          rpcEffect(
            keybindings
              .upsertKeybindingRule(input.rule, input.replacing)
              .pipe(
                Effect.map((keybindingsConfig) => ({ keybindings: keybindingsConfig, issues: [] })),
              ),
            "Failed to update keybinding",
          ),
        [WS_METHODS.serverEditKeybindings]: (input) =>
          rpcEffect(
            keybindings
              .editKeybindings(input.edits)
              .pipe(
                Effect.map((keybindingsConfig) => ({ keybindings: keybindingsConfig, issues: [] })),
              ),
            "Failed to update keybindings",
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.lifecycle" },
            Stream.concat(
              Stream.fromEffect(
                lifecycleEvents.snapshot.pipe(
                  Effect.map((snapshot) =>
                    Array.from(snapshot.events).toSorted(
                      (left, right) => left.sequence - right.sequence,
                    ),
                  ),
                ),
              ).pipe(Stream.flatMap(Stream.fromIterable)),
              bufferLiveUiStream(lifecycleEvents.stream, {
                label: "server.lifecycle",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }),
            ).pipe(
              Stream.map(
                (event): ServerLifecycleStreamEvent =>
                  event.type === "welcome"
                    ? { type: "welcome", payload: event.payload }
                    : event.type === "ready"
                      ? { type: "ready", payload: event.payload }
                      : { type: "maintenance", payload: event.payload },
              ),
            ),
          ),
        [WS_METHODS.subscribeServerConfig]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.config" },
            Stream.concat(
              Stream.fromEffect(
                loadServerConfig.pipe(
                  Effect.map(
                    (config): ServerConfigStreamEvent => ({
                      type: "snapshot" as const,
                      config,
                    }),
                  ),
                ),
              ),
              Stream.merge(
                bufferLiveUiStream(keybindings.streamChanges, {
                  label: "server.keybindings",
                  onDroppedEvents: failLiveUiStreamForSnapshotResync,
                }).pipe(
                  Stream.map((event) => ({
                    type: "configUpdated" as const,
                    payload: { issues: event.issues, providers: [] },
                  })),
                ),
                Stream.merge(
                  bufferLiveUiStream(providerHealth.streamChanges, {
                    label: "server.provider-statuses",
                    onDroppedEvents: failLiveUiStreamForSnapshotResync,
                  }).pipe(
                    Stream.map((providers) => ({
                      type: "providerStatuses" as const,
                      payload: { providers },
                    })),
                  ),
                  bufferLiveUiStream(serverSettings.streamViews, {
                    label: "server.settings",
                    onDroppedEvents: failLiveUiStreamForSnapshotResync,
                  }).pipe(
                    Stream.map((settings) => ({
                      type: "settingsUpdated" as const,
                      payload: { settings },
                    })),
                  ),
                ),
              ),
            ).pipe(Stream.mapError((cause) => toWsRpcError(cause, "Server config stream failed"))),
          ),
        [WS_METHODS.subscribeServerProviderStatuses]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.provider-statuses" },
            Stream.concat(
              Stream.fromEffect(
                providerHealth.getStatuses.pipe(Effect.map((providers) => ({ providers }))),
              ),
              bufferLiveUiStream(providerHealth.streamChanges, {
                label: "server.provider-statuses",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }).pipe(Stream.map((providers) => ({ providers }))),
            ),
          ),
        [WS_METHODS.subscribeServerSettings]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.settings" },
            Stream.concat(
              Stream.fromEffect(
                serverSettings.getSettingsView.pipe(Effect.map((settings) => ({ settings }))),
              ),
              bufferLiveUiStream(serverSettings.streamViews, {
                label: "server.settings",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }).pipe(Stream.map((settings) => ({ settings }))),
            ).pipe(
              Stream.mapError((cause) => toWsRpcError(cause, "Server settings stream failed")),
            ),
          ),
        [WS_METHODS.subscribeServerKeepAwake]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "server.keep-awake" },
            Stream.concat(
              Stream.fromEffect(
                keepAwake.getState.pipe(Effect.map((state) => ({ keepAwake: state }))),
              ),
              bufferLiveUiStream(keepAwake.streamChanges, {
                label: "server.keep-awake",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }).pipe(Stream.map((state) => ({ keepAwake: state }))),
            ).pipe(
              Stream.mapError((cause) => toWsRpcError(cause, "Server keep-awake stream failed")),
            ),
          ),

        [WS_METHODS.providerGetComposerCapabilities]: (input) =>
          rpcEffect(
            providerDiscoveryService.getComposerCapabilities(input),
            "Failed to get composer capabilities",
          ),
        [WS_METHODS.providerCompactThread]: (input) =>
          rpcEffect(providerService.compactThread(input), "Failed to compact thread"),
        [WS_METHODS.providerListCommands]: (input) =>
          rpcEffect(providerDiscoveryService.listCommands(input), "Failed to list commands"),
        [WS_METHODS.providerListSkills]: (input) =>
          rpcEffect(providerDiscoveryService.listSkills(input), "Failed to list skills"),
        [WS_METHODS.providerReadSkill]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const readModel = yield* orchestrationEngine.getReadModel();
              const allowed =
                workspaceRootsEqual(input.cwd, config.cwd) ||
                readModel.projects.some(
                  (project) =>
                    project.kind === "project" &&
                    project.deletedAt === null &&
                    workspaceRootsEqual(project.workspaceRoot, input.cwd),
                );
              if (!allowed) {
                return yield* Effect.fail(
                  new WsRpcError({
                    message: "Skill previews require a registered workspace.",
                    code: "workspace-unregistered",
                  }),
                );
              }
              const portable = yield* Effect.tryPromise(() =>
                discoverSkillsCatalog({
                  cwd: input.cwd,
                  homeDir: config.homeDir,
                  mossBaseDir: config.baseDir,
                  includeDuplicateOrigins: true,
                }),
              );
              const portableMatch = portable.some(
                (skill) =>
                  skill.name === input.name &&
                  nodePath.resolve(skill.path) === nodePath.resolve(input.path),
              );
              const skills = portableMatch
                ? portable
                : (yield* providerDiscoveryService.listSkills({
                    provider: input.provider,
                    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
                    cwd: input.cwd,
                    forceReload: true,
                    includeDisabled: true,
                  })).skills;
              const contents = yield* Effect.tryPromise(() =>
                readRegisteredSkillContent({
                  skills,
                  name: input.name,
                  path: input.path,
                }),
              );
              return { contents };
            }),
            "Failed to read skill instructions",
          ),
        [WS_METHODS.providerListSkillsCatalog]: (input) =>
          rpcEffect(
            Effect.tryPromise(() =>
              discoverSkillsCatalog({
                cwd: input.cwd ?? null,
                homeDir: config.homeDir,
                mossBaseDir: config.baseDir,
                includeDuplicateOrigins: true,
              }),
            ).pipe(
              Effect.map((skills) => ({
                skills,
                mossSkillsDir: mossSkillsDir(config.baseDir),
              })),
            ),
            "Failed to list the skills catalog",
          ),
        [WS_METHODS.providerListPlugins]: (input) =>
          rpcEffect(providerDiscoveryService.listPlugins(input), "Failed to list plugins"),
        [WS_METHODS.providerReadPlugin]: (input) =>
          rpcEffect(providerDiscoveryService.readPlugin(input), "Failed to read plugin"),
        [WS_METHODS.providerListModels]: (input) =>
          rpcEffect(providerDiscoveryService.listModels(input), "Failed to list models"),
        [WS_METHODS.providerListAgents]: (input) =>
          rpcEffect(providerDiscoveryService.listAgents(input), "Failed to list agents"),
        [WS_METHODS.automationList]: (input) =>
          rpcEffect(automationService.list(input), "Failed to list automations"),
        [WS_METHODS.automationGetMemory]: ({ automationId }) =>
          rpcEffect(automationService.getMemory(automationId), "Failed to load automation memory"),
        [WS_METHODS.automationCreate]: (input) =>
          rpcEffect(automationService.create(input), "Failed to create automation"),
        [WS_METHODS.automationUpdate]: (input) =>
          rpcEffect(automationService.update(input), "Failed to update automation"),
        [WS_METHODS.automationDelete]: (input) =>
          rpcEffect(automationService.delete(input), "Failed to delete automation"),
        [WS_METHODS.automationRunNow]: (input) =>
          rpcEffect(automationService.runNow(input), "Failed to run automation"),
        [WS_METHODS.automationCancelRun]: (input) =>
          rpcEffect(automationService.cancelRun(input), "Failed to cancel automation run"),
        [WS_METHODS.automationMarkRunRead]: (input) =>
          rpcEffect(automationService.markRunRead(input), "Failed to update automation run"),
        [WS_METHODS.automationArchiveRun]: (input) =>
          rpcEffect(automationService.archiveRun(input), "Failed to update automation run"),
        [WS_METHODS.automationResolveProposal]: (input) =>
          rpcEffect(
            automationService.resolveProposal(input),
            "Failed to resolve automation proposal",
          ),
        [WS_METHODS.projectAgentGetOverview]: (input) =>
          rpcEffect(
            projectAgentService.getOverview(input, { kind: "user" }),
            "Failed to load project overview",
          ),
        [WS_METHODS.projectAgentListSummaries]: (input) =>
          rpcEffect(
            projectAgentService.listSummaries(input, { kind: "user" }),
            "Failed to list project agents",
          ),
        [WS_METHODS.projectAgentConfigure]: (input) =>
          // Library fields move real directories and remotes; only the owner
          // session may change them. Other configure fields stay user-level.
          (input.libraryPath !== undefined ||
          input.libraryRemoteUrl !== undefined ||
          input.libraryPushOnChange !== undefined
            ? requireWsOwnerSession
            : Effect.void
          ).pipe(
            Effect.andThen(
              rpcEffect(
                projectAgentService.configure(input, { kind: "user" }),
                "Failed to configure project coordinator",
              ),
            ),
          ),
        [WS_METHODS.projectAgentLinkProject]: (input) =>
          rpcEffect(
            projectAgentService.linkProject(input, { kind: "user" }),
            "Failed to link repository",
          ),
        [WS_METHODS.projectAgentUnlinkProject]: (input) =>
          rpcEffect(
            projectAgentService.unlinkProject(input, { kind: "user" }),
            "Failed to unlink repository",
          ),
        [WS_METHODS.projectAgentPauseGroup]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                projectAgentService.pauseGroup(input, { kind: "user" }),
                "Failed to pause hub",
              ),
            ),
          ),
        [WS_METHODS.projectAgentResumeGroup]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                projectAgentService.resumeGroup(input, { kind: "user" }),
                "Failed to resume hub",
              ),
            ),
          ),
        [WS_METHODS.projectAgentArchiveGroup]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                projectAgentService.archiveGroup(input, { kind: "user" }),
                "Failed to archive hub",
              ),
            ),
          ),
        [WS_METHODS.projectAgentUnarchiveGroup]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                projectAgentService.unarchiveGroup(input, { kind: "user" }),
                "Failed to unarchive hub",
              ),
            ),
          ),
        [WS_METHODS.projectAgentRestartCoordinator]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                projectAgentService.restartCoordinator(input, { kind: "user" }),
                "Failed to restart coordinator",
              ),
            ),
          ),
        [WS_METHODS.projectAgentDeleteGroup]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                projectAgentService.deleteGroup(input, { kind: "user" }),
                "Failed to delete hub",
              ),
            ),
          ),
        [WS_METHODS.projectAgentStartGoal]: (input) =>
          rpcEffect(
            projectAgentService.startGoal(input, { kind: "user" }),
            "Failed to start project goal",
          ),
        [WS_METHODS.projectAgentUpdateGoal]: (input) =>
          rpcEffect(
            projectAgentService.updateGoal(input, { kind: "user" }),
            "Failed to update project goal",
          ),
        [WS_METHODS.projectAgentPauseGoal]: (input) =>
          rpcEffect(
            projectAgentService.pauseGoal(input, { kind: "user" }),
            "Failed to pause project goal",
          ),
        [WS_METHODS.projectAgentResumeGoal]: (input) =>
          rpcEffect(
            projectAgentService.resumeGoal(input, { kind: "user" }),
            "Failed to resume project goal",
          ),
        [WS_METHODS.projectAgentStopGoal]: (input) =>
          rpcEffect(
            projectAgentService.stopGoal(input, { kind: "user" }),
            "Failed to stop project goal",
          ),
        [WS_METHODS.projectAgentListTasks]: (input) =>
          rpcEffect(
            projectAgentService.listTasks(input, { kind: "user" }),
            "Failed to list project tasks",
          ),
        [WS_METHODS.projectAgentCreateTask]: (input) =>
          rpcEffect(
            projectAgentService.createTask(input, { kind: "user" }),
            "Failed to create project task",
          ),
        [WS_METHODS.projectAgentUpdateTask]: (input) =>
          rpcEffect(
            projectAgentService.updateTask(input, { kind: "user" }),
            "Failed to update project task",
          ),
        [WS_METHODS.projectAgentListEvidence]: (input) =>
          rpcEffect(
            projectAgentService.listEvidence(input, { kind: "user" }),
            "Failed to list task evidence",
          ),
        [WS_METHODS.projectAgentListThreadIndex]: (input) =>
          rpcEffect(
            projectAgentService.listThreadIndex(input, { kind: "user" }),
            "Failed to list project threads",
          ),
        [WS_METHODS.projectAgentExcludeThread]: (input) =>
          rpcEffect(
            projectAgentService.excludeThread(input, { kind: "user" }),
            "Failed to update thread coverage",
          ),
        [WS_METHODS.projectAgentBackfillSummaries]: (input) =>
          rpcEffect(
            projectAgentService.backfillSummaries(input, { kind: "user" }),
            "Failed to backfill project summaries",
          ),
        [WS_METHODS.projectAgentListActivity]: (input) =>
          rpcEffect(
            projectAgentService.listActivity(input, { kind: "user" }),
            "Failed to list project activity",
          ),
        [WS_METHODS.projectAgentListDocuments]: (input) =>
          rpcEffect(
            projectAgentService.listDocuments(input, { kind: "user" }),
            "Failed to list project documents",
          ),
        [WS_METHODS.projectAgentReadDocument]: (input) =>
          rpcEffect(
            projectAgentService.readDocument(input, { kind: "user" }),
            "Failed to read project document",
          ),
        [WS_METHODS.projectAgentWriteDocument]: (input) =>
          rpcEffect(
            projectAgentService.writeDocument(input, { kind: "user" }),
            "Failed to write project document",
          ),
        [WS_METHODS.projectAgentExportDocuments]: (input) =>
          rpcEffect(
            projectAgentService.exportDocuments(input, { kind: "user" }),
            "Failed to export project documents",
          ),
        [WS_METHODS.projectAgentRefreshDigest]: (input) =>
          rpcEffect(
            projectAgentService.refreshDigest(input, { kind: "user" }),
            "Failed to refresh project digest",
          ),
        [WS_METHODS.projectAgentLibraryList]: (input) =>
          rpcEffect(
            withLibraryRootLock(
              input.projectId,
              Effect.gen(function* () {
                const { root, libraryIsManaged } = yield* resolveGroupLibrary(input.projectId);
                const entries = yield* withLibraryQueue(
                  root,
                  Effect.gen(function* () {
                    yield* ensureLibraryRepo(git, root, input.projectId, {
                      isManaged: libraryIsManaged,
                    });
                    return yield* listLibraryEntries(root, input.relativePath);
                  }),
                );
                return { root, entries };
              }),
            ),
            "Failed to list the hub library",
          ),
        [WS_METHODS.projectAgentLibraryMkdir]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                withLibraryRootLock(
                  input.projectId,
                  Effect.gen(function* () {
                    const { root, agentConfig, libraryIsManaged } = yield* resolveGroupLibrary(
                      input.projectId,
                    );
                    return yield* withLibraryQueue(
                      root,
                      Effect.gen(function* () {
                        yield* ensureLibraryRepo(git, root, input.projectId, {
                          isManaged: libraryIsManaged,
                        });
                        yield* createLibraryDirectory(root, input.relativePath);
                        const { commitSha } = yield* commitLibraryChange(
                          git,
                          root,
                          `Create ${input.relativePath}`,
                        );
                        yield* pushGroupLibraryInBackground(root, agentConfig);
                        return { commitSha };
                      }),
                    );
                  }),
                ),
                "Failed to create the library folder",
              ),
            ),
          ),
        [WS_METHODS.projectAgentLibraryRename]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                withLibraryRootLock(
                  input.projectId,
                  Effect.gen(function* () {
                    const { root, agentConfig, libraryIsManaged } = yield* resolveGroupLibrary(
                      input.projectId,
                    );
                    return yield* withLibraryQueue(
                      root,
                      Effect.gen(function* () {
                        yield* ensureLibraryRepo(git, root, input.projectId, {
                          isManaged: libraryIsManaged,
                        });
                        yield* renameLibraryEntry(root, input.from, input.to);
                        const { commitSha } = yield* commitLibraryChange(
                          git,
                          root,
                          `Rename ${input.from} to ${input.to}`,
                        );
                        yield* pushGroupLibraryInBackground(root, agentConfig);
                        return { commitSha };
                      }),
                    );
                  }),
                ),
                "Failed to rename the library entry",
              ),
            ),
          ),
        [WS_METHODS.projectAgentLibraryDelete]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                withLibraryRootLock(
                  input.projectId,
                  Effect.gen(function* () {
                    const { root, agentConfig, libraryIsManaged } = yield* resolveGroupLibrary(
                      input.projectId,
                    );
                    return yield* withLibraryQueue(
                      root,
                      Effect.gen(function* () {
                        yield* ensureLibraryRepo(git, root, input.projectId, {
                          isManaged: libraryIsManaged,
                        });
                        yield* deleteLibraryEntry(root, input.relativePath);
                        const { commitSha } = yield* commitLibraryChange(
                          git,
                          root,
                          `Delete ${input.relativePath}`,
                        );
                        yield* pushGroupLibraryInBackground(root, agentConfig);
                        return { commitSha };
                      }),
                    );
                  }),
                ),
                "Failed to delete the library entry",
              ),
            ),
          ),
        [WS_METHODS.projectAgentLibraryHistory]: (input) =>
          rpcEffect(
            withLibraryRootLock(
              input.projectId,
              Effect.gen(function* () {
                const { root, libraryIsManaged } = yield* resolveGroupLibrary(input.projectId);
                const commits = yield* withLibraryQueue(
                  root,
                  Effect.gen(function* () {
                    yield* ensureLibraryRepo(git, root, input.projectId, {
                      isManaged: libraryIsManaged,
                    });
                    const relativePath =
                      input.relativePath === undefined
                        ? undefined
                        : yield* normalizeLibraryRelativePath(input.relativePath);
                    return yield* libraryHistory(git, root, relativePath);
                  }),
                );
                return { root, commits };
              }),
            ),
            "Failed to load library history",
          ),
        [WS_METHODS.projectAgentLibraryRestore]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(
              rpcEffect(
                withLibraryRootLock(
                  input.projectId,
                  Effect.gen(function* () {
                    const { root, agentConfig, libraryIsManaged } = yield* resolveGroupLibrary(
                      input.projectId,
                    );
                    return yield* withLibraryQueue(
                      root,
                      Effect.gen(function* () {
                        yield* ensureLibraryRepo(git, root, input.projectId, {
                          isManaged: libraryIsManaged,
                        });
                        const relativePath = yield* normalizeLibraryRelativePath(
                          input.relativePath,
                        );
                        const result = yield* restoreLibraryEntry(
                          git,
                          root,
                          relativePath,
                          input.sha,
                        );
                        yield* pushGroupLibraryInBackground(root, agentConfig);
                        return result;
                      }),
                    );
                  }),
                ),
                "Failed to restore the library entry",
              ),
            ),
          ),
        [WS_METHODS.projectAgentLibraryStatus]: (input) =>
          rpcEffect(
            withLibraryRootLock(
              input.projectId,
              Effect.gen(function* () {
                const { root, agentConfig } = yield* resolveGroupLibrary(input.projectId);
                const pushStatus = yield* readLibraryPushStatus(root);
                return {
                  root,
                  remoteConfigured: typeof agentConfig?.libraryRemoteUrl === "string",
                  lastPushAt: pushStatus.lastPushAt,
                  lastPushError: pushStatus.lastPushError,
                };
              }),
            ),
            "Failed to load library status",
          ),
        [WS_METHODS.projectAgentResolveWorker]: (input) =>
          rpcEffect(
            projectAgentService.resolveWorkerAlert(input, { kind: "user" }),
            "Failed to resolve worker alert",
          ),
        [WS_METHODS.subscribeProjectAgentEvents]: (input, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: `projectAgent.events:${input.projectId}` },
            projectAgentService
              .streamEvents(input)
              .pipe(Stream.mapError((cause) => toWsRpcError(cause, "Project event stream failed"))),
          ),
        [WS_METHODS.subscribeAutomationEvents]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "automation.events" },
            Stream.merge(
              Stream.fromEffect(
                automationService.list({}).pipe(
                  Effect.map(({ definitions, runs, memories }) => ({
                    type: "snapshot" as const,
                    definitions,
                    runs,
                    memories,
                  })),
                ),
              ),
              automationService.streamEvents,
            ).pipe(
              Stream.mapError((cause) => toWsRpcError(cause, "Automation event stream failed")),
            ),
          ),
        // Keep refusal handling for hosts that do not offer Tasks.
        [WS_METHODS.todoList]: () =>
          whenTasksEnabled(rpcEffect(todoService.list(), "Failed to list tasks")),
        [WS_METHODS.todoCreate]: (input) =>
          whenTasksEnabled(rpcEffect(todoService.create(input), "Failed to create task")),
        [WS_METHODS.todoUpdate]: (input) =>
          whenTasksEnabled(rpcEffect(todoService.update(input), "Failed to update task")),
        [WS_METHODS.todoDelete]: (input) =>
          whenTasksEnabled(rpcEffect(todoService.delete(input), "Failed to delete task")),
        [WS_METHODS.secretRequestAnswer]: (input) =>
          secretRequests === undefined
            ? Effect.fail(
                new WsRpcError({
                  message: "Secret requests are unavailable on this server.",
                  code: SECRET_REQUEST_ERROR_CODES.notFound,
                  retryable: false,
                }),
              )
            : secretRequests.answer(input).pipe(
                // Rebuilt without `cause`: nothing from the request rides back to the client.
                Effect.mapError(
                  (error) =>
                    new WsRpcError({
                      message: error.message,
                      code: error.code,
                      retryable: error.code === SECRET_REQUEST_ERROR_CODES.storeFailed,
                    }),
                ),
              ),
        [WS_METHODS.subscribeTodoEvents]: (_, { clientId }) =>
          tasksEnabled
            ? streamAdmission.guard(
                clientId,
                { key: "todo.events" },
                todoService.streamChanges.pipe(
                  Stream.mapError((cause) => toWsRpcError(cause, "Task event stream failed")),
                ),
              )
            : Stream.fail(tasksUnavailableError()),

        // Share with guest: the owner's side. Guests never reach this server directly.
        [GUEST_SHARE_WS_METHODS.create]: (input) =>
          guestShareRpcEffect(
            gateOrchestrationMutationUntilStartup(
              runtimeStartup,
              guestShareService.create(input.threadId),
            ),
          ),
        [GUEST_SHARE_WS_METHODS.close]: (input) =>
          guestShareRpcEffect(
            gateOrchestrationMutationUntilStartup(
              runtimeStartup,
              guestShareService.close(input.threadId),
            ),
          ),
        [GUEST_SHARE_WS_METHODS.resolveMessage]: (input) =>
          guestShareRpcEffect(
            gateOrchestrationMutationUntilStartup(
              runtimeStartup,
              guestShareService.resolveMessage(input),
            ),
          ),
        [GUEST_SHARE_WS_METHODS.subscribe]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "guest-share.events" },
            guestShareService
              .subscribe()
              .pipe(Stream.mapError((cause) => toGuestShareWsRpcError(cause))),
          ),

        [WS_METHODS.pagesSpaces]: (input) =>
          pageRpcEffect(pageOperation((service) => service.spaces(input, LOCAL_PAGES_PRINCIPAL))),
        [WS_METHODS.pagesList]: (input) =>
          pageRpcEffect(pageOperation((service) => service.list(input, LOCAL_PAGES_PRINCIPAL))),
        [WS_METHODS.pagesRead]: (input) =>
          pageRpcEffect(pageOperation((service) => service.read(input, LOCAL_PAGES_PRINCIPAL))),
        [WS_METHODS.pagesVersions]: (input) =>
          pageRpcEffect(pageOperation((service) => service.versions(input, LOCAL_PAGES_PRINCIPAL))),
        [WS_METHODS.pagesComments]: (input) =>
          pageRpcEffect(pageOperation((service) => service.comments(input, LOCAL_PAGES_PRINCIPAL))),
        [WS_METHODS.pagesMutate]: (input) =>
          pageRpcEffect(pageOperation((service) => service.mutate(input, LOCAL_PAGES_PRINCIPAL))),

        // Moss 资料库 local multi-agent index (Codex cloud library mapped to
        // local agent roots; agent source files are read-only).
        [WS_METHODS.libraryList]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const role = yield* CurrentWsSessionRole;
              return yield* listMossMediaLibrary(
                config.stateDir,
                libraryService,
                input,
                role === "owner",
              );
            }),
            "Failed to list library items",
          ),
        [WS_METHODS.librarySync]: () =>
          rpcEffect(libraryService.sync(), "Failed to sync the library index"),
        [WS_METHODS.libraryFavorite]: (input) =>
          rpcEffect(libraryService.favorite(input), "Failed to update library favorites"),
        [WS_METHODS.libraryMove]: (input) =>
          rpcEffect(libraryService.move(input), "Failed to move library items"),
        [WS_METHODS.libraryRename]: (input) =>
          rpcEffect(libraryService.rename(input), "Failed to rename the library item"),
        [WS_METHODS.libraryTrash]: (input) =>
          rpcEffect(libraryService.trash(input), "Failed to trash library items"),
        [WS_METHODS.libraryRestore]: (input) =>
          rpcEffect(libraryService.restore(input), "Failed to restore library items"),
        [WS_METHODS.libraryDelete]: (input) =>
          rpcEffect(
            libraryService.deletePermanently(input),
            "Failed to permanently delete library items",
          ),
        [WS_METHODS.libraryCreateFolder]: (input) =>
          rpcEffect(libraryService.createFolder(input), "Failed to create the library folder"),
        [WS_METHODS.libraryRenameFolder]: (input) =>
          rpcEffect(libraryService.renameFolder(input), "Failed to rename the library folder"),
        [WS_METHODS.libraryDeleteFolder]: (input) =>
          rpcEffect(libraryService.deleteFolder(input), "Failed to delete the library folder"),
        [WS_METHODS.libraryRegister]: (input) =>
          rpcEffect(libraryService.register(input), "Failed to register library items"),
        [WS_METHODS.libraryImport]: (input) =>
          rpcEffect(libraryService.importFiles(input), "Failed to import library files"),

        [WS_METHODS.computerHistoryGetState]: () =>
          rpcEffect(
            Effect.promise(() => computerHistory.getState()),
            "Failed to load Computer History state",
          ),
        [WS_METHODS.computerHistoryGetSettings]: () =>
          rpcEffect(
            Effect.promise(() => computerHistory.getSettings()),
            "Failed to load Computer History settings",
          ),
        [WS_METHODS.computerHistoryUpdateSettings]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.updateSettings(input)),
            "Failed to update Computer History settings",
          ),
        [WS_METHODS.computerHistoryListApplications]: () =>
          rpcEffect(
            Effect.promise(() => computerHistory.listApplications()),
            "Failed to list Computer History applications",
          ),
        [WS_METHODS.computerHistoryResolveApplications]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.resolveApplications(input)),
            "Failed to resolve Computer History applications",
          ),
        [WS_METHODS.computerHistorySetEnabled]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.setEnabled(input)),
            "Failed to update Computer History lifecycle",
          ),
        [WS_METHODS.computerHistoryRetryActivation]: () =>
          rpcEffect(
            Effect.promise(() => computerHistory.retryActivation()),
            "Failed to retry Computer History activation",
          ),
        [WS_METHODS.computerHistoryPause]: () =>
          rpcEffect(
            Effect.promise(() => computerHistory.pause()),
            "Failed to pause Computer History",
          ),
        [WS_METHODS.computerHistoryResume]: () =>
          rpcEffect(
            Effect.promise(() => computerHistory.resume()),
            "Failed to resume Computer History",
          ),
        [WS_METHODS.computerHistoryListHistory]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.listHistory(input)),
            "Failed to load Computer History",
          ),
        [WS_METHODS.computerHistoryListSuggestions]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.listHistorySuggestions(input)),
            "Failed to load Computer History suggestions",
          ),
        [WS_METHODS.computerHistoryListSummaryIntervals]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.listHistorySummaryIntervals(input)),
            "Failed to load Computer History summaries",
          ),
        [WS_METHODS.computerHistoryRevealInFinder]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.revealInFinder(input)),
            "Failed to reveal Computer History in Finder",
          ),
        [WS_METHODS.computerHistoryClearHistory]: (input) =>
          rpcEffect(
            Effect.promise(() => computerHistory.clearHistory(input)),
            "Failed to clear Computer History",
          ),
        [WS_METHODS.serverWorkspaceImportProbe]: (input) =>
          rpcEffect(workspaceImport.probe(input), "Failed to probe workspace import"),
        [WS_METHODS.serverWorkspaceImportApply]: (input) =>
          rpcEffect(workspaceImport.apply(input), "Failed to apply workspace import"),
        [WS_METHODS.serverWorkspaceImportSync]: (input) =>
          rpcEffect(workspaceImport.sync(input), "Failed to update workspace import sync"),
        [WS_METHODS.serverStartProviderLogin]: (input) => providerHealth.startLogin(input),
        [WS_METHODS.serverCancelProviderLogin]: (input) => providerHealth.cancelLogin(input),
        [WS_METHODS.providerListMcp]: (input) =>
          rpcEffect(providerDiscoveryService.listMcp(input), "Failed to list MCP servers"),
        [WS_METHODS.providerAddMarketplace]: (input) =>
          rpcEffect(providerDiscoveryService.addMarketplace(input), "Failed to add marketplace"),
        [WS_METHODS.providerRemoveMarketplace]: (input) =>
          rpcEffect(
            providerDiscoveryService.removeMarketplace(input),
            "Failed to remove marketplace",
          ),
        [WS_METHODS.providerUpgradeMarketplace]: (input) =>
          rpcEffect(
            providerDiscoveryService.upgradeMarketplace(input),
            "Failed to upgrade marketplace",
          ),
        [WS_METHODS.providerInstallPlugin]: (input) =>
          rpcEffect(providerDiscoveryService.installPlugin(input), "Failed to install plugin"),
        [WS_METHODS.providerUninstallPlugin]: (input, { clientId }) =>
          rpcEffect(
            withProviderProjectionAuthority(
              input,
              String(clientId),
              providerDiscoveryService.uninstallPlugin(input),
            ),
            "Failed to uninstall plugin",
          ),
        [WS_METHODS.providerSetPluginEnabled]: (input, { clientId }) =>
          rpcEffect(
            withProviderProjectionAuthority(
              input,
              String(clientId),
              providerDiscoveryService.setPluginEnabled(input),
            ),
            "Failed to configure plugin",
          ),
        [WS_METHODS.providerListApps]: (input) =>
          rpcEffect(providerDiscoveryService.listApps(input), "Failed to list apps"),
        [WS_METHODS.providerSetAppEnabled]: (input) =>
          rpcEffect(providerDiscoveryService.setAppEnabled(input), "Failed to configure app"),
        [WS_METHODS.providerReadAppTools]: (input) =>
          rpcEffect(providerDiscoveryService.readAppTools(input), "Failed to read app tools"),
        [WS_METHODS.providerReadAppConnector]: (input) =>
          rpcEffect(
            providerDiscoveryService.readAppConnector(input),
            "Failed to read app connector",
          ),
        [WS_METHODS.providerReadAppConnectorTerms]: (input) =>
          rpcEffect(
            providerDiscoveryService.readAppConnectorTerms(input),
            "Failed to read app connector terms",
          ),
        [WS_METHODS.providerStartAppConnection]: (input) =>
          rpcEffect(providerDiscoveryService.startAppConnection(input), "Failed to connect app"),
        [WS_METHODS.providerCompleteAppConnection]: (input) =>
          rpcEffect(
            providerDiscoveryService.completeAppConnection(input),
            "Failed to complete app login",
          ),
        [WS_METHODS.providerCatalogSelection]: (input) =>
          rpcEffect(
            Effect.gen(function* () {
              const principal = yield* CurrentManagedAttachmentPrincipal;
              if (principal.ownerKind !== "session") {
                return yield* Effect.fail(
                  new WsRpcError({
                    message:
                      "An authenticated session principal is required for catalog selection.",
                    code: "authorization-required",
                  }),
                );
              }
              const readModel = yield* orchestrationEngine.getReadModel();
              const registeredProjects = readModel.projects.filter(
                (project) => project.kind === "project" && project.deletedAt === null,
              );
              refreshServerWorkspaceAuthorization(principal.ownerId, registeredProjects);
              const currentProject =
                registeredProjects.find((project) =>
                  workspaceRootsEqual(project.workspaceRoot, config.cwd),
                ) ?? (registeredProjects.length === 1 ? registeredProjects[0] : undefined);
              if (!currentProject) {
                return yield* Effect.fail(
                  new WsRpcError({
                    message: "Catalog selection needs one server-registered current workspace.",
                    code: "workspace-unregistered",
                  }),
                );
              }
              const workspace = yield* Effect.try({
                try: () =>
                  mossWorkspaceRegistry.resolve({
                    role: "client",
                    ownerId: principal.ownerId,
                    cwd: currentProject.workspaceRoot,
                    workspaceId: currentProject.id,
                    mutation: false,
                    projects: registeredProjects.map((project) => ({
                      id: project.id,
                      workspaceRoot: project.workspaceRoot,
                      deletedAt: project.deletedAt,
                    })),
                  }),
                catch: (cause) =>
                  new WsRpcError({
                    message: "Catalog selection workspace is not authorized.",
                    code:
                      cause instanceof Error ? "authorization-required" : "workspace-unregistered",
                    cause,
                  }),
              });
              return yield* Effect.tryPromise(() =>
                catalogSelectionRpc.select(input, {
                  actorId: workspace.ownerId,
                  workspaceId: workspace.workspaceId,
                  workspaceRoot: workspace.cwd,
                }),
              );
            }),
            "Failed to attest catalog selection",
          ),
        [WS_METHODS.providerResourceImportInventory]: (input, { clientId }) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const workspace = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                mutation: false,
                ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace,
                connectionId: String(clientId),
              });
              yield* requireMossProjectionAuthorityLive(authority.authority);
              return yield* Effect.tryPromise(() =>
                inventoryMossResourceImport({
                  cwd: workspace.cwd,
                  ...(input.providers !== undefined ? { providers: input.providers } : {}),
                  ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
                  ...(input.localSource !== undefined ? { localSource: input.localSource } : {}),
                  homeDir: config.homeDir,
                  stateDir: authority.stateDir,
                  ownerId: workspace.ownerId,
                  workspaceId: workspace.workspaceId,
                  projectId: workspace.workspaceId,
                  principalId: workspace.ownerId,
                  issuer: authority.binding.issuer,
                  sessionId: authority.sessionId,
                  ...(authority.authority
                    ? { ownershipStore: authority.authority.canonicalAuthority.ownershipStore }
                    : {}),
                }),
              );
            }),
            "Failed to inventory provider resources",
          ),
        [WS_METHODS.providerResourceImportPlan]: (input, { clientId }) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const workspace = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                mutation: false,
                ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace,
                connectionId: String(clientId),
              });
              yield* requireMossProjectionAuthorityLive(authority.authority);
              return yield* Effect.tryPromise(() =>
                planMossResourceImport({
                  cwd: workspace.cwd,
                  ...(input.resourceIds !== undefined ? { resourceIds: input.resourceIds } : {}),
                  ...(input.providers !== undefined ? { providers: input.providers } : {}),
                  ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
                  ...(input.selectionOrigin !== undefined
                    ? { selectionOrigin: input.selectionOrigin }
                    : {}),
                  ...(input.selectionTicket !== undefined
                    ? { selectionTicket: input.selectionTicket }
                    : {}),
                  ...(input.localSource !== undefined ? { localSource: input.localSource } : {}),
                  ...(input.selectionTicket
                    ? { selectionTicketVerifier: catalogSelectionTicketVerifier }
                    : {}),
                  homeDir: config.homeDir,
                  stateDir: authority.stateDir,
                  ownerId: workspace.ownerId,
                  workspaceId: workspace.workspaceId,
                  projectId: workspace.workspaceId,
                  principalId: workspace.ownerId,
                  issuer: authority.binding.issuer,
                  sessionId: authority.sessionId,
                  ...(authority.authority
                    ? { ownershipStore: authority.authority.canonicalAuthority.ownershipStore }
                    : {}),
                }),
              );
            }),
            "Failed to plan provider resource import",
          ),
        ...resourceImportMutationRpcHandlers,
        [WS_METHODS.providerPrepareMossResourceMutation]: (input, { clientId }) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const projectId = yield* findRegisteredProjectId(input.cwd);
              if (!projectId) {
                return yield* Effect.fail(
                  new WsRpcError({
                    message: "A registered workspace is required for canonical mutation planning.",
                    code: "workspace-unregistered",
                  }),
                );
              }
              const authorization = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                workspaceId: projectId,
                mutation: true,
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace: authorization,
                connectionId: String(clientId),
              });
              if (!authority.authority) {
                return yield* Effect.fail(
                  new WsRpcError({
                    message: "Canonical mutation planning requires a server-owned authority.",
                    code: "durability-unsupported",
                  }),
                );
              }
              yield* requireMossProjectionAuthorityLive(authority.authority);
              validateCanonicalResourcePathHint(input);
              const { action, ...payload } = input;
              const plan = yield* Effect.tryPromise(() =>
                issueMossCanonicalMutationPlan({
                  ownershipStore: authority.authority!.canonicalAuthority.ownershipStore,
                  stateDir: authority.authority!.canonicalAuthority.stateDir,
                  scope: {
                    cwd: authorization.cwd,
                    issuer: authority.binding.issuer,
                    ownerId: authorization.ownerId,
                    projectId: authorization.workspaceId,
                    principalId: authorization.ownerId,
                    sessionId: authority.sessionId,
                    workspaceId: authorization.workspaceId,
                  },
                  action,
                  payload,
                }),
              );
              return {
                planId: plan.planId,
                operationId: plan.operationId,
                planHash: plan.planHash,
                expiresAt: plan.expiresAt,
              } satisfies MossCanonicalResourceMutationPlanResult;
            }),
            "Failed to prepare the Moss resource mutation",
          ),
        [WS_METHODS.providerCreateMossResource]: (input, { clientId }) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const projectId = yield* findRegisteredProjectId(input.cwd);
              if (!projectId) {
                return yield* Effect.fail(
                  new WsRpcError({
                    message: "A registered workspace is required for canonical mutation.",
                    code: "workspace-unregistered",
                  }),
                );
              }
              const authorization = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                workspaceId: projectId,
                mutation: true,
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace: authorization,
                connectionId: String(clientId),
              });
              const mutation = canonicalResourceMutationForAuthority(authority.authority);
              return yield* mutation.create(input, {
                cwd: authorization.cwd,
                ownerId: authorization.ownerId,
                projectId: authorization.workspaceId,
                workspaceId: authorization.workspaceId,
                principalId: authorization.ownerId,
                sessionId: authority.sessionId,
                issuer: authority.binding.issuer,
              });
            }),
            "Failed to create the Moss resource",
          ),
        [WS_METHODS.providerDeleteMossResource]: (input, { clientId }) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const projectId = yield* findRegisteredProjectId(input.cwd);
              if (!projectId) {
                return yield* Effect.fail(
                  new WsRpcError({
                    message: "A registered workspace is required for canonical mutation.",
                    code: "workspace-unregistered",
                  }),
                );
              }
              const authorization = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                workspaceId: projectId,
                mutation: true,
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace: authorization,
                connectionId: String(clientId),
              });
              const mutation = canonicalResourceMutationForAuthority(authority.authority);
              return yield* mutation.delete(input, {
                cwd: authorization.cwd,
                ownerId: authorization.ownerId,
                projectId: authorization.workspaceId,
                workspaceId: authorization.workspaceId,
                principalId: authorization.ownerId,
                sessionId: authority.sessionId,
                issuer: authority.binding.issuer,
              });
            }),
            "Failed to remove the Moss resource",
          ),
        [WS_METHODS.providerUpdateMossResource]: (input, { clientId }) =>
          resourceImportRpcEffect(
            Effect.gen(function* () {
              const projectId = yield* findRegisteredProjectId(input.cwd);
              if (!projectId) {
                return yield* Effect.fail(
                  new WsRpcError({
                    message: "A registered workspace is required for canonical mutation.",
                    code: "workspace-unregistered",
                  }),
                );
              }
              const authorization = yield* resolveResourceImportWorkspace({
                cwd: input.cwd,
                workspaceId: projectId,
                mutation: true,
              });
              const authority = yield* resolveResourceImportAuthority({
                workspace: authorization,
                connectionId: String(clientId),
              });
              const mutation = canonicalResourceMutationForAuthority(authority.authority);
              return yield* mutation.update(input, {
                cwd: authorization.cwd,
                ownerId: authorization.ownerId,
                projectId: authorization.workspaceId,
                workspaceId: authorization.workspaceId,
                principalId: authorization.ownerId,
                sessionId: authority.sessionId,
                issuer: authority.binding.issuer,
              });
            }),
            "Failed to update the Moss resource",
          ),
        [WS_METHODS.providerListSessions]: () =>
          rpcEffect(
            providerService.listSessions().pipe(Effect.map((sessions) => ({ sessions }))),
            "Failed to list provider sessions",
          ),
        [WS_METHODS.providerGetLaunchPlan]: (input) =>
          rpcEffect(providerService.getLaunchPlan(input), "Failed to get launch plan"),
        [WS_METHODS.providerGetLoopLedgerDashboardSnapshot]: (input) =>
          rpcEffect(
            providerService.getLoopLedgerDashboardSnapshot(input),
            "Failed to get loop-ledger dashboard snapshot",
          ),
        [WS_METHODS.providerSubmitPermissionAction]: (input: ProviderSubmitPermissionActionInput) =>
          rpcEffect(
            providerService.submitPermissionAction(input),
            "Failed to submit permission action",
          ),
        [WS_METHODS.providerSubscribeNormalizedSessionEvents]: (input) =>
          bufferLiveUiStream(providerService.streamNormalizedEventsWithReplay(input), {
            label: "provider.normalized-session-events",
            onDroppedEvents: failLiveUiStreamForSnapshotResync,
          }).pipe(
            Stream.mapError((cause) =>
              toWsRpcError(cause, "Provider normalized event stream failed"),
            ),
          ),
        ...makeMossEnterpriseKeyRpcHandlers(mossEnterpriseKeyAccount),
        ...makeMossPhoneAccountRpcHandlers(mossPhoneAccountService),
        [WS_METHODS.serverMossAccountSelectRealm]: (input: MossAccountSelectRealmInput) =>
          input.realm === "cn"
            ? mossPhoneAccountService.activateRealm
              ? rpcEffect(
                  mossPhoneAccountService.activateRealm(input),
                  "Failed to select Moss account realm",
                )
              : Effect.fail(
                  new WsRpcError({
                    message: "The cn account realm is unavailable.",
                    code: "ACCOUNT_REALM_UNAVAILABLE",
                    retryable: false,
                  }),
                )
            : mossCloudAccountService.activateRealm
              ? rpcEffect(
                  mossCloudAccountService.activateRealm(input),
                  "Failed to select Moss account realm",
                )
              : Effect.fail(
                  new WsRpcError({
                    message: "The global account realm is unavailable.",
                    code: "ACCOUNT_REALM_UNAVAILABLE",
                    retryable: false,
                  }),
                ),
        ...makeMossCloudAccountRpcHandlers(mossCloudAccountService),
        ...makeMossPayRpcHandlers(mossPayService),
        ...makeRealtimeVoiceRpcHandlers(realtimeVoiceService),
        [WS_METHODS.realtimeVoiceSubscribe]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "realtime.voice" },
            Stream.concat(
              Stream.fromEffect(
                realtimeVoiceService.getState.pipe(
                  Effect.map((state) => ({
                    type: "state" as const,
                    sessionId: state.sessionId,
                    threadId: state.threadId,
                    createdAt: new Date().toISOString(),
                    state,
                  })),
                ),
              ),
              bufferLiveUiStream(realtimeVoiceService.events, {
                label: "realtime.voice",
                onDroppedEvents: failLiveUiStreamForSnapshotResync,
              }),
            ),
          ),

        ...makeWsDeviceHandlers(deviceService),
        [DEVICE_WS_METHODS.subscribeEvents]: (_, { clientId }) =>
          streamAdmission.guard(
            clientId,
            { key: "device.events" },
            // Device pushes are lossy by design: thread state is a versioned
            // full snapshot, so a client that falls behind converges on the
            // next one rather than needing every intermediate state.
            //
            // `Stream.never`, not `Stream.empty`, where no device engine can
            // run. This is an infinite subscription, and the client treats one
            // that completes as a zombie socket: it forces a full reconnect to
            // recover it, and an empty stream completes instantly, so the pair
            // loops. That churn restarts every other subscription with it,
            // which is how unrelated RPCs began missing their replies on Linux
            // CI. Staying open and silent is what "no events will ever arrive"
            // actually means.
            //
            // Gated on `supported`, not just on the service existing: the layer
            // is provided on every platform so callers need not branch on null,
            // and off darwin it resolves to a service whose backend reports
            // unsupported-platform. `makeWsDeviceHandlers` already branches the
            // same way.
            deviceService?.supported !== true
              ? Stream.never
              : bufferLiveUiStream(
                  Stream.callback<DeviceEvent>((queue) =>
                    Effect.gen(function* () {
                      const unsubscribe = deviceService.manager.onEvent((event) => {
                        Effect.runFork(Queue.offer(queue, event).pipe(Effect.asVoid));
                      });
                      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
                    }),
                  ),
                  { label: "device.events" },
                ),
          ),

        ...computerHandlers,
        [COMPUTER_WS_METHODS.getAuditHistory]: (input) =>
          requireWsOwnerSession.pipe(
            Effect.andThen(computerHandlers[COMPUTER_WS_METHODS.getAuditHistory](input)),
          ),
        [COMPUTER_WS_METHODS.getThreadState]: (input, { headers }) =>
          Effect.suspend(() => {
            computerInterests.watch(
              Headers.get(headers, WS_CONNECTION_SESSION_HEADER),
              input.threadId,
            );
            return computerHandlers[COMPUTER_WS_METHODS.getThreadState](input);
          }),
        [COMPUTER_WS_METHODS.subscribeEvents]: (_, { clientId, headers }) =>
          streamAdmission.guard(
            clientId,
            { key: "computer.events" },
            computerService?.supported !== true
              ? Stream.never
              : bufferLiveUiStream(
                  Stream.callback<ComputerEvent>((queue) =>
                    Effect.gen(function* () {
                      const connectionKey = Headers.get(headers, WS_CONNECTION_SESSION_HEADER);
                      const unsubscribe = computerInterests.subscribe(
                        connectionKey,
                        computerService.manager.onEvent.bind(computerService.manager),
                        (event) => {
                          Effect.runFork(Queue.offer(queue, event).pipe(Effect.asVoid));
                        },
                      );
                      // Socket cleanup owns interests; a stream retry only
                      // replaces its listener and must retain every live view.
                      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
                    }),
                  ),
                  { label: "computer.events" },
                ),
          ),
      };

      // Keep the wire connection alive when the client and this server are
      // temporarily out of sync on a newly added RPC.  RpcServer treats a
      // missing handler as a defect and closes the entire WebSocket (which
      // also drops unrelated lifecycle/welcome streams).  Return a typed RPC
      // failure for an unimplemented method instead; callers can surface or
      // retry that method while the rest of the session remains usable.
      const completeHandlers = handlers as Record<string, unknown>;
      for (const [method, rpc] of AdmittedWsFeatureRpcGroup.requests) {
        if (completeHandlers[method] !== undefined) continue;
        const failure = new WsRpcError({
          message: `RPC method '${method}' is unavailable on this server build.`,
          code: "RPC_METHOD_UNAVAILABLE",
          retryable: false,
        });
        completeHandlers[method] = RpcSchema.isStreamSchema(rpc.successSchema)
          ? () => Stream.fail(failure)
          : () => Effect.fail(failure);
      }
      // Account credentials, provider login, payment, enterprise keys, and realtime
      // voice are host-global mutations.  They must be owned by the desktop
      // connection even when the caller is a remote client role.  Apply this
      // at the final registry boundary so restored handler helpers cannot
      // accidentally bypass the authorization policy.
      const ownerOnlyMethods = new Set([
        WS_METHODS.serverMossAccountSession,
        WS_METHODS.serverMossAccountSelectRealm,
        WS_METHODS.serverMossAccountStartPhoneLogin,
        WS_METHODS.serverMossAccountVerifyPhoneLogin,
        WS_METHODS.serverMossAccountLogout,
        WS_METHODS.serverMossCloudAccountState,
        WS_METHODS.serverMossCloudAccountList,
        WS_METHODS.serverMossCloudAccountSelect,
        WS_METHODS.serverMossCloudAccountRemove,
        WS_METHODS.serverMossCloudAccountSignUp,
        WS_METHODS.serverMossCloudAccountSignIn,
        WS_METHODS.serverMossCloudAccountRefresh,
        WS_METHODS.serverMossCloudAccountStartGoogleOAuth,
        WS_METHODS.serverMossCloudAccountExchangeGoogleOAuthCode,
        WS_METHODS.serverMossCloudAccountRequestPasswordReset,
        WS_METHODS.serverMossCloudAccountExchangeCode,
        WS_METHODS.serverMossCloudAccountUpdatePassword,
        WS_METHODS.serverMossCloudAccountLogout,
        WS_METHODS.serverMossEnterpriseKeyState,
        WS_METHODS.serverMossEnterpriseKeySignIn,
        WS_METHODS.serverMossEnterpriseKeyActivate,
        WS_METHODS.serverMossEnterpriseKeySignOut,
        WS_METHODS.serverMossPayCatalog,
        WS_METHODS.serverMossPayQuota,
        WS_METHODS.serverMossPayCreateOrder,
        WS_METHODS.serverMossPayGetOrder,
        WS_METHODS.serverUpdateSettings,
        WS_METHODS.serverStartProviderLogin,
        WS_METHODS.serverCancelProviderLogin,
        WS_METHODS.serverRefreshProviders,
        WS_METHODS.serverUpdateProvider,
        WS_METHODS.providerReadSkill,
        WS_METHODS.providerAddMarketplace,
        WS_METHODS.providerRemoveMarketplace,
        WS_METHODS.providerUpgradeMarketplace,
        WS_METHODS.providerInstallPlugin,
        WS_METHODS.providerUninstallPlugin,
        WS_METHODS.providerSetPluginEnabled,
        WS_METHODS.providerSetAppEnabled,
        WS_METHODS.providerStartAppConnection,
        WS_METHODS.providerCompleteAppConnection,
        WS_METHODS.computerHistoryUpdateSettings,
        WS_METHODS.computerHistorySetEnabled,
        WS_METHODS.computerHistoryRetryActivation,
        WS_METHODS.computerHistoryPause,
        WS_METHODS.computerHistoryResume,
        WS_METHODS.computerHistoryRevealInFinder,
        WS_METHODS.computerHistoryClearHistory,
        WS_METHODS.realtimeVoiceListVoices,
        WS_METHODS.realtimeVoiceClaim,
        WS_METHODS.realtimeVoiceReleaseClaim,
        WS_METHODS.realtimeVoiceStart,
        WS_METHODS.realtimeVoiceReportClientState,
        WS_METHODS.realtimeVoiceResolveScreenContext,
        WS_METHODS.realtimeVoiceAppendText,
        WS_METHODS.realtimeVoiceAppendSpeech,
        WS_METHODS.realtimeVoiceStop,
        WS_METHODS.realtimeVoiceGetState,
        WS_METHODS.realtimeVoiceSubscribe,
      ]);
      for (const method of ownerOnlyMethods) {
        const handler = completeHandlers[method];
        const rpc = AdmittedWsFeatureRpcGroup.requests.get(method);
        if (typeof handler !== "function" || !rpc) continue;
        completeHandlers[method] = (input: unknown, options: unknown) => {
          return RpcSchema.isStreamSchema(rpc.successSchema)
            ? Stream.unwrap(
                requireOwnerRole.pipe(
                  // Do not invoke the underlying handler until authorization
                  // succeeds.  Some handlers allocate sessions or mutate
                  // host state as part of construction.
                  Effect.andThen(
                    Effect.sync(
                      () =>
                        (handler as (input: unknown, options: unknown) => unknown)(
                          input,
                          options,
                        ) as Stream.Stream<unknown, unknown, never>,
                    ),
                  ),
                ),
              )
            : ownerOnlyWsRpcHandler(
                handler as (
                  input: unknown,
                  options: unknown,
                ) => Effect.Effect<unknown, unknown, never>,
                requireOwnerRole,
              )(input, options);
        };
      }
      return (AdmittedWsFeatureRpcGroup.of as unknown as (handlers: unknown) => any)(
        completeHandlers,
      );
    }),
  );

export const makeWsRpcLayer = () =>
  Layer.merge(makeWsRpcHandlersLayer(), wsRequestAdmissionMiddlewareLayer);

const makeRpcWebSocketHttpEffect = Effect.gen(function* () {
  // Keep handler-owned jobs alive for the HTTP server lifetime. Effect.provide
  // with a Layer would close its build scope as soon as this constructor returns.
  const handlers = yield* Layer.buildWithScope(
    makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson)),
    yield* Effect.scope,
  );
  return yield* RpcServer.toHttpEffectWebsocket(AdmittedWsFeatureRpcGroup, {
    spanPrefix: "ws.rpc",
    spanAttributes: {
      "rpc.transport": "websocket",
      "rpc.system": "effect-rpc",
    },
    // JSON keeps the wire format symmetric with any web build. A serialization
    // mismatch on this single multiplexed socket is a hard connect failure, and the
    // desktop/dev setup routinely runs server and web on independently-built copies.
  }).pipe(Effect.provide(handlers));
});

const makeBootstrapWebSocketHttpEffect = RpcServer.toHttpEffectWebsocket(WsBootstrapRpcGroup, {
  spanPrefix: "ws.bootstrap",
  spanAttributes: {
    "rpc.transport": "websocket",
    "rpc.system": "effect-rpc",
  },
}).pipe(
  Effect.provide(
    WsBootstrapRpcGroup.toLayer(
      Effect.succeed(
        WsBootstrapRpcGroup.of({
          [WS_BOOTSTRAP_METHOD]: negotiateWsCompatibility,
        }),
      ),
    ).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
  ),
);

function trustedWebSocketRequestUrl(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerConfigShape,
): URL | null {
  const url = HttpServerRequest.toURL(request);
  return url &&
    !shouldRejectUntrustedRequestOrigin({
      rawOrigin: request.headers.origin,
      requestOrigin: url.origin,
      config,
    })
    ? url
    : null;
}

export function authenticateRpcWebSocketUpgrade(input: {
  readonly config: Pick<ServerConfigShape, "authToken" | "host" | "publicUrl">;
  readonly legacyToken: string | null;
  readonly request: AuthRequest;
  readonly serverAuth: Pick<ServerAuthShape, "authenticateWebSocketUpgrade">;
}): Effect.Effect<AuthenticatedSession | null, AuthError> {
  if (
    !requiresWebSocketAuthentication(input.config) ||
    (isLoopbackHost(input.config.host) &&
      !input.config.publicUrl &&
      input.legacyToken === input.config.authToken)
  ) {
    return Effect.succeed(null);
  }
  return input.serverAuth.authenticateWebSocketUpgrade(input.request);
}

/**
 * Apply the feature socket's authentication policy to the separate device
 * frame socket. The desktop bridge still supplies the loopback-only legacy
 * `?token=` credential, so this path must share the same compatibility rule as
 * the RPC socket rather than calling ServerAuth directly.
 */
export function authorizeDeviceFrameWebSocketUpgrade(input: {
  readonly config: Pick<ServerConfigShape, "authToken" | "host" | "publicUrl">;
  readonly legacyToken: string | null;
  readonly request: AuthRequest;
  readonly serverAuth: Pick<ServerAuthShape, "authenticateWebSocketUpgrade">;
}): Effect.Effect<boolean> {
  return authenticateRpcWebSocketUpgrade(input).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
}

/** Computer still frames use the same trusted-origin and authentication policy. */
export const authorizeComputerFrameWebSocketUpgrade = authorizeDeviceFrameWebSocketUpgrade;

export function makeWebsocketRpcRouteLayer<R>(
  rpcWebSocketHttpEffectSource: Effect.Effect<
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >,
    never,
    R
  >,
) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const rpcWebSocketHttpEffect = yield* rpcWebSocketHttpEffectSource;
      const connectionSessions = yield* WsConnectionSessions;
      const router = yield* HttpRouter.HttpRouter;
      // RPC handlers run on fibers forked from the layer-build scope, not from
      // this per-connection fiber, so the authenticated session cannot be
      // provided as a plain service around rpcWebSocketHttpEffect. Instead the
      // session is registered for the connection's lifetime and its key is
      // injected as a synthetic upgrade header; the admission middleware
      // resolves it back into handler-scoped services on every request.
      const runWithConnectionSession = (
        request: HttpServerRequest.HttpServerRequest,
        session: WsConnectionSession,
      ) =>
        Effect.gen(function* () {
          const sessionKey = yield* connectionSessions.register(session);
          return yield* rpcWebSocketHttpEffect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({
                headers: Headers.set(request.headers, WS_CONNECTION_SESSION_HEADER, sessionKey),
              }),
            ),
          );
        });
      yield* router.add(
        "GET",
        WS_FEATURE_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const config = yield* ServerConfig;
          const serverAuth = yield* ServerAuth;
          const sessions = yield* SessionCredentialService;
          const url = trustedWebSocketRequestUrl(request, config);
          if (!url) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          const compatibilityError = validateWsFeatureCompatibility(url.searchParams);
          if (compatibilityError) {
            return HttpServerResponse.jsonUnsafe(compatibilityError, {
              status: 426,
              headers: { "Cache-Control": "no-store" },
            });
          }
          const legacyToken = url.searchParams.get("token");
          const authenticatedSession = yield* authenticateRpcWebSocketUpgrade({
            config,
            legacyToken,
            request: makeEffectAuthRequest(request),
            serverAuth,
          });

          if (!authenticatedSession) {
            return yield* runWithConnectionSession(request, {
              role: "owner",
              attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            });
          }

          return yield* sessions.runAuthenticatedConnection(
            authenticatedSession.sessionId,
            runWithConnectionSession(request, {
              role: authenticatedSession.role,
              attachmentPrincipal: attachmentPrincipalForSession(authenticatedSession.sessionId),
            }),
          );
        }).pipe(
          Effect.catchTags({
            AuthError: (error) => Effect.succeed(authErrorResponse(error)),
            SessionCapacityError: (error) =>
              Effect.succeed(
                HttpServerResponse.text(error.message, {
                  status: 429,
                  headers: {
                    "Cache-Control": "no-store",
                    "Retry-After": String(error.retryAfterSeconds),
                  },
                }),
              ),
            SessionCredentialError: (error) =>
              Effect.succeed(HttpServerResponse.text(error.message, { status: 401 })),
          }),
        ),
      );
    }),
  );
}

// Negotiation over plain HTTP: a connect costs exactly one WebSocket upgrade
// instead of the legacy bootstrap-socket round trip. Advertised to clients via
// the "transport.http-negotiate" capability; the WS_BOOTSTRAP_PATH socket stays
// available for older clients during rollout.
function makeWsNegotiateHttpRouteLayer() {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        WS_NEGOTIATE_HTTP_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const config = yield* ServerConfig;
          const url = trustedWebSocketRequestUrl(request, config);
          if (!url) {
            // Same no-store discipline as the negotiated responses: an
            // intermediary must never cache a refusal keyed on our behalf.
            return HttpServerResponse.text("Forbidden", {
              status: 403,
              headers: { "Cache-Control": "no-store", Vary: "Origin" },
            });
          }
          // The desktop app fetches cross-origin (moss://app); reflect only
          // origins the WS upgrade itself would trust.
          const origin = normalizeCorsOrigin(request.headers.origin);
          const corsHeaders =
            origin && isTrustedAppOrigin({ origin, requestOrigin: url.origin, config })
              ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
              : {};
          const headers = { "Cache-Control": "no-store", ...corsHeaders };
          const input = parseWsNegotiateSearchParams(url.searchParams);
          if (input instanceof WsCompatibilityError) {
            return HttpServerResponse.jsonUnsafe(input, { status: 426, headers });
          }
          return yield* negotiateWsCompatibility(input).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 200, headers })),
            Effect.catch((error) =>
              Effect.succeed(HttpServerResponse.jsonUnsafe(error, { status: 426, headers })),
            ),
          );
        }),
      );
    }),
  );
}

function makeWebsocketBootstrapRouteLayer<R>(
  bootstrapWebSocketHttpEffectSource: Effect.Effect<
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >,
    never,
    R
  >,
) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const bootstrapWebSocketHttpEffect = yield* bootstrapWebSocketHttpEffectSource;
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        WS_BOOTSTRAP_PATH,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const config = yield* ServerConfig;
          const url = trustedWebSocketRequestUrl(request, config);
          if (!url) {
            return HttpServerResponse.text("Forbidden", { status: 403 });
          }
          return yield* bootstrapWebSocketHttpEffect;
        }),
      );
    }),
  );
}

// Both negotiation surfaces: the single-handshake HTTP endpoint and the legacy
// bootstrap socket kept for older clients during rollout. Exported separately
// so route-level tests can mount them beside a custom feature RPC group.
export const makeWebsocketNegotiationRouteLayer = () =>
  Layer.merge(
    makeWsNegotiateHttpRouteLayer(),
    makeWebsocketBootstrapRouteLayer(makeBootstrapWebSocketHttpEffect),
  );

/**
 * Video rides a second WebSocket (see `deviceFrameRoute`), so it is admitted by
 * the same rules as the RPC upgrade: trusted origin, then whatever
 * authentication the config requires.
 */
const deviceFrameRouteLayer = makeDeviceFrameRouteLayer({
  authorizeUpgrade: (request) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const serverAuth = yield* ServerAuth;
      const url = trustedWebSocketRequestUrl(request, config);
      if (url === null) return false;
      return yield* authorizeDeviceFrameWebSocketUpgrade({
        config,
        legacyToken: url.searchParams.get("token"),
        request: makeEffectAuthRequest(request),
        serverAuth,
      });
    }),
});

const computerFrameRouteLayer = makeComputerFrameRouteLayer({
  authorizeUpgrade: (request) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const serverAuth = yield* ServerAuth;
      const url = trustedWebSocketRequestUrl(request, config);
      if (url === null) return false;
      return yield* authorizeComputerFrameWebSocketUpgrade({
        config,
        legacyToken: url.searchParams.get("token"),
        request: makeEffectAuthRequest(request),
        serverAuth,
      });
    }),
});

export const websocketRpcRouteLayer = Layer.mergeAll(
  deviceFrameRouteLayer,
  computerFrameRouteLayer,
  makeWebsocketNegotiationRouteLayer(),
  // The registry must be provided here so the upgrade route and the RPC
  // middleware (built from the same source effect) share one instance.
  makeWebsocketRpcRouteLayer(makeRpcWebSocketHttpEffect).pipe(
    Layer.provide(WsConnectionSessionsLive),
  ),
);

export const gateOrchestrationMutationUntilStartup = <A, E, R>(
  startup: Pick<ServerRuntimeStartupShape, "enqueueCommand">,
  effect: Effect.Effect<A, E, R>,
) => startup.enqueueCommand(effect);
export const gateOrchestrationReadUntilStartup = <A, E, R>(
  startup: Pick<ServerRuntimeStartupShape, "enqueueRead">,
  effect: Effect.Effect<A, E, R>,
) => startup.enqueueRead(effect);
export const gateOrchestrationStreamUntilStartup = <A, R>(
  startup: Pick<ServerRuntimeStartupShape, "enqueueRead">,
  stream: Stream.Stream<A, WsRpcError, R>,
): Stream.Stream<A, WsRpcError, R> =>
  Stream.unwrap(
    startup
      .enqueueRead(Effect.succeed(stream))
      .pipe(
        Effect.mapError((cause) =>
          toWsRpcError(cause, "Server startup reconciliation is not ready"),
        ),
      ),
  );

export function toVoiceWsRpcError(cause: unknown, _fallbackMessage: string): WsRpcError {
  if (cause instanceof VoiceAccountAdmissionError) {
    return new WsRpcError({ message: cause.message, code: cause.code, retryable: cause.retryable });
  }
  if (cause instanceof VoiceTranscriptionProviderRouteError) {
    return new WsRpcError({ message: cause.message, code: cause.code, retryable: false });
  }
  if (cause instanceof VoiceTranscriptionExecutionError) {
    return new WsRpcError({ message: cause.message, code: cause.code, retryable: cause.retryable });
  }
  if (cause instanceof RealtimeVoiceRuntimeError) {
    return new WsRpcError({ message: cause.message, code: cause.code, retryable: cause.retryable });
  }
  return new WsRpcError({
    message: "Voice transcription is temporarily unavailable. Try again shortly.",
    code: "VOICE_TRANSCRIPTION_UNAVAILABLE",
    retryable: true,
  });
}

const voiceRpcEffect = <A, E, R>(effect: Effect.Effect<A, E, R>, fallbackMessage: string) =>
  effect.pipe(Effect.mapError((cause) => toVoiceWsRpcError(cause, fallbackMessage)));

// Small exported adapters keep provider RPC effects directly testable without
// constructing the full websocket layer. The production registry uses the
// same adapters below, so tests exercise the actual error mapping.
export const providerListSessionsRpcEffect = (providerService: {
  listSessions: () => Effect.Effect<readonly unknown[]>;
}) =>
  rpcEffect(
    providerService.listSessions().pipe(Effect.map((sessions) => ({ sessions }))),
    "Failed to list provider sessions",
  );
export const providerSubscribeNormalizedSessionEventsRpcStream = (
  providerService: { streamNormalizedEventsWithReplay: (input: any) => Stream.Stream<any, any> },
  input: any,
) =>
  bufferLiveUiStream(providerService.streamNormalizedEventsWithReplay(input), {
    label: "provider.normalized-session-events",
    onDroppedEvents: failLiveUiStreamForSnapshotResync,
  }).pipe(
    Stream.mapError((cause) => toWsRpcError(cause, "Provider normalized event stream failed")),
  );
export const providerAddMarketplaceRpcEffect = (
  service: { addMarketplace: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.addMarketplace(input), "Failed to add marketplace");
export const providerRemoveMarketplaceRpcEffect = (
  service: { removeMarketplace: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.removeMarketplace(input), "Failed to remove marketplace");
export const providerUpgradeMarketplaceRpcEffect = (
  service: { upgradeMarketplace: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.upgradeMarketplace(input), "Failed to upgrade marketplace");
export const providerInstallPluginRpcEffect = (
  service: { installPlugin: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.installPlugin(input), "Failed to install plugin");
export const providerUninstallPluginRpcEffect = (
  service: { uninstallPlugin: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.uninstallPlugin(input), "Failed to uninstall plugin");
export const providerSetPluginEnabledRpcEffect = (
  service: { setPluginEnabled: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.setPluginEnabled(input), "Failed to configure plugin");
export const providerListAppsRpcEffect = (
  service: { listApps: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.listApps(input), "Failed to list apps");
export const providerSetAppEnabledRpcEffect = (
  service: { setAppEnabled: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.setAppEnabled(input), "Failed to configure app");
export const providerReadAppToolsRpcEffect = (
  service: { readAppTools: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.readAppTools(input), "Failed to read app tools");
export const providerReadAppConnectorRpcEffect = (
  service: { readAppConnector: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.readAppConnector(input), "Failed to read app connector");
export const providerReadAppConnectorTermsRpcEffect = (
  service: { readAppConnectorTerms: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.readAppConnectorTerms(input), "Failed to read app connector terms");
export const providerStartAppConnectionRpcEffect = (
  service: { startAppConnection: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.startAppConnection(input), "Failed to connect app");
export const providerCompleteAppConnectionRpcEffect = (
  service: { completeAppConnection: (input: any) => Effect.Effect<any, any> },
  input: any,
) => rpcEffect(service.completeAppConnection(input), "Failed to complete app login");

export const makeMossPhoneAccountRpcHandlers = (service: MossPhoneAccountServiceShape) => ({
  [WS_METHODS.serverMossAccountSession]: () =>
    rpcEffect(service.getSession(), "Failed to load Moss phone account session"),
  [WS_METHODS.serverMossAccountStartPhoneLogin]: (input: MossAccountStartPhoneLoginInput) =>
    rpcEffect(service.startPhoneLogin(input), "Failed to start Moss phone login"),
  [WS_METHODS.serverMossAccountVerifyPhoneLogin]: (input: MossAccountVerifyPhoneLoginInput) =>
    rpcEffect(service.verifyPhoneLogin(input), "Failed to verify Moss phone login"),
  [WS_METHODS.serverMossAccountLogout]: () =>
    rpcEffect(service.logout(), "Failed to log out of Moss phone account"),
});

const mossCloudAccountRpcEffect = <A, R>(
  effect: Effect.Effect<A, MossCloudAccountServiceError, R>,
  fallbackMessage: string,
) =>
  effect.pipe(
    Effect.mapError((cause) => {
      return new WsRpcError({
        message: cause instanceof MossCloudAccountServiceError ? cause.message : fallbackMessage,
      });
    }),
  );

export const makeMossCloudAccountRpcHandlers = (service: MossCloudAccountServiceShape) => ({
  [WS_METHODS.serverMossCloudAccountState]: () =>
    mossCloudAccountRpcEffect(service.getState(), "Failed to load the Moss cloud account"),
  [WS_METHODS.serverMossCloudAccountList]: () =>
    mossCloudAccountRpcEffect(service.listAccounts(), "Failed to list saved Moss cloud accounts"),
  [WS_METHODS.serverMossCloudAccountSelect]: (input: MossCloudSelectAccountInput) =>
    mossCloudAccountRpcEffect(
      service.selectAccount(input),
      "Failed to select the saved Moss cloud account",
    ),
  [WS_METHODS.serverMossCloudAccountRemove]: (input: MossCloudRemoveAccountInput) =>
    mossCloudAccountRpcEffect(
      service.removeAccount(input),
      "Failed to remove the saved Moss cloud account",
    ),
  [WS_METHODS.serverMossCloudAccountSignUp]: (input: MossCloudSignUpInput) =>
    mossCloudAccountRpcEffect(service.signUp(input), "Failed to create the Moss cloud account"),
  [WS_METHODS.serverMossCloudAccountSignIn]: (input: MossCloudSignInInput) =>
    mossCloudAccountRpcEffect(service.signIn(input), "Failed to sign in to the Moss cloud account"),
  [WS_METHODS.serverMossCloudAccountStartGoogleOAuth]: () =>
    mossCloudAccountRpcEffect(service.startGoogleOAuth(), "Failed to start Google authentication"),
  [WS_METHODS.serverMossCloudAccountExchangeGoogleOAuthCode]: (
    input: MossCloudExchangeGoogleOAuthCodeInput,
  ) =>
    mossCloudAccountRpcEffect(
      service.exchangeGoogleOAuthCode(input),
      "Failed to exchange the Google authentication code",
    ),
  [WS_METHODS.serverMossCloudAccountRefresh]: () =>
    mossCloudAccountRpcEffect(service.refresh(), "Failed to refresh the Moss cloud account"),
  [WS_METHODS.serverMossCloudAccountRequestPasswordReset]: (
    input: MossCloudRequestPasswordResetInput,
  ) =>
    mossCloudAccountRpcEffect(
      service.requestPasswordReset(input),
      "Failed to request a Moss password reset",
    ),
  [WS_METHODS.serverMossCloudAccountExchangeCode]: (input: MossCloudExchangeCodeInput) =>
    mossCloudAccountRpcEffect(
      service.exchangeCode(input),
      "Failed to exchange the Moss authentication code",
    ),
  [WS_METHODS.serverMossCloudAccountUpdatePassword]: (input: MossCloudUpdatePasswordInput) =>
    mossCloudAccountRpcEffect(
      service.updatePassword(input),
      "Failed to update the Moss account password",
    ),
  [WS_METHODS.serverMossCloudAccountLogout]: () =>
    mossCloudAccountRpcEffect(service.logout(), "Failed to log out of the Moss cloud account"),
});

const mossEnterpriseKeyRpcEffect = <A, R>(
  effect: Effect.Effect<A, MossEnterpriseKeyError, R>,
  fallbackMessage: string,
) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new WsRpcError({
          message: cause instanceof MossEnterpriseKeyError ? cause.message : fallbackMessage,
          ...(cause instanceof MossEnterpriseKeyError ? { code: cause.code } : {}),
        }),
    ),
  );

export const makeMossEnterpriseKeyRpcHandlers = (service: MossEnterpriseKeyAccountShape) => ({
  [WS_METHODS.serverMossEnterpriseKeyState]: () =>
    mossEnterpriseKeyRpcEffect(service.getState(), "Failed to load the Moss enterprise key"),
  [WS_METHODS.serverMossEnterpriseKeySignIn]: (input: MossEnterpriseKeySignInInput) =>
    mossEnterpriseKeyRpcEffect(service.signIn(input), "Failed to sign in with the enterprise key"),
  [WS_METHODS.serverMossEnterpriseKeyActivate]: () =>
    mossEnterpriseKeyRpcEffect(service.activate(), "Failed to switch to the enterprise key"),
  [WS_METHODS.serverMossEnterpriseKeySignOut]: () =>
    mossEnterpriseKeyRpcEffect(service.signOut(), "Failed to sign out of the enterprise key"),
});

const mossPayRpcEffect = <A, R>(
  effect: Effect.Effect<A, MossPayError, R>,
  fallbackMessage: string,
) =>
  effect.pipe(
    Effect.mapError((cause) => {
      return new WsRpcError({
        message: cause instanceof MossPayError ? cause.message : fallbackMessage,
      });
    }),
  );

export const makeMossPayRpcHandlers = (service: MossPayServiceShape) => ({
  [WS_METHODS.serverMossPayCatalog]: () =>
    mossPayRpcEffect(service.getCatalog(), "Failed to load the Moss plans and packages"),
  [WS_METHODS.serverMossPayQuota]: () =>
    mossPayRpcEffect(service.getQuota(), "Failed to load the Moss account quota"),
  [WS_METHODS.serverMossPayCreateOrder]: (input: MossPayCreateOrderInput) =>
    mossPayRpcEffect(service.createOrder(input), "Failed to create the Moss payment order"),
  [WS_METHODS.serverMossPayGetOrder]: (input: MossPayGetOrderInput) =>
    mossPayRpcEffect(service.getOrder(input), "Failed to load the Moss payment order"),
});

const realtimeVoiceRpcEffect = <A, R>(
  effect: Effect.Effect<A, RealtimeVoiceRuntimeError, R>,
  fallbackMessage: string,
) =>
  effect.pipe(
    Effect.mapError((cause) => {
      return new WsRpcError({
        message: cause instanceof RealtimeVoiceRuntimeError ? cause.message : fallbackMessage,
        ...(cause instanceof RealtimeVoiceRuntimeError
          ? { code: cause.code, retryable: cause.retryable }
          : {}),
      });
    }),
  );

export const makeRealtimeVoiceRpcHandlers = (service: RealtimeVoiceServiceShape) => ({
  [WS_METHODS.realtimeVoiceListVoices]: () => service.listVoices(),
  [WS_METHODS.realtimeVoiceClaim]: (input: RealtimeVoiceClaimInput) =>
    realtimeVoiceRpcEffect(service.claim(input), "Failed to reserve Realtime Voice"),
  [WS_METHODS.realtimeVoiceReleaseClaim]: (input: RealtimeVoiceReleaseClaimInput) =>
    realtimeVoiceRpcEffect(service.releaseClaim(input), "Failed to release Realtime Voice"),
  [WS_METHODS.realtimeVoiceStart]: (input: RealtimeVoiceStartInput) =>
    realtimeVoiceRpcEffect(service.start(input), "Failed to start Realtime Voice"),
  [WS_METHODS.realtimeVoiceReportClientState]: (input: RealtimeVoiceReportClientStateInput) =>
    realtimeVoiceRpcEffect(
      service.reportClientState(input),
      "Failed to update Realtime Voice transport state",
    ),
  [WS_METHODS.realtimeVoiceResolveScreenContext]: (input: RealtimeVoiceResolveScreenContextInput) =>
    realtimeVoiceRpcEffect(
      service.resolveScreenContext(input),
      "Failed to return Realtime Voice screen context",
    ),
  [WS_METHODS.realtimeVoiceAppendText]: (input: RealtimeVoiceAppendTextInput) =>
    realtimeVoiceRpcEffect(service.appendText(input), "Failed to append Realtime Voice text"),
  [WS_METHODS.realtimeVoiceAppendSpeech]: (input: RealtimeVoiceAppendSpeechInput) =>
    realtimeVoiceRpcEffect(service.appendSpeech(input), "Failed to append Realtime Voice speech"),
  [WS_METHODS.realtimeVoiceStop]: (input: RealtimeVoiceStopInput) =>
    realtimeVoiceRpcEffect(service.stop(input), "Failed to stop Realtime Voice"),
  [WS_METHODS.realtimeVoiceGetState]: () => service.getState,
});
