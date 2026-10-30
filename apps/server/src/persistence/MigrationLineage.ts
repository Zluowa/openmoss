import { Effect, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type MigrationTrackerRow = {
  readonly migration_id: number;
  readonly name: string;
};

export type MigrationSchemaDataFingerprint = {
  readonly effects: ReadonlyArray<string>;
};

export type MigrationLineageClassification =
  | { readonly kind: "fresh-or-untracked" }
  | { readonly kind: "moss-prefix"; readonly highWaterMark: number }
  | {
      readonly kind: "moss-3cefd5a-prefix";
      readonly highWaterMark: number;
      readonly firstDivergedId: 53;
    }
  | {
      readonly kind: "too-new";
      readonly highWaterMark: number;
      readonly latestSupportedMigrationId: number;
    }
  | {
      readonly kind: "unknown-or-mixed";
      readonly highWaterMark: number | null;
      readonly firstDivergedId: number | null;
      readonly expectedName: string;
      readonly recordedName: string;
      readonly detail: string;
    };

const COMMON_DESCRIPTOR = [
  [1, "OrchestrationEvents"],
  [2, "OrchestrationCommandReceipts"],
  [3, "CheckpointDiffBlobs"],
  [4, "ProviderSessionRuntime"],
  [5, "Projections"],
  [6, "ProjectionThreadSessionRuntimeModeColumns"],
  [7, "ProjectionThreadMessageAttachments"],
  [8, "ProjectionThreadActivitySequence"],
  [9, "ProviderSessionRuntimeMode"],
  [10, "ProjectionThreadsRuntimeMode"],
  [11, "OrchestrationThreadCreatedRuntimeMode"],
  [12, "ProjectionThreadsInteractionMode"],
  [13, "ProjectionThreadProposedPlans"],
  [14, "ProjectionThreadProposedPlanImplementation"],
  [15, "ProjectionTurnsSourceProposedPlan"],
  [16, "CanonicalizeModelSelections"],
  [17, "ThreadHandoffMetadata"],
  [18, "ProjectionThreadMessageMentions"],
  [19, "ProjectionThreadsEnvMode"],
  [20, "ProjectionThreadsForkSource"],
  [21, "ProjectionThreadsAssociatedWorktree"],
  [22, "ProjectionThreadsAssociatedWorktreeBranch"],
  [23, "ProjectionThreadsAssociatedWorktreeRef"],
  [24, "ProjectionThreadsArchivedAt"],
  [25, "ProjectionThreadsSubagents"],
  [26, "ProjectionThreadShellSummary"],
  [27, "BackfillProjectionThreadShellSummary"],
  [28, "ProjectionProjectsKind"],
  [29, "ProjectionThreadsLastKnownPr"],
  [30, "ProjectionThreadMessagesDispatchMode"],
  [31, "ProjectionThreadsCreateBranchFlowCompleted"],
  [32, "ReconcileImportedSchemaLineage"],
  [33, "ProjectionThreadsSidechatSource"],
  [34, "AuthAccessManagement"],
  [35, "NormalizeLegacyModelSelectionOptions"],
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionSnapshotCapIndexes"],
  [38, "ReconcileLegacySidechatSource"],
  [39, "ReconcileLegacyPinnedThreads"],
  [40, "ProjectionThreadsPinnedMessagesNotes"],
  [41, "ProjectionProjectsPinned"],
  [42, "ProjectionThreadsMarkers"],
  [43, "ProfileStatsIndexes"],
  [44, "Automations"],
  [45, "AutomationPolicies"],
  [46, "AutomationCompletionPolicy"],
  [47, "AutomationCompletionPolicyVersion"],
  [48, "AutomationCompletionEvaluationBacklog"],
  [49, "ProjectionThreadMessagesDispatchOrigin"],
  [50, "ProfileStatsArchive"],
  [51, "ProfileStatsDeletedTokensModel"],
  [52, "ProjectionThreadUserMessageSummaryIndex"],
] as const;

const MOSS_DESCRIPTOR_SUFFIX = [
  [53, "MossAccountControlPlane"],
  [54, "ProjectionThreadSessionProviderInstance"],
  [55, "ProviderSessionRuntimeInstanceId"],
  [56, "ProfileStatsDeletedTurnsProviderInstance"],
  [57, "ProfileStatsDeletedTokensProviderInstance"],
  [58, "ClearAutomationDefinitionProviderOptions"],
  [59, "ClearAutomationRunProviderOptions"],
  [60, "ScrubOrchestrationEventProviderOptions"],
  [61, "MossCloudAccountBindings"],
  [62, "BackfillThreadActivitySequence"],
  [63, "ProjectPullRequestPins"],
  [64, "DurableProviderCommandDelivery"],
  [65, "ManagedAttachments"],
  [66, "CommandReceiptFingerprints"],
  [67, "ThreadScopedProjectionMessageIdentity"],
  [68, "ThreadScopedPendingApprovalIdentity"],
  [69, "ProviderSessionLifecycleGeneration"],
  [70, "PendingApprovalLifecycleGeneration"],
  [71, "PendingApprovalSettlementState"],
  [72, "PendingInteractionSettlementParity"],
  [73, "ProjectionMessageCausalSequence"],
  [74, "DurableProviderCommandDeliveryCutover"],
  [75, "DurableQueuedTurnPromotions"],
  [76, "DurableProviderRuntimeEvents"],
  [77, "ProviderDeliveryReconciliation"],
  [78, "GitHandoffOperations"],
  [79, "ScrubCodexOrchestrationEventBinaryPath"],
  [80, "AgentGatewayOperations"],
  [81, "ProjectionThreadsGatewayProvenance"],
  [82, "AgentGatewayOperationRetention"],
  [83, "OperationalDiagnostics"],
  [84, "ExternalMcpIntegrations"],
  [85, "ExternalMcpActiveCapacity"],
  [86, "ExternalMcpHardening"],
  [87, "ExternalMcpCompensatingCapacity"],
  [88, "ExternalMcpLiveTurnCapacity"],
  [89, "Spaces"],
  [90, "ExternalMcpProjectScope"],
  [91, "AutomationProposals"],
  [92, "AutomationMemory"],
  [93, "AutomationHeartbeatEligibility"],
  [94, "AutomationNotificationPolicy"],
  [95, "AutomationSettings"],
  [96, "NormalizeStudioThreadWorkspaces"],
  [97, "DropUnusedOrchestrationEventIndexes"],
  [98, "ProjectionThreadsSettledAt"],
  [99, "RecoverRetentionHiddenThreads"],
  [100, "ProjectionThreadMessageTextSegments"],
  [101, "AutomationFailureTolerance"],
  [102, "BackfillAutomationRunThreadSource"],
  [103, "BackfillMaxIterationsDisabledReason"],
  [104, "ProjectionThreadsGoal"],
  [105, "ProjectionThreadsGoalTiming"],
  [106, "ProjectionThreadsGoalAchievements"],
] as const;

const UPSTREAM_DESCRIPTOR_SUFFIX = [
  [53, "BackfillThreadActivitySequence"],
  [54, "DurableProviderCommandDelivery"],
  [55, "ManagedAttachments"],
  [56, "CommandReceiptFingerprints"],
  [57, "ThreadScopedProjectionMessageIdentity"],
  [58, "ThreadScopedPendingApprovalIdentity"],
  [59, "ProviderSessionLifecycleGeneration"],
  [60, "PendingApprovalLifecycleGeneration"],
  [61, "PendingApprovalSettlementState"],
  [62, "PendingInteractionSettlementParity"],
  [63, "ProjectionMessageCausalSequence"],
  [64, "DurableProviderCommandDeliveryCutover"],
  [65, "DurableQueuedTurnPromotions"],
  [66, "DurableProviderRuntimeEvents"],
  [67, "ProviderDeliveryReconciliation"],
  [68, "GitHandoffOperations"],
  [69, "ProjectPullRequestPins"],
  [70, "AgentGatewayOperations"],
  [71, "ProjectionThreadsGatewayProvenance"],
  [72, "AgentGatewayOperationRetention"],
  [73, "OperationalDiagnostics"],
  [74, "ExternalMcpIntegrations"],
  [75, "ExternalMcpActiveCapacity"],
  [76, "ExternalMcpHardening"],
  [77, "ExternalMcpCompensatingCapacity"],
  [78, "ExternalMcpLiveTurnCapacity"],
  [79, "Spaces"],
  [80, "ExternalMcpProjectScope"],
  [81, "AutomationProposals"],
  [82, "AutomationMemory"],
  [83, "AutomationHeartbeatEligibility"],
  [84, "AutomationNotificationPolicy"],
  [85, "AutomationSettings"],
  [86, "NormalizeStudioThreadWorkspaces"],
  [87, "DropUnusedOrchestrationEventIndexes"],
  [88, "ProjectionThreadsSettledAt"],
  [89, "RecoverRetentionHiddenThreads"],
  [90, "ProjectionThreadMessageTextSegments"],
  [91, "AutomationFailureTolerance"],
  [92, "BackfillAutomationRunThreadSource"],
  [93, "BackfillMaxIterationsDisabledReason"],
  [94, "ProjectionThreadsGoal"],
  [95, "ProjectionThreadsGoalTiming"],
  [96, "ProjectionThreadsGoalAchievements"],
  [97, "ProjectionThreadsSidechatLifecycle"],
  [98, "MigrateKiloToOpenCode"],
  [99, "InvalidateProjectionThreadsCursor"],
] as const;

// v0.5.4/v0.5.5 shipped the pull-request pins migration at 54 before
// upstream reserved that slot for provider delivery. This is the only
// historical upstream suffix accepted outside the immutable current
// descriptor, and it still requires schema fingerprint proof plus a durable
// backup before Moss adopts it.
const UPSTREAM_V055_DESCRIPTOR_SUFFIX = [
  [53, "BackfillThreadActivitySequence"],
  [54, "ProjectPullRequestPins"],
] as const;

export const SUPPORTED_HISTORICAL_UPSTREAM_IDENTITIES: ReadonlyArray<readonly [number, string]> =
  Object.freeze([[54, "ProjectPullRequestPins"]]);

export const MOSS_RELEASED_DESCRIPTOR: ReadonlyArray<readonly [number, string]> = Object.freeze([
  ...COMMON_DESCRIPTOR,
  ...MOSS_DESCRIPTOR_SUFFIX,
  [107, "ProjectionSidebarSections"],
  [108, "ProjectionThreadsArchiveSidebarPlacement"],
  [109, "ProjectionSidebarThreadOrder"],
  [110, "ProjectionSidebarProjectOrder"],
  [111, "ProjectionThreadsSidechatLifecycle"],
  [112, "MigrateKiloToOpenCode"],
  [113, "ProjectionThreadMessageRealtimeHandoffId"],
  [114, "InvalidateProjectionThreadsCursor"],
  [115, "MessageTextChunks"],
  [116, "RemoveTranscriptMarkers"],
  [117, "ProjectionThreadMessagesTurnBoundary"],
  [118, "ClaudeTokenAccounting"],
  // Upstream's 104-118 series lands after Moss's frozen 118 in this lineage
  // (same bodies, renumbered past the Moss-only range).
  [119, "ProjectionThreadsClaudeCacheReview"],
  [120, "AsyncUserInput"],
  [121, "ProjectImportOrigins"],
  [122, "ProjectionThreadsHumanMessage"],
  [123, "GatewayCompletions"],
  [124, "ProjectAgent"],
  [125, "Groups"],
  [126, "GroupLibraryHosting"],
  [127, "CoordinatorAppearance"],
  [128, "ProjectAgentWakeCursor"],
  [129, "ProjectAgentLifecycle"],
  [130, "ProjectAgentManagedWorkers"],
  [131, "ProjectAgentWorkerRecovery"],
  [132, "WorkerMonitoringLiveness"],
  [133, "ProfileStatsDeletedProviderInstances"],
  [134, "ProjectionTurnsPendingMessageIndex"],
  [135, "Todos"],
  [136, "ProjectionThreadsSidechatContext"],
  [137, "ProjectImportHistory"],
  [138, "HubWork"],
  [139, "ProjectionThreadsSnooze"],
  [140, "PullRequestAutoFix"],
  [141, "Library"],
  // Upstream v1.0.1's 131_ProjectSourceFolders lands past the frozen Moss 141.
  [142, "ProjectSourceFolders"],
  [143, "ExternalMcpTurnCapacityRecovery"],
  [144, "ProjectionTurnsWorkspaceInitialization"],
  [145, "ProjectionThreadsForkSourceMessage"],
  [146, "LibraryMediaDeletions"],
  // Upstream v1.0.6's turn-activity index, appended so released Moss databases
  // retain their existing migration IDs through 146.
  [147, "ProjectionMessageTurnActivityIndex"],
  [148, "Pages"],
  [149, "AutomationCreateRequests"],
  [150, "GuestShares"],
]);

export const UPSTREAM_3CEFD5A_DESCRIPTOR: ReadonlyArray<readonly [number, string]> = Object.freeze([
  ...COMMON_DESCRIPTOR,
  ...UPSTREAM_DESCRIPTOR_SUFFIX,
]);

// Released upstream v0.8.4 extends the frozen 3cefd5a lineage. Adoption still
// requires all schema/data fingerprints and a durable pre-migration backup.
const UPSTREAM_V084_DESCRIPTOR_SUFFIX = [
  [100, "MessageTextChunks"],
  [101, "RemoveTranscriptMarkers"],
  [102, "ProjectionThreadMessagesTurnBoundary"],
  [103, "ClaudeTokenAccounting"],
] as const;
export const UPSTREAM_V084_DESCRIPTOR: ReadonlyArray<readonly [number, string]> = Object.freeze([
  ...UPSTREAM_3CEFD5A_DESCRIPTOR,
  ...UPSTREAM_V084_DESCRIPTOR_SUFFIX,
]);

export const UPSTREAM_V055_DESCRIPTOR: ReadonlyArray<readonly [number, string]> = Object.freeze([
  ...COMMON_DESCRIPTOR,
  ...UPSTREAM_V055_DESCRIPTOR_SUFFIX,
]);

const UPSTREAM_REQUIRED_EFFECTS = new Map<number, ReadonlyArray<string>>([
  [53, ["data:thread-activity-sequences-backfilled"]],
  [54, ["data:reserved-provider-delivery-noop"]],
  [
    55,
    [
      "table:managed_attachment_blobs",
      "table:managed_attachment_cleanup_jobs",
      "index:idx_managed_attachment_cleanup_jobs_due",
    ],
  ],
  [
    56,
    [
      "column:orchestration_command_receipts:fingerprint_version",
      "column:orchestration_command_receipts:command_fingerprint",
    ],
  ],
  [
    57,
    [
      "primary-key:projection_thread_messages:thread_id,message_id",
      "index:idx_projection_thread_messages_message_id",
    ],
  ],
  [58, ["effect:thread-scoped-pending-interaction-identity"]],
  [59, ["column:provider_session_runtime:lifecycle_generation"]],
  [60, ["effect:pending-interaction-lifecycle-generation"]],
  [61, ["effect:pending-interaction-settlement-columns"]],
  [
    62,
    [
      "table:projection_pending_interactions",
      "index:idx_projection_pending_interactions_request_id",
    ],
  ],
  [
    63,
    [
      "column:projection_thread_messages:sequence",
      "index:idx_projection_thread_messages_thread_sequence",
    ],
  ],
  [
    64,
    [
      "table:orchestration_consumer_state",
      "table:orchestration_event_deliveries",
      "data:provider-command-reactor-consumer",
    ],
  ],
  [65, ["table:queued_turn_promotions", "index:idx_queued_turn_promotions_active_message"]],
  [
    66,
    [
      "table:provider_runtime_events",
      "table:provider_runtime_open_turns",
      "table:provider_runtime_event_consumers",
    ],
  ],
  [
    67,
    [
      "table:provider_delivery_reconciliations",
      "index:idx_provider_delivery_reconciliations_delivery",
    ],
  ],
  [68, ["table:git_handoff_operations", "index:idx_git_handoff_operations_recovery"]],
  [69, ["table:project_pull_request_pins", "trigger:trg_project_pull_request_pins_limit"]],
  [70, ["table:agent_gateway_operations", "index:idx_agent_gateway_operations_status"]],
  [
    71,
    [
      "column:projection_threads:creation_source",
      "column:projection_threads:source_thread_id",
      "column:projection_threads:source_turn_id",
      "column:projection_threads:gateway_operation_id",
      "column:projection_threads:gateway_operation_index",
      "index:idx_projection_threads_gateway_operation",
    ],
  ],
  [72, ["column:agent_gateway_operations:caller_purged_at"]],
  [
    73,
    [
      "table:operational_diagnostics",
      "index:idx_operational_diagnostics_thread_sequence",
      "index:idx_operational_diagnostics_occurred_at",
    ],
  ],
  [
    74,
    [
      "table:external_mcp_integrations",
      "table:external_mcp_integration_projects",
      "table:external_mcp_pairing_codes",
      "table:external_mcp_operations",
      "table:external_mcp_tasks",
      "table:external_mcp_audit_log",
      "table:external_mcp_rate_windows",
      "index:idx_external_mcp_operations_status",
      "index:idx_external_mcp_tasks_project",
      "index:idx_external_mcp_audit_rate",
    ],
  ],
  [
    75,
    ["view:external_mcp_active_capacity_claims", "effect:external-mcp-capacity-compensation-aware"],
  ],
  [76, ["column:external_mcp_integrations:client_kind", "table:external_mcp_rate_windows"]],
  [77, ["effect:external-mcp-capacity-compensation-aware"]],
  [78, ["effect:external-mcp-capacity-live-turn-authoritative"]],
  [
    79,
    [
      "table:projection_spaces",
      "column:projection_projects:space_id",
      "index:idx_projection_spaces_active_order",
      "index:idx_projection_projects_space_id",
    ],
  ],
  [80, ["column:external_mcp_integrations:project_scope"]],
  [81, ["column:automation_definitions:proposal_state"]],
  [82, ["table:automation_memory"]],
  [
    83,
    [
      "column:automation_definitions:heartbeat_cooldown_seconds",
      "column:automation_runs:deferred_until",
    ],
  ],
  [84, ["column:automation_definitions:notification_policy"]],
  [85, ["table:automation_settings"]],
  [86, ["column:projection_threads:working_directory"]],
  [
    87,
    ["absence:index:idx_orch_events_command_id", "absence:index:idx_orch_events_correlation_id"],
  ],
  [88, ["column:projection_threads:settled_at"]],
  [90, ["table:message_text_segments"]],
  [
    91,
    [
      "column:automation_definitions:stop_after_consecutive_failures",
      "column:automation_definitions:consecutive_failure_count",
      "column:automation_definitions:disabled_reason",
      "column:automation_definitions:disabled_at",
    ],
  ],
  [92, ["column:projection_threads:creation_source"]],
  [94, ["column:projection_threads:goal"]],
  [95, ["column:projection_threads:goal_started_at", "column:projection_threads:goal_paused_at"]],
  [96, ["column:projection_threads:goal_achievements_json"]],
  [
    100,
    [
      "column:projection_thread_messages:text_event_sequence",
      "column:projection_thread_messages:text_json",
      "column:message_text_segments:text_json",
      "table:message_text_chunks",
      "index:idx_message_text_chunks_segment",
    ],
  ],
  [
    101,
    ["absence:column:projection_threads:thread_markers_json", "data:transcript-markers-retired"],
  ],
  [102, ["column:projection_thread_messages:starts_new_turn"]],
  [
    103,
    [
      "column:profile_stats_deleted_tokens:token_accounting_version",
      "table:profile_stats_claude_legacy_usage",
    ],
  ],
]);

export const requiredUpstreamFingerprintThrough = (highWaterMark: number): ReadonlyArray<string> =>
  [...UPSTREAM_REQUIRED_EFFECTS.entries()]
    .filter(([id]) => id <= highWaterMark)
    .flatMap(([, effects]) => effects)
    .filter((effect, index, all) => all.indexOf(effect) === index)
    .sort();

const prefixMatches = (
  tracker: ReadonlyArray<MigrationTrackerRow>,
  descriptor: ReadonlyArray<readonly [number, string]>,
): boolean =>
  tracker.every(
    (row, index) =>
      descriptor[index]?.[0] === row.migration_id && descriptor[index]?.[1] === row.name,
  );

const unknown = (
  tracker: ReadonlyArray<MigrationTrackerRow>,
  detail: string,
): MigrationLineageClassification => {
  const highWaterMark = tracker.at(-1)?.migration_id ?? null;
  const divergence = tracker.find((row, index) => {
    const moss = MOSS_RELEASED_DESCRIPTOR[index];
    const upstream = UPSTREAM_V084_DESCRIPTOR[index];
    return row.migration_id !== index + 1 || (row.name !== moss?.[1] && row.name !== upstream?.[1]);
  });
  const id = divergence?.migration_id ?? Math.min((highWaterMark ?? 0) + 1, 53);
  return {
    kind: "unknown-or-mixed",
    highWaterMark,
    firstDivergedId: divergence?.migration_id ?? null,
    expectedName:
      MOSS_RELEASED_DESCRIPTOR.find(([migrationId]) => migrationId === id)?.[1] ?? "<none>",
    recordedName: divergence?.name ?? detail,
    detail,
  };
};

export function classifyMigrationLineage(
  tracker: ReadonlyArray<MigrationTrackerRow>,
  fingerprint: MigrationSchemaDataFingerprint,
): MigrationLineageClassification {
  if (tracker.length === 0) return { kind: "fresh-or-untracked" };
  if (tracker.some((row, index) => row.migration_id !== index + 1)) {
    return unknown(tracker, "tracker IDs must be a contiguous, unique prefix beginning at 1");
  }

  const highWaterMark = tracker[tracker.length - 1]!.migration_id;
  const mossPrefix = prefixMatches(tracker, MOSS_RELEASED_DESCRIPTOR);
  if (mossPrefix) return { kind: "moss-prefix", highWaterMark };
  if (
    highWaterMark > MOSS_RELEASED_DESCRIPTOR.length &&
    prefixMatches(tracker.slice(0, MOSS_RELEASED_DESCRIPTOR.length), MOSS_RELEASED_DESCRIPTOR)
  ) {
    return {
      kind: "too-new",
      highWaterMark,
      latestSupportedMigrationId: MOSS_RELEASED_DESCRIPTOR.length,
    };
  }

  const upstreamPrefix = prefixMatches(tracker, UPSTREAM_V084_DESCRIPTOR);
  if (upstreamPrefix && highWaterMark >= 53) {
    const actualEffects = new Set(fingerprint.effects);
    const missing = requiredUpstreamFingerprintThrough(highWaterMark).filter(
      (effect) => !actualEffects.has(effect),
    );
    if (missing.length > 0) {
      return unknown(tracker, `upstream schema/data fingerprint is missing: ${missing.join(", ")}`);
    }
    return { kind: "moss-3cefd5a-prefix", highWaterMark, firstDivergedId: 53 };
  }

  const upstreamV055Prefix = prefixMatches(tracker, UPSTREAM_V055_DESCRIPTOR);
  if (upstreamV055Prefix && highWaterMark === 54) {
    const actualEffects = new Set(fingerprint.effects);
    const requiredEffects = [
      ...requiredUpstreamFingerprintThrough(53),
      ...(UPSTREAM_REQUIRED_EFFECTS.get(69) ?? []),
    ];
    const missing = requiredEffects.filter((effect) => !actualEffects.has(effect));
    if (missing.length > 0) {
      return unknown(
        tracker,
        `upstream v0.5.5 schema/data fingerprint is missing: ${missing.join(", ")}`,
      );
    }
    return { kind: "moss-3cefd5a-prefix", highWaterMark, firstDivergedId: 53 };
  }
  if (
    highWaterMark > UPSTREAM_V084_DESCRIPTOR.length &&
    prefixMatches(tracker.slice(0, UPSTREAM_V084_DESCRIPTOR.length), UPSTREAM_V084_DESCRIPTOR)
  ) {
    return {
      kind: "too-new",
      highWaterMark,
      latestSupportedMigrationId: MOSS_RELEASED_DESCRIPTOR.length,
    };
  }
  return unknown(tracker, "tracker names do not match the complete Moss or upstream descriptor");
}

export const MigrationBackupAuthorization = ServiceMap.Reference<boolean>(
  "@synara/persistence/MigrationBackupAuthorization",
  { defaultValue: () => false },
);

type SqliteMasterRow = {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};

export const inspectCurrentMigrationLineage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const master = yield* sql<SqliteMasterRow>`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `;
  const tableNames = master.filter(({ type }) => type === "table").map(({ name }) => name);
  const trackerExists = tableNames.includes("effect_sql_migrations");
  const tracker = trackerExists
    ? yield* sql<MigrationTrackerRow>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        ORDER BY migration_id ASC
      `
    : [];

  const effects = new Set<string>();
  for (const row of master) {
    if (
      row.type === "table" ||
      row.type === "index" ||
      row.type === "view" ||
      row.type === "trigger"
    ) {
      effects.add(`${row.type}:${row.name}`);
    }
  }

  if (tableNames.includes("orchestration_events")) {
    if (!effects.has("index:idx_orch_events_command_id")) {
      effects.add("absence:index:idx_orch_events_command_id");
    }
    if (!effects.has("index:idx_orch_events_correlation_id")) {
      effects.add("absence:index:idx_orch_events_correlation_id");
    }
  }

  for (const table of tableNames) {
    const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
      SELECT name, pk FROM pragma_table_info(${table}) ORDER BY cid
    `;
    for (const column of columns) effects.add(`column:${table}:${column.name}`);
    const primaryKey = columns
      .filter(({ pk }) => pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name);
    if (primaryKey.length > 0) {
      effects.add(`primary-key:${table}:${primaryKey.join(",")}`);
    }
  }

  if (
    tableNames.includes("projection_threads") &&
    !effects.has("column:projection_threads:thread_markers_json")
  ) {
    effects.add("absence:column:projection_threads:thread_markers_json");
  }
  if (tableNames.includes("orchestration_events")) {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events
      WHERE event_type IN ('thread.marker-added', 'thread.marker-removed',
        'thread.marker-done-set', 'thread.marker-label-set')
        OR (event_type = 'thread.meta-updated'
          AND json_type(payload_json, '$.threadMarkers') IS NOT NULL)
    `;
    if ((rows[0]?.count ?? 0) === 0) effects.add("data:transcript-markers-retired");
  }

  effects.add("data:reserved-provider-delivery-noop");
  if (
    tableNames.includes("projection_thread_activities") &&
    tableNames.includes("orchestration_events")
  ) {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM projection_thread_activities AS activity
      INNER JOIN orchestration_events AS event
        ON event.event_type = 'thread.activity-appended'
       AND json_extract(event.payload_json, '$.activity.id') = activity.activity_id
      WHERE activity.sequence = 0
    `;
    if ((rows[0]?.count ?? 0) === 0) effects.add("data:thread-activity-sequences-backfilled");
  }
  if (tableNames.includes("orchestration_consumer_state")) {
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_consumer_state
      WHERE consumer_name = 'provider-command-reactor.v1'
    `;
    if ((rows[0]?.count ?? 0) === 1) effects.add("data:provider-command-reactor-consumer");
  }

  const has = (effect: string) => effects.has(effect);
  if (
    has("primary-key:projection_pending_approvals:thread_id,request_id") ||
    has("primary-key:projection_pending_interactions:thread_id,interaction_kind,request_id")
  )
    effects.add("effect:thread-scoped-pending-interaction-identity");
  if (
    has("column:projection_pending_approvals:lifecycle_generation") ||
    has("column:projection_pending_interactions:lifecycle_generation")
  )
    effects.add("effect:pending-interaction-lifecycle-generation");
  if (
    (has("column:projection_pending_approvals:response_command_id") &&
      has("column:projection_pending_approvals:response_requested_at")) ||
    (has("column:projection_pending_interactions:response_command_id") &&
      has("column:projection_pending_interactions:response_requested_at"))
  )
    effects.add("effect:pending-interaction-settlement-columns");

  const capacityView = master.find(
    ({ type, name }) => type === "view" && name === "external_mcp_active_capacity_claims",
  )?.sql;
  if (capacityView?.includes("operations.status IN ('reserved', 'dispatching', 'compensating')")) {
    effects.add("effect:external-mcp-capacity-compensation-aware");
  }
  if (capacityView?.includes("WHEN turns.state IN ('pending', 'running') THEN turns.state")) {
    effects.add("effect:external-mcp-capacity-live-turn-authoritative");
  }

  return {
    trackerExists,
    hasUserSchema: master.some(
      ({ type, name }) => type === "table" && name !== "effect_sql_migrations",
    ),
    tracker,
    fingerprint: { effects: [...effects].sort() },
    classification: classifyMigrationLineage(tracker, { effects: [...effects] }),
  } as const;
});
