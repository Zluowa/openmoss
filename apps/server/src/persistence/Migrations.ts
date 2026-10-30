/**
 * MigrationsLive - Migration runner with inline loader
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * Migrations run automatically when the MigrationLayer is provided,
 * ensuring the database schema is always up-to-date before the application starts.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MigrationBackupRequiredError,
  MigrationLineageError,
  MigrationSchemaTooNewError,
} from "./Errors.ts";
import {
  MigrationBackupAuthorization,
  inspectCurrentMigrationLineage,
  type MigrationLineageClassification,
} from "./MigrationLineage.ts";

// Import all migrations statically
// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ThreadHandoffMetadata.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadMessageMentions.ts";
import Migration0019 from "./Migrations/019_ProjectionThreadsEnvMode.ts";
import Migration0020 from "./Migrations/020_ProjectionThreadsForkSource.ts";
import Migration0021 from "./Migrations/021_ProjectionThreadsAssociatedWorktree.ts";
import Migration0022 from "./Migrations/022_ProjectionThreadsAssociatedWorktreeBranch.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadsAssociatedWorktreeRef.ts";
import Migration0024 from "./Migrations/024_ProjectionThreadsArchivedAt.ts";
import Migration0025 from "./Migrations/025_ProjectionThreadsSubagents.ts";
import Migration0026 from "./Migrations/026_ProjectionThreadShellSummary.ts";
import Migration0027 from "./Migrations/027_BackfillProjectionThreadShellSummary.ts";
import Migration0028 from "./Migrations/028_ProjectionProjectsKind.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadsLastKnownPr.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadMessagesDispatchMode.ts";
import Migration0031 from "./Migrations/031_ProjectionThreadsCreateBranchFlowCompleted.ts";
import Migration0032 from "./Migrations/032_ReconcileImportedSchemaLineage.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSidechatSource.ts";
import Migration0034 from "./Migrations/034_AuthAccessManagement.ts";
import Migration0035 from "./Migrations/035_NormalizeLegacyModelSelectionOptions.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionSnapshotCapIndexes.ts";
import Migration0038 from "./Migrations/038_ReconcileLegacySidechatSource.ts";
import Migration0039 from "./Migrations/039_ReconcileLegacyPinnedThreads.ts";
import Migration0040 from "./Migrations/040_ProjectionThreadsPinnedMessagesNotes.ts";
import Migration0041 from "./Migrations/041_ProjectionProjectsPinned.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadsMarkers.ts";
import Migration0043 from "./Migrations/043_ProfileStatsIndexes.ts";
import Migration0044 from "./Migrations/044_Automations.ts";
import Migration0045 from "./Migrations/045_AutomationPolicies.ts";
import Migration0046 from "./Migrations/046_AutomationCompletionPolicy.ts";
import Migration0047 from "./Migrations/047_AutomationCompletionPolicyVersion.ts";
import Migration0048 from "./Migrations/048_AutomationCompletionEvaluationBacklog.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadMessagesDispatchOrigin.ts";
import Migration0050 from "./Migrations/050_ProfileStatsArchive.ts";
import Migration0051 from "./Migrations/051_ProfileStatsDeletedTokensModel.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadUserMessageSummaryIndex.ts";
import Migration0053 from "./Migrations/053_MossAccountControlPlane.ts";
// These PR migrations were authored before upstream claimed loader IDs 51/52.
// Keep their source filenames for review history, but shift their loader IDs
// after Moss's released migration 53 so every migration remains ordered and unique.
import Migration0054 from "./Migrations/051_ProjectionThreadSessionProviderInstance.ts";
import Migration0055 from "./Migrations/052_ProviderSessionRuntimeInstanceId.ts";
import Migration0056 from "./Migrations/054_ProfileStatsDeletedTurnsProviderInstance.ts";
import Migration0057 from "./Migrations/055_ProfileStatsDeletedTokensProviderInstance.ts";
import Migration0058 from "./Migrations/056_ClearAutomationDefinitionProviderOptions.ts";
import Migration0059 from "./Migrations/057_ClearAutomationRunProviderOptions.ts";
import Migration0060 from "./Migrations/059_ScrubOrchestrationEventProviderOptions.ts";
import Migration0061 from "./Migrations/061_MossCloudAccountBindings.ts";
// Upstream introduced this as migration 53 after Moss had already released its
// own 53-61 lineage. Append it so existing Moss databases never reuse an ID.
import Migration0062 from "./Migrations/053_BackfillThreadActivitySequence.ts";
// Upstream introduced this as source migration 69 after Moss had already
// extended its released lineage through 62. Append it rather than reusing an
// applied ID.
import Migration0063 from "./Migrations/069_ProjectPullRequestPins.ts";
// Upstream's delivery/attachment lineage originally occupied IDs 54-68.
// Moss already shipped different migrations at those IDs, so append the same
// migration bodies after the released Moss lineage instead of reusing IDs.
import Migration0064 from "./Migrations/054_ReservedDurableProviderCommandDelivery.ts";
import Migration0065 from "./Migrations/055_ManagedAttachments.ts";
import Migration0066 from "./Migrations/056_CommandReceiptFingerprints.ts";
import Migration0067 from "./Migrations/057_ThreadScopedProjectionMessageIdentity.ts";
import Migration0068 from "./Migrations/058_ThreadScopedPendingApprovalIdentity.ts";
import Migration0069 from "./Migrations/059_ProviderSessionLifecycleGeneration.ts";
import Migration0070 from "./Migrations/060_PendingApprovalLifecycleGeneration.ts";
import Migration0071 from "./Migrations/061_PendingApprovalSettlementState.ts";
import Migration0072 from "./Migrations/062_PendingInteractionSettlementParity.ts";
import Migration0073 from "./Migrations/063_ProjectionMessageCausalSequence.ts";
import Migration0074 from "./Migrations/064_DurableProviderCommandDelivery.ts";
import Migration0075 from "./Migrations/065_DurableQueuedTurnPromotions.ts";
import Migration0076 from "./Migrations/066_DurableProviderRuntimeEvents.ts";
import Migration0077 from "./Migrations/067_ProviderDeliveryReconciliation.ts";
import Migration0078 from "./Migrations/068_GitHandoffOperations.ts";
// The plugin-parity scrub was authored at loader ID 63 before upstream claimed
// 63-78. Preserve the released upstream lineage and append the idempotent scrub.
import Migration0079 from "./Migrations/063_ScrubCodexOrchestrationEventBinaryPath.ts";
// Upstream source migrations 70-79 are immutable, but their source IDs collide
// with the released Moss lineage. They are registered only at loader IDs 80-89.
import Migration0080 from "./Migrations/070_AgentGatewayOperations.ts";
import Migration0081 from "./Migrations/071_ProjectionThreadsGatewayProvenance.ts";
import Migration0082 from "./Migrations/072_AgentGatewayOperationRetention.ts";
import Migration0083 from "./Migrations/073_OperationalDiagnostics.ts";
import Migration0084 from "./Migrations/074_ExternalMcpIntegrations.ts";
import Migration0085 from "./Migrations/075_ExternalMcpActiveCapacity.ts";
import Migration0086 from "./Migrations/076_ExternalMcpHardening.ts";
import Migration0087 from "./Migrations/077_ExternalMcpCompensatingCapacity.ts";
import Migration0088 from "./Migrations/078_ExternalMcpLiveTurnCapacity.ts";
import Migration0089 from "./Migrations/079_Spaces.ts";
// Upstream introduced source migration 80 after Moss had already released
// loader IDs through 89. Append it without reusing a released Moss ID.
import Migration0090 from "./Migrations/080_ExternalMcpProjectScope.ts";
// Moss v0.6.0/0.6.1 added source migrations 81-87 after Moss had already
// released loader IDs through 90. Preserve Moss's append-only lineage by
// registering those immutable bodies at 91-97.
import Migration0091 from "./Migrations/081_AutomationProposals.ts";
import Migration0092 from "./Migrations/082_AutomationMemory.ts";
import Migration0093 from "./Migrations/083_AutomationHeartbeatEligibility.ts";
import Migration0094 from "./Migrations/084_AutomationNotificationPolicy.ts";
import Migration0095 from "./Migrations/085_AutomationSettings.ts";
import Migration0096 from "./Migrations/086_NormalizeStudioThreadWorkspaces.ts";
import Migration0097 from "./Migrations/087_DropUnusedOrchestrationEventIndexes.ts";
// Upstream introduced source migration 88 after Moss had already released
// loader IDs through 97. Append the immutable body instead of reusing an ID.
import Migration0098 from "./Migrations/088_ProjectionThreadsSettledAt.ts";
// Upstream introduced source migration 89 after Moss had already released
// loader IDs through 98. Append the immutable body at loader ID 99.
import Migration0099 from "./Migrations/089_RecoverRetentionHiddenThreads.ts";
// Upstream source migrations 90-96 are appended after Moss's released
// migration 99. Their source filenames and bodies remain immutable, but their
// loader IDs must not reuse Moss's released IDs.
import Migration0100 from "./Migrations/090_ProjectionThreadMessageTextSegments.ts";
import Migration0101 from "./Migrations/091_AutomationFailureTolerance.ts";
import Migration0102 from "./Migrations/092_BackfillAutomationRunThreadSource.ts";
import Migration0103 from "./Migrations/093_BackfillMaxIterationsDisabledReason.ts";
import Migration0104 from "./Migrations/094_ProjectionThreadsGoal.ts";
import Migration0105 from "./Migrations/095_ProjectionThreadsGoalTiming.ts";
import Migration0106 from "./Migrations/096_ProjectionThreadsGoalAchievements.ts";
import Migration0107 from "./Migrations/097_ProjectionSidebarSections.ts";
import Migration0108 from "./Migrations/108_ProjectionThreadsArchiveSidebarPlacement.ts";
import Migration0109 from "./Migrations/109_ProjectionSidebarThreadOrder.ts";
import Migration0110 from "./Migrations/110_ProjectionSidebarProjectOrder.ts";
import Migration0111 from "./Migrations/097_ProjectionThreadsSidechatLifecycle.ts";
import Migration0112 from "./Migrations/098_MigrateKiloToOpenCode.ts";
import Migration0113 from "./Migrations/113_ProjectionThreadMessageRealtimeHandoffId.ts";
// Upstream source ID 99 collides with released Moss history. Append at 114.
import Migration0114 from "./Migrations/099_InvalidateProjectionThreadsCursor.ts";
// Moss 0.8.4 Claude accounting is appended after the released Moss lineage
// so existing 1-114 databases retain their append-only migration identity.
import MessageTextChunksMigration from "./Migrations/100_MessageTextChunks.ts";
import RemoveTranscriptMarkersMigration from "./Migrations/101_RemoveTranscriptMarkers.ts";
import TurnBoundaryMigration from "./Migrations/102_ProjectionThreadMessagesTurnBoundary.ts";
import ClaudeTokenAccountingMigration from "./Migrations/103_ClaudeTokenAccounting.ts";
// Upstream released these migrations after Moss 0.8.4 (released loader IDs 1-118).
// Append their immutable bodies past the released Moss lineage instead of
// reusing IDs that Moss databases already recorded with different names.
import Migration0119 from "./Migrations/104_ProjectionThreadsClaudeCacheReview.ts";
import Migration0120 from "./Migrations/105_AsyncUserInput.ts";
import Migration0121 from "./Migrations/106_ProjectImportOrigins.ts";
import Migration0122 from "./Migrations/107_ProjectionThreadsHumanMessage.ts";
import Migration0123 from "./Migrations/108_GatewayCompletions.ts";
import Migration0124 from "./Migrations/109_ProjectAgent.ts";
import Migration0125 from "./Migrations/110_Groups.ts";
import Migration0126 from "./Migrations/111_GroupLibraryHosting.ts";
import Migration0127 from "./Migrations/112_CoordinatorAppearance.ts";
import Migration0128 from "./Migrations/113_ProjectAgentWakeCursor.ts";
import Migration0129 from "./Migrations/114_ProjectAgentLifecycle.ts";
import Migration0130 from "./Migrations/115_ProjectAgentManagedWorkers.ts";
import Migration0131 from "./Migrations/116_ProjectAgentWorkerRecovery.ts";
import Migration0132 from "./Migrations/117_WorkerMonitoringLiveness.ts";
import Migration0133 from "./Migrations/120_ProfileStatsDeletedProviderInstances.ts";
import Migration0134 from "./Migrations/124_ProjectionTurnsPendingMessageIndex.ts";
import Migration0135 from "./Migrations/125_Todos.ts";
import Migration0136 from "./Migrations/126_ProjectionThreadsSidechatContext.ts";
import Migration0137 from "./Migrations/127_ProjectImportHistory.ts";
import Migration0138 from "./Migrations/128_HubWork.ts";
import Migration0139 from "./Migrations/129_ProjectionThreadsSnooze.ts";
import Migration0140 from "./Migrations/130_PullRequestAutoFix.ts";
import Migration0141 from "./Migrations/141_Library.ts";
import Migration0146 from "./Migrations/146_LibraryMediaDeletions.ts";
import Migration0142 from "./Migrations/131_ProjectSourceFolders.ts";
import Migration0143 from "./Migrations/132_ExternalMcpTurnCapacityRecovery.ts";
import Migration0144 from "./Migrations/133_ProjectionTurnsWorkspaceInitialization.ts";
import Migration0145 from "./Migrations/134_ProjectionThreadsForkSourceMessage.ts";
import Migration0147 from "./Migrations/143_ProjectionMessageTurnActivityIndex.ts";
import Migration0148 from "./Migrations/148_Pages.ts";
import Migration0149 from "./Migrations/149_AutomationCreateRequests.ts";
import Migration0150 from "./Migrations/150_GuestShares.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ThreadHandoffMetadata", Migration0017],
  [18, "ProjectionThreadMessageMentions", Migration0018],
  [19, "ProjectionThreadsEnvMode", Migration0019],
  [20, "ProjectionThreadsForkSource", Migration0020],
  [21, "ProjectionThreadsAssociatedWorktree", Migration0021],
  [22, "ProjectionThreadsAssociatedWorktreeBranch", Migration0022],
  [23, "ProjectionThreadsAssociatedWorktreeRef", Migration0023],
  [24, "ProjectionThreadsArchivedAt", Migration0024],
  [25, "ProjectionThreadsSubagents", Migration0025],
  [26, "ProjectionThreadShellSummary", Migration0026],
  [27, "BackfillProjectionThreadShellSummary", Migration0027],
  [28, "ProjectionProjectsKind", Migration0028],
  [29, "ProjectionThreadsLastKnownPr", Migration0029],
  [30, "ProjectionThreadMessagesDispatchMode", Migration0030],
  [31, "ProjectionThreadsCreateBranchFlowCompleted", Migration0031],
  [32, "ReconcileImportedSchemaLineage", Migration0032],
  [33, "ProjectionThreadsSidechatSource", Migration0033],
  [34, "AuthAccessManagement", Migration0034],
  [35, "NormalizeLegacyModelSelectionOptions", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionSnapshotCapIndexes", Migration0037],
  [38, "ReconcileLegacySidechatSource", Migration0038],
  [39, "ReconcileLegacyPinnedThreads", Migration0039],
  [40, "ProjectionThreadsPinnedMessagesNotes", Migration0040],
  [41, "ProjectionProjectsPinned", Migration0041],
  [42, "ProjectionThreadsMarkers", Migration0042],
  [43, "ProfileStatsIndexes", Migration0043],
  [44, "Automations", Migration0044],
  [45, "AutomationPolicies", Migration0045],
  [46, "AutomationCompletionPolicy", Migration0046],
  [47, "AutomationCompletionPolicyVersion", Migration0047],
  [48, "AutomationCompletionEvaluationBacklog", Migration0048],
  [49, "ProjectionThreadMessagesDispatchOrigin", Migration0049],
  [50, "ProfileStatsArchive", Migration0050],
  [51, "ProfileStatsDeletedTokensModel", Migration0051],
  [52, "ProjectionThreadUserMessageSummaryIndex", Migration0052],
  [53, "MossAccountControlPlane", Migration0053],
  [54, "ProjectionThreadSessionProviderInstance", Migration0054],
  [55, "ProviderSessionRuntimeInstanceId", Migration0055],
  [56, "ProfileStatsDeletedTurnsProviderInstance", Migration0056],
  [57, "ProfileStatsDeletedTokensProviderInstance", Migration0057],
  [58, "ClearAutomationDefinitionProviderOptions", Migration0058],
  [59, "ClearAutomationRunProviderOptions", Migration0059],
  [60, "ScrubOrchestrationEventProviderOptions", Migration0060],
  [61, "MossCloudAccountBindings", Migration0061],
  [62, "BackfillThreadActivitySequence", Migration0062],
  [63, "ProjectPullRequestPins", Migration0063],
  // Upstream 54 was an intentionally empty development tracker reservation;
  // preserve that body and name before the production cutover appended at 74.
  [64, "DurableProviderCommandDelivery", Migration0064],
  [65, "ManagedAttachments", Migration0065],
  [66, "CommandReceiptFingerprints", Migration0066],
  [67, "ThreadScopedProjectionMessageIdentity", Migration0067],
  [68, "ThreadScopedPendingApprovalIdentity", Migration0068],
  [69, "ProviderSessionLifecycleGeneration", Migration0069],
  [70, "PendingApprovalLifecycleGeneration", Migration0070],
  [71, "PendingApprovalSettlementState", Migration0071],
  [72, "PendingInteractionSettlementParity", Migration0072],
  [73, "ProjectionMessageCausalSequence", Migration0073],
  [74, "DurableProviderCommandDeliveryCutover", Migration0074],
  [75, "DurableQueuedTurnPromotions", Migration0075],
  [76, "DurableProviderRuntimeEvents", Migration0076],
  [77, "ProviderDeliveryReconciliation", Migration0077],
  [78, "GitHandoffOperations", Migration0078],
  [79, "ScrubCodexOrchestrationEventBinaryPath", Migration0079],
  [80, "AgentGatewayOperations", Migration0080],
  [81, "ProjectionThreadsGatewayProvenance", Migration0081],
  [82, "AgentGatewayOperationRetention", Migration0082],
  [83, "OperationalDiagnostics", Migration0083],
  [84, "ExternalMcpIntegrations", Migration0084],
  [85, "ExternalMcpActiveCapacity", Migration0085],
  [86, "ExternalMcpHardening", Migration0086],
  [87, "ExternalMcpCompensatingCapacity", Migration0087],
  [88, "ExternalMcpLiveTurnCapacity", Migration0088],
  [89, "Spaces", Migration0089],
  [90, "ExternalMcpProjectScope", Migration0090],
  [91, "AutomationProposals", Migration0091],
  [92, "AutomationMemory", Migration0092],
  [93, "AutomationHeartbeatEligibility", Migration0093],
  [94, "AutomationNotificationPolicy", Migration0094],
  [95, "AutomationSettings", Migration0095],
  [96, "NormalizeStudioThreadWorkspaces", Migration0096],
  [97, "DropUnusedOrchestrationEventIndexes", Migration0097],
  [98, "ProjectionThreadsSettledAt", Migration0098],
  [99, "RecoverRetentionHiddenThreads", Migration0099],
  [100, "ProjectionThreadMessageTextSegments", Migration0100],
  [101, "AutomationFailureTolerance", Migration0101],
  [102, "BackfillAutomationRunThreadSource", Migration0102],
  [103, "BackfillMaxIterationsDisabledReason", Migration0103],
  [104, "ProjectionThreadsGoal", Migration0104],
  [105, "ProjectionThreadsGoalTiming", Migration0105],
  [106, "ProjectionThreadsGoalAchievements", Migration0106],
  [107, "ProjectionSidebarSections", Migration0107],
  [108, "ProjectionThreadsArchiveSidebarPlacement", Migration0108],
  [109, "ProjectionSidebarThreadOrder", Migration0109],
  [110, "ProjectionSidebarProjectOrder", Migration0110],
  [111, "ProjectionThreadsSidechatLifecycle", Migration0111],
  [112, "MigrateKiloToOpenCode", Migration0112],
  [113, "ProjectionThreadMessageRealtimeHandoffId", Migration0113],
  [114, "InvalidateProjectionThreadsCursor", Migration0114],
  [115, "MessageTextChunks", MessageTextChunksMigration],
  [116, "RemoveTranscriptMarkers", RemoveTranscriptMarkersMigration],
  [117, "ProjectionThreadMessagesTurnBoundary", TurnBoundaryMigration],
  [118, "ClaudeTokenAccounting", ClaudeTokenAccountingMigration],
  [119, "ProjectionThreadsClaudeCacheReview", Migration0119],
  [120, "AsyncUserInput", Migration0120],
  [121, "ProjectImportOrigins", Migration0121],
  [122, "ProjectionThreadsHumanMessage", Migration0122],
  [123, "GatewayCompletions", Migration0123],
  [124, "ProjectAgent", Migration0124],
  [125, "Groups", Migration0125],
  [126, "GroupLibraryHosting", Migration0126],
  [127, "CoordinatorAppearance", Migration0127],
  [128, "ProjectAgentWakeCursor", Migration0128],
  [129, "ProjectAgentLifecycle", Migration0129],
  [130, "ProjectAgentManagedWorkers", Migration0130],
  [131, "ProjectAgentWorkerRecovery", Migration0131],
  [132, "WorkerMonitoringLiveness", Migration0132],
  [133, "ProfileStatsDeletedProviderInstances", Migration0133],
  [134, "ProjectionTurnsPendingMessageIndex", Migration0134],
  [135, "Todos", Migration0135],
  [136, "ProjectionThreadsSidechatContext", Migration0136],
  [137, "ProjectImportHistory", Migration0137],
  [138, "HubWork", Migration0138],
  [139, "ProjectionThreadsSnooze", Migration0139],
  [140, "PullRequestAutoFix", Migration0140],
  [141, "Library", Migration0141],
  [142, "ProjectSourceFolders", Migration0142],
  [143, "ExternalMcpTurnCapacityRecovery", Migration0143],
  [144, "ProjectionTurnsWorkspaceInitialization", Migration0144],
  [145, "ProjectionThreadsForkSourceMessage", Migration0145],
  [146, "LibraryMediaDeletions", Migration0146],
  [147, "ProjectionMessageTurnActivityIndex", Migration0147],
  [148, "Pages", Migration0148],
  [149, "AutomationCreateRequests", Migration0149],
  [150, "GuestShares", Migration0150],
] as const;

export const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Highest migration ID whose content is identical across every supported
 * imported lineage. A name mismatch at or below this ID
 * means the database does not come from any known lineage, so re-running
 * migrations could destroy data — refuse to start instead.
 *
 * This boundary cannot be raised past 16 today: predecessor-lineage imports
 * (see `Migrations/032_ReconcileImportedSchemaLineage.ts`) record foreign names
 * from ID 17 onward and are repaired by the replay path below. Exported because
 * `MigrationBackup.inspectMigrationBackupPlan` gates the same way when it decides
 * whether a pre-migration backup is warranted. Renumbering regressions are
 * prevented at the source instead, by `scripts/check-migration-lineage.ts`.
 */
export const LAST_SHARED_LINEAGE_MIGRATION_ID = 16;
export const LATEST_MIGRATION_ID = Math.max(...migrationEntries.map(([id]) => id));

const canonicalMigrationNamesById: ReadonlyMap<number, string> = new Map(
  migrationEntries.map(([id, name]) => [id, name] as const),
);

const IMPORTED_SCHEMA_RECONCILIATION_MIGRATION_ID = 32;

export function planLegacyMigration32Rename(
  recordedNamesById: ReadonlyMap<number, string>,
): string | null {
  const canonicalName = canonicalMigrationNamesById.get(
    IMPORTED_SCHEMA_RECONCILIATION_MIGRATION_ID,
  );
  if (canonicalName === undefined) return null;

  const hasCanonicalPrefix = migrationEntries
    .filter(([id]) => id < IMPORTED_SCHEMA_RECONCILIATION_MIGRATION_ID)
    .every(([id, name]) => recordedNamesById.get(id) === name);
  const recordedName = recordedNamesById.get(IMPORTED_SCHEMA_RECONCILIATION_MIGRATION_ID);
  return hasCanonicalPrefix && recordedName !== undefined && recordedName !== canonicalName
    ? canonicalName
    : null;
}

/**
 * First canonical entry whose name is not recorded at the same ID, considering
 * only IDs the database claims to have applied.
 *
 * Shared by the alias pre-check, the replay path, and
 * `MigrationBackup.inspectMigrationBackupPlan`, so "this database will be
 * replayed" and "this database needs a backup first" can never disagree.
 */
export const findFirstMigrationLineageDivergence = (
  recordedNamesById: ReadonlyMap<number, string>,
  highWaterMark: number,
) =>
  migrationEntries.find(([id, name]) => id <= highWaterMark && recordedNamesById.get(id) !== name);

/**
 * A tracker identity that a *released* Moss build wrote for a migration whose
 * canonical ID later changed.
 *
 * v0.5.5 shipped `[54, "ProjectPullRequestPins"]`; v0.6.0 reserved 54 for the
 * private-build `DurableProviderCommandDelivery` identity and moved the pins
 * migration to 69. Without an entry here every v0.5.5 database is misread as a
 * foreign import, and the replay path wipes and re-runs every tracker row from
 * the divergence onward — destructive, and fatal on any database whose schema
 * is already partway into the newer range (migration 56 is a bare
 * `ALTER TABLE ... ADD COLUMN`, so it dies on `duplicate column name`).
 *
 * `historicalSlotRequiresRerun` is the reviewed answer to a single question:
 * does the migration Moss registers at `historicalId` *today* still need to
 * run on a database that recorded the historical identity? When it is `false`
 * the row is renamed to the canonical identity in place and nothing replays;
 * when it is `true` the row is removed so the migrator re-runs that one ID.
 *
 * The alias intentionally does *not* renumber the row to `currentId`: the
 * migrator gates purely on `max(migration_id)`, so moving the row to 69 would
 * skip migrations 54–68, which a v0.5.5 database has genuinely never applied.
 * The migration at `currentId` therefore re-runs, and must be idempotent.
 */
export interface MigrationLineageAlias {
  readonly historicalId: number;
  readonly historicalName: string;
  readonly currentId: number;
  readonly historicalSlotRequiresRerun: boolean;
}

export const MIGRATION_LINEAGE_ALIASES: readonly MigrationLineageAlias[] = [
  {
    // Shipped in v0.5.5. Migration 54 is now `Effect.void` (see
    // `Migrations/054_ReservedDurableProviderCommandDelivery.ts`), so the slot
    // needs no work on a database that already recorded it.
    historicalId: 54,
    historicalName: "ProjectPullRequestPins",
    currentId: 69,
    historicalSlotRequiresRerun: false,
  },
];

export type MigrationLineageAliasRepair =
  | { readonly kind: "rename"; readonly migrationId: number; readonly name: string }
  | { readonly kind: "remove"; readonly migrationId: number };

/**
 * Metadata-only repairs that turn a recorded tracker carrying known historical
 * identities into an exact prefix of the canonical lineage.
 *
 * Returns an empty list unless *every* remaining (id, name) pair lines up
 * afterwards, so a tracker that also diverges for unrelated reasons falls
 * through to the unchanged replay path.
 */
export const planMigrationLineageAliasRepairs = (
  recordedNamesById: ReadonlyMap<number, string>,
): readonly MigrationLineageAliasRepair[] => {
  const applicable = MIGRATION_LINEAGE_ALIASES.filter(
    (alias) =>
      recordedNamesById.get(alias.historicalId) === alias.historicalName &&
      // The historical identity must actually be a divergence today...
      canonicalMigrationNamesById.get(alias.historicalId) !== alias.historicalName &&
      // ...and the alias must still point at where that migration now lives, so
      // a stale table degrades to the old behavior instead of corrupting one.
      canonicalMigrationNamesById.get(alias.currentId) === alias.historicalName,
  );
  if (applicable.length === 0) {
    return [];
  }

  const repaired = new Map(recordedNamesById);
  const repairs: MigrationLineageAliasRepair[] = [];
  for (const alias of applicable) {
    const canonicalName = canonicalMigrationNamesById.get(alias.historicalId);
    if (alias.historicalSlotRequiresRerun || canonicalName === undefined) {
      repaired.delete(alias.historicalId);
      repairs.push({ kind: "remove", migrationId: alias.historicalId });
      continue;
    }
    repaired.set(alias.historicalId, canonicalName);
    repairs.push({ kind: "rename", migrationId: alias.historicalId, name: canonicalName });
  }

  const highWaterMark = Math.max(...repaired.keys(), 0);
  if (findFirstMigrationLineageDivergence(repaired, highWaterMark) !== undefined) {
    return [];
  }
  return repairs;
};

/**
 * Repairs the migration tracker of an imported legacy database before the
 * migrator runs.
 *
 * Imported databases can carry their own `effect_sql_migrations` rows,
 * recorded under that lineage's migration names
 * at the same numeric IDs. The migrator gates purely on max(migration_id), so
 * once the imported tracker's high-water mark reaches Moss's latest ID,
 * every Moss migration is skipped silently and startup crashes on missing
 * columns such as `projection_threads.env_mode`. Renumbering self-heal
 * migrations past the legacy IDs (#023, then #032) loses that race whenever
 * the legacy lineage ships more migrations.
 *
 * Instead, compare the recorded (id, name) pairs against Moss's lineage and
 * delete every tracker row from the first divergence onward. The migrator
 * then re-runs those migrations in order; every migration past
 * {@link LAST_SHARED_LINEAGE_MIGRATION_ID} is idempotent, so re-running them
 * over a legacy-evolved schema is safe and loses no data.
 *
 * Divergences caused by Moss renumbering one of its *own* released
 * migrations are handled first and separately, through
 * {@link MIGRATION_LINEAGE_ALIASES}: those trackers are repaired in place
 * rather than truncated, because the rows below the divergence are genuinely
 * ours and the schema they describe is genuinely applied.
 */
const failForUnsafeClassification = (
  classification: Extract<
    MigrationLineageClassification,
    { readonly kind: "too-new" | "unknown-or-mixed" }
  >,
) => {
  if (classification.kind === "too-new") {
    return Effect.fail(
      new MigrationSchemaTooNewError({
        databaseMigrationId: classification.highWaterMark,
        latestSupportedMigrationId: classification.latestSupportedMigrationId,
      }),
    );
  }
  return Effect.fail(
    new MigrationLineageError({
      firstDivergedId: classification.firstDivergedId ?? 0,
      expectedName: classification.expectedName,
      recordedName: classification.recordedName,
    }),
  );
};

export const reconcileMigrationLineage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inspection = yield* inspectCurrentMigrationLineage;
  const { classification } = inspection;
  if (classification.kind === "too-new" || classification.kind === "unknown-or-mixed") {
    return yield* failForUnsafeClassification(classification);
  }
  if (classification.kind !== "moss-3cefd5a-prefix") return classification;

  // An exact upstream-lineage database is adopted only after a durable
  // pre-migration backup (see runWithPreMigrationBackup): tracker rows from the
  // divergence onward are discarded and every later migration re-runs, which is
  // only safe to attempt once a restorable snapshot exists.
  const authorization = yield* MigrationBackupAuthorization;
  if (!authorization) {
    return yield* Effect.fail(
      new MigrationBackupRequiredError({
        sourceLineage: classification.kind,
        databaseMigrationId: classification.highWaterMark,
      }),
    );
  }

  yield* Effect.logWarning(
    "Adopting exact upstream 3cefd5a migration lineage after durable backup",
  ).pipe(
    Effect.annotateLogs({
      firstDivergedId: classification.firstDivergedId,
      highWaterMark: classification.highWaterMark,
    }),
  );
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id >= ${classification.firstDivergedId}
  `;
  return classification;
});

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
  /** Test-only failure point used to prove adoption transaction rollback. */
  readonly injectFailureAfterLineageReconciliation?: boolean | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = ({
  toMigrationInclusive,
  injectFailureAfterLineageReconciliation = false,
}: RunMigrationsOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* inspectCurrentMigrationLineage;
    if (
      before.classification.kind === "moss-3cefd5a-prefix" &&
      toMigrationInclusive !== undefined &&
      toMigrationInclusive < LATEST_MIGRATION_ID
    ) {
      return yield* Effect.fail(
        new MigrationBackupRequiredError({
          sourceLineage: "partial upstream adoption is forbidden",
          databaseMigrationId: before.classification.highWaterMark,
        }),
      );
    }
    const migrationUnit = Effect.gen(function* () {
      const classification = yield* reconcileMigrationLineage;
      if (injectFailureAfterLineageReconciliation) {
        return yield* Effect.fail(new Error("injected failure after lineage reconciliation"));
      }
      yield* Effect.log(
        toMigrationInclusive === undefined
          ? "Running all migrations..."
          : `Running migrations 1 through ${toMigrationInclusive}...`,
      );
      const executed = yield* run({ loader: makeMigrationLoader(toMigrationInclusive) });
      if (classification.kind === "moss-3cefd5a-prefix") {
        const after = yield* inspectCurrentMigrationLineage;
        if (
          after.classification.kind !== "moss-prefix" ||
          after.classification.highWaterMark !== LATEST_MIGRATION_ID
        ) {
          return yield* Effect.fail(
            new MigrationLineageError({
              firstDivergedId: 53,
              expectedName: `canonical Moss 1-${LATEST_MIGRATION_ID}`,
              recordedName: after.classification.kind,
            }),
          );
        }
      }
      return executed;
    });
    const executedMigrations =
      before.classification.kind === "moss-3cefd5a-prefix"
        ? yield* sql.withTransaction(migrationUnit)
        : yield* migrationUnit;
    yield* Effect.log("Migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
    );
    return executedMigrations;
  });

/**
 * Layer that runs migrations when the layer is built.
 *
 * Use this to ensure migrations run before your application starts.
 * Migrations are run automatically - no separate script is needed.
 *
 * @example
 * ```typescript
 * import { MigrationsLive } from "@acme/db/Migrations"
 * import * as SqliteClient from "@acme/db/SqliteClient"
 *
 * // Migrations run automatically when SqliteClient is provided
 * const AppLayer = MigrationsLive.pipe(
 *   Layer.provideMerge(SqliteClient.layer({ filename: "database.sqlite" }))
 * )
 * ```
 */
export const MigrationsLive = Layer.effectDiscard(runMigrations());
