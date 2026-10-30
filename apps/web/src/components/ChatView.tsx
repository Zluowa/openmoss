import { ensureThreadHistoryLoaded, useThreadHistory } from "../threadHistory";
import { createPortal } from "react-dom";
import {
  flushConversationImageEditors,
  getConversationImageComposer,
  useConversationImageComposer,
} from "~/lib/conversationImageComposer";
import {
  conversationImageIdentity,
  mergeConversationImages,
} from "~/lib/conversationGeneratedImages";
import { resolveGeneratedImageGalleryGroup } from "./chat/GeneratedImageGallery";
import { type LegendListRef } from "@legendapp/list/react";
import {
  parseComputerInvocation,
  resolveComputerInvocationMode,
} from "@synara/shared/computerInvocation";
import {
  MessageId,
  OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
  type AutomationDefinition,
  type EditorId,
  type ModelSelection,
  type ModelSlug,
  type PinnedMessage,
  type PendingClaudeCacheReview,
  type ProjectId,
  type ProjectScript,
  type ProviderInstanceId,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type RuntimeMode,
  type ServerProviderStatus,
  type ThreadGoalAchievement,
  type TurnId,
} from "@synara/contracts";
import { resolveLatestTailUserMessageEditTarget } from "@synara/shared/conversationEdit";
import { getModelCapabilities, resolveApiModelId } from "@synara/shared/model";
import {
  resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd,
  resolveThreadBranchSourceCwd,
  resolveThreadWorkspaceState,
} from "@synara/shared/threadEnvironment";
import { threadExportBlockedReason } from "@synara/shared/threadExport";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCopyThreadIdToClipboard } from "~/hooks/useCopyToClipboard";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { useRepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useThreadRecap } from "~/hooks/useThreadRecap";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "~/lib/chatPaneScope";
import type { RightDockHtmlDocument } from "~/rightDockStore.logic";
import { formatComposerMentionToken } from "~/lib/composerMentions";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitBranchesQueryOptions,
  gitCreateDetachedWorktreeMutationOptions,
  gitGithubRepositoryQueryOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { LoaderCircleIcon, RefreshCwIcon, TemporaryThreadIcon, FolderIcon } from "~/lib/icons";
import { getLocalFolderBrowseRootPath } from "~/lib/localFolderMentions";
import {
  findProviderStatus,
  isProviderDurablyUnavailable,
  isServerConfiguredMossDefaultManagedProvider,
  resolveProviderSendAdmission,
  resolveVoiceTranscriptionTarget,
} from "~/lib/providerAvailability";
import {
  isMossPayAccountTransitionPending,
  resolveMossPayQuotaAccountIdentity,
} from "~/lib/mossPayQuotaIdentity";
import { evaluateMossQuotaAdmission, type MossQuotaAdmission } from "~/lib/mossQuotaAdmission";
import {
  serverProviderUsageSnapshotQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import {
  mossServerMutationKeys,
  mossServerQueryKeys,
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "./auth/mossServerReactQuery";
import { resolveProviderInstanceLabel } from "~/lib/providerInstancePresentation";
import { holdQueuedComposerTurnsForStop } from "~/lib/queuedComposerDrain";
import { resolveAuxiliaryTextGenerationSelection } from "~/lib/textGenerationCapabilities";
import { cn, isMacNavigatorPlatform, newCommandId, newThreadId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { dispatchThreadSnoozedUntil, resolveSnoozeDeadline } from "~/lib/threadSnooze";
import {
  ChatLinkActionsContext,
  parseGitHubItemUrl,
  type ChatLinkActions,
} from "~/lib/linkContextMenu";
import { openExternalLink } from "~/lib/linkChips";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import { projectScriptRuntimeEnv } from "~/projectScripts";
import {
  getAppModelOptions,
  getCustomModelsForProvider,
  resolveAppModelSelection,
  resolveAssistantDeliveryMode,
  resolveDefaultProviderInstanceId,
  useAppSettings,
} from "../appSettings";
import { GROUPS_ON, MCP_CONNECTORS_ON } from "../betaFeatures";
import { mcpConnectorsQueryOptions } from "../lib/mcpConnectorsReactQuery";
import { providerSupportsMcpConnectors } from "@synara/shared/mcpConnectors";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  stripComposerTriggerText,
} from "../composer-logic";
import {
  useComposerDraftStore,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
} from "../composerDraftStore";
import { composerDraftHasUnsentContent } from "../composerDraftDomain";
import { hasActiveComposerSend } from "../lib/composerSendOwnership";
import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import {
  buildGoalSlashCommandPrompt,
  canExecuteSideSlashCommand,
  canOfferForkSlashCommand,
  canOfferReviewSlashCommand,
  canOfferSideSlashCommand,
  hasProviderNativeSlashCommand,
  resolveComposerSlashRootBranch,
} from "../composerSlashCommands";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { isElectron } from "../env";
import { useFeatureFlags } from "../featureFlags";
import {
  resolveThreadMentionForThreadId,
  useComposerCommandMenuItems,
} from "../hooks/useComposerCommandMenuItems";
import { useComposerThreadMentionDrop } from "../hooks/useComposerThreadMentionDrop";
import { splitComposerDropzoneFiles, useComposerDropzone } from "../hooks/useComposerDropzone";
import { useComposerImageIntake } from "../hooks/useComposerImageIntake";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
import { useClaudeContextCompaction } from "../hooks/useClaudeContextCompaction";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useTheme } from "../hooks/useTheme";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useThreadUnblock } from "../hooks/useThreadUnblock";
import { useThreadWorkspaceHandoff } from "../hooks/useThreadWorkspaceHandoff";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useComputerControlModeChange } from "~/hooks/useComputerControlModeChange";
import { useThreadComputerStateSeed } from "../hooks/useThreadComputerStateSeed";
import {
  useThreadComputerAvailability,
  useThreadComputerControlGeneration,
} from "../computerStateStore";
import { formatShortcutLabel, shortcutLabelForCommand } from "../keybindings";
import { useTranslation } from "../localization";
import { dispatchThreadNotes } from "~/pinnedMessages";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { useChatShellStateStore } from "~/chatShellStateStore";
import { ComposerRealtimeVoiceButton } from "./chat/ComposerRealtimeVoiceButton";
import { RealtimeVoiceComposerControls } from "./chat/RealtimeVoiceComposerControls";
import { RealtimeVoiceLaunchOverlay } from "./chat/RealtimeVoiceLaunchOverlay";
import {
  hasCompletedRealtimeVoiceOnboarding,
  persistRealtimeVoiceOnboardingCompletion,
  RealtimeVoiceOnboarding,
} from "./chat/RealtimeVoiceOnboarding";
import { RealtimeVoiceStage } from "./chat/RealtimeVoiceStage";
import { RealtimeVoiceViewportLayer } from "./chat/RealtimeVoiceViewportLayer";
import { useRealtimeVoiceController } from "./chat/RealtimeVoiceControllerProvider";
import { isHomeChatContainerProject } from "../lib/chatProjects";
import { isGroupContainerProject } from "../lib/groupProjects";
import { appendComposerPromptText } from "../lib/chatReferences";
import { createPastedTextDraft } from "../lib/composerPastedText";
import {
  buildComposerFileAttachmentsFromFiles,
  effectiveComposerAttachmentCount,
} from "../lib/composerSend";
import {
  deriveContextWindowSelectionStatus,
  deriveComposerContextWindowLabel,
  deriveObservedClaudeContextBudget,
  deriveAppliedContextWindowSelection,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowState,
} from "../lib/contextWindow";
import { reconcileDeletedThreadFromClient } from "../lib/deletedThreadClientReconciliation";
import { resolveGroupCoordinatorDisplayName } from "../lib/groupCoordinatorName";
import {
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
} from "../lib/runtimeMode";
import { addSelectionToSide, startSelectionChat } from "../lib/selectionChat";
import { waitForSidechatCreator } from "../lib/sidechatCreatorRegistry";
import {
  formatSubagentModelLabel,
  resolveSubagentPresentationForThread,
  resolveSubagentThreadStatusKind,
} from "../lib/subagentPresentation";
import {
  insertInlineTerminalContextPlaceholder,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { registerTerminalContextComposerTarget } from "../lib/terminalContextComposerRegistry";
import {
  resolveDiffEnvironmentState,
  resolveThreadEnvironmentMode,
} from "../lib/threadEnvironment";
import { resolveInheritedThreadContext } from "../lib/threadBootstrap";
import {
  canCreateThreadHandoff,
  canContinueThreadHandoff,
  resolveAvailableHandoffTargets,
  resolveThreadHandoffAvailability,
  type ThreadHandoffTarget,
} from "../lib/threadHandoff";
import { FORK_THREAD_TARGET_LABELS } from "../lib/threadFork";
import { buildDraftThreadRenameCreateInput, dispatchThreadRename } from "../lib/threadRename";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { proposedPlanTitle } from "../proposedPlan";
import { buildModelSelection, buildNextProviderOptions } from "../providerModelOptions";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import { AutomationDialog, automationsForThread } from "../routes/-automations.shared";
import {
  deriveActiveBackgroundTasksState,
  deriveActiveTaskListState,
  deriveActiveWorkStartedAt,
  derivePendingBackgroundWork,
  derivePhase,
  deriveTimelineEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasLiveTurnTailWork,
  isLatestTurnSettled,
  type ActiveTaskListState,
} from "../session-logic";
import {
  resolveSplitViewFocusedThreadId,
  selectSplitView,
  useSplitViewStore,
  type SplitViewPanePanelState,
} from "../splitViewStore";
import { useStore } from "../store";
import {
  createComposerThreadMentionSourcesSelector,
  createProjectSelector,
  createSidechatSummariesForSourceSelector,
  createThreadSelector,
} from "../storeSelectors";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { getThreadFromState } from "../threadDerivation";
import { isThreadDetailAwaitingVerification } from "../threadDetailAuthority";
import { retryThreadDetailSync } from "../threadDetailSyncRetry";
import { SETTINGS_TARGETS } from "../settingsNavigation";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Thread,
} from "../types";
import { useWorkflowRunUiStore } from "../workflowRunUiStore";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import BranchToolbar, { RuntimeUsageControls } from "./BranchToolbar";
import {
  ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS,
  DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
  DismissedProviderHealthBannersSchema,
  PullRequestDialogState,
  appendVoiceTranscriptToPrompt,
  buildCollapsedCursorModelOptionsReset,
  buildLocalDraftThread,
  buildThreadBreadcrumbs,
  canApplyComposerFocus,
  commitAfterRuntimeModePersistence,
  derivePromptHistoryFromMessages,
  hasFileUndoSettled,
  resolveActiveThreadTitle,
  type TurnDispatchSettings,
  resolveActiveTurnLiveDiffState,
  resolveCommittedProviderModel,
  resolveDefaultEnvironmentPanelOpen,
  resolveDraftFallbackModelSelection,
  resolveEnvironmentPanelOpen,
  resolveEnvironmentPanelPreferenceUpdate,
  resolveEnvironmentPanelVisible,
  resolveGitRepoUiState,
  resolveSettledThreadBranchMismatch,
  resolveThreadArtifactWorkspaceRoot,
  resolveThreadDetailHydration,
  resolveLatestProviderRetryLabel,
  resolveWorkingLabel,
  shouldEnableComposerPastedTextCollapse,
  shouldRenderProviderHealthBanner,
  shouldShowComposerProviderInstancePicker,
  shouldStartActiveTurnLayoutGrace,
  steerSkipsLiveCompaction,
  type PendingFileUndo,
  decodePendingRealtimeVoiceLaunch,
  encodePendingRealtimeVoiceLaunch,
  type PendingRealtimeVoiceLaunchAction,
  resolveRealtimeVoiceLaunchRequest,
  resolveRealtimeVoiceOnboardingLaunchDisposition,
  shouldUseRealtimeVoiceOwningComposerControls,
} from "./ChatView.logic";
import { createThreadLineageSelector, localSubagentThreadId } from "./ChatView.selectors";
import { ComposerPromptEditor } from "./ComposerPromptEditor";
import PlanSidebar from "./PlanSidebar";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { hasUnseenSnoozeReturn } from "./Sidebar.logic";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { MossLogo } from "./MossLogo";
import TerminalWorkspaceTabs from "./TerminalWorkspaceTabs";
import { ThreadWorktreeHandoffDialog } from "./ThreadWorktreeHandoffDialog";

import { ChatComposerFooter } from "./chat/ChatComposerFooter";
import { GuestPendingMessages } from "./chat/guestShare/GuestPendingMessages";
import { ChatComposerSendButton } from "./chat/ChatProviderSendControl";
import {
  hasComposerResumeProjectionAdvancedSince,
  isComposerResumeEligible,
  isComposerResumePendingForThread,
} from "./chat/composerResume.logic";
import {
  MossControlPlanePanel,
  MossNativeShellAccessStrip,
  type MossControlPlaneSurface,
} from "./chat/MossControlPlanePanel";
import { resolveMossShellProductizationState } from "../mossShellProductization";
import { ChatHeader } from "./chat/ChatHeader";
import { OpenThreadTabStrip } from "./chat/OpenThreadTabStrip";
import { ChatSurfaceHeader } from "./chat/ChatSurfaceHeader";
import { useAsyncUserInputResponse } from "./chat/useAsyncUserInputResponse";
import { ChatTranscriptPane } from "./chat/ChatTranscriptPane";
import { ComposerActiveTaskListCard } from "./chat/ComposerActiveTaskListCard";
import { ComposerBranchMismatchBanner } from "./chat/ComposerBranchMismatchBanner";
import { ComposerCapsuleRow } from "./chat/ComposerCapsule";
import { ComposerColumnFrame, ComposerStackedHeaderFrame } from "./chat/ComposerColumnFrame";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import { ComposerExpiredUserInputNotice } from "./chat/ComposerExpiredUserInputNotice";
import { ComposerExtrasPanel } from "./chat/ComposerExtrasPanel";
import { ComposerExtrasTrigger } from "./chat/ComposerExtrasTrigger";
import { ComposerGoalHeader } from "./chat/ComposerGoalHeader";
import { ComposerInputBanners } from "./chat/ComposerInputBanners";
import { ComposerTransportNotice } from "./chat/ComposerTransportNotice";
import { ComposerLiveChangesHeader } from "./chat/ComposerLiveChangesHeader";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./chat/ComposerLocalDirectoryMenu";
import {
  ComposerModelPicker,
  type ComposerModelSelectionOptions,
} from "./chat/ComposerModelPicker";
import { ProviderInstancePicker } from "./chat/ProviderInstancePicker";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { HubPendingApprovals } from "./chat/group/HubPendingApprovals";
import { shouldShowHubPendingApprovals } from "./chat/group/HubPendingApprovals.logic";
import { ComposerPendingBackgroundWorkRow } from "./chat/ComposerPendingBackgroundWorkRow";
import {
  ComposerClaudeCacheReviewPanel,
  isClaudeCacheReviewPanelVisible,
  type ClaudeCacheReviewDecision,
} from "./chat/ComposerClaudeCacheReviewPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerQueuedHeader } from "./chat/ComposerQueuedHeader";
import {
  COMPUTER_CONTROL_HINT_EFFORT,
  shouldShowComputerControlEffortHint,
} from "./chat/composerComputerControlHint";
import { ComposerComputerControlEffortHint } from "./chat/ComposerComputerControlEffortHint";
import { ComposerTipRow } from "./chat/ComposerTipRow";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./chat/composerStackedPanelStyles";
import { ComposerPullRequestAutoFixHint } from "./chat/ComposerPullRequestAutoFixHint";
import {
  applyComposerPrediction,
  createPredictionTriggerTracker,
  COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY,
  deriveModelComposerPrediction,
} from "./chat/composerPrediction";
import { ComposerReferenceAttachments } from "./chat/ComposerReferenceAttachments";
import { ComposerSlashStatusDialog } from "./chat/ComposerSlashStatusDialog";
import {
  findLatestRunningSubagentRun,
  subagentRunPhaseStatusKind,
} from "./chat/SubagentRunCard.logic";
import { useSubagentRunControls } from "./chat/useSubagentRunControls";
import type { SubagentThreadPresentation } from "./chat/SubagentThreadIntro";
import {
  collectForegroundRunningSubagentStripItems,
  collectRunningSubagentStripItems,
} from "./chat/ComposerSubagentStrip.logic";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { ExpandedImageOverlay } from "./chat/ExpandedImageOverlay";
import { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { useExpandedImagePreview } from "./chat/useExpandedImagePreview";
import { ExpiredSidechatNotice } from "./chat/ExpiredSidechatNotice";
import type { MessagesTimelineController } from "./chat/MessagesTimeline";
import {
  buildTurnDiffSummaryByAssistantMessageId,
  deriveTurnTimingByTurnId,
  groupGeneratedImagesByTurn,
} from "./chat/MessagesTimeline.logic";
import { ProjectPicker } from "./chat/ProjectPicker";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { resolveProviderModelLabel } from "./chat/ProviderModelPicker";
import {
  RateLimitBanner,
  deriveLatestRateLimitStatus,
  type RateLimitStatus,
} from "./chat/RateLimitBanner";
import { ImageGenerationLimitBanner } from "./chat/ImageGenerationLimitBanner";
import { MossQuotaExhaustedSurface } from "./chat/MossQuotaExhaustedSurface";
import {
  PERSONAL_IMAGE_USAGE_URL,
  createImageGenerationLimitThreadSelector,
  getImageGenerationLimitResetDelayMs,
  resolveImageGenerationAccountSource,
  resolveImageGenerationLimitPresentation,
  selectImageGenerationLimitState,
  shouldShowImageGenerationLimitBanner,
} from "./chat/imageGenerationLimit.logic";
import {
  isQuotaOwnedThreadError,
  resolveQuotaOwnedThreadError,
} from "./chat/threadErrorPresentation";
import { ThreadDetailHydrationState } from "./chat/ThreadDetailHydrationState";
import { ChatThreadFindHost } from "./chat/ThreadFindBar";
import { resolveTraitsTriggerSummary } from "./chat/TraitsPicker";
import { TranscriptSelectionActionLayer } from "./chat/TranscriptSelectionActionLayer";
import { WorkflowRunCapsule } from "./chat/WorkflowRunCard";
import { deriveAgentActivityTimelineState } from "./chat/agentActivity.logic";
import {
  ENVIRONMENT_DOCKED_CONTENT_INSET_PX,
  EnvironmentPanel,
  type EnvironmentPanelProps,
} from "./chat/environment/EnvironmentPanel";
import type { GroupSettingsSection } from "./chat/group/groupSettingsDialog.logic";
import { CoordinatorSuggestions } from "./chat/project/CoordinatorSuggestions";
import {
  shouldShowCoordinatorSuggestions,
  visibleCoordinatorSuggestionChips,
} from "./chat/project/coordinatorSuggestions.logic";
import { ProjectPanel } from "./chat/project/ProjectPanel";
import { LibraryPanel } from "./chat/group/LibraryPanel";
import { useHubWorkItems } from "./chat/project/useHubWorkItems";
import { hubWorkItemsBySourceMessage } from "./chat/project/hubWorkItems";
import { useProjectAgentSummaries } from "./chat/project/useProjectAgentSummaries";
import { useProjectAgentSummariesStore } from "./chat/project/useProjectAgentSummaries";
import { GroupPausedBanner } from "./chat/group/GroupPausedBanner";
import { useProjectInstructionsSource } from "./chat/project/useProjectInstructionsSource";
import { resolveProjectPanelEnabled } from "./chat/auxiliary/auxiliaryPanel.logic";
import { useAuxiliarySurface } from "./chat/auxiliary/useAuxiliarySurface";
import {
  createGroupNeedsAttentionSelector,
  type GroupNeedsAttentionGroup,
} from "./chat/project/groupOverview.logic";
import { usePinnedMessageActions } from "./chat/environment/usePinnedMessageActions";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
} from "./chat/chatHeaderControls";
import type { LateComposerSendHandlers } from "./chat/chatSendTypes";
import { composerTranscriptBottomInsetPx, useComposerOverlayHeight } from "./chat/composerOverlay";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOLDER_PICKER_CAPSULE_HOVER_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME,
  COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME,
  COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME,
  COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
  ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
} from "./chat/composerPickerStyles";
import { getComposerTraitSelection } from "./chat/composerTraits";
import { deriveFastModeNotice } from "~/lib/fastModeState";
import { AmbientRailSlot } from "./chat/AmbientRailSlot";
import { ComputerPreviewPopover } from "./chat/ComputerPreviewPopover";
import {
  computerPreviewBudgetPx,
  computerPreviewCardCaps,
} from "./chat/ComputerPreviewPopover.logic";
import {
  selectThreadComputerPreviewLayout,
  selectThreadComputerPreviewSession,
  useComputerPreviewStore,
} from "../computerPreviewStore";
import { resolveRuntimeModelDescriptor } from "./chat/runtimeModelCapabilities";
import { createThreadFindHighlightStore, type ThreadFindMatch } from "./chat/threadFind.logic";
import { useChatAutomationCreation } from "./chat/useChatAutomationCreation";
import { useChatAutomationSetup } from "./chat/useChatAutomationSetup";
import { AutomationCreationPendingDialog } from "./automation/AutomationCreationPendingDialog";
import { useChatComposerCommands } from "./chat/useChatComposerCommands";
import { useChatComposerDraft } from "./chat/useChatComposerDraft";
import { useChatComposerEditing } from "./chat/useChatComposerEditing";
import { useChatKeyboardShortcuts } from "./chat/useChatKeyboardShortcuts";
import { useComposerEffortCycle } from "./chat/useComposerEffortCycle";
import { useChatLocalDispatch } from "./chat/useChatLocalDispatch";
import { useChatPendingInteractions } from "./chat/useChatPendingInteractions";
import { useChatProjectScripts } from "./chat/useChatProjectScripts";
import { useChatProviderModels } from "./chat/useChatProviderModels";
import { useChatProviderStatus } from "./chat/useChatProviderStatus";
import { useChatQueuedTurns } from "./chat/useChatQueuedTurns";
import { useChatRuntimeModes } from "./chat/useChatRuntimeModes";
import { useChatTerminalController } from "./chat/useChatTerminalController";
import { useChatTimelineMessages } from "./chat/useChatTimelineMessages";
import { useChatTranscriptScroll } from "./chat/useChatTranscriptScroll";
import { useChatTurnFollowUps } from "./chat/useChatTurnFollowUps";
import { useChatTurnSubmission } from "./chat/useChatTurnSubmission";
import { useChatWorkLog } from "./chat/useChatWorkLog";
import { useChatWorkspaceSelection } from "./chat/useChatWorkspaceSelection";
import { useComposerDiscovery } from "./chat/useComposerDiscovery";
import { useComposerReferences } from "./chat/useComposerReferences";
import { useComposerSingleRow } from "./chat/useComposerSingleRow";
import { useComposerVoiceController } from "./chat/useComposerVoiceController";
import { useThreadErrorToast } from "./chat/useThreadErrorToast";
import { useTranscriptAssistantSelectionAction } from "./chat/useTranscriptAssistantSelectionAction";
import {
  composerFooterPlanForTier,
  resolveNextComposerFooterTier,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { Button } from "./ui/button";
import { SidebarHeaderTrigger } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";
import { toastManager } from "./ui/toast";
import { isSidechatThread, isStandaloneSidechatThread } from "@synara/shared/sidechatThread";

// The terminal panel loads xterm plus its addons (~223 KB gzip). Its mount point
// is conditional, so loading it lazily keeps the terminal stack out of the initial
// chat bundle and defers the cost to the first time a terminal is actually opened.
const ThreadTerminalDrawer = lazy(() => import("./ThreadTerminalDrawer"));

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PINNED_MESSAGES: readonly PinnedMessage[] = [];
const EMPTY_GOAL_ACHIEVEMENTS: readonly ThreadGoalAchievement[] = [];
const EMPTY_PINNED_TEXT: ReadonlyMap<MessageId, string> = new Map();
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/** Ties the composer `+` trigger to the panel it opens above the editor. */
const COMPOSER_EXTRAS_PANEL_ID = "composer-extras-panel";

const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];

const EMPTY_TERMINAL_RUNTIME_ENV: Record<string, string> = {};
const MAX_DISMISSED_PROVIDER_HEALTH_BANNERS = 50;

const EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS: ReadonlyArray<string> = [];

function getProviderHealthBannerDismissalKey(status: ServerProviderStatus | null): string | null {
  if (!status || status.status === "ready") {
    return null;
  }
  return [
    status.provider,
    status.instanceId ?? status.provider,
    status.status,
    status.available ? "available" : "unavailable",
    status.authStatus,
    status.message?.trim() ?? "",
  ].join("\u001f");
}

function getRateLimitBannerDismissalKey(
  status: RateLimitStatus | null,
  threadId: Thread["id"] | null,
): string | null {
  if (!status || !threadId) {
    return null;
  }
  return [
    threadId,
    status.status,
    status.resetsAt ?? "",
    typeof status.utilization === "number" ? String(Math.round(status.utilization * 100)) : "",
  ].join("\u001f");
}

function resolveGatewayMossQuotaDecision(input: {
  readonly managed: boolean;
  readonly error: string | null | undefined;
  readonly quota:
    | {
        readonly billingModel: string;
        readonly periodEnd: string | null;
        readonly usageLimits: readonly {
          readonly key: string;
          readonly limit: number | null;
          readonly used: number;
          readonly resetsAt: string | null;
        }[];
      }
    | null
    | undefined;
}): Extract<MossQuotaAdmission, { readonly kind: "exhausted" }> | null {
  if (!input.managed || !input.error || !isQuotaOwnedThreadError(input.error)) return null;
  const normalizedError = input.error.toLocaleLowerCase("en-US");
  const rejectedWindowKey = /(?:five[- ]hour|5\s*hour)/u.test(normalizedError)
    ? "five_hour"
    : /\bweekly\b/u.test(normalizedError)
      ? "weekly"
      : "monthly";
  const rejectedWindow =
    input.quota?.usageLimits.find((window) => window.key === "lifetime") ??
    input.quota?.usageLimits.find((window) => window.key === rejectedWindowKey) ??
    input.quota?.usageLimits.find((window) => window.key === "monthly");
  const limit = rejectedWindow?.limit ?? 0;
  return {
    kind: "exhausted",
    remainingPercent: 0,
    limit,
    used: Math.max(limit, rejectedWindow?.used ?? 0),
    resetAt: rejectedWindow?.resetsAt ?? input.quota?.periodEnd ?? null,
    usagePeriod:
      rejectedWindowKey === "five_hour"
        ? "five-hour"
        : rejectedWindowKey === "weekly"
          ? "weekly"
          : "period",
    usageBasis:
      input.quota?.billingModel === "cost_budget_v1" || normalizedError.includes("service_cost_")
        ? "hidden-cost"
        : "requests",
  };
}

const VOICE_RECORDER_ACTION_ARM_DELAY_MS = 250;

function warnVoiceGuard(event: string, details?: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    return;
  }
  if (details) {
    console.warn(`[voice] ${event}`, details);
    return;
  }
  console.warn(`[voice] ${event}`);
}

function ComposerControlSkeleton(props: { widthClassName: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md border border-border/50 px-2",
        props.widthClassName,
      )}
    >
      <Skeleton className="h-3.5 w-full rounded-full" />
    </div>
  );
}

function ComposerModelLoadingControl(props: { widthClassName: string }) {
  return (
    <div
      aria-label="Loading models"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md border border-border/50 px-2 text-muted-foreground",
        props.widthClassName,
      )}
    >
      <RefreshCwIcon aria-hidden="true" className="size-4 animate-spin" />
      <span className="truncate text-ui-xs">Loading models</span>
    </div>
  );
}

interface ChatViewProps {
  threadId: ThreadId;
  hideHeader?: boolean;
  paneScopeId?: string;
  surfaceMode?: "single" | "split";
  presentationMode?: "default" | "editor" | "quick-chat" | "subagent-panel";
  /** Explicit `?mossShell=1` route toggle: enables the Moss product shell for this surface. */
  mossShellRouteEnabled?: boolean;
  readOnlyOverride?: boolean;
  /** Forces the right dock open/closed regardless of the per-thread store (quick chat keeps it closed). */
  rightDockOpenOverride?: boolean;
  /** Fires when the thread has visible conversation content (messages or a sendable draft). */
  onConversationActivity?: () => void;
  isFocusedPane?: boolean;
  panelState?: SplitViewPanePanelState;
  onToggleDiffPanel?: () => void;
  onToggleRightDock?: () => void;
  onToggleBrowserPanel?: () => void;
  onToggleDevicePanel?: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenTurnDiffPanel?: (turnId: TurnId, filePath?: string) => void;
  onOpenHtmlDocument?: (document: RightDockHtmlDocument) => void;
  onSplitSurface?: () => void;
  onMaximizeSurface?: () => void;
  viewModeAction?: {
    label: string;
    active: boolean;
    onClick: () => void;
  } | null;
  onChangeThreadInSplitPane?: () => void;
  onCloseThreadPane?: () => void;
  /**
   * Enables the ambient computer preview rail for this chat: when provided,
   * a live computer session renders below the Environment card and the chat
   * reserves gutter space for it so it never covers the transcript. Absent
   * in editor-rail and dock-sidechat views, which keep no preview.
   */
}

// Builds an ephemeral transcript bubble for the conversational automation-setup
// exchange. These never reach a provider and are not persisted; they render the
// back-and-forth (user request, Moss's clarifying questions) inline like Codex.

const REALTIME_VOICE_PENDING_LAUNCH_KEY = "moss.realtimeVoice.pendingLaunch.v2";

export default function ChatView({
  threadId,
  hideHeader: hideHeaderProp,
  paneScopeId: paneScopeIdProp,
  surfaceMode: surfaceModeProp,
  presentationMode: presentationModeProp,
  mossShellRouteEnabled: mossShellRouteEnabledProp,
  isFocusedPane: isFocusedPaneProp,
  panelState,
  onToggleDiffPanel,
  onToggleRightDock,
  onToggleBrowserPanel,
  onToggleDevicePanel,
  onOpenBrowserUrl,
  onOpenTurnDiffPanel,
  onOpenHtmlDocument,
  onSplitSurface,
  onMaximizeSurface,
  viewModeAction: viewModeActionProp,
  onChangeThreadInSplitPane,
  onCloseThreadPane,
  readOnlyOverride,
  rightDockOpenOverride,
  onConversationActivity,
}: ChatViewProps) {
  // Prop defaults are resolved here instead of in the destructuring pattern: an
  // AssignmentPattern in the parameter list makes React Compiler bail out (silently —
  // `panicThreshold` is unset) on this entire component, the hottest one in the app.
  // See chatHotPath.compiler.test.ts.
  const { format, t } = useTranslation();
  const paneScopeId = paneScopeIdProp ?? SINGLE_CHAT_PANE_SCOPE_ID;
  const surfaceMode = surfaceModeProp ?? "single";
  const presentationMode = presentationModeProp ?? "default";
  const isSubagentPanel = presentationMode === "subagent-panel";
  const isEditorRail = presentationMode === "editor";
  const isQuickChat = presentationMode === "quick-chat";
  const hideHeader = (hideHeaderProp ?? false) || isQuickChat;
  const isFocusedPane = isFocusedPaneProp ?? true;
  const viewModeAction = viewModeActionProp ?? null;
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadWorkspace = useStore((store) => store.setThreadWorkspace);
  const { settings, updateSettings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const setComposerDraftModelSelectionAndSticky = useComposerDraftStore(
    (store) => store.setModelSelectionAndSticky,
  );
  const timestampFormat = settings.timestampFormat;
  // The composer floats over the transcript; its measured height becomes the
  // transcript's bottom content inset (see composerOverlay.ts).
  const {
    overlayRef: composerOverlayRef,
    overlayHeightPx: composerOverlayHeightPx,
    overlayBottomClearancePx: composerOverlayBottomClearancePx,
  } = useComposerOverlayHeight();
  const composerTranscriptInsetPx = composerTranscriptBottomInsetPx(composerOverlayHeightPx);
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { continueThreadHandoff, createThreadHandoff } = useThreadHandoff();
  const rawSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(rawSearch.splitViewId ?? null), [rawSearch.splitViewId]),
  );
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(
    gitCreateDetachedWorktreeMutationOptions({ queryClient }),
  );
  const isInactiveSplitPane = surfaceMode === "split" && !isFocusedPane;
  const {
    composerDraft,
    prompt,
    composerImages,
    composerFiles,
    composerAssistantSelections,
    composerBrowserAnnotations,
    composerFileComments,
    composerTerminalContexts,
    composerPastedTexts,
    composerPullRequestContexts,
    composerSkills,
    composerMentions,
    queuedComposerTurns,
    composerSendState,
    nonPersistedComposerImageIds,
    durablyPersistedComposerImageIds,
    setComposerDraftPrompt,
    setComposerDraftPromptHistorySavedDraft,
    restoreComposerDraftPromptHistorySavedDraft,
    setComposerDraftModelSelection,
    setComposerDraftProviderModelOptions,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    setComposerDraftComputerControlMode,
    setComposerDraftComputerControl,
    enqueueQueuedComposerTurn,
    insertQueuedComposerTurn,
    removeQueuedComposerTurnFromDraft,
    removeComposerDraftFile,
    addComposerDraftBrowserAnnotations,
    insertComposerDraftTerminalContext,
    addComposerDraftPastedTexts,
    setComposerDraftTerminalContexts,
    clearComposerDraftContent,
    setDraftThreadContext,
    getDraftThreadByProjectId,
    getDraftThread,
    setProjectDraftThreadId,
    clearProjectDraftThreadId,
    promptRef,
    composerAssistantSelectionsRef,
    composerBrowserAnnotationsRef,
    composerTerminalContextsRef,
    composerFileCommentsRef,
    composerPastedTextsRef,
    composerPullRequestContextsRef,
    composerCursor,
    setComposerCursor,
    composerTrigger,
    setComposerTrigger,
    composerEditorRef,
    promptHistoryNavigationRef,
    applyingPromptHistoryNavigationRef,
    expectedPromptHistoryPromptRef,
    promptHistoryAppliedPromptRef,
    composerImagesRef,
    composerFilesRef,
    restoredQueuedSourceProposedPlanRef,
    setRestoredQueuedSourceProposedPlan,
    setPrompt,
    discardPromptHistoryNavigationForComposerMutation,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    addComposerAssistantSelectionToDraft,
    addComposerTerminalContextsToDraft,
    addComposerPastedTextsToDraft,
    addComposerFileCommentToDraft,
    removeComposerImageFromDraft,
    clearComposerAssistantSelectionsFromDraft,
    clearComposerFileCommentsFromDraft,
    removeComposerTerminalContextFromDraft,
    removeComposerPastedTextFromDraft,
    addComposerPullRequestContextsToDraft,
    removeComposerPullRequestContextFromDraft,
    removeComposerBrowserAnnotationFromDraft,
    showComposerPastedTextInField,
  } = useChatComposerDraft({ threadId });
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const hasTemporaryThreadMarker = useTemporaryThreadStore((store) =>
    threadId ? store.temporaryThreadIds[threadId] === true : false,
  );
  const markTemporaryThread = useTemporaryThreadStore((store) => store.markTemporaryThread);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const markWorkflowRunPaused = useWorkflowRunUiStore((store) => store.markPaused);
  const markWorkflowRunDismissed = useWorkflowRunUiStore((store) => store.markDismissed);
  const serverThread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const sourceThreadSidechats = useStore(
    useMemo(() => createSidechatSummariesForSourceSelector(threadId), [threadId]),
  );
  const threadDetailSyncState = useStore((state) =>
    threadId ? (state.threadDetailSyncById?.[threadId] ?? null) : null,
  );
  const composerThreadSummaries = useStore(
    useMemo(() => createComposerThreadMentionSourcesSelector(), []),
  );
  const composerThreadProjects = useStore((state) => state.projects);
  const crossTaskSourceThreadId =
    serverThread?.creationSource && serverThread.sourceThreadId
      ? serverThread.sourceThreadId
      : null;
  const crossTaskSourceThread = useStore(
    useMemo(() => createThreadSelector(crossTaskSourceThreadId), [crossTaskSourceThreadId]),
  );
  const crossTaskOrigin = useMemo(
    () =>
      crossTaskSourceThreadId
        ? {
            sourceThreadId: crossTaskSourceThreadId,
            sourceProvider: crossTaskSourceThread?.modelSelection.provider ?? null,
          }
        : null,
    [crossTaskSourceThread?.modelSelection.provider, crossTaskSourceThreadId],
  );
  const forkSourceThreadId = serverThread?.sidechatSourceThreadId
    ? null
    : (serverThread?.forkSourceThreadId ?? null);
  const forkSourceThread = useStore(
    useMemo(() => createThreadSelector(forkSourceThreadId), [forkSourceThreadId]),
  );
  const forkSource = useMemo(
    () =>
      forkSourceThreadId
        ? {
            sourceThreadId: forkSourceThreadId,
            sourceTitle: forkSourceThread?.title ?? "chat",
          }
        : null,
    [forkSourceThread?.title, forkSourceThreadId],
  );
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  const draftFallbackModelSelection = useMemo<ModelSelection>(
    () =>
      resolveDraftFallbackModelSelection({
        projectDefault: fallbackDraftProject?.defaultModelSelection,
        settingsDefaultProvider: settings.defaultProvider,
      }),
    [fallbackDraftProject?.defaultModelSelection, settings.defaultProvider],
  );

  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage } =
    useExpandedImagePreview();

  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});

  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [pendingFileUndo, setPendingFileUndo] = useState<PendingFileUndo | null>(null);

  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  // Width-aware visibility for the footer picker cluster (context meter,
  // model name, traits label). Inputs live in a ref so the resize observer
  // can re-plan without re-subscribing; the sync function is exposed via ref
  // so label changes can re-plan without a resize.
  const [composerFooterTier, setComposerFooterTier] = useState(0);
  const composerFooterTierRef = useRef(0);
  const composerFooterDemotionWidthsRef = useRef<ReadonlyArray<number | undefined>>([]);
  const composerFooterLayoutSyncRef = useRef<(() => void) | null>(null);

  const [composerCommandPicker, setComposerCommandPicker] = useState<
    null | "fork-target" | "review-target"
  >(null);
  // The composer `+` panel shares the floating slot above the editor with the
  // slash/mention command menu, so only one of the two is ever open.
  const [isComposerExtrasPanelOpen, setIsComposerExtrasPanelOpen] = useState(false);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] = useState<
    (PullRequestDialogState & { threadId: ThreadId }) | null
  >(null);

  const [hasAcceptedComposerPrediction, setHasAcceptedComposerPrediction] = useLocalStorage(
    COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [dismissedProviderHealthBannerKeys, setDismissedProviderHealthBannerKeys] = useLocalStorage(
    DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
    EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS,
    DismissedProviderHealthBannersSchema,
  );
  const [dismissedRateLimitBannerKey, setDismissedRateLimitBannerKey] = useState<string | null>(
    null,
  );
  const [
    dismissedImageGenerationLimitIdentityByProvider,
    setDismissedImageGenerationLimitIdentityByProvider,
  ] = useState<Record<string, string>>({});
  const [imageGenerationLimitClock, setImageGenerationLimitClock] = useState(() => Date.now());
  const [dismissedClaudeSwitchKey, setDismissedClaudeSwitchKey] = useState<string | null>(null);
  const [submittedClaudeSwitchKey, setSubmittedClaudeSwitchKey] = useState<string | null>(null);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const legendListRef = useRef<LegendListRef | null>(null);
  const timelineControllerRef = useRef<MessagesTimelineController | null>(null);
  const [threadFindOpen, setThreadFindOpen] = useState(false);
  const threadHistory = useThreadHistory(threadId);
  useEffect(() => {
    if (!threadFindOpen) return;
    let cancelled = false;
    void ensureThreadHistoryLoaded(threadId, undefined, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [threadFindOpen, threadId, threadDetailSyncState, threadHistory.owner]);
  const [threadFindFocusNonce, setThreadFindFocusNonce] = useState(0);
  const [threadFindHighlightStore] = useState(() => createThreadFindHighlightStore());
  const handleThreadFindJump = (match: ThreadFindMatch) => {
    timelineControllerRef.current?.scrollToMessage(match.messageId, {
      ...(match.segmentIndex === undefined ? {} : { segmentIndex: match.segmentIndex }),
      fineScrollFind: true,
    });
  };
  const handleThreadFindActiveMatchChange = (match: ThreadFindMatch | null) => {
    threadFindHighlightStore.setActiveMatch(match);
    timelineControllerRef.current?.setActiveFindMatch(match);
  };

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade; the pickers already closed post-commit.
    const settle = window.setTimeout(() => {
      setComposerCommandPicker(null);
      setIsComposerExtrasPanelOpen(false);
      setIsModelPickerOpen(false);
      setIsTraitsPickerOpen(false);
      setThreadFindOpen(false);
      threadFindHighlightStore.set(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [
    setComposerCommandPicker,
    setIsComposerExtrasPanelOpen,
    setIsModelPickerOpen,
    setIsTraitsPickerOpen,
    setThreadFindOpen,
    threadId,
    threadFindHighlightStore,
  ]);

  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerStatusRowRef = useRef<HTMLDivElement>(null);
  // Set by whichever mounted GitActionsControl instance (header quick-action or the
  // Environment panel row) last registered — either performs the identical commit &
  // push mutation for this thread's repo, so it doesn't matter which one is "current".
  const commitAndPushTriggerRef = useRef<(() => void) | null>(null);
  const onRegisterCommitAndPushTrigger = useCallback(
    (trigger: (() => void) | null) => {
      commitAndPushTriggerRef.current = trigger;
    },
    [commitAndPushTriggerRef],
  );
  const pendingComposerFocusRef = useRef(false);

  const composerFormHeightRef = useRef(0);

  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);

  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const localDirectoryMenuRef = useRef<ComposerLocalDirectoryMenuHandle | null>(null);

  const sendInFlightRef = useMemo(() => ({ threadId, current: false }), [threadId]);
  const sendPreflightInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const activatedThreadIdRef = useRef<ThreadId | null>(null);

  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(threadId, draftThread, draftFallbackModelSelection, localDraftError)
        : undefined,
    [draftThread, draftFallbackModelSelection, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  useEffect(() => {
    if (composerSendState.hasSendableContent || (activeThread?.messages.length ?? 0) > 0) {
      onConversationActivity?.();
    }
  }, [activeThread?.messages.length, composerSendState.hasSendableContent, onConversationActivity]);
  // Invocation needs the current revocation generation before the preview appears.
  useThreadComputerStateSeed(threadId);
  const computerAvailability = useThreadComputerAvailability(threadId);
  const computerControlGeneration =
    useThreadComputerControlGeneration(threadId) ?? composerDraft.computerControlGeneration ?? 0;
  const computerControlAvailable = computerAvailability?.kind === "available";
  // Local threads reconcile their stored branch to the shared checkout as soon as the
  // branch query resolves. Keep the branch seen when a thread becomes active so a settled
  // thread can explain that change before the user's first resumed message.
  const [activeThreadBranchAtActivation, setActiveThreadBranchAtActivation] = useState<{
    threadId: ThreadId;
    branch: string | null;
    isSettled: boolean;
  } | null>(null);
  const [
    settledThreadBranchWarningDismissedThreadId,
    setSettledThreadBranchWarningDismissedThreadId,
  ] = useState<ThreadId | null>(null);
  // Capture before children mount: a deferred write adds another full chat commit
  // between initial transcript positioning and reveal, and can lose a rapid A -> B -> A switch.
  if (activeThread && activeThreadBranchAtActivation?.threadId !== activeThread.id) {
    // React restarts this component before rendering its children. Capture the branch
    // before checkout reconciliation, without a timer that commits the whole chat again
    // between the transcript's initial scroll and reveal. A new activation alone resets it.
    setActiveThreadBranchAtActivation({
      threadId: activeThread.id,
      branch: activeThread.branch,
      isSettled: activeThread.settledAt != null,
    });
    setSettledThreadBranchWarningDismissedThreadId(null);
  }
  const settledThreadBranchAtActivation =
    activeThreadBranchAtActivation !== null &&
    activeThreadBranchAtActivation.threadId === activeThread?.id &&
    activeThreadBranchAtActivation.isSettled
      ? activeThreadBranchAtActivation.branch
      : activeThread?.branch;
  useEffect(() => {
    if (
      !pendingFileUndo ||
      !hasFileUndoSettled({ pending: pendingFileUndo, thread: activeThread ?? null })
    ) {
      return;
    }
    // Async setState (post-paint) keeps this settled-undo cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setPendingFileUndo(null);
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setIsRevertingCheckpoint, setPendingFileUndo, activeThread, pendingFileUndo]);
  const [runtimeModeAcknowledgement, setRuntimeModeAcknowledgement] = useState<{
    threadId: ThreadId;
    baseMode: RuntimeMode;
    baseUpdatedAt: string;
    mode: RuntimeMode;
  } | null>(null);
  const serverRuntimeMode = serverThread?.runtimeMode;
  const serverThreadUpdatedAt = serverThread?.updatedAt;
  const acknowledgeRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (serverRuntimeMode === undefined || serverThreadUpdatedAt === undefined) return;
      setRuntimeModeAcknowledgement({
        threadId,
        baseMode: serverRuntimeMode,
        baseUpdatedAt: serverThreadUpdatedAt,
        mode,
      });
    },
    [serverRuntimeMode, serverThreadUpdatedAt, threadId],
  );
  // Only a server-confirmed choice made in this view may temporarily precede
  // the projection. Persisted composer drafts do not own an existing thread's permissions.
  const acknowledgedRuntimeMode =
    runtimeModeAcknowledgement?.threadId === threadId &&
    runtimeModeAcknowledgement.baseMode === serverRuntimeMode &&
    runtimeModeAcknowledgement.baseUpdatedAt === serverThreadUpdatedAt
      ? runtimeModeAcknowledgement.mode
      : serverRuntimeMode;
  const runtimeMode =
    acknowledgedRuntimeMode ??
    composerDraft.runtimeMode ??
    activeThread?.runtimeMode ??
    DEFAULT_RUNTIME_MODE;

  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.panel === "diff";
  const browserOpen = rawSearch.panel === "browser";
  const resolvedDiffOpen = panelState ? panelState.panel === "diff" : diffOpen;
  const onRespondToAsyncUserInput = useAsyncUserInputResponse(threadId);
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  // Read once here so memo bodies depend on the turn id instead of the turn object: a
  // `foo?.bar` read inside a memo makes React Compiler infer `foo` as the dependency, which
  // no longer matches the hand-written `foo?.bar` dep and bails the whole component out.
  const activeLatestTurnId = activeLatestTurn?.turnId ?? null;
  const activeLatestTurnState = activeLatestTurn?.state ?? null;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const imageGenerationLimitActivitySlices = useStore(
    useMemo(() => createImageGenerationLimitThreadSelector(), []),
  );
  useEffect(() => {
    setImageGenerationLimitClock(Date.now());
  }, [imageGenerationLimitActivitySlices]);
  const hasLiveTurnTail = hasLiveTurnTailWork({
    latestTurn: activeLatestTurn,
    messages: activeThread?.messages ?? EMPTY_MESSAGES,
    activities: threadActivities,
    session: activeThread?.session ?? null,
  });
  const activeContextWindowState = useMemo(
    () => deriveLatestContextWindowState(threadActivities),
    [threadActivities],
  );
  const activeContextWindow = activeContextWindowState.snapshot;
  const activeCumulativeCostUsd = useMemo(
    () => deriveCumulativeCostUsd(threadActivities),
    [threadActivities],
  );
  const activeRateLimitStatus = useMemo(
    () => deriveLatestRateLimitStatus(threadActivities),
    [threadActivities],
  );
  const activeRateLimitBannerDismissalKey = useMemo(
    () => getRateLimitBannerDismissalKey(activeRateLimitStatus, activeThread?.id ?? null),
    [activeRateLimitStatus, activeThread?.id],
  );
  const visibleActiveRateLimitStatus =
    activeRateLimitBannerDismissalKey === dismissedRateLimitBannerKey
      ? null
      : activeRateLimitStatus;
  const latestTurnSettledByProvider = isLatestTurnSettled(
    activeLatestTurn,
    activeThread?.session ?? null,
  );
  const latestTurnSettled = latestTurnSettledByProvider && !hasLiveTurnTail;
  // `latestTurnSettled` is also false when there is NO started turn (a brand-new
  // chat), because `isLatestTurnSettled` treats a non-existent turn as unsettled.
  // Gate live-turn UI on an actually-started turn so composer chrome cannot
  // appear on a fresh chat just because the repo already has local edits.
  const latestTurnLive = Boolean(activeLatestTurn?.startedAt) && !latestTurnSettled;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const deletePlaceholderTerminalThread = useCallback(
    async (terminalThreadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      // Body kept in a nested function: React Compiler's BuildHIR cannot lower a value block
      // (`?.`, `??`, ternary) that sits directly inside a `try`, and one of them makes the
      // whole component bail out of compilation. The catch below still sees every rejection.
      const deleteEmptyTerminalThread = async () => {
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: terminalThreadId,
        });
        void reconcileDeletedThreadFromClient({
          threadId: terminalThreadId,
          removeDeletedThreadFromClientState:
            useStore.getState().removeDeletedThreadFromClientState,
        });
        useComposerDraftStore.getState().clearDraftThread(terminalThreadId);
        useTerminalStateStore.getState().clearTerminalState(terminalThreadId);
        removeThreadFromSplitViews(terminalThreadId);
        if (activeSplitView) {
          const nextSplitView = useSplitViewStore.getState().splitViewsById[activeSplitView.id];
          const nextThreadId = nextSplitView
            ? resolveSplitViewFocusedThreadId(nextSplitView)
            : null;
          if (nextSplitView && nextThreadId) {
            await navigate({
              to: "/$threadId",
              params: { threadId: nextThreadId },
              replace: true,
              search: () => ({ splitViewId: nextSplitView.id }),
            });
            return;
          }
        }
        await handleNewChat();
      };

      try {
        await deleteEmptyTerminalThread();
      } catch (error) {
        console.error("Failed to delete empty terminal thread after closing its last terminal", {
          threadId: terminalThreadId,
          error,
        });
      }
    },
    [activeSplitView, handleNewChat, navigate, removeThreadFromSplitViews],
  );
  const {
    terminalState,
    terminalFocusRequestId,
    requestTerminalFocus,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    setTerminalOpen,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
    setTerminalMetadataInStore: storeSetTerminalMetadata,
    setTerminalActivityInStore: storeSetTerminalActivity,
    openChatThreadPageInStore: storeOpenChatThreadPage,
    openTerminalThreadPageInStore: storeOpenTerminalThreadPage,
    toggleTerminalVisibility,
    createTerminalFromShortcut,
    openNewFullWidthTerminal,
    closeTerminal,
    handleTerminalSessionExited,
    closeActiveWorkspaceView,
  } = useChatTerminalController({
    threadId,
    activeThreadId,
    activeThread,
    activeProjectPresent: activeProject !== undefined,
    isFocusedPane,
    isServerThread,
    confirmTerminalClose: settings.confirmTerminalTabClose,
    onDeletePlaceholderThread: deletePlaceholderTerminalThread,
  });
  const localProjectInstructions = useProjectInstructionsStore((state) =>
    activeProjectId ? (state.instructionsByProjectId[activeProjectId] ?? "") : "",
  );
  const setProjectInstructions = useProjectInstructionsStore((state) => state.setInstructions);
  const serverProjectInstructions = useProjectInstructionsSource(activeProjectId ?? null);
  const projectInstructions = serverProjectInstructions.serverBacked
    ? serverProjectInstructions.instructions
    : localProjectInstructions;
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((state) => state.groupsWorkspaceRoot);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const isHomeChatContainer = isHomeChatContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
  });
  const isGroupContainer = isGroupContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
    groupsWorkspaceRoot,
  });
  const isContainerLandingProject = isHomeChatContainer || isGroupContainer;
  const activeProjectDisplayName = isHomeChatContainer
    ? activeProject?.folderName
    : activeProject?.name;
  const isChatProject = isContainerLandingProject;
  const activeProjectScripts =
    activeProject?.kind === "project" ? activeProject.scripts : undefined;
  const threadLineageThreads = useStore(
    useMemo(() => createThreadLineageSelector(activeThread?.id ?? null), [activeThread?.id]),
  );
  // Read once here so the memo depends on the two fields it uses instead of the thread
  // object, whose identity changes with every streamed token (and re-rendered the header).
  const activeThreadParentId = activeThread?.parentThreadId ?? null;
  const threadBreadcrumbs = useMemo(
    () =>
      buildThreadBreadcrumbs(
        threadLineageThreads,
        activeThreadId ? { id: activeThreadId, parentThreadId: activeThreadParentId } : null,
      ),
    [activeThreadId, activeThreadParentId, threadLineageThreads],
  );
  // Group threads are always local. Their optional "Use a folder" cwd is stored separately
  // from Git worktree metadata; the server migration repairs the legacy mixed representation.
  const resolvedThreadEnvMode = isGroupContainer
    ? "local"
    : isServerThread
      ? (activeThread?.envMode ?? null)
      : (draftThread?.envMode ?? null);
  const resolvedThreadWorktreePath = isGroupContainer
    ? null
    : isServerThread
      ? (activeThread?.worktreePath ?? null)
      : (draftThread?.worktreePath ?? null);
  const resolvedThreadWorkingDirectory = isServerThread
    ? (activeThread?.workingDirectory ?? null)
    : (draftThread?.workingDirectory ?? null);
  const diffEnvironmentState = resolveDiffEnvironmentState({
    projectCwd: activeProject?.cwd ?? null,
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });
  const diffEnvironmentPending = diffEnvironmentState.pending;
  const diffDisabledReason = diffEnvironmentState.disabledReason;
  const repoDiffBadgeRefreshIntervalMs =
    isFocusedPane && latestTurnLive && !diffEnvironmentPending && !resolvedDiffOpen
      ? GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS
      : false;
  const activeThreadAssociatedWorktree = useMemo(
    () =>
      deriveAssociatedWorktreeMetadata({
        branch: activeThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? null,
        ...(activeThread?.associatedWorktreePath !== undefined
          ? { associatedWorktreePath: activeThread.associatedWorktreePath }
          : {}),
        ...(activeThread?.associatedWorktreeBranch !== undefined
          ? { associatedWorktreeBranch: activeThread.associatedWorktreeBranch }
          : {}),
        ...(activeThread?.associatedWorktreeRef !== undefined
          ? { associatedWorktreeRef: activeThread.associatedWorktreeRef }
          : {}),
      }),
    [activeThread],
  );

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        threadId,
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [
      setComposerHighlightedItemId,
      setPullRequestDialogState,
      canCheckoutPullRequestIntoThread,
      threadId,
    ],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, [setPullRequestDialogState]);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      envMode: DraftThreadEnvMode;
      lastKnownPr?: Thread["lastKnownPr"];
    }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const draftThreadContext = {
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.envMode,
        ...(input.lastKnownPr !== undefined ? { lastKnownPr: input.lastKnownPr } : {}),
      };
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, draftThreadContext);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, draftThreadContext);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (
        !isServerThread &&
        activeDraftThread?.projectId === activeProject.id &&
        activeDraftThread.entryPoint === "chat"
      ) {
        setDraftThreadContext(threadId, draftThreadContext);
        setProjectDraftThreadId(activeProject.id, threadId, draftThreadContext);
        return;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        ...draftThreadContext,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      pullRequest: NonNullable<Thread["lastKnownPr"]>;
    }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
        lastKnownPr: input.pullRequest,
      });
    },
    [openOrReuseProjectDraftThread],
  );

  // Read on a visit or new completion, not when the user explicitly marks this chat unread.
  const autoReadThreadId = activeThread?.id;
  const activeTurnCompletedAt = activeLatestTurn?.completedAt;
  useEffect(() => {
    if (!autoReadThreadId || isInactiveSplitPane) return;
    if (!latestTurnSettled) return;
    if (!activeTurnCompletedAt) return;
    const turnCompletedAt = Date.parse(activeTurnCompletedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const visitedAt = getThreadFromState(useStore.getState(), autoReadThreadId)?.lastVisitedAt;
    const lastVisitedAt = visitedAt ? Date.parse(visitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(autoReadThreadId);
  }, [
    autoReadThreadId,
    activeTurnCompletedAt,
    isInactiveSplitPane,
    latestTurnSettled,
    markThreadVisited,
  ]);

  // A chat back from snooze reads as unread until it is opened. Stamp the reminder time
  // rather than now: a client clock behind the server would leave the stamp before it.
  const activeSnoozedUntil = activeThread?.snoozedUntil;
  const activeSnoozeReminderAt = activeThread?.snoozeReminderAt;
  useEffect(() => {
    if (!autoReadThreadId || isInactiveSplitPane || !activeSnoozeReminderAt) return;
    const returned = {
      snoozedUntil: activeSnoozedUntil,
      snoozeReminderAt: activeSnoozeReminderAt,
      lastVisitedAt: getThreadFromState(useStore.getState(), autoReadThreadId)?.lastVisitedAt,
    };
    if (hasUnseenSnoozeReturn(returned))
      markThreadVisited(autoReadThreadId, activeSnoozeReminderAt);
  }, [
    autoReadThreadId,
    isInactiveSplitPane,
    activeSnoozedUntil,
    activeSnoozeReminderAt,
    markThreadVisited,
  ]);

  const { coordinatorThreadIds, summariesByProjectId, summaryFor } = useProjectAgentSummaries();
  const isCoordinatorConversation = Boolean(
    activeThread && coordinatorThreadIds.has(activeThread.id),
  );
  const {
    hasThreadStarted,
    lockedProvider,
    boundProvider,
    boundProviderInstanceId,
    serverConfigQuery,
    selectedProvider,
    providerInstances,
    selectedProviderInstanceId,
    providerModelDiscoveryCwd,
    customModelsByProvider,
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    loadingModelProviders,
    refreshModels,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    runtimeModelsByProviderInstance,
    dynamicAgents,
    selectedProviderRuntimeModelDiscoveryPending,
    composerModelOptions,
    selectedModel,
    selectedRuntimeModel,
    composerProviderState,
    selectedPromptEffort,
    selectedModelSelection,
    providerOptionsForDispatch,
    selectedModelForPickerWithCustomFallback,
    showComposerModelBootstrapSkeleton,
    searchableModelOptions,
  } = useChatProviderModels({
    threadId,
    activeThread,
    activeProject,
    composerDraft,
    settings,
    resolvedThreadWorktreePath,
    // Same gate as the Hand off menu: a coordinator is one per-group identity.
    allowProviderHandoff: isServerThread && !isCoordinatorConversation,
  });
  const imageGenerationLimitFailure = useMemo(
    () =>
      selectImageGenerationLimitState({
        slices: imageGenerationLimitActivitySlices,
        providerInstanceId: selectedProviderInstanceId,
        nowEpochSeconds: imageGenerationLimitClock / 1_000,
        dismissedFailureIdentity:
          dismissedImageGenerationLimitIdentityByProvider[selectedProviderInstanceId] ?? null,
      }),
    [
      imageGenerationLimitActivitySlices,
      dismissedImageGenerationLimitIdentityByProvider,
      imageGenerationLimitClock,
      selectedProviderInstanceId,
    ],
  );
  const imageGenerationLimitSourceKind = imageGenerationLimitFailure
    ? resolveImageGenerationAccountSource({
        instanceId: selectedProviderInstanceId,
        provider: selectedProvider,
      })
    : null;
  const selectedProviderInstances = useMemo(
    () => providerInstances.filter((instance) => instance.provider === selectedProvider),
    [providerInstances, selectedProvider],
  );
  const selectedProviderInstanceLabel = resolveProviderInstanceLabel(
    selectedProviderInstances,
    selectedProviderInstanceId,
  );
  const showProviderInstancePicker = shouldShowComposerProviderInstancePicker({
    selectedProviderInstanceId,
    providerInstances: selectedProviderInstances,
  });
  // Cursor model variants always render collapsed in the composer picker.
  const showExpandedCursorModelVariants = false;
  const {
    selectedComposerSkills,
    selectedComposerMentions,
    selectedComposerSkillsRef,
    selectedComposerMentionsRef,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
  } = useComposerReferences({
    threadId,
    selectedProvider,
    prompt,
    composerSkills,
    composerMentions,
  });
  // A command enables only this draft's turn. Settings remains a separate
  // explicit default; clearing the draft removes request activation.
  const computerControlMode = resolveComputerInvocationMode({
    messageText: prompt,
    enableComputerControl: settings.computerControlEnabled,
  });
  const enableComputerControl = computerControlMode !== "off";
  const featureFlags = useFeatureFlags();
  const showDebugTaskBanner = import.meta.env.DEV && featureFlags["show-debug-task-banner"];
  const mossShellRouteEnabled = mossShellRouteEnabledProp ?? false;
  const mossShellProductization = resolveMossShellProductizationState({
    featureFlagEnabled: featureFlags["show-moss-control-plane"],
    productDefaultEnabled: featureFlags["moss-product-shell-default"],
    routeEnabled: mossShellRouteEnabled,
    surfaceMode,
    // Quick Chat is a compact conversation surface, so it intentionally follows
    // the same "no product-control-plane chrome" gate as the editor rail.
    presentationMode: isQuickChat || isSubagentPanel ? "editor" : presentationMode,
  });
  const showMossControlPlane = mossShellProductization.enabled;
  const [mossNativeSurface, setMossNativeSurface] = useState<MossControlPlaneSurface>("events");

  const phase = derivePhase(activeThread?.session ?? null);
  const isConnecting = phase === "connecting" || threadDetailSyncState === "cached";
  const providerDisplayName =
    PROVIDER_DISPLAY_NAMES[activeThread?.session?.provider ?? selectedProvider];
  const {
    workLogEntries,
    subagentRunThreads,
    backgroundedSubagentToolUseIds,
    subagentTaskEnds,
    subagentThreadRunRow,
    composerSubagentStripItems,
    subagentRoster,
    stripSourceThreadId,
    workflowRunState,
  } = useChatWorkLog({
    activeThread,
    latestTurnSettled,
    latestTurnLive,
  });
  const [openAgentActivityId, setOpenAgentActivityId] = useState<string | null>(null);
  const agentActivityTimelineState = useMemo(
    () => deriveAgentActivityTimelineState(workLogEntries),
    [workLogEntries],
  );
  const openAgentActivityDetail = openAgentActivityId
    ? (agentActivityTimelineState.detailById.get(openAgentActivityId) ?? null)
    : null;
  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setOpenAgentActivityId, activeThread?.id]);
  useEffect(() => {
    if (!openAgentActivityId || agentActivityTimelineState.detailById.has(openAgentActivityId)) {
      return;
    }
    // Async setState (post-paint) keeps this stale-detail cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setOpenAgentActivityId, agentActivityTimelineState.detailById, openAgentActivityId]);
  const {
    respondingRequestKeys,
    pendingApprovals,
    pendingUserInputs,
    pendingUserInputAnswersByRequestIdRef,
    setPendingUserInputAnswersByRequestId,
    expiredQuestionDrafts,
    activePendingUserInput,
    activePendingUserInputKey,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingQuestion,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingApproval,
    onRespondToApproval,
    userInputSubmissionVersion,
    onCancelActivePendingUserInput,
    onToggleActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
  } = useChatPendingInteractions({
    threadId,
    activeThread,
    runtimeMode,
    promptRef,
    setPrompt,
    setComposerCursor,
    setComposerTrigger,
    setComposerHighlightedItemId,
  });
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarPlanSourceThreadId = !latestTurnSettled
    ? (activeLatestTurn?.sourceProposedPlan?.threadId ?? null)
    : null;
  const sidebarPlanSourceThread = useStore(
    useMemo(() => createThreadSelector(sidebarPlanSourceThreadId), [sidebarPlanSourceThreadId]),
  );
  const activeThreadPlanThreadId = activeThread?.id ?? null;
  const activeThreadPlanProposedPlans = activeThread?.proposedPlans;
  const sidebarPlanSourceThreadPlanId = sidebarPlanSourceThread?.id ?? null;
  const sidebarPlanSourceThreadProposedPlans = sidebarPlanSourceThread?.proposedPlans;
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: [
          ...(activeThreadPlanThreadId
            ? [
                {
                  id: activeThreadPlanThreadId,
                  proposedPlans: activeThreadPlanProposedPlans ?? [],
                },
              ]
            : []),
          ...(sidebarPlanSourceThreadPlanId &&
          sidebarPlanSourceThreadPlanId !== activeThreadPlanThreadId
            ? [
                {
                  id: sidebarPlanSourceThreadPlanId,
                  proposedPlans: sidebarPlanSourceThreadProposedPlans ?? [],
                },
              ]
            : []),
        ],
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThreadPlanThreadId,
      }),
    [
      activeLatestTurn,
      activeThreadPlanProposedPlans,
      activeThreadPlanThreadId,
      latestTurnSettled,
      sidebarPlanSourceThreadPlanId,
      sidebarPlanSourceThreadProposedPlans,
    ],
  );
  const planSidebarLabel = sidebarProposedPlan ? "Plan details" : "Tasks";
  const planSidebarToggleLabel = planSidebarOpen ? `Hide ${planSidebarLabel}` : planSidebarLabel;
  const planSidebarToggleTitle = `${planSidebarOpen ? "Hide" : "Show"} ${planSidebarLabel.toLowerCase()} sidebar`;
  const activeTaskList = useMemo((): ActiveTaskListState | null => {
    if (showDebugTaskBanner) {
      return {
        createdAt: new Date().toISOString(),
        turnId: activeLatestTurn?.turnId ?? null,
        tasks: [
          {
            task: "Inspect banner layout without overlapping transcript text",
            status: "inProgress",
          },
          {
            task: "Confirm compact task banner width",
            status: "pending",
          },
          {
            task: "Verify sidebar task controls",
            status: "completed",
          },
        ],
      };
    }

    // Only while a turn is live: deriveActiveTaskListState falls back to the latest
    // unfinished prior-turn list (follow-up turns, reloads mid-turn), but once the
    // thread is idle the card must clear — providers routinely end a turn without
    // marking every task completed, and an unfinished list must not linger forever.
    return latestTurnSettled
      ? null
      : deriveActiveTaskListState(threadActivities, activeLatestTurn?.turnId);
  }, [activeLatestTurn?.turnId, latestTurnSettled, showDebugTaskBanner, threadActivities]);
  const activeBackgroundTasks = useMemo(
    () =>
      latestTurnSettled
        ? null
        : deriveActiveBackgroundTasksState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, latestTurnSettled, threadActivities],
  );
  // Once the turn settles, still-running isBackgrounded tasks keep the thread
  // visibly "waiting on background work" instead of going quiet.
  const pendingBackgroundWork = useMemo(
    () =>
      latestTurnSettled
        ? derivePendingBackgroundWork({
            activities: threadActivities,
            latestTurn: activeLatestTurn,
            session: activeThread?.session ?? null,
          })
        : null,
    [activeLatestTurn, activeThread?.session, latestTurnSettled, threadActivities],
  );
  const pendingBackgroundWorkCount = pendingBackgroundWork?.count ?? 0;

  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);

  const {
    localDispatch,
    worktreeSetupResolutionRef,
    worktreeSetupPendingAction,
    setWorktreeSetupPendingAction,
    turnTakenOver,
    isSendBusy,
    isAwaitingTurnStart,
    isSettlingTurnDispatch,
    activeWorktreeSetup,
    isPreparingWorktree,
    beginLocalDispatch,
    failLocalDispatchWorktreeSetup,
    resetLocalDispatch,
    clearLocalDispatchWorktreeSetup,
    onResolveWorktreeSetup,
    armLocalDispatchAckFallback,
    scheduleFailedWorktreeSetupDispatchReset,
  } = useChatLocalDispatch({
    threadId,
    phase,
    activeLatestTurn,
    activeThread,
    activePendingApproval,
    activePendingUserInput,
  });
  const hasLiveTurn = phase === "running";
  // Providers that clear `activeTurnId` on every terminal event (Claude) would
  // otherwise leave the transcript with no active turn while work is still in
  // progress, collapsing the newest answer into a closed "Worked for" disclosure.
  // Fall back only while that turn is unsettled. A follow-up send can be busy
  // before its new turn exists; it must not reopen the previous turn's work.
  const activeTurnIdForTranscript = latestTurnSettled
    ? null
    : (activeThread?.session?.activeTurnId ?? activeLatestTurnId);
  // The edit affordance must mirror the exact policy the server decider applies:
  // resolve the editable target from the raw sequence-ordered thread messages and
  // the running-session turn id — never from the createdAt-sorted timeline rows,
  // whose optimistic/filtered entries can surface the button on a message the
  // validators then reject.
  const editableUserMessageId = useMemo(() => {
    if (!activeThread || !isServerThread) {
      return null;
    }
    const editTarget = resolveLatestTailUserMessageEditTarget({
      messages: activeThread.messages,
      activeTurnId:
        activeThread.session?.orchestrationStatus === "running"
          ? (activeThread.session.activeTurnId ?? null)
          : null,
    });
    return editTarget.editable ? (editTarget.messageId as MessageId) : null;
  }, [activeThread, isServerThread]);
  // Defence in depth against a session stuck at "running" with no turn to
  // complete: nothing would ever drain the composer queue, so messages routed
  // into it would be swallowed. Server-side reconciliation settles these
  // sessions; this keeps the composer usable until it does.
  const hasQueueableLiveTurn = hasLiveTurn && activeThread?.session?.activeTurnId != null;
  const {
    automationProjects,
    automationThreads,
    automationData,
    automationDraftForm,
    setAutomationDraftForm,
    automationDraftWarnings,
    setAutomationDraftWarnings,
    setAutomationDraftWarningContext,
    acknowledgedAutomationWarnings,
    setAcknowledgedAutomationWarnings,
    automationDraftOpen,
    setAutomationDraftOpen,
    setAutomationDraftDialogOpen,
    isAutomationDraftSubmitting,
    setIsAutomationDraftSubmitting,
    automationDraftSubmittingRef,
    pendingAutomationConversation,
    setPendingAutomationConversation,
    activeThreadIdRef,
    pendingAutomationConversationRef,
    hasLiveTurnRef,
    isPendingSetupBubbleId,
    cancelAutomationConversation,
    toggleAutomationWarning,
    updateAutomationDraftForm,
    resetAutomationDraftState,
  } = useChatAutomationSetup({
    threadId,
    hasLiveTurn,
    promptRef,
    setComposerDraftPrompt,
  });
  // Keep Thinking through the post-ack gap where the server has the message /
  // turn request but the provider session is not live yet (common on first send).
  const isWorking =
    hasLiveTurn || isSendBusy || isConnecting || isRevertingCheckpoint || isAwaitingTurnStart;
  const providerRetryLabel = resolveLatestProviderRetryLabel(
    threadActivities,
    activeTurnIdForTranscript,
  );
  const hasStreamingAssistantText =
    activeThread?.messages.some((message) => message.role === "assistant" && message.streaming) ??
    false;
  const activeTurnLayoutLive =
    threadDetailSyncState === "cached" ? !latestTurnSettled : isWorking || !latestTurnSettled;
  const [keepSettledActiveTurnLayout, setKeepSettledActiveTurnLayout] = useState(false);
  const previousActiveTurnLayoutLiveRef = useRef(activeTurnLayoutLive);
  const previousActiveTurnLayoutKeyRef = useRef<string | null>(null);
  const activeWorkStartedAt = hasLiveTurnTail
    ? (activeLatestTurn?.startedAt ?? null)
    : hasLiveTurn
      ? deriveActiveWorkStartedAt(activeLatestTurn, activeThread?.session ?? null, null)
      : null;
  const activeTurnLayoutKey =
    activeThreadId === null ? null : `${activeThreadId}:${activeLatestTurn?.turnId ?? "idle"}`;
  const activeTurnInProgress = activeTurnLayoutLive || keepSettledActiveTurnLayout;
  const hasRunningSubagents = useMemo(
    () => collectRunningSubagentStripItems(composerSubagentStripItems).length > 0,
    [composerSubagentStripItems],
  );
  const runningSubagentRunParentId = activeThread?.parentThreadId ?? activeThread?.id ?? null;
  const subagentRunLiveTurnId = latestTurnLive ? activeLatestTurnId : null;
  const runningSubagentRun = useMemo(
    () =>
      findLatestRunningSubagentRun({
        entries: workLogEntries,
        threads: subagentRunThreads,
        parentThreadId: runningSubagentRunParentId,
        liveTurnId: subagentRunLiveTurnId,
        taskEndByToolUseId: subagentTaskEnds,
        backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
      }),
    [
      backgroundedSubagentToolUseIds,
      runningSubagentRunParentId,
      subagentRunLiveTurnId,
      subagentRunThreads,
      subagentTaskEnds,
      workLogEntries,
    ],
  );
  const isComposerApprovalState = activePendingApproval !== null;
  const isSidechatExpired = Boolean(activeThread?.sidechatExpiredAt);
  const isComposerEditorDisabled = isConnecting || isComposerApprovalState || isSidechatExpired;
  const canCollapsePastedTextToDraft = shouldEnableComposerPastedTextCollapse({
    isComposerApprovalState,
    hasPendingUserInput: pendingUserInputs.length > 0,
    showPlanFollowUpPrompt,
  });
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  useLayoutEffect(() => {
    if (threadDetailSyncState === "cached") {
      // A last-known running turn is hydration, not observed live work. Its
      // eventual confirmation must not start the live settlement grace period.
      previousActiveTurnLayoutKeyRef.current = activeTurnLayoutKey;
      previousActiveTurnLayoutLiveRef.current = false;
      setKeepSettledActiveTurnLayout(false);
      return;
    }
    if (previousActiveTurnLayoutKeyRef.current !== activeTurnLayoutKey) {
      previousActiveTurnLayoutKeyRef.current = activeTurnLayoutKey;
      previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    const shouldStartGrace = shouldStartActiveTurnLayoutGrace({
      previousTurnLayoutLive: previousActiveTurnLayoutLiveRef.current,
      currentTurnLayoutLive: activeTurnLayoutLive,
      latestTurnStartedAt: activeLatestTurn?.startedAt ?? null,
    });
    previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;

    if (activeTurnLayoutLive) {
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    if (!shouldStartGrace) {
      return;
    }

    setKeepSettledActiveTurnLayout(true);
    const timeoutId = window.setTimeout(() => {
      setKeepSettledActiveTurnLayout(false);
    }, ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    setKeepSettledActiveTurnLayout,
    previousActiveTurnLayoutLiveRef,
    previousActiveTurnLayoutKeyRef,
    activeLatestTurn?.startedAt,
    activeTurnLayoutKey,
    activeTurnLayoutLive,
    threadDetailSyncState,
  ]);

  const { timelineMessages, optimisticUserMessages, setOptimisticUserMessages } =
    useChatTimelineMessages({
      threadId,
      activeThread,
      pendingAutomationConversation,
    });
  const promptHistory = useMemo(() => {
    const activeMessages = activeThread?.messages ?? EMPTY_MESSAGES;
    // Optimistic messages exist only briefly after a send; skip the full-transcript
    // id Set on the common (streaming-flush) path where there is nothing to reconcile.
    if (optimisticUserMessages.length === 0) {
      return derivePromptHistoryFromMessages(activeMessages);
    }
    const activeMessageIds = new Set(activeMessages.map((message) => message.id));
    const pendingOptimisticMessages = optimisticUserMessages.filter(
      (message) => !activeMessageIds.has(message.id),
    );
    return derivePromptHistoryFromMessages([...activeMessages, ...pendingOptimisticMessages]);
  }, [activeThread?.messages, optimisticUserMessages]);
  const activeGroupSummary = isCoordinatorConversation ? summaryFor(activeThread?.projectId) : null;
  const hubWorkItems = useHubWorkItems(
    isCoordinatorConversation ? (activeThread?.projectId ?? null) : null,
  );
  const hubWorkItemsByMessageId = useMemo(
    () => hubWorkItemsBySourceMessage(hubWorkItems, activeThread?.id),
    [hubWorkItems, activeThread?.id],
  );
  const hubApprovalThreadIds = useMemo(
    () =>
      [
        ...new Set([
          ...(activeGroupSummary?.memberThreadIds ?? []),
          ...hubWorkItems.flatMap((item) => (item.workerThreadId ? [item.workerThreadId] : [])),
        ]),
      ].filter((id) => id !== activeThread?.id),
    [activeGroupSummary?.memberThreadIds, hubWorkItems, activeThread?.id],
  );
  // A thread the group coordinator started names the group in its origin label,
  // so the worker reads as part of that group rather than "another thread".
  const crossTaskOriginGroupName =
    crossTaskSourceThreadId && coordinatorThreadIds.has(crossTaskSourceThreadId)
      ? (composerThreadProjects.find((project) => project.id === crossTaskSourceThread?.projectId)
          ?.name ?? null)
      : null;
  const subagentParentThreadId = serverThread?.parentThreadId
    ? (crossTaskSourceThreadId ?? serverThread.parentThreadId)
    : null;
  const subagentParentTitle = crossTaskSourceThread
    ? crossTaskSourceThread.parentThreadId
      ? resolveSubagentPresentationForThread({ thread: crossTaskSourceThread }).primaryLabel
      : crossTaskSourceThread.title
    : null;
  const subagentStartedAt =
    (subagentThreadRunRow?.startedAtMs != null
      ? new Date(subagentThreadRunRow.startedAtMs).toISOString()
      : null) ??
    serverThread?.messages.find((message) => message.dispatchOrigin === "agent")?.createdAt ??
    serverThread?.createdAt ??
    null;
  const subagentStatusKind = serverThread?.parentThreadId
    ? subagentThreadRunRow
      ? subagentRunPhaseStatusKind(subagentThreadRunRow.phase)
      : latestTurnLive
        ? "running"
        : resolveSubagentThreadStatusKind({
            error: serverThread.error,
            session: serverThread.session,
            latestTurn: serverThread.latestTurn,
          })
    : null;
  const subagentRole = serverThread?.subagentRole ?? null;
  const subagentModelLabel = formatSubagentModelLabel(serverThread?.modelSelection.model) ?? null;
  const subagentProvider = serverThread?.modelSelection.provider ?? null;
  const subagentEndedAt =
    subagentThreadRunRow?.endedAtMs != null
      ? new Date(subagentThreadRunRow.endedAtMs).toISOString()
      : (serverThread?.latestTurn?.completedAt ?? null);
  const subagentThread = useMemo<SubagentThreadPresentation | null>(
    () =>
      subagentParentThreadId && subagentProvider
        ? {
            parentThreadId: subagentParentThreadId,
            parentTitle: subagentParentTitle ?? "the parent thread",
            role: subagentRole,
            modelLabel: subagentModelLabel,
            provider: subagentProvider,
            statusKind: subagentStatusKind,
            startedAt: subagentStartedAt,
            endedAt: subagentEndedAt,
          }
        : null,
    [
      subagentEndedAt,
      subagentModelLabel,
      subagentParentThreadId,
      subagentParentTitle,
      subagentProvider,
      subagentRole,
      subagentStartedAt,
      subagentStatusKind,
    ],
  );
  const resolvedCrossTaskOrigin = useMemo(
    () =>
      subagentThread
        ? null
        : crossTaskOrigin && crossTaskOriginGroupName
          ? { ...crossTaskOrigin, coordinatorGroupName: crossTaskOriginGroupName }
          : crossTaskOrigin,
    [crossTaskOrigin, crossTaskOriginGroupName, subagentThread],
  );
  const [coordinatorSettingsOpen, setCoordinatorSettingsOpen] = useState(false);
  const [coordinatorSettingsSection, setCoordinatorSettingsSection] = useState<
    GroupSettingsSection | undefined
  >(undefined);
  const coordinatorSuggestionChips = visibleCoordinatorSuggestionChips({
    hasGoal: activeGroupSummary?.hasGoal,
    instructionsConfigured: activeGroupSummary?.instructionsConfigured,
    linkedProjectCount: activeGroupSummary?.linkedProjectIds?.length ?? 0,
  });
  const showCoordinatorSuggestions =
    isGroupContainer &&
    coordinatorSuggestionChips.length > 0 &&
    shouldShowCoordinatorSuggestions({
      isCoordinatorThread: isCoordinatorConversation,
      messages: activeThread?.messages ?? EMPTY_MESSAGES,
    });
  const handoffAvailability = resolveThreadHandoffAvailability({
    isGroupContainer,
    isCoordinatorThread: isCoordinatorConversation,
  });
  const handoffDisabled = !(
    activeThread &&
    activeProject &&
    isServerThread &&
    handoffAvailability.providerHandoff &&
    canCreateThreadHandoff({
      thread: activeThread,
      isBusy: isWorking,
      hasPendingApprovals: pendingApprovals.length > 0,
      hasPendingUserInput: pendingUserInputs.length > 0,
    })
  );
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        agentActivityTimelineState.timelineWorkEntries,
        // Coordinator check-in turns run in the background and never appear
        // in this transcript — their outcomes live in the group activity log.
        { suppressCoordinatorCheckins: isCoordinatorConversation },
      ),
    [
      activeThread?.proposedPlans,
      agentActivityTimelineState.timelineWorkEntries,
      isCoordinatorConversation,
      timelineMessages,
    ],
  );
  const enteringUserMessageIds = useMemo<ReadonlySet<MessageId>>(
    () => new Set(optimisticUserMessages.map((message) => message.id)),
    [optimisticUserMessages],
  );
  const conversationGeneratedImages = useMemo(
    () =>
      [...groupGeneratedImagesByTurn(timelineEntries).values()].flatMap((group) =>
        group.images.map((image) => ({
          id: conversationImageIdentity(resolveGeneratedImageGalleryGroup(group).groupId, image.id),
          path: image.path,
          name: image.path.replace(/\\/g, "/").split("/").at(-1) || "image",
        })),
      ),
    [timelineEntries],
  );
  useEffect(() => {
    if (conversationGeneratedImages.length === 0) return;
    const dock = useRightDockStore.getState();
    const pane = dock.dockStateByThreadId[threadId]?.panes.find(
      (entry) => entry.kind === "imagePreview",
    );
    if (!pane?.imagePreview) return;
    const merged = mergeConversationImages(pane.imagePreview.images, conversationGeneratedImages);
    if (JSON.stringify(merged) !== JSON.stringify(pane.imagePreview.images))
      dock.updatePane(threadId, pane.id, {
        imagePreview: { ...pane.imagePreview, images: merged },
      });
  }, [conversationGeneratedImages, threadId]);
  // The user message a local send anchored at the top of the transcript viewport.
  // Set at the send sites and kept after the turn settles — collapsing the tail
  // spacer when a turn ends would visibly yank the settled transcript. The next
  // send replaces it, and thread switches reset it via the per-thread timeline
  // remount plus the threadId guard at the render site.
  const [tailAnchor, setTailAnchor] = useState<{
    threadId: ThreadId;
    messageId: MessageId;
  } | null>(null);
  // True from send until the tail-anchor hook finishes sliding the sent message
  // to the viewport top. The auto-follow effect stays quiet while set so the
  // anchored slide has exactly one scroll owner (see useTailAnchorScroll).

  // --- Pinned messages & notes (per-thread, server-synced through sidepanel commands) ---
  const pinnedMessages = activeThread?.pinnedMessages ?? EMPTY_PINNED_MESSAGES;
  const goalAchievements = activeThread?.goalAchievements ?? EMPTY_GOAL_ACHIEVEMENTS;
  const threadNotes = activeThread?.notes ?? "";
  const pinnedMessageIds = useMemo(
    () => new Set(pinnedMessages.map((pin) => pin.messageId)),
    [pinnedMessages],
  );
  const pinnedMessageTextById = useMemo(() => {
    if (pinnedMessageIds.size === 0) return EMPTY_PINNED_TEXT;
    const textById = new Map<MessageId, string>();
    for (const message of timelineMessages) {
      if (pinnedMessageIds.has(message.id)) textById.set(message.id, message.text);
    }
    return textById;
  }, [pinnedMessageIds, timelineMessages]);
  const {
    handleTogglePinMessage,
    handleTogglePinnedMessageDone,
    handleUnpinMessage,
    handleRenamePinnedMessage,
    handleNotesChange,
  } = usePinnedMessageActions({ activeThreadId, pinnedMessages });
  const handleTogglePinMessageGuarded = useCallback(
    (messageId: MessageId) => {
      // Never pin an ephemeral automation-setup bubble; its id vanishes when setup ends.
      if (isPendingSetupBubbleId(messageId)) {
        return;
      }
      handleTogglePinMessage(messageId);
    },
    [handleTogglePinMessage, isPendingSetupBubbleId],
  );
  // Stable identity: this is forwarded to the memoized MessagesTimeline, so an inline
  // arrow here would defeat its `memo()` and re-derive every row on every keystroke.
  const canPinMessage = useCallback(
    (messageId: MessageId) => !isPendingSetupBubbleId(messageId),
    [isPendingSetupBubbleId],
  );
  const handleCopyProjectInstructionsToNotes = useCallback(() => {
    if (!activeThreadId) {
      return;
    }
    const nextNotes = mergeProjectInstructionsIntoThreadNotes({
      threadNotes,
      projectInstructions,
    });
    if (nextNotes === threadNotes) {
      return;
    }
    void handleNotesChange(activeThreadId, nextNotes)
      .then(() => {
        toastManager.add({
          type: "success",
          title: "Project instructions added to notepad.",
        });
      })
      .catch(() => {
        // `handleNotesChange` already surfaces the save failure through the shared notes toast.
      });
  }, [activeThreadId, handleNotesChange, projectInstructions, threadNotes]);
  const historyJumpThreadRef = useRef<ThreadId | null>(threadId);
  useLayoutEffect(() => {
    historyJumpThreadRef.current = threadId;
    return () => {
      historyJumpThreadRef.current = null;
    };
  }, [threadId]);
  const handleJumpToPinnedMessage = useCallback(
    (messageId: MessageId) => {
      const cancelled = () => historyJumpThreadRef.current !== threadId;
      void ensureThreadHistoryLoaded(threadId, messageId, cancelled).then(() => {
        requestAnimationFrame(() => {
          if (!cancelled()) timelineControllerRef.current?.scrollToMessage(messageId);
        });
      });
    },
    [threadId, timelineControllerRef],
  );

  // Before treating an empty timeline as a genuinely new thread, wait for the
  // detail snapshot: a server thread whose history has not synced yet must show
  // a loading (or failed) transcript state instead of the empty landing.
  const threadDetailHydration = resolveThreadDetailHydration({
    isServerThread,
    hasTimelineEntries: timelineEntries.length > 0,
    detailSyncState: threadDetailSyncState,
  });
  // Turn/session updates can arrive before the first transcript row. An empty
  // synced snapshot during startup must not restore the unstarted landing.
  // Terminal turns can lack start timestamps after restore/import; their state wins.
  const hasPendingThreadWork =
    isWorking || (activeLatestTurnState === "running" && !latestTurnSettled);
  const handleRetryThreadDetailSync = useCallback(() => {
    void retryThreadDetailSync(threadId).catch(() => undefined);
  }, [threadId]);
  const activeThreadIsSidechat = Boolean(activeThread && isSidechatThread(activeThread));
  // Stable identity: this element is forwarded to the memoized MessagesTimeline, so
  // building it inline in JSX would defeat its `memo()` on every keystroke.
  const transcriptEmptyStateContent = useMemo((): ReactNode => {
    if (isEditorRail) {
      return <span aria-hidden="true" />;
    }
    if (threadDetailHydration !== "ready") {
      return (
        <ThreadDetailHydrationState
          onRetry={handleRetryThreadDetailSync}
          state={threadDetailHydration}
        />
      );
    }
    return hasPendingThreadWork || activeThreadIsSidechat ? <span aria-hidden="true" /> : undefined;
  }, [
    activeThreadIsSidechat,
    handleRetryThreadDetailSync,
    hasPendingThreadWork,
    isEditorRail,
    threadDetailHydration,
  ]);
  // Empty top-level threads render the centered landing composer instead of the transcript pane.
  // Home-scoped chats get the global "What should we build?" copy plus the project picker,
  // while project-scoped drafts reuse the same centered layout with folder-specific copy.
  const isCenteredEmptyLanding =
    timelineEntries.length === 0 &&
    !hasPendingThreadWork &&
    !activeThread?.parentThreadId &&
    !activeThreadIsSidechat &&
    !isEditorRail &&
    threadDetailHydration === "ready";
  const isEmptyChatLanding =
    isCenteredEmptyLanding && Boolean(homeDir) && isContainerLandingProject;
  // Code review sidechats keep an item-specific composer placeholder.
  const standaloneSidechatContext =
    activeThread && isStandaloneSidechatThread(activeThread) ? activeThread.sidechatContext : null;
  const standaloneSidechatItemNoun =
    standaloneSidechatContext?.itemKind === "issue" ? "issue" : "pull request";
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnTimingByTurnId = useMemo(
    () =>
      deriveTurnTimingByTurnId({
        turnDiffSummaries,
        latestTurn: activeLatestTurn,
        activities: threadActivities,
      }),
    [activeLatestTurn, threadActivities, turnDiffSummaries],
  );
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const messagesForDiffAnchoring: {
      id: MessageId;
      role: "user" | "assistant" | "system";
      turnId: TurnId | null;
    }[] = [];
    for (const message of timelineMessages) {
      messagesForDiffAnchoring.push({
        id: message.id,
        role: message.role,
        turnId: message.turnId ?? null,
      });
    }
    return buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: turnDiffSummaries.map((summary) => ({
        ...summary,
        checkpointTurnCount:
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      })),
      messages: messagesForDiffAnchoring,
    });
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaries, timelineMessages]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const threadWorkspaceCwd = activeProject
    ? resolveSharedThreadWorkspaceCwd({
        projectCwd: activeProject.cwd,
        envMode: resolvedThreadEnvMode,
        worktreePath: resolvedThreadWorktreePath,
        workingDirectory: resolvedThreadWorkingDirectory,
      })
    : null;
  const threadArtifactWorkspaceRoot = resolveThreadArtifactWorkspaceRoot({
    isGroupContainer,
    projectCwd: activeProject?.cwd ?? null,
    threadWorkspaceCwd,
  });
  const gitCwd = threadWorkspaceCwd;
  const gitBranchSourceCwd = isGroupContainer
    ? threadWorkspaceCwd
    : activeProject
      ? resolveThreadBranchSourceCwd({
          projectCwd: activeProject.cwd,
          worktreePath: resolvedThreadWorktreePath,
        })
      : null;

  const branchesQuery = useQuery(gitBranchesQueryOptions(gitBranchSourceCwd));
  const gitStatusQuery = useQuery(gitStatusQueryOptions(gitBranchSourceCwd));
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverConfigQuery.data?.homeDir ?? null,
    isMacNavigatorPlatform(),
  );
  const [isContextWindowMeterOpen, setIsContextWindowMeterOpen] = useState(false);
  const {
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    providerPlugins,
    providerNativeCommands,
    providerArtifacts,
    providerSkills,
    workspaceEntries,
    effectiveComposerTrigger,
    effectiveComposerTriggerKind,
    supportsTextNativeReviewCommand,
    isComposerMenuLoading,
    canCompactThread,
    isNativeCommandDiscoveryPending,
  } = useComposerDiscovery({
    threadId,
    selectedProvider,
    selectedProviderInstanceId,
    composerTrigger,
    composerCommandPicker,
    providerModelDiscoveryCwd,
    providerOptionsForDispatch,
    gitCwd,
    piAgentDir: settings.piAgentDir,
    ompAgentDir: settings.ompAgentDir,
    discoverNativeCompaction:
      selectedProvider === "claudeAgent" &&
      (isContextWindowMeterOpen || activeThread?.claudeCacheReview != null),
  });
  const canRequestNativeClaudeCompaction =
    selectedProvider === "claudeAgent" &&
    hasProviderNativeSlashCommand(
      "claudeAgent",
      providerNativeCommands.map((command) => command.name),
      "compact",
    );
  const claudeCompactDisabledReason = !canRequestNativeClaudeCompaction
    ? isNativeCommandDiscoveryPending
      ? "Checking Claude's available commands..."
      : "Compaction is unavailable for this Claude session."
    : hasLiveTurn || isConnecting || (activeBackgroundTasks?.activeCount ?? 0) > 0
      ? "Wait for Claude and its background tasks to finish."
      : activePendingApproval || pendingUserInputs.length > 0
        ? "Resolve the pending request before compacting."
        : null;
  const standaloneClaudeCompactDisabledReason =
    activeThread?.claudeCacheReview != null
      ? "Choose how to resume the held message above."
      : isWorking
        ? "Wait for Claude to finish before compacting."
        : claudeCompactDisabledReason;
  const { compact: onCompactClaudeContext, isSubmitting: isRequestingClaudeCompaction } =
    useClaudeContextCompaction({
      threadId,
      disabledReason: standaloneClaudeCompactDisabledReason,
      onBegin: beginLocalDispatch,
      onAccepted: armLocalDispatchAckFallback,
      onFailure: resetLocalDispatch,
    });
  const cacheReviewMessageId = activeThread?.claudeCacheReview?.messageId;
  const cacheReviewMessage = cacheReviewMessageId
    ? activeThread?.messages.find((entry) => entry.id === cacheReviewMessageId)
    : undefined;
  const cacheReviewIsCompactionRequest = /^\/compact(?:\s|$)/u.test(
    cacheReviewMessage?.text.trim() ?? "",
  );
  const onRespondToClaudeCacheReview = useCallback(
    async (review: PendingClaudeCacheReview, decision: ClaudeCacheReviewDecision) => {
      const api = readNativeApi();
      if (!api || isThreadDetailAwaitingVerification(threadId))
        throw new Error("Reconnect before choosing how to resume.");
      await api.orchestration.dispatchCommand({
        type: "thread.claude-cache.respond",
        commandId: newCommandId(),
        threadId,
        messageId: review.messageId,
        reviewId: review.reviewId,
        decision,
        createdAt: new Date().toISOString(),
      });
    },
    [threadId],
  );
  const activeRootBranch = useMemo(
    () =>
      resolveComposerSlashRootBranch({
        branches: branchesQuery.data?.branches,
        activeProjectCwd: activeProject?.cwd,
        activeThreadBranch: activeThread?.branch,
      }),
    [activeProject?.cwd, activeThread?.branch, branchesQuery.data?.branches],
  );
  const currentActiveGitBranch = useMemo(() => {
    if (gitStatusQuery.data !== undefined) {
      return gitStatusQuery.data.branch;
    }

    return (
      branchesQuery.data?.branches.find(
        (branch) =>
          branch.current === true &&
          (branch.worktreePath === null ||
            branch.worktreePath === undefined ||
            branch.worktreePath === activeProject?.cwd),
      )?.name ?? null
    );
  }, [activeProject?.cwd, branchesQuery.data?.branches, gitStatusQuery.data]);
  const settledThreadBranchMismatch = resolveSettledThreadBranchMismatch({
    isSettled:
      activeThread?.settledAt != null &&
      settledThreadBranchWarningDismissedThreadId !== activeThread.id,
    isLocalWorkspace: !isGroupContainer && resolvedThreadWorktreePath === null,
    threadBranch: settledThreadBranchAtActivation,
    currentBranch: currentActiveGitBranch,
  });

  const selectedModelCaps = useMemo(
    () => getModelCapabilities(selectedProvider, selectedModel),
    [selectedModel, selectedProvider],
  );
  const supportsFastSlashCommand = selectedModelCaps.supportsFastMode;
  const currentProviderModelOptions = composerModelOptions?.[selectedProvider];
  const { isEffortPreviewOpen, cycleEffort, dismissEffortPreview } = useComposerEffortCycle({
    threadId,
    provider: selectedProvider,
    providerInstanceId: selectedProviderInstanceId,
    model: selectedModel,
    runtimeModel: selectedRuntimeModel,
    modelOptions: currentProviderModelOptions,
    prompt,
  });
  const isComposerModelEffortPickerOpen =
    isModelPickerOpen || isTraitsPickerOpen || isEffortPreviewOpen;
  const fastModeEnabled =
    supportsFastSlashCommand &&
    (currentProviderModelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;
  const composerPromptWithoutActiveSlashTrigger =
    composerTrigger?.kind === "slash-command"
      ? stripComposerTriggerText(prompt, composerTrigger)
      : prompt;
  const canOfferReviewCommand =
    (branchesQuery.data?.isRepo ?? true) &&
    canOfferReviewSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
    });
  const canOfferForkCommand =
    isServerThread &&
    activeThread !== undefined &&
    canOfferForkSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
      interactionMode,
    });
  const sideSlashCommandContext = {
    imageCount: composerImages.length,
    terminalContextCount: composerTerminalContexts.length,
    selectedSkillCount: selectedComposerSkills.length,
    selectedMentionCount: selectedComposerMentions.length,
    interactionMode,
    isSidechat: activeThread ? isSidechatThread(activeThread) : false,
  } as const;
  const canExecuteSideCommand =
    isServerThread &&
    activeThread !== undefined &&
    canExecuteSideSlashCommand(sideSlashCommandContext);
  const canOfferSideCommand =
    isServerThread &&
    activeThread !== undefined &&
    canOfferSideSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      ...sideSlashCommandContext,
    });
  // Export is hidden while the thread is running so archives cannot capture a
  // partial assistant response. Same shared predicate as the server's 409
  // guard, so the composer and the export route cannot drift.
  const canOfferExportCommand =
    isServerThread &&
    activeThread !== undefined &&
    threadExportBlockedReason(activeThread) === null;
  // Connectors are mentionable only where the session receives them.
  const connectorsMentionable =
    MCP_CONNECTORS_ON && providerSupportsMcpConnectors(selectedProvider);
  const connectorsQuery = useQuery({
    ...mcpConnectorsQueryOptions(),
    enabled: connectorsMentionable,
  });
  const mentionableConnectors = useMemo(
    () =>
      connectorsMentionable
        ? (connectorsQuery.data ?? []).filter((connector) => connector.status === "connected")
        : [],
    [connectorsMentionable, connectorsQuery.data],
  );
  const normalComposerMenuItems = useComposerCommandMenuItems({
    composerTrigger: effectiveComposerTrigger,
    provider: selectedProvider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    searchableModelOptions,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      canCompactThread &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferReviewCommand,
    canOfferForkCommand,
    canOfferSideCommand,
    canOfferExportCommand,
    providerArtifacts,
    dynamicAgents,
    threadMentionSources: {
      threads: composerThreadSummaries,
      projects: composerThreadProjects,
      currentThreadId: threadId,
    },
    connectors: mentionableConnectors,
  });
  const composerMenuItems = useMemo(() => {
    if (composerCommandPicker === "fork-target") {
      return [
        {
          id: "fork-target:worktree",
          type: "fork-target" as const,
          target: "worktree" as const,
          label: FORK_THREAD_TARGET_LABELS.worktree,
          description: "Continue in a new worktree",
        },
        {
          id: "fork-target:local",
          type: "fork-target" as const,
          target: "local" as const,
          label: FORK_THREAD_TARGET_LABELS.local,
          description:
            activeThread?.worktreePath || activeThread?.envMode === "worktree"
              ? "Continue in this local worktree"
              : "Continue in the current local thread",
        },
      ];
    }
    if (composerCommandPicker === "review-target") {
      return [
        {
          id: "review-target:changes",
          type: "review-target" as const,
          target: "changes" as const,
          label: "Review Uncommitted Changes",
          description: "Review local uncommitted changes",
        },
        {
          id: "review-target:base-branch",
          type: "review-target" as const,
          target: "base-branch" as const,
          label: "Review Against Base Branch",
          description: "Review the current branch diff against its base",
        },
      ];
    }

    return normalComposerMenuItems;
  }, [
    activeThread?.envMode,
    activeThread?.worktreePath,
    composerCommandPicker,
    normalComposerMenuItems,
  ]);
  const composerMenuOpen = Boolean(composerTrigger || composerCommandPicker);
  // The `+` panel yields the floating slot to the slash/mention menu as soon as a
  // trigger is typed, so the two can never render over each other.
  const composerExtrasPanelOpen = isComposerExtrasPanelOpen && !composerMenuOpen;
  const composerOverlayOpen = composerMenuOpen || composerExtrasPanelOpen;
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  // Keydown can fire as soon as the updated menu commits, before passive effects.
  useLayoutEffect(() => {
    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;
  }, [
    composerMenuOpenRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    composerMenuOpen,
    composerMenuItems,
    activeComposerMenuItem,
  ]);
  const nonPersistedComposerImageIdSet = useMemo(() => {
    const durableBlobIds = new Set(
      durablyPersistedComposerImageIds
        .filter((attachment) => Boolean(attachment.blobKey))
        .map((attachment) => attachment.id),
    );
    return new Set(nonPersistedComposerImageIds.filter((id) => !durableBlobIds.has(id)));
  }, [durablyPersistedComposerImageIds, nonPersistedComposerImageIds]);
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const { rememberCustomBinaryPathForDispatch, providerStatuses } = useChatProviderStatus({
    activeThread,
    settings,
    configuredProviderStatuses: serverConfigQuery.data?.providers,
  });
  const activeThreadProvider = activeThread?.modelSelection.provider ?? null;
  const activeThreadProviderInstanceId =
    activeThread?.session?.providerInstanceId ?? activeThread?.modelSelection.instanceId;
  const handoffTargets = useMemo(
    () =>
      activeThreadProvider
        ? resolveAvailableHandoffTargets({
            sourceProvider: activeThreadProvider,
            sourceProviderInstanceId: activeThreadProviderInstanceId,
            providerInstances,
            providerStatuses,
          })
        : [],
    [activeThreadProvider, activeThreadProviderInstanceId, providerInstances, providerStatuses],
  );
  const continueHandoffTargets = useMemo(
    () =>
      handoffTargets.filter(
        (target) =>
          activeThreadProvider !== null &&
          canContinueThreadHandoff({
            sourceProvider: activeThreadProvider,
            targetProvider: target.provider,
          }),
      ),
    [activeThreadProvider, handoffTargets],
  );
  const sidechatTargetProviders = useMemo(
    () => [...new Set(handoffTargets.map((target) => target.provider))],
    [handoffTargets],
  );

  const handoffActionLabel = activeThread ? "Hand off thread" : "Create handoff thread";
  const activeProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, selectedProvider, selectedProviderInstanceId),
    [selectedProvider, selectedProviderInstanceId, providerStatuses],
  );
  const activeProviderHealthBannerDismissalKey = useMemo(
    () => getProviderHealthBannerDismissalKey(activeProviderStatus),
    [activeProviderStatus],
  );
  const visibleActiveProviderStatus =
    !isProviderDurablyUnavailable(activeProviderStatus) &&
    activeProviderHealthBannerDismissalKey &&
    dismissedProviderHealthBannerKeys.includes(activeProviderHealthBannerDismissalKey)
      ? null
      : activeProviderStatus;
  const voiceProviderTarget = useMemo(
    () =>
      resolveVoiceTranscriptionTarget({
        statuses: providerStatuses,
        providerInstances,
        selectedProvider,
        selectedProviderInstanceId,
      }),
    [providerInstances, providerStatuses, selectedProvider, selectedProviderInstanceId],
  );
  const voiceProviderStatus = voiceProviderTarget?.status ?? null;
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = isGroupContainer ? null : (activeThread?.worktreePath ?? null);
  const hasNativeUserMessages = useMemo(
    () =>
      activeThread?.messages.some(
        (message) =>
          message.role === "user" &&
          (message.source === "native" || message.source === "async-user-input"),
      ) ?? false,
    [activeThread?.messages],
  );
  // Left to React Compiler instead of a manual `useMemo`: the hand-written dep array could
  // not be preserved (the compiler cannot prove `threadWorkspaceCwd` is never mutated), which
  // bailed the whole component out of compilation. The empty case returns a module-level
  // constant so its identity is stable no matter how the value is memoized.
  const terminalRuntimeProjectCwd = isGroupContainer ? threadWorkspaceCwd : activeProjectCwd;
  const threadTerminalRuntimeEnv = terminalRuntimeProjectCwd
    ? projectScriptRuntimeEnv({
        project: {
          cwd: terminalRuntimeProjectCwd,
        },
        worktreePath: activeThreadWorktreePath,
      })
    : EMPTY_TERMINAL_RUNTIME_ENV;
  const isGitRepo = resolveGitRepoUiState({
    isGroupContainer,
    queriedIsRepo: branchesQuery.data?.isRepo,
  });
  // Groups never offers "Initialize Git": its reference folder is ordinary cwd context,
  // so Git actions appear only when that selected folder is already a repository.
  const showGitActions = isGroupContainer
    ? Boolean(resolvedThreadWorkingDirectory) && isGitRepo
    : !isContainerLandingProject || Boolean(resolvedThreadWorktreePath);
  const repoDiffTotals = useRepoDiffTotals({
    gitCwd: threadWorkspaceCwd,
    isGitRepo,
    refetchInterval: repoDiffBadgeRefreshIntervalMs,
  });
  // The composer live strip is turn-scoped; repoDiffTotals can include unrelated
  // local edits that existed before the active agent turn started.
  const activeTurnLiveDiffState = useMemo(
    () =>
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeLatestTurn?.turnId ?? null,
        turnDiffSummaries,
        workLogEntries,
      }),
    [activeLatestTurn?.turnId, turnDiffSummaries, workLogEntries],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const modelPickerShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "modelPicker.toggle") ??
      formatShortcutLabel({
        key: "m",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    [keybindings],
  );
  const traitsPickerShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "traitsPicker.toggle"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    if (diffEnvironmentPending && !diffOpen) {
      return;
    }
    if (onToggleDiffPanel) {
      onToggleDiffPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen
          ? { ...rest, panel: undefined, diff: undefined }
          : { ...rest, panel: "diff", diff: "1" };
      },
    });
  }, [diffEnvironmentPending, diffOpen, navigate, onToggleDiffPanel, threadId]);
  const onToggleBrowser = useCallback(() => {
    if (onToggleBrowserPanel) {
      onToggleBrowserPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return browserOpen ? { ...rest, panel: undefined } : { ...rest, panel: "browser" };
      },
    });
  }, [browserOpen, navigate, onToggleBrowserPanel, threadId]);
  const openBrowserUrl = useCallback(
    (url: string) => {
      const api = readNativeApi();
      void api?.browser.open({ threadId, initialUrl: url }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not open repository",
          description:
            error instanceof Error ? error.message : "The in-app browser could not open GitHub.",
        });
      });
      if (onOpenBrowserUrl) {
        onOpenBrowserUrl(url);
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          panel: "browser",
        }),
      });
    },
    [navigate, onOpenBrowserUrl, threadId],
  );
  // Chat links offer the built-in review view only for repositories this project owns,
  // matching the Environment panel; any other pull request or issue falls back to the in-app
  // browser. A pull request opens in the thread's PR pane, an issue in the inbox detail.
  // Left to the React Compiler to memoize: manual hooks here cannot be preserved.
  const openRightDockPane = useRightDockStore((store) => store.openPane);
  // A side chat in a dock (the only chat without a header) has no dock or browser panel of its
  // own on screen, so the fallbacks above change for it. A forked one selects a PR tab in its host
  // chat's dock, a standalone one (Code review's Ask) selects the PR in Code review, and links
  // meant for the in-app browser open externally.
  const sidechatHostThreadId = hideHeader ? (activeThread?.sidechatSourceThreadId ?? null) : null;
  const opensPullRequestInCodeReview = hideHeader && standaloneSidechatContext !== null;
  const openLinkInBrowser = hideHeader ? openExternalLink : openBrowserUrl;
  const openGitHubItemLink = (url: string) => {
    const item = parseGitHubItemUrl(url);
    if (!item || !activeProjectId) {
      openLinkInBrowser(url);
      return;
    }
    const { kind, repository, number } = item;
    void queryClient.fetchQuery(gitGithubRepositoryQueryOptions(gitBranchSourceCwd)).then(
      (result) => {
        const belongsToProject = result.repositories.some(
          (candidate) => candidate.nameWithOwner.toLowerCase() === repository.toLowerCase(),
        );
        if (!belongsToProject) {
          openLinkInBrowser(url);
          return;
        }
        if (kind === "issue" || opensPullRequestInCodeReview) {
          void navigate({
            to: "/pull-requests",
            search: {
              kind,
              selectedProjectId: activeProjectId,
              selectedRepo: repository,
              number,
            },
          });
          return;
        }
        openRightDockPane(sidechatHostThreadId ?? threadId, {
          kind: "pullRequest",
          pullRequestProjectId: activeProjectId,
          pullRequestRepository: repository,
          pullRequestNumber: number,
          pullRequestInitialTab: "summary",
        });
      },
      () => openLinkInBrowser(url),
    );
  };
  const chatLinkActions: ChatLinkActions = {
    openInBrowserPanel: openLinkInBrowser,
    openGitHubItem: openGitHubItemLink,
    githubLinkOpenTarget: settings.githubLinkOpenTarget,
  };

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const isTerminalPrimarySurface = terminalState.entryPoint === "terminal";
  const isTerminalEnvironmentContext =
    isTerminalPrimarySurface || terminalWorkspaceTerminalTabActive;
  const shouldShowProviderHealthBanner = shouldRenderProviderHealthBanner({
    threadEntryPoint: terminalState.entryPoint,
    terminalWorkspaceTerminalTabActive,
  });
  // Terminal-only threads should not pay to mount the hidden chat/composer pane.
  const shouldRenderChatPaneContent = !(
    terminalWorkspaceTerminalTabActive && terminalState.workspaceLayout === "terminal-only"
  );
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (getThreadFromState(useStore.getState(), targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setLocalDraftErrorsByThreadId, setStoreThreadError],
  );
  const composerImageAttachmentCount = useCallback(
    () =>
      effectiveComposerAttachmentCount(useComposerDraftStore.getState().draftsByThreadId[threadId]),
    [threadId],
  );
  const commitPreparedComposerImages = useCallback(
    (images: ComposerImageAttachment[]) => addComposerImagesToDraft(images),
    [addComposerImagesToDraft],
  );
  const setComposerImagePreparationError = useCallback(
    (error: string | null) => setThreadError(threadId, error),
    [setThreadError, threadId],
  );
  const {
    addImages: enqueueComposerImages,
    isPreparingImages: isPreparingComposerImages,
    pendingImageCount: pendingComposerImageCount,
    waitForPending: waitForPendingComposerImages,
  } = useComposerImageIntake({
    threadId,
    existingAttachmentCount: composerImageAttachmentCount,
    commitImages: commitPreparedComposerImages,
    onError: setComposerImagePreparationError,
  });

  const focusComposer = useCallback(() => {
    // A disabled editor (dispatch connecting, pending approval) cannot
    // take focus either. Never ask the renderer to focus while another app owns
    // the desktop; on macOS that can activate Moss and switch Spaces.
    const editor = composerEditorRef.current;
    if (
      !editor ||
      !canApplyComposerFocus({
        windowHasFocus: document.hasFocus(),
        editorAvailable: true,
        editorDisabled: isComposerEditorDisabled,
      })
    ) {
      pendingComposerFocusRef.current = true;
      return;
    }
    pendingComposerFocusRef.current = false;
    editor.focusAtEnd();
  }, [composerEditorRef, pendingComposerFocusRef, isComposerEditorDisabled]);
  const toggleComposerFocus = useCallback(() => {
    const editor = composerEditorRef.current;
    if (editor?.isFocused()) {
      pendingComposerFocusRef.current = false;
      editor.blur();
      return;
    }
    focusComposer();
  }, [composerEditorRef, pendingComposerFocusRef, focusComposer]);
  const scheduleComposerFocus = useCallback(() => {
    pendingComposerFocusRef.current = true;
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [pendingComposerFocusRef, focusComposer]);
  const { change: handleComputerControlModeChange, sequence: computerControlChangeSequence } =
    useComputerControlModeChange({
      threadId,
      setMode: setComposerDraftComputerControlMode,
      focusComposer: scheduleComposerFocus,
    });
  // External panels (diff headers, file explorer, preview) bump this nonce after
  // inserting a reference so the composer visibly receives the text.
  const composerFocusRequestNonce = useComposerFocusRequestStore(
    (store) => store.requestsByThreadId[threadId] ?? 0,
  );
  useEffect(() => {
    if (composerFocusRequestNonce > 0) {
      scheduleComposerFocus();
    }
  }, [composerFocusRequestNonce, scheduleComposerFocus]);
  // A deferred composer focus is only welcome while nothing else in the app holds
  // focus: once the reader deliberately focuses the transcript, find box or any
  // control, a stale pending focus must not steal it (and yank the scroll) back.
  const canApplyPendingComposerFocus = () =>
    document.activeElement === null || document.activeElement === document.body;
  useEffect(() => {
    if (!pendingComposerFocusRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (canApplyPendingComposerFocus()) {
        focusComposer();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pendingComposerFocusRef, focusComposer, threadId]);
  useEffect(() => {
    const handleWindowFocus = () => {
      if (!pendingComposerFocusRef.current) return;
      window.requestAnimationFrame(() => {
        if (canApplyPendingComposerFocus()) {
          focusComposer();
        }
      });
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [pendingComposerFocusRef, focusComposer]);
  // Keep the two composer picker menus mutually exclusive so shortcuts always open one surface.
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      dismissEffortPreview();
      setIsModelPickerOpen(open);
      if (open) {
        setIsTraitsPickerOpen(false);
      }
    },
    [dismissEffortPreview, setIsModelPickerOpen, setIsTraitsPickerOpen],
  );
  const handleTraitsPickerOpenChange = useCallback(
    (open: boolean) => {
      dismissEffortPreview();
      setIsTraitsPickerOpen(open);
      if (open) {
        setIsModelPickerOpen(false);
      }
    },
    [dismissEffortPreview, setIsModelPickerOpen, setIsTraitsPickerOpen],
  );
  const appendVoiceTranscriptToComposer = useCallback(
    (transcript: string) => {
      const nextPrompt = appendVoiceTranscriptToPrompt(promptRef.current, transcript);
      if (!nextPrompt) {
        return;
      }

      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [promptRef, setComposerCursor, setComposerTrigger, scheduleComposerFocus, setPrompt],
  );
  const {
    isVoiceRecording,
    isVoiceStarting,
    isVoiceWaitingForAudio,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  } = useComposerVoiceController({
    activeProject,
    activeThreadId: activeThread?.id ?? null,
    threadId,
    selectedProvider,
    selectedProviderInstanceId,
    voiceProviderInstanceId: voiceProviderTarget?.instanceId ?? "codex",
    activeProviderStatus: voiceProviderStatus,
    pendingUserInputCount: pendingUserInputs.length,
    onTranscriptReady: appendVoiceTranscriptToComposer,
    refreshVoiceStatus: refreshProviderStatuses,
    actionArmDelayMs: VOICE_RECORDER_ACTION_ARM_DELAY_MS,
    failureCopy: {
      transcriptionFailedTitle: "Couldn't transcribe voice note",
    },
    onGuardWarning: warnVoiceGuard,
  });
  const composerPredictionEnabled =
    // 有意偏离：多 CLI — non-Codex providers still predict.
    interactionMode !== "plan" &&
    !hasLiveTurn &&
    !isComposerEditorDisabled &&
    !composerOverlayOpen &&
    composerTrigger === null &&
    activePendingProgress === null &&
    pendingUserInputs.length === 0 &&
    !showPlanFollowUpPrompt &&
    !isVoiceRecording &&
    !isVoiceTranscribing &&
    composerAssistantSelections.length === 0 &&
    composerBrowserAnnotations.length === 0 &&
    composerFileComments.length === 0 &&
    composerFiles.length === 0 &&
    composerImages.length === 0 &&
    composerMentions.length === 0 &&
    composerPastedTexts.length === 0 &&
    composerPullRequestContexts.length === 0 &&
    composerSkills.length === 0 &&
    composerTerminalContexts.length === 0;
  const [modelComposerPrediction, setModelComposerPrediction] = useState<{
    readonly key: string;
    readonly text: string;
  } | null>(null);
  const modelPredictionRequestKeyRef = useRef<string | null>(null);
  const modelPredictionAbortRef = useRef<AbortController | null>(null);
  const [predictionRefreshNonce, setPredictionRefreshNonce] = useState(0);
  const dismissedPredictionTurnIdRef = useRef<string | null>(null);
  const predictionIneligibleLogRef = useRef<string | null>(null);
  const [predictionTriggerTracker] = useState(createPredictionTriggerTracker);
  const modelPredictionKey =
    activeThreadId && activeLatestTurnId ? `${activeThreadId}:${activeLatestTurnId}` : null;
  // Live completion, mount catch-up, and window-focus recovery all share the
  // same request path. Domain events supply the turn-completed signal; the key
  // guard still coalesces duplicate delivery.
  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    return api.orchestration.onDomainEvent((event) => {
      const candidate = event as {
        readonly aggregateId?: string;
        readonly type?: string;
        readonly payload?: { readonly threadId?: string };
      };
      if (
        (candidate.aggregateId === activeThreadId ||
          candidate.payload?.threadId === activeThreadId) &&
        typeof candidate.type === "string" &&
        (candidate.type.includes("turn") || candidate.type.includes("message"))
      ) {
        modelPredictionRequestKeyRef.current = null;
        setPredictionRefreshNonce((value) => value + 1);
      }
    });
  }, [activeThreadId]);
  useEffect(() => {
    const handleFocus = () => {
      modelPredictionRequestKeyRef.current = null;
      setPredictionRefreshNonce((value) => value + 1);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);
  useEffect(() => {
    if (!settings.composerPredictionsEnabled || modelPredictionKey === null) {
      modelPredictionRequestKeyRef.current = null;
      setModelComposerPrediction((current) => (current === null ? current : null));
      return;
    }
    const ineligibleReason = !latestTurnSettled
      ? "turn-active"
      : interactionMode === "plan"
        ? "plan-mode"
        : null;
    if (ineligibleReason !== null) {
      modelPredictionRequestKeyRef.current = null;
      if (ineligibleReason === "turn-active") {
        predictionTriggerTracker.observeActiveTurn(modelPredictionKey);
      }
      const logKey = `${modelPredictionKey}:${ineligibleReason}`;
      if (import.meta.env.DEV && predictionIneligibleLogRef.current !== logKey) {
        predictionIneligibleLogRef.current = logKey;
        console.debug("[prediction] ineligible", { reason: ineligibleReason });
      }
      return;
    }
    predictionIneligibleLogRef.current = null;
    if (modelPredictionRequestKeyRef.current === modelPredictionKey) return;
    const api = readNativeApi();
    if (!api) return;
    if (activeThreadId === null || activeLatestTurnId === null) return;
    modelPredictionRequestKeyRef.current = modelPredictionKey;
    modelPredictionAbortRef.current?.abort();
    const controller = new AbortController();
    modelPredictionAbortRef.current = controller;
    const generationTrigger = predictionTriggerTracker.takeTrigger(modelPredictionKey);
    let finished = false;
    const startedAt = performance.now();
    void api.orchestration
      .predictNextMessage(
        {
          threadId: activeThreadId,
          latestTurnId: activeLatestTurnId,
          generationTrigger,
        },
        { signal: controller.signal },
      )
      .then((result) => {
        if (result.latestTurnId !== activeLatestTurnId || controller.signal.aborted) return;
        if (dismissedPredictionTurnIdRef.current === activeLatestTurnId) return;
        const text = result.text.trim();
        if (text.length === 0) {
          if (import.meta.env.DEV) {
            console.debug("[prediction] abstained", {
              durationMs: Math.round(performance.now() - startedAt),
            });
          }
          return;
        }
        if (import.meta.env.DEV) {
          console.debug("[prediction] shown", {
            durationMs: Math.round(performance.now() - startedAt),
          });
        }
        setModelComposerPrediction({ key: modelPredictionKey, text });
      })
      .catch(() => undefined)
      .finally(() => {
        finished = true;
        if (modelPredictionAbortRef.current === controller) modelPredictionAbortRef.current = null;
      });
    return () => {
      controller.abort();
      if (finished) return;
      // A request cut short here (StrictMode's dev remount, a dependency re-run) is asked
      // again by the next run, with its trigger, instead of being skipped by the key guard.
      if (modelPredictionRequestKeyRef.current === modelPredictionKey) {
        modelPredictionRequestKeyRef.current = null;
      }
      if (generationTrigger === "live") {
        predictionTriggerTracker.observeActiveTurn(modelPredictionKey);
      }
    };
  }, [
    activeLatestTurnId,
    activeThreadId,
    interactionMode,
    latestTurnSettled,
    modelPredictionKey,
    predictionRefreshNonce,
    predictionTriggerTracker,
    settings.composerPredictionsEnabled,
  ]);
  const modelPrediction = deriveModelComposerPrediction({
    prompt,
    text:
      composerPredictionEnabled && modelComposerPrediction?.key === modelPredictionKey
        ? modelComposerPrediction.text
        : null,
  });
  const composerPrediction = modelPrediction;
  // Bumped when Enter finishes a voice note under the "send" setting, or a
  // visual's follow-up choice fills the composer; the effect next to the late
  // send handlers sends once the new prompt commits.
  const [composerAutoSendRequest, setComposerAutoSendRequest] = useState(0);
  const finishComposerVoiceRecordingFromEnter = useCallback(() => {
    const autoSend = settings.voiceEnterBehavior === "send";
    const promptBeforeTranscript = promptRef.current;
    void submitComposerVoiceRecording().then((transcribed) => {
      // An empty transcript leaves the draft untouched; don't send it blind.
      if (autoSend && transcribed && promptRef.current !== promptBeforeTranscript) {
        setComposerAutoSendRequest((current) => current + 1);
      }
    });
  }, [promptRef, settings.voiceEnterBehavior, submitComposerVoiceRecording]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThreadId) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        selectionCollapsed: true,
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeThreadId,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThreadId,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      composerEditorRef,
      activeThreadId,
      composerCursor,
      composerTerminalContexts,
      discardPromptHistoryNavigationForComposerMutation,
      insertComposerDraftTerminalContext,
    ],
  );
  // Terminal-only workspaces intentionally have no mounted composer. Do not
  // publish a global-looking action with nowhere to insert the selection.
  const canAddTerminalContextToChat = activeThread !== undefined && shouldRenderChatPaneContent;
  // Keep the published capability stable while cursor and draft state change;
  // dock terminals should not rerender for ordinary composer edits.
  const addTerminalContextToDraftRef = useRef(addTerminalContextToDraft);
  useLayoutEffect(() => {
    addTerminalContextToDraftRef.current = addTerminalContextToDraft;
  }, [addTerminalContextToDraftRef, addTerminalContextToDraft]);
  const addRegisteredTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      addTerminalContextToDraftRef.current(selection);
    },
    [addTerminalContextToDraftRef],
  );
  useLayoutEffect(() => {
    if (!canAddTerminalContextToChat) {
      return;
    }
    return registerTerminalContextComposerTarget(paneScopeId, addRegisteredTerminalContextToDraft);
  }, [addRegisteredTerminalContextToDraft, canAddTerminalContextToChat, paneScopeId]);
  // Collapse an oversized paste into an attachment card above the composer instead
  // of flooding the editor with raw text. The card holds the full content until the
  // user sends or clicks "Show in text field".
  const addPastedTextToDraft = useCallback(
    (text: string) => {
      if (!activeThread) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftPastedTexts(activeThread.id, [
        createPastedTextDraft({
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          text,
        }),
      ]);
    },
    [activeThread, addComposerDraftPastedTexts, discardPromptHistoryNavigationForComposerMutation],
  );
  // The terminal's panel toggle mirrors the right dock's collapse control: it shows
  // or hides the side panel only when this thread already has a pane to show.
  const storeRightDockOpen = useRightDockStore(
    (store) => selectRightDockState(threadId)(store).open,
  );
  const rightDockOpen = rightDockOpenOverride ?? storeRightDockOpen;
  const isMobileViewport = useIsMobile();
  // Temporary threads are visually identical to regular chats — they use the same
  // Environment panel + header controls. "Temporary" is purely a sidebar badge +
  // auto-delete-on-leave concern, never a stripped-down chat UI.
  const environmentEnabled = !isEditorRail && !hideHeader;
  const environmentUsesFloatingOverlay =
    isTerminalEnvironmentContext || isMobileViewport || rightDockOpen || surfaceMode === "split";
  const environmentDefaultOpen = resolveDefaultEnvironmentPanelOpen({
    environmentEnabled,
    isCenteredEmptyLanding,
    isTerminalPrimarySurface,
    isConstrainedChatLayout: environmentUsesFloatingOverlay,
    settingsDefaultOpen: settings.environmentPanelDefaultOpen,
  });
  // Every close (header toggle or panel action click) stores the cross-chat preference,
  // so a dismissed panel stays closed when switching threads until it is toggled back on.
  // The same toggle also persists to settings so the preference survives reloads.
  const [environmentPanelPreferenceOpen, setEnvironmentPanelPreferenceOpen] = useState<
    boolean | null
  >(null);
  const updateEnvironmentPanelPreference = useCallback(
    (open: boolean, persist: boolean) => {
      const update = resolveEnvironmentPanelPreferenceUpdate({ open, persist });
      setEnvironmentPanelPreferenceOpen(update.userPreferenceOpen);
      if (update.settingsDefaultOpen !== null) {
        updateSettings({ environmentPanelDefaultOpen: update.settingsDefaultOpen });
      }
    },
    // The state setter is stable, so listing it changes nothing at runtime — but React
    // Compiler infers it as a dependency here and refuses to compile the component when the
    // hand-written array omits it.
    [setEnvironmentPanelPreferenceOpen, updateSettings],
  );
  const setEnvironmentPanelOpenPreference = useCallback(
    (open: boolean) => updateEnvironmentPanelPreference(open, true),
    [updateEnvironmentPanelPreference],
  );
  const closeEnvironmentPanelAfterAction = useCallback(
    () => updateEnvironmentPanelPreference(false, false),
    [updateEnvironmentPanelPreference],
  );
  const environmentPanelOpen = resolveEnvironmentPanelOpen({
    defaultOpen: environmentDefaultOpen,
    userPreferenceOpen: environmentPanelPreferenceOpen,
  });
  const environmentPanelVisible = resolveEnvironmentPanelVisible({
    environmentEnabled,
    environmentPanelOpen,
  });
  const projectPanelEnabled = resolveProjectPanelEnabled({
    environmentEnabled,
    isGroupContainer,
  });
  // Group chats default to the Groups panel — a newly created group's
  // coordinator chat opens with Focus/sections visible. An explicit toggle wins
  // while its project stays active; closing the panel persists per group so the
  // default never overrides a deliberate close.
  const { auxiliarySurface, chooseAuxiliarySurface, setGroupPanelClosed } = useAuxiliarySurface({
    projectId: activeProjectId,
    projectPanelEnabled,
    environmentPanelVisible,
  });
  const setEnvironmentFromAuxiliary = useCallback(
    (open: boolean) => {
      chooseAuxiliarySurface(open ? "environment" : null);
      setEnvironmentPanelOpenPreference(open);
    },
    [chooseAuxiliarySurface, setEnvironmentPanelOpenPreference],
  );
  const setProjectFromAuxiliary = useCallback(
    (open: boolean) => {
      chooseAuxiliarySurface(open ? "project" : null);
      // The close is remembered per group (separate store) — never written into
      // the env-panel preference, so a dismissed Groups panel stays closed on
      // later visits without changing the Environment default.
      setGroupPanelClosed(!open);
      // Another surface claims the dock, but the user's persisted env-panel
      // preference stays untouched — environmentPanelVisibleEffective already
      // hides Environment while a sibling panel is open.
      if (open) {
        closeEnvironmentPanelAfterAction();
      }
    },
    [chooseAuxiliarySurface, setGroupPanelClosed, closeEnvironmentPanelAfterAction],
  );
  const setLibraryFromAuxiliary = useCallback(
    (open: boolean) => {
      chooseAuxiliarySurface(open ? "library" : null);
      if (open) {
        closeEnvironmentPanelAfterAction();
      }
    },
    [chooseAuxiliarySurface, closeEnvironmentPanelAfterAction],
  );
  const githubRepositoryQuery = useQuery(
    gitGithubRepositoryQueryOptions(gitBranchSourceCwd, environmentPanelVisible),
  );
  const threadRecap = useThreadRecap({
    thread: activeThread,
    cwd: threadWorkspaceCwd,
    enabled: environmentPanelVisible,
    latestTurnSettled,
    codexHomePath: settings.codexHomePath || null,
    providerOptions: providerOptionsForDispatch ?? null,
    textGenerationModelSelection: resolveAuxiliaryTextGenerationSelection({
      provider: selectedProvider,
      modelSelection: selectedModelSelection,
    }),
  });
  const hasRightDockPanes = useRightDockStore(
    (store) => selectRightDockState(threadId)(store).panes.length > 0,
  );
  const setRightDockOpen = useRightDockStore((store) => store.setDockOpen);
  const rightPanelShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "rightPanel.toggle") ??
      formatShortcutLabel({
        key: "b",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
        modKey: true,
      }),
    [keybindings],
  );
  const toggleRightDock = useCallback(() => {
    setRightDockOpen(threadId, !rightDockOpen);
  }, [rightDockOpen, setRightDockOpen, threadId]);
  const terminalDrawerProps = {
    threadId,
    cwd: gitCwd ?? activeProject?.cwd ?? "",
    runtimeEnv: threadTerminalRuntimeEnv,
    terminalLabelsById: terminalState.terminalLabelsById,
    terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
    terminalCliKindsById: terminalState.terminalCliKindsById,
    activeTerminalId: terminalState.activeTerminalId,
    focusRequestId: terminalFocusRequestId,
    onTerminalSessionExited: handleTerminalSessionExited,
    onTerminalMetadataChange: (
      terminalId: string,
      metadata: {
        cliKind: "codex" | "claude" | "antigravity" | null;
        label: string;
      },
    ) => {
      if (!activeThreadId) return;
      storeSetTerminalMetadata(activeThreadId, terminalId, metadata);
    },
    onTerminalActivityChange: (
      terminalId: string,
      activity: {
        hasRunningSubprocess: boolean;
        agentState: "running" | "attention" | "review" | null;
      },
    ) => {
      if (!activeThreadId) return;
      storeSetTerminalActivity(activeThreadId, terminalId, activity);
    },
    ...(canAddTerminalContextToChat ? { onAddTerminalContext: addTerminalContextToDraft } : {}),
  };
  const {
    runProjectScript,
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
    lastInvokedScriptByProjectId,
  } = useChatProjectScripts({
    activeThreadId,
    activeThread,
    activeProject,
    gitCwd,
    isGroupContainer,
    setThreadError,
  });
  const stopActiveThreadSession = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !isServerThread ||
      !activeThread ||
      isThreadDetailAwaitingVerification(activeThread.id) ||
      activeThread.session === null ||
      activeThread.session.status === "closed"
    ) {
      return;
    }

    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, isServerThread]);
  const {
    handoffBusy,
    worktreeHandoffDialogOpen,
    setWorktreeHandoffDialogOpen,
    worktreeHandoffName,
    setWorktreeHandoffName,
    onHandoffToWorktree,
    onHandoffToLocal,
    confirmWorktreeHandoff,
  } = useThreadWorkspaceHandoff({
    activeProject,
    activeThread,
    activeRootBranch,
    activeThreadAssociatedWorktree,
    isServerThread,
    stopActiveThreadSession,
    runProjectScript,
  });
  const {
    persistRuntimeModeChange,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    resetInteractionMode,
    persistThreadSettingsForNextTurn,
  } = useChatRuntimeModes({
    onRuntimeModePersisted: acknowledgeRuntimeModeChange,
    threadId,
    activeThread,
    serverThread,
    isLocalDraftThread,
    runtimeMode,
    interactionMode,
    selectedProvider,
    selectedRuntimeModel,
    selectedModelSelection,
    activeProviderStatus,
    scheduleComposerFocus,
  });
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        planSidebarDismissedForTurnRef.current =
          activeTaskList?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [
    setPlanSidebarOpen,
    planSidebarDismissedForTurnRef,
    activeTaskList?.turnId,
    sidebarProposedPlan?.turnId,
  ]);

  const {
    showScrollToBottom,
    isUserScrollDetached,
    tailAnchorScrollInFlightRef,
    armTranscriptAutoFollow,
    onTranscriptNavigate,
    onIsAtEndChange,
    onScrollToBottom,
    onMessagesClickCaptureBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesPointerCancelBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
    onEmbeddedScrollIntent,
  } = useChatTranscriptScroll({
    activeThreadId,
    legendListRef,
    timelineEntries,
    hasStreamingAssistantText,
    composerTranscriptInsetPx,
    isInactiveSplitPane,
  });
  useEffect(() => {
    const messageId = rawSearch.messageId;
    if (!messageId || threadDetailSyncState !== "synced") return;
    let cancelled = false;
    onTranscriptNavigate();
    void ensureThreadHistoryLoaded(threadId, messageId, () => cancelled).then(() => {
      requestAnimationFrame(() => {
        if (!cancelled) timelineControllerRef.current?.scrollToMessage(messageId);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rawSearch.messageId, threadId, threadDetailSyncState, onTranscriptNavigate]);
  useLayoutEffect(() => {
    if (settings.anchorSentMessagesToTop) return;
    tailAnchorScrollInFlightRef.current = false;
    setTailAnchor(null);
  }, [settings.anchorSentMessagesToTop, tailAnchorScrollInFlightRef]);
  const selectionChatEnvMode = useProjectEnvironmentStore((state) =>
    activeProject ? state.envModeByProjectId[activeProject.id] : undefined,
  );
  const {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
    dismissTranscriptSelectionAction,
    onMessagesClickCapture,
    onMessagesMouseUp,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
  } = useTranscriptAssistantSelectionAction({
    threadId,
    enabled:
      Boolean(activeThread) &&
      !isInactiveSplitPane &&
      !isSidechatExpired &&
      pendingUserInputs.length === 0 &&
      !isComposerApprovalState,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
    canReferenceAssistantSelection: (selection) =>
      !isPendingSetupBubbleId(MessageId.makeUnsafe(selection.assistantMessageId)),
    scheduleComposerFocus,
    onMessagesClickCaptureBase,
    onMessagesPointerCancelBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
  });

  // Runs for unfocused split panes too: they stay visible, and a side chat in a narrow dock is
  // always one, so skipping the measurement left its footer clipped instead of tiered.
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const syncComposerFooterLayout = () => {
      const composerFormWidth = measureComposerFormWidth();
      const nextCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));
      // Tier the footer controls by MEASURED overflow: demote one step while
      // the footer row's content is wider than the row, promote back (with
      // hysteresis) when the recorded overflow width is comfortably exceeded.
      // Started threads move the pickers to the row under the composer, so that row is
      // the one that can overflow.
      const footerRow =
        composerStatusRowRef.current ??
        composerForm.querySelector<HTMLElement>("[data-chat-composer-footer]");
      if (footerRow) {
        const rowOverflows = footerRow.scrollWidth > footerRow.clientWidth + 1;
        // The leading cluster clips (overflow-hidden) in compact mode instead
        // of growing the row's scrollWidth, so check it directly — a clipped
        // "+"/access-rules cluster must also demote the tier.
        const leadingCluster = footerRow.querySelector<HTMLElement>("[data-chat-composer-leading]");
        const leadingClips =
          nextCompact &&
          leadingCluster !== null &&
          leadingCluster.scrollWidth > leadingCluster.clientWidth + 1;
        const nextStep = resolveNextComposerFooterTier({
          currentTier: composerFooterTierRef.current,
          clientWidth: footerRow.clientWidth,
          isOverflowing: rowOverflows || leadingClips,
          demotionWidths: composerFooterDemotionWidthsRef.current,
        });
        composerFooterDemotionWidthsRef.current = nextStep.demotionWidths;
        if (nextStep.tier !== composerFooterTierRef.current) {
          composerFooterTierRef.current = nextStep.tier;
          setComposerFooterTier(nextStep.tier);
        }
      }
    };
    composerFooterLayoutSyncRef.current = syncComposerFooterLayout;

    const measuredHeight = Math.ceil(composerForm.getBoundingClientRect().height);
    composerFormHeightRef.current = measuredHeight;
    syncComposerFooterLayout();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      syncComposerFooterLayout();

      const nextHeight = entry.contentRect.height;
      composerFormHeightRef.current = nextHeight;
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    setIsComposerFooterCompact,
    setComposerFooterTier,
    composerFooterTierRef,
    composerFooterDemotionWidthsRef,
    composerFooterLayoutSyncRef,
    composerFormRef,
    composerFormHeightRef,
    activeThread?.id,
    composerFooterHasWideActions,
    // The landing and the transcript mount the composer form in different places, so moving
    // between them replaces the node the observer watches.
    isCenteredEmptyLanding,
  ]);
  // Started threads get the single-row composer while the draft is one plain line. Anything
  // that needs the block's room (approvals, questions, plan follow-up, banners, attachment
  // chips) keeps the block layout.
  const composerSingleRow = useComposerSingleRow({
    formRef: composerFormRef,
    prompt,
    eligible:
      !isCenteredEmptyLanding &&
      !isComposerApprovalState &&
      pendingUserInputs.length === 0 &&
      !showPlanFollowUpPrompt &&
      !(pendingAutomationConversation && pendingAutomationConversation.threadId === threadId) &&
      !(serverThread?.snoozedUntil != null && serverThread.archivedAt == null) &&
      !isPreparingComposerImages &&
      composerAssistantSelections.length === 0 &&
      composerBrowserAnnotations.length === 0 &&
      composerFileComments.length === 0 &&
      composerPastedTexts.length === 0 &&
      composerPullRequestContexts.length === 0 &&
      composerFiles.length === 0 &&
      composerImages.length === 0,
  });

  useEffect(() => {
    // Capture the carried sidebar-open intent synchronously (ref reads/writes stay
    // in render->commit order); defer only the setState so this thread-change reset
    // stays out of the render->effect->render cascade.
    const openPlanSidebar = planSidebarOpenOnNextThreadRef.current;
    planSidebarOpenOnNextThreadRef.current = false;
    planSidebarDismissedForTurnRef.current = null;
    const settle = window.setTimeout(() => {
      setPullRequestDialogState(null);
      setRenameDialogOpen(false);

      setPlanSidebarOpen(openPlanSidebar);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [
    setPlanSidebarOpen,
    planSidebarDismissedForTurnRef,
    planSidebarOpenOnNextThreadRef,
    setPullRequestDialogState,
    setRenameDialogOpen,
    activeThread?.id,
  ]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [setComposerHighlightedItemId, composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setIsRevertingCheckpoint, activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen || isInactiveSplitPane) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, isInactiveSplitPane, terminalState.terminalOpen]);

  useLayoutEffect(() => {
    // ChatView stays mounted across thread switches, so clear thread-local overlays before paint.
    setExpandedImage(null);
    setWorktreeHandoffDialogOpen(false);
  }, [setExpandedImage, setWorktreeHandoffDialogOpen, threadId]);

  useEffect(() => {
    dragDepthRef.current = 0;
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade. The expanded image and timeline hook's
    // optimistic messages clear before paint, so these residual resets can wait.
    const settle = window.setTimeout(() => {
      setComposerHighlightedItemId(null);
      setComposerCursor(
        collapseExpandedComposerCursor(promptRef.current, promptRef.current.length),
      );
      setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
      setIsDragOverComposer(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    setIsDragOverComposer,
    setComposerHighlightedItemId,
    dragDepthRef,
    threadId,
  ]);

  useEffect(() => {
    if (!composerMenuOpen) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setComposerCommandPicker(null);
      setComposerHighlightedItemId(null);
      setComposerTrigger(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    setComposerTrigger,
    setComposerCommandPicker,
    setComposerHighlightedItemId,
    composerMenuOpen,
  ]);

  const activeWorktreePath = isGroupContainer ? null : activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = isGroupContainer
    ? "local"
    : isServerThread
      ? resolveThreadEnvironmentMode({
          envMode: activeThread?.envMode,
          worktreePath: activeWorktreePath ?? null,
        })
      : (draftThread?.envMode ?? "local");
  const envState = resolveThreadWorkspaceState({
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });

  // Every turn this view dispatches carries the same settings block. Assemble it
  // once here so each dispatch site spreads a projection of one object instead of
  // re-deriving the fields inline, and so the send callbacks depend on one value
  // instead of listing six that are easy to forget (see commit ca0e72f3e).
  const turnDispatchSettings = useMemo<TurnDispatchSettings>(
    () => ({
      modelSelection: selectedModelSelection,
      providerOptions: providerOptionsForDispatch,
      enableComputerControl,
      computerControlMode,
      computerControlGeneration,
      assistantDeliveryMode,
      runtimeMode,
      interactionMode,
      envMode,
    }),
    [
      assistantDeliveryMode,
      computerControlGeneration,
      computerControlMode,
      enableComputerControl,
      envMode,
      interactionMode,
      providerOptionsForDispatch,
      runtimeMode,
      selectedModelSelection,
    ],
  );

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      requestTerminalFocus();
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [
    terminalOpenByThreadRef,
    activeThreadId,
    focusComposer,
    requestTerminalFocus,
    terminalState.terminalOpen,
  ]);

  useEffect(() => {
    if (!activeThreadId) {
      activatedThreadIdRef.current = null;
      return;
    }
    if (activatedThreadIdRef.current === activeThreadId) {
      return;
    }
    activatedThreadIdRef.current = activeThreadId;
    if (terminalState.entryPoint !== "terminal") {
      return;
    }
    storeOpenTerminalThreadPage(activeThreadId);
  }, [activatedThreadIdRef, activeThreadId, storeOpenTerminalThreadPage, terminalState.entryPoint]);

  useEffect(() => {
    if (!terminalWorkspaceOpen) {
      return;
    }

    if (terminalState.workspaceActiveTab === "terminal") {
      requestTerminalFocus();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    focusComposer,
    requestTerminalFocus,
    terminalState.workspaceActiveTab,
    terminalWorkspaceOpen,
  ]);

  const onInterrupt = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread || isThreadDetailAwaitingVerification(activeThread.id)) return;
    // A user Stop pauses the waiting queue instead of sending it after the turn.
    const releaseQueueHold = holdQueuedComposerTurnsForStop(activeThread.id);
    await api.orchestration
      .dispatchCommand({
        type: "thread.turn.interrupt",
        requestedBy: "user",
        commandId: newCommandId(),
        threadId: activeThread.id,
        createdAt: new Date().toISOString(),
      })
      .catch((error: unknown) => {
        releaseQueueHold();
        throw error;
      });
  }, [activeThread]);

  // A rejected interrupt (orchestration dispatch timeout, dead runtime) leaves the
  // UI spinning with no explanation, so the stop affordances report it.
  const onInterruptFromStopControl = useCallback(() => {
    void onInterrupt().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not stop the current response",
        description:
          error instanceof Error
            ? error.message
            : "The interrupt request failed. Try again in a moment.",
      });
    });
  }, [onInterrupt]);

  // Background command rows offer Stop while their task runs. A rejected stop
  // leaves the row running, so the failure is reported instead of swallowed.
  const onStopBackgroundTask = useCallback(
    (taskId: string) => {
      const api = readNativeApi();
      if (!api || !activeThread || isThreadDetailAwaitingVerification(activeThread.id)) return;
      void api.orchestration
        .dispatchCommand({
          type: "thread.task.stop",
          commandId: newCommandId(),
          threadId: activeThread.id,
          taskId,
          createdAt: new Date().toISOString(),
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not stop the background task",
            description: error instanceof Error ? error.message : "Try again in a moment.",
          });
        });
    },
    [activeThread],
  );

  const onStopWorkflowRun = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !workflowRunState ||
      isThreadDetailAwaitingVerification(activeThread.id)
    )
      return;
    await api.orchestration.dispatchCommand({
      type: "thread.task.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      taskId: workflowRunState.workflowTaskId,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, workflowRunState]);

  const {
    backgroundSubagent: onBackgroundSubagentStripItem,
    stopSubagent: onStopSubagentStripItem,
  } = useSubagentRunControls(stripSourceThreadId);

  // Ctrl+B parity with the native CLI: send every foreground running subagent to
  // the background at once, fanning through the same per-row background dispatch.
  const onBackgroundAllForegroundSubagentStripItems = useCallback(async () => {
    const foreground = collectForegroundRunningSubagentStripItems(composerSubagentStripItems);
    await Promise.all(foreground.map((item) => onBackgroundSubagentStripItem(item)));
  }, [composerSubagentStripItems, onBackgroundSubagentStripItem]);
  // Pause is the same stop command; the persisted flag makes the settled card
  // read as paused (with a resume affordance) instead of plain stopped, across
  // reloads too.
  const onPauseWorkflowRun = useCallback(async () => {
    if (!workflowRunState || !activeThreadId || isThreadDetailAwaitingVerification(activeThreadId))
      return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunPaused(activeThreadId, workflowTaskId);
    await onStopWorkflowRun();
  }, [activeThreadId, markWorkflowRunPaused, onStopWorkflowRun, workflowRunState]);

  const onDismissWorkflowRun = useCallback(() => {
    if (!workflowRunState || !activeThreadId || isThreadDetailAwaitingVerification(activeThreadId))
      return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunDismissed(activeThreadId, workflowTaskId);
  }, [activeThreadId, markWorkflowRunDismissed, workflowRunState]);

  const onProviderModelSelect = useCallback(
    async (
      provider: ProviderKind,
      model: ModelSlug,
      selectionOptions?: ComposerModelSelectionOptions,
    ) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedInstanceId =
        selectionOptions?.instanceId ?? resolveDefaultProviderInstanceId(settings, provider);
      // Picking another provider is a handoff, but the bound provider stays on
      // its own account either way.
      const instanceLockedProvider = lockedProvider ?? boundProvider;
      const lockedInstanceId =
        instanceLockedProvider !== null && provider === instanceLockedProvider
          ? (activeThread.session?.providerInstanceId ??
            activeThread.modelSelection.instanceId ??
            // A thread that never stored an account runs in the one the composer shows.
            selectedProviderInstanceId)
          : undefined;
      if (lockedInstanceId && resolvedInstanceId !== lockedInstanceId) {
        scheduleComposerFocus();
        return;
      }
      const resolvedModel = resolveCommittedProviderModel({
        selectedModel: model,
        // Accounts of one provider can expose different catalogs.
        availableOptions:
          modelOptionsByProviderInstance[resolvedInstanceId] ?? modelOptionsByProvider[provider],
        fallback: () => resolveAppModelSelection(provider, customModelsByProvider, model),
      });
      const runtimeModel = resolveRuntimeModelDescriptor({
        provider,
        model: resolvedModel,
        // Accounts of one provider can advertise different capabilities.
        runtimeModels:
          runtimeModelsByProviderInstance[resolvedInstanceId] ?? runtimeModelsByProvider[provider],
      });
      const nextModelSelection = buildModelSelection(
        provider,
        resolvedModel,
        // A starred preset commits its provider options together with the model.
        selectionOptions?.modelOptions,
        provider === "claudeAgent" ? runtimeModel?.supportsAutoMode : undefined,
        { instanceId: resolvedInstanceId },
      );
      const providerStatus = findProviderStatus(providerStatuses, provider, resolvedInstanceId);
      const nextRuntimeMode =
        runtimeMode === "auto" &&
        !providerModelSupportsAutoRuntimeMode(provider, runtimeModel, providerStatus)
          ? "approval-required"
          : normalizeRuntimeModeForProvider(runtimeMode, provider);
      // Commit the canonical downgrade before storing an incompatible model.
      // On failure the Auto draft remains visible so compatibility checks can retry.
      const didCommitSelection = await commitAfterRuntimeModePersistence({
        currentRuntimeMode: runtimeMode,
        nextRuntimeMode,
        persistRuntimeMode: persistRuntimeModeChange,
        commit: () => {
          setComposerDraftModelSelectionAndSticky(activeThread.id, nextModelSelection);
          if (provider === "cursor" && !selectionOptions?.modelOptions) {
            setComposerDraftProviderModelOptions(
              activeThread.id,
              provider,
              undefined,
              buildCollapsedCursorModelOptionsReset({
                provider,
                instanceId: resolvedInstanceId,
                model: resolvedModel,
                showExpandedCursorModelVariants,
              }) ?? {
                persistSticky: true,
                model: resolvedModel,
                instanceId: resolvedInstanceId,
              },
            );
          }
        },
      });
      if (!didCommitSelection) {
        scheduleComposerFocus();
        return;
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      boundProvider,
      customModelsByProvider,
      lockedProvider,
      modelOptionsByProvider,
      modelOptionsByProviderInstance,
      persistRuntimeModeChange,
      providerStatuses,
      runtimeMode,
      runtimeModelsByProvider,
      runtimeModelsByProviderInstance,
      scheduleComposerFocus,
      selectedProviderInstanceId,
      settings,
      setComposerDraftModelSelectionAndSticky,
      setComposerDraftProviderModelOptions,
      showExpandedCursorModelVariants,
    ],
  );

  const onProviderInstanceSelect = useCallback(
    (instanceId: ProviderInstanceId) => {
      void onProviderModelSelect(selectedProvider, selectedModelForPickerWithCustomFallback, {
        instanceId,
      });
    },
    [onProviderModelSelect, selectedModelForPickerWithCustomFallback, selectedProvider],
  );
  const openProviderAccountSettings = useCallback(() => {
    void navigate({
      to: "/settings",
      search: {
        section: "providers",
        target: SETTINGS_TARGETS.providerInstalls,
        provider: selectedProvider,
      },
    });
  }, [navigate, selectedProvider]);

  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();

  const handleCycleEffort = useCallback(() => {
    if (!cycleEffort()) return false;
    setIsModelPickerOpen(false);
    setIsTraitsPickerOpen(false);
    return true;
  }, [cycleEffort]);

  // The open-thread strip owns closing (including its queue and last-tab fallback). The
  // Cmd/Ctrl+W shortcut reaches that exact path through this ref when the strip is mounted.
  const closeActiveThreadTabRef = useRef<(() => boolean) | null>(null);
  const onCloseActiveThreadTab = useStableCallback(() => {
    return closeActiveThreadTabRef.current?.() ?? false;
  });

  useChatKeyboardShortcuts({
    onToggleDevicePanel,
    onSplitSurface,
    surfaceMode,
    isFocusedPane,
    activeThreadId,
    hasLiveTurn,
    composerFormRef,
    onInterruptFromStopControl,
    composerSubagentStripItems,
    onBackgroundAllForegroundSubagentStripItems,
    isVoiceRecording,
    isVoiceTranscribing,
    onVoiceRecordingEnter: finishComposerVoiceRecordingFromEnter,
    isComposerApprovalState,
    terminalState,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    keybindings,
    toggleComposerFocus,
    shouldRenderChatPaneContent,
    setThreadFindOpen,
    setThreadFindFocusNonce,
    handleModelPickerOpenChange,
    scheduleComposerFocus,
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    selectedProvider,
    selectedProviderInstanceId,
    selectedModel,
    onProviderModelSelect,
    handleTraitsPickerOpenChange,
    cycleEffort: handleCycleEffort,
    toggleTerminalVisibility,
    setTerminalOpen,
    closeTerminal,
    createTerminalFromShortcut,
    openNewFullWidthTerminal,
    closeActiveWorkspaceView,
    setTerminalWorkspaceTab,
    onCloseActiveThreadTab,
    onToggleDiff,
    commitAndPushTriggerRef,
    showGitActions,
    isGitRepo,
    onToggleBrowser,
    copyThreadIdToClipboard,
    activeProject,
    runProjectScript,
    activeThread,
  });

  // Preserve the original "single mic button" contract:
  // first click starts recording, the next click submits/transcribes.
  const toggleComposerVoiceRecording = useCallback(() => {
    if (isVoiceTranscribing) {
      return;
    }
    if (isVoiceRecording) {
      void submitComposerVoiceRecording();
      return;
    }
    void startComposerVoiceRecording();
  }, [
    isVoiceRecording,
    isVoiceTranscribing,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
  ]);

  // --- Realtime voice --------------------------------------------------------
  const prepareRealtimeVoiceThread = useCallback(async () => {
    if (!isLocalDraftThread) return;
    const api = readNativeApi();
    if (!api || !activeProject || !activeThread) {
      throw new Error("Moss could not create the voice chat thread.");
    }
    const result = await promoteThreadCreate(
      {
        type: "thread.create",
        commandId: newCommandId(),
        threadId: activeThread.id,
        projectId: activeProject.id,
        title: t("chat.voice.newChatTitle"),
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
        envMode: activeThread.envMode ?? (activeThread.worktreePath ? "worktree" : "local"),
        branch: activeThread.branch ?? null,
        worktreePath: activeThread.worktreePath ?? null,
        workingDirectory: activeThread.workingDirectory ?? null,
        associatedWorktreePath: activeThreadAssociatedWorktree.associatedWorktreePath,
        associatedWorktreeBranch: activeThreadAssociatedWorktree.associatedWorktreeBranch,
        associatedWorktreeRef: activeThreadAssociatedWorktree.associatedWorktreeRef,
        lastKnownPr: activeThread.lastKnownPr ?? null,
        createdAt: activeThread.createdAt,
      },
      api,
      { force: true },
    );
    if (result === "unavailable") {
      throw new Error("Moss could not create the voice chat thread.");
    }
    const projectInstructions =
      useProjectInstructionsStore.getState().instructionsByProjectId[activeProject.id] ?? "";
    const inheritedNotes = mergeProjectInstructionsIntoThreadNotes({
      threadNotes,
      projectInstructions,
    });
    if (inheritedNotes !== threadNotes && inheritedNotes.trim().length > 0) {
      await dispatchThreadNotes(activeThread.id, inheritedNotes).catch(() => undefined);
    }
  }, [
    activeProject,
    activeThread,
    activeThreadAssociatedWorktree,
    interactionMode,
    isLocalDraftThread,
    runtimeMode,
    selectedModelSelection,
    t,
    threadNotes,
  ]);
  const focusRealtimeVoiceThread = useCallback(
    (voiceThreadId: ThreadId) =>
      navigate({ to: "/$threadId", params: { threadId: voiceThreadId } }),
    [navigate],
  );
  const realtimeVoiceSource = timelineEntries.length === 0 ? "composer-new" : "composer-existing";
  const realtimeVoice = useRealtimeVoiceController({
    threadId,
    source: realtimeVoiceSource,
    prepareThread: prepareRealtimeVoiceThread,
    focusThread: focusRealtimeVoiceThread,
    ownsDesktopSurface: presentationMode !== "quick-chat" && isFocusedPane,
    disabled:
      !activeProject ||
      isComposerApprovalState ||
      isConnecting ||
      isSendBusy ||
      isVoiceRecording ||
      isVoiceTranscribing ||
      pendingUserInputs.length > 0,
  });
  // Codex keeps Realtime Voice inside the owning thread's normal transcript shell.
  // An otherwise-empty thread therefore becomes a blank timeline plus the 208px
  // voice stage/composer; the new-thread hero must not return if that same call
  // is detached to the global overlay and later handed back.
  const isCenteredEmptyLandingVisible = isCenteredEmptyLanding && !realtimeVoice.isVisible;
  // Keep a stable state marker on the shell so visual parity checks can distinguish
  // intentional empty/voice variants from active-thread geometry without inspecting
  // provider or transcript internals.
  const chatShellState = realtimeVoice.isMainThreadPresentationVisible
    ? "voice"
    : isCenteredEmptyLandingVisible
      ? isEmptyChatLanding
        ? "home-empty"
        : "project-empty"
      : "active-thread";
  useLayoutEffect(() => {
    useChatShellStateStore.getState().setShellState(chatShellState);
  }, [chatShellState]);
  const [realtimeVoiceOnboardingOpen, setRealtimeVoiceOnboardingOpen] = useState(false);
  const [realtimeVoiceOnboardingPendingCompletion, setRealtimeVoiceOnboardingPendingCompletion] =
    useState(false);
  const realtimeVoiceOnboardingLaunchObservedRef = useRef(false);
  const writePendingRealtimeVoiceLaunch = useCallback(
    (value: PendingRealtimeVoiceLaunchAction | null) => {
      try {
        if (value === null) {
          const pending = decodePendingRealtimeVoiceLaunch(
            window.sessionStorage.getItem(REALTIME_VOICE_PENDING_LAUNCH_KEY),
            threadId,
          );
          if (pending) window.sessionStorage.removeItem(REALTIME_VOICE_PENDING_LAUNCH_KEY);
          return;
        }
        window.sessionStorage.setItem(
          REALTIME_VOICE_PENDING_LAUNCH_KEY,
          encodePendingRealtimeVoiceLaunch({ action: value, threadId }),
        );
      } catch {
        // Best-effort only; launch failures still surface through the active thread.
      }
    },
    [threadId],
  );
  const readPendingRealtimeVoiceLaunch =
    useCallback((): PendingRealtimeVoiceLaunchAction | null => {
      try {
        return decodePendingRealtimeVoiceLaunch(
          window.sessionStorage.getItem(REALTIME_VOICE_PENDING_LAUNCH_KEY),
          threadId,
        );
      } catch {
        return null;
      }
    }, [threadId]);
  const pendingRealtimeVoiceLaunchAttemptRef = useRef<PendingRealtimeVoiceLaunchAction | null>(
    null,
  );
  // Ref indirection keeps this callback's dependency list to stable identities the
  // React Compiler can preserve (`realtimeVoice.start` is a fresh member access it
  // cannot match); the ref always points at the latest controller start.
  const realtimeVoiceStartRef = useRef(realtimeVoice.start);
  useLayoutEffect(() => {
    realtimeVoiceStartRef.current = realtimeVoice.start;
  }, [realtimeVoice.start]);
  const startPendingRealtimeVoiceLaunch = useCallback(
    async (pendingLaunch: PendingRealtimeVoiceLaunchAction): Promise<boolean> => {
      if (pendingRealtimeVoiceLaunchAttemptRef.current !== null) {
        return false;
      }
      pendingRealtimeVoiceLaunchAttemptRef.current = pendingLaunch;
      return Promise.resolve()
        .then(() => realtimeVoiceStartRef.current())
        .then((accepted) => {
          if (accepted && readPendingRealtimeVoiceLaunch() === pendingLaunch) {
            writePendingRealtimeVoiceLaunch(null);
          }
          return accepted;
        })
        .finally(() => {
          if (pendingRealtimeVoiceLaunchAttemptRef.current === pendingLaunch) {
            pendingRealtimeVoiceLaunchAttemptRef.current = null;
          }
        });
    },
    [readPendingRealtimeVoiceLaunch, writePendingRealtimeVoiceLaunch],
  );
  // Plain function, not useCallback: only JSX handlers call it, and a hand-written
  // dependency list here is one the React Compiler cannot preserve (it would bail
  // the whole hot component out of auto-memoization).
  const requestRealtimeVoiceStart = () => {
    const request = resolveRealtimeVoiceLaunchRequest({
      hasCompletedOnboarding: hasCompletedRealtimeVoiceOnboarding(),
      isLocalDraftThread,
    });
    if (request === "open-onboarding") {
      writePendingRealtimeVoiceLaunch("onboarding");
      setRealtimeVoiceOnboardingOpen(true);
      return;
    }
    if (request === "start") {
      writePendingRealtimeVoiceLaunch("start");
      void startPendingRealtimeVoiceLaunch("start");
      return;
    }
    writePendingRealtimeVoiceLaunch(request === "prepare-then-onboarding" ? "onboarding" : "start");
    void prepareRealtimeVoiceThread().catch(() => {
      if (request === "prepare-then-onboarding") {
        setRealtimeVoiceOnboardingOpen(true);
        return;
      }
      void startPendingRealtimeVoiceLaunch("start");
    });
  };
  // A launch requested on a local draft (or queued behind onboarding) survives the
  // draft-promotion remount through sessionStorage; once the thread is a server thread
  // again, this effect consumes the pending action exactly once.
  useEffect(() => {
    if (isLocalDraftThread) {
      return;
    }
    const pendingLaunch = readPendingRealtimeVoiceLaunch();
    if (!pendingLaunch) {
      pendingRealtimeVoiceLaunchAttemptRef.current = null;
      return;
    }
    if (pendingLaunch === "onboarding" && !hasCompletedRealtimeVoiceOnboarding()) {
      setRealtimeVoiceOnboardingOpen(true);
      return;
    }
    if (pendingRealtimeVoiceLaunchAttemptRef.current === pendingLaunch) {
      return;
    }
    void startPendingRealtimeVoiceLaunch(pendingLaunch);
  }, [isLocalDraftThread, readPendingRealtimeVoiceLaunch, startPendingRealtimeVoiceLaunch]);
  useEffect(() => {
    if (!realtimeVoiceOnboardingPendingCompletion) {
      realtimeVoiceOnboardingLaunchObservedRef.current = false;
      return;
    }
    if (
      realtimeVoice.state.phase !== "inactive" ||
      realtimeVoice.isLaunchOverlayVisible ||
      realtimeVoice.isLaunchConnected
    ) {
      realtimeVoiceOnboardingLaunchObservedRef.current = true;
    }
    const disposition = resolveRealtimeVoiceOnboardingLaunchDisposition({
      pendingCompletion: realtimeVoiceOnboardingPendingCompletion,
      launchObserved: realtimeVoiceOnboardingLaunchObservedRef.current,
      phase: realtimeVoice.state.phase,
      launchOverlayVisible: realtimeVoice.isLaunchOverlayVisible,
      launchConnected: realtimeVoice.isLaunchConnected,
    });
    if (disposition === "persist") {
      persistRealtimeVoiceOnboardingCompletion();
      setRealtimeVoiceOnboardingPendingCompletion(false);
      return;
    }
    if (disposition === "clear") {
      setRealtimeVoiceOnboardingPendingCompletion(false);
    }
  }, [
    realtimeVoice.isLaunchConnected,
    realtimeVoice.isLaunchOverlayVisible,
    realtimeVoice.state.phase,
    realtimeVoiceOnboardingPendingCompletion,
  ]);
  const isRealtimeVoiceModalVisible = realtimeVoice.isLaunchOverlayVisible;
  const isRealtimeVoiceCurrentThreadActive = shouldUseRealtimeVoiceOwningComposerControls({
    isCurrentThread: realtimeVoice.isCurrentThread,
    phase: realtimeVoice.state.phase,
  });
  const isRealtimeVoiceActiveInAnotherThread =
    !realtimeVoice.isCurrentThread &&
    realtimeVoice.state.threadId !== null &&
    realtimeVoice.state.phase !== "inactive" &&
    realtimeVoice.state.phase !== "failed";

  // --- Composer attachment entry points -------------------------------------
  const addComposerImages = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0 || isSidechatExpired) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach images after answering plan questions.",
        });
        return;
      }

      enqueueComposerImages(files);
    },
    [activeThreadId, enqueueComposerImages, isSidechatExpired, pendingUserInputs.length],
  );

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const addComposerFiles = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0 || isSidechatExpired) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach files after answering plan questions.",
        });
        return;
      }

      const { files: nextFiles, error } = buildComposerFileAttachmentsFromFiles({
        files,
        existingAttachmentCount: effectiveComposerAttachmentCount(
          useComposerDraftStore.getState().draftsByThreadId[activeThreadId],
        ),
      });

      const insertedCount = nextFiles.length > 0 ? addComposerFilesToDraft(nextFiles) : 0;
      setThreadError(
        activeThreadId,
        insertedCount < nextFiles.length
          ? `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`
          : error,
      );
    },
    [
      activeThreadId,
      addComposerFilesToDraft,
      isSidechatExpired,
      pendingUserInputs.length,
      setThreadError,
    ],
  );

  const addComposerAttachments = useCallback(
    (files: readonly File[]) => {
      const { imageFiles, genericFiles } = splitComposerDropzoneFiles(files);
      if (imageFiles.length > 0) {
        addComposerImages(imageFiles);
      }
      if (genericFiles.length > 0) {
        addComposerFiles(genericFiles);
      }
    },
    [addComposerFiles, addComposerImages],
  );

  const removeComposerFile = (fileId: string) => {
    discardPromptHistoryNavigationForComposerMutation();
    removeComposerDraftFile(threadId, fileId);
  };

  const {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  } = useComposerDropzone({
    disabled: isSidechatExpired,
    addImages: addComposerImages,
    fileSupport: {
      genericFiles: "accept",
      addFiles: addComposerFiles,
    },
    appendReferenceText: (referenceText) => appendComposerPromptText(threadId, referenceText),
    appendPathMentions: (paths) => {
      for (const absolutePath of paths) {
        appendComposerPromptText(threadId, formatComposerMentionToken(absolutePath));
      }
    },
    dragDepthRef,
    focusComposer,
    setIsDragOverComposer,
  });

  // Dropping a sidebar/activity chat row on the composer references it exactly
  // like picking it from the `@` menu: token in the prompt + mention binding.
  const { isThreadDragOverComposer, threadMentionDropzoneProps } = useComposerThreadMentionDrop({
    disabled: isSidechatExpired,
    currentThreadId: threadId,
    onDropThread: (droppedThreadId) => {
      const mention = resolveThreadMentionForThreadId({
        threads: composerThreadSummaries,
        projects: composerThreadProjects,
        currentThreadId: threadId,
        threadId: droppedThreadId,
      });
      if (!mention) {
        toastManager.add({
          type: "error",
          title: "Could not reference this chat",
          description: "This chat is unavailable or cannot be mentioned here.",
        });
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      appendComposerPromptText(threadId, formatComposerMentionToken(mention.name));
      updateSelectedComposerMentions((existing) => [
        ...existing.filter((existingMention) => existingMention.name !== mention.name),
        mention,
      ]);
    },
  });

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          format("chat.checkpointRevert.title", { turnCount }),
          t("chat.checkpointRevert.description"),
          t("chat.checkpointRevert.irreversible"),
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          scope: "thread",
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      setIsRevertingCheckpoint,
      activeThread,
      hasLiveTurn,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      setThreadError,
      format,
      t,
    ],
  );

  const onUndoTurnFiles = useCallback(
    async (turnCounts: readonly number[]) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint || turnCounts.length === 0) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before undoing file changes.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          t("chat.fileUndo.title"),
          t("chat.fileUndo.earlierChanges"),
          t("chat.fileUndo.messagesKept"),
          t("chat.checkpointRevert.irreversible"),
        ].join("\n"),
      );
      if (!confirmed) return;

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      // The card can merge several turns. The server refuses to undo a turn while
      // newer file changes are still applied, so revert newest-first and stop at
      // the first failure rather than leaving the card half-undone silently.
      const orderedTurnCounts = [...new Set(turnCounts)].toSorted((left, right) => right - left);
      const requestedAt = new Date().toISOString();
      setPendingFileUndo({
        threadId: activeThread.id,
        turnCounts: orderedTurnCounts,
        existingFailureActivityIds: activeThread.activities
          .filter((activity) => activity.kind === "checkpoint.revert.failed")
          .map((activity) => activity.id),
      });
      const dispatchReverts = async () => {
        for (const turnCount of orderedTurnCounts) {
          await api.orchestration.dispatchCommand({
            type: "thread.checkpoint.revert",
            commandId: newCommandId(),
            threadId: activeThread.id,
            turnCount,
            scope: "files",
            createdAt: requestedAt,
          });
        }
      };
      await dispatchReverts().catch((err: unknown) => {
        setPendingFileUndo(null);
        setIsRevertingCheckpoint(false);
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to undo file changes.",
        );
      });
    },
    [
      setIsRevertingCheckpoint,
      setPendingFileUndo,
      activeThread,
      hasLiveTurn,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      setThreadError,
      t,
    ],
  );

  // Stable: it reads the whole thread, which changes with every streamed token.
  const onCreateHandoffThread = useStableCallback(async (target: ThreadHandoffTarget) => {
    if (!activeThread || handoffDisabled) {
      return;
    }

    try {
      await createThreadHandoff(activeThread, target.provider, target.instanceId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create handoff thread",
        description:
          error instanceof Error
            ? error.message
            : "An error occurred while creating the handoff thread.",
      });
    }
  });

  const onContinueHandoffInThread = useStableCallback(async (target: ThreadHandoffTarget) => {
    if (!activeThread || handoffDisabled) {
      return;
    }

    try {
      await continueThreadHandoff(activeThread, target.provider, target.instanceId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not hand off this thread",
        description:
          error instanceof Error
            ? error.message
            : "An error occurred while handing off the thread.",
      });
    }
  });

  const clearComposerInput = useCallback(
    (threadId: ThreadId) => {
      promptHistoryNavigationRef.current = null;
      applyingPromptHistoryNavigationRef.current = false;
      expectedPromptHistoryPromptRef.current = null;
      promptRef.current = "";
      setRestoredQueuedSourceProposedPlan(threadId, null);
      clearComposerDraftContent(threadId);
      updateSelectedComposerSkills([]);
      updateSelectedComposerMentions([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      promptHistoryNavigationRef,
      applyingPromptHistoryNavigationRef,
      expectedPromptHistoryPromptRef,
      setComposerHighlightedItemId,
      clearComposerDraftContent,
      setRestoredQueuedSourceProposedPlan,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const {
    createAutomationFromForm,
    prepareAutomationFormForCreate,
    submitAutomationDraft,
    automationCreationPending,
    automationCreationPendingOpen,
    setAutomationCreationPendingOpen,
    automationCreationError,
    retryAutomationCreation,
  } = useChatAutomationCreation({
    threadId,
    activeProject,
    automationDraftSubmittingRef,
    isServerThread,
    activeThread,
    providerOptionsForDispatch,
    setIsAutomationDraftSubmitting,
    queryClient,
    clearComposerInput,
    resetAutomationDraftState,
    activeThreadAssociatedWorktree,
    threadNotes,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    automationDraftForm,
    automationDraftWarnings,
    acknowledgedAutomationWarnings,
  });

  const lateComposerSendHandlersRef = useRef<LateComposerSendHandlers | null>(null);
  const {
    setQueuedSteerGate,
    removeQueuedComposerTurn,
    onSteerQueuedComposerTurn,
    onEditQueuedComposerTurn,
    queuePause,
    onResumeQueuedComposerTurns,
    onEditPausedQueuedComposerTurn,
  } = useChatQueuedTurns({
    threadId,
    queuedComposerTurns,
    activeThread,
    promptRef,
    clearComposerDraftContent,
    setComposerDraftPrompt,
    setDraftThreadContext,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    addComposerAssistantSelectionToDraft,
    addComposerDraftBrowserAnnotations,
    addComposerFileCommentToDraft,
    addComposerTerminalContextsToDraft,
    addComposerPastedTextsToDraft,
    addComposerPullRequestContextsToDraft,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
    setRestoredQueuedSourceProposedPlan,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    setComposerDraftComputerControlMode,
    setComposerDraftComputerControl,
    setComposerCursor,
    setComposerTrigger,
    scheduleComposerFocus,
    removeQueuedComposerTurnFromDraft,
    lateComposerSendHandlersRef,
    insertQueuedComposerTurn,
    phase,
    localDispatch,
    isLocalDraftThread,
    activeLatestTurn,
    isConnecting,
    activePendingApproval,
    activePendingProgress,
    pendingUserInputs,
    hasPendingCacheReview: activeThread?.claudeCacheReview != null,
    sendInFlightRef,
    sendPreflightInFlightRef,
  });
  const hasQueuedComposerTurns = queuedComposerTurns.length > 0;
  const activeSessionForQueuedSteer = activeThread?.session;
  const activeActivitiesForQueuedSteer = activeThread?.activities;
  const activeCacheReviewForQueuedSteer = activeThread?.claudeCacheReview;
  // Only the queued rows read this; skip the activity scan while nothing is queued.
  const queuedSteerSkipsCompaction = useMemo(
    () =>
      hasQueuedComposerTurns &&
      steerSkipsLiveCompaction({
        session: activeSessionForQueuedSteer ?? null,
        activities: activeActivitiesForQueuedSteer ?? [],
        claudeCacheReview: activeCacheReviewForQueuedSteer ?? null,
      }),
    [
      activeActivitiesForQueuedSteer,
      activeCacheReviewForQueuedSteer,
      activeSessionForQueuedSteer,
      hasQueuedComposerTurns,
    ],
  );

  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const mossQuotaManagedSelection = isServerConfiguredMossDefaultManagedProvider(
    serverSettingsQuery.data,
    selectedModelSelection.instanceId,
  );
  const mossQuotaPhoneLoginCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossPhoneLogin(),
  });
  const mossQuotaPhoneLogoutCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossLogout(),
  });
  const mossQuotaCloudAccountSwitchCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossCloudSelect(),
  });
  const mossQuotaCloudLogoutCount = useIsMutating({
    mutationKey: mossServerMutationKeys.mossCloudLogout(),
  });
  const mossQuotaAccountTransitionPending = isMossPayAccountTransitionPending({
    phoneLoginCount: mossQuotaPhoneLoginCount,
    phoneLogoutCount: mossQuotaPhoneLogoutCount,
    cloudAccountSwitchCount: mossQuotaCloudAccountSwitchCount,
    cloudLogoutCount: mossQuotaCloudLogoutCount,
  });
  const mossQuotaPhoneAccountQuery = useQuery(
    serverMossAccountSessionQueryOptions({ enabled: mossQuotaManagedSelection }),
  );
  const mossQuotaCloudAccountQuery = useQuery(
    serverMossCloudAccountStateQueryOptions({ enabled: mossQuotaManagedSelection }),
  );
  const mossQuotaAccountIdentity = useMemo(
    () =>
      resolveMossPayQuotaAccountIdentity(
        mossQuotaPhoneAccountQuery.data,
        mossQuotaCloudAccountQuery.data,
        mossQuotaAccountTransitionPending,
      ),
    [
      mossQuotaAccountTransitionPending,
      mossQuotaCloudAccountQuery.data,
      mossQuotaPhoneAccountQuery.data,
    ],
  );
  const mossQuotaQuery = useQuery(
    serverMossPayQuotaQueryOptions({
      enabled: mossQuotaManagedSelection && mossQuotaAccountIdentity !== null,
      accountIdentity: mossQuotaAccountIdentity,
    }),
  );
  const mossQuotaAdmission = useMemo(
    () =>
      evaluateMossQuotaAdmission({
        instanceId: selectedModelSelection.instanceId,
        driver: selectedProvider,
        managed: mossQuotaManagedSelection,
        quota: mossQuotaQuery.data,
        quotaFetchedAt: mossQuotaQuery.data ? mossQuotaQuery.dataUpdatedAt : null,
        accountIdentity: mossQuotaAccountIdentity,
        proofAccountIdentity: mossQuotaAccountIdentity,
      }),
    [
      mossQuotaAccountIdentity,
      mossQuotaManagedSelection,
      mossQuotaQuery.data,
      mossQuotaQuery.dataUpdatedAt,
      selectedModelSelection.instanceId,
      selectedProvider,
    ],
  );
  const gatewayQuotaDecision = resolveGatewayMossQuotaDecision({
    managed: mossQuotaManagedSelection,
    error: activeThread?.error,
    quota: mossQuotaQuery.data,
  });
  const visibleMossQuotaDecision =
    mossQuotaAdmission.kind === "exhausted" ? mossQuotaAdmission : gatewayQuotaDecision;
  const visibleMossQuotaDecisionKey = visibleMossQuotaDecision
    ? `${activeThread?.id ?? "none"}:${visibleMossQuotaDecision.usageBasis}:${visibleMossQuotaDecision.usagePeriod}:${visibleMossQuotaDecision.resetAt ?? "none"}`
    : null;
  const quotaOwnedActiveThreadError = resolveQuotaOwnedThreadError(
    activeThread?.error,
    visibleMossQuotaDecision !== null,
  );
  const previousMossQuotaAccountIdentityRef = useRef<string | null>(null);
  const mossQuotaAccountIdentityRef = useRef<string | null>(mossQuotaAccountIdentity);
  const mossQuotaAccountTransitionPendingRef = useRef(mossQuotaAccountTransitionPending);
  useEffect(() => {
    const previousIdentity = previousMossQuotaAccountIdentityRef.current;
    if (previousIdentity !== null && previousIdentity !== mossQuotaAccountIdentity) {
      queryClient.removeQueries({
        queryKey: mossServerQueryKeys.mossPayQuota(previousIdentity),
        exact: true,
      });
    }
    previousMossQuotaAccountIdentityRef.current = mossQuotaAccountIdentity;
    mossQuotaAccountIdentityRef.current = mossQuotaAccountIdentity;
    mossQuotaAccountTransitionPendingRef.current = mossQuotaAccountTransitionPending;
  }, [mossQuotaAccountIdentity, mossQuotaAccountTransitionPending, queryClient]);
  const imageGenerationLimitBannerVisible = shouldShowImageGenerationLimitBanner({
    hasImageGenerationLimit: imageGenerationLimitFailure !== null,
    showMossQuotaExhausted: visibleMossQuotaDecision !== null,
    hardRateLimit: activeRateLimitStatus?.status === "rejected",
    providerHealthUnavailable: isProviderDurablyUnavailable(activeProviderStatus),
  });
  const imageGenerationLimitFailureIdentity = imageGenerationLimitFailure?.failureIdentity ?? null;
  const imageGenerationLimitResetsAt = imageGenerationLimitFailure?.resetsAt ?? null;
  useEffect(() => {
    if (!imageGenerationLimitBannerVisible || imageGenerationLimitFailureIdentity === null) {
      return;
    }
    const delayMs = getImageGenerationLimitResetDelayMs(imageGenerationLimitResetsAt, Date.now());
    if (delayMs === null) return;
    const timeoutId = window.setTimeout(() => {
      setImageGenerationLimitClock(Date.now());
    }, delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [
    imageGenerationLimitBannerVisible,
    imageGenerationLimitClock,
    imageGenerationLimitFailureIdentity,
    imageGenerationLimitResetsAt,
  ]);
  const imageGenerationLimitUsageQuery = useQuery(
    serverProviderUsageSnapshotQueryOptions({
      provider: selectedProvider,
      providerInstanceId: selectedProviderInstanceId,
      enabled:
        imageGenerationLimitBannerVisible &&
        imageGenerationLimitSourceKind === "personal" &&
        selectedProvider === "codex",
    }),
  );
  const imageGenerationLimitPresentation = imageGenerationLimitSourceKind
    ? resolveImageGenerationLimitPresentation({
        sourceKind: imageGenerationLimitSourceKind,
        planName: imageGenerationLimitUsageQuery.data?.planName,
      })
    : null;
  const dismissImageGenerationLimitBanner = useCallback(() => {
    const failure = imageGenerationLimitFailure;
    if (failure) {
      setDismissedImageGenerationLimitIdentityByProvider((previous) => {
        if (previous[failure.providerInstanceId] === failure.failureIdentity) return previous;
        return { ...previous, [failure.providerInstanceId]: failure.failureIdentity };
      });
    }
  }, [imageGenerationLimitFailure]);
  // No manual useCallback here: the compiler could not match
  // `imageGenerationLimitBannerVisible`'s inferred scope to the hand-written dep
  // list (PreserveManualMemo bailout), which cost the whole component its
  // memoization. A plain closure lets the compiler own the memoization.
  const openImageGenerationLimitAction = () => {
    const failure = imageGenerationLimitFailure;
    const presentation = imageGenerationLimitPresentation;
    if (!failure || !presentation || !imageGenerationLimitBannerVisible) return;
    setDismissedImageGenerationLimitIdentityByProvider((previous) => {
      if (previous[failure.providerInstanceId] === failure.failureIdentity) return previous;
      return { ...previous, [failure.providerInstanceId]: failure.failureIdentity };
    });
    if (presentation.action === "personal-usage") {
      openExternalLink(PERSONAL_IMAGE_USAGE_URL);
    } else if (presentation.action === "managed-usage") {
      void navigate({ to: "/settings", search: { section: "usage" } });
    }
  };
  const visibleActiveRateLimitStatusForRender =
    imageGenerationLimitBannerVisible && visibleActiveRateLimitStatus?.status === "allowed_warning"
      ? null
      : visibleActiveRateLimitStatus;
  // A provider picked in the composer over the thread's own one hands the
  // thread off in place before the message is sent (same path as "Continue in
  // this thread"). The send refuses up front while the thread is busy; once the
  // message shows, a failed handoff rolls the send back into the composer.
  const canSendWithProviderHandoff = useStableCallback(
    (modelSelection?: ModelSelection): boolean => {
      const targetProvider = modelSelection?.provider ?? selectedProvider;
      if (
        !activeThread ||
        boundProvider === null ||
        targetProvider === boundProvider ||
        !handoffDisabled
      ) {
        return true;
      }
      const targetName = PROVIDER_DISPLAY_NAMES[targetProvider] ?? targetProvider;
      toastManager.add({
        type: "error",
        title: `Cannot switch to ${targetName} yet`,
        description:
          "Wait for the current turn to finish and answer any pending request, then send again.",
      });
      return false;
    },
  );
  const prepareProviderHandoffForSend = useStableCallback(
    async (threadForSend: Thread, selectionForSend: ModelSelection): Promise<void> => {
      // A send owns the thread and model captured before attachment/setup waits.
      // Later picker changes or navigation belong to the next send.
      await continueThreadHandoff(
        threadForSend,
        selectionForSend.provider,
        selectionForSend.instanceId,
        selectionForSend,
      );
    },
  );
  const { onSend: submitComposerTurn } = useChatTurnSubmission({
    threadId,
    hasLiveTurn,
    canSendWithProviderHandoff,
    prepareProviderHandoffForSend,
    lateComposerSendHandlersRef,
    activeThread,
    isConnecting,
    sendPreflightInFlightRef,
    sendInFlightRef,
    turnDispatchSettings,
    computerControlChangeSequence,
    setComposerDraftComputerControlMode,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    hasQueueableLiveTurn,
    clearComposerInput,
    scheduleComposerFocus,
    activeProject,
    threadWorkspaceCwd,
    refreshProviderStatuses,
    isServerThread,
    hasNativeUserMessages,
    chatWorkspaceRoot,
    isHomeChatContainer,
    isGroupContainer,
    resolvedThreadWorktreePath,
    resolvedThreadWorkingDirectory,
    currentActiveGitBranch,
    isContainerLandingProject,
    syncServerShellSnapshot,
    activeRootBranch,
    gitBranchSourceCwd,
    setStoreThreadError,
    queryClient,
    isCenteredEmptyLanding,
    setEnvironmentPanelPreferenceOpen,
    environmentPanelPreferenceOpen,
    setTailAnchor,
    setThreadError,
    setComposerHighlightedItemId,
    setStoreThreadWorkspace,
    createWorktreeMutation,
    isLocalDraftThread,
    threadNotes,
    setSettledThreadBranchWarningDismissedThreadId,
    setQueuedSteerGate,
    planSidebarDismissedForTurnRef,
    setPlanSidebarOpen,
    settings,
    isSendBusy,
    worktreeSetupResolutionRef,
    setWorktreeSetupPendingAction,
    beginLocalDispatch,
    clearLocalDispatchWorktreeSetup,
    armLocalDispatchAckFallback,
    failLocalDispatchWorktreeSetup,
    scheduleFailedWorktreeSetupDispatchReset,
    resetLocalDispatch,
    isVoiceTranscribing,
    waitForPendingComposerImages,
    activePendingProgress,
    activePendingUserInputKey,
    pendingUserInputAnswersByRequestIdRef,
    setPendingUserInputAnswersByRequestId,
    composerEditorRef,
    promptRef,
    composerImages,
    composerFiles,
    composerAssistantSelections,
    composerBrowserAnnotations,
    composerFileComments,
    composerTerminalContexts,
    composerPastedTexts,
    composerPullRequestContexts,
    restoredQueuedSourceProposedPlanRef,
    enqueueQueuedComposerTurn,
    setComposerDraftPrompt,
    setComposerTrigger,
    clearProjectDraftThreadId,
    setDraftThreadContext,
    promptHistoryNavigationRef,
    applyingPromptHistoryNavigationRef,
    expectedPromptHistoryPromptRef,
    clearComposerDraftContent,
    setComposerDraftInteractionMode,
    setComposerCursor,
    setRestoredQueuedSourceProposedPlan,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    composerBrowserAnnotationsRef,
    composerFileCommentsRef,
    composerTerminalContextsRef,
    composerPastedTextsRef,
    composerPullRequestContextsRef,
    setPrompt,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    addComposerAssistantSelectionToDraft,
    addComposerDraftBrowserAnnotations,
    addComposerFileCommentToDraft,
    addComposerTerminalContextsToDraft,
    addComposerPastedTextsToDraft,
    addComposerPullRequestContextsToDraft,
    selectedComposerSkillsRef,
    selectedComposerMentionsRef,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
    selectedProvider,
    selectedModel,
    selectedPromptEffort,
    pendingAutomationConversationRef,
    setPendingAutomationConversation,
    pendingAutomationConversation,
    activeThreadIdRef,
    hasLiveTurnRef,
    automationProjects,
    setAutomationDraftWarningContext,
    setAutomationDraftForm,
    setAutomationDraftWarnings,
    setAcknowledgedAutomationWarnings,
    setAutomationDraftOpen,
    armTranscriptAutoFollow,
    tailAnchorScrollInFlightRef,
    prepareAutomationFormForCreate,
    createAutomationFromForm,
    providerStatuses,
    isPreparingWorktree,
    serverSettings: serverSettingsQuery.data,
    mossQuotaAccountIdentity,
    mossQuotaAccountIdentityRef,
    mossQuotaAccountTransitionPendingRef,
    rememberCustomBinaryPathForDispatch,
    setOptimisticUserMessages,
    runProjectScript,
    persistThreadSettingsForNextTurn,
  });

  const {
    onSubmitPlanFollowUp,
    onContinueFailedTurn,
    onRetryStartFailure,
    onEditUserMessage,
    onResumeWorkflowRun,
    onImplementPlanInNewThread,
  } = useChatTurnFollowUps({
    threadId,
    activeThread,
    isServerThread,
    isConnecting,
    sendInFlightRef,
    setThreadError,
    setTailAnchor,
    anchorSentMessagesToTop: settings.anchorSentMessagesToTop,
    turnDispatchSettings,
    computerControlChangeSequence,
    setComposerDraftComputerControlMode,
    activeProposedPlan,
    setQueuedSteerGate,
    planSidebarDismissedForTurnRef,
    setPlanSidebarOpen,
    isRevertingCheckpoint,
    setIsRevertingCheckpoint,
    isSendBusy,
    beginLocalDispatch,
    armLocalDispatchAckFallback,
    resetLocalDispatch,
    selectedProvider,
    selectedModel,
    selectedPromptEffort,
    setOptimisticUserMessages,
    armTranscriptAutoFollow,
    tailAnchorScrollInFlightRef,
    persistThreadSettingsForNextTurn,
    canSendWithProviderHandoff,
    prepareProviderHandoffForSend,
    setComposerDraftInteractionMode,
    rememberCustomBinaryPathForDispatch,
    workflowRunState,
    lateComposerSendHandlersRef,
    activeThreadId,
    markWorkflowRunDismissed,
    activeProject,
    activeThreadAssociatedWorktree,
    syncServerShellSnapshot,
    planSidebarOpenOnNextThreadRef,
    navigate,
  });

  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = promptRef.current;
      if (nextPrompt === currentPrompt) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [promptRef, setComposerCursor, setComposerTrigger, scheduleComposerFocus, setPrompt],
  );
  const selectedProviderModelOptions = composerModelOptions?.[selectedProvider];
  const composerTraitSelection = getComposerTraitSelection(
    selectedProvider,
    selectedModel,
    prompt,
    selectedProviderModelOptions,
    selectedRuntimeModel,
  );
  const runtimeUsageContextWindow = activeContextWindow;
  const claudeSwitchKey =
    (activeThread?.messages.length ?? 0) > 0 &&
    boundProvider === "claudeAgent" &&
    activeThread?.modelSelection.provider === "claudeAgent" &&
    (selectedProvider !== "claudeAgent" ||
      resolveApiModelId(selectedModelSelection) !== resolveApiModelId(activeThread.modelSelection))
      ? JSON.stringify([
          threadId,
          resolveApiModelId(activeThread.modelSelection),
          selectedProvider,
          selectedModelSelection.instanceId,
          resolveApiModelId(selectedModelSelection),
        ])
      : null;
  // Dismiss only this pending choice. Returning to the current selection or completing
  // the switch ends the tip's lifetime; a later selection can show it again.
  useEffect(() => {
    if (claudeSwitchKey === null) {
      setDismissedClaudeSwitchKey(null);
      setSubmittedClaudeSwitchKey(null);
    }
  }, [claudeSwitchKey]);
  const onSend = useCallback(
    async (...args: Parameters<typeof submitComposerTurn>) => {
      args[0]?.preventDefault();
      if (args[2] === undefined) {
        const imageHost = getConversationImageComposer(threadId);
        if (imageHost && !(await imageHost.beforeSend())) return false;
      }
      // Keep the choice captured for this send: later picker changes belong to the
      // next message. Automatic queue drains must not acknowledge a new draft choice.
      const switchKeyForSend = claudeSwitchKey;
      if (activeLatestTurnId !== null) {
        modelPredictionAbortRef.current?.abort();
        modelPredictionAbortRef.current = null;
        dismissedPredictionTurnIdRef.current = activeLatestTurnId;
        setModelComposerPrediction(null);
        if (import.meta.env.DEV) {
          console.debug("[prediction] ignored", { turnId: activeLatestTurnId });
        }
      }
      const accepted = await submitComposerTurn(...args);
      if (accepted && switchKeyForSend !== null && args[2] === undefined) {
        setSubmittedClaudeSwitchKey(switchKeyForSend);
      }
      return accepted;
    },
    [activeLatestTurnId, claudeSwitchKey, submitComposerTurn, threadId],
  );
  const showClaudeModelSwitchNote =
    claudeSwitchKey !== null &&
    claudeSwitchKey !== dismissedClaudeSwitchKey &&
    claudeSwitchKey !== submittedClaudeSwitchKey &&
    !isSendBusy &&
    !isConnecting &&
    !isRevertingCheckpoint &&
    !isAwaitingTurnStart &&
    !activePendingApproval &&
    pendingUserInputs.length === 0 &&
    activeThread?.claudeCacheReview == null;
  const appliedContextWindowSelection = useMemo(
    () => deriveAppliedContextWindowSelection(threadActivities),
    [threadActivities],
  );
  const contextWindowSelectionStatus = useMemo(
    () =>
      deriveContextWindowSelectionStatus({
        activeSnapshot: runtimeUsageContextWindow,
        ...(selectedProvider === "claudeAgent"
          ? { appliedValue: appliedContextWindowSelection }
          : {}),
        selectedValue:
          selectedProvider === "claudeAgent" ? composerTraitSelection.contextWindow : null,
      }),
    [
      runtimeUsageContextWindow,
      composerTraitSelection.contextWindow,
      selectedProvider,
      appliedContextWindowSelection,
    ],
  );
  const observedClaudeContextBudget = useMemo(
    () => deriveObservedClaudeContextBudget(threadActivities),
    [threadActivities],
  );
  const composerContextWindowLabel = deriveComposerContextWindowLabel({
    provider: selectedProvider,
    model: selectedModel,
    snapshot: runtimeUsageContextWindow,
    status: contextWindowSelectionStatus,
    observedBudget: observedClaudeContextBudget,
  });
  // Claude reports the speed it actually serves; the selection is only a request.
  const composerFastModeNotice = useMemo(
    () => (selectedProvider === "claudeAgent" ? deriveFastModeNotice(threadActivities) : null),
    [selectedProvider, threadActivities],
  );
  const composerFooterControlsPlan = useMemo(
    () => composerFooterPlanForTier(composerFooterTier, Boolean(runtimeUsageContextWindow)),
    [composerFooterTier, runtimeUsageContextWindow],
  );
  // The displayed labels changed (model switch, effort change, picker layout):
  // recorded overflow widths no longer apply, so reset to the richest tier and
  // let the measured-overflow loop demote again before paint if needed.
  const composerFooterModelLabel = resolveProviderModelLabel({
    provider: selectedProvider,
    lockedProvider,
    model: selectedModelForPickerWithCustomFallback,
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    selectedProviderInstanceId,
  });
  const composerFooterTraitsSummary = resolveTraitsTriggerSummary({
    provider: selectedProvider,
    model: selectedModelForPickerWithCustomFallback,
    prompt,
    modelOptions: selectedProviderModelOptions,
    ...(selectedRuntimeModel ? { runtimeModel: selectedRuntimeModel } : {}),
    runtimeAgents: dynamicAgents,
  });
  const composerFooterPlanInputsKey = [
    selectedProviderInstanceLabel,
    composerFooterModelLabel,
    composerFooterTraitsSummary.summaryText,
    composerContextWindowLabel,
    Boolean(runtimeUsageContextWindow),
  ].join(":");
  useLayoutEffect(() => {
    composerFooterDemotionWidthsRef.current = [];
    composerFooterTierRef.current = 0;
    setComposerFooterTier(0);
    composerFooterLayoutSyncRef.current?.();
  }, [
    setComposerFooterTier,
    composerFooterTierRef,
    composerFooterDemotionWidthsRef,
    composerFooterLayoutSyncRef,
    composerFooterPlanInputsKey,
  ]);
  // After a tier renders, re-measure before paint: a still-overflowing footer
  // demotes another step until it fits (bounded by COMPOSER_FOOTER_MAX_TIER).
  useLayoutEffect(() => {
    composerFooterLayoutSyncRef.current?.();
  }, [composerFooterLayoutSyncRef, composerFooterTier]);
  const composerModelEffortPickerWidthClassName = isComposerFooterCompact ? "w-40" : "w-44 sm:w-52";
  const handleComposerModelEffortPickerOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        handleModelPickerOpenChange(true);
      } else {
        dismissEffortPreview();
        setIsModelPickerOpen(false);
        setIsTraitsPickerOpen(false);
      }
    },
    [
      dismissEffortPreview,
      setIsModelPickerOpen,
      setIsTraitsPickerOpen,
      handleModelPickerOpenChange,
    ],
  );
  // Event handlers handed to children below. Their closures read live thread and draft
  // state, so they are recreated with every streamed token and keystroke; one identity
  // keeps those children from re-rendering (and re-registering editor commands) for it.
  const handleProviderModelChange = useStableCallback(onProviderModelSelect);
  const composerModelAndTraitsControls = showComposerModelBootstrapSkeleton ? (
    selectedProviderRuntimeModelDiscoveryPending ? (
      <ComposerModelLoadingControl widthClassName={composerModelEffortPickerWidthClassName} />
    ) : (
      <ComposerControlSkeleton widthClassName={composerModelEffortPickerWidthClassName} />
    )
  ) : (
    <ComposerModelPicker
      hideModelLabel={!composerFooterControlsPlan.showModelLabel}
      hideStatusLabel={!composerFooterControlsPlan.showTraitsLabel}
      contextWindowLabel={composerContextWindowLabel}
      fastModeNotice={composerFastModeNotice}
      effortControl={settings.composerEffortSlider ? "slider" : "menu"}
      provider={selectedProvider}
      model={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      boundProviderInstance={
        lockedProvider === null && boundProvider !== null && boundProviderInstanceId !== null
          ? { provider: boundProvider, instanceId: boundProviderInstanceId }
          : null
      }
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      modelOptionsByProviderInstance={modelOptionsByProviderInstance}
      loadingModelProviders={loadingModelProviders}
      onRefreshModels={refreshModels}
      discoveryErrorsByProvider={discoveryErrorsByProvider}
      hiddenProviders={settings.hiddenProviders}
      providerOrder={settings.providerOrder}
      providerInstances={providerInstances}
      selectedProviderInstanceId={selectedProviderInstanceId}
      threadId={threadId}
      runtimeModel={selectedRuntimeModel}
      runtimeModelsByProvider={runtimeModelsByProvider}
      runtimeAgents={dynamicAgents}
      modelOptions={selectedProviderModelOptions}
      prompt={prompt}
      onPromptChange={setPromptFromTraits}
      onProviderModelChange={handleProviderModelChange}
      onSelectionCommitted={scheduleComposerFocus}
      open={isComposerModelEffortPickerOpen}
      onOpenChange={handleComposerModelEffortPickerOpenChange}
      shortcutLabel={modelPickerShortcutLabel}
    />
  );
  const composerPickerControls = (
    <>
      {showProviderInstancePicker ? (
        showComposerModelBootstrapSkeleton ? (
          <ComposerControlSkeleton widthClassName={isComposerFooterCompact ? "w-10" : "w-32"} />
        ) : (
          <ProviderInstancePicker
            provider={selectedProvider}
            providerInstances={providerInstances}
            providers={providerStatuses}
            selectedProviderInstanceId={selectedProviderInstanceId}
            selectionLocked={
              lockedProvider !== null ||
              (boundProvider !== null && selectedProvider === boundProvider)
            }
            compact={isComposerFooterCompact}
            hideLabel={!composerFooterControlsPlan.showModelLabel}
            onProviderInstanceChange={onProviderInstanceSelect}
            onManageAccounts={openProviderAccountSettings}
          />
        )
      ) : null}
      {composerModelAndTraitsControls}
    </>
  );
  const toggleFastMode = useCallback(() => {
    if (!composerTraitSelection.caps.supportsFastMode) {
      scheduleComposerFocus();
      return;
    }
    setComposerDraftProviderModelOptions(
      threadId,
      selectedProvider,
      buildNextProviderOptions(selectedProvider, selectedProviderModelOptions, {
        fastMode: !composerTraitSelection.fastModeEnabled,
      }),
      { instanceId: selectedProviderInstanceId, persistSticky: true },
    );
    scheduleComposerFocus();
  }, [
    composerTraitSelection.caps.supportsFastMode,
    composerTraitSelection.fastModeEnabled,
    scheduleComposerFocus,
    selectedProvider,
    selectedProviderInstanceId,
    selectedProviderModelOptions,
    setComposerDraftProviderModelOptions,
    threadId,
  ]);
  const {
    onEnvModeChange,
    handleResetWorkspaceToHome,
    handleSelectWorkspaceRoot,
    handleSelectProjectForEmptyDraft,
    handleCreateProjectFromPickerPath,
  } = useChatWorkspaceSelection({
    threadId,
    activeThread,
    activeProject,
    activeRootBranch,
    isServerThread,
    isLocalDraftThread,
    isHomeChatContainer,
    isGroupContainer,
    hasNativeUserMessages,
    composerEditorRef,
    scheduleComposerFocus,
    defaultProvider: settings.defaultProvider,
  });

  const {
    applyPromptReplacement,
    resolveActiveComposerTrigger,
    applyComposerTriggerReplacement,
    handleSelectLocalDirectoryMention,
    handleNavigateLocalFolder,
    setComposerPromptValue,
    clearComposerSlashDraft,
  } = useChatComposerEditing({
    threadId,
    promptRef,
    activePendingProgress,
    activePendingUserInputKey,
    pendingUserInputAnswersByRequestIdRef,
    setPendingUserInputAnswersByRequestId,
    setPrompt,
    setComposerCursor,
    setComposerTrigger,
    composerEditorRef,
    composerCursor,
    composerTerminalContexts,
    setComposerHighlightedItemId,
    setRestoredQueuedSourceProposedPlan,
    clearComposerDraftContent,
    scheduleComposerFocus,
  });

  // A visual's follow-up choice is the reader's next message: sent as is on an
  // empty composer, added under a draft (and left for the reader) otherwise.
  const onSendVisualChoice = useCallback(
    (message: string) => {
      const draft = (
        composerEditorRef.current?.readSnapshot()?.value ?? promptRef.current
      ).trimEnd();
      const stagedDraft = useComposerDraftStore.getState().draftsByThreadId[threadId];
      const hasStagedContext =
        isPreparingComposerImages ||
        (stagedDraft !== undefined &&
          (composerDraftHasUnsentContent({ ...stagedDraft, prompt: "" }) ||
            stagedDraft.skills.length > 0 ||
            stagedDraft.mentions.length > 0));
      if (draft.length > 0 || hasStagedContext) {
        setComposerPromptValue(draft.length > 0 ? `${draft}\n\n${message}` : message);
        return;
      }
      setComposerPromptValue(message);
      setComposerAutoSendRequest((current) => current + 1);
    },
    [composerEditorRef, promptRef, setComposerPromptValue, threadId, isPreparingComposerImages],
  );

  // A denied task offers the same visible, one-request invocation as the slash menu.
  const handleEnableComputerControlFromDenial = useCallback(() => {
    const currentPrompt =
      composerEditorRef.current?.readSnapshot({ flushPending: true })?.value ?? promptRef.current;
    if (!parseComputerInvocation(currentPrompt)) {
      setComposerPromptValue(`/computer-use ${currentPrompt}`);
    }
    handleComputerControlModeChange("request");
  }, [composerEditorRef, promptRef, setComposerPromptValue, handleComputerControlModeChange]);

  const slashEditorActions = useMemo(
    () => ({
      resolveActiveComposerTrigger,
      applyPromptReplacement,
      clearComposerSlashDraft,
      setComposerPromptValue,
      scheduleComposerFocus,
      setComposerHighlightedItemId,
    }),
    [
      setComposerHighlightedItemId,
      applyPromptReplacement,
      clearComposerSlashDraft,
      resolveActiveComposerTrigger,
      scheduleComposerFocus,
      setComposerPromptValue,
    ],
  );

  const {
    handleForkFromMessage,
    handleForkTargetSelection,
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
    clearThreadGoal,
    setThreadGoalPaused,
  } = useComposerSlashCommands({
    activeProject,
    activeThread,
    activeRootBranch,
    isServerThread,
    isLocalDraftThread,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      canCompactThread &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canExecuteSideCommand,
    sidechatTargetProviders: sidechatTargetProviders,
    canOfferExportCommand,
    supportsTextNativeReviewCommand,
    fastModeEnabled,
    providerNativeCommands,
    providerCommandDiscoveryCwd: providerModelDiscoveryCwd,
    selectedProvider,
    currentProviderModelOptions,
    selectedModelSelection,
    environmentMode: envMode ?? null,
    runtimeMode,
    interactionMode,
    threadId,
    syncServerShellSnapshot,
    navigateToThread: (nextThreadId, options) =>
      navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        ...(options?.splitViewId ? { search: () => ({ splitViewId: options.splitViewId }) } : {}),
      }),
    handleClearConversation: async () => {
      if (!activeProject) {
        toastManager.add({
          type: "warning",
          title: "Clear is unavailable",
          description: "Open a project before starting a fresh thread.",
        });
        return;
      }
      await handleNewThread(activeProject.id, { entryPoint: "chat" });
    },
    handleInteractionModeChange,
    openForkTargetPicker: () => {
      setComposerCommandPicker("fork-target");
      setComposerHighlightedItemId("fork-target:worktree");
    },
    openReviewTargetPicker: () => {
      setComposerCommandPicker("review-target");
      setComposerHighlightedItemId("review-target:changes");
    },
    setComposerDraftProviderModelOptions,
    editorActions: slashEditorActions,
  });

  // Keep Goal menu drafts literal while reusing slash-command chips and persistence.
  const insertGoalSlashCommandInComposer = useCallback(() => {
    const currentPrompt = promptRef.current;
    if (/^\s*\/goal\b/i.test(currentPrompt)) {
      scheduleComposerFocus();
      return;
    }
    setComposerPromptValue(buildGoalSlashCommandPrompt(currentPrompt));
  }, [promptRef, scheduleComposerFocus, setComposerPromptValue]);

  // Prefills a literal goal so editing reuses the same slash-command path
  // that created the goal, mirroring how queued turns restore into the composer.
  const editThreadGoalInComposer = useCallback(() => {
    const currentGoal = activeThread?.goal?.trim();
    if (!activeThread || !currentGoal) {
      return;
    }
    const nextPrompt = buildGoalSlashCommandPrompt(currentGoal);
    promptRef.current = nextPrompt;
    clearComposerDraftContent(activeThread.id);
    setComposerDraftPrompt(activeThread.id, nextPrompt);
    setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    scheduleComposerFocus();
  }, [
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    activeThread,
    clearComposerDraftContent,
    scheduleComposerFocus,
    setComposerDraftPrompt,
  ]);

  // Refreshed on every commit, in a layout effect rather than a passive one: the queued
  // dispatcher can run from the same commit's follow-up work, so there must be no window
  // where it sees the previous render's handlers. See `LateComposerSendHandlers`.
  useLayoutEffect(() => {
    lateComposerSendHandlersRef.current = {
      send: onSend,
      submitPlanFollowUp: onSubmitPlanFollowUp,
      advanceActivePendingUserInput: onAdvanceActivePendingUserInput,
      handleStandaloneSlashCommand,
    };
  });

  // Runs after the transcript (or choice) and the cleared transcribing flag have
  // committed, so the send guard and the live editor snapshot both see the text.
  useEffect(() => {
    if (composerAutoSendRequest === 0) return;
    void lateComposerSendHandlersRef.current?.send();
  }, [composerAutoSendRequest]);

  const {
    onSelectComposerItem,
    onComposerMenuItemHighlighted,
    onPromptChange,
    onComposerCommandKey,
  } = useChatComposerCommands({
    threadId,
    composerSelectLockRef,
    setComposerCommandPicker,
    setComposerHighlightedItemId,
    handleForkTargetSelection,
    handleReviewTargetSelection,
    resolveActiveComposerTrigger,
    applyComposerTriggerReplacement,
    handleNavigateLocalFolder,
    localFolderBrowseRootPath,
    handleSlashCommandSelection,
    selectedProvider,
    scheduleComposerFocus,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
    onProviderModelSelect,
    composerMenuItems,
    composerHighlightedItemId,
    activePendingQuestion,
    activePendingUserInput,
    promptHistoryNavigationRef,
    restoreComposerDraftPromptHistorySavedDraft,
    promptRef,
    setPrompt,
    expectedPromptHistoryPromptRef,
    onChangeActivePendingUserInputCustomAnswer,
    setComposerDraftPromptHistorySavedDraft,
    applyingPromptHistoryNavigationRef,
    promptHistory,
    promptHistoryAppliedPromptRef,
    restoredQueuedSourceProposedPlanRef,
    setRestoredQueuedSourceProposedPlan,
    composerCommandPicker,
    composerTerminalContexts,
    setComposerDraftTerminalContexts,
    setComposerCursor,
    setComposerTrigger,
    clearComposerSlashDraft,
    composerMenuOpenRef,
    onSend,
    settings,
    hasLiveTurn,
    isLocalFolderBrowserOpen,
    localDirectoryMenuRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    activePendingProgress,
    isComposerApprovalState,
    pendingUserInputs,
    composerDraft,
  });
  const onExpandTimelineImage = useCallback(
    async (preview: ExpandedImagePreview) => {
      if (preview.generated?.kind === "generated-image") {
        if (!(await flushConversationImageEditors(threadId))) return;
        const groupId = preview.generated.groupId;
        openRightDockPane(threadId, {
          kind: "imagePreview",
          imagePreview: {
            images: mergeConversationImages(
              conversationGeneratedImages,
              preview.generated.images.map((image) => ({
                ...image,
                id: conversationImageIdentity(groupId, image.id),
              })),
            ),
            activeImageId: conversationImageIdentity(groupId, preview.generated.activeImageId),
            cwd: preview.generated.cwd ?? null,
            conversationTitle: activeThread?.title ?? null,
            groupId: preview.generated.groupId,
            createdAt: preview.generated.createdAt,
            view: preview.generated.initialView ?? "single",
          },
        });
        setExpandedImage(null);
        return;
      }
      setExpandedImage(preview);
    },
    [
      activeThread?.title,
      openRightDockPane,
      setExpandedImage,
      threadId,
      conversationGeneratedImages,
    ],
  );

  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (diffEnvironmentPending) {
        return;
      }
      if (onOpenTurnDiffPanel) {
        onOpenTurnDiffPanel(turnId, filePath);
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? {
                ...rest,
                panel: "diff",
                diff: "1",
                diffTurnId: turnId,
                diffFilePath: filePath,
              }
            : { ...rest, panel: "diff", diff: "1", diffTurnId: turnId };
        },
      });
    },
    [diffEnvironmentPending, navigate, onOpenTurnDiffPanel, threadId],
  );
  const onReviewComposerLiveChanges = useCallback(() => {
    if (!activeTurnLiveDiffState.turnId) {
      return;
    }
    onOpenTurnDiff(activeTurnLiveDiffState.turnId);
  }, [activeTurnLiveDiffState.turnId, onOpenTurnDiff]);
  const onNavigateToThread = useCallback(
    (nextThreadId: ThreadId) =>
      navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: (previous) =>
          isEditorRail
            ? { ...stripDiffSearchParams(previous), view: "editor" }
            : stripDiffSearchParams(previous),
      }),
    [isEditorRail, navigate],
  );
  // What the transcript's subagent cards read from this chat. Stop and
  // background go through the same per-row dispatches the keyboard uses.
  const activeThreadIdForSubagentRuns = activeThread?.id ?? null;
  const subagentRunContext = useMemo(
    () =>
      activeThreadIdForSubagentRuns
        ? {
            parentThreadId: runningSubagentRunParentId,
            liveTurnId: subagentRunLiveTurnId,
            threads: subagentRunThreads,
            backgroundedProviderThreadIds: backgroundedSubagentToolUseIds,
            taskEndByToolUseId: subagentTaskEnds,
            onOpenThread: onNavigateToThread,
            onStop: onStopSubagentStripItem,
            onBackground: onBackgroundSubagentStripItem,
          }
        : null,
    [
      activeThreadIdForSubagentRuns,
      runningSubagentRunParentId,
      subagentRunLiveTurnId,
      subagentTaskEnds,
      backgroundedSubagentToolUseIds,
      onBackgroundSubagentStripItem,
      onNavigateToThread,
      onStopSubagentStripItem,
      subagentRunThreads,
    ],
  );
  const onOpenAutomation = useCallback(
    (automationId: string) => {
      void navigate({
        to: "/automations/$automationId",
        params: { automationId },
      });
    },
    [navigate],
  );
  // The Overview row menu's "Open in split view" mirrors SingleChatSurface's
  // split helper: seed a split view off the thread, then swap the route to it.
  const onOpenThreadSplit = useCallback(
    (nextThreadId: ThreadId) => {
      const ownerProjectId =
        useStore.getState().sidebarThreadSummaryById[nextThreadId]?.projectId ?? activeProjectId;
      if (!ownerProjectId) return;
      const splitViewId = useSplitViewStore.getState().createFromThread({
        sourceThreadId: nextThreadId,
        ownerProjectId,
      });
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        replace: true,
        search: () => ({ splitViewId }),
      });
    },
    [activeProjectId, navigate],
  );
  const activeProjectIdForNewChat = activeProject?.id ?? null;
  const onNewEditorChat = useCallback(() => {
    if (!activeProjectIdForNewChat) {
      return;
    }
    // Keep the editor workspace view (and any open file) across the new-thread
    // navigation; the default new-thread flow clears all search params.
    void handleNewThread(activeProjectIdForNewChat, undefined, {
      search: (previous) => ({ ...stripDiffSearchParams(previous), view: "editor" }),
    });
  }, [activeProjectIdForNewChat, handleNewThread]);
  const onOpenEditorChat = useCallback(
    (nextThreadId: ThreadId) => {
      storeOpenChatThreadPage(nextThreadId);
      return onNavigateToThread(nextThreadId);
    },
    [onNavigateToThread, storeOpenChatThreadPage],
  );
  const onOpenEditorTerminal = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalPresentationMode("workspace");
    setTerminalWorkspaceLayout("terminal-only");
    setTerminalWorkspaceTab("terminal");
    requestTerminalFocus();
  }, [
    activeThreadId,
    requestTerminalFocus,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
  ]);
  const onCloseEditorTerminal = useCallback(() => {
    void closeTerminal(terminalState.activeTerminalId);
  }, [closeTerminal, terminalState.activeTerminalId]);
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      void onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByUserMessageId],
  );
  const onRunProjectScriptFromHeader = useStableCallback((script: ProjectScript) => {
    void runProjectScript(script);
  });
  // A thread-strip `+` uses the active project's workspace. A pending, reusable draft wins
  // so this never retargets unsent work to the thread currently on screen.
  const onNewThreadFromHeader = useStableCallback(() => {
    const targetProjectId = activeProject?.id ?? activeThread?.projectId ?? null;
    if (!targetProjectId) return;
    const pendingProjectDraft = useComposerDraftStore
      .getState()
      .getDraftThreadByProjectId(targetProjectId);
    void handleNewThread(
      targetProjectId,
      resolveInheritedThreadContext({
        activeThread,
        activeDraftThread:
          draftThread ??
          (pendingProjectDraft &&
          pendingProjectDraft.isTemporary !== true &&
          !hasActiveComposerSend(pendingProjectDraft.threadId)
            ? pendingProjectDraft
            : null),
      }),
    );
  });
  const dismissActiveThreadError = useCallback(() => {
    if (!activeThread) return;
    setThreadError(activeThread.id, null);
  }, [activeThread, setThreadError]);
  // Retry resends the latest message, so it is offered only when that message
  // can be sent again exactly: text, with no attachments.
  const canRetryActiveThreadStart = useMemo(() => {
    const lastUserMessage = activeThread?.messages.findLast((message) => message.role === "user");
    return (
      lastUserMessage !== undefined &&
      lastUserMessage.text.trim().length > 0 &&
      (lastUserMessage.attachments?.length ?? 0) === 0
    );
  }, [activeThread?.messages]);
  const retryActiveThreadStart = useCallback(() => {
    void onRetryStartFailure().then((sent) => {
      if (sent) dismissActiveThreadError();
    });
  }, [dismissActiveThreadError, onRetryStartFailure]);
  const dismissThreadError = useCallback(
    (errorThreadId: ThreadId) => {
      setThreadError(errorThreadId, null);
    },
    [setThreadError],
  );
  const clearThreadErrorAfterUnblock = useCallback(
    (unblockedThreadId: ThreadId) => {
      setThreadError(unblockedThreadId, null);
    },
    [setThreadError],
  );
  const { unblockThread, unblockingThreadId } = useThreadUnblock({
    threadId: activeThread?.id ?? null,
    onUnblocked: clearThreadErrorAfterUnblock,
  });
  const unblockingActiveThread =
    activeThread !== undefined && unblockingThreadId === activeThread.id;
  useThreadErrorToast({
    threadId: activeThread?.id ?? null,
    onDismiss: dismissThreadError,
    onUnblock: unblockThread,
    unblockingThreadId,
  });
  const dismissActiveProviderHealthBanner = useCallback(() => {
    if (!activeProviderHealthBannerDismissalKey) return;
    setDismissedProviderHealthBannerKeys((current) => {
      if (current.includes(activeProviderHealthBannerDismissalKey)) {
        return current;
      }
      return [activeProviderHealthBannerDismissalKey, ...current].slice(
        0,
        MAX_DISMISSED_PROVIDER_HEALTH_BANNERS,
      );
    });
  }, [activeProviderHealthBannerDismissalKey, setDismissedProviderHealthBannerKeys]);
  const dismissActiveRateLimitBanner = useCallback(() => {
    if (!activeRateLimitBannerDismissalKey) return;
    setDismissedRateLimitBannerKey(activeRateLimitBannerDismissalKey);
  }, [setDismissedRateLimitBannerKey, activeRateLimitBannerDismissalKey]);
  const previewSession = useComputerPreviewStore(selectThreadComputerPreviewSession(threadId));
  const previewLayout = useComputerPreviewStore(selectThreadComputerPreviewLayout(threadId));
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const [mainContentWidth, setMainContentWidth] = useState(1600);
  useEffect(() => {
    const element = mainContentRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      setMainContentWidth((previous) => (previous === width ? previous : width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const composerEffortOptionId = composerTraitSelection.primarySelectDescriptor?.id ?? "effort";
  const applyComputerControlEffortHint = useCallback(() => {
    setComposerDraftProviderModelOptions(
      threadId,
      selectedProvider,
      buildNextProviderOptions(selectedProvider, selectedProviderModelOptions, {
        [composerEffortOptionId]: COMPUTER_CONTROL_HINT_EFFORT,
      }),
      { model: selectedModelForPickerWithCustomFallback, persistSticky: true },
    );
    updateSettings({ dismissedComputerControlEffortHint: true });
    scheduleComposerFocus();
  }, [
    composerEffortOptionId,
    scheduleComposerFocus,
    selectedModelForPickerWithCustomFallback,
    selectedProvider,
    selectedProviderModelOptions,
    setComposerDraftProviderModelOptions,
    threadId,
    updateSettings,
  ]);
  const dismissComputerControlEffortHint = useCallback(() => {
    updateSettings({ dismissedComputerControlEffortHint: true });
    scheduleComposerFocus();
  }, [scheduleComposerFocus, updateSettings]);

  // Only built when the Group panel applies — in every other chat view the
  // needs-attention selector has no consumer and stays empty. No manual
  // useMemo: the compiler owns this scope (see chatHotPath.compiler.test.ts).
  const projectPanelAttentionGroups = new Map<ProjectId, GroupNeedsAttentionGroup>();
  if (projectPanelEnabled && activeProject) {
    const summary = summariesByProjectId.get(activeProject.id);
    projectPanelAttentionGroups.set(activeProject.id, {
      projectId: activeProject.id,
      coordinatorThreadId: summary?.coordinatorThreadId ?? null,
      memberThreadIds: new Set(summary?.memberThreadIds ?? []),
      needsYouThreadIds: new Set(summary?.needsYouThreadIds ?? []),
    });
  }
  const projectPanelNeedsAttention = useStore(
    createGroupNeedsAttentionSelector({
      groups: projectPanelAttentionGroups,
    }),
  );
  // "Use default" in group settings means the app default — the project's default
  // model first, then the user's default provider, never the active thread's model.
  const groupPanelDefaultModelSelection = useMemo<ModelSelection>(
    () =>
      resolveDraftFallbackModelSelection({
        projectDefault: activeProject?.defaultModelSelection,
        settingsDefaultProvider: settings.defaultProvider,
      }),
    [activeProject?.defaultModelSelection, settings.defaultProvider],
  );

  const handlePromptChange = useStableCallback(onPromptChange);
  const handleComposerCommandKey = useStableCallback(onComposerCommandKey);
  const handleComposerPaste = useStableCallback(onComposerPaste);
  const acceptComposerPrediction = useStableCallback(() => {
    if (!composerPrediction) return;
    const currentPrompt = promptRef.current;
    const nextPrompt = applyComposerPrediction(currentPrompt, composerPrediction);
    if (nextPrompt === currentPrompt) return;
    discardPromptHistoryNavigationForComposerMutation();
    setComposerPromptValue(nextPrompt);
    if (import.meta.env.DEV) console.debug("[prediction] accepted");
    setHasAcceptedComposerPrediction(true);
  });
  const composerPromptPrediction = composerPrediction
    ? {
        base: prompt,
        suffix: composerPrediction.suffix,
        hint: t("chat.composer.prediction.pressTabToAccept"),
        showHint: !hasAcceptedComposerPrediction,
        onAccept: acceptComposerPrediction,
      }
    : null;
  const handleCollapsePastedText = useStableCallback(addPastedTextToDraft);
  const handleEnvModeChange = useStableCallback(onEnvModeChange);
  const handleHandoffToWorktree = useStableCallback(onHandoffToWorktree);
  const handleHandoffToLocal = useStableCallback(onHandoffToLocal);
  const handleConfirmWorktreeHandoff = useStableCallback(confirmWorktreeHandoff);
  const handleResetInteractionMode = useStableCallback(resetInteractionMode);
  const closeAgentActivityDetail = useStableCallback(() => setOpenAgentActivityId(null));

  // Resume state must be initialized for every render, including the empty state where there is
  // no active thread. Keeping these hooks above the early return preserves hook order while the
  // eligibility and event handlers remain safely inactive until a thread is selected.
  const isComposerProjectPending = !activeProject;
  const hasPendingComposerInteraction =
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    (activeThread?.pendingInteractions ?? []).some(
      (interaction) => interaction.status !== "confirmed",
    );
  const activeManagedProviderConfigured = useMemo(
    () =>
      isServerConfiguredMossDefaultManagedProvider(
        serverSettingsQuery.data,
        selectedProviderInstanceId,
      ),
    [selectedProviderInstanceId, serverSettingsQuery.data],
  );
  const activeProviderSendAdmission = useMemo(
    () =>
      resolveProviderSendAdmission(
        activeProviderStatus,
        selectedProviderInstanceId,
        activeManagedProviderConfigured,
      ),
    [activeManagedProviderConfigured, activeProviderStatus, selectedProviderInstanceId],
  );
  // No manual useMemo here: the hand-written dep list referenced
  // `showPlanFollowUpPrompt`, whose compiler-inferred scope stays open across
  // this point (PreserveManualMemo bailout), disabling memoization for the whole
  // component. The compiler memoizes this derivation itself.
  const composerResumeEligible = isComposerResumeEligible({
    thread: activeThread,
    provider: activeThread?.session?.provider ?? activeThreadProvider,
    isServerThread,
    hasSendableContent: composerSendState.hasSendableContent,
    isResponseInProgress: isWorking,
    hasActiveUnpausedGoal:
      (activeThread?.goal ?? "").trim().length > 0 && activeThread?.goalPausedAt == null,
    hasQueuedTurn: queuedComposerTurns.length > 0,
    hasPendingInteraction: hasPendingComposerInteraction,
    hasPlanFollowUp: showPlanFollowUpPrompt,
    providerAdmissionState: activeProviderSendAdmission.state,
    isLoading:
      isConnecting ||
      isComposerProjectPending ||
      isVoiceRecording ||
      isVoiceTranscribing ||
      isSendBusy ||
      isRevertingCheckpoint ||
      isPreparingComposerImages ||
      isPreparingWorktree ||
      isRealtimeVoiceCurrentThreadActive,
  });
  const [resumeInFlightTurnId, setResumeInFlightTurnId] = useState<TurnId | null>(null);
  const [resumeInFlightThreadId, setResumeInFlightThreadId] = useState<ThreadId | null>(null);
  const [resumeDispatchAccepted, setResumeDispatchAccepted] = useState(false);
  const resumeInFlightThreadIdRef = useRef<ThreadId | null>(null);
  const resumeInFlightTurnIdRef = useRef<TurnId | null>(null);
  const resumeBaselineSessionUpdatedAtRef = useRef<string | null>(null);
  const resumeMountedRef = useRef(false);
  useEffect(() => {
    resumeMountedRef.current = true;
    return () => {
      resumeMountedRef.current = false;
    };
  }, []);
  const clearResumeInFlight = useCallback(() => {
    resumeInFlightTurnIdRef.current = null;
    resumeInFlightThreadIdRef.current = null;
    resumeBaselineSessionUpdatedAtRef.current = null;
    setResumeDispatchAccepted(false);
    setResumeInFlightThreadId(null);
    setResumeInFlightTurnId(null);
  }, []);
  const onResumeInterruptedTask = useCallback(async () => {
    if (!activeThread) {
      return;
    }
    const currentThreadId = activeThread.id;
    const turnId = activeThread.latestTurn?.turnId;
    if (!turnId || !composerResumeEligible) {
      setThreadError(currentThreadId, "The latest Codex turn is not resumable.");
      return;
    }
    if (resumeInFlightTurnIdRef.current !== null) {
      setThreadError(currentThreadId, "A Resume request is already in flight.");
      return;
    }
    const api = readNativeApi();
    if (!api) {
      setThreadError(currentThreadId, "Native orchestration is unavailable.");
      return;
    }
    resumeInFlightTurnIdRef.current = turnId;
    resumeInFlightThreadIdRef.current = currentThreadId;
    resumeBaselineSessionUpdatedAtRef.current = activeThread.session?.updatedAt ?? null;
    setResumeDispatchAccepted(false);
    setResumeInFlightThreadId(currentThreadId);
    setResumeInFlightTurnId(turnId);
    // Kept as a function call so the `&&` chain lives outside the `try` — value
    // blocks inside try/catch are not compilable (see chatHotPath.compiler.test).
    const isCurrentResumeStillInFlight = () =>
      resumeMountedRef.current &&
      resumeInFlightThreadIdRef.current === currentThreadId &&
      resumeInFlightTurnIdRef.current === turnId;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.resume",
        commandId: newCommandId(),
        threadId: currentThreadId,
        turnId,
        createdAt: new Date().toISOString(),
      });
      if (isCurrentResumeStillInFlight()) {
        setResumeDispatchAccepted(true);
      }
    } catch {
      if (isCurrentResumeStillInFlight()) {
        clearResumeInFlight();
      }
      setThreadError(currentThreadId, "Unable to resume the interrupted turn.");
    }
  }, [activeThread, clearResumeInFlight, composerResumeEligible, setThreadError]);
  useEffect(() => {
    const pendingTurnId = resumeInFlightTurnIdRef.current;
    const pendingThreadId = resumeInFlightThreadIdRef.current;
    if (pendingTurnId === null || pendingThreadId === null) return;
    if (activeThread === null || activeThread === undefined) {
      clearResumeInFlight();
      return;
    }
    if (pendingThreadId !== threadId || activeThread.id !== pendingThreadId) {
      clearResumeInFlight();
      return;
    }
    const latestTurn = activeThread.latestTurn;
    if (latestTurn?.turnId !== pendingTurnId) {
      if (
        latestTurn?.state === "running" ||
        (latestTurn?.completedAt !== null && latestTurn?.completedAt !== undefined)
      ) {
        clearResumeInFlight();
      }
      return;
    }
    if (latestTurn.state === "running") {
      clearResumeInFlight();
      return;
    }
    if (
      resumeDispatchAccepted &&
      activeThread.session?.orchestrationStatus === "error" &&
      hasComposerResumeProjectionAdvancedSince(
        resumeBaselineSessionUpdatedAtRef.current,
        activeThread.session.updatedAt,
      )
    ) {
      clearResumeInFlight();
    }
  }, [activeThread, clearResumeInFlight, resumeDispatchAccepted, threadId]);
  const isResumePendingForCurrentThread = isComposerResumePendingForThread({
    activeThreadId: activeThread?.id === threadId ? activeThread.id : null,
    inFlightThreadId: resumeInFlightThreadId,
    inFlightTurnId: resumeInFlightTurnId,
  });

  // Moss visible parity markers: stable provider/session/send diagnostics on the
  // composer shell so desktop parity checks do not have to inspect internals.
  const mossVisibleComposerProvider =
    activeThread?.session?.provider ?? activeThreadProvider ?? "codex";
  // Expose the exact provider instance for every CLI/source. The desktop
  // matrix and recovery tooling use this marker to verify that a mid-thread
  // switch stayed on the requested managed or personal route.
  const mossVisibleComposerProviderInstance = selectedModelSelection.instanceId;
  const mossVisibleComposerSessionStatus = activeThread?.session?.status ?? "not-started";
  const mossVisibleComposerSendState = isPreparingWorktree
    ? "preparing-worktree"
    : isSendBusy
      ? "sending"
      : activeProviderSendAdmission.state === "blocked"
        ? "unavailable"
        : isConnecting || isComposerProjectPending
          ? "connecting"
          : isVoiceTranscribing
            ? "transcribing"
            : composerSendState.hasSendableContent
              ? "ready"
              : "empty";
  const composerResumeControl = (
    <ChatComposerSendButton
      provider={selectedProvider}
      status={activeProviderStatus}
      admission={activeProviderSendAdmission}
      visibleSendState={mossVisibleComposerSendState}
      hasSendableContent={composerSendState.hasSendableContent}
      isSendBusy={isSendBusy}
      isConnecting={isConnecting}
      isSendPreflightInFlight={false}
      isProjectPending={isComposerProjectPending}
      isVoiceTranscribing={isVoiceTranscribing}
      isModelLoading={false}
      isPreparingImages={isPreparingComposerImages}
      isPreparingWorktree={isPreparingWorktree}
      showResume={composerResumeEligible}
      isResumePending={isResumePendingForCurrentThread}
      isInteractionUnavailable={
        hasPendingComposerInteraction || isVoiceRecording || isRealtimeVoiceCurrentThreadActive
      }
      onResume={onResumeInterruptedTask}
    />
  );

  // Empty state: no active thread
  const imageComposerHost = useConversationImageComposer(threadId);
  if (!activeThread) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col text-[var(--color-text-foreground-secondary)]",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
        data-shell-surface="chat"
        data-shell-state="no-thread"
      >
        {!isElectron && (
          <header className={cn(CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, "px-3 py-2 md:hidden")}>
            <div className="flex items-center gap-2">
              <SidebarHeaderTrigger className="size-7 shrink-0" />
              <span className="text-ui-lg font-medium text-[var(--color-text-foreground)]">
                Threads
              </span>
            </div>
          </header>
        )}
        {isElectron && (
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              "drag-region px-5",
              desktopTopBarTrafficLightGutterClassName,
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <SidebarHeaderNavigationControls />
            <span className="text-ui leading-snug text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-ui leading-snug">
              Select a thread or create a new one to get started.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Open-thread tabs belong to the single chat on desktop; split panes, the editor rail, and
  // phone-width headers keep the plain thread title.
  const showOpenThreadTabs =
    !isMobileViewport && surfaceMode === "single" && !isEditorRail && !isQuickChat;

  const activeThreadDisplayTitle = resolveActiveThreadTitle({
    title: isCoordinatorConversation
      ? resolveGroupCoordinatorDisplayName({
          coordinatorName: activeGroupSummary?.coordinatorName ?? null,
          threadTitle: activeThread.title,
          groupName: activeProjectDisplayName ?? activeProject?.name ?? activeThread.title,
          remoteName: activeProject?.remoteName ?? null,
        })
      : activeThread.title,
    subagentTitle: activeThread.parentThreadId
      ? resolveSubagentPresentationForThread({
          thread: activeThread,
          threads: threadLineageThreads,
        }).fullLabel
      : null,
    isHomeChat: isChatProject,
    isEmpty: timelineEntries.length === 0,
  });

  const handleRenameActiveThread = async (newTitle: string) => {
    const outcome = await dispatchThreadRename({
      threadId: activeThread.id,
      newTitle,
      unchangedTitles: [activeThread.title],
      createIfMissing: isLocalDraftThread
        ? buildDraftThreadRenameCreateInput(activeThread)
        : undefined,
    }).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Failed to rename thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      throw error;
    });

    if (outcome === "empty") {
      toastManager.add({
        type: "warning",
        title: "Thread title cannot be empty",
      });
      return;
    }
    if (outcome === "unchanged" || outcome === "unavailable") {
      return;
    }
  };

  const runtimeUsageControlsProps = {
    provider: selectedProvider,
    runtimeModel: selectedRuntimeModel,
    providerStatus: activeProviderStatus,
    runtimeMode,
    activeRuntimeMode: activeThread?.session?.activeTurnId
      ? activeThread.session.runtimeMode
      : undefined,
    onRuntimeModeChange: handleRuntimeModeChange,
    contextWindow: runtimeUsageContextWindow,
    cumulativeCostUsd: activeCumulativeCostUsd,
    activeContextWindowLabel: contextWindowSelectionStatus.activeLabel,
    pendingContextWindowLabel: contextWindowSelectionStatus.pendingSelectedLabel,
  };
  // The composer's leading controls (extras "+" menu, access-rules/runtime
  // indicator). At the narrowest footer tier they relocate from the footer to
  // the branch-toolbar row below the input instead of getting clipped; the
  // relocated variant is icon-only since relocation means space is minimal.
  const relocateComposerLeadingControls = composerFooterControlsPlan.relocateLeadingControls;
  // Started threads keep the composer to + / text / mic / send: permission, model/effort and
  // the context ring sit in the row under it, beside the branch controls.
  const composerStatusBelow = !isCenteredEmptyLanding;
  const composerExtrasTrigger = (
    <ComposerExtrasTrigger
      open={isComposerExtrasPanelOpen}
      panelId={COMPOSER_EXTRAS_PANEL_ID}
      onToggle={() => {
        setIsComposerExtrasPanelOpen((open) => !open);
        // The panel is keyboard-driven from the editor: keep the caret where the
        // user left it so typing (and Escape) keep working while it is open.
        scheduleComposerFocus();
      }}
    />
  );
  const composerContextMeter =
    (composerStatusBelow || (!isVoiceRecording && !isVoiceTranscribing)) &&
    runtimeUsageContextWindow &&
    composerFooterControlsPlan.showContextMeter ? (
      <ContextWindowMeter
        usage={runtimeUsageContextWindow}
        showClaudeCache={activeThread?.session?.provider === "claudeAgent"}
        onOpenChange={setIsContextWindowMeterOpen}
        {...(selectedProvider === "claudeAgent" &&
        activeThread?.session?.provider === "claudeAgent" &&
        isServerThread
          ? {
              compactAction: {
                disabledReason: standaloneClaudeCompactDisabledReason,
                isSubmitting: isRequestingClaudeCompaction,
                onCompact: onCompactClaudeContext,
              },
            }
          : {})}
        {...(activeCumulativeCostUsd != null ? { cumulativeCostUsd: activeCumulativeCostUsd } : {})}
        {...(contextWindowSelectionStatus.activeLabel !== undefined
          ? {
              activeWindowLabel: contextWindowSelectionStatus.activeLabel,
            }
          : {})}
        {...(contextWindowSelectionStatus.pendingSelectedLabel !== undefined
          ? {
              pendingWindowLabel: contextWindowSelectionStatus.pendingSelectedLabel,
            }
          : {})}
      />
    ) : null;
  const renderComposerLeadingControls = (options: { iconOnly: boolean }) => (
    <>
      {composerExtrasTrigger}
      {!isVoiceRecording && !isVoiceTranscribing ? (
        <RuntimeUsageControls
          {...runtimeUsageControlsProps}
          className="shrink-0"
          hideLabel={options.iconOnly}
        />
      ) : null}
    </>
  );
  const branchToolbarProps = {
    threadId: activeThread.id,
    onEnvModeChange: handleEnvModeChange,
    envLocked,
    threadDetailReady: threadDetailHydration === "ready",
    ...(handoffAvailability.workspaceHandoff
      ? {
          onHandoffToWorktree: handleHandoffToWorktree,
          onHandoffToLocal: handleHandoffToLocal,
          handoffBusy,
        }
      : {}),
    onComposerFocusRequest: scheduleComposerFocus,
    ...(isGroupContainer ? { fixedLocalWorkspaceCwd: threadWorkspaceCwd } : {}),
    ...(canCheckoutPullRequestIntoThread
      ? { onCheckoutPullRequestRequest: openPullRequestDialog }
      : {}),
  };
  const showTrailingBranchToolbar = !activeThreadIsSidechat && isGitRepo && !environmentEnabled;
  const showEmptyLandingBranchToolbar =
    isCenteredEmptyLanding && activeProject?.kind === "project" && !isHomeChatContainer;
  // Temporary is chosen while starting a chat. Draft metadata covers local reloads;
  // the in-memory marker keeps the badge + auto-delete alive through promotion.
  const isThreadTemporary = draftThread?.isTemporary === true || hasTemporaryThreadMarker;
  const toggleDraftTemporary = () => {
    const next = !isThreadTemporary;
    setDraftThreadContext(threadId, { isTemporary: next });
    if (next) {
      markTemporaryThread(threadId);
    } else {
      clearTemporaryThread(threadId);
    }
  };
  const showEmptyLandingProjectPicker =
    isCenteredEmptyLanding && isLocalDraftThread && activeProject?.kind === "project";
  const showContainerChatWorkspacePicker =
    isEmptyChatLanding && (isHomeChatContainer || isGroupContainer);
  const emptyLandingProjectChip =
    !showContainerChatWorkspacePicker &&
    !showEmptyLandingProjectPicker &&
    activeProjectDisplayName ? (
      <span
        className={cn(
          "inline-flex min-w-0 max-w-56 shrink items-center gap-2 overflow-hidden rounded-full px-2 py-1 sm:max-w-64",
          COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
        )}
      >
        <FolderIcon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{activeProjectDisplayName}</span>
      </span>
    ) : null;
  // Only primary chats offer a new-chat workspace tray.
  const showEmptyLandingControls =
    isCenteredEmptyLandingVisible &&
    (isEmptyChatLanding ||
      showEmptyLandingProjectPicker ||
      emptyLandingProjectChip !== null ||
      showEmptyLandingBranchToolbar);
  const emptyLandingControls = showEmptyLandingControls ? (
    <div
      data-empty-landing-controls="true"
      data-shell-surface="composer-context"
      data-shell-state={chatShellState}
      // Tray sitting in normal flow directly above the composer, full composer width so
      // the project / environment / branch chips sit near the shell edges. Unfilled in
      // both themes (chips float over the page), rounded on top only and flush against
      // the input shell below. No overlap/underlay tricks — in dark mode a slice tucked
      // behind the composer's translucent corners reads as a visible cut along the seam.
      className="chat-composer-shell squircle mx-auto flex min-h-8 w-full min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden !rounded-b-none !rounded-t-[var(--composer-radius)] px-1.5 py-1 transition-colors duration-150 ease-out motion-reduce:transition-none sm:min-h-7"
    >
      {showContainerChatWorkspacePicker ? (
        <ProjectPicker
          align="start"
          side="top"
          triggerVariant="ghost"
          triggerClassName={cn(
            "h-8 px-2 py-1 sm:h-7 sm:px-2.5",
            COMPOSER_FOLDER_PICKER_CAPSULE_HOVER_CLASS_NAME,
            COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
          )}
          showResetToHome={Boolean(
            isGroupContainer ? resolvedThreadWorkingDirectory : resolvedThreadWorktreePath,
          )}
          selectedWorkspaceRoot={
            isGroupContainer ? resolvedThreadWorkingDirectory : resolvedThreadWorktreePath
          }
          onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
          onResetToHome={handleResetWorkspaceToHome}
          {...(!isGroupContainer
            ? {
                onSelectProject: handleSelectProjectForEmptyDraft,
                onCreateProjectFromPath: handleCreateProjectFromPickerPath,
              }
            : {})}
        />
      ) : showEmptyLandingProjectPicker ? (
        <ProjectPicker
          align="start"
          side="top"
          triggerVariant="ghost"
          triggerClassName={cn(
            "h-8 px-2 py-1 sm:h-7 sm:px-2.5",
            COMPOSER_FOLDER_PICKER_CAPSULE_HOVER_CLASS_NAME,
            COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
          )}
          selectionMode="project"
          selectedProjectId={activeProject.id}
          selectedWorkspaceRoot={activeProject.cwd}
          showResetToHome
          onSelectProject={handleSelectProjectForEmptyDraft}
          onCreateProjectFromPath={handleCreateProjectFromPickerPath}
          onResetToHome={handleResetWorkspaceToHome}
        />
      ) : (
        emptyLandingProjectChip
      )}
      {/* Reserve the run-location/branch slot so project selection fades controls in
        without resizing. Codex order: project, where to run (Local), branch. */}
      <div
        aria-hidden={showEmptyLandingBranchToolbar ? undefined : true}
        className={cn(
          "flex min-w-0 flex-1 items-center transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
          showEmptyLandingBranchToolbar
            ? "translate-y-0 opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        {showEmptyLandingBranchToolbar ? (
          <BranchToolbar
            {...branchToolbarProps}
            className="mx-0 min-w-0 flex-1 !justify-start !px-0 !pb-0 !pt-0"
            showBranchSelector={isGitRepo}
            showEnvironmentPicker={isGitRepo || envMode === "worktree"}
          />
        ) : null}
      </div>
      {showEmptyLandingBranchToolbar ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={isThreadTemporary}
          onClick={toggleDraftTemporary}
          title={
            isThreadTemporary
              ? "Temporary chat — deleted when you leave. Click to keep it."
              : "Make this a temporary chat (deleted when you leave)"
          }
          aria-label="Temporary chat"
          className={cn(
            "ml-auto shrink-0 gap-1.5 whitespace-nowrap px-2 sm:px-2.5",
            COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME,
            COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
            isThreadTemporary && "!text-[var(--color-text-accent)]",
          )}
        >
          <TemporaryThreadIcon className="size-4" />
          <span className="sr-only sm:not-sr-only">Temporary</span>
        </Button>
      ) : null}
    </div>
  ) : null;

  const threadAutomationItems = automationsForThread(
    automationData.definitions,
    activeThread.id,
  ).map((definition) => ({ definition }));

  // Read from the two inputs it uses, not from the thread object, so the list keeps its
  // identity (and the Environment panel its render) while the thread streams.
  const environmentSidechats = activeThreadIsSidechat
    ? null
    : sourceThreadSidechats.map((sidechat) => ({
        id: sidechat.id,
        title: sidechat.title,
        expiredAt: sidechat.sidechatExpiredAt ?? null,
      }));
  // Shared inputs for both Environment panel surfaces (the header Popover when the dock is
  // open, and the docked right column when it is closed) so the two never drift.
  const environmentPanelProps: Omit<EnvironmentPanelProps, "open" | "variant"> = {
    gitCwd: threadWorkspaceCwd,
    openInTarget: threadWorkspaceCwd,
    githubRepository: githubRepositoryQuery.data?.repository ?? null,
    githubRepositories: githubRepositoryQuery.data?.repositories ?? [],
    isGitRepo,
    keybindings,
    availableEditors,
    activeThreadId: activeThread.id,
    activeProvider: activeThread.session?.provider ?? activeThread.modelSelection.provider,
    isGroupChat: isGroupContainer,
    groupFolderPath: isGroupContainer ? resolvedThreadWorkingDirectory : null,
    showGitActions,
    diffOpen: resolvedDiffOpen,
    threadAutomations: threadAutomationItems,
    sidechats: environmentSidechats,
    subagentRoster,
    subagentSourceThreadId: stripSourceThreadId,
    diffDisabledReason,
    diffTotals: repoDiffTotals,
    branchToolbar: activeThreadIsSidechat ? null : branchToolbarProps,
    recap: threadRecap,
    pinnedMessages,
    pinnedMessageTextById,
    notes: threadNotes,
    activeProjectId,
    projectInstructions,
    canCopyProjectInstructionsToNotes: !isLocalDraftThread,
    onProjectInstructionsChange: serverProjectInstructions.serverBacked
      ? serverProjectInstructions.onChange
      : setProjectInstructions,
    onCopyProjectInstructionsToNotes: handleCopyProjectInstructionsToNotes,
    onToggleDiff,
    onOpenAutomation: (definition: AutomationDefinition) => onOpenAutomation(definition.id),
    onOpenGithubRepository: openBrowserUrl,
    onJumpToPinnedMessage: handleJumpToPinnedMessage,
    onTogglePinnedMessageDone: handleTogglePinnedMessageDone,
    onUnpinMessage: handleUnpinMessage,
    onRenamePinnedMessage: handleRenamePinnedMessage,
    onNotesChange: handleNotesChange,
    onOpenEditorView: viewModeAction?.onClick ?? null,
    onClose: closeEnvironmentPanelAfterAction,
    onRegisterCommitAndPushTrigger,
  };
  // Full-width single chat: overlay plus transcript/composer inset. Floating overlay when the
  // column is already narrow — right dock open or a split pane (same as header compact mode).
  // Terminal surfaces always float so opening Environment never resizes the terminal workspace.
  const projectPanelVisible = projectPanelEnabled && auxiliarySurface === "project";
  const libraryPanelVisible = projectPanelEnabled && auxiliarySurface === "library";
  const environmentPanelVisibleEffective =
    environmentPanelVisible && auxiliarySurface !== "project" && auxiliarySurface !== "library";
  const environmentAppliesContentInset =
    (environmentPanelVisibleEffective || projectPanelVisible || libraryPanelVisible) &&
    !environmentUsesFloatingOverlay;
  const environmentOverlayVariant = environmentUsesFloatingOverlay ? "floating" : "docked";

  // Ambient preview rail: the live card sits below the Environment card and
  // the chat frees its gutter, so it never covers the transcript. Space is
  // reserved only for a card that actually has content (live phase + a landed
  // frame), at its fitted width — never for an armed or waiting session.
  const environmentInsetPx = environmentAppliesContentInset
    ? ENVIRONMENT_DOCKED_CONTENT_INSET_PX
    : 0;
  const previewCaps = computerPreviewCardCaps(
    settings.computerPreviewSize === "large" ? "large" : "compact",
  );
  const previewBudgetPx = computerPreviewBudgetPx({
    mainContentWidthPx: mainContentWidth,
    environmentInsetPx: environmentInsetPx,
    caps: previewCaps,
  });
  const previewReservesInset =
    environmentOverlayVariant === "docked" &&
    settings.autoOpenComputerPane &&
    previewSession?.phase === "live" &&
    (previewLayout?.hasFrame === true || previewLayout?.hasVisibleStatus === true) &&
    previewLayout?.floating !== true;
  const previewInsetPx = previewReservesInset
    ? Math.min(previewLayout?.width ?? previewBudgetPx, previewBudgetPx) + 24
    : 0;
  const contentInsetRightPx =
    environmentInsetPx + previewInsetPx > 0 ? environmentInsetPx + previewInsetPx : undefined;
  const environmentHeaderState = environmentEnabled
    ? {
        open: environmentPanelVisibleEffective,
        onOpenChange: setEnvironmentFromAuxiliary,
      }
    : null;
  const projectHeaderState = projectPanelEnabled
    ? {
        open: projectPanelVisible,
        onOpenChange: setProjectFromAuxiliary,
        attention:
          activeProject === undefined ? false : projectPanelNeedsAttention.has(activeProject.id),
      }
    : null;
  const libraryHeaderState = projectPanelEnabled
    ? {
        open: libraryPanelVisible,
        onOpenChange: setLibraryFromAuxiliary,
      }
    : null;
  const showComposerLiveChangesHeader = latestTurnLive && activeTurnLiveDiffState.hasChanges;
  const showComposerActiveTaskListCard = Boolean(activeTaskList && !planSidebarOpen);
  const activeThreadGoalText = activeThread?.goal?.trim() ?? "";
  const showComposerComputerControlEffortHint = shouldShowComputerControlEffortHint({
    enableComputerControl,
    computerControlAvailable,
    dismissed: settings.dismissedComputerControlEffortHint,
    provider: selectedProvider,
    traits: composerTraitSelection,
  });
  const startReplacementSidechat = () => {
    if (!activeThread) return;
    // A forked sidechat is replaced by its source thread's creator. A standalone one has no
    // source thread: the inbox that hosts it registers its replacement under its own id.
    const standalone = isStandaloneSidechatThread(activeThread);
    const creatorHostId = standalone ? activeThread.id : activeThread.sidechatSourceThreadId;
    if (!creatorHostId) return;
    void waitForSidechatCreator(creatorHostId)
      .then((createSidechat) => {
        if (!createSidechat) {
          toastManager.add({
            type: "warning",
            title: "Side chat is unavailable",
            description: standalone
              ? "Open the item in Code review before starting a new side chat."
              : "Open the parent chat before starting a replacement side chat.",
          });
          return;
        }
        return createSidechat();
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not start side chat",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the side chat.",
        });
      });
  };
  // The workflow card already lists its run and member agents, so the generic
  // "N background agents" footer only counts tasks outside the workflow.
  const composerBackgroundTaskCount = workflowRunState
    ? (activeBackgroundTasks?.taskIds.filter((taskId) => !workflowRunState.taskIds.includes(taskId))
        .length ?? 0)
    : (activeBackgroundTasks?.activeCount ?? 0);

  const composerSection =
    isSubagentPanel && readOnlyOverride === true ? null : shouldRenderChatPaneContent &&
      readOnlyOverride !== true ? (
      <div
        className={cn(isCenteredEmptyLandingVisible ? "w-full overflow-visible" : "contents")}
        // The transcript dissolves at this composer's top edge, so on a glass window it can
        // take the sheer raised tint instead of the dense overlay fill (see index.css).
        data-chat-composer-slot=""
        data-empty-landing-composer-block={isCenteredEmptyLandingVisible ? "true" : undefined}
        data-shell-surface="composer"
        data-shell-state={chatShellState}
      >
        {realtimeVoice.isMainThreadPresentationVisible ? (
          <RealtimeVoiceStage
            state={realtimeVoice.state}
            transcript={realtimeVoice.transcript}
            quota={realtimeVoice.quota}
            readOutputSignal={realtimeVoice.readOutputSignal}
            handoff={realtimeVoice.presentationHandoff}
            usesFadeTransition={
              realtimeVoice.canDetachToGlobalOverlay &&
              realtimeVoice.presentationSurface === "main-thread" &&
              realtimeVoice.presentationHandoff?.from === "global-overlay"
            }
            canDetachToGlobalOverlay={realtimeVoice.canDetachToGlobalOverlay}
            onDetachToGlobalOverlay={realtimeVoice.detachToGlobalOverlay}
            onConnectionHandoffComplete={realtimeVoice.completeLaunchHandoff}
          />
        ) : null}
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="relative z-10 w-full overflow-visible"
          data-chat-composer-form="true"
          data-chat-pane-scope={paneScopeId}
          data-moss-product-shell-composer={showMossControlPlane ? "true" : undefined}
          data-moss-visible-composer-shell="true"
          data-moss-visible-session-scope="true"
          data-moss-visible-thread-id={String(activeThread.id)}
          data-moss-visible-provider={mossVisibleComposerProvider}
          data-moss-visible-provider-instance={mossVisibleComposerProviderInstance}
          data-moss-visible-model={selectedModelSelection.model}
          data-moss-visible-session-status={mossVisibleComposerSessionStatus}
          // The send-phase/send-outcome diagnostic chain (markMossVisibleSendDiagnostic) is
          // part of the Moss send pipeline, which the merge intentionally replaces with the
          // upstream send path; the markers stay at their idle defaults here.
          data-moss-visible-send-phase="idle"
          data-moss-visible-send-outcome="idle"
          data-moss-visible-project-ready={activeProject ? "true" : "false"}
          data-moss-visible-active-turn-id={
            activeThread.session?.activeTurnId ? String(activeThread.session.activeTurnId) : ""
          }
        >
          <ComposerColumnFrame>
            {/* A bare wrapper keeps the normal-flow panels' -mb-px seam onto the input shell
                via margin collapse. */}
            <div data-composer-panels="">
              {/* Activity above the input floats as capsules; only queued follow-ups keep
                  the stacked rail fused onto the input. */}
              <ComposerCapsuleRow>
                <ComposerTransportNotice />
                {showComposerLiveChangesHeader ? (
                  <ComposerLiveChangesHeader
                    fileCount={activeTurnLiveDiffState.fileCount}
                    additions={activeTurnLiveDiffState.additions}
                    deletions={activeTurnLiveDiffState.deletions}
                    onReview={
                      activeTurnLiveDiffState.turnId ? onReviewComposerLiveChanges : undefined
                    }
                  />
                ) : null}
                {activeTaskList && showComposerActiveTaskListCard ? (
                  <ComposerActiveTaskListCard
                    activeTaskList={activeTaskList}
                    backgroundTaskCount={composerBackgroundTaskCount}
                    onOpenSidebar={() => setPlanSidebarOpen(true)}
                  />
                ) : null}
                {workflowRunState ? (
                  <WorkflowRunCapsule
                    workflowRun={workflowRunState}
                    onOpenThread={onNavigateToThread}
                    onStop={onStopWorkflowRun}
                    onPause={onPauseWorkflowRun}
                    onResume={onResumeWorkflowRun}
                    onDismiss={onDismissWorkflowRun}
                  />
                ) : null}
                {activeThreadGoalText.length > 0 && activeThread ? (
                  <ComposerGoalHeader
                    goal={activeThreadGoalText}
                    goalStartedAt={activeThread.goalStartedAt}
                    goalPausedAt={activeThread.goalPausedAt}
                    canPause={isServerThread}
                    onEdit={editThreadGoalInComposer}
                    onSetPaused={async (paused) => {
                      await setThreadGoalPaused(paused);
                    }}
                    onClear={clearThreadGoal}
                  />
                ) : null}
                {pendingBackgroundWorkCount > 0 ? (
                  <ComposerPendingBackgroundWorkRow count={pendingBackgroundWorkCount} />
                ) : null}
                {showComposerComputerControlEffortHint ? (
                  <ComposerComputerControlEffortHint
                    onApply={applyComputerControlEffortHint}
                    onDismiss={dismissComputerControlEffortHint}
                  />
                ) : null}
                {showClaudeModelSwitchNote ? (
                  <ComposerTipRow
                    icon={
                      <RefreshCwIcon
                        aria-hidden="true"
                        className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME}
                      />
                    }
                    message={
                      selectedProvider === "claudeAgent"
                        ? "Next reply may use more Claude allowance."
                        : "Chat context uses the new provider’s allowance."
                    }
                    onDismiss={() => setDismissedClaudeSwitchKey(claudeSwitchKey)}
                    testId="composer-claude-model-switch-note"
                  />
                ) : null}
                <ComposerPullRequestAutoFixHint
                  threadId={threadId}
                  isServerThread={isServerThread}
                  pullRequest={gitStatusQuery.data?.pr ?? null}
                  isWorking={isWorking}
                />
              </ComposerCapsuleRow>
              {isSidechatExpired ? (
                <ExpiredSidechatNotice onStartNew={startReplacementSidechat} />
              ) : null}
              <ComposerQueuedHeader
                queuedTurns={queuedComposerTurns}
                onSteer={onSteerQueuedComposerTurn}
                onRemove={removeQueuedComposerTurn}
                onEdit={onEditQueuedComposerTurn}
                steerSkipsCompaction={queuedSteerSkipsCompaction}
                pause={queuePause}
                onResume={onResumeQueuedComposerTurns}
                onEditPaused={onEditPausedQueuedComposerTurn}
                cwd={threadWorkspaceCwd ?? undefined}
              />
              {isCoordinatorConversation && activeThread ? (
                <HubPendingApprovals
                  threadIds={hubApprovalThreadIds}
                  hubProjectId={activeThread.projectId}
                  coordinatorThreadId={activeThread.id}
                  onOpenThread={onNavigateToThread}
                />
              ) : null}
              {settledThreadBranchMismatch ? (
                <div className="pb-2">
                  <ComposerBranchMismatchBanner {...settledThreadBranchMismatch} />
                </div>
              ) : null}
              {/* Pending approvals and AskUserQuestion prompts both render as a detached
                  card floating just above the composer (padding gives the measured gap),
                  instead of a banner fused into the composer surface. An approval takes
                  precedence and suppresses the question card while one is active. */}
              {shouldShowHubPendingApprovals({
                groupsOn: GROUPS_ON,
                isCoordinatorConversation,
                hasActiveThread: activeThread != null,
              }) && activeThread ? (
                <HubPendingApprovals
                  threadIds={hubApprovalThreadIds}
                  hubProjectId={activeThread.projectId}
                  coordinatorThreadId={activeThread.id}
                  onOpenThread={onNavigateToThread}
                />
              ) : null}
              {isServerThread && activeThread ? (
                // Keyed by thread so a switch never shows the previous thread's waiting
                // messages while the card re-opens.
                <GuestPendingMessages
                  key={`guest-pending:${activeThread.id}`}
                  threadId={activeThread.id}
                  onImageExpand={setExpandedImage}
                />
              ) : null}
              {activePendingApproval ? (
                <ComposerStackedHeaderFrame
                  className="mx-auto mb-0 w-14/15 pb-2"
                  data-moss-visible-permission-request="true"
                  data-moss-visible-permission-request-id={String(activePendingApproval.requestId)}
                  data-moss-visible-permission-count={pendingApprovals.length}
                >
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                    isResponding={respondingRequestKeys.includes(
                      pendingRequestInstanceKey(
                        activePendingApproval.requestId,
                        activePendingApproval.lifecycleGeneration,
                      ),
                    )}
                    onRespond={onRespondToApproval}
                  />
                </ComposerStackedHeaderFrame>
              ) : pendingUserInputs.length > 0 ? (
                <div className="pb-2">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    submissionVersion={userInputSubmissionVersion}
                    isResponding={activePendingIsResponding}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onToggleActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onPrevious={onPreviousActivePendingUserInputQuestion}
                    onCancel={onCancelActivePendingUserInput}
                  />
                </div>
              ) : null}
              {activeThread?.claudeCacheReview &&
              isClaudeCacheReviewPanelVisible(activeThread.claudeCacheReview) ? (
                <div className="pb-2">
                  <ComposerClaudeCacheReviewPanel
                    key={`${threadId}:${activeThread.claudeCacheReview.reviewId}`}
                    review={activeThread.claudeCacheReview}
                    compactDisabledReason={claudeCompactDisabledReason}
                    isCompactionRequest={cacheReviewIsCompactionRequest}
                    onRespond={onRespondToClaudeCacheReview}
                  />
                </div>
              ) : null}
              {expiredQuestionDrafts[0] &&
              pendingUserInputs.length === 0 &&
              !activePendingApproval ? (
                <ComposerExpiredUserInputNotice
                  threadId={threadId}
                  requestKey={expiredQuestionDrafts[0][0]}
                  draft={expiredQuestionDrafts[0][1]}
                  onRestore={(nextPrompt) => {
                    promptRef.current = nextPrompt;
                    setComposerCursor(
                      collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
                    );
                    scheduleComposerFocus();
                  }}
                />
              ) : null}
              {emptyLandingControls}
              {imageGenerationLimitBannerVisible &&
              imageGenerationLimitFailure &&
              imageGenerationLimitPresentation ? (
                <div className="pb-2">
                  <ImageGenerationLimitBanner
                    failure={imageGenerationLimitFailure}
                    nowMs={Date.now()}
                    onDismiss={dismissImageGenerationLimitBanner}
                    onPrimaryAction={
                      imageGenerationLimitPresentation.action
                        ? openImageGenerationLimitAction
                        : undefined
                    }
                    presentation={imageGenerationLimitPresentation}
                  />
                </div>
              ) : null}
            </div>
            <div
              className={cn(
                COMPOSER_INPUT_SHELL_CLASS_NAME,
                composerProviderState.composerFrameClassName,
                composerOverlayOpen && !isComposerApprovalState && "overflow-visible",
                isSidechatExpired && "pointer-events-none opacity-60",
                isThreadDragOverComposer && "ring-1 ring-info/65",
              )}
              aria-disabled={isSidechatExpired}
              data-composer-layout={composerSingleRow ? "row" : undefined}
              {...threadMentionDropzoneProps}
            >
              <div
                data-chat-composer-surface=""
                className={cn(
                  COMPOSER_INPUT_SURFACE_CLASS_NAME,
                  composerProviderState.composerSurfaceClassName,
                  composerSingleRow && COMPOSER_SINGLE_ROW_SURFACE_CLASS_NAME,
                  composerOverlayOpen && !isComposerApprovalState && "overflow-visible",
                )}
              >
                <ComposerInputBanners
                  roundedTopReset={false}
                  planFollowUp={
                    !activePendingApproval &&
                    pendingUserInputs.length === 0 &&
                    showPlanFollowUpPrompt &&
                    activeProposedPlan
                      ? {
                          id: activeProposedPlan.id,
                          title: proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null,
                        }
                      : null
                  }
                  automationSetup={
                    !activePendingApproval &&
                    pendingUserInputs.length === 0 &&
                    pendingAutomationConversation &&
                    pendingAutomationConversation.threadId === threadId
                      ? { onCancel: cancelAutomationConversation }
                      : null
                  }
                  snooze={
                    serverThread?.snoozedUntil != null && serverThread.archivedAt == null
                      ? {
                          snoozedUntil: serverThread.snoozedUntil,
                          onReturnNow: () => void dispatchThreadSnoozedUntil(serverThread.id, null),
                          onReschedule: (duration) =>
                            void dispatchThreadSnoozedUntil(
                              serverThread.id,
                              resolveSnoozeDeadline(duration, Date.now()).toISOString(),
                            ),
                        }
                      : null
                  }
                />
                <div
                  className={cn(
                    composerSingleRow
                      ? COMPOSER_SINGLE_ROW_EDITOR_CLASS_NAME
                      : COMPOSER_EDITOR_PADDING_CLASS_NAME,
                    // While dictating, the recorder bar takes the editor's cell.
                    composerSingleRow && (isVoiceRecording || isVoiceTranscribing) && "hidden",
                    composerOverlayOpen && !isComposerApprovalState && "overflow-visible",
                  )}
                >
                  {composerOverlayOpen && !isComposerApprovalState ? (
                    <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                      {composerExtrasPanelOpen ? (
                        <ComposerExtrasPanel
                          panelId={COMPOSER_EXTRAS_PANEL_ID}
                          interactionMode={interactionMode}
                          supportsFastMode={composerTraitSelection.caps.supportsFastMode}
                          fastModeEnabled={composerTraitSelection.fastModeEnabled}
                          threadId={threadId}
                          onAddAttachments={addComposerAttachments}
                          onToggleFastMode={toggleFastMode}
                          onInteractionModeChange={handleInteractionModeChange}
                          onInsertGoal={insertGoalSlashCommandInComposer}
                          onClose={() => {
                            setIsComposerExtrasPanelOpen(false);
                            scheduleComposerFocus();
                          }}
                        />
                      ) : isLocalFolderBrowserOpen ? (
                        <ComposerLocalDirectoryMenu
                          mentionQuery={mentionTriggerQuery}
                          rootLabel={localFolderBrowseRootPath ?? "Local folders unavailable"}
                          homeDir={serverConfigQuery.data?.homeDir ?? null}
                          onSelectEntry={(absolutePath) =>
                            handleSelectLocalDirectoryMention(absolutePath)
                          }
                          onNavigateFolder={handleNavigateLocalFolder}
                          handleRef={localDirectoryMenuRef}
                        />
                      ) : (
                        <ComposerCommandMenu
                          items={composerMenuItems}
                          resolvedTheme={resolvedTheme}
                          isLoading={isComposerMenuLoading}
                          triggerKind={
                            composerCommandPicker !== null
                              ? "slash-command"
                              : effectiveComposerTriggerKind
                          }
                          activeItemId={activeComposerMenuItem?.id ?? null}
                          onHighlightedItemChange={onComposerMenuItemHighlighted}
                          onSelect={onSelectComposerItem}
                        />
                      )}
                    </div>
                  ) : null}
                  {!isComposerApprovalState &&
                    pendingUserInputs.length === 0 &&
                    isPreparingComposerImages && (
                      <div
                        className="flex items-center gap-1.5 px-1 text-ui leading-snug text-muted-foreground"
                        role="status"
                      >
                        <LoaderCircleIcon className="size-4 animate-spin" />
                        Optimizing {pendingComposerImageCount === 1 ? "image" : "images"}…
                      </div>
                    )}
                  {!isComposerApprovalState &&
                    pendingUserInputs.length === 0 &&
                    (composerAssistantSelections.length > 0 ||
                      composerBrowserAnnotations.length > 0 ||
                      composerFileComments.length > 0 ||
                      composerPastedTexts.length > 0 ||
                      composerPullRequestContexts.length > 0 ||
                      composerFiles.length > 0 ||
                      composerImages.length > 0) && (
                      <ComposerReferenceAttachments
                        assistantSelections={composerAssistantSelections}
                        browserAnnotations={composerBrowserAnnotations}
                        fileComments={composerFileComments}
                        pastedTexts={composerPastedTexts}
                        pullRequestContexts={composerPullRequestContexts}
                        files={composerFiles}
                        images={composerImages}
                        nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                        onExpandImage={setExpandedImage}
                        onRemoveAssistantSelections={clearComposerAssistantSelectionsFromDraft}
                        onRemoveBrowserAnnotation={removeComposerBrowserAnnotationFromDraft}
                        onRemoveFileComments={clearComposerFileCommentsFromDraft}
                        onRemovePastedText={removeComposerPastedTextFromDraft}
                        onShowPastedTextInField={showComposerPastedTextInField}
                        onRemovePullRequestContext={removeComposerPullRequestContextFromDraft}
                        onRemoveFile={removeComposerFile}
                        onRemoveImage={removeComposerImage}
                      />
                    )}
                  {/* Keep chrome mounted; reset only the editor's undo history per chat. */}
                  <ComposerPromptEditor
                    key={threadId}
                    ref={composerEditorRef}
                    value={
                      isComposerApprovalState
                        ? ""
                        : activePendingProgress
                          ? activePendingProgress.customAnswer
                          : prompt
                    }
                    cursor={composerCursor}
                    terminalContexts={
                      !isComposerApprovalState && pendingUserInputs.length === 0
                        ? composerTerminalContexts
                        : []
                    }
                    mentionReferences={selectedComposerMentions}
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onChange={handlePromptChange}
                    onCommandKeyDown={handleComposerCommandKey}
                    onPaste={handleComposerPaste}
                    prediction={composerPromptPrediction}
                    {...(canCollapsePastedTextToDraft
                      ? { onCollapsePastedText: handleCollapsePastedText }
                      : {})}
                    placeholder={
                      isComposerApprovalState
                        ? "Resolve this approval request to continue"
                        : activePendingProgress
                          ? activePendingProgress.activeQuestion?.options.length === 0
                            ? "Type your answer to continue"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : activeThread?.parentThreadId
                              ? "Message this subagent"
                              : hasLiveTurn
                                ? "Ask for follow-up changes"
                                : standaloneSidechatContext
                                  ? `Ask about this ${standaloneSidechatItemNoun}`
                                  : "Do anything in Moss"
                    }
                    disabled={isComposerEditorDisabled}
                    singleLine={composerSingleRow}
                  />
                </div>
                {/* Bottom toolbar — hidden while an approval takes over the composer,
                    since the approve/decline actions live in the detached approval card
                    floating above (see ComposerPendingApprovalPanel). */}
                {activePendingApproval ? null : (
                  <ChatComposerFooter
                    layout={composerSingleRow ? "row" : "block"}
                    resumeControl={
                      composerResumeEligible || isResumePendingForCurrentThread
                        ? composerResumeControl
                        : null
                    }
                    sendState={mossVisibleComposerSendState}
                    realtimeVoice={{
                      active: isRealtimeVoiceCurrentThreadActive,
                      controls: (
                        <RealtimeVoiceComposerControls
                          state={realtimeVoice.state}
                          onStop={() => void realtimeVoice.stop()}
                          onToggleInputMuted={realtimeVoice.toggleInputMuted}
                          onToggleOutputMuted={realtimeVoice.toggleOutputMuted}
                        />
                      ),
                      button: !realtimeVoice.isVisible ? (
                        <ComposerRealtimeVoiceButton
                          mode={isRealtimeVoiceActiveInAnotherThread ? "return" : "start"}
                          disabled={
                            (!isRealtimeVoiceActiveInAnotherThread && !realtimeVoice.canStart) ||
                            isComposerApprovalState ||
                            isConnecting ||
                            isSendBusy
                          }
                          busy={
                            realtimeVoice.state.phase === "reserving" ||
                            realtimeVoice.state.phase === "presenting" ||
                            realtimeVoice.state.phase === "starting"
                          }
                          onClick={() => {
                            if (isRealtimeVoiceActiveInAnotherThread) {
                              realtimeVoice.openOwningThread();
                              return;
                            }
                            requestRealtimeVoiceStart();
                          }}
                        />
                      ) : null,
                    }}
                    isComposerFooterCompact={isComposerFooterCompact}
                    leadingControls={
                      composerStatusBelow
                        ? composerExtrasTrigger
                        : relocateComposerLeadingControls
                          ? null
                          : renderComposerLeadingControls({ iconOnly: false })
                    }
                    composerPickerControls={composerStatusBelow ? null : composerPickerControls}
                    contextMeter={composerStatusBelow ? null : composerContextMeter}
                    interactionMode={interactionMode}
                    resetInteractionMode={handleResetInteractionMode}
                    sidebarAction={
                      activeTaskList || sidebarProposedPlan || planSidebarOpen
                        ? {
                            title: planSidebarToggleTitle,
                            label: planSidebarToggleLabel,
                            onClick: togglePlanSidebar,
                          }
                        : null
                    }
                    voice={{
                      enabled: showVoiceNotesControl,
                      recording: isVoiceRecording,
                      starting: isVoiceStarting,
                      waitingForAudio: isVoiceWaitingForAudio,
                      transcribing: isVoiceTranscribing,
                      durationLabel: voiceRecordingDurationLabel,
                      waveformLevels: voiceWaveformLevels,
                      onCancel: cancelComposerVoiceRecording,
                      onSubmit: submitComposerVoiceRecording,
                      onToggle: toggleComposerVoiceRecording,
                    }}
                    pendingInput={
                      activePendingProgress
                        ? {
                            progress: activePendingProgress,
                            responding: activePendingIsResponding,
                            answersComplete: Boolean(activePendingResolvedAnswers),
                          }
                        : null
                    }
                    submission={{
                      phase,
                      busy: isSendBusy,
                      connecting: isConnecting,
                      expired: isSidechatExpired,
                      hasPendingCacheReview: activeThread?.claudeCacheReview != null,
                      preparingImages: isPreparingComposerImages,
                      preparingWorktree: isPreparingWorktree,
                      hasContent: composerSendState.hasSendableContent,
                      hasPendingUserInputs: pendingUserInputs.length > 0,
                      showPlanFollowUp: showPlanFollowUpPrompt,
                      hasPrompt: prompt.trim().length > 0,
                      onInterrupt: onInterruptFromStopControl,
                      onImplementInNewThread: onImplementPlanInNewThread,
                    }}
                  />
                )}
              </div>
            </div>
          </ComposerColumnFrame>
        </form>
      </div>
    ) : (
      <div
        aria-hidden="true"
        className="w-full overflow-visible"
        data-chat-composer-form="deferred"
        data-shell-surface="composer"
        data-shell-state={chatShellState}
      >
        <div
          className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, COMPOSER_COLUMN_FRAME_CLASS_NAME)}
          style={{ height: 88 }}
        />
      </div>
    );

  const chatView = (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
      data-shell-surface="chat"
      data-shell-state={chatShellState}
      data-moss-product-shell={showMossControlPlane ? "true" : undefined}
      data-presentation-mode={presentationMode}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {/* Subtle accent tint over the whole pane while a file is dragged anywhere over it,
          signalling that dropping it will attach the file to the composer. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-50 transition-opacity duration-150",
          "bg-info/8 ring-1 ring-inset ring-info/30",
          isDragOverComposer ? "opacity-100" : "opacity-0",
        )}
      />
      <RealtimeVoiceOnboarding
        open={realtimeVoiceOnboardingOpen}
        onClose={() => {
          if (readPendingRealtimeVoiceLaunch() === "onboarding") {
            writePendingRealtimeVoiceLaunch(null);
          }
          setRealtimeVoiceOnboardingOpen(false);
        }}
        onCompleteStart={() => {
          writePendingRealtimeVoiceLaunch("start");
          realtimeVoiceOnboardingLaunchObservedRef.current = false;
          setRealtimeVoiceOnboardingPendingCompletion(true);
          return startPendingRealtimeVoiceLaunch("start").then((accepted) => {
            if (accepted) return;
            writePendingRealtimeVoiceLaunch("onboarding");
            realtimeVoiceOnboardingLaunchObservedRef.current = false;
            setRealtimeVoiceOnboardingPendingCompletion(false);
            setRealtimeVoiceOnboardingOpen(true);
          });
        }}
      />
      <RealtimeVoiceViewportLayer visible={isRealtimeVoiceModalVisible}>
        <RealtimeVoiceLaunchOverlay
          visible={realtimeVoice.isLaunchOverlayVisible}
          failed={realtimeVoice.launchFailed}
          connected={realtimeVoice.isLaunchConnected}
          handoffComplete={realtimeVoice.launchHandoffComplete}
          error={realtimeVoice.error ?? realtimeVoice.state.error}
          onHandoffComplete={realtimeVoice.completeLaunchHandoff}
          onRetry={() => void realtimeVoice.retry()}
          onBack={realtimeVoice.dismissFailure}
        />
      </RealtimeVoiceViewportLayer>
      <div
        className="contents"
        aria-hidden={isRealtimeVoiceModalVisible ? true : undefined}
        inert={isRealtimeVoiceModalVisible ? true : undefined}
        data-moss-realtime-voice-background={isRealtimeVoiceModalVisible ? "inert" : "interactive"}
      >
        <ChatSurfaceHeader
          hidden={hideHeader}
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            !isEditorRail && CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "flex items-center",
            isEditorRail ? "h-10" : CHAT_SURFACE_HEADER_HEIGHT_CLASS,
            isElectron && "drag-region",
            // The editor-rail chat header sits in the editor's second row (inside the
            // right-side chat pane), not flush against the window edges — the editor's
            // own top bar already reserves both desktop window-control gutters. Applying
            // them here just leaves redundant empty space on the sides.
            !isEditorRail && desktopTopBarTrafficLightGutterClassName,
            !isEditorRail && desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <ChatHeader
            activeThreadId={activeThread.id}
            activeThreadTitle={activeThreadDisplayTitle}
            activeThreadEntryPoint={terminalState.entryPoint}
            activeProvider={activeThread.session?.provider ?? activeThread.modelSelection.provider}
            activeProjectName={isEditorRail ? undefined : activeProjectDisplayName}
            threadBreadcrumbs={threadBreadcrumbs}
            {...(isEditorRail
              ? { className: cn(CHAT_SURFACE_HEADER_PADDING_X_CLASS, "h-full") }
              : {})}
            {...(showOpenThreadTabs
              ? {
                  threadTabs: (
                    <OpenThreadTabStrip
                      activeThreadId={activeThread.id}
                      keybindings={keybindings}
                      closeActiveTabRef={closeActiveThreadTabRef}
                      onRenameActiveThread={() => setRenameDialogOpen(true)}
                      onNewThread={
                        activeProjectScripts !== undefined && !isCenteredEmptyLanding
                          ? onNewThreadFromHeader
                          : null
                      }
                    />
                  ),
                }
              : {})}
            isSidechat={isSidechatThread(activeThread)}
            hideSidebarControls={isEditorRail}
            hideHandoffControls={terminalWorkspaceTerminalTabActive || isEditorRail}
            minimalChrome={isCenteredEmptyLanding}
            isGitRepo={isGitRepo}
            openInTarget={threadWorkspaceCwd}
            activeProjectScripts={isEditorRail ? undefined : activeProjectScripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            diffToggleShortcutLabel={diffPanelShortcutLabel}
            handoffActionLabel={handoffActionLabel}
            handoffDisabled={handoffDisabled}
            handoffActionTargets={handoffTargets}
            continueHandoffActionTargets={continueHandoffTargets}
            showHandoffAction={handoffAvailability.providerHandoff}
            gitCwd={threadWorkspaceCwd}
            diffTotals={repoDiffTotals}
            showGitActions={showGitActions && !isEditorRail}
            showDiffToggle={!isEditorRail}
            diffOpen={resolvedDiffOpen}
            diffDisabledReason={diffDisabledReason}
            rightDockOpen={rightDockOpen}
            {...(onToggleRightDock ? { onToggleRightDock } : {})}
            rightDockShortcutLabel={rightPanelShortcutLabel}
            environment={isEditorRail ? null : environmentHeaderState}
            projectPanel={isEditorRail ? null : projectHeaderState}
            libraryPanel={isEditorRail ? null : libraryHeaderState}
            surfaceMode={surfaceMode}
            editorChatControls={
              isEditorRail && activeProject
                ? {
                    projectId: activeProject.id,
                    activeSurface: terminalWorkspaceTerminalTabActive ? "terminal" : "chat",
                    terminalAvailable: terminalState.terminalOpen,
                    terminalHasRunningActivity: terminalState.runningTerminalIds.length > 0,
                    onNewChat: onNewEditorChat,
                    onNewTerminal: onOpenEditorTerminal,
                    onOpenChat: onOpenEditorChat,
                    onOpenTerminal: onOpenEditorTerminal,
                    onCloseTerminal: onCloseEditorTerminal,
                  }
                : null
            }
            onRunProjectScript={onRunProjectScriptFromHeader}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
            onToggleDiff={onToggleDiff}
            onRegisterCommitAndPushTrigger={onRegisterCommitAndPushTrigger}
            onCreateHandoff={onCreateHandoffThread}
            onContinueHandoff={onContinueHandoffInThread}
            onNavigateToThread={onNavigateToThread}
            onRenameThread={() => setRenameDialogOpen(true)}
            {...(onCloseThreadPane ? { onCloseThreadPane } : {})}
          />
        </ChatSurfaceHeader>

        {/* Floating find panel — a root-level overlay so it sits on top of the
          header and the docked Environment panel at the pane's top-right. */}
        {shouldRenderChatPaneContent ? (
          <ChatThreadFindHost
            open={threadFindOpen}
            focusNonce={threadFindFocusNonce}
            timelineEntries={timelineEntries}
            threadId={threadId}
            className={cn(
              terminalWorkspaceTerminalTabActive && "invisible",
              !isEditorRail && desktopTopBarWindowControlsGutterClassName,
            )}
            onClose={() => setThreadFindOpen(false)}
            onJump={handleThreadFindJump}
            onHighlightChange={threadFindHighlightStore.set}
            onActiveMatchChange={handleThreadFindActiveMatchChange}
          />
        ) : null}

        <RenameThreadDialog
          open={renameDialogOpen}
          currentTitle={activeThread.title}
          onOpenChange={setRenameDialogOpen}
          onSave={handleRenameActiveThread}
        />
        {visibleMossQuotaDecision !== null ? (
          <MossQuotaExhaustedSurface
            decision={visibleMossQuotaDecision}
            key={visibleMossQuotaDecisionKey}
            onOpenPlans={() => {
              void navigate({ to: "/membership", search: { focus: "plans" } });
            }}
          />
        ) : null}
        {automationCreationPending ? (
          <AutomationCreationPendingDialog
            open={automationCreationPendingOpen}
            pending={automationCreationPending}
            error={automationCreationError}
            busy={isAutomationDraftSubmitting}
            onOpenChange={setAutomationCreationPendingOpen}
            onRetry={() => void retryAutomationCreation()}
          />
        ) : automationDraftForm ? (
          <AutomationDialog
            open={automationDraftOpen}
            form={automationDraftForm}
            projects={automationProjects}
            threads={automationThreads}
            warnings={automationDraftWarnings}
            acknowledgedWarningIds={acknowledgedAutomationWarnings}
            onToggleWarning={toggleAutomationWarning}
            onOpenChange={setAutomationDraftDialogOpen}
            onFormChange={updateAutomationDraftForm}
            onSubmit={submitAutomationDraft}
            busy={isAutomationDraftSubmitting}
            submitError={automationCreationError}
          />
        ) : null}

        {/* Thread-level errors surface in flow at the top of the transcript
          pane (see `ThreadErrorBanner`) so they never cover message content;
          a toast only fires for a live error on a thread that is not
          currently visible (see `useThreadErrorToast`). */}
        <ProviderHealthBanner
          status={shouldShowProviderHealthBanner ? visibleActiveProviderStatus : null}
          onDismiss={dismissActiveProviderHealthBanner}
        />
        <RateLimitBanner
          rateLimitStatus={visibleActiveRateLimitStatusForRender}
          onDismiss={dismissActiveRateLimitBanner}
        />
        {terminalWorkspaceOpen && !isEditorRail ? (
          <TerminalWorkspaceTabs
            activeTab={terminalState.workspaceActiveTab}
            isWorking={isWorking}
            terminalHasRunningActivity={terminalState.runningTerminalIds.length > 0}
            workspaceLayout={terminalState.workspaceLayout}
            onSelectTab={setTerminalWorkspaceTab}
            onClose={onCloseEditorTerminal}
          />
        ) : null}
        {showMossControlPlane && shouldRenderChatPaneContent ? (
          <MossNativeShellAccessStrip
            activeSurface={mossNativeSurface}
            onSurfaceChange={setMossNativeSurface}
            providerLabel={mossVisibleComposerProvider}
            productizationMode={mossShellProductization.mode}
            productizationSource={mossShellProductization.source}
            sessionStatus={mossVisibleComposerSessionStatus}
            threadId={activeThread.id}
          />
        ) : null}
        {/* Main content area with optional plan sidebar */}
        <div ref={mainContentRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* Chat column */}
          {/* 18px end padding shifts the centered 48rem column so the approval
              card's gutters match the Codex frame (about 131 left, 149 right). */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col pe-[18px]">
            <div
              aria-hidden={terminalWorkspaceTerminalTabActive}
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
              )}
            >
              {shouldRenderChatPaneContent && isCenteredEmptyLandingVisible ? (
                <div
                  className={cn(
                    "chat-pane-enter relative flex min-h-0 flex-1 flex-col",
                    CHAT_COLUMN_GUTTER_CLASS_NAME,
                  )}
                  data-shell-surface="chat-empty-state"
                  data-shell-state={chatShellState}
                >
                  {/* The heading floats centered in the space above the composer, which is
                    anchored to the bottom of the pane (with its workspace-tools rail
                    stacked on top of the input) so starting a chat keeps the composer
                    where it lives for the rest of the conversation. */}
                  <div className="relative flex min-h-0 flex-1 items-center justify-center">
                    {/* Codex-style hero: glyph plus one question, nothing else. Suggestions
                      and import prompts stay on demand (sidebar / "+" menu / settings). */}
                    <div
                      className={cn(
                        "flex flex-col items-center gap-4 px-6 text-center select-none",
                        CHAT_COLUMN_FRAME_CLASS_NAME,
                      )}
                      data-shell-surface="chat-empty-hero"
                      data-shell-state={chatShellState}
                    >
                      <MossLogo aria-label="Moss logo" className="size-12" />
                      <h2
                        data-testid="empty-landing-heading"
                        aria-label={
                          isEmptyChatLanding
                            ? "What should we build?"
                            : `What should we build in ${activeProjectDisplayName ?? "this folder"}?`
                        }
                        data-hero-heading="true"
                        className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]"
                      >
                        {isEmptyChatLanding ? (
                          "What should we build?"
                        ) : (
                          <>
                            {"What should we build in "}
                            {showEmptyLandingProjectPicker ? (
                              <ProjectPicker
                                align="center"
                                side="bottom"
                                selectionMode="project"
                                selectedProjectId={activeProject.id}
                                selectedWorkspaceRoot={activeProject.cwd}
                                showResetToHome
                                onSelectProject={handleSelectProjectForEmptyDraft}
                                onCreateProjectFromPath={handleCreateProjectFromPickerPath}
                                onResetToHome={handleResetWorkspaceToHome}
                                renderTrigger={
                                  <button
                                    type="button"
                                    data-testid="empty-landing-heading-project-trigger"
                                    data-translation-skip="true"
                                    className="cursor-pointer rounded-sm text-inherit underline decoration-dotted decoration-[1.5px] underline-offset-[6px] transition-colors duration-150 ease-out hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                                  >
                                    {activeProjectDisplayName ?? "this folder"}
                                  </button>
                                }
                              />
                            ) : (
                              <span className="text-inherit" data-translation-skip="true">
                                {activeProjectDisplayName ?? "this folder"}
                              </span>
                            )}
                            {"?"}
                          </>
                        )}
                      </h2>
                    </div>
                  </div>
                  <div className="relative w-full shrink-0 pb-3 sm:pb-4">
                    {imageComposerHost?.target
                      ? createPortal(composerSection, imageComposerHost.target)
                      : composerSection}
                    {relocateComposerLeadingControls ? (
                      <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                        <div className="flex w-full items-center gap-1">
                          <div className="flex shrink-0 items-center gap-1 pl-1">
                            {renderComposerLeadingControls({ iconOnly: true })}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {shouldRenderChatPaneContent && !isCenteredEmptyLandingVisible ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                    <ChatTranscriptPane
                      activeThreadId={activeThread.id}
                      activeTurnId={activeTurnIdForTranscript}
                      agentActivityDetail={openAgentActivityDetail}
                      hasMessages={timelineEntries.length > 0}
                      isWorking={isWorking}
                      suppressWorkingIndicator={activePendingApproval?.requestKind === "command"}
                      workingLabel={resolveWorkingLabel({
                        isSettlingTurnDispatch,
                        isSendBusy,
                        turnTakenOver,
                        isConnecting,
                        providerName: providerDisplayName,
                        ...(providerRetryLabel ? { retryLabel: providerRetryLabel } : {}),
                      })}
                      worktreeSetup={activeWorktreeSetup}
                      worktreeSetupPendingAction={worktreeSetupPendingAction}
                      onResolveWorktreeSetup={onResolveWorktreeSetup}
                      activeTurnInProgress={activeTurnInProgress}
                      subagentsRunning={hasRunningSubagents}
                      subagentRun={subagentRunContext}
                      runningSubagentRun={runningSubagentRun}
                      subagentThread={subagentThread}
                      collapseFinishedTurns={settings.collapseFinishedTurns}
                      activeTurnStartedAt={activeWorkStartedAt}
                      listRef={legendListRef}
                      timelineControllerRef={timelineControllerRef}
                      findHighlightStore={threadFindHighlightStore}
                      pinnedMessageIds={pinnedMessageIds}
                      canPinMessage={canPinMessage}
                      onTogglePinMessage={handleTogglePinMessageGuarded}
                      onForkFromMessage={handleForkFromMessage}
                      goalAchievements={goalAchievements}
                      enteringUserMessageIds={enteringUserMessageIds}
                      tailAnchorMessageId={
                        settings.anchorSentMessagesToTop &&
                        tailAnchor !== null &&
                        tailAnchor.threadId === activeThread.id
                          ? tailAnchor.messageId
                          : null
                      }
                      tailAnchorScrollInFlightRef={tailAnchorScrollInFlightRef}
                      crossTaskOrigin={resolvedCrossTaskOrigin}
                      forkSource={forkSource}
                      isTemporaryThread={isThreadTemporary}
                      isLocalDraft={isLocalDraftThread}
                      isProjectImport={activeThread.isProjectImport === true}
                      timelineEntries={timelineEntries}
                      messageChangeSignal={timelineMessages}
                      turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                      turnTimingByTurnId={turnTimingByTurnId}
                      conversationOnly={isCoordinatorConversation}
                      hubWorkItemsByMessageId={hubWorkItemsByMessageId}
                      threadError={
                        quotaOwnedActiveThreadError === null ? (activeThread?.error ?? null) : null
                      }
                      recoverableTurnId={
                        activeLatestTurnState === "error" ? activeLatestTurnId : null
                      }
                      turnRecoveryDisabled={
                        isSendBusy ||
                        isConnecting ||
                        isWorking ||
                        pendingApprovals.length > 0 ||
                        pendingUserInputs.length > 0
                      }
                      onContinueFailedTurn={onContinueFailedTurn}
                      onChangeRecoveryModel={() => handleModelPickerOpenChange(true)}
                      unblockingThread={unblockingActiveThread}
                      onDismissThreadError={dismissActiveThreadError}
                      {...(canRetryActiveThreadStart
                        ? { onRetryThreadError: retryActiveThreadStart }
                        : {})}
                      onUnblockThread={unblockThread}
                      onOpenTurnDiff={onOpenTurnDiff}
                      {...(onOpenHtmlDocument ? { onOpenHtmlDocument } : {})}
                      onOpenThread={onNavigateToThread}
                      onOpenAutomation={onOpenAutomation}
                      {...(threadDetailSyncState === "cached" ? {} : { onStopBackgroundTask })}
                      computerControlEnabled={enableComputerControl}
                      onEnableComputerControl={handleEnableComputerControlFromDenial}
                      revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                      onRevertUserMessage={onRevertUserMessage}
                      onUndoTurnFiles={onUndoTurnFiles}
                      onEditUserMessage={onEditUserMessage}
                      onRespondToAsyncUserInput={onRespondToAsyncUserInput}
                      editableUserMessageId={editableUserMessageId}
                      isRevertingCheckpoint={isRevertingCheckpoint}
                      onExpandTimelineImage={onExpandTimelineImage}
                      followLiveOutput={!isUserScrollDetached}
                      animateTailAnchorSlide={!hasStreamingAssistantText}
                      onIsAtEndChange={onIsAtEndChange}
                      onNavigate={onTranscriptNavigate}
                      markdownCwd={threadWorkspaceCwd ?? undefined}
                      resolvedTheme={resolvedTheme}
                      chatFontSizePx={settings.chatFontSizePx}
                      timestampFormat={timestampFormat}
                      messageTrailAudioSource={settings.messageTrailAudioSource}
                      messageTrailMicrophoneId={settings.messageTrailMicrophoneId}
                      workspaceRoot={threadArtifactWorkspaceRoot ?? undefined}
                      keybindings={keybindings}
                      availableEditors={availableEditors}
                      // An active voice session owns the empty transcript surface with
                      // RealtimeVoiceStage. Keep MessagesTimeline's default hero out of that
                      // surface; otherwise the old empty-thread heading remains underneath the
                      // live voice stage until the first persisted message arrives.
                      emptyStateContent={
                        realtimeVoice.isMainThreadPresentationVisible ? (
                          <span aria-hidden="true" />
                        ) : (
                          transcriptEmptyStateContent
                        )
                      }
                      emptyStateProjectName={activeProjectDisplayName}
                      terminalWorkspaceTerminalTabActive={terminalWorkspaceTerminalTabActive}
                      onMessagesScroll={onMessagesScroll}
                      onMessagesClickCapture={onMessagesClickCapture}
                      onMessagesMouseUp={onMessagesMouseUp}
                      onMessagesWheel={onMessagesWheel}
                      onEmbeddedScrollIntent={onEmbeddedScrollIntent}
                      onSendVisualChoice={onSendVisualChoice}
                      onMessagesPointerDown={onMessagesPointerDown}
                      onMessagesPointerUp={onMessagesPointerUp}
                      onMessagesPointerCancel={onMessagesPointerCancel}
                      onMessagesTouchStart={onMessagesTouchStart}
                      onMessagesTouchMove={onMessagesTouchMove}
                      onMessagesTouchEnd={onMessagesTouchEnd}
                      onOpenAgentActivity={setOpenAgentActivityId}
                      onCloseAgentActivityDetail={closeAgentActivityDetail}
                      scrollButtonVisible={showScrollToBottom}
                      onScrollToBottom={onScrollToBottom}
                      contentInsetRightPx={contentInsetRightPx}
                      contentInsetBottomPx={composerTranscriptInsetPx}
                      contentInsetBottomClearancePx={composerOverlayBottomClearancePx}
                    />
                    {/* The composer floats `bottom-full` over this trailing                      block, so the last in-flow element must reserve the
                      same `pb-28` clearance CoordinatorSuggestions does or
                      the composer surface covers its controls. */}
                    {isCoordinatorConversation && activeGroupSummary?.pausedAt ? (
                      <div
                        className={cn(
                          CHAT_COLUMN_GUTTER_CLASS_NAME,
                          showCoordinatorSuggestions ? "pb-2" : "pb-28",
                        )}
                      >
                        <GroupPausedBanner
                          projectId={activeThread!.projectId}
                          onResume={async () => {
                            const api = readNativeApi();
                            if (!api?.projectAgent || !activeThread) return;
                            const overview = await api.projectAgent
                              .resumeGroup({
                                requestId: crypto.randomUUID(),
                                projectId: activeThread.projectId,
                              })
                              .catch(() => null);
                            if (overview) {
                              useProjectAgentSummariesStore.getState().applyOverview(overview);
                            }
                          }}
                        />
                      </div>
                    ) : null}
                    {showCoordinatorSuggestions ? (
                      <CoordinatorSuggestions
                        chips={coordinatorSuggestionChips}
                        composerHeightPx={composerOverlayHeightPx}
                        onOpenSettings={(section) => {
                          setCoordinatorSettingsSection(section);
                          setCoordinatorSettingsOpen(true);
                        }}
                      />
                    ) : null}
                  </div>

                  {/* Trailing block below the transcript: the composer floats on top of it
                    (`bottom-full`), so the transcript's scroll viewport — and therefore every
                    row scrolling behind the frosted composer — is clipped at the composer's
                    bottom edge. Nothing ever shows through this gutter or the BranchToolbar row. */}
                  <div className="relative z-10 w-full shrink-0">
                    <div
                      ref={composerOverlayRef}
                      className={cn(
                        "pointer-events-none absolute inset-x-0 bottom-full w-full overflow-visible",
                        ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
                        CHAT_COLUMN_GUTTER_CLASS_NAME,
                      )}
                      // Match the transcript's right inset so the composer stays aligned with chat
                      // content (and clear of the docked Environment overlay and preview rail).
                      style={
                        contentInsetRightPx ? { paddingRight: contentInsetRightPx } : undefined
                      }
                    >
                      <div className="pointer-events-auto">
                        {imageComposerHost?.target
                          ? createPortal(composerSection, imageComposerHost.target)
                          : composerSection}
                      </div>
                    </div>
                    {composerStatusBelow ? (
                      <>
                        <div className="pt-0.5" />
                        {/* Row under the composer: permission, branch controls (git threads), then
                            model/effort and the context ring. The footer tiers measure this row. */}
                        <div
                          className={cn(
                            CHAT_COLUMN_GUTTER_CLASS_NAME,
                            ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
                          )}
                          style={
                            contentInsetRightPx ? { paddingRight: contentInsetRightPx } : undefined
                          }
                        >
                          <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                            <div
                              ref={composerStatusRowRef}
                              data-chat-composer-status-row=""
                              className="@container flex min-h-9 w-full min-w-0 flex-wrap items-center gap-1 pb-1.5 pt-1"
                            >
                              <RuntimeUsageControls
                                {...runtimeUsageControlsProps}
                                className="shrink-0"
                              />
                              {showTrailingBranchToolbar ? (
                                <BranchToolbar
                                  {...branchToolbarProps}
                                  className="min-w-0 flex-[1_0_9rem] px-1 py-0"
                                />
                              ) : (
                                <div className="min-w-0 flex-1" />
                              )}
                              <div className="ml-auto flex shrink-0 items-center gap-2 pr-1">
                                {composerPickerControls}
                                {composerContextMeter}
                              </div>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Empty landing with voice still floats here, but the pickers stay in the
                            footer. Keep the old relocate/git row so they are not duplicated. */}
                        <div
                          className={cn(showTrailingBranchToolbar ? "pt-0.5" : "pt-3 sm:pt-4")}
                        />
                        {showTrailingBranchToolbar || relocateComposerLeadingControls ? (
                          <div className={CHAT_COLUMN_GUTTER_CLASS_NAME}>
                            <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                              <div className="flex w-full items-center gap-1">
                                {relocateComposerLeadingControls ? (
                                  <div className="flex shrink-0 items-center gap-1 pl-1">
                                    {renderComposerLeadingControls({ iconOnly: true })}
                                  </div>
                                ) : null}
                                {showTrailingBranchToolbar ? (
                                  <BranchToolbar
                                    {...branchToolbarProps}
                                    className="min-w-0 flex-1"
                                  />
                                ) : null}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              ) : null}

              {shouldRenderChatPaneContent && pullRequestDialogState?.threadId === threadId ? (
                <PullRequestThreadDialog
                  key={pullRequestDialogState.key}
                  open
                  cwd={threadArtifactWorkspaceRoot}
                  initialReference={pullRequestDialogState.initialReference}
                  onOpenChange={(open) => {
                    if (!open) {
                      closePullRequestDialog();
                    }
                  }}
                  onPrepared={handlePreparedPullRequestThread}
                />
              ) : null}
            </div>

            {terminalWorkspaceOpen ? (
              <div
                aria-hidden={!terminalWorkspaceTerminalTabActive}
                className={cn(
                  "absolute inset-0 min-h-0 min-w-0 transition-all duration-200 ease-out",
                  terminalWorkspaceTerminalTabActive
                    ? "translate-y-0 opacity-100"
                    : "pointer-events-none translate-y-1 opacity-0",
                )}
              >
                <Suspense fallback={null}>
                  <ThreadTerminalDrawer
                    key={`${activeThread.id}-workspace`}
                    {...terminalDrawerProps}
                    isVisible={terminalWorkspaceTerminalTabActive}
                  />
                </Suspense>
              </div>
            ) : null}

            {/* Environment overlay — always mounted so open/close can transition in lockstep with inset. */}
            {environmentEnabled ? (
              <EnvironmentPanel
                {...environmentPanelProps}
                open={environmentPanelVisibleEffective}
                variant={environmentOverlayVariant}
                railBottom={
                  previewSession ? (
                    <AmbientRailSlot envOpen={environmentPanelVisible}>
                      <ComputerPreviewPopover
                        key={threadId}
                        threadId={threadId}
                        maxWidthPx={previewBudgetPx}
                        size={settings.computerPreviewSize === "large" ? "large" : "compact"}
                      />
                    </AmbientRailSlot>
                  ) : undefined
                }
              />
            ) : null}
            {projectPanelEnabled ? (
              <ProjectPanel
                open={projectPanelVisible}
                variant={environmentOverlayVariant}
                projectId={activeProjectId}
                projectName={activeProjectDisplayName ?? activeProject?.name ?? "Project"}
                workspacePath={activeProject?.cwd ?? ""}
                // "Use default" must mean the app's default model, not whatever the
                // active thread happens to run (W14).
                defaultModelSelection={groupPanelDefaultModelSelection}
                importedInstructions={projectInstructions}
                onOpenCoordinator={(threadId) => onNavigateToThread(threadId)}
                onOpenThread={(threadId) => onNavigateToThread(threadId)}
                onOpenThreadSplit={onOpenThreadSplit}
                onOpenAutomation={onOpenAutomation}
                onClose={() => setProjectFromAuxiliary(false)}
                settingsDialogOpen={coordinatorSettingsOpen}
                settingsInitialSection={coordinatorSettingsSection}
                onSettingsDialogOpenChange={(open) => {
                  setCoordinatorSettingsOpen(open);
                  if (!open) setCoordinatorSettingsSection(undefined);
                }}
              />
            ) : null}
            {projectPanelEnabled ? (
              <LibraryPanel
                open={libraryPanelVisible}
                variant={environmentOverlayVariant}
                projectId={activeProjectId}
                onClose={() => setLibraryFromAuxiliary(false)}
              />
            ) : null}
          </div>
          {/* end chat column */}

          {showMossControlPlane ? (
            <MossControlPlanePanel
              activeSurface={mossNativeSurface}
              onSurfaceChange={setMossNativeSurface}
              productShellMode
              threadId={activeThread.id}
            />
          ) : null}

          {/* Plan sidebar */}
          {planSidebarOpen && !isQuickChat ? (
            <PlanSidebar
              activeTaskList={activeTaskList}
              activeProposedPlan={sidebarProposedPlan}
              markdownCwd={threadWorkspaceCwd ?? undefined}
              workspaceRoot={threadArtifactWorkspaceRoot ?? undefined}
              timestampFormat={timestampFormat}
              onClose={() => {
                setPlanSidebarOpen(false);
                // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
                const turnKey = activeTaskList?.turnId ?? sidebarProposedPlan?.turnId ?? null;
                if (turnKey) {
                  planSidebarDismissedForTurnRef.current = turnKey;
                }
              }}
            />
          ) : null}
        </div>
        {/* end horizontal flex container */}

        <ComposerSlashStatusDialog
          open={isSlashStatusDialogOpen}
          onOpenChange={setIsSlashStatusDialogOpen}
          selectedModel={selectedModel}
          fastModeEnabled={fastModeEnabled}
          selectedPromptEffort={selectedPromptEffort}
          interactionMode={interactionMode}
          envMode={envMode}
          envState={envState}
          branch={activeThread?.branch ?? activeRootBranch}
          contextWindow={activeContextWindow}
          cumulativeCostUsd={activeCumulativeCostUsd}
          rateLimitStatus={activeRateLimitStatus}
          activeContextWindowLabel={contextWindowSelectionStatus.activeLabel}
          pendingContextWindowLabel={contextWindowSelectionStatus.pendingSelectedLabel}
        />

        <ThreadWorktreeHandoffDialog
          open={worktreeHandoffDialogOpen}
          worktreeName={worktreeHandoffName}
          busy={handoffBusy}
          onWorktreeNameChange={setWorktreeHandoffName}
          onOpenChange={setWorktreeHandoffDialogOpen}
          onConfirm={handleConfirmWorktreeHandoff}
        />
        {!isInactiveSplitPane && activeProject && !isSidechatExpired ? (
          <TranscriptSelectionActionLayer
            key={threadId}
            action={pendingTranscriptSelectionAction}
            defaultEnvMode={selectionChatEnvMode ?? settings.defaultThreadEnvMode}
            canUseWorktree={isGitRepo && !isContainerLandingProject}
            canAddToSide={isServerThread && !isSidechatThread(activeThread)}
            onDismiss={dismissTranscriptSelectionAction}
            onAddToChat={commitTranscriptAssistantSelection}
            onAddToSide={(selection) =>
              addSelectionToSide({
                selection,
                project: activeProject,
                sourceThread: activeThread,
                selectedModelSelection,
                runtimeMode,
              })
            }
            onNewChat={(selection, prompt, envMode, intent) =>
              startSelectionChat({
                selection,
                prompt,
                envMode,
                intent,
                projectId: activeProject.id,
                projectCwd: activeProject.cwd,
                modelSelection: selectedModelSelection,
                selectedPromptEffort,
                providerOptionsForDispatch,
                runtimeMode,
                createThread: handleNewThread,
              })
            }
          />
        ) : null}
        <ExpandedImageOverlay
          expandedImage={expandedImage}
          onClose={closeExpandedImage}
          onNavigate={navigateExpandedImage}
        />
      </div>
    </div>
  );
  return (
    <ChatLinkActionsContext.Provider value={chatLinkActions}>
      {chatView}
    </ChatLinkActionsContext.Provider>
  );
}
