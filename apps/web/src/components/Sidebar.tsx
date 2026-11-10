import { MOSS_HELP_SITE_URL } from "@moss/shared/desktopIdentity";
import { MossbotSidebar } from "./mossbot/MossbotSidebar";
import { resolveMossbotForThread } from "./mossbot/mossbot.logic";
import { SidebarGettingStarted } from "./SidebarGettingStarted";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { useTranslation, type TranslationKey } from "~/localization";
import { useRealtimeVoiceGlobalRuntime } from "./chat/RealtimeVoiceControllerProvider";
// FILE: Sidebar.tsx
// Purpose: Renders the project/thread sidebar, including row status, sorting, and thread actions.
// Exports: Sidebar

import {
  AddPlusIcon,
  ArchiveIcon,
  BookIcon,
  BotIcon,
  CircleQuestionIcon,
  ClockIcon,
  CodeReviewIcon,
  PluginIcon,
  CopyIcon,
  CustomizeIcon,
  FeedbackIcon,
  GitBranchIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GiftIcon,
  InboxIcon,
  KanbanIcon,
  TasksIcon,
  KeyboardIcon,
  BellIcon,
  type LucideIcon,
  NewThreadIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  SearchIcon,
  StopFilledIcon,
  TemporaryThreadIcon,
  TerminalIcon,
  Trash2,
  TriangleAlertIcon,
  UsersIcon,
  WorktreeIcon,
  XIcon,
  MossbotIcon,
} from "~/lib/icons";
import { createCentralIconComponent } from "~/lib/central-icons";
import { openGuestShareDialog } from "~/guestShareDialogStore";
import { useGuestShareStore } from "~/guestShareStore";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "~/components/pullRequest/pullRequestStatePresentation";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { type RealtimeVoiceState } from "@moss/contracts";
import { useTasksNeedingAttentionCount, useTodoEventSubscription } from "./tasks/useTodos";
import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";
import { ensureNativeApi } from "~/nativeApi";
import {
  getActiveComposerSendThreadIds,
  subscribeComposerSends,
} from "~/lib/composerSendOwnership";
import { autoAnimate } from "@formkit/auto-animate";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  lazy,
  startTransition,
  useMemo,
  useRef,
  useSyncExternalStore,
  Suspense,
  useState,
  type ComponentType,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  type AutomationDefinition,
  type AutomationListResult,
  MAX_PINNED_PROJECTS,
  type DesktopUpdateState,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadPullRequest,
  PROVIDER_DISPLAY_NAMES,
  ProjectId,
  type ProviderKind,
  ThreadId,
  type ResolvedKeybindingsConfig,
  pendingGuestMessageCount,
} from "@moss/contracts";
import { isGenericChatThreadTitle } from "@moss/shared/chatThreads";
import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@moss/shared/githubRepository";
import { getDefaultModel } from "@moss/shared/model";
import { pluralize } from "@moss/shared/text";
import { resolveThreadWorkspaceCwd } from "@moss/shared/threadEnvironment";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  getProviderInstanceOptions,
  type ProviderInstanceOption,
  useAppSettings,
} from "../appSettings";
import { resolveTasksSurfaceSlot, type SidebarNavItemId } from "../sidebarNavOrdering";
import { useTasksSurfaceEnabled } from "../tasksSurface";
import {
  buildRailItemOrder,
  isRailItemAvailable,
  normalizeHiddenRailItems,
  normalizeRailItemOrder,
  railItemCanHide,
  type RailOrderableItemId,
  railProjectShortcutKey,
  resolveActiveRailShortcutKey,
  resolveRailShortcuts,
  toggleRailShortcutKey,
} from "../appRail.logic";
import { useRailShellStore } from "../railShellStore";
import { isElectron } from "../env";
import {
  closeMossCanvas,
  openMossCanvas,
  openMossLibraryDestination,
} from "../lib/mossCanvasBridge";
import { RailAccountMenu } from "./SidebarAccountMenu";
import { formatRelativeTime } from "../lib/relativeTime";
import {
  isMacNavigatorPlatform,
  newCommandId,
  newMessageId,
  newProjectId,
  newThreadId,
} from "../lib/utils";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { expandProjectHomePath, joinProjectPath } from "../lib/projectPaths";
import { reconcileDeletedThreadsFromClient } from "../lib/deletedThreadClientReconciliation";
import { deleteProjectFromClient } from "../lib/projectDelete";
import { persistAppStateNow, useStore } from "../store";
import { useThreadIdsWithPendingDraft } from "../composerDraftStore";
import { getThreadFromState } from "../threadDerivation";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "../keybindings";
import {
  createAllThreadsSelector,
  createProjectLastActivityAtSelector,
  createSidebarDisplayThreadsSelector,
  createSidebarTreeThreadsSelector,
  isSidebarThreadVisible,
} from "../storeSelectors";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { useActivityThreads } from "../hooks/useActivityThreads";
import { useCommittedPathname } from "../hooks/useCommittedPathname";
import { countNeedsYouActions } from "./inbox/inbox.logic";
import {
  resolveThreadPullRequestFallback,
  type ThreadPullRequest,
  useThreadPullRequests,
} from "../hooks/useThreadPullRequests";
import {
  providerComposerCapabilitiesQueryOptions,
  providerModelsQueryOptions,
} from "../lib/providerDiscoveryReactQuery";
import {
  buildThreadImportCandidates,
  filterThreadImportTargetsByCapabilities,
  type ThreadImportTarget,
} from "../lib/threadImport";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
} from "../lib/projectShortcutTargets";
import {
  githubInboxQueryKeys,
  githubInboxReviewBadgeQueryOptions,
  pullRequestQueryKeys,
} from "../lib/pullRequestReactQuery";
import { prefetchModelsForNewThread } from "../lib/providerModelPrefetch";
import { resolveProviderDiscoveryCwd } from "../lib/providerDiscovery";
import { modelQueryOptionsForProviderInstance } from "../hooks/useProviderModelCatalog";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
  serverSettingsQueryOptions,
} from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { isHomeChatContainerProject, prewarmHomeChatProject } from "../lib/chatProjects";
import { isGroupContainerProject } from "../lib/groupProjects";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useLatestProjectStore } from "../latestProjectStore";
import {
  resolveThreadEnvironmentPresentation,
  type ForkThreadTarget,
} from "../lib/threadEnvironment";
import { canForkThread, dispatchThreadFork, FORK_THREAD_TARGET_LABELS } from "../lib/threadFork";
import { contextMenuGroup } from "../lib/contextMenuGroup";
import { registerThreadContextMenu, type ThreadContextMenuOptions } from "../lib/threadContextMenu";
import { gitBranchesQueryOptions } from "../lib/gitReactQuery";
import { resolveComposerSlashRootBranch } from "../composerSlashCommands";
import { dispatchThreadRename } from "../lib/threadRename";
import { quotePosixShellArgument } from "../lib/shellQuote";
import { useStableValue } from "~/hooks/useStableValue";
import { DEFAULT_THREAD_TERMINAL_ID, type SidebarThreadSummary, type Thread } from "../types";
import {
  applyAutomationEvent,
  automationAttentionCount,
  automationQueryKey,
  formatCadence,
  groupAutomationsByContinuedThread,
} from "../routes/-automations.shared";
import { useIsMobile } from "../hooks/useMediaQuery";
import { shouldRenderTerminalWorkspace } from "./ChatView.logic";
import { isModelPickerShortcutScopeActive } from "./chat/ComposerModelPicker.logic";
import {
  APP_RAIL_GLYPH_CLASS_NAME,
  AppRail,
  AppRailPortal,
  appRailButtonClassName,
  railItemGlyphs,
  railProjectGlyphs,
  type AppRailItem,
  useAppRailSlot,
} from "./AppRail";
import {
  type SidebarCustomizeItem,
  SidebarCustomizeHeader,
  SidebarCustomizeList,
} from "./SidebarCustomizeList";
import { AppRailMoreMenu } from "./AppRailMoreMenu";
import { useAppRailPlugins } from "~/hooks/useAppRailPlugins";
import { resolveResourceIcon } from "~/lib/resourceIcon";
import type { AppRailPlugin } from "~/lib/appRailPlugins";
import { AppRailUsage } from "./AppRailUsage";
import { ProjectDisclosureChevron, ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { ThreadHoverCardContent } from "./ThreadHoverCardContent";
import { ProjectHoverCardContent } from "./ProjectHoverCardContent";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import {
  abbreviateHomePath,
  createProjectHoverCardAnchor,
  createThreadHoverCardAnchor,
} from "./sidebarHoverCardAnchors";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import {
  type ActivityScopeSelection,
  buildActivityViewModel,
  findNextThreadNeedingAttention,
  hasActivityNeedingAttention,
  resolveActivityPriorityTier,
} from "./SidebarActivityView.logic";
import {
  ActivityThreadRow,
  SidebarActivityView,
  SidebarSnoozedThreadsSection,
} from "./SidebarActivityView";
import { RailUpdateControl } from "./providerUpdates/RailUpdateControl";
import { SidebarIconButton, sidebarIconButtonSlotClass } from "./SidebarIconButton";
import { OneTimeCoachmark, TASKS_COACHMARK } from "./OneTimeCoachmark";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";
import { SidebarPrimaryAction } from "./SidebarPrimaryAction";
import { RailAutomationsPanel } from "./RailAutomationsPanel";
import { SidebarPanelTitle } from "./SidebarPanelTitle";
import { SidebarMetaChipStack } from "./SidebarMetaChip";
import { SidebarRowHoverActions } from "./SidebarRowHoverActions";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { SidebarGlyph, sidebarGlyphClass, SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { ThreadArchiveActionButton } from "./ThreadArchiveActionButton";
import { ThreadPinToggleButton } from "./ThreadPinToggleButton";
import {
  SidebarThreadRowContent,
  type SidebarThreadTerminalStatus,
} from "./SidebarThreadRowContent";
import { GroupSettingsDialog } from "./chat/group/GroupSettingsDialog";
import { activateThreadWhenHydrated } from "./SidebarGroupsSurface.logic";

import { useProjectAgentSummaries } from "./chat/project/useProjectAgentSummaries";
import { RenameDialog } from "./RenameDialog";
import { EditProjectDialog, type EditProjectValue } from "./EditProjectDialog";
import { RelocateProjectDialog } from "./RelocateProjectDialog";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { SnoozeUntilDialog } from "./SnoozeUntilDialog";
import { SNOOZE_PRESETS } from "../lib/threadSnooze";
import ReleaseHistoryDialog from "./ReleaseHistoryDialog";
import { INBOX_ON, isBetaFeatureOn } from "../betaFeatures";
import { WHATS_NEW_ENTRIES } from "../whatsNew/entries";
import { sortEntriesByVersionDesc } from "../whatsNew/logic";
import { SidebarSearchPalette, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useProviderStatusesForLocalConfig } from "../hooks/useProviderStatusesForLocalConfig";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useCreateProjectDialogStore } from "../createProjectDialogStore";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import { openExternalLink } from "~/lib/linkChips";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarRouteState,
  persistSidebarUiPreferences,
  readSidebarUiState,
  subscribeSidebarUiState,
} from "./Sidebar.uiState";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateAlreadyCurrentNotice,
  getDesktopUpdateErrorSignature,
  isDesktopUpdateButtonDisabled,
  isDesktopUpdateInstallInFlight,
  resolveDesktopUpdateButtonAction,
  shouldRecommendManualDesktopDownload,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Popover, PopoverPopup } from "./ui/popover";
import { StatusDot } from "./ui/status-chip";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { ShortcutKbd } from "./ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import {
  excludeHiddenProjectAgentCoordinatorThreads,
  buildProjectThreadTree,
  derivePinnedProjectIdsForSidebar,
  deriveSidebarProjectData,
  createSidebarThreadHoverAnchorId,
  findWorkspaceRootMatch,
  canSnoozeSidebarThread,
  getPinnedThreadsForSidebar,
  orderPinnedProjectsForSidebar,
  pullRequestRepositoryConfigFingerprint,
  getNextVisibleSidebarThreadId,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarEntriesForPreview,
  groupSidebarThreadsByProjectId,
  partitionSidebarThreadsByProjectIds,
  resolvePrimaryNewChatAction,
  isLatestPinnedProjectMutation,
  pruneProjectThreadListPagingForCollapsedProjects,
  recoverExistingAddProjectTarget,
  runExclusiveProjectAddition,
  runProjectProvisionWithCancellationRecovery,
  resolvePullRequestReviewBadge,
  resolveSidebarThreadListPaging,
  DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY,
  resolveProjectEmptyState,
  resolveSettingsBackTarget,
  type SettingsBackTarget,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarProjectRowLabel,
  resolveThreadHoverCardMetadata,
  resolveThreadProjectLabel,
  resolveThreadRowAriaLabel,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  resolveThreadStatusTrailingIndicator,
  type ThreadStatusPill,
  type SidebarDerivedProjectData,
  type SidebarThreadHoverAnchorScope,
  type SidebarActionBadge,
  shouldShowDebugFeatureFlagsMenu,
  shouldPrunePinnedThreads,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import type { LastThreadRoute } from "../chatRouteRestore";
import { useCopyPathToClipboard, useCopyThreadIdToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import {
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_INNER_CLASS,
} from "~/lib/disclosureMotion";
import { createClientPointMenuAnchor } from "~/lib/clientPointMenuAnchor";
import {
  canCreateThreadHandoff,
  canContinueThreadHandoff,
  resolveAvailableHandoffTargets,
  resolveThreadHandoffAvailability,
  resolveThreadHandoffBadgeLabel,
  type ThreadHandoffTarget,
} from "../lib/threadHandoff";
import { isTerminalFocused } from "../lib/terminalFocus";
import { beginThreadDrag, endThreadDrag } from "../lib/threadDrag";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { normalizeSettingsSection, type SettingsSectionId } from "../settingsNavigation";
import {
  sidebarHoverRevealHideClassName,
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_FOCUS_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_PROJECT_NAME_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_ROW_SNOOZE_REMINDER_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "../sidebarRowStyles";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { PLUGIN_LIBRARY_SETTINGS_PATH } from "~/lib/pluginLibraryHistoryState";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "./chat/ComposerPickerMenuPopup";
import { selectSplitView, useSplitViewStore } from "../splitViewStore";
import { useRightDockStore } from "../rightDockStore";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useThreadActivationController } from "../hooks/useThreadActivationController";
import {
  firstLocalServerUrl,
  useSidebarProjectRunController,
} from "../hooks/useSidebarProjectRunController";
import { useSidebarThreadActions } from "../hooks/useSidebarThreadActions";
import {
  useHeldSidebarThreadSortKeys,
  useIsPointerWithin,
} from "../hooks/useSidebarThreadOrderHold";
import { useThreadActionShortcuts } from "../hooks/useThreadActionShortcuts";
import { usePinnedProjectAgentsStore } from "../pinnedProjectAgentsStore";
import { usePinnedProjectsStore } from "../pinnedProjectsStore";
import { reconcileOptimisticPinState } from "../pinning.logic";
import { useThreadDetailPrewarm } from "../threadDetailPrewarm";
import { hasThreadDetailResumeCursor } from "../threadDetailResumeCursors";
import { retainThreadDetailSubscription } from "../threadDetailSubscriptionRetention";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import {
  areSidebarSearchThreadListsEqual,
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchThread,
} from "./SidebarSearchPalette.logic";
import { useFocusedChatContext } from "../focusedChatContext";
import { waitForRecoverableProjectInReadModel } from "../lib/projectCreateRecovery";
import {
  createOrRecoverProjectFromPath,
  PROJECT_CREATE_EXISTING_SYNC_ERROR,
} from "../lib/projectCreation";
import {
  CreateProjectDialog,
  type CreateProjectSubmitOptions,
  type CreateProjectSubmitValue,
} from "./CreateProjectDialog";
import {
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME,
  SidebarContextMenuIcon,
} from "./sidebarContextMenuStyles";
import { isSidechatThread } from "@moss/shared/sidechatThread";
import { openSettings as openSettingsDialog } from "~/settingsDialogStore";

// Central glyphs for the sidebar section-header buttons (expand/collapse, sort, add).
const ExpandAllIcon = createCentralIconComponent("expand-45");
const CollapseAllIcon = createCentralIconComponent("minimize-45");
const SortFilterIcon = createCentralIconComponent("filter-2");
const BackArrowIcon = createCentralIconComponent("arrow-left");

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
/** The "…" menu leads with Codex's destinations (项目, 图像, 资料空间, 代码审查, 定时任务, 插件). */
const RAIL_MORE_MENU_LEADING_ITEMS: readonly RailOrderableItemId[] = [
  "home",
  "images",
  "library",
  "pullRequests",
  "automations",
  "skills",
];
const THREAD_PREVIEW_LIMIT = 5;
// The bottom "Recent" group shows this many of the most recently active threads
// across every project.
const RECENT_SECTION_THREAD_LIMIT = 5;
// Each "Show more" click reveals this many extra rows; "Show less" hides them again page by page.
const THREAD_PREVIEW_PAGE_SIZE = 5;
// Mouse clicks must not focus the paging buttons, or the focus ring lingers as a solid block
// after the click; they should only light up on hover/press. Keyboard focus is unaffected.
const preventFocusOnMouseDown = (event: React.MouseEvent) => {
  event.preventDefault();
};
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<ThreadId, string>();
const ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 6;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS = 50;
const GITHUB_CANCEL_RECOVERY_MAX_ATTEMPTS = 40;
const GITHUB_CANCEL_RECOVERY_DELAY_MS = 250;
/** Snap the optimistic segment selection back if the navigation never lands. */
const DebugFeatureFlagsMenu = import.meta.env.DEV
  ? lazy(() =>
      import("./DebugFeatureFlagsMenu").then((module) => ({
        default: module.DebugFeatureFlagsMenu,
      })),
    )
  : null;

type ProjectContextMenuId =
  | "open-in-finder"
  | "open-in-kanban"
  | "copy-path"
  | "relocate"
  | "start-dev"
  | "stop-dev"
  | "open-dev-server"
  | "rename"
  | "edit-project-agent"
  | "toggle-pin-project-agent"
  | "toggle-pin"
  | "archive-threads"
  | "delete-threads"
  | "delete";

type ProjectContextMenuState = {
  projectId: ProjectId;
  position: { x: number; y: number };
};

// Sidebar right-click menus (project rows) share one chrome; see
// sidebarContextMenuStyles.
const PROJECT_CONTEXT_MENU_PANEL_CLASS_NAME = SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME;
const PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME = SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME;

// Same gap and tone as the Chats header chevron.
const PROJECT_ROW_CHEVRON_CLASS_NAME = "-ml-1 text-muted-foreground/79";

function ProjectContextMenuIcon({ icon }: { icon: LucideIcon }) {
  return <SidebarContextMenuIcon icon={icon} />;
}

type DebugFeatureFlagsWindow = Window & {
  mossShowFeatureFlags?: () => void;
  mossHideFeatureFlags?: () => void;
};

function readDebugFeatureFlagsMenuVisibility(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: window.localStorage.getItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY),
    });
  } catch {
    return false;
  }
}

function threadJumpLabelMapsEqual(
  left: ReadonlyMap<ThreadId, string>,
  right: ReadonlyMap<ThreadId, string>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const [threadId, label] of left) {
    if (right.get(threadId) !== label) {
      return false;
    }
  }
  return true;
}

// Resolve the visible numbered-thread hints from the active keybinding config.
function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByThreadId: ReadonlyMap<
    ThreadId,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<ThreadId, string> {
  if (input.threadJumpCommandByThreadId.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<ThreadId, string>();
  for (const [threadId, command] of input.threadJumpCommandByThreadId) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadId, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}
function WorktreeBadgeGlyph({ className }: { className?: string }) {
  return <WorktreeIcon aria-hidden="true" className={sidebarGlyphClass("meta", className)} />;
}

/** Pulsing green dot shown before a project name while a dev run is live. */
function ProjectRunIndicatorDot({ className }: { className?: string }) {
  return (
    <StatusDot
      aria-hidden="true"
      title="Dev server running"
      className={cn("bg-emerald-400 motion-safe:animate-pulse", className)}
    />
  );
}

/** Meta chips fade on row hover so pin/archive actions can occupy the same slot. */
const THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME = cn(
  "flex shrink-0 items-center",
  sidebarHoverRevealHideClassName("thread-row"),
);

/** Status glyph slot; matches the 15px meta-chip column so trailing icons stay compact. */
function threadRowStatusSlotClassName(isSubagentThread: boolean, toneClassName?: string): string {
  return cn(
    "flex w-[15px] shrink-0 items-center justify-center leading-none tabular-nums",
    sidebarHoverRevealHideClassName("thread-row"),
    isSubagentThread
      ? "text-ui-xs"
      : // Nudge the timestamp a hair above the meta scale while still tracking the user's
        // typography setting (the CSS var is always set; the 11px is just an SSR fallback).
        "text-[length:calc(var(--app-font-size-ui-meta,11px)+0.5px)]",
    toneClassName ?? (isSubagentThread ? "text-muted-foreground/26" : "text-muted-foreground/38"),
  );
}

function resolveWorktreeBadgeLabel(
  thread: Pick<Thread, "envMode" | "worktreePath">,
): string | null {
  return resolveThreadEnvironmentPresentation({
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  }).worktreeBadgeLabel;
}

type ThreadMetaChip = {
  id: "guest" | "automation" | "handoff" | "fork" | "worktree" | "pr";
  tooltip: string;
  icon: ReactNode;
};

/**
 * Back-to-front order: first = behind, last = in front.
 * Priority lowest -> highest: handoff -> fork -> worktree.
 */
function resolveThreadRowMetaChips(input: {
  thread: Pick<Thread, "forkSourceThreadId" | "envMode" | "worktreePath" | "handoff">;
  includeHandoffBadge: boolean;
  /**
   * When the leading provider avatar already renders the source → target handoff
   * pair, the trailing handoff chip is a redundant double icon and is dropped.
   */
  handoffShownInAvatar?: boolean;
  /** Heartbeat automations targeting this thread; surfaced as an at-a-glance clock chip. */
  threadAutomations?: readonly AutomationDefinition[] | undefined;
  /** A guest's messages waiting for the owner's Send/Dismiss; the row's needs-you chip. */
  guestMessagesWaitingLabel?: string | null | undefined;
}): ThreadMetaChip[] {
  const chips: ThreadMetaChip[] = [];
  if (input.guestMessagesWaitingLabel) {
    chips.push({
      id: "guest",
      tooltip: input.guestMessagesWaitingLabel,
      icon: (
        <SidebarGlyph
          icon={UsersIcon}
          variant="meta"
          className="text-amber-600 dark:text-amber-300/90"
        />
      ),
    });
  }
  const threadAutomations = input.threadAutomations;
  if (threadAutomations && threadAutomations.length > 0) {
    const anyEnabled = threadAutomations.some((automation) => automation.enabled);
    const firstAutomation = threadAutomations[0]!;
    const tooltip =
      threadAutomations.length === 1
        ? `${firstAutomation.name} · ${
            firstAutomation.enabled ? formatCadence(firstAutomation.schedule) : "Paused"
          }`
        : `${threadAutomations.length} automations`;
    chips.push({
      id: "automation",
      tooltip,
      icon: (
        <SidebarGlyph
          icon={ClockIcon}
          variant="meta"
          className={anyEnabled ? "text-muted-foreground/55" : "text-muted-foreground/40"}
        />
      ),
    });
  }

  const handoffBadgeLabel = resolveThreadHandoffBadgeLabel(input.thread);
  if (input.includeHandoffBadge && !input.handoffShownInAvatar && handoffBadgeLabel) {
    chips.push({
      id: "handoff",
      tooltip: handoffBadgeLabel,
      icon: (
        <SidebarGlyph icon={GitBranchIcon} variant="meta" className="text-muted-foreground/55" />
      ),
    });
  }

  if (input.thread.forkSourceThreadId) {
    chips.push({
      id: "fork",
      tooltip: "Forked thread",
      icon: (
        <SidebarGlyph
          icon={GitBranchIcon}
          variant="meta"
          className="text-emerald-600 dark:text-emerald-300/90"
        />
      ),
    });
  }

  const worktreeBadgeLabel = resolveWorktreeBadgeLabel(input.thread);
  if (worktreeBadgeLabel) {
    chips.push({
      id: "worktree",
      tooltip: worktreeBadgeLabel,
      icon: <WorktreeBadgeGlyph className="text-muted-foreground/55" />,
    });
  }

  return chips;
}

// The thread's PR state, as a plain meta chip that closes the row (the hover card's PR
// row is the clickable way to open it).
function resolveThreadRowPrChip(pr: NonNullable<ThreadPullRequest>): ThreadMetaChip {
  const presentation = resolvePrStatePresentation(pr);
  return {
    id: "pr",
    tooltip: `#${pr.number} ${presentation.label}: ${pr.title}`,
    icon: (
      <SidebarGlyph
        icon={PR_STATE_PRESENTATION_ICONS[presentation.iconKind]}
        variant="meta"
        className={presentation.colorClass}
      />
    ),
  };
}

function terminalStatusFromThreadState(input: {
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
}): SidebarThreadTerminalStatus | null {
  const terminalAttentionStates = Object.values(input.terminalAttentionStatesById ?? {});
  if (terminalAttentionStates.includes("attention")) {
    return {
      label: "Terminal input needed",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      pulse: false,
    };
  }
  if ((input.runningTerminalIds?.length ?? 0) > 0) {
    return {
      label: "Terminal process running",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      pulse: true,
    };
  }
  if (terminalAttentionStates.includes("review")) {
    return {
      label: "Terminal task completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      pulse: false,
    };
  }
  return null;
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  onProjectSortOrderChange,
  ...threadSortMenuProps
}: ThreadSortMenuProps & {
  projectSortOrder: SidebarProjectSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
}) {
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={SortFilterIcon}
        label="Sort projects"
        tooltip="Sort projects"
        tooltipSide="right"
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem
                  key={value}
                  value={value}
                  className="min-h-7 py-1 sm:text-ui leading-snug"
                >
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-ui leading-snug font-medium text-muted-foreground">
            Sort threads
          </div>
          <ThreadSortMenuItems {...threadSortMenuProps} />
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

// Docs wait for Moss's help site; the help menu leaves the entry out until then.
const helpSiteUrl = MOSS_HELP_SITE_URL;

// Latest curated releases surfaced directly in the help menu. Static data, so
// computed once at module scope rather than per render.
const HELP_MENU_RELEASE_ENTRIES = sortEntriesByVersionDesc(WHATS_NEW_ENTRIES).slice(0, 3);

// Footer help menu; swapped out for the desktop-update pill while an update is
// available (see SidebarFooter).
/**
 * Keep the owning thread discoverable while the process-wide voice call moves to
 * the desktop overlay. Failed/inactive states do not represent a live call and
 * therefore must not leave a stale sidebar badge behind.
 */
export function resolveSidebarRealtimeVoiceStatusLabel(
  input: {
    readonly state: Readonly<Pick<RealtimeVoiceState, "phase" | "threadId">>;
    readonly threadId: ThreadId;
  },
  t: (key: TranslationKey) => string,
): string | null {
  if (input.state.threadId !== input.threadId) return null;
  switch (input.state.phase) {
    case "reserving":
    case "presenting":
    case "starting":
      return t("sidebar.voice.starting");
    case "active":
      return t("sidebar.voice.active");
    case "stopping":
      return t("sidebar.voice.ending");
    case "inactive":
    case "failed":
      return null;
  }
}

export function SidebarHelpMenu({
  onOpenShortcuts,
  onOpenFeedback,
  onCustomizeSidebar,
  inRail: inRailProp,
  renderMenu,
}: {
  renderMenu?: (helpMenu: ReactNode) => ReactNode;
  onOpenShortcuts: () => void;
  onOpenFeedback: () => void;
  /** Null hides the entry (e.g. on surfaces without the primary nav block). */
  onCustomizeSidebar: (() => void) | null;
  /** Rail layout: the trigger takes the rail button look and the menu opens to the side. */
  inRail?: boolean;
}) {
  const { t } = useTranslation();
  const inRail = inRailProp ?? false;
  // `openCount` keys the dialog so each open remounts the accordion — its rows
  // capture `defaultOpen` in mount state, so a stale mount would ignore a
  // newly selected version.
  const [releaseHistory, setReleaseHistory] = useState<{
    readonly open: boolean;
    readonly version: string | null;
    readonly openCount: number;
  }>({ open: false, version: null, openCount: 0 });

  const openReleaseHistory = (version: string | null) => {
    setReleaseHistory((prev) => ({ open: true, version, openCount: prev.openCount + 1 }));
  };

  const content = (
    <>
      <MenuGroup>
        <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
          {t("sidebar.helpMenu.whatsNew")}
        </div>
        {HELP_MENU_RELEASE_ENTRIES.map((entry) => (
          <MenuItem
            key={entry.version}
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => openReleaseHistory(entry.version)}
          >
            <span className="min-w-0 flex-1 truncate">
              {entry.features[0]?.title ?? `Version ${entry.version}`}
            </span>
            <span className="shrink-0 text-[var(--color-text-foreground-secondary)] tabular-nums">
              {entry.date}
            </span>
          </MenuItem>
        ))}
        <MenuItem
          className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
          onClick={() => openReleaseHistory(null)}
        >
          <SidebarContextMenuIcon icon={GiftIcon} />
          <span>{t("sidebar.helpMenu.changelog")}</span>
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        {onCustomizeSidebar ? (
          <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={onCustomizeSidebar}>
            <SidebarContextMenuIcon icon={CustomizeIcon} />
            <span>{t("sidebar.helpMenu.customize")}</span>
          </MenuItem>
        ) : null}
        <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={onOpenShortcuts}>
          <SidebarContextMenuIcon icon={KeyboardIcon} />
          <span>{t("sidebar.helpMenu.shortcuts")}</span>
        </MenuItem>
        <MenuItem className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME} onClick={onOpenFeedback}>
          <SidebarContextMenuIcon icon={FeedbackIcon} />
          <span>{t("sidebar.helpMenu.feedback")}</span>
        </MenuItem>
        {helpSiteUrl ? (
          <MenuItem
            className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
            onClick={() => openExternalLink(helpSiteUrl)}
          >
            <SidebarContextMenuIcon icon={BookIcon} />
            <span>{t("sidebar.helpMenu.docs")}</span>
          </MenuItem>
        ) : null}
      </MenuGroup>
    </>
  );

  return (
    <>
      {renderMenu ? (
        renderMenu(
          <MenuSub>
            <MenuSubTrigger className="font-normal">
              <CircleQuestionIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("sidebar.more.help")}</span>
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup className="w-64 min-w-64">
              {content}
            </ComposerPickerMenuSubPopup>
          </MenuSub>,
        )
      ) : (
        <Menu>
          <SidebarIconButton
            render={<MenuTrigger />}
            icon={CircleQuestionIcon}
            label={t("sidebar.help")}
            tooltip={t("sidebar.help")}
            {...(inRail
              ? {
                  tooltipSide: "right" as const,
                  iconClassName: APP_RAIL_GLYPH_CLASS_NAME,
                  className: appRailButtonClassName(false),
                }
              : {})}
          />
          <ComposerPickerMenuPopup
            align="end"
            side={inRail ? "right" : "top"}
            className="w-64 min-w-64"
          >
            {content}
          </ComposerPickerMenuPopup>
        </Menu>
      )}
      <ReleaseHistoryDialog
        key={releaseHistory.openCount}
        open={releaseHistory.open}
        onOpenChange={(open) => {
          setReleaseHistory((prev) => ({ ...prev, open }));
        }}
        defaultExpandedVersion={releaseHistory.version}
      />
    </>
  );
}

export type ThreadSortMenuProps = {
  threadSortOrder: SidebarThreadSortOrder;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  threadAttentionFirst: boolean;
  onThreadAttentionFirstChange: (attentionFirst: boolean) => void;
};

function ThreadSortMenuItems({
  threadSortOrder,
  onThreadSortOrderChange,
  threadAttentionFirst,
  onThreadAttentionFirstChange,
}: ThreadSortMenuProps) {
  return (
    <>
      <MenuRadioGroup
        value={threadSortOrder}
        onValueChange={(value) => {
          onThreadSortOrderChange(value as SidebarThreadSortOrder);
        }}
      >
        {(
          Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
        ).map(([value, label]) => (
          <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-ui leading-snug">
            {label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {/* "Created at" is a plain creation-time list, so the toggle only applies to activity order. */}
      <MenuCheckboxItem
        variant="switch"
        checked={threadAttentionFirst}
        disabled={threadSortOrder === "created_at"}
        onCheckedChange={(checked) => {
          onThreadAttentionFirstChange(checked === true);
        }}
        className="min-h-7 py-1 sm:text-ui leading-snug"
      >
        Working and unread on top
      </MenuCheckboxItem>
    </>
  );
}

export function ChatSortMenu(props: ThreadSortMenuProps) {
  return (
    <Menu>
      <SidebarIconButton
        render={<MenuTrigger />}
        icon={SortFilterIcon}
        label="Sort chats"
        tooltip="Sort chats"
        tooltipSide="top"
      />
      <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-ui leading-snug font-medium text-muted-foreground">
            Sort chats
          </div>
          <ThreadSortMenuItems {...props} />
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** Everything a primary nav row needs, keyed by `SidebarNavItemId` so persisted
 *  order/visibility settings can drive both the live rows and the customize card. */
type SidebarNavItemDescriptor = {
  readonly icon: ComponentType<{ className?: string }>;
  readonly iconClassName?: string;
  readonly label: string;
  readonly active: boolean;
  readonly badge: SidebarActionBadge | null;
  readonly onClick: () => void;
  readonly onMouseEnter?: () => void;
  readonly onFocus?: () => void;
};

function SortableProjectItem({
  projectId,
  disabled: disabledProp,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  // Default resolved in the body — see SidebarPrimaryAction.
  const disabled = disabledProp ?? false;
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

/**
 * Header Activity toggle: a bell that lights up in the accent tone while the
 * Activity view is on, with an unread dot when completions are waiting.
 */
export function SidebarActivityBellButton({
  active,
  showUnreadDot,
  shortcutLabel,
  onClick,
}: {
  active: boolean;
  showUnreadDot: boolean;
  shortcutLabel: string | null;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <OneTimeCoachmark
      storageKey="moss:activity-onboarding:v1"
      title={t("sidebar.activity.onboardingTitle")}
      description={t("sidebar.activity.onboardingDescription")}
      tooltip={`${t("sidebar.activity.tooltip")}${shortcutLabel ? ` (${shortcutLabel})` : ""}`}
      tooltipSide="bottom"
    >
      <button
        type="button"
        aria-label={
          active
            ? t("sidebar.activity.switchToClassicView")
            : t("sidebar.activity.switchToActivityView")
        }
        aria-pressed={active}
        onClick={onClick}
        className={cn(
          "relative inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors",
          sidebarIconButtonSlotClass("header"),
          SIDEBAR_ROW_FOCUS_CLASS_NAME,
          active
            ? "bg-[color-mix(in_srgb,var(--color-text-accent)_15%,transparent)] text-[var(--color-text-accent)]"
            : "sidebar-icon-button text-muted-foreground/75 hover:text-foreground",
        )}
      >
        <BellIcon className={sidebarGlyphClass("leading")} />
        {showUnreadDot ? (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-[var(--color-text-accent)] ring-2 ring-[var(--sidebar-background,var(--background))]"
          />
        ) : null}
      </button>
    </OneTimeCoachmark>
  );
}

// Codex lists one row per chat title inside a project. Capture threads that
// share a title ("Live working turn") otherwise stack as duplicate noise;
// the newest updated row is the one that stays.
function collapseSameTitleSidebarThreads(
  threads: readonly SidebarThreadSummary[],
): SidebarThreadSummary[] {
  const newestIdByTitle = new Map<string, { id: string; stamp: string }>();
  for (const thread of threads) {
    if (thread.parentThreadId) continue;
    const title = thread.title.trim();
    if (!title) continue;
    const stamp = thread.updatedAt ?? thread.createdAt;
    const current = newestIdByTitle.get(title);
    if (!current || stamp > current.stamp) {
      newestIdByTitle.set(title, { id: thread.id, stamp });
    }
  }
  return threads.filter((thread) => {
    if (thread.parentThreadId) return true;
    const title = thread.title.trim();
    if (!title) return true;
    return newestIdByTitle.get(title)?.id === thread.id;
  });
}

export default function Sidebar() {
  const { format, t } = useTranslation();
  const [railFeaturesOpen, setRailFeaturesOpen] = useState(false);
  const railPlugins = useAppRailPlugins(railFeaturesOpen);
  const { state: realtimeVoiceState } = useRealtimeVoiceGlobalRuntime();
  const [showDebugFeatureFlagsMenu, setShowDebugFeatureFlagsMenu] = useState(
    readDebugFeatureFlagsMenuVisibility,
  );
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  // Nav destinations live in the rail (portaled next to this panel) and the panel shows
  // Home or a project pinned to the rail.
  const isMobile = useIsMobile();
  const railActiveItem = useRailShellStore((store) => store.activeItem);
  const railPanelView = useRailShellStore((store) => store.panelView);
  const railProjectId = useRailShellStore((store) => store.railProjectId);
  const selectRailPanelItem = useRailShellStore((store) => store.selectPanelItem);
  const selectRailRouteItem = useRailShellStore((store) => store.selectRouteItem);
  const openRailProject = useRailShellStore((store) => store.openRailProject);
  const reconcileRailShell = useRailShellStore((store) => store.reconcile);
  const sidebarThreadSummaryById = useStore((store) => store.sidebarThreadSummaryById);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const setAllProjectsExpanded = useStore((store) => store.setAllProjectsExpanded);
  const collapseProjectsExcept = useStore((store) => store.collapseProjectsExcept);
  const reorderProjects = useStore((store) => store.reorderProjects);
  const renameProjectLocally = useStore((store) => store.renameProjectLocally);
  const setProjectAppearanceLocally = useStore((store) => store.setProjectAppearanceLocally);
  const removeDeletedProjectFromClientState = useStore(
    (store) => store.removeDeletedProjectFromClientState,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const clearProjectDraftThreads = useComposerDraftStore((store) => store.clearProjectDraftThreads);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const activeComposerSendThreadIds = useSyncExternalStore(
    subscribeComposerSends,
    getActiveComposerSendThreadIds,
    getActiveComposerSendThreadIds,
  );
  const temporaryThreadIds = useTemporaryThreadStore((store) => store.temporaryThreadIds);
  const persistedPinnedProjectIds = usePinnedProjectsStore((store) => store.pinnedProjectIds);
  const pinProjectLocally = usePinnedProjectsStore((store) => store.pinProject);
  const unpinProject = usePinnedProjectsStore((store) => store.unpinProject);
  const prunePinnedProjects = usePinnedProjectsStore((store) => store.prunePinnedProjects);
  const pinnedProjectAgentIds = usePinnedProjectAgentsStore((store) => store.pinnedProjectAgentIds);
  const toggleProjectAgentPinned = usePinnedProjectAgentsStore(
    (store) => store.toggleProjectAgentPinned,
  );
  const prunePinnedProjectAgents = usePinnedProjectAgentsStore(
    (store) => store.prunePinnedProjectAgents,
  );
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const groupsWorkspaceRoot = useWorkspacePathsStore((store) => store.groupsWorkspaceRoot);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useCommittedPathname();
  // Settings > Plugins lives at its own path; it still belongs to the settings shell.
  const isOnPluginSettings = pathname === PLUGIN_LIBRARY_SETTINGS_PATH;
  const isOnSettings = pathname === "/settings" || isOnPluginSettings;
  const isOnKanban = pathname.startsWith("/kanban");
  const isOnTasks = pathname.startsWith("/tasks");
  const isOnAutomations = pathname.startsWith("/automations");
  const isOnPullRequests = pathname.startsWith("/pull-requests");
  const isOnInbox = pathname.startsWith("/inbox");
  // Plugins/Customize destination routes (the rail's Plugins item, stored id "skills").
  const isOnCustomizeDestination =
    pathname.startsWith("/skills") || pathname.startsWith("/plugins");
  // Lightweight read of automations to drive the sidebar attention badge. Shares the
  // ["automations"] query cache with the Automations route (and its live stream updates).
  const automationListQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
  });
  useEffect(() => {
    const api = ensureNativeApi();
    return api.automation.onEvent((event) => {
      queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) =>
        applyAutomationEvent(prev, event),
      );
    });
  }, [queryClient]);
  const automationAttentionBadge = useMemo(() => {
    const data = automationListQuery.data;
    if (!data) return null;
    const count = automationAttentionCount(data.runs);
    return count > 0
      ? {
          text: String(count),
          accessibleLabel: `${count} ${pluralize(count, "automation needs", "automations need")} attention`,
        }
      : null;
  }, [automationListQuery.data]);
  // Subscribe to Tasks unless the connected server has refused it.
  const tasksSurfaceEnabled = useTasksSurfaceEnabled();
  useTodoEventSubscription(tasksSurfaceEnabled);
  const tasksNeedingAttentionCount = useTasksNeedingAttentionCount(tasksSurfaceEnabled);
  const tasksAttentionBadge = useMemo(
    () =>
      tasksNeedingAttentionCount > 0
        ? {
            text: String(tasksNeedingAttentionCount),
            accessibleLabel: `${tasksNeedingAttentionCount} ${pluralize(tasksNeedingAttentionCount, "task needs", "tasks need")} you`,
          }
        : null,
    [tasksNeedingAttentionCount],
  );
  const pullRequestRepositoryConfig = useMemo(
    () => pullRequestRepositoryConfigFingerprint(projects),
    [projects],
  );
  const previousPullRequestRepositoryConfigRef = useRef(pullRequestRepositoryConfig);
  useEffect(() => {
    if (previousPullRequestRepositoryConfigRef.current === pullRequestRepositoryConfig) return;
    previousPullRequestRepositoryConfigRef.current = pullRequestRepositoryConfig;
    void queryClient.invalidateQueries({ queryKey: githubInboxQueryKeys.all });
    void queryClient.invalidateQueries({ queryKey: pullRequestQueryKeys.all });
  }, [pullRequestRepositoryConfig, queryClient]);
  const { settings: appSettings, serverSettings, updateSettings } = useAppSettings();
  // The badge observes the open inbox list and shares its server snapshot, so an open inbox makes
  // it free; with the inbox closed it refreshes every 15 minutes.
  const pullRequestsReviewingQuery = useQuery({
    ...githubInboxReviewBadgeQueryOptions(appSettings.githubInboxSort),
    enabled: projects.some((project) => project.kind === "project"),
  });
  const pullRequestsReviewBadge = resolvePullRequestReviewBadge(pullRequestsReviewingQuery.data);
  // Heartbeat automations grouped by their target thread, so each thread row can show a
  // clock chip indicating an automation is attached (mirrors the Environment panel section).
  const automationsByThreadId = useMemo(
    () => groupAutomationsByContinuedThread(automationListQuery.data?.definitions ?? []),
    [automationListQuery.data],
  );
  // A guest's waiting messages mark the thread row, so the owner notices them from
  // another thread (same needs-you tone as terminal input).
  const guestSharesByThreadId = useGuestShareStore((state) => state.sharesByThreadId);
  const guestMessagesWaitingLabelFor = (threadId: ThreadId): string | null => {
    const count = pendingGuestMessageCount(guestSharesByThreadId[threadId]);
    if (count === 0) return null;
    return count === 1
      ? t("chat.guestShare.sidebar.pendingOne")
      : format("chat.guestShare.sidebar.pendingMany", { count });
  };
  const sidebarProviderInstances = useMemo(
    () => getProviderInstanceOptions(appSettings),
    [appSettings],
  );
  // Projects is always available; Groups and the standalone Chats footer can be hidden
  // independently from Settings.
  const chatsSectionVisible = appSettings.showChatsSection;
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { continueThreadHandoff, createThreadHandoff } = useThreadHandoff();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const pendingThreadRowAnchorRef = useRef<{
    threadId: ThreadId;
    row: HTMLElement;
    viewport: HTMLElement;
    top: number;
    scrollTop: number;
  } | null>(null);
  useLayoutEffect(() => {
    const anchor = pendingThreadRowAnchorRef.current;
    pendingThreadRowAnchorRef.current = null;
    if (
      !anchor ||
      anchor.threadId !== routeThreadId ||
      !anchor.row.isConnected ||
      anchor.viewport.scrollTop !== anchor.scrollTop
    ) {
      return;
    }
    // Keep the activated row in place when navigation replaces the subagent subtree.
    // Native anchoring can instead hold an earlier row; scroll bounds still apply.
    anchor.viewport.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
  }, [routeThreadId]);
  const routeSearch = useDiffRouteSearch();
  const settingsSectionSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const activeSettingsSection: SettingsSectionId = isOnPluginSettings
    ? "plugins"
    : normalizeSettingsSection(settingsSectionSearch.section);
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const splitViewsById = useSplitViewStore((store) => store.splitViewsById);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || !threadsHydrated || projects.length > 0) {
      return;
    }

    let cancelled = false;
    // The sidebar is the visible empty-state owner. If startup hydrated empty
    // before the desktop projection caught up, ask the lightweight shell endpoint once.
    void api.orchestration
      .getShellSnapshot()
      .then((snapshot) => {
        if (
          cancelled ||
          (snapshot.spaces.length === 0 &&
            snapshot.projects.length === 0 &&
            snapshot.threads.length === 0)
        ) {
          return;
        }
        syncServerShellSnapshot(snapshot);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [projects.length, syncServerShellSnapshot, threadsHydrated]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const canInstallConsoleCommand = shouldShowDebugFeatureFlagsMenu({
      isDev: import.meta.env.DEV,
      hostname: window.location.hostname,
      storageValue: "true",
    });
    if (!canInstallConsoleCommand) {
      return;
    }

    const debugWindow = window as DebugFeatureFlagsWindow;
    const updateVisibility = () => {
      setShowDebugFeatureFlagsMenu(readDebugFeatureFlagsMenuVisibility());
    };
    const showFeatureFlags = () => {
      window.localStorage.setItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY, "true");
      updateVisibility();
    };
    const hideFeatureFlags = () => {
      window.localStorage.removeItem(DEBUG_FEATURE_FLAGS_MENU_STORAGE_KEY);
      updateVisibility();
    };

    debugWindow.mossShowFeatureFlags = showFeatureFlags;
    debugWindow.mossHideFeatureFlags = hideFeatureFlags;
    window.addEventListener("storage", updateVisibility);
    updateVisibility();

    return () => {
      window.removeEventListener("storage", updateVisibility);
      if (debugWindow.mossShowFeatureFlags === showFeatureFlags) {
        delete debugWindow.mossShowFeatureFlags;
      }
      if (debugWindow.mossHideFeatureFlags === hideFeatureFlags) {
        delete debugWindow.mossHideFeatureFlags;
      }
    };
  }, []);
  const setSplitFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const openRightDockPane = useRightDockStore((store) => store.openPane);
  // Query defaults are applied after destructuring: a default inside the destructuring
  // pattern makes React Compiler bail out on the whole Sidebar component.
  const keybindingsQuery = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const keybindings = keybindingsQuery.data ?? EMPTY_KEYBINDINGS;
  const serverCwdQuery = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.cwd ?? null,
  });
  const serverCwd = serverCwdQuery.data ?? null;
  const providerStatuses = useProviderStatusesForLocalConfig();
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  // Declared next to `keybindings` (rather than further down) because the project-row render
  // helpers above read these labels. A const declared after the closure that captures it
  // widens its inferred mutable range and makes React Compiler drop the memoization of every
  // hook that depends on it. See Sidebar.compiler.test.ts.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    shortcutLabelForCommand(keybindings, "chat.newLatestProject");
  const newChatShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newChat") ??
    shortcutLabelForCommand(keybindings, "chat.newLocal");
  const newTerminalThreadShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newTerminal");
  const searchShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.search") ??
    (isMacNavigatorPlatform() ? "⌘K" : "Ctrl+K");
  const activityShortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.activity");
  const importThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.importThread") ??
    (isMacNavigatorPlatform() ? "⌘I" : "Ctrl+I");
  const addProjectShortcutLabel =
    shortcutLabelForCommand(keybindings, "sidebar.addProject") ??
    (isMacNavigatorPlatform() ? "⇧⌘O" : "Ctrl+Shift+O");
  const usageSettingsShortcutLabel = shortcutLabelForCommand(keybindings, "settings.usage");
  const { activeProjectId: focusedProjectId } = useFocusedChatContext();
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  // Shared with the composer project picker, which opens this same dialog.
  const createProjectDialogOpen = useCreateProjectDialogStore((state) => state.isOpen);
  const setCreateProjectDialogOpen = useCreateProjectDialogStore((state) => state.setOpen);
  // The open flag lives in a module store now, so it outlives this sidebar: close the
  // dialog with it, or a remounted sidebar would reopen a stale modal over everything.
  useEffect(() => () => setCreateProjectDialogOpen(false), [setCreateProjectDialogOpen]);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [automationCreateOpen, setAutomationCreateOpen] = useState(false);
  useEffect(() => {
    // Match the dialog's previous panel-local lifetime when leaving Automations.
    if (!isOnAutomations) setAutomationCreateOpen(false);
  }, [isOnAutomations]);
  const openFeedbackDialog = useFeedbackDialogStore((state) => state.openDialog);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SidebarSearchPaletteMode>("search");
  const projectAdditionLockRef = useRef(false);
  const [renameDialogThreadId, setRenameDialogThreadId] = useState<ThreadId | null>(null);
  const [snoozeDialogThreadId, setSnoozeDialogThreadId] = useState<ThreadId | null>(null);
  const [renameProjectDialogId, setRenameProjectDialogId] = useState<ProjectId | null>(null);
  const [projectAgentDialogState, setProjectAgentDialogState] = useState<{
    projectId: ProjectId;
    mode: "onboarding" | "edit";
    /** Posted to the coordinator as its first turn once onboarding saves. */
    firstMessage?: string;
    /** The dialog opening also created the group — Cancel may offer discard. */
    discardable?: boolean;
  } | null>(null);
  // A coordinator activation scheduled from onboarding outlives the dialog: its
  // poll/timeout must not yank the user to that thread after they have moved on,
  // so keep its cancel handle and drop it on unmount and on the first navigation
  // after it was scheduled.
  const pendingCoordinatorActivationRef = useRef<{
    readonly cancel: () => void;
    readonly pathname: string;
  } | null>(null);
  useEffect(() => {
    const pending = pendingCoordinatorActivationRef.current;
    if (pending && pending.pathname !== pathname) {
      pending.cancel();
      pendingCoordinatorActivationRef.current = null;
    }
  }, [pathname]);
  useEffect(
    () => () => {
      pendingCoordinatorActivationRef.current?.cancel();
      pendingCoordinatorActivationRef.current = null;
    },
    [],
  );
  // The project stays set after close so the dialog can play its exit transition.
  const [editProjectDialog, setEditProjectDialog] = useState<{
    projectId: ProjectId;
    open: boolean;
  } | null>(null);
  const [relocateProjectDialogId, setRelocateProjectDialogId] = useState<ProjectId | null>(null);
  const [projectContextMenuState, setProjectContextMenuState] =
    useState<ProjectContextMenuState | null>(null);
  // "Show more" paging state: extra pages of THREAD_PREVIEW_PAGE_SIZE rows per project cwd.
  const [threadListExtraPagesByProjectCwd, setThreadListExtraPagesByProjectCwd] = useState<
    ReadonlyMap<string, number>
  >(() => new Map(Object.entries(readSidebarUiState().projectThreadListExtraPagesByCwd)));
  const [chatSectionExpanded, setChatSectionExpanded] = useState(
    () => readSidebarUiState().chatSectionExpanded,
  );
  const [chatThreadListExtraPages, setChatThreadListExtraPages] = useState(
    () => readSidebarUiState().chatThreadListExtraPages,
  );
  const [dismissedThreadStatusKeyByThreadId, setDismissedThreadStatusKeyByThreadId] = useState<
    Record<string, string>
  >(() => readSidebarUiState().dismissedThreadStatusKeyByThreadId);
  const [lastThreadRoute, setLastThreadRoute] = useState(
    () => readSidebarUiState().lastThreadRoute,
  );
  const [activityViewEnabled, setActivityViewEnabled] = useState(
    () => readSidebarUiState().activityViewEnabled,
  );
  // Lives here, not in SidebarActivityView, so it survives the view unmounting
  // (opening Settings swaps the sidebar surface) and reloads.
  const [activityScope, setActivityScope] = useState<ActivityScopeSelection>(
    () => readSidebarUiState().activityScope,
  );
  const [activityVisibleThreadIds, setActivityVisibleThreadIds] = useState<readonly ThreadId[]>([]);
  const [classicSnoozedVisibleThreadIds, setClassicSnoozedVisibleThreadIds] = useState<
    readonly ThreadId[]
  >([]);
  const handleActivityVisibleThreadIdsChange = useCallback((threadIds: readonly ThreadId[]) => {
    setActivityVisibleThreadIds((current) => {
      if (
        current.length === threadIds.length &&
        current.every((threadId, index) => threadId === threadIds[index])
      ) {
        return current;
      }
      return [...threadIds];
    });
  }, []);
  // Sidebar UI state is stored as one blob. Adopt the complete external write
  // so this tab cannot persist stale paging, dismissal, or route fields over a
  // newer tab merely because the Activity toggle changed there.
  useEffect(
    () =>
      subscribeSidebarUiState((state) => {
        setChatSectionExpanded(state.chatSectionExpanded);
        setChatThreadListExtraPages(state.chatThreadListExtraPages);
        setThreadListExtraPagesByProjectCwd(
          new Map(Object.entries(state.projectThreadListExtraPagesByCwd)),
        );
        setDismissedThreadStatusKeyByThreadId(state.dismissedThreadStatusKeyByThreadId);
        setLastThreadRoute(state.lastThreadRoute);
        setActivityViewEnabled(state.activityViewEnabled);
        setActivityScope(state.activityScope);
      }),
    [],
  );
  // The swap unmounts one full surface and mounts the other; a transition keeps
  // the click responsive instead of blocking the main thread on large sidebars.
  const setActivityViewEnabledSmoothly = useCallback((enabled: boolean) => {
    startTransition(() => {
      setActivityViewEnabled(enabled);
    });
  }, []);
  const [optimisticActiveThreadId, setOptimisticActiveThreadId] = useState<ThreadId | null>(null);
  const lastThreadRenameTapRef = useRef<{
    threadId: ThreadId;
    timestamp: number;
  } | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const optimisticPinnedStateByProjectIdRef = useRef(new Map<ProjectId, boolean>());
  const latestPinnedMutationVersionByProjectIdRef = useRef(new Map<ProjectId, number>());
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installingDesktopUpdate, setInstallingDesktopUpdate] = useState(false);
  const [optimisticPinnedStateByProjectId, setOptimisticPinnedStateByProjectId] = useState<
    ReadonlyMap<ProjectId, boolean>
  >(() => new Map());
  // Dedupes the manual-download fallback toast so a single failure surfaced by
  // both the click handler and the install-watchdog push only notifies once.
  const lastDesktopUpdateErrorToastSignatureRef = useRef<string | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);

  // Row layout (the open thread's subagent rows, a collapsed folder's open row,
  // the preview cap's forced reveal) follows the route, not the pointer-down
  // optimistic id. Rebuilding the list between press and release moves the row
  // out from under the pointer, so the click never fires and the thread never opens.
  const routeActiveSidebarThreadId = routeThreadId;
  const activeSidebarThreadId = optimisticActiveThreadId ?? routeActiveSidebarThreadId;
  const visualActiveSidebarThreadId = optimisticActiveThreadId ?? routeThreadId;
  const hideAutomationRunThreads = !appSettings.showAutomationRunThreads;
  const selectSidebarTreeThreads = useMemo(
    () => createSidebarTreeThreadsSelector({ hideAutomationRunThreads }),
    [hideAutomationRunThreads],
  );
  const sidebarTreeThreads = useStore(selectSidebarTreeThreads);
  const selectProjectLastActivityAt = useMemo(() => createProjectLastActivityAtSelector(), []);
  const projectLastActivityAt = useStore(selectProjectLastActivityAt);
  const { summaryFor, summariesByProjectId, coordinatorThreadIds, membersLoaded } =
    useProjectAgentSummaries();
  // The bell and Inbox read current threads. Activity also receives snoozed rows
  // for its separate section, so badges never point at work the user set aside.
  const {
    sidebarThreads,
    displaySidebarThreads,
    groupProjectIdSet,
    visibleNonGroupThreads: visibleNonGroupSidebarThreads,
    activityNonGroupThreads: activityNonGroupSidebarThreads,
  } = useActivityThreads({ hideAutomationRunThreads });
  const displaySidebarTreeThreads = useMemo(
    () => excludeHiddenProjectAgentCoordinatorThreads(sidebarTreeThreads, coordinatorThreadIds),
    [coordinatorThreadIds, sidebarTreeThreads],
  );
  const { nonGroupThreads: nonGroupSidebarTreeThreads } = useMemo(
    () =>
      partitionSidebarThreadsByProjectIds(
        displaySidebarTreeThreads,
        groupProjectIdSet,
        summariesByProjectId,
      ),
    [displaySidebarTreeThreads, groupProjectIdSet, summariesByProjectId],
  );
  // Inbox is available in both Stable and Beta.
  const inboxAvailable = INBOX_ON;
  // The destination also supports users' own CLI accounts. The existing media
  // service still authorizes each generation/read against its account boundary.
  const imagesAvailable = true;
  const inboxBadge = useMemo(() => {
    if (!inboxAvailable) return null;
    const count = countNeedsYouActions(
      visibleNonGroupSidebarThreads,
      activeSidebarThreadId,
      dismissedThreadStatusKeyByThreadId,
    );
    return count > 0
      ? {
          text: String(count),
          accessibleLabel: `${count} ${pluralize(count, "thread needs", "threads need")} you`,
        }
      : null;
  }, [
    activeSidebarThreadId,
    dismissedThreadStatusKeyByThreadId,
    inboxAvailable,
    visibleNonGroupSidebarThreads,
  ]);
  const dismissThreadStatus = useCallback(
    (threadId: ThreadId, statusKey: string | null | undefined) => {
      if (!statusKey) {
        return;
      }
      setDismissedThreadStatusKeyByThreadId((current) => {
        if (current[threadId] === statusKey) {
          return current;
        }
        return {
          ...current,
          [threadId]: statusKey,
        };
      });
    },
    [],
  );
  const clearDismissedThreadStatus = useCallback((threadId: ThreadId) => {
    setDismissedThreadStatusKeyByThreadId((current) => {
      if (!(threadId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);
  const handleMarkThreadUnread = useCallback(
    (threadId: ThreadId) => {
      clearDismissedThreadStatus(threadId);
      markThreadUnread(threadId);
    },
    [clearDismissedThreadStatus, markThreadUnread],
  );
  const canSnoozeThread = useCallback(
    (
      thread: Pick<
        SidebarThreadSummary,
        | "id"
        | "projectId"
        | "creationSource"
        | "sourceThreadId"
        | "parentThreadId"
        | "sidechatSourceThreadId"
        | "sidechatContext"
      >,
    ) =>
      canSnoozeSidebarThread({
        thread,
        groupProjectIds: groupProjectIdSet,
        summariesByProjectId,
        coordinatorThreadIds,
        membersLoaded,
      }),
    [groupProjectIdSet, summariesByProjectId, coordinatorThreadIds, membersLoaded],
  );
  const resolveThreadStatusForSidebar = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveThreadStatusPill({
        thread: {
          ...thread,
          dismissedStatusKey: dismissedThreadStatusKeyByThreadId[thread.id],
        },
        hasPendingApprovals: thread.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput,
        isPreparingWorktree:
          activeComposerSendThreadIds.has(thread.id) &&
          thread.envMode === "worktree" &&
          thread.latestTurn === null &&
          thread.session === null,
      }),
    [activeComposerSendThreadIds, dismissedThreadStatusKeyByThreadId],
  );
  const resolveActivityPriorityTierForSidebar = useCallback(
    (thread: SidebarThreadSummary) =>
      resolveActivityPriorityTier(resolveThreadStatusForSidebar(thread)),
    [resolveThreadStatusForSidebar],
  );
  // Drives the dot on the header Activity bell: another chat waiting on an answer or
  // with unseen work, by Priority's tiers.
  const hasUnreadActivity = useMemo(
    () =>
      hasActivityNeedingAttention(
        visibleNonGroupSidebarThreads,
        activeSidebarThreadId,
        resolveActivityPriorityTierForSidebar,
      ),
    [activeSidebarThreadId, resolveActivityPriorityTierForSidebar, visibleNonGroupSidebarThreads],
  );

  useEffect(() => {
    if (!optimisticActiveThreadId) {
      return;
    }
    if (routeActiveSidebarThreadId === optimisticActiveThreadId) {
      // The route caught up; drop the optimistic override on the next tick. Async
      // setState keeps this out of render, and activeSidebarThreadId already resolves
      // to the same thread via `optimistic ?? route`, so the deferral is invisible.
      const settle = window.setTimeout(() => {
        setOptimisticActiveThreadId((current) =>
          current === optimisticActiveThreadId ? null : current,
        );
      }, 0);
      return () => window.clearTimeout(settle);
    }

    const timeout = window.setTimeout(() => {
      if (pendingThreadRowAnchorRef.current?.threadId === optimisticActiveThreadId) {
        pendingThreadRowAnchorRef.current = null;
      }
      setOptimisticActiveThreadId((current) =>
        current === optimisticActiveThreadId ? null : current,
      );
    }, 1_500);
    return () => window.clearTimeout(timeout);
  }, [optimisticActiveThreadId, routeActiveSidebarThreadId]);

  const clearThreadNotification = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) {
        return;
      }
      const threadStatus = resolveThreadStatusForSidebar(thread);
      if (!threadStatus?.dismissible) {
        return;
      }
      if (threadStatus.label === "Completed") {
        markThreadVisited(threadId, thread.latestTurn?.completedAt ?? undefined);
        return;
      }
      if (threadStatus.label === "Reminder") {
        markThreadVisited(threadId, thread.snoozeReminderAt ?? undefined);
        return;
      }
      dismissThreadStatus(threadId, threadStatus.dismissalKey);
    },
    [
      dismissThreadStatus,
      markThreadVisited,
      resolveThreadStatusForSidebar,
      sidebarThreadSummaryById,
    ],
  );
  const routeTerminalState = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId)
    : null;
  const terminalOpen = routeTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: routeTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const {
    pinnedThreadIds,
    pinnedThreadIdSet,
    toggleThreadPinned,
    setThreadSettledWithToast,
    setThreadSnoozedUntil,
    snoozeThread,
    settledOverrideByThreadId,
    deleteThread,
    confirmAndDeleteThread,
    archiveThread,
    archiveThreadWithUndo,
    confirmAndArchiveThread,
    archiveAllThreadsInProject,
    deleteProjectThreads,
  } = useSidebarThreadActions({
    activeSplitView,
    appSettings,
    clearTerminalState,
    handleNewChat,
    projectById,
    routeSplitViewId: routeSearch.splitViewId ?? null,
    routeThreadId,
    sidebarThreads,
    sidebarTreeThreads,
    sidebarThreadSummaryById,
    threadsHydrated,
  });
  useThreadActionShortcuts({
    enabled: !isOnSettings,
    keybindings,
    routeThreadId,
    activeSplitView,
    threadById: sidebarThreadSummaryById,
    terminalStateByThreadId,
    canSnooze: canSnoozeThread,
    onArchive: confirmAndArchiveThread,
    onSnooze: setSnoozeDialogThreadId,
    onMarkUnread: handleMarkThreadUnread,
  });
  const snoozedSidebarThreads = useMemo(
    () =>
      buildActivityViewModel({
        threads: activityNonGroupSidebarThreads,
        pinnedThreadIdSet,
      }).snoozed,
    [activityNonGroupSidebarThreads, pinnedThreadIdSet],
  );
  // Codex-style bottom "Recent" group: the most recently active threads across
  // all projects. Snoozed rows keep their own section.
  const recentSidebarThreads = useMemo(() => {
    const snoozedThreadIds = new Set(snoozedSidebarThreads.map((thread) => thread.id));
    return visibleNonGroupSidebarThreads
      .filter((thread) => !snoozedThreadIds.has(thread.id))
      .sort((left, right) =>
        (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
      )
      .slice(0, RECENT_SECTION_THREAD_LIMIT);
  }, [snoozedSidebarThreads, visibleNonGroupSidebarThreads]);
  const draftThreadIdSet = useThreadIdsWithPendingDraft();
  const {
    projectRunsByProjectId,
    projectRunServerByProjectId,
    projectRunDialogProjectId,
    projectRunDialogProject,
    projectRunDialogExistingRun,
    projectRunDialogCommandDraft,
    setProjectRunDialogCommandDraft,
    projectRunDialogCommandIsValid,
    openProjectRunDialog,
    closeProjectRunDialog,
    handleConfirmProjectRun,
    handleStopProjectRun,
    handleOpenProjectRunServer,
  } = useSidebarProjectRunController({
    projects,
    projectById,
    homeDir,
    chatWorkspaceRoot,
  });
  // Resolve the active thread's project for real threads AND not-yet-persisted draft threads,
  // so a fresh Mossbot chat (a draft at /$threadId) keeps its Mossbot surface.
  const activeRouteProjectId = routeThreadId
    ? (sidebarThreadSummaryById[routeThreadId]?.projectId ??
      draftThreadsByThreadId[routeThreadId]?.projectId ??
      null)
    : null;
  // Use the list's validated containers and member index: a hub worker's projectId
  // points at its execution repo, which must not move its chat out of Hubs.
  const activeMossbot = resolveMossbotForThread({
    projectId: activeRouteProjectId,
    threadId: routeThreadId,
    summaries: summariesByProjectId,
  });
  // Mossbot is open in every flavor; the Hubs surface is gone, so a hub chat opened from a
  // link or search shows in the ordinary thread view.
  const isOnMossbot = pathname === "/mossbot" || activeMossbot !== null;
  useEffect(() => {
    reconcileRailShell({
      pathname,
      onMossbotSurface: isOnMossbot,
      projectIds: threadsHydrated ? new Set(projects.map((project) => project.id)) : null,
    });
  }, [isOnMossbot, pathname, projects, reconcileRailShell, threadsHydrated]);
  const ordinarySpaceProjects = useMemo(
    () =>
      projects.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
          groupsWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );

  const pinnedThreads = useMemo(
    () => getPinnedThreadsForSidebar(nonGroupSidebarTreeThreads, pinnedThreadIds),
    [nonGroupSidebarTreeThreads, pinnedThreadIds],
  );
  const openPrLink = useCallback(
    (
      event: MouseEvent<HTMLElement> | import("react").KeyboardEvent<HTMLElement>,
      prUrl: string,
    ) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link opening is unavailable.",
        });
        return;
      }

      void api.shell.openExternal(prUrl).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open PR link",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [],
  );
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const projectByIdRef = useRef(projectById);
  useEffect(() => {
    projectByIdRef.current = projectById;
  }, [projectById]);
  const setOptimisticProjectPinned = useCallback((projectId: ProjectId, isPinned: boolean) => {
    optimisticPinnedStateByProjectIdRef.current.set(projectId, isPinned);
    setOptimisticPinnedStateByProjectId((current) => {
      if (current.get(projectId) === isPinned) {
        return current;
      }
      const next = new Map(current);
      next.set(projectId, isPinned);
      return next;
    });
  }, []);
  const clearOptimisticProjectPinned = useCallback((projectId: ProjectId) => {
    optimisticPinnedStateByProjectIdRef.current.delete(projectId);
    setOptimisticPinnedStateByProjectId((current) => {
      if (!current.has(projectId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  }, []);
  const dispatchProjectPinnedState = useCallback(
    async (projectId: ProjectId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId,
        isPinned,
      });
    },
    [],
  );
  const setProjectPinned = useCallback(
    async (projectId: ProjectId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectByIdRef.current.get(projectId);
      if (!project || project.kind !== "project") {
        return;
      }
      const requestVersion =
        (latestPinnedMutationVersionByProjectIdRef.current.get(projectId) ?? 0) + 1;
      latestPinnedMutationVersionByProjectIdRef.current.set(projectId, requestVersion);

      setOptimisticProjectPinned(projectId, isPinned);
      if (isPinned) {
        const accepted = pinProjectLocally(projectId);
        if (!accepted) {
          clearOptimisticProjectPinned(projectId);
          toastManager.add({
            type: "warning",
            title: "Project pin limit reached",
            description: `You can pin up to ${MAX_PINNED_PROJECTS} projects.`,
          });
          return;
        }
      } else {
        unpinProject(projectId);
      }

      try {
        await dispatchProjectPinnedState(projectId, isPinned);
      } catch (error) {
        if (
          !isLatestPinnedProjectMutation({
            projectId,
            requestVersion,
            latestMutationVersionByProjectId: latestPinnedMutationVersionByProjectIdRef.current,
          })
        ) {
          return;
        }

        const confirmedPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
        if (confirmedPinned) {
          pinProjectLocally(projectId);
        } else {
          unpinProject(projectId);
        }
        clearOptimisticProjectPinned(projectId);
        throw error;
      }
    },
    [
      clearOptimisticProjectPinned,
      dispatchProjectPinnedState,
      pinProjectLocally,
      setOptimisticProjectPinned,
      unpinProject,
    ],
  );
  const toggleProjectPinned = useCallback(
    (projectId: ProjectId) => {
      const optimisticPinned = optimisticPinnedStateByProjectIdRef.current.get(projectId);
      const locallyPinned = usePinnedProjectsStore.getState().pinnedProjectIds.includes(projectId);
      const serverPinned = projectByIdRef.current.get(projectId)?.isPinned === true;
      const isPinned = optimisticPinned ?? (locallyPinned || serverPinned);
      void setProjectPinned(projectId, !isPinned).catch((error) => {
        console.error("Failed to update pinned project state", {
          projectId,
          error,
        });
        toastManager.add({
          type: "error",
          title: isPinned ? "Unable to unpin project" : "Unable to pin project",
          description: error instanceof Error ? error.message : undefined,
        });
      });
    },
    [setProjectPinned],
  );
  useEffect(() => {
    if (optimisticPinnedStateByProjectId.size === 0) {
      return;
    }

    const serverPinnedStateByProjectId = new Map(
      projects.map((project) => [project.id, project.isPinned === true] as const),
    );
    // Reconciliation drops optimistic entries the server has confirmed while syncing
    // the mirror ref. Deferring the setState off render (async is allowed) leaves the
    // derived pinned lists unchanged, since a confirmed entry is redundant either way.
    const settle = window.setTimeout(() => {
      setOptimisticPinnedStateByProjectId((current) => {
        const reconciled = reconcileOptimisticPinState({
          optimisticPinnedStateById: current,
          serverPinnedStateById: serverPinnedStateByProjectId,
        });
        for (const projectId of reconciled.settledIds) {
          optimisticPinnedStateByProjectIdRef.current.delete(projectId);
        }
        return reconciled.optimisticPinnedStateById;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [optimisticPinnedStateByProjectId, projects]);
  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      // Only navigate to threads the sidebar actually shows — focusing a hidden
      // automation-run thread would select a row the user can't see.
      const latestThread = sortThreadsForSidebar(
        displaySidebarThreads.filter(
          (thread) =>
            thread.projectId === projectId &&
            isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
        ),
        appSettings.sidebarThreadSortOrder,
        { attentionFirst: appSettings.sidebarThreadAttentionFirst },
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      displaySidebarThreads,
      hideAutomationRunThreads,
      navigate,
    ],
  );

  const openOrCreateProjectThreadFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot): Promise<boolean> => {
      // The store may already contain events newer than this response. Rank
      // each candidate from its coherent normalized summary, including visits.
      const summaries = useStore.getState().sidebarThreadSummaryById;
      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .flatMap((thread) => {
            const summary = summaries[thread.id];
            return summary ? [summary] : [];
          })
          .filter(
            (thread) =>
              thread.projectId === projectId &&
              (thread.archivedAt ?? null) === null &&
              thread.snoozedUntil == null &&
              !isSidechatThread(thread),
          ),
        appSettings.sidebarThreadSortOrder,
        { attentionFirst: appSettings.sidebarThreadAttentionFirst },
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return true;
      }

      return (await handleNewThread(projectId).catch(() => null)) !== null;
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
    ],
  );

  const openExistingProjectFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot): Promise<boolean> => {
      const existingProject =
        snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
      if (!existingProject) {
        return false;
      }

      // The store may already contain events newer than this response. Rank
      // each candidate from its coherent normalized summary, including visits.
      const summaries = useStore.getState().sidebarThreadSummaryById;
      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .flatMap((thread) => {
            const summary = summaries[thread.id];
            return summary ? [summary] : [];
          })
          .filter(
            (thread) =>
              thread.projectId === projectId &&
              (thread.archivedAt ?? null) === null &&
              thread.snoozedUntil == null,
          ),
        appSettings.sidebarThreadSortOrder,
        { attentionFirst: appSettings.sidebarThreadAttentionFirst },
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return true;
      }

      setProjectExpanded(projectId, true);
      return (await handleNewThread(projectId).catch(() => null)) !== null;
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      setProjectExpanded,
    ],
  );

  // Poll the server read model briefly after project.create so we only recover from fresh state.
  const waitForProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
      workspaceRoot?: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  // Cancellation can arrive while the server is committing project.create. Give
  // that durable commit and its read-model projection enough time to become
  // observable before reporting the clone as cancelled.
  const waitForCancelledGitHubProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
      workspaceRoot?: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: GITHUB_CANCEL_RECOVERY_MAX_ATTEMPTS,
        delayMs: GITHUB_CANCEL_RECOVERY_DELAY_MS,
      }),
    [],
  );

  const waitForProjectWorkspaceRootInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        workspaceRoot,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  // Keep add-project recovery on the same fresh-snapshot path for create, duplicate, and existing-project flows.
  const recoverExistingProjectFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [openExistingProjectFromSnapshot, syncServerShellSnapshot, waitForProjectInSnapshot],
  );

  const recoverExistingProjectByWorkspaceRootFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectWorkspaceRootInSnapshot(api, workspaceRoot);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [
      openExistingProjectFromSnapshot,
      syncServerShellSnapshot,
      waitForProjectWorkspaceRootInSnapshot,
    ],
  );

  const handleOpenProjectFromSearch = useCallback(
    (projectId: string) => {
      const typedProjectId = ProjectId.makeUnsafe(projectId);
      // Match focusMostRecentThreadForProject's visibility filter: if a project's only
      // threads are hidden automation runs, fall through to creating a fresh thread
      // instead of focusing nothing.
      const hasProjectThread = sidebarThreads.some(
        (thread) =>
          thread.projectId === typedProjectId &&
          isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
      );
      if (hasProjectThread) {
        focusMostRecentThreadForProject(typedProjectId);
        return;
      }

      void handleNewThread(typedProjectId);
    },
    [focusMostRecentThreadForProject, handleNewThread, hideAutomationRunThreads, sidebarThreads],
  );

  // Shared resolver behind resolveBackToThreadsTarget and the settings-back path below.
  const resolveBackTargetForThreads = useCallback(
    (threads: readonly SidebarThreadSummary[], extraAvailableThreadIds?: ReadonlySet<string>) => {
      const latestThread =
        sortThreadsForSidebar(threads, appSettings.sidebarThreadSortOrder, {
          attentionFirst: appSettings.sidebarThreadAttentionFirst,
        })[0] ?? null;
      const availableThreadIds = new Set<string>(threads.map((thread) => thread.id));
      if (extraAvailableThreadIds) {
        for (const threadId of extraAvailableThreadIds) {
          availableThreadIds.add(threadId);
        }
      }
      return resolveSettingsBackTarget({
        lastThreadRoute,
        availableThreadIds,
        availableSplitViewIds: new Set(
          Object.keys(splitViewsById).filter((splitViewId) => splitViewsById[splitViewId]),
        ),
        latestThreadId: latestThread?.id ?? null,
      });
    },
    [
      appSettings.sidebarThreadAttentionFirst,
      appSettings.sidebarThreadSortOrder,
      lastThreadRoute,
      splitViewsById,
    ],
  );

  // Fresh unsent chats have a route id but no persisted sidebar summary yet. Keep those draft
  // routes valid return targets — scoped to whichever segment the draft's project belongs to —
  // for both the settings back button and the segment switcher.
  const nonGroupDraftThreadIds = useMemo(() => {
    const draftThreadIds = new Set<string>();
    for (const [threadId, draft] of Object.entries(draftThreadsByThreadId)) {
      if (!groupProjectIdSet.has(draft.projectId)) {
        draftThreadIds.add(threadId);
      }
    }
    return draftThreadIds;
  }, [draftThreadsByThreadId, groupProjectIdSet]);

  const resolveBackToThreadsTarget = useCallback(
    () => resolveBackTargetForThreads(visibleNonGroupSidebarThreads, nonGroupDraftThreadIds),
    [nonGroupDraftThreadIds, resolveBackTargetForThreads, visibleNonGroupSidebarThreads],
  );

  // Navigates to a resolved settings-back / segment-switch target. Returns whether it navigated
  // to a thread so callers can fall back to creating a fresh chat/home route otherwise.
  const navigateToBackTarget = useCallback(
    (target: SettingsBackTarget) => {
      if (target.kind !== "thread") {
        return false;
      }
      // The route swap re-renders the whole sidebar surface plus the destination
      // ChatView in one go; run it as a transition so urgent click feedback (the
      // segmented picker's optimistic thumb) paints first instead of freezing
      // until the heavy render commits.
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(target.threadId) },
          search: () => ({
            splitViewId: target.splitViewId,
          }),
        });
      });
      return true;
    },
    [navigate],
  );

  // Back to the thread view from another section: the remembered thread first, else the
  // stored home-chat draft (same as "New chat"), so an in-progress draft is never lost.
  const openThreadsView = useCallback(() => {
    if (navigateToBackTarget(resolveBackToThreadsTarget())) {
      return;
    }
    void handleNewChat();
  }, [handleNewChat, navigateToBackTarget, resolveBackToThreadsTarget]);

  // The `/hubs` route owns the hidden-section redirect (a hidden Groups tab
  // also hides the section surface only) — the sidebar must not bounce group
  // threads opened from search, split view, or a link while the tab is hidden.
  useEffect(() => {
    // Persisted paths make homeDir truthy
    // immediately on reload, well before the first shell snapshot arrives.
    if (!threadsHydrated || !homeDir) {
      return;
    }
    prewarmHomeChatProject({ homeDir, chatWorkspaceRoot });
  }, [chatWorkspaceRoot, homeDir, threadsHydrated]);
  // Opens a fresh home-chat draft directly on the draft thread route so the first send
  // does not need a second route swap from "/" to "/$threadId".
  const handleCreateHomeChat = useCallback(async () => {
    // Reuse the stored home-chat draft thread when one exists (matching the
    // project "New thread" button), so a draft typed in a new chat survives
    // switching to another thread and back. Only mint a fresh draft when there
    // is no stored draft to resume.
    await handleNewChat();
  }, [handleNewChat]);

  const addProjectFromPath = useCallback(
    async (
      rawCwd: string,
      options: {
        createIfMissing?: boolean;
        additionalFolders?: ReadonlyArray<string> | undefined;
      } = {},
    ) => {
      const cwd = rawCwd.trim();
      if (!cwd) {
        throw new Error("Project folder path is empty.");
      }
      const api = readNativeApi();
      if (!api) {
        throw new Error("The app server is unavailable.");
      }

      // The flow lives in a nested function that the exclusive lock helper merely awaits: React
      // Compiler's BuildHIR cannot lower a `throw` or a value block (`?.`, `??`, ternary,
      // conditional spread) that sits directly inside a try block, and a single one of them
      // makes the entire Sidebar bail out of compilation — silently, since `panicThreshold`
      // is unset. Nested function bodies are lowered separately and are unaffected, and the
      // catch below still sees every rejection. See Sidebar.compiler.test.ts.
      const additionalFolders = options.additionalFolders ?? [];
      const runAddProject = async () => {
        const existing = findWorkspaceRootMatch(projects, cwd, (project) => project.cwd);
        // A multi-folder project never reopens an existing one: that would drop its extra
        // folders. The create below reports the conflict instead.
        const existingRecovery = await recoverExistingAddProjectTarget({
          existingProjectId: additionalFolders.length > 0 ? undefined : existing?.id,
          workspaceRoot: cwd,
          recoverByProjectId: (projectId) => recoverExistingProjectFromServer(api, projectId),
          recoverByWorkspaceRoot: (workspaceRoot) =>
            recoverExistingProjectByWorkspaceRootFromServer(api, workspaceRoot),
        });
        if (existingRecovery === "recovered") {
          return;
        }
        if (existing) {
          // Local project state can briefly outlive a server-side project.deleted event.
          // Continue to project.create so re-adding the folder revives it instead of opening a dead shell.
        }

        const creationResult = await createOrRecoverProjectFromPath({
          api,
          workspaceRoot: cwd,
          ...(additionalFolders.length > 0 ? { additionalFolders } : {}),
          ...(options.createIfMissing === undefined
            ? {}
            : { createIfMissing: options.createIfMissing }),
          defaultProvider: appSettings.defaultProvider,
          loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
          maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
          delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
        });
        if (creationResult.snapshot) {
          syncServerShellSnapshot(creationResult.snapshot);
        }
        if (creationResult.project && creationResult.snapshot) {
          const recovered = creationResult.created
            ? await openOrCreateProjectThreadFromSnapshot(
                creationResult.project.id,
                creationResult.snapshot,
              )
            : await openExistingProjectFromSnapshot(
                creationResult.project.id,
                creationResult.snapshot,
              );
          if (recovered) {
            return;
          }
          if (creationResult.created) {
            // The opener's draft navigation was superseded; retrying here
            // would override the user's newer route.
            throw new Error("Project creation was superseded before its chat opened.");
          }
        }

        if (!creationResult.created) {
          const recovered = await recoverExistingProjectFromServer(api, creationResult.projectId);
          if (recovered) {
            return;
          }
          throw new Error(PROJECT_CREATE_EXISTING_SYNC_ERROR);
        }

        // The command already committed successfully at this point. If the projection
        // snapshot is just slow to catch up, continue with the local new-thread flow
        // instead of surfacing a false-negative sidebar sync error.
        setProjectExpanded(creationResult.projectId, true);
        const threadId = await handleNewThread(creationResult.projectId).catch(() => null);
        if (!threadId) {
          throw new Error("Project creation was superseded before its chat opened.");
        }
      };

      await runExclusiveProjectAddition(projectAdditionLockRef, runAddProject);
    },
    [
      appSettings.defaultProvider,
      handleNewThread,
      projects,
      recoverExistingProjectFromServer,
      recoverExistingProjectByWorkspaceRootFromServer,
      openOrCreateProjectThreadFromSnapshot,
      openExistingProjectFromSnapshot,
      setProjectExpanded,
      syncServerShellSnapshot,
    ],
  );

  const handleStartAddProject = useCallback(() => {
    setCreateProjectDialogOpen(true);
  }, [setCreateProjectDialogOpen]);

  const currentProjectShortcutTargetId = useMemo(
    () => resolveCurrentProjectTargetId(ordinarySpaceProjects, focusedProjectId),
    [ordinarySpaceProjects, focusedProjectId],
  );
  const latestUsableProjectId = useMemo(
    () =>
      resolveLatestProjectTargetIdWithFallback(
        ordinarySpaceProjects,
        latestProjectId,
        projectLastActivityAt,
      ),
    [ordinarySpaceProjects, latestProjectId, projectLastActivityAt],
  );
  const primaryNewThreadTarget = useMemo(
    () =>
      resolveNewThreadTarget({
        currentProjectId: currentProjectShortcutTargetId,
        latestUsableProjectId,
      }),
    [currentProjectShortcutTargetId, latestUsableProjectId],
  );

  // Warm model discovery before ChatView mounts so new-thread composers skip
  // the "Loading models" skeleton when React Query already has a fresh cache hit.
  const prefetchModelsForProjectNewThread = useCallback(
    (projectId: ProjectId, options?: { includeDroid?: boolean }) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        return;
      }

      const draftStore = useComposerDraftStore.getState();
      const draftThread = draftStore.getDraftThreadByProjectId(projectId, "chat");
      const draftComposer = draftThread
        ? (draftStore.draftsByThreadId[draftThread.threadId] ?? null)
        : null;
      prefetchModelsForNewThread(queryClient, {
        settings: appSettings,
        serverSettings: serverSettings ?? null,
        hiddenProviders: appSettings.hiddenProviders,
        draftActiveProvider: draftComposer?.activeProvider ?? null,
        stickyActiveProvider: draftStore.stickyActiveProvider,
        projectDefaultProvider: project.defaultModelSelection?.provider ?? null,
        projectCwd: project.cwd,
        draftWorktreePath: draftThread?.worktreePath ?? null,
        serverCwd,
        // Match new-thread bootstrap: preserve existing drafts and apply project
        // preferences only when creating a fresh one.
        envMode:
          draftThread?.envMode ??
          useProjectEnvironmentStore.getState().envModeByProjectId[projectId] ??
          appSettings.defaultThreadEnvMode,
        providerStatuses,
        statusesReconciled: hasReconciledServerProviderStatuses(queryClient),
        providerOrder: appSettings.providerOrder,
        includeDroid: options?.includeDroid === true,
      });
    },
    [appSettings, projects, providerStatuses, queryClient, serverCwd, serverSettings],
  );

  const prefetchModelsForPrimaryNewThread = useCallback(() => {
    if (!primaryNewThreadTarget) {
      return;
    }
    // Idle hover/focus must not spin Droid's expensive per-model ACP discovery;
    // only explicit new-thread intent (the click path below) warms Droid.
    prefetchModelsForProjectNewThread(primaryNewThreadTarget.projectId);
  }, [prefetchModelsForProjectNewThread, primaryNewThreadTarget]);

  useEffect(() => {
    if (!primaryNewThreadTarget) {
      return;
    }
    prefetchModelsForProjectNewThread(primaryNewThreadTarget.projectId);
  }, [prefetchModelsForProjectNewThread, primaryNewThreadTarget]);

  const handlePrimaryNewThread = useCallback(() => {
    const action = resolvePrimaryNewChatAction({
      hasProjectTarget: primaryNewThreadTarget !== null,
      threadsHydrated,
    });
    if (action === "project-thread" && primaryNewThreadTarget) {
      prefetchModelsForProjectNewThread(primaryNewThreadTarget.projectId, { includeDroid: true });
      void handleNewThread(primaryNewThreadTarget.projectId);
      return;
    }
    // With no project, New chat opens the global chat home (never "Create project").
    if (action === "home-chat") void handleCreateHomeChat();
  }, [
    handleCreateHomeChat,
    handleNewThread,
    prefetchModelsForProjectNewThread,
    primaryNewThreadTarget,
    threadsHydrated,
  ]);

  const handleImportThread = useCallback(
    async (target: ThreadImportTarget, externalId: string) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("The app server is unavailable.");
      }

      if (!currentProjectShortcutTargetId) {
        throw new Error("Add a project before importing a thread.");
      }

      const activeProject = projects.find(
        (project) => project.id === currentProjectShortcutTargetId,
      );
      if (!activeProject) {
        throw new Error("The target project could not be resolved.");
      }

      const { provider, instanceId } = target;
      const providerDefaultModel = getDefaultModel(provider);
      let modelSelection =
        activeProject.defaultModelSelection?.provider === provider &&
        activeProject.defaultModelSelection.instanceId === instanceId
          ? activeProject.defaultModelSelection
          : providerDefaultModel
            ? {
                provider,
                instanceId,
                model: providerDefaultModel,
              }
            : null;
      if (!modelSelection && provider === "omp") {
        // OMP has no static default model; the imported session's own last-used
        // model wins server-side during import. The thread record still needs a
        // catalog-valid placeholder selection.
        const catalog = await queryClient
          .fetchQuery(
            providerModelsQueryOptions({
              provider: "omp",
              instanceId,
              cwd: activeProject.cwd,
            }),
          )
          .catch(() => null);
        const fallbackModel = catalog?.models[0]?.slug;
        modelSelection = fallbackModel
          ? {
              provider: "omp",
              instanceId,
              model: fallbackModel,
            }
          : null;
      }
      if (!modelSelection) {
        throw new Error(
          provider === "omp"
            ? "No Oh My Pi models are discovered yet; configure an OMP provider before importing."
            : `Select a ${PROVIDER_DISPLAY_NAMES[provider]} model before importing.`,
        );
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const trimmedExternalId = externalId.trim();
      const suffix = trimmedExternalId.slice(-8);
      const title =
        provider === "claudeAgent"
          ? `Imported Claude session${suffix ? ` ${suffix}` : ""}`
          : provider === "cursor"
            ? `Imported Cursor session${suffix ? ` ${suffix}` : ""}`
            : provider === "droid"
              ? `Imported Droid session${suffix ? ` ${suffix}` : ""}`
              : provider === "opencode"
                ? `Imported OpenCode session${suffix ? ` ${suffix}` : ""}`
                : provider === "omp"
                  ? `Imported Oh My Pi session${suffix ? ` ${suffix}` : ""}`
                  : `Imported Codex thread${suffix ? ` ${suffix}` : ""}`;
      let createdThread = false;

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: activeProject.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          branch: null,
          worktreePath: null,
          createdAt,
        });
        createdThread = true;

        await api.orchestration.importThread({
          threadId,
          externalId: trimmedExternalId,
        });

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      } catch (error) {
        if (createdThread) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
    [
      appSettings.defaultThreadEnvMode,
      currentProjectShortcutTargetId,
      navigate,
      projects,
      queryClient,
    ],
  );

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const outcome = await dispatchThreadRename({
        threadId,
        newTitle,
        unchangedTitles: [originalTitle],
      }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return null;
      });

      if (outcome === "empty") {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
      }
    },
    [],
  );

  const openRenameThreadDialog = useCallback((threadId: ThreadId) => {
    setRenameDialogThreadId(threadId);
  }, []);

  const handleThreadRenamePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") {
        return;
      }

      const previousTap = lastThreadRenameTapRef.current;
      const currentTapTimestamp = event.timeStamp;
      if (
        previousTap &&
        previousTap.threadId === threadId &&
        currentTapTimestamp - previousTap.timestamp <= 320
      ) {
        event.preventDefault();
        event.stopPropagation();
        lastThreadRenameTapRef.current = null;
        openRenameThreadDialog(threadId);
        return;
      }

      lastThreadRenameTapRef.current = {
        threadId,
        timestamp: currentTapTimestamp,
      };
    },
    [openRenameThreadDialog],
  );

  const { prewarmThreadDetail: prewarmThreadDetailForIntent } = useThreadDetailPrewarm();

  const primeThreadActivation = useCallback(
    (event: ReactPointerEvent<HTMLElement>, threadId: ThreadId) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      prewarmThreadDetailForIntent(threadId);
      setOptimisticActiveThreadId(threadId);
    },
    [prewarmThreadDetailForIntent],
  );

  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();
  const copyPathToClipboard = useCopyPathToClipboard();
  const handoffThread = useCallback(
    async (thread: Thread, target: ThreadHandoffTarget) => {
      try {
        await createThreadHandoff(thread, target.provider, target.instanceId);
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
    },
    [createThreadHandoff],
  );

  const continueHandoffInThread = useCallback(
    async (thread: Thread, target: ThreadHandoffTarget) => {
      try {
        await continueThreadHandoff(thread, target.provider, target.instanceId);
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
    },
    [continueThreadHandoff],
  );

  const forkThread = useCallback(
    async (thread: Thread, target: ForkThreadTarget) => {
      const api = readNativeApi();
      if (!api) return;
      const projectCwd = projectCwdById.get(thread.projectId) ?? null;
      // Only a thread without its own branch needs the root checkout's branch.
      const needsRootBranch = !thread.branch && projectCwd !== null;
      // Promise chains rather than try/catch: React Compiler bails out on value
      // blocks inside a try statement, and this file has a zero-bailout budget.
      await (
        needsRootBranch
          ? queryClient
              .fetchQuery(gitBranchesQueryOptions(projectCwd))
              .then((result) => result.branches)
              .catch(() => null)
          : Promise.resolve(null)
      )
        .then((branches) =>
          dispatchThreadFork({
            api,
            sourceThread: thread,
            target,
            rootBranch: resolveComposerSlashRootBranch({
              branches,
              activeProjectCwd: projectCwd,
              activeThreadBranch: thread.branch,
            }),
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          }),
        )
        .then(async (nextThreadId) => {
          syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
          await navigate({ to: "/$threadId", params: { threadId: nextThreadId } });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not fork thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the forked thread.",
          });
        });
    },
    [navigate, projectCwdById, queryClient, syncServerShellSnapshot],
  );

  // Posts the "pick this thread up" user message to a group's coordinator once
  // its coordinator thread exists (right after onboarding save, or immediately
  // when moving a thread into a configured group).
  const postGroupPickupMessage = useCallback(
    async (coordinatorThreadId: ThreadId, text: string): Promise<boolean> => {
      const api = readNativeApi();
      if (!api) return false;
      // Run the coordinator under its configured runtime mode — never a
      // blanket full-access turn.
      const runtimeMode =
        useStore.getState().threadShellById?.[coordinatorThreadId]?.runtimeMode ??
        "approval-required";
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: coordinatorThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not notify the coordinator",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        return false;
      }
    },
    [],
  );

  const handleThreadContextMenu = useCallback(
    async (
      threadId: ThreadId,
      position: { x: number; y: number },
      options?: ThreadContextMenuOptions,
    ) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = getThreadFromState(useStore.getState(), threadId);
      if (!thread) return;
      const extraItems = options?.extraItems ?? [];
      // Only leaf rows resolve the menu; a parent row just opens its submenu.
      const extraItemIds = new Set(
        extraItems.flatMap((item) => item.children?.map((child) => child.id) ?? [item.id]),
      );
      const threadSummary = sidebarThreadSummaryById[threadId];
      const isPinned = pinnedThreadIdSet.has(threadId);
      const hasPendingApprovals =
        threadSummary?.hasPendingApprovals ??
        derivePendingApprovals(thread.activities, thread.pendingInteractions, {
          authoritativeHasPending: thread.hasPendingApprovals,
          latestTurnId: thread.latestTurn?.turnId,
        }).length > 0;
      const hasPendingUserInput =
        threadSummary?.hasPendingUserInput ??
        derivePendingUserInputs(thread.activities, thread.pendingInteractions, {
          authoritativeHasPending: thread.hasPendingUserInput,
          latestTurnId: thread.latestTurn?.turnId,
        }).length > 0;
      const handoffAvailability = resolveThreadHandoffAvailability({
        isGroupContainer: groupProjectIdSet.has(thread.projectId),
        isCoordinatorThread: coordinatorThreadIds.has(threadId),
      });
      const canHandoff =
        handoffAvailability.providerHandoff &&
        canCreateThreadHandoff({
          thread,
          hasPendingApprovals,
          hasPendingUserInput,
        });
      const threadStatus = threadSummary ? resolveThreadStatusForSidebar(threadSummary) : null;
      const canSnooze = canSnoozeThread(thread);
      const handoffTargets = canHandoff
        ? resolveAvailableHandoffTargets({
            sourceProvider: thread.modelSelection.provider,
            sourceProviderInstanceId:
              thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
            providerInstances: getProviderInstanceOptions(appSettings),
            providerStatuses,
          })
        : [];
      const continueHandoffTargets = handoffTargets.filter((target) =>
        canContinueThreadHandoff({
          sourceProvider: thread.modelSelection.provider,
          sourceProviderInstanceId:
            thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
          targetProvider: target.provider,
          targetProviderInstanceId: target.instanceId,
        }),
      );
      const handoffTargetById = new Map(
        handoffTargets.map((target) => [`handoff:${target.instanceId}`, target]),
      );
      const continueHandoffTargetById = new Map(
        continueHandoffTargets.map((target) => [`handoff-here:${target.instanceId}`, target]),
      );
      const handoffItems = contextMenuGroup(
        { id: "handoff", label: "Handoff", icon: THREAD_CONTEXT_MENU_ICONS.handoff },
        [
          ...continueHandoffTargets.map((target) => ({
            id: `handoff-here:${target.instanceId}`,
            label: `${target.label} in this thread`,
            standaloneLabel: `Handoff to ${target.label} in this thread`,
            icon: THREAD_CONTEXT_MENU_ICONS.handoff,
          })),
          ...handoffTargets.map((target, index) => ({
            id: `handoff:${target.instanceId}`,
            label:
              continueHandoffTargets.length > 0 ? `${target.label} in a new thread` : target.label,
            standaloneLabel: `Handoff to ${target.label}`,
            icon: THREAD_CONTEXT_MENU_ICONS.handoff,
            ...(index === 0 && continueHandoffTargets.length > 0 ? { separatorBefore: true } : {}),
          })),
        ],
      );
      // Same action as `/fork`.
      const canFork = canForkThread({ thread, handoffAvailability });
      const forkItems = canFork
        ? contextMenuGroup({ id: "fork", label: "Fork", icon: THREAD_CONTEXT_MENU_ICONS.fork }, [
            {
              id: "fork:local",
              label: FORK_THREAD_TARGET_LABELS.local,
              icon: THREAD_CONTEXT_MENU_ICONS.forkLocal,
            },
            {
              id: "fork:worktree",
              label: FORK_THREAD_TARGET_LABELS.worktree,
              icon: THREAD_CONTEXT_MENU_ICONS.forkWorktree,
            },
          ])
        : [];
      if (forkItems[0] && handoffItems.length === 0) {
        forkItems[0] = { ...forkItems[0], separatorBefore: true };
      }
      if (handoffItems[0]) {
        handoffItems[0] = { ...handoffItems[0], separatorBefore: true };
      }
      const threadWorkspacePath = resolveThreadWorkspaceCwd({
        projectCwd: projectCwdById.get(thread.projectId) ?? null,
        envMode: thread.envMode,
        worktreePath: thread.worktreePath,
      });
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread", icon: THREAD_CONTEXT_MENU_ICONS.rename },
          {
            id: "share-guest",
            label: "Share with guest…",
            icon: THREAD_CONTEXT_MENU_ICONS.shareGuest,
          },
          {
            id: "toggle-pin",
            label: pinActionLabel("thread", isPinned),
            icon: THREAD_CONTEXT_MENU_ICONS.pin,
          },
          ...(threadStatus?.dismissible
            ? [
                {
                  id: "clear-notification",
                  label: "Clear notification",
                  icon: THREAD_CONTEXT_MENU_ICONS.clearNotification,
                },
              ]
            : []),
          { id: "mark-unread", label: "Mark unread", icon: THREAD_CONTEXT_MENU_ICONS.markUnread },
          ...(canSnooze
            ? [
                ...(threadSummary?.snoozedUntil != null
                  ? [
                      {
                        id: "snooze-cancel",
                        label: "Return now",
                        icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                        separatorBefore: true,
                      },
                    ]
                  : []),
                ...contextMenuGroup(
                  {
                    id: "snooze",
                    label: threadSummary?.snoozedUntil != null ? "Reschedule" : "Snooze",
                    icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                    separatorBefore: threadSummary?.snoozedUntil == null,
                  },
                  [
                    ...SNOOZE_PRESETS.map((preset) => ({
                      id: preset.id,
                      label: preset.label,
                      icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                    })),
                    {
                      id: "snooze-custom",
                      label: "Pick date & time…",
                      icon: THREAD_CONTEXT_MENU_ICONS.snooze,
                    },
                  ],
                ),
              ]
            : []),
          ...handoffItems,
          ...forkItems,
          ...contextMenuGroup(
            {
              id: "copy",
              label: "Copy",
              icon: THREAD_CONTEXT_MENU_ICONS.copy,
              separatorBefore: true,
            },
            [
              {
                id: "copy-path",
                label: "Path",
                standaloneLabel: "Copy Path",
                icon: THREAD_CONTEXT_MENU_ICONS.copy,
              },
              {
                id: "copy-thread-id",
                label: "Thread ID",
                standaloneLabel: "Copy Thread ID",
                icon: THREAD_CONTEXT_MENU_ICONS.copy,
              },
            ],
          ),
          ...(threadWorkspacePath
            ? [
                {
                  id: "open-path-in-terminal",
                  label: "Open Path in Terminal",
                  icon: THREAD_CONTEXT_MENU_ICONS.openInTerminal,
                },
              ]
            : []),
          ...extraItems,
          // Subagent threads are archived and restored through their parent
          // (thread.archive cascades); archiving one alone would strand it with
          // no sidebar or Archived-panel row to restore it from.
          ...(thread.parentThreadId
            ? []
            : [
                {
                  id: "archive",
                  label: "Archive",
                  icon: THREAD_CONTEXT_MENU_ICONS.archive,
                  separatorBefore: true,
                },
              ]),
          {
            id: "delete",
            label: "Delete",
            icon: THREAD_CONTEXT_MENU_ICONS.delete,
            destructive: true,
            ...(thread.parentThreadId ? { separatorBefore: true } : {}),
          },
        ],
        position,
      );

      if (clicked !== null && extraItemIds.has(clicked)) {
        await options?.onExtraAction?.(clicked);
        return;
      }
      if (clicked === "rename") {
        openRenameThreadDialog(threadId);
        return;
      }
      if (clicked === "share-guest") {
        openGuestShareDialog(threadId);
        return;
      }
      if (clicked === "toggle-pin") {
        toggleThreadPinned(threadId);
        return;
      }

      if (clicked === "mark-unread") {
        handleMarkThreadUnread(threadId);
        return;
      }
      if (clicked === "clear-notification") {
        clearThreadNotification(threadId);
        return;
      }
      if (clicked === "snooze-cancel") {
        setThreadSnoozedUntil(threadId, null);
        return;
      }
      if (clicked === "snooze-custom") {
        setSnoozeDialogThreadId(threadId);
        return;
      }
      const snoozePreset = SNOOZE_PRESETS.find((preset) => preset.id === clicked);
      if (snoozePreset) {
        snoozeThread(threadId, snoozePreset.duration);
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("handoff-here:")) {
        const target = continueHandoffTargetById.get(clicked);
        if (target) {
          await continueHandoffInThread(thread, target);
        }
        return;
      }
      if (typeof clicked === "string" && clicked.startsWith("handoff:")) {
        const target = handoffTargetById.get(clicked);
        if (target) {
          await handoffThread(thread, target);
        }
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath);
        return;
      }
      if (clicked === "open-path-in-terminal") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to open.",
          });
          return;
        }
        await navigate({ to: "/$threadId", params: { threadId } });
        const terminalStore = useTerminalStateStore.getState();
        const currentTerminalState = selectThreadTerminalState(
          terminalStore.terminalStateByThreadId,
          threadId,
        );

        const targetTerminalId = currentTerminalState.activeTerminalId;
        if (currentTerminalState.runningTerminalIds.includes(targetTerminalId)) {
          toastManager.add({
            type: "error",
            title: "Terminal is busy",
            description: "Stop its command before opening another path.",
          });
          return;
        }
        const shouldCreateNewTerminal = !currentTerminalState.terminalOpen;

        const previousTerminalOpen = currentTerminalState.terminalOpen;
        const previousPresentationMode = currentTerminalState.presentationMode;
        const previousActiveTerminalId = currentTerminalState.activeTerminalId;

        terminalStore.setTerminalPresentationMode(threadId, "workspace");
        terminalStore.setTerminalOpen(threadId, true);
        terminalStore.setActiveTerminal(threadId, targetTerminalId);

        const cdCommand = `cd ${quotePosixShellArgument(threadWorkspacePath)}\r`;
        try {
          if (shouldCreateNewTerminal) {
            // A brand new PTY needs an explicit cwd so that the shell's first
            // prompt already shows the workspace path. The follow-up `cd` write
            // makes the navigation visible in the scrollback (it's effectively
            // a no-op since the shell is already there, but it matches the
            // user-typed-it experience).
            await api.terminal.open({
              threadId,
              terminalId: targetTerminalId,
              cwd: threadWorkspacePath,
            });
          }
          // Existing PTYs keep their launch cwd/env on reattach; writing `cd`
          // navigates in place without replacing shell state.
          await api.terminal.write({
            threadId,
            terminalId: targetTerminalId,
            data: cdCommand,
            onlyIfIdle: true,
          });
        } catch (error) {
          // Open may already have created a PTY, even if navigation or its
          // acknowledgement failed. Keep its identity available for reattach.
          terminalStore.setTerminalPresentationMode(threadId, previousPresentationMode);
          terminalStore.setTerminalOpen(threadId, previousTerminalOpen);
          if (previousActiveTerminalId) {
            terminalStore.setActiveTerminal(threadId, previousActiveTerminalId);
          }
          toastManager.add({
            type: "error",
            title: "Unable to open terminal",
            description:
              error instanceof Error ? error.message : "The terminal could not be opened.",
          });
        }
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId);
        return;
      }
      if (clicked === "fork:local" || clicked === "fork:worktree") {
        await forkThread(thread, clicked === "fork:worktree" ? "worktree" : "local");
        return;
      }
      if (clicked === "archive") {
        await confirmAndArchiveThread(threadId);
        return;
      }
      if (clicked !== "delete") return;
      await confirmAndDeleteThread(threadId);
    },
    [
      appSettings,
      canSnoozeThread,
      confirmAndArchiveThread,
      confirmAndDeleteThread,
      coordinatorThreadIds,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      clearThreadNotification,
      continueHandoffInThread,
      forkThread,
      groupProjectIdSet,
      handoffThread,
      membersLoaded,
      handleMarkThreadUnread,
      navigate,
      openRenameThreadDialog,
      pinnedThreadIdSet,
      projectCwdById,
      projects,
      providerStatuses,
      resolveThreadStatusForSidebar,
      serverSettingsQuery.data?.providers,
      sidebarThreadSummaryById,
      setThreadSnoozedUntil,
      snoozeThread,
      summariesByProjectId,
      summaryFor,
      toggleThreadPinned,
    ],
  );
  // The open-thread tabs open this same menu for their thread, with their close rows added.
  useEffect(() => registerThreadContextMenu(handleThreadContextMenu), [handleThreadContextMenu]);
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          {
            id: "mark-unread",
            label: `Mark unread (${count})`,
            icon: THREAD_CONTEXT_MENU_ICONS.markUnread,
          },
          { id: "archive", label: `Archive (${count})`, icon: THREAD_CONTEXT_MENU_ICONS.archive },
          {
            id: "delete",
            label: `Delete (${count})`,
            icon: THREAD_CONTEXT_MENU_ICONS.delete,
            destructive: true,
          },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          handleMarkThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked === "archive") {
        // Subagent threads follow their parent's archive cascade. Archiving one
        // directly would strand it, and archiving it after its parent in this
        // loop would fail the not-archived invariant.
        const archiveIds = ids.filter(
          (id) => (getThreadFromState(useStore.getState(), id)?.parentThreadId ?? null) === null,
        );
        if (archiveIds.length === 0) {
          removeFromSelection(ids);
          return;
        }
        if (appSettings.confirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            [
              `Archive ${archiveIds.length} ${pluralize(archiveIds.length, "thread")}?`,
              "Archived threads are hidden from the sidebar but can be restored later.",
            ].join("\n"),
          );
          if (!confirmed) return;
        }

        const excludedThreadIds = new Set<ThreadId>(ids);
        for (const id of archiveIds) {
          await archiveThread(id, { excludedThreadIds });
        }
        removeFromSelection(ids);
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} ${pluralize(count, "thread")}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      const successfullyDeletedIds: ThreadId[] = [];
      const runDeletes = async (): Promise<void> => {
        for (const id of ids) {
          await deleteThread(id, { deletedThreadIds: deletedIds, reconcileDeletedThread: false });
          successfullyDeletedIds.push(id);
        }
      };
      await runDeletes().finally(() => {
        if (successfullyDeletedIds.length > 0) {
          void reconcileDeletedThreadsFromClient({
            threadIds: successfullyDeletedIds,
            removeDeletedThreadFromClientState:
              useStore.getState().removeDeletedThreadFromClientState,
          });
        }
      });
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadArchive,
      appSettings.confirmThreadDelete,
      archiveThread,
      clearSelection,
      deleteThread,
      handleMarkThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

  const rememberLastThreadRouteNow = useCallback(
    (nextLastThreadRoute: LastThreadRoute) => {
      setLastThreadRoute(nextLastThreadRoute);
      persistSidebarRouteState({
        lastThreadRoute: nextLastThreadRoute,
        safeMainNavigationTarget: readSidebarUiState().safeMainNavigationTarget,
      });
      persistSidebarUiPreferences({
        chatSectionExpanded,
        chatThreadListExtraPages,
        projectThreadListExtraPagesByCwd: Object.fromEntries(threadListExtraPagesByProjectCwd),
        dismissedThreadStatusKeyByThreadId,
        activityViewEnabled,
        activityScope,
      });
    },
    [
      activityScope,
      activityViewEnabled,
      chatSectionExpanded,
      chatThreadListExtraPages,
      dismissedThreadStatusKeyByThreadId,
      threadListExtraPagesByProjectCwd,
    ],
  );
  const { activateThreadFromSidebarIntent } = useThreadActivationController({
    activeSplitView,
    clearSelection,
    navigate,
    openChatThreadPage,
    openSidechatDock: ({ sourceThreadId, sidechatThreadId }) =>
      openRightDockPane(sourceThreadId, {
        kind: "sidechat",
        threadId: sidechatThreadId,
      }),
    openTerminalThreadPage,
    prewarmThreadDetailForIntent,
    rememberLastThreadRouteNow,
    routeSplitViewId: routeSearch.splitViewId,
    routeThreadId,
    selectedThreadCount: selectedThreadIds.size,
    setOptimisticActiveThreadId,
    setSelectionAnchor,
    setSplitFocusedPane,
    sidebarThreadSummaryById,
    splitViewsById,
    terminalStateByThreadId,
  });
  // Capture at activation, after selection modifiers and before the route changes layout.
  const activateThreadRow = (threadId: ThreadId, row: HTMLElement) => {
    const viewport = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    pendingThreadRowAnchorRef.current =
      viewport && threadId !== routeThreadId
        ? {
            threadId,
            row,
            viewport,
            top: row.getBoundingClientRect().top,
            scrollTop: viewport.scrollTop,
          }
        : null;
    activateThreadFromSidebarIntent(threadId);
  };
  // PR chip on a thread row behaves like a link: a plain click opens the PR in the thread's
  // right dock, while cmd/ctrl/middle-click (or a non-GitHub URL) opens it on GitHub.
  const openThreadPullRequest = useCallback(
    (
      event: MouseEvent<HTMLElement> | import("react").KeyboardEvent<HTMLElement>,
      thread: SidebarThreadSummary,
      pr: OrchestrationThreadPullRequest,
    ) => {
      const repository = parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(pr.url);
      if (
        event.metaKey ||
        event.ctrlKey ||
        ("button" in event && event.button === 1) ||
        !repository
      ) {
        openPrLink(event, pr.url);
        return;
      }
      if ("button" in event && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      activateThreadFromSidebarIntent(thread.id);
      openRightDockPane(thread.id, {
        kind: "pullRequest",
        pullRequestProjectId: thread.projectId,
        pullRequestRepository: repository,
        pullRequestNumber: pr.number,
        pullRequestInitialTab: "summary",
      });
    },
    [activateThreadFromSidebarIntent, openPrLink, openRightDockPane],
  );

  const handleCreateProjectSubmit = useCallback(
    async (value: CreateProjectSubmitValue, options: CreateProjectSubmitOptions) => {
      const runCreateProject = async () => {
        if (value.source === "github") {
          const api = readNativeApi();
          if (!api) throw new Error("The app server is unavailable.");
          await runExclusiveProjectAddition(projectAdditionLockRef, async () => {
            const openProvisionedProject = async (
              projectId: ProjectId,
              workspaceRoot: string | undefined,
              waitForProject: typeof waitForProjectInSnapshot,
            ) => {
              const { project, snapshot } = await waitForProject(api, projectId, workspaceRoot);
              if (snapshot) {
                syncServerShellSnapshot(snapshot);
              }
              if (!project || !snapshot) return false;

              return openExistingProjectFromSnapshot(project.id, snapshot);
            };
            const requestedProjectId = newProjectId();
            const requestedWorkspaceRoot = joinProjectPath(
              expandProjectHomePath(value.destinationParent, homeDir),
              value.directoryName,
            );
            const provision = await runProjectProvisionWithCancellationRecovery({
              signal: options.signal,
              provision: () =>
                api.projects.provisionFromGitHub(
                  {
                    operationId: value.operationId,
                    repository: value.repository,
                    destinationParent: value.destinationParent,
                    directoryName: value.directoryName,
                    commandId: newCommandId(),
                    projectId: requestedProjectId,
                    // Spaces were removed: a GitHub project is never filed under one.
                    newProjectSpaceId: null,
                    defaultModelSelection: {
                      provider: "codex",
                      model: getDefaultModel("codex"),
                    },
                    createdAt: new Date().toISOString(),
                  },
                  { signal: options.signal },
                ),
              // Cancellation can race the server's project.create commit. If that
              // commit won, recover the durable project and report success instead
              // of telling the user a registered project was cancelled.
              recoverCommittedProject: () =>
                openProvisionedProject(
                  requestedProjectId,
                  requestedWorkspaceRoot,
                  waitForCancelledGitHubProjectInSnapshot,
                ),
            });
            if (provision.status === "recovered") return;
            if (
              !(await openProvisionedProject(
                provision.result.projectId,
                undefined,
                waitForProjectInSnapshot,
              ))
            ) {
              throw new Error(
                "The GitHub project was added, but it has not synced into the sidebar yet. Try again in a moment.",
              );
            }
          });
        } else {
          await addProjectFromPath(value.workspaceRoot, {
            createIfMissing: value.createIfMissing,
            additionalFolders: value.additionalFolders,
          });
          // A name typed in the create dialog becomes the project's local name
          // once the created project is visible in the store.
          if (value.name) {
            const namedProject = findWorkspaceRootMatch(
              useStore.getState().projects,
              value.workspaceRoot,
              (project) => project.cwd,
            );
            if (namedProject) {
              renameProjectLocally(namedProject.id, value.name);
            }
          }
        }
      };

      await runCreateProject();
    },
    [
      addProjectFromPath,
      homeDir,
      openExistingProjectFromSnapshot,
      projects,
      renameProjectLocally,
      syncServerShellSnapshot,
      waitForCancelledGitHubProjectInSnapshot,
      waitForProjectInSnapshot,
    ],
  );

  // Shared by the project context menu's Delete and the edit dialog's red
  // "Remove local project" button — the project lifecycle's only destructive action.
  const removeProjectWithThreads = useCallback(
    async (projectId: ProjectId) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(projectId);
      if (!project) return;

      const projectThreads = excludeHiddenProjectAgentCoordinatorThreads(
        sidebarThreads.filter((thread) => thread.projectId === projectId),
        coordinatorThreadIds,
      );
      const confirmed = await api.dialogs.confirm(
        projectThreads.length > 0
          ? [
              `Remove project "${project.name}"?`,
              `This will delete ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in this folder and remove the project.`,
            ].join("\n")
          : `Remove project "${project.name}"?`,
      );
      if (!confirmed) return;

      // Nested function so the `try` body stays free of value blocks — see the comment on
      // `runAddProject` above for why React Compiler requires this shape.
      const runRemoveProject = async () => {
        // `project.delete` refuses non-empty folders, so `Remove` clears threads first.
        const deletionResult = await deleteProjectThreads(projectId, {
          confirmMessage: null,
          showEmptyToast: false,
          showResultToast: false,
          worktreeCleanupMode: "skip",
        });
        if (deletionResult === null) {
          return;
        }
        if (deletionResult.failureCount > 0) {
          toastManager.add({
            type: "error",
            title: `Failed to remove "${project.name}"`,
            description: `Could not delete ${deletionResult.failureCount} ${pluralize(deletionResult.failureCount, "thread")} in "${project.name}".`,
          });
          return;
        }

        await deleteProjectFromClient({
          api: api.orchestration,
          projectId,
          removeDeletedProjectFromClientState,
        });
        clearProjectDraftThreads(projectId);
        toastManager.add({
          type: "success",
          title: `Removed "${project.name}"`,
          description:
            deletionResult.deletedCount > 0
              ? `Deleted ${deletionResult.deletedCount} ${pluralize(deletionResult.deletedCount, "thread")} and removed the project.`
              : "Project removed.",
        });
      };

      try {
        await runRemoveProject();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearProjectDraftThreads,
      coordinatorThreadIds,
      deleteProjectThreads,
      projectById,
      removeDeletedProjectFromClientState,
      sidebarThreads,
    ],
  );
  const handleProjectContextMenuAction = useCallback(
    async (projectId: ProjectId, clicked: ProjectContextMenuId) => {
      setProjectContextMenuState(null);
      const api = readNativeApi();
      if (!api) return;
      const project = projectById.get(projectId);
      if (!project) return;

      if (clicked === "open-in-finder") {
        try {
          await api.shell.showInFolder(project.cwd);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Unable to open in Finder",
            description:
              error instanceof Error
                ? error.message
                : "An unknown error occurred opening the folder.",
          });
        }
        return;
      }
      if (clicked === "open-in-kanban") {
        void navigate({ to: "/kanban/$projectId", params: { projectId } });
        return;
      }
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd);
        return;
      }
      if (clicked === "start-dev") {
        openProjectRunDialog(projectId);
        return;
      }
      if (clicked === "stop-dev") {
        await handleStopProjectRun(projectId);
        return;
      }
      if (clicked === "open-dev-server") {
        await handleOpenProjectRunServer(projectId);
        return;
      }
      if (clicked === "relocate") {
        setRelocateProjectDialogId(projectId);
        return;
      }
      if (clicked === "rename") {
        setEditProjectDialog({ projectId, open: true });
        return;
      }
      if (clicked === "edit-project-agent") {
        setProjectAgentDialogState({
          projectId,
          mode: summaryFor(projectId)?.configured ? "edit" : "onboarding",
        });
        return;
      }
      if (clicked === "toggle-pin") {
        toggleProjectPinned(projectId);
        return;
      }
      if (clicked === "toggle-pin-project-agent") {
        toggleProjectAgentPinned(projectId);
        return;
      }
      if (clicked === "archive-threads") {
        await archiveAllThreadsInProject(projectId);
        return;
      }
      if (clicked === "delete-threads") {
        await deleteProjectThreads(projectId);
        return;
      }
      if (clicked !== "delete") return;
      await removeProjectWithThreads(projectId);
    },
    [
      archiveAllThreadsInProject,
      copyPathToClipboard,
      deleteProjectThreads,
      handleOpenProjectRunServer,
      handleStopProjectRun,
      navigate,
      openProjectRunDialog,
      projectById,
      removeProjectWithThreads,
      summaryFor,
      toggleProjectAgentPinned,
      toggleProjectPinned,
    ],
  );

  const handleProjectContextMenu = useCallback(
    (projectId: ProjectId, position: { x: number; y: number }) => {
      if (!readNativeApi()) return;
      if (!projectById.has(projectId)) return;
      setProjectContextMenuState({ projectId, position });
    },
    [projectById],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = projects.find((project) => project.id === active.id);
      const overProject = projects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, projects, reorderProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  // --- Rail customization: the editor opens as a popover beside the rail. ---
  const [isCustomizingNav, setIsCustomizingNav] = useState(false);
  const railSlot = useAppRailSlot();
  const hasDesktopRail = !isMobile && railSlot !== null;
  const [desktopNavigationElement, setDesktopNavigationElement] = useState<HTMLDivElement | null>(
    null,
  );
  // Phones have no shell slot: the rail rides inside the sidebar sheet, so its own wrapper
  // anchors the editor there.
  const [mobileRailElement, setMobileRailElement] = useState<HTMLDivElement | null>(null);
  const railCustomizeAnchor = railSlot ?? mobileRailElement ?? desktopNavigationElement;
  const openUsageSettings = useCallback(() => {
    openSettingsDialog({ section: "usage" });
  }, []);
  const [navCustomizeMenuPosition, setNavCustomizeMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const navCustomizeMenuAnchor = useMemo(
    () => (navCustomizeMenuPosition ? createClientPointMenuAnchor(navCustomizeMenuPosition) : null),
    [navCustomizeMenuPosition],
  );
  const sidebarNavDescriptors = useMemo<Record<SidebarNavItemId, SidebarNavItemDescriptor>>(
    () => ({
      newThread: {
        icon: NewThreadIcon,
        iconClassName: "size-4",
        label: t("sidebar.nav.newChat"),
        active: false,
        badge: null,
        onClick: handlePrimaryNewThread,
        onMouseEnter: prefetchModelsForPrimaryNewThread,
        onFocus: prefetchModelsForPrimaryNewThread,
      },
      inbox: {
        icon: InboxIcon,
        label: "Inbox",
        active: isOnInbox,
        badge: inboxBadge,
        onClick: () => {
          void navigate({ to: "/inbox" });
        },
      },
      kanban: {
        icon: KanbanIcon,
        label: "Kanban",
        active: isOnKanban,
        badge: null,
        onClick: () => {
          void navigate({ to: "/kanban" });
        },
      },
      tasks: {
        icon: TasksIcon,
        label: "Tasks",
        // The Tasks entry stands for both views: the list and the Kanban board.
        active: isOnTasks || isOnKanban,
        badge: tasksAttentionBadge,
        onClick: () => {
          void navigate({ to: appSettings.tasksViewMode === "kanban" ? "/kanban" : "/tasks" });
        },
      },
      pullRequests: {
        icon: CodeReviewIcon,
        label: "Code review",
        active: isOnPullRequests,
        badge: pullRequestsReviewBadge,
        onClick: () => {
          // No search: the inbox reopens with the filters the user last chose.
          void navigate({ to: "/pull-requests" });
        },
      },
      automations: {
        icon: ClockIcon,
        label: "Automations",
        active: isOnAutomations,
        badge: automationAttentionBadge,
        onClick: () => {
          void navigate({ to: "/automations" });
        },
      },
    }),
    [
      automationAttentionBadge,
      handlePrimaryNewThread,
      inboxBadge,
      t,
      isOnAutomations,
      isOnInbox,
      isOnKanban,
      isOnPullRequests,
      isOnTasks,
      appSettings.tasksViewMode,
      navigate,
      prefetchModelsForPrimaryNewThread,
      pullRequestsReviewBadge,
      tasksAttentionBadge,
    ],
  );
  const handleNavContextMenu = useCallback((event: MouseEvent) => {
    if (!readNativeApi()) return;
    event.preventDefault();
    setNavCustomizeMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);
  useEffect(() => {
    if (!isCustomizingNav) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsCustomizingNav(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCustomizingNav]);

  // Trees need child (subagent) threads too; the flat display list stays
  // root-only for pinned rows and other non-tree consumers.
  const sidebarThreadsByProjectId = useMemo(
    () => groupSidebarThreadsByProjectId(displaySidebarTreeThreads),
    [displaySidebarTreeThreads],
  );
  // Rows hold still while the pointer is over the list, so opening an unread
  // chat or a chat starting work never moves the row the user is about to click.
  const [sidebarContentElement, setSidebarContentElement] = useState<HTMLDivElement | null>(null);
  const isPointerOverSidebarContent = useIsPointerWithin(sidebarContentElement);
  const sidebarThreadAttentionFirst = appSettings.sidebarThreadAttentionFirst;
  const heldSidebarThreadSortKeys = useHeldSidebarThreadSortKeys({
    threads: displaySidebarTreeThreads,
    sortOrder: appSettings.sidebarThreadSortOrder,
    attentionFirst: sidebarThreadAttentionFirst,
    hold: isPointerOverSidebarContent,
  });
  const threadSortMenuProps = useMemo<ThreadSortMenuProps>(
    () => ({
      threadSortOrder: appSettings.sidebarThreadSortOrder,
      onThreadSortOrderChange: (sortOrder) => {
        updateSettings({ sidebarThreadSortOrder: sortOrder });
      },
      threadAttentionFirst: sidebarThreadAttentionFirst,
      onThreadAttentionFirstChange: (attentionFirst) => {
        updateSettings({ sidebarThreadAttentionFirst: attentionFirst });
      },
    }),
    [appSettings.sidebarThreadSortOrder, sidebarThreadAttentionFirst, updateSettings],
  );
  const sortedSidebarThreadsByProjectId = useMemo(() => {
    const byProjectId = new Map<ProjectId, SidebarThreadSummary[]>();
    for (const [projectId, projectThreads] of sidebarThreadsByProjectId) {
      byProjectId.set(
        projectId,
        collapseSameTitleSidebarThreads(
          sortThreadsForSidebar(projectThreads, appSettings.sidebarThreadSortOrder, {
            attentionFirst: sidebarThreadAttentionFirst,
            heldKeys: heldSidebarThreadSortKeys,
          }),
        ),
      );
    }
    return byProjectId;
  }, [
    appSettings.sidebarThreadSortOrder,
    heldSidebarThreadSortKeys,
    sidebarThreadAttentionFirst,
    sidebarThreadsByProjectId,
  ]);
  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleEditProjectSave = useCallback(
    (projectId: ProjectId, next: EditProjectValue, previousLocalName: string | null) => {
      setProjectAppearanceLocally(projectId, next.appearance);
      const trimmed = next.name.trim();
      const normalizedPrevious = previousLocalName?.trim() ?? "";
      if (trimmed === normalizedPrevious) {
        return;
      }
      renameProjectLocally(projectId, trimmed.length > 0 ? trimmed : null);
    },
    [renameProjectLocally, setProjectAppearanceLocally],
  );

  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(projects, displaySidebarThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, displaySidebarThreads, projects],
  );
  const chatProjects = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }),
      ),
    [chatWorkspaceRoot, homeDir, sortedProjects],
  );
  const visibleChatThreadRows = useMemo(() => {
    if (!chatSectionExpanded) {
      return [];
    }
    return buildProjectThreadTree({
      threads: sortThreadsForSidebar(
        chatProjects.flatMap((project) => sortedSidebarThreadsByProjectId.get(project.id) ?? []),
        appSettings.sidebarThreadSortOrder,
        { attentionFirst: sidebarThreadAttentionFirst, heldKeys: heldSidebarThreadSortKeys },
      ),
      forceVisibleThreadId: routeActiveSidebarThreadId ?? undefined,
    });
  }, [
    appSettings.sidebarThreadSortOrder,
    chatSectionExpanded,
    chatProjects,
    routeActiveSidebarThreadId,
    heldSidebarThreadSortKeys,
    sidebarThreadAttentionFirst,
    sortedSidebarThreadsByProjectId,
  ]);
  const visibleChatThreadIds = useMemo(
    () => visibleChatThreadRows.map((row) => row.thread.id),
    [visibleChatThreadRows],
  );
  const visibleChatPreviewEntries = useMemo(
    () =>
      visibleChatThreadRows.map((row) => ({
        rowId: row.thread.id,
        rootRowId: row.rootThreadId,
        row,
      })),
    [visibleChatThreadRows],
  );
  const activeChatPreviewEntry =
    routeActiveSidebarThreadId === null
      ? null
      : (visibleChatPreviewEntries.find((entry) => entry.rowId === routeActiveSidebarThreadId) ??
        null);
  const {
    canShowLessChatThreads,
    canShowMoreChatThreads,
    chatThreadListEffectiveExtraPages,
    renderedChatEntries,
  } = useMemo(() => {
    const paging = resolveSidebarThreadListPaging({
      totalCount: visibleChatPreviewEntries.length,
      baseLimit: THREAD_PREVIEW_LIMIT,
      pageSize: THREAD_PREVIEW_PAGE_SIZE,
      requestedExtraPages: chatThreadListExtraPages,
    });
    const { visibleEntries } = getVisibleSidebarEntriesForPreview({
      entries: visibleChatPreviewEntries,
      activeEntryId: activeChatPreviewEntry?.rowId,
      previewLimit: paging.previewLimit,
    });
    return {
      // Mirror deriveSidebarProjectData: the active-chat reveal can force rows past the page
      // cap, so only offer "Show more" while rows are genuinely hidden.
      canShowMoreChatThreads:
        paging.canShowMore && visibleEntries.length < visibleChatPreviewEntries.length,
      canShowLessChatThreads: paging.canShowLess,
      chatThreadListEffectiveExtraPages: paging.effectiveExtraPages,
      renderedChatEntries: visibleEntries,
    };
  }, [activeChatPreviewEntry?.rowId, chatThreadListExtraPages, visibleChatPreviewEntries]);
  const allStandardProjectsBase = useMemo(
    () =>
      sortedProjects.filter((project) =>
        isOrdinarySpaceProject(project, {
          homeDir,
          chatWorkspaceRoot,
          studioWorkspaceRoot,
          groupsWorkspaceRoot,
        }),
      ),
    [chatWorkspaceRoot, groupsWorkspaceRoot, homeDir, sortedProjects, studioWorkspaceRoot],
  );
  // Spaces were removed: Home lists every project, including ones an older build filed
  // under a Space, so nothing a person had there goes missing.
  const standardProjectsBase = allStandardProjectsBase;
  const pinnedProjectIds = useMemo(
    () =>
      derivePinnedProjectIdsForSidebar({
        projects: standardProjectsBase,
        persistedPinnedProjectIds,
        optimisticPinnedStateByProjectId,
      }),
    [optimisticPinnedStateByProjectId, persistedPinnedProjectIds, standardProjectsBase],
  );
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const pinnedProjectAgentIdSet = useMemo(
    () => new Set(pinnedProjectAgentIds),
    [pinnedProjectAgentIds],
  );
  const standardProjects = useMemo(
    () => orderPinnedProjectsForSidebar(standardProjectsBase, pinnedProjectIds),
    [pinnedProjectIds, standardProjectsBase],
  );
  // Codex Recents lists threads that are not already open under Projects.
  // An expanded project's rows must not be repeated in the bottom group.
  const visibleRecentSidebarThreads = useMemo(() => {
    const listed = new Set<string>(visibleChatThreadIds);
    const listedTitles = new Set<string>();
    for (const project of standardProjects) {
      if (!project.expanded) continue;
      for (const thread of sortedSidebarThreadsByProjectId.get(project.id) ?? []) {
        listed.add(thread.id);
        const title = thread.title.trim();
        if (title && !thread.parentThreadId) listedTitles.add(title);
      }
    }
    // A same-title sibling that the project list already collapsed still
    // qualifies for Recent. Drop it when the surviving row is on screen.
    return collapseSameTitleSidebarThreads(
      recentSidebarThreads.filter((thread) => {
        if (listed.has(thread.id)) return false;
        const title = thread.title.trim();
        return !(title && !thread.parentThreadId && listedTitles.has(title));
      }),
    );
  }, [
    recentSidebarThreads,
    sortedSidebarThreadsByProjectId,
    standardProjects,
    visibleChatThreadIds,
  ]);
  const visibleRecentSidebarThreadIds = useMemo(
    () => visibleRecentSidebarThreads.map((thread) => thread.id),
    [visibleRecentSidebarThreads],
  );
  const projectEmptyState = resolveProjectEmptyState({
    projectCount: standardProjects.length,
    shouldShowProjectPathEntry: createProjectDialogOpen,
    threadsHydrated,
  });
  const standardProjectSidebarDataById = useMemo<ReadonlyMap<ProjectId, SidebarDerivedProjectData>>(
    () =>
      deriveSidebarProjectData({
        projects: standardProjects,
        sortedSidebarThreadsByProjectId,
        pinnedThreadIds,
        threadListExtraPagesByProjectCwd,
        normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
        activeSidebarThreadId: routeActiveSidebarThreadId ?? undefined,
        previewLimit: THREAD_PREVIEW_LIMIT,
        previewPageSize: THREAD_PREVIEW_PAGE_SIZE,
        resolveThreadStatus: resolveThreadStatusForSidebar,
      }),
    [
      routeActiveSidebarThreadId,
      threadListExtraPagesByProjectCwd,
      pinnedThreadIds,
      sortedSidebarThreadsByProjectId,
      standardProjects,
      resolveThreadStatusForSidebar,
    ],
  );
  const allProjectsExpanded = useMemo(
    () => standardProjects.length > 0 && standardProjects.every((project) => project.expanded),
    [standardProjects],
  );
  // Rail layout: the projects the user added to the rail from its "…" menu. The project
  // panel always lists the pinned project's threads, whatever its folder state in the Home
  // tree, so it derives as expanded.
  const railShortcuts = useMemo(
    () =>
      resolveRailShortcuts({
        keys: appSettings.railShortcuts,
        projectIds: new Set(allStandardProjectsBase.map((project) => project.id)),
      }),
    [allStandardProjectsBase, appSettings.railShortcuts],
  );
  const railProject = railProjectId !== null ? (projectById.get(railProjectId) ?? null) : null;
  const railProjectSidebarData = useMemo(() => {
    if (!railProject) {
      return null;
    }
    return (
      deriveSidebarProjectData({
        projects: [{ id: railProject.id, cwd: railProject.cwd, expanded: true }],
        sortedSidebarThreadsByProjectId,
        pinnedThreadIds,
        threadListExtraPagesByProjectCwd,
        normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
        activeSidebarThreadId: routeActiveSidebarThreadId ?? undefined,
        previewLimit: THREAD_PREVIEW_LIMIT,
        previewPageSize: THREAD_PREVIEW_PAGE_SIZE,
        resolveThreadStatus: resolveThreadStatusForSidebar,
      }).get(railProject.id) ?? null
    );
  }, [
    pinnedThreadIds,
    railProject,
    routeActiveSidebarThreadId,
    resolveThreadStatusForSidebar,
    sortedSidebarThreadsByProjectId,
    threadListExtraPagesByProjectCwd,
  ]);
  const railPagedProjectId = railProject?.id ?? null;

  // Reset per-project preview paging when a folder closes so reopening starts at five rows again.
  // The rail project panel shows its project as open whatever the tree says, so its paging stays.
  useEffect(() => {
    const settle = window.setTimeout(() => {
      setThreadListExtraPagesByProjectCwd((current) =>
        pruneProjectThreadListPagingForCollapsedProjects({
          threadListExtraPagesByProjectCwd: current,
          projects:
            railPagedProjectId === null
              ? standardProjects
              : standardProjects.filter((project) => project.id !== railPagedProjectId),
          normalizeProjectCwd: normalizeSidebarProjectThreadListCwd,
        }),
      );
    }, 0);
    return () => window.clearTimeout(settle);
  }, [railPagedProjectId, standardProjects]);

  useEffect(() => {
    if (!shouldPrunePinnedThreads({ threadsHydrated })) {
      return;
    }
    prunePinnedProjects(allStandardProjectsBase.map((project) => project.id));
    prunePinnedProjectAgents(projects.map((project) => project.id));
  }, [
    allStandardProjectsBase,
    projects,
    prunePinnedProjectAgents,
    prunePinnedProjects,
    threadsHydrated,
  ]);

  useEffect(() => {
    const retainedThreadIds = new Set(sidebarThreads.map((thread) => thread.id));
    const settle = window.setTimeout(() => {
      setDismissedThreadStatusKeyByThreadId((current) => {
        const nextEntries = Object.entries(current).filter(([threadId]) =>
          retainedThreadIds.has(ThreadId.makeUnsafe(threadId)),
        );
        if (nextEntries.length === Object.keys(current).length) {
          return current;
        }
        return Object.fromEntries(nextEntries);
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [sidebarThreads]);

  useEffect(() => {
    persistSidebarUiPreferences({
      chatSectionExpanded,
      chatThreadListExtraPages,
      projectThreadListExtraPagesByCwd: Object.fromEntries(threadListExtraPagesByProjectCwd),
      dismissedThreadStatusKeyByThreadId,
      activityViewEnabled,
      activityScope,
    });
  }, [
    activityScope,
    activityViewEnabled,
    chatSectionExpanded,
    chatThreadListExtraPages,
    dismissedThreadStatusKeyByThreadId,
    threadListExtraPagesByProjectCwd,
    lastThreadRoute,
  ]);

  useEffect(() => {
    if (isOnSettings || routeThreadId === null) {
      return;
    }

    const nextLastThreadRoute = {
      threadId: routeThreadId,
      ...(routeSearch.splitViewId ? { splitViewId: routeSearch.splitViewId } : {}),
    };
    const settle = window.setTimeout(() => {
      setLastThreadRoute((current) => {
        if (
          current?.threadId === nextLastThreadRoute.threadId &&
          current?.splitViewId === nextLastThreadRoute.splitViewId
        ) {
          return current;
        }
        return nextLastThreadRoute;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [isOnSettings, routeSearch.splitViewId, routeThreadId]);

  const handleThreadClick = useCallback(
    (
      event: MouseEvent<HTMLElement>,
      threadId: ThreadId,
      orderedProjectThreadIds: readonly ThreadId[],
    ) => {
      const isMac = isMacNavigatorPlatform();
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      activateThreadRow(threadId, event.currentTarget);
    },
    [activateThreadRow, rangeSelectTo, toggleThreadSelection],
  );

  const classicVisibleSidebarThreadIds = useMemo(() => {
    const visibleThreadIdSet = new Set<ThreadId>();
    const addVisibleThreadId = (threadId: ThreadId) => {
      visibleThreadIdSet.add(threadId);
    };

    for (const thread of pinnedThreads) {
      addVisibleThreadId(thread.id);
    }

    for (const project of standardProjects) {
      const projectSidebarData = standardProjectSidebarDataById.get(project.id);
      if (!projectSidebarData) {
        continue;
      }

      if (!project.expanded) {
        if (projectSidebarData.activeEntryId) {
          addVisibleThreadId(projectSidebarData.activeEntryId);
        }
        continue;
      }

      for (const entry of projectSidebarData.visibleEntries) {
        addVisibleThreadId(entry.rowId);
      }
    }

    for (const threadId of classicSnoozedVisibleThreadIds) addVisibleThreadId(threadId);
    return [...visibleThreadIdSet];
  }, [
    classicSnoozedVisibleThreadIds,
    pinnedThreads,
    standardProjectSidebarDataById,
    standardProjects,
  ]);
  const visibleSidebarThreadIds = activityViewEnabled
    ? activityVisibleThreadIds
    : classicVisibleSidebarThreadIds;
  const visibleSidebarThreadIdSet = useMemo(
    () =>
      new Set(
        activityViewEnabled
          ? visibleSidebarThreadIds
          : [...visibleSidebarThreadIds, ...visibleChatThreadIds],
      ),
    [activityViewEnabled, visibleChatThreadIds, visibleSidebarThreadIds],
  );
  const visibleSidebarThreads = useMemo(
    // Tree source so an active subagent row also gets PR badges and git targets.
    () => sidebarThreads.filter((thread) => visibleSidebarThreadIdSet.has(thread.id)),
    [sidebarThreads, visibleSidebarThreadIdSet],
  );
  // PR badges only render on visible rows, so keep git/PR query setup off hidden project history.
  const prByThreadId = useThreadPullRequests({
    threads: visibleSidebarThreads,
    projectCwdById,
  });
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
  const threadJumpCommandByThreadId = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        break;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandByThreadId.keys()],
    [threadJumpCommandByThreadId],
  );
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen,
      terminalWorkspaceOpen,
    }),
    [terminalOpen, terminalWorkspaceOpen],
  );
  const [threadJumpLabelByThreadId, setThreadJumpLabelByThreadId] =
    useState<ReadonlyMap<ThreadId, string>>(EMPTY_THREAD_JUMP_LABELS);
  const threadJumpLabelsRef = useRef<ReadonlyMap<ThreadId, string>>(EMPTY_THREAD_JUMP_LABELS);
  useEffect(() => {
    threadJumpLabelsRef.current = threadJumpLabelByThreadId;
  }, [threadJumpLabelByThreadId]);
  const [showThreadJumpHints, setShowThreadJumpHints] = useState(false);
  const showThreadJumpHintsRef = useRef(false);
  useEffect(() => {
    showThreadJumpHintsRef.current = showThreadJumpHints;
  }, [showThreadJumpHints]);
  const visibleThreadJumpLabelByThreadId = showThreadJumpHints
    ? threadJumpLabelByThreadId
    : EMPTY_THREAD_JUMP_LABELS;

  useEffect(() => {
    const threadIdsToPrewarm = getSidebarThreadIdsToPrewarm({
      visibleThreadIds: visibleSidebarThreadIds,
      activeThreadId: activeSidebarThreadId,
    });
    // Retaining a thread without cached detail would open a full-history
    // snapshot stream speculatively; only cursor-resumable threads are cheap
    // enough to keep warm from scroll position alone.
    const releaseCallbacks = threadIdsToPrewarm
      .filter((threadId) => hasThreadDetailResumeCursor(threadId))
      .map((threadId) => retainThreadDetailSubscription(threadId));

    return () => {
      for (const release of releaseCallbacks) {
        release();
      }
    };
  }, [activeSidebarThreadId, visibleSidebarThreadIds]);

  // Pinned rows share the thread-container label rule (project name, or
  // "Moss" for project-less chats) with the hover cards and Activity rows.
  function resolvePinnedThreadProjectLabel(projectId: ProjectId): string {
    return resolveThreadProjectLabel(projectById.get(projectId));
  }

  // Keep hover actions in the same trailing slot used by the timestamp they replace.
  function renderThreadArchiveAction(
    threadId: ThreadId,
    toneClassName: string,
    options?: {
      compact?: boolean;
    },
  ) {
    return (
      <ThreadArchiveActionButton
        threadId={threadId}
        toneClassName={toneClassName}
        compact={options?.compact === true}
        onArchive={() => void archiveThreadWithUndo(threadId)}
      />
    );
  }

  function renderThreadHoverActions(input: {
    threadId: ThreadId;
    toneClassName: string;
    isPinned: boolean;
    includePinToggle?: boolean;
    compact?: boolean;
  }) {
    const compact = input.compact === true;
    const includePinToggle = input.includePinToggle !== false;

    return (
      <SidebarRowHoverActions threadId={input.threadId}>
        <div className="pointer-events-auto inline-flex items-center gap-2">
          {includePinToggle ? (
            <ThreadPinToggleButton
              pinned={input.isPinned}
              presentation="inline"
              toneClassName={input.toneClassName}
              onToggle={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleThreadPinned(input.threadId);
              }}
            />
          ) : null}
          {renderThreadArchiveAction(input.threadId, input.toneClassName, {
            compact,
          })}
        </div>
      </SidebarRowHoverActions>
    );
  }

  function renderThreadRowTrailingCluster(input: {
    isSubagentThread: boolean;
    threadJumpLabel: string | null;
    rightMetaChips: ThreadMetaChip[];
    prChip: ThreadMetaChip | null;
    threadStatus: ReturnType<typeof resolveThreadStatusForSidebar>;
    timestampToneClassName?: string;
    hoverActions: ReactNode;
  }) {
    // The jump shortcut owns the slot while it is visible; otherwise the shared
    // rule decides which status glyph shows here.
    const trailingStatus = resolveThreadStatusTrailingIndicator({
      status: input.threadStatus,
      slotOccupied: Boolean(input.threadJumpLabel),
    });
    return (
      <div className="relative flex min-w-0 items-center justify-end gap-2 group-hover/thread-row:min-w-12 group-focus-within/thread-row:min-w-12">
        {input.rightMetaChips.length > 0 ? (
          <div className={cn("shrink-0", THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME)}>
            <SidebarMetaChipStack chips={input.rightMetaChips} />
          </div>
        ) : null}
        {input.threadJumpLabel ? (
          <ShortcutKbd
            shortcutLabel={input.threadJumpLabel}
            title={input.threadJumpLabel}
            groupClassName={cn(THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME, "shrink")}
          />
        ) : null}
        {trailingStatus ? (
          // The relative time now lives in the row hover card, so the trailing
          // slot only carries the live status/loader glyph; when idle it
          // collapses and the hover action icons sit flush at the end.
          <span
            title={trailingStatus.label}
            className={threadRowStatusSlotClassName(
              input.isSubagentThread,
              input.timestampToneClassName,
            )}
          >
            <SidebarStatusTrailingGlyph status={trailingStatus} />
          </span>
        ) : null}
        {input.prChip ? (
          <div className={cn("shrink-0", THREAD_ROW_META_CHIP_HOVER_FADE_CLASS_NAME)}>
            <SidebarMetaChipStack chips={[input.prChip]} />
          </div>
        ) : null}
        {input.hoverActions}
      </div>
    );
  }

  // Section header (label + hover-revealed toolbar) shared by the Threads and Groups surfaces,
  // so spacing/typography stay in lockstep; only the label and toolbar contents vary.
  function renderListSectionHeader(label: string, toolbar: ReactNode) {
    return (
      <div className="group/project-header relative my-1">
        <div
          className={cn(
            "flex h-7 w-full min-w-0 items-center px-2 py-0.5 pr-[4.75rem]",
            SIDEBAR_SECTION_LABEL_CLASS_NAME,
          )}
        >
          <span className="truncate">{label}</span>
        </div>
        <SidebarSectionToolbar placement="overlay" revealOnHover>
          {toolbar}
        </SidebarSectionToolbar>
      </div>
    );
  }
  // Identical "Pinned" header + rows block shared by the Threads and Groups surfaces.
  // `pinnedThreads` is already the surface-appropriate list, so a single helper keeps both in sync.
  function renderPinnedThreadsSection() {
    if (pinnedThreads.length === 0) {
      return null;
    }
    return (
      <div className="mb-3">
        <div className="my-1 flex items-center justify-between px-2 py-1">
          <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{t("sidebar.pinned")}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {pinnedThreads.map((thread) => renderPinnedThreadRow(thread))}
        </div>
      </div>
    );
  }

  function renderSnoozedThreadRow(thread: SidebarThreadSummary) {
    return (
      <ActivityThreadRow
        key={thread.id}
        thread={thread}
        project={projectById.get(thread.projectId)}
        isActive={visualActiveSidebarThreadId === thread.id}
        isSettled={false}
        isPinned={pinnedThreadIdSet.has(thread.id)}
        threadJumpLabel={visibleThreadJumpLabelByThreadId.get(thread.id) ?? null}
        hasPendingDraft={draftThreadIdSet.has(thread.id)}
        pr={
          prByThreadId.has(thread.id)
            ? (prByThreadId.get(thread.id) ?? null)
            : resolveThreadPullRequestFallback({
                branch: thread.branch,
                hasDedicatedWorktree: thread.worktreePath !== null,
                lastKnownPr: thread.lastKnownPr ?? null,
              })
        }
        status={resolveThreadStatusForSidebar(thread)}
        onOpen={() => activateThreadFromSidebarIntent(thread.id)}
        onOpenPullRequest={(event, pr) => openThreadPullRequest(event, thread, pr)}
        onSetSettled={(settled) => setThreadSettledWithToast(thread.id, settled)}
        onReturnSnoozed={() => setThreadSnoozedUntil(thread.id, null)}
        onTogglePinned={() => toggleThreadPinned(thread.id)}
        onArchive={() => void archiveThreadWithUndo(thread.id)}
        onRename={openRenameThreadDialog}
        onRenamePointerUp={handleThreadRenamePointerUp}
        onContextMenu={(threadId, position) => {
          void handleThreadContextMenu(threadId, position);
        }}
        renderHoverCard={(anchorId) =>
          renderThreadHoverCardPopup(thread, anchorId, visualActiveSidebarThreadId === thread.id)
        }
      />
    );
  }

  // Shared rich hover card for thread/chat rows. Worktree metadata is resolved
  // once here so pinned and nested rows stay visually and semantically identical.
  function renderThreadHoverCardPopup(
    thread: SidebarThreadSummary,
    hoverAnchorId: string,
    isActive: boolean,
  ) {
    const hoverProject = projectById.get(thread.projectId) ?? null;
    const hoverMetadata = resolveThreadHoverCardMetadata({
      thread,
      project: hoverProject,
    });
    const hoverStatus = resolveThreadStatusTrailingIndicator({
      status: resolveThreadStatusForSidebar(thread),
      isActive,
    });
    return (
      <TooltipPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        // Zero the viewport's px-2 py-1 inset so the card's own padding matches
        // the project PreviewCard (which has no viewport). The var also drives
        // the viewport width calc, so setting it to 0 keeps the content full-width.
        viewportClassName="[--viewport-inline-padding:0px] py-0"
        anchor={createThreadHoverCardAnchor(hoverAnchorId)}
        className={cn(SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME, "whitespace-normal leading-tight")}
      >
        <ThreadHoverCardContent
          threadId={thread.id}
          title={thread.title}
          timeLabel={formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
          projectName={hoverMetadata.projectName}
          projectCwd={hoverMetadata.projectCwd}
          projectAppearance={hoverProject?.appearance ?? null}
          sourceProjectName={hoverMetadata.sourceProjectName}
          branch={hoverMetadata.branch}
          worktreeName={hoverMetadata.worktreeName}
          pullRequest={prByThreadId.get(thread.id) ?? null}
          onOpenPullRequest={openPrLink}
          model={thread.modelSelection}
          modelCatalogQueryOptions={modelQueryOptionsForProviderInstance({
            provider: thread.modelSelection.provider,
            instanceId: thread.modelSelection.instanceId ?? thread.modelSelection.provider,
            settings: appSettings,
            enabled: false,
            cwd: resolveProviderDiscoveryCwd({
              activeThreadWorktreePath: thread.worktreePath,
              activeProjectCwd: hoverProject?.cwd ?? null,
              serverCwd,
            }),
          })}
          status={hoverStatus}
        />
      </TooltipPopup>
    );
  }

  // Interactive hover card for project/folder rows: name + pin toggle, chat
  // count, path, and an "Edit project" action. Rendered inside a PreviewCard so
  // its controls stay reachable when the pointer moves into the card.
  function renderProjectHoverCardPopup(
    project: (typeof sortedProjects)[number],
    chatCount: number,
  ) {
    return (
      <PreviewCardPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        anchor={createProjectHoverCardAnchor(project.id)}
        className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
      >
        <ProjectHoverCardContent
          name={project.name}
          cwd={project.cwd}
          appearance={project.appearance ?? null}
          isPinned={pinnedProjectIdSet.has(project.id)}
          chatCount={chatCount}
          path={abbreviateHomePath(project.cwd, homeDir)}
          onTogglePin={() => toggleProjectPinned(project.id)}
          onEditProject={() => void handleProjectContextMenuAction(project.id, "rename")}
        />
      </PreviewCardPopup>
    );
  }

  function renderPinnedThreadRow(thread: SidebarThreadSummary) {
    const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
    const threadEntryPoint = threadTerminalState.entryPoint;
    const terminalStatus = terminalStatusFromThreadState({
      runningTerminalIds: threadTerminalState.runningTerminalIds,
      terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
    });
    const terminalCount = threadTerminalState.terminalIds.length;
    const isActive = visualActiveSidebarThreadId === thread.id;
    const projectLabel = resolvePinnedThreadProjectLabel(thread.projectId);
    const rightMetaChips = resolveThreadRowMetaChips({
      thread,
      includeHandoffBadge: true,
      handoffShownInAvatar:
        threadEntryPoint !== "terminal" &&
        !isGenericChatThreadTitle(thread.title) &&
        Boolean(thread.handoff?.sourceProvider),
      threadAutomations: automationsByThreadId.get(thread.id),
      guestMessagesWaitingLabel: guestMessagesWaitingLabelFor(thread.id),
    });
    const threadStatus = resolveThreadStatusForSidebar(thread);
    const isSubagentThread = Boolean(thread.parentThreadId);
    const pr = prByThreadId.get(thread.id) ?? null;
    const prChip =
      !isSubagentThread && !thread.forkSourceThreadId && pr ? resolveThreadRowPrChip(pr) : null;
    const threadJumpLabel = visibleThreadJumpLabelByThreadId.get(thread.id) ?? null;
    const hoverAnchorId = createSidebarThreadHoverAnchorId({
      scope: "pinned",
      threadId: thread.id,
    });
    return (
      <Tooltip key={thread.id}>
        <TooltipTrigger
          {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
          render={
            <div
              data-thread-hover-anchor={hoverAnchorId}
              className="group/thread-row relative w-full"
            />
          }
        >
          <div
            role="button"
            tabIndex={0}
            data-thread-item
            aria-label={resolveThreadRowAriaLabel(thread)}
            aria-description={prChip?.tooltip}
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              // Metadata and shortcut hints occupy their actual width in the flex row.
              "relative gap-1.5 pr-2 transition-colors",
              isActive
                ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                : cn(
                    SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                    SIDEBAR_ROW_HOVER_CLASS_NAME,
                    threadStatus?.label === "Reminder" && SIDEBAR_ROW_SNOOZE_REMINDER_CLASS_NAME,
                  ),
            )}
            onPointerDown={(event) => primeThreadActivation(event, thread.id)}
            onClick={(event) => activateThreadRow(thread.id, event.currentTarget)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openRenameThreadDialog(thread.id);
            }}
            onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activateThreadRow(thread.id, event.currentTarget);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              void handleThreadContextMenu(thread.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <SidebarThreadRowContent
              thread={thread}
              terminalEntryPoint={threadEntryPoint === "terminal"}
              terminalStatus={terminalStatus}
              terminalCount={terminalCount}
              isActive={isActive}
              variant="pinned"
              pendingStatusColorClass={
                threadStatus?.label === "Pending Approval"
                  ? "text-emerald-700 dark:text-emerald-400"
                  : null
              }
              suffix={
                projectLabel ? (
                  // While shortcut hints show, the project name yields width before the title.
                  <span
                    className={cn(
                      "min-w-0 max-w-[40%] truncate text-right text-ui-meta text-muted-foreground/38",
                      threadJumpLabel ? "shrink-[2]" : "shrink-0",
                    )}
                  >
                    {projectLabel}
                  </span>
                ) : null
              }
            />
            <div className="flex min-w-0 items-center">
              {renderThreadRowTrailingCluster({
                isSubagentThread,
                threadJumpLabel,
                rightMetaChips,
                prChip,
                threadStatus,
                timestampToneClassName: "text-muted-foreground/38",
                hoverActions: renderThreadHoverActions({
                  threadId: thread.id,
                  toneClassName: "text-muted-foreground/42",
                  isPinned: true,
                  compact: isSubagentThread,
                }),
              })}
            </div>
          </div>
        </TooltipTrigger>
        {renderThreadHoverCardPopup(thread, hoverAnchorId, isActive)}
      </Tooltip>
    );
  }

  function renderThreadRow(
    thread: SidebarThreadSummary,
    orderedProjectThreadIds: readonly ThreadId[],
    depth = 0,
    // Chat rows sit directly under the "Chats" header (no project nesting), so
    // their top-level rows align flush like pinned rows instead of the indented
    // column used for project-nested threads.
    topLevel = false,
    // A group member thread dispatched into a linked repo shows where it runs —
    // same small-label treatment as pinned rows' project name.
    projectContextLabel?: string,
    // Rows rendered in a second section (Recent) need their own hover-anchor
    // namespace so the card anchors to the row under the pointer, not the same
    // thread's other instance elsewhere in the sidebar.
    hoverScope?: SidebarThreadHoverAnchorScope,
  ) {
    const threadTerminalState = selectThreadTerminalState(terminalStateByThreadId, thread.id);
    const threadEntryPoint = threadTerminalState.entryPoint;
    const isActive = visualActiveSidebarThreadId === thread.id;
    const isPinned = pinnedThreadIdSet.has(thread.id);
    const isSelected = selectedThreadIds.has(thread.id);
    const isHighlighted = isActive || isSelected;
    const threadStatus = resolveThreadStatusForSidebar(thread);
    const pr = prByThreadId.get(thread.id) ?? null;
    const terminalStatus = terminalStatusFromThreadState({
      runningTerminalIds: threadTerminalState.runningTerminalIds,
      terminalAttentionStatesById: threadTerminalState.terminalAttentionStatesById,
    });
    const terminalCount = threadTerminalState.terminalIds.length;
    const isTemporaryThread =
      temporaryThreadIds[thread.id] === true ||
      draftThreadsByThreadId[thread.id]?.isTemporary === true;
    const secondaryMetaClass = isHighlighted
      ? "text-foreground/54 dark:text-foreground/64"
      : "text-muted-foreground/34";
    const rightMetaChips = resolveThreadRowMetaChips({
      thread,
      includeHandoffBadge: !isTemporaryThread,
      handoffShownInAvatar:
        threadEntryPoint !== "terminal" &&
        !isGenericChatThreadTitle(thread.title) &&
        Boolean(thread.handoff?.sourceProvider),
      threadAutomations: automationsByThreadId.get(thread.id),
      guestMessagesWaitingLabel: guestMessagesWaitingLabelFor(thread.id),
    });
    const isSubagentThread = Boolean(thread.parentThreadId);
    const prChip =
      !isSubagentThread && !thread.forkSourceThreadId && pr ? resolveThreadRowPrChip(pr) : null;
    const subagentIndentPx = Math.max(0, Math.min(depth - 1, 3) * 10);
    const showCompactMeta = !isSubagentThread;
    const showTemporaryThreadIcon = showCompactMeta && isTemporaryThread;
    // The Recent group duplicates a thread's canonical row; rendering the jump
    // chord there too would show the same hint twice while the shortcut only
    // targets the canonical sidebar position.
    const threadJumpLabel =
      hoverScope === "recent" ? null : (visibleThreadJumpLabelByThreadId.get(thread.id) ?? null);
    const hoverAnchorId = createSidebarThreadHoverAnchorId({
      scope: hoverScope ?? (topLevel ? "chat" : "project"),
      threadId: thread.id,
    });

    return (
      <SidebarMenuSubItem
        key={thread.id}
        data-thread-hover-anchor={hoverAnchorId}
        className="group/thread-row w-full"
        data-thread-item
      >
        <Tooltip>
          <TooltipTrigger
            {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
            render={
              <SidebarMenuSubButton
                render={<div role="button" tabIndex={0} />}
                data-thread-entry-point={threadEntryPoint}
                size="sm"
                isActive={isActive}
                aria-label={resolveThreadRowAriaLabel(thread)}
                aria-description={prChip?.tooltip}
                className={cn(
                  resolveThreadRowClassName({
                    isActive,
                    isSelected,
                    isSnoozeReminder: threadStatus?.label === "Reminder",
                  }),
                  topLevel && !isSubagentThread ? "pl-2" : null,
                  "pr-2",
                )}
                draggable
                onDragStart={(event) => beginThreadDrag(event, thread.id)}
                onDragEnd={endThreadDrag}
                onClick={(event) => {
                  handleThreadClick(event, thread.id, orderedProjectThreadIds);
                }}
                onPointerDown={(event) => primeThreadActivation(event, thread.id)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openRenameThreadDialog(thread.id);
                }}
                onPointerUp={(event) => handleThreadRenamePointerUp(event, thread.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  activateThreadRow(thread.id, event.currentTarget);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  // A right-click inside an active multi-selection acts on the whole
                  // selection; anywhere else it drops the selection and targets the row.
                  if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
                    void handleMultiSelectContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                    });
                    return;
                  }
                  if (selectedThreadIds.size > 0) {
                    clearSelection();
                  }
                  void handleThreadContextMenu(thread.id, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              />
            }
          >
            <SidebarThreadRowContent
              thread={thread}
              terminalEntryPoint={threadEntryPoint === "terminal"}
              terminalStatus={terminalStatus}
              terminalCount={terminalCount}
              isActive={isActive}
              variant="standard"
              subagentIndentPx={subagentIndentPx}
              pendingStatusColorClass={
                threadStatus?.label === "Pending Approval"
                  ? "text-emerald-700 dark:text-emerald-400"
                  : null
              }
              suffix={
                showTemporaryThreadIcon ? (
                  <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex shrink-0 items-center text-muted-foreground/55">
                            <TemporaryThreadIcon />
                          </span>
                        }
                      />
                      <TooltipPopup side="top">Temporary chat</TooltipPopup>
                    </Tooltip>
                  </div>
                ) : projectContextLabel ? (
                  <span className="min-w-0 max-w-[40%] shrink truncate pl-1 pr-1 text-ui-meta text-muted-foreground/38">
                    {projectContextLabel}
                  </span>
                ) : undefined
              }
            />
            <div className="flex min-w-0 items-center">
              {renderThreadRowTrailingCluster({
                isSubagentThread,
                threadJumpLabel,
                rightMetaChips: showCompactMeta ? rightMetaChips : [],
                prChip,
                threadStatus,
                timestampToneClassName: isSubagentThread
                  ? isHighlighted
                    ? "text-foreground/38 dark:text-foreground/46"
                    : "text-muted-foreground/24"
                  : secondaryMetaClass,
                hoverActions: renderThreadHoverActions({
                  threadId: thread.id,
                  toneClassName: secondaryMetaClass,
                  isPinned,
                  compact: isSubagentThread,
                }),
              })}
            </div>
          </TooltipTrigger>
          {renderThreadHoverCardPopup(thread, hoverAnchorId, isActive)}
        </Tooltip>
      </SidebarMenuSubItem>
    );
  }

  // Inbox / new terminal thread / new thread for one project. Shared by the tree's
  // hover toolbar and the rail project panel's header.
  function renderProjectThreadActions(project: (typeof sortedProjects)[number]) {
    return (
      <>
        <SidebarIconButton
          icon={CodeReviewIcon}
          label={`Open code review for ${project.name}`}
          tooltip="Code review"
          tooltipSide="top"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            // Opens the in-app inbox scoped to this project for this visit (the URL
            // override leaves the saved project filter alone) instead of leaving for GitHub.
            void navigate({ to: "/pull-requests", search: { projectId: project.id } });
          }}
        />
        <SidebarIconButton
          icon={TerminalIcon}
          label={`Create new terminal thread in ${project.name}`}
          tooltip={
            newTerminalThreadShortcutLabel
              ? `New terminal thread (${newTerminalThreadShortcutLabel})`
              : "New terminal thread"
          }
          tooltipSide="top"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void handleNewThread(project.id, { entryPoint: "terminal" });
          }}
        />
        <SidebarIconButton
          icon={NewThreadIcon}
          label={format("sidebar.project.newConversationAria", { project: project.name })}
          tooltip={
            newThreadShortcutLabel
              ? `${t("sidebar.project.newConversationTooltip")} (${newThreadShortcutLabel})`
              : t("sidebar.project.newConversationTooltip")
          }
          tooltipSide="top"
          data-testid="new-thread-button"
          onMouseEnter={() => {
            prefetchModelsForProjectNewThread(project.id);
          }}
          onFocus={() => {
            prefetchModelsForProjectNewThread(project.id);
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            prefetchModelsForProjectNewThread(project.id, { includeDroid: true });
            void handleNewThread(project.id);
          }}
        />
      </>
    );
  }

  // A project's thread rows plus its show more/less paging. Shared by the tree's folder
  // disclosure and the rail project panel.
  function renderProjectThreadList(
    project: (typeof sortedProjects)[number],
    projectSidebarData: SidebarDerivedProjectData,
  ) {
    const {
      orderedProjectThreadIds,
      visibleEntries,
      threadListExtraPages,
      canShowMoreThreads,
      canShowLessThreads,
    } = projectSidebarData;
    return (
      <>
        {visibleEntries.map((entry) =>
          renderThreadRow(entry.thread, orderedProjectThreadIds, entry.depth),
        )}

        {(canShowMoreThreads || canShowLessThreads) && (
          <SidebarMenuSubItem className="w-full">
            <div className="flex w-full items-center gap-1">
              {canShowMoreThreads && (
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className="h-7 flex-1 translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground"
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => {
                    showMoreThreadsForProject(project.cwd, threadListExtraPages);
                  }}
                >
                  <span>{t("sidebar.showMore")}</span>
                </SidebarMenuSubButton>
              )}
              {canShowLessThreads && (
                <SidebarMenuSubButton
                  render={<button type="button" />}
                  data-thread-selection-safe
                  size="sm"
                  className={cn(
                    "h-7 translate-x-0 justify-start rounded-lg text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground",
                    // Keep the left indent when "Show less" is the only affordance left.
                    canShowMoreThreads ? "w-auto flex-none px-2" : "flex-1 pr-2 pl-8",
                  )}
                  onMouseDown={preventFocusOnMouseDown}
                  onClick={() => {
                    showLessThreadsForProject(project.cwd, threadListExtraPages);
                  }}
                >
                  <span>{t("sidebar.showLess")}</span>
                </SidebarMenuSubButton>
              )}
            </div>
          </SidebarMenuSubItem>
        )}
      </>
    );
  }

  // A project reads as "running" when Moss tracks a run for it or when a local server
  // (possibly started outside Moss) is attributed by cwd. Shared by the tree's project
  // header and the rail project panel.
  function isSidebarProjectRunning(projectId: ProjectId): boolean {
    return (
      (projectRunsByProjectId[projectId] ?? null) !== null ||
      (projectRunServerByProjectId.get(projectId) ?? null) !== null
    );
  }

  function renderProjectItem(
    project: (typeof sortedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const isProjectPinned = pinnedProjectIdSet.has(project.id);
    const projectSidebarData = standardProjectSidebarDataById.get(project.id);
    if (!projectSidebarData) {
      return null;
    }
    const { allProjectThreadCount, projectStatus } = projectSidebarData;
    const projectFolderIconClassName = isProjectPinned
      ? "opacity-0"
      : sidebarHoverRevealHideClassName("project-header");
    const isProjectRunning = isSidebarProjectRunning(project.id);
    const collapsedProjectStatus = project.expanded ? null : projectStatus;
    // The "open dev server" affordance now lives in the project context menu, so
    // the hover toolbar always reserves space for the three thread actions. The
    // reserve lives on the *name* container (not the button) so only the truncating
    // name yields to the overlay toolbar; the trailing run dot stays put and fades
    // in place instead of sliding left. Focus is read from the group because the
    // name container itself is not focusable — the row's button is.
    const projectToolbarReserveClassName =
      "group-hover/project-header:pr-[4.75rem] project-header-focus:pr-[4.75rem]";
    // Configured display name only — folder identity lives in the hover card (#1000).
    const projectRowLabel = resolveSidebarProjectRowLabel(project);

    return (
      <div className="group/collapsible">
        <PreviewCard>
          <PreviewCardTrigger
            {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
            render={
              <div
                className="group/project-header relative"
                data-project-hover-anchor={project.id}
              />
            }
          >
            <SidebarMenuButton
              ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
              size="sm"
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                "hover:bg-[var(--sidebar-accent)] group-hover/project-header:bg-[var(--sidebar-accent)] group-hover/project-header:text-[var(--sidebar-accent-foreground)]",
                isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
              )}
              {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
              {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
              onPointerDownCapture={handleProjectTitlePointerDownCapture}
              onClick={(event) => handleProjectTitleClick(event, project.id)}
              onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                void handleProjectContextMenu(project.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <SidebarLeadingIcon
                size="sm"
                tone={SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME}
                className={projectFolderIconClassName}
              >
                <ProjectSidebarIcon
                  cwd={project.cwd}
                  expanded={project.expanded}
                  appearance={project.appearance}
                />
              </SidebarLeadingIcon>
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 overflow-hidden transition-[padding] duration-150 ease-out",
                  projectToolbarReserveClassName,
                )}
              >
                {/* Sized to the name so the chevron follows it, like the Chats header. */}
                <span
                  className={cn(SIDEBAR_PROJECT_NAME_CLASS_NAME, "flex-initial")}
                  data-translation-skip="true"
                >
                  {projectRowLabel}
                </span>
                {/* The pin covers a pinned project's glyph, folder included. */}
                {isProjectPinned ? (
                  <DisclosureChevron
                    open={project.expanded}
                    className={PROJECT_ROW_CHEVRON_CLASS_NAME}
                  />
                ) : (
                  <ProjectDisclosureChevron
                    cwd={project.cwd}
                    expanded={project.expanded}
                    appearance={project.appearance}
                    className={PROJECT_ROW_CHEVRON_CLASS_NAME}
                  />
                )}
              </div>
              {/* Closed folders surface child-chat status on the project row; open
                  folders leave that signal to their visible child thread rows. */}
              {isProjectRunning || collapsedProjectStatus ? (
                <span
                  aria-label={
                    collapsedProjectStatus
                      ? `Project status: ${collapsedProjectStatus.label}`
                      : undefined
                  }
                  title={collapsedProjectStatus?.label}
                  className={cn(
                    "ml-auto flex min-w-[1.625rem] shrink-0 items-center justify-end gap-2 self-center",
                    sidebarHoverRevealHideClassName("project-header"),
                  )}
                >
                  {isProjectRunning ? <ProjectRunIndicatorDot /> : null}
                  {collapsedProjectStatus ? (
                    <SidebarStatusTrailingGlyph status={collapsedProjectStatus} />
                  ) : null}
                </span>
              ) : null}
            </SidebarMenuButton>
            <button
              type="button"
              aria-label={pinActionLabel(project.name, isProjectPinned)}
              aria-pressed={isProjectPinned}
              title={pinActionLabel(project.name, isProjectPinned)}
              className={cn(
                "sidebar-icon-button absolute left-2 top-1/2 z-20 inline-flex size-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm transition-opacity hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
                isProjectPinned
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0 md:group-hover/project-header:pointer-events-auto md:group-hover/project-header:opacity-100 md:project-header-focus:pointer-events-auto md:project-header-focus:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleProjectPinned(project.id);
              }}
            >
              <PinStatusIcon pinned={isProjectPinned} className="size-4" />
            </button>
            <SidebarSectionToolbar placement="overlay" revealOnHover>
              {renderProjectThreadActions(project)}
            </SidebarSectionToolbar>
          </PreviewCardTrigger>
          {renderProjectHoverCardPopup(project, allProjectThreadCount)}
        </PreviewCard>

        <div
          className={cn(
            disclosureShellClassName(project.expanded),
            SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
          )}
        >
          <div className={DISCLOSURE_INNER_CLASS}>
            <SidebarMenuSub
              className={cn(
                "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                disclosureContentClassName(project.expanded),
              )}
            >
              {renderProjectThreadList(project, projectSidebarData)}
            </SidebarMenuSub>
          </div>
        </div>
      </div>
    );
  }

  // Rail project panel: the threads of a project pinned to the rail, opened from its rail
  // shortcut without leaving the current route. The back arrow returns to Home.
  function renderRailProjectPanel() {
    if (railProject && railProjectSidebarData) {
      return (
        <SidebarGroup className="px-1.5 py-1.5">
          <div className="my-1 flex h-7 min-w-0 items-center gap-1.5 ps-1 pe-1.5">
            <SidebarIconButton
              icon={BackArrowIcon}
              label="Back"
              tooltip="Back"
              tooltipSide="bottom"
              onClick={() => selectRailPanelItem("home")}
            />
            <span className={SIDEBAR_PROJECT_NAME_CLASS_NAME}>
              {resolveSidebarProjectRowLabel(railProject)}
            </span>
            <SidebarSectionToolbar>{renderProjectThreadActions(railProject)}</SidebarSectionToolbar>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSub
                className={cn(
                  "mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0",
                  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
                )}
              >
                {renderProjectThreadList(railProject, railProjectSidebarData)}
              </SidebarMenuSub>
            </SidebarMenuItem>
          </SidebarMenu>
          {railProjectSidebarData.visibleEntries.length === 0 ? (
            <div className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
              No threads yet
            </div>
          ) : null}
        </SidebarGroup>
      );
    }
    return null;
  }

  const handleProjectTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  // Reads the latest threads at key time without re-subscribing the shortcut listener on
  // every thread update. Same threads and tiers as the bell's dot, so the chord goes where
  // the dot points.
  const openNextThreadNeedingAttention = useEffectEvent(() => {
    const nextThreadId = findNextThreadNeedingAttention(
      visibleNonGroupSidebarThreads,
      activeSidebarThreadId,
      resolveActivityPriorityTierForSidebar,
    );
    if (nextThreadId) activateThreadFromSidebarIntent(nextThreadId);
  });

  useEffect(() => {
    const clearThreadJumpHints = () => {
      setThreadJumpLabelByThreadId((current) =>
        current === EMPTY_THREAD_JUMP_LABELS ? current : EMPTY_THREAD_JUMP_LABELS,
      );
      setShowThreadJumpHints(false);
    };
    const shouldIgnoreThreadJumpHintUpdate = (event: KeyboardEvent) =>
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key !== "Meta" &&
      event.key !== "Control" &&
      event.key !== "Alt" &&
      event.key !== "Shift" &&
      !showThreadJumpHintsRef.current &&
      threadJumpLabelsRef.current === EMPTY_THREAD_JUMP_LABELS;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const shortcutContext = getCurrentSidebarShortcutContext();
      if (!shouldIgnoreThreadJumpHintUpdate(event)) {
        const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
          platform: navigator.platform,
          context: shortcutContext,
        });
        if (!shouldShowHints) {
          if (
            showThreadJumpHintsRef.current ||
            threadJumpLabelsRef.current !== EMPTY_THREAD_JUMP_LABELS
          ) {
            clearThreadJumpHints();
          }
        } else {
          setThreadJumpLabelByThreadId((current) => {
            const nextLabelMap = buildThreadJumpLabelMap({
              keybindings,
              platform: navigator.platform,
              terminalOpen: shortcutContext.terminalOpen,
              threadJumpCommandByThreadId,
            });
            return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
          });
          setShowThreadJumpHints(true);
        }
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (command === "sidebar.search") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("search");
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "search");
        return;
      }
      if (command === "sidebar.activity") {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpenActivity = isOnSettings || !activityViewEnabled;
        setActivityViewEnabledSmoothly(shouldOpenActivity);
        if (shouldOpenActivity && isOnSettings) {
          openThreadsView();
        }
        return;
      }
      if (command === "sidebar.addProject") {
        event.preventDefault();
        event.stopPropagation();
        setCreateProjectDialogOpen(true);
        return;
      }
      if (command === "sidebar.importThread") {
        event.preventDefault();
        event.stopPropagation();
        setSearchPaletteMode("import");
        setSearchPaletteOpen((prev) => !prev || searchPaletteMode !== "import");
        return;
      }
      if (command === "settings.usage") {
        event.preventDefault();
        event.stopPropagation();
        openSettingsDialog({ section: "usage" });
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        // The open model picker addresses its rows with the same mod+digit chord.
        if (isModelPickerShortcutScopeActive()) return;
        event.preventDefault();
        event.stopPropagation();
        const threadJumpTargetId = threadJumpThreadIds[jumpIndex];
        if (threadJumpTargetId) {
          activateThreadFromSidebarIntent(threadJumpTargetId);
        }
        return;
      }
      if (command === "chat.attention.next") {
        event.preventDefault();
        event.stopPropagation();
        openNextThreadNeedingAttention();
        return;
      }
      if (command !== "chat.visible.next" && command !== "chat.visible.previous") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const nextThreadId = getNextVisibleSidebarThreadId({
        visibleThreadIds: visibleSidebarThreadIds,
        activeThreadId: activeSidebarThreadId ?? undefined,
        direction: command === "chat.visible.previous" ? "backward" : "forward",
      });
      if (nextThreadId && nextThreadId !== activeSidebarThreadId) {
        activateThreadFromSidebarIntent(nextThreadId);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (shouldIgnoreThreadJumpHintUpdate(event)) {
        return;
      }
      const shortcutContext = getCurrentSidebarShortcutContext();
      const shouldShowHints = shouldShowThreadJumpHints(event, keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (!shouldShowHints) {
        clearThreadJumpHints();
        return;
      }
      setThreadJumpLabelByThreadId((current) => {
        const nextLabelMap = buildThreadJumpLabelMap({
          keybindings,
          platform: navigator.platform,
          terminalOpen: shortcutContext.terminalOpen,
          threadJumpCommandByThreadId,
        });
        return threadJumpLabelMapsEqual(current, nextLabelMap) ? current : nextLabelMap;
      });
      setShowThreadJumpHints(true);
    };
    const onWindowBlur = () => {
      clearThreadJumpHints();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    activateThreadFromSidebarIntent,
    activeSidebarThreadId,
    activityViewEnabled,
    openThreadsView,
    keybindings,
    getCurrentSidebarShortcutContext,
    homeDir,
    isOnSettings,
    navigate,
    searchPaletteMode,
    setActivityViewEnabledSmoothly,
    threadJumpCommandByThreadId,
    threadJumpThreadIds,
    visibleSidebarThreadIds,
  ]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Single entry point for update error toasts. Attaches the manual-download
  // fallback (copy link + "Download manually") whenever a release URL is known,
  // and dedupes by error signature so the same failure is not toasted twice.
  const surfaceDesktopUpdateError = useCallback(
    (input: { title: string; description: string; state: DesktopUpdateState | null }) => {
      const signature = getDesktopUpdateErrorSignature(input.state) ?? `adhoc:${input.description}`;
      if (lastDesktopUpdateErrorToastSignatureRef.current === signature) {
        return;
      }
      lastDesktopUpdateErrorToastSignatureRef.current = signature;
      const releaseUrl = input.state?.releaseUrl ?? null;
      const recommendManualDownload = shouldRecommendManualDesktopDownload(input.state);
      const fallbackProps = releaseUrl
        ? {
            data: { copyText: releaseUrl },
            actionProps: {
              children: "Download manually",
              onClick: () => {
                void window.desktopBridge?.openExternal(releaseUrl);
              },
            },
          }
        : {};
      toastManager.add({
        type: "error",
        title: recommendManualDownload ? "Download the update manually" : input.title,
        description: recommendManualDownload
          ? `Automatic installation has failed ${input.state?.installFailureCount ?? 0} times. Download ${input.state?.availableVersion ?? "the update"} manually to finish updating.`
          : input.description,
        ...fallbackProps,
      });
    },
    [],
  );

  // The install watchdog (and any background-pushed failure) flips the update
  // state to a download/install error without going through a click handler, so
  // the fallback must also be surfaced reactively here. Dedup keeps it from
  // doubling up with the click-handler toast for user-initiated failures.
  useEffect(() => {
    if (!getDesktopUpdateErrorSignature(desktopUpdateState)) {
      // Returning to any non-error state (new download, success, up-to-date)
      // clears the dedup key so the next distinct failure notifies again.
      lastDesktopUpdateErrorToastSignatureRef.current = null;
      return;
    }
    if (!desktopUpdateState?.releaseUrl) {
      return;
    }
    surfaceDesktopUpdateError({
      title:
        desktopUpdateState.errorContext === "install"
          ? "Couldn’t finish updating"
          : "Couldn’t download the update",
      description:
        desktopUpdateState.message ??
        "The in-app update could not complete. You can download it manually.",
      state: desktopUpdateState,
    });
  }, [desktopUpdateState, surfaceDesktopUpdateError]);

  // Install failures deliberately preserve "downloaded" so the same artifact
  // can be retried. Watch the error as well as the status to release the latch.
  useEffect(() => {
    if (
      desktopUpdateState?.status !== "downloaded" ||
      desktopUpdateState.errorContext === "install"
    ) {
      setInstallingDesktopUpdate(false);
    }
  }, [desktopUpdateState?.status, desktopUpdateState?.errorContext]);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);
  const isBetaDesktopFlavor = desktopUpdateState?.flavor === "beta";

  const desktopUpdateButtonDisabled =
    isDesktopUpdateButtonDisabled(desktopUpdateState) || installingDesktopUpdate;
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const searchPaletteProjects = useMemo<SidebarSearchProject[]>(
    () =>
      // A group chat's hidden container never appears in search.
      projects
        .filter((project) => project.kind !== "room")
        .map((project) => ({
          id: project.id,
          name: project.name,
          remoteName: project.remoteName,
          folderName: project.folderName,
          localName: project.localName,
          appearance: project.appearance ?? null,
          cwd: project.cwd,
          // Spaces were removed: no project carries a Space name into search any more.
          spaceName: "",
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })),
    [projects],
  );
  const searchPaletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: "new-chat",
        label: "New chat",
        description: "Open the new chat landing screen.",
        keywords: ["chat", "new", "home"],
        shortcutLabel: newChatShortcutLabel,
      },
      {
        id: "new-thread",
        label: t("sidebar.newThread"),
        description: t("sidebar.searchPalette.newThread.description"),
        keywords: ["thread", "new", "project"],
        shortcutLabel: newThreadShortcutLabel,
      },
      {
        id: "add-project",
        label: "Add project",
        description: "Open a repository or folder in the sidebar.",
        keywords: ["folder", "repo", "repository", "open"],
        shortcutLabel: addProjectShortcutLabel,
        run: handleStartAddProject,
      },
      {
        id: "import-projects",
        label: "Import projects from…",
        description: "Bring Codex and Claude Code projects and conversations into Moss.",
        keywords: ["import", "projects", "codex", "claude", "conversations", "folders"],
      },
      {
        id: "import-thread",
        label: "Import thread from...",
        description: "Attach a local thread to an existing provider session.",
        keywords: [
          "import",
          "resume",
          "thread",
          "session",
          "codex",
          "claude",
          "cursor",
          "opencode",
        ],
        shortcutLabel: importThreadShortcutLabel,
      },
      {
        id: "feedback",
        label: "Feedback Moss",
        description: "Send feedback or report an issue to the Moss team.",
        keywords: ["feedback", "bug", "issue", "problem", "report", "support", "moss"],
      },
      {
        id: "settings",
        label: "Settings",
        description: "Open app settings.",
        keywords: ["preferences", "config"],
      },
      {
        id: "usage-settings",
        label: "Usage settings",
        description: "Open provider usage and remaining credits.",
        keywords: ["usage", "limits", "credits", "quota", "providers"],
        shortcutLabel: usageSettingsShortcutLabel,
      },
    ],
    [
      addProjectShortcutLabel,
      handleStartAddProject,
      importThreadShortcutLabel,
      newChatShortcutLabel,
      newThreadShortcutLabel,
      t,
      usageSettingsShortcutLabel,
    ],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    // Keep the sidebar action as the single visible entry point for manual checks.
    if (desktopUpdateButtonAction === "check") {
      void bridge
        .checkForUpdates()
        .then((nextState) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(nextState);
          if (nextState.status === "available") {
            toastManager.add({
              type: "info",
              title: "Preparing update",
              description: `Moss is preparing version ${nextState.availableVersion ?? "available"} in the background.`,
            });
            return;
          }

          if (nextState.status === "downloading") {
            toastManager.add({
              type: "info",
              title: "Preparing update",
              description: "Moss is downloading the update in the background.",
            });
            return;
          }

          if (nextState.status === "downloaded") {
            toastManager.add({
              type: "success",
              title: "Update ready",
              description: "Click Update when you’re ready to restart and install it.",
            });
            return;
          }

          if (nextState.status === "up-to-date") {
            toastManager.add({
              type: "info",
              title: "You're up to date",
              description: `Moss ${nextState.currentVersion} is already the newest version.`,
            });
            return;
          }

          if (nextState.status === "error") {
            surfaceDesktopUpdateError({
              title: "Could not check for updates",
              description: nextState.message ?? "An unexpected error occurred.",
              state: nextState,
            });
          }
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setInstallingDesktopUpdate(false);
          setDesktopUpdateState(result.state);
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update ready",
              description: "Click Update when you’re ready to restart and install it.",
            });
          }
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: "Already up to date",
              description: alreadyCurrentNotice,
            });
            return;
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          surfaceDesktopUpdateError({
            title: "Could not download update",
            description: actionError,
            state: result.state,
          });
        })
        .catch((error) => {
          surfaceDesktopUpdateError({
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      setInstallingDesktopUpdate(true);
      persistAppStateNow();
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateState(result.state);
          if (!isDesktopUpdateInstallInFlight(result)) {
            setInstallingDesktopUpdate(false);
          }
          const alreadyCurrentNotice = getDesktopUpdateAlreadyCurrentNotice(result);
          if (alreadyCurrentNotice) {
            toastManager.add({
              type: "info",
              title: "Already up to date",
              description: alreadyCurrentNotice,
            });
            return;
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          surfaceDesktopUpdateError({
            title: "Could not install update",
            description: actionError,
            state: result.state,
          });
        })
        .catch((error) => {
          setInstallingDesktopUpdate(false);
          surfaceDesktopUpdateError({
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
            state: desktopUpdateState,
          });
        });
    }
  }, [
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateState,
    surfaceDesktopUpdateError,
  ]);

  // Both handlers step from the *effective* (clamped) page count reported by the derived
  // project data, so stale/oversized stored paging self-heals on the very next click.
  const setThreadListExtraPagesForProject = useCallback(
    (projectCwd: string, nextExtraPages: number) => {
      const cwdKey = normalizeSidebarProjectThreadListCwd(projectCwd);
      if (cwdKey.length === 0) return;
      setThreadListExtraPagesByProjectCwd((current) => {
        const clampedExtraPages = Math.max(0, nextExtraPages);
        if ((current.get(cwdKey) ?? 0) === clampedExtraPages) return current;
        const next = new Map(current);
        if (clampedExtraPages === 0) {
          next.delete(cwdKey);
        } else {
          next.set(cwdKey, clampedExtraPages);
        }
        return next;
      });
    },
    [],
  );

  const showMoreThreadsForProject = useCallback(
    (projectCwd: string, currentExtraPages: number) => {
      setThreadListExtraPagesForProject(projectCwd, currentExtraPages + 1);
    },
    [setThreadListExtraPagesForProject],
  );

  const showLessThreadsForProject = useCallback(
    (projectCwd: string, currentExtraPages: number) => {
      setThreadListExtraPagesForProject(projectCwd, currentExtraPages - 1);
    },
    [setThreadListExtraPagesForProject],
  );

  const handleToggleProjects = useCallback(() => {
    if (allProjectsExpanded) {
      collapseProjectsExcept(focusedProjectId);
      return;
    }
    setAllProjectsExpanded(true);
  }, [allProjectsExpanded, collapseProjectsExcept, focusedProjectId, setAllProjectsExpanded]);

  const betaBadge = isBetaDesktopFlavor ? (
    <span
      aria-label="Moss Beta"
      className="inline-flex shrink-0 items-center rounded-full bg-[var(--beta-pill)] px-1.5 py-0.5 text-ui-xs font-semibold leading-none text-[var(--beta-pill-ink)]"
    >
      Beta
    </span>
  ) : null;

  // Home and a pinned project switch the panel; route items navigate (prewarm included). The store's
  // active item keeps one item selected.
  const isOnThreadsSection =
    !isOnMossbot &&
    !isOnSettings &&
    !isOnKanban &&
    !isOnTasks &&
    !isOnPullRequests &&
    !isOnAutomations &&
    !isOnInbox &&
    !isOnCustomizeDestination;
  const sidebarHelpMenuProps = {
    onOpenShortcuts: () => openSettingsDialog({ section: "shortcuts" }),
    onOpenFeedback: () => openFeedbackDialog(),
    // The rail customizes from its "…" menu.
    onCustomizeSidebar: null,
  };
  // A pinned project stands for what the panel shows, so Home steps back.
  const activeRailShortcutKey = resolveActiveRailShortcutKey({
    activeItem: railActiveItem,
    railProjectId,
    shortcuts: railShortcuts,
  });
  // Where Tasks takes Kanban's slot it also stands for the board it switches to, so the
  // Kanban route selects (and keeps visible, even if hidden) the Tasks item.
  const railSlotActiveItem =
    tasksSurfaceEnabled && railActiveItem === "kanban" ? "tasks" : railActiveItem;
  // The rail's top items, in the user's Customize order (hidden ones drop out unless active).
  const railItemOrder = resolveTasksSurfaceSlot(
    normalizeRailItemOrder(appSettings.railItemOrder),
    tasksSurfaceEnabled,
  );
  const hiddenRailItems = new Set(
    resolveTasksSurfaceSlot(
      normalizeHiddenRailItems(appSettings.hiddenRailItems),
      tasksSurfaceEnabled,
    ),
  );
  // The zh-CN rail names these destinations 首页/定时任务/图像/资料空间/插件. The upstream
  // "Code review"/"Automations" wording only survives on destinations the Moss rail
  // hides by default.
  const railItemLabel = (id: RailOrderableItemId): string => {
    switch (id) {
      case "home":
        return t("sidebar.nav.home");
      case "mossbot":
        return "Mossbot";
      case "automations":
        // The DOM dictionary reads a bare "Scheduled" as the status 已定时;
        // the destination name needs the keyed nav term (定时任务).
        return t("sidebar.nav.scheduled");
      case "pullRequests":
        return t("sidebar.more.codeReview");
      case "images":
        return t("sidebar.nav.images");
      case "library":
        return "资料空间";
      case "skills":
        return t("sidebar.nav.plugins");
      default:
        return sidebarNavDescriptors[id].label;
    }
  };
  const railItemFor = (id: RailOrderableItemId): AppRailItem => {
    const base = { id, glyphs: railItemGlyphs(id), label: railItemLabel(id) };
    if (id === "home") {
      return {
        ...base,
        badge: null,
        active: railActiveItem === "home" && activeRailShortcutKey === null,
        onSelect: () => {
          // Home is the threads panel, so it keeps the Activity view the user chose.
          selectRailPanelItem("home");
          // Projects live next to the threads only: from another section, Home goes back
          // to the thread view instead of opening over that section.
          if (!isOnThreadsSection) openThreadsView();
        },
      };
    }
    if (id === "mossbot") {
      return {
        ...base,
        badge: null,
        active: railActiveItem === "mossbot",
        onSelect: () => {
          selectRailRouteItem("mossbot");
          void navigate({ to: "/mossbot" });
        },
      };
    }
    if (id === "images" || id === "library") {
      // Moss native-surface destinations: no route — the chat shell swaps the route
      // column for the Images workspace / Library surface (see _chat.tsx).
      return {
        ...base,
        badge: null,
        active: railActiveItem === id,
        onSelect: () => {
          selectRailRouteItem(id);
          if (id === "images") openMossCanvas({ surface: "images" });
          else openMossLibraryDestination();
        },
      };
    }
    if (id === "skills") {
      return {
        ...base,
        badge: null,
        active:
          railSlotActiveItem === "skills" &&
          !railPlugins.pinned.some(
            (plugin) => pathname === `/skills/plugins/${encodeURIComponent(plugin.id)}`,
          ),
        onSelect: () => {
          selectRailRouteItem("skills");
          void navigate({ to: "/skills" });
        },
      };
    }
    const item = sidebarNavDescriptors[id];
    return {
      ...base,
      badge: item.badge,
      active: railSlotActiveItem === id,
      onSelect: () => {
        selectRailRouteItem(id);
        item.onClick();
      },
      onMouseEnter: item.onMouseEnter,
      onFocus: item.onFocus,
    };
  };
  const railAvailability = {
    inboxAvailable,
    imagesAvailable,
  };
  const railVisibleItemIds = buildRailItemOrder({
    order: railItemOrder,
    hidden: hiddenRailItems,
    activeItem: railSlotActiveItem,
    ...railAvailability,
  });
  const railItems: AppRailItem[] = railVisibleItemIds.map(railItemFor);
  const searchPaletteNavigationActions: SidebarSearchAction[] = (
    ["inbox", "kanban", "automations"] as const
  )
    .filter((id) => isRailItemAvailable(id, railAvailability))
    .map((id) => {
      const item = railItemFor(id);
      return {
        id: `go-${id}`,
        label: `Go to ${item.label}`,
        description: `Open ${item.label}.`,
        keywords: [item.label, "go", "navigate"],
        run: item.onSelect,
        icon: item.glyphs.idle,
      };
    });
  if (projects.length > 0) {
    searchPaletteNavigationActions.push({
      id: "new-automation",
      label: "New automation",
      description: "Schedule a recurring task.",
      keywords: ["automation", "create", "new", "schedule"],
      icon: AddPlusIcon,
      run: () => {
        railItemFor("automations").onSelect();
        setAutomationCreateOpen(true);
      },
    });
  }
  const railShortcutItems: AppRailItem[] = railShortcuts.flatMap((shortcut): AppRailItem[] => {
    const project = projectById.get(shortcut.projectId);
    if (!project) return [];
    return [
      {
        id: shortcut.key,
        glyphs: railProjectGlyphs(project.cwd, project.appearance ?? null),
        label: resolveSidebarProjectRowLabel(project),
        badge: null,
        active: activeRailShortcutKey === shortcut.key,
        onSelect: () => {
          setActivityViewEnabledSmoothly(false);
          selectRailPanelItem("project");
          openRailProject(project.id);
          if (!isOnThreadsSection) openThreadsView();
        },
      },
    ];
  });
  // Customize rows: the rail popover lists the rail's own items (Inbox
  // only where it ships), then its project shortcuts.
  const railCustomizeItems: SidebarCustomizeItem[] = railItemOrder
    .filter((id) => isRailItemAvailable(id, railAvailability))
    .map((id) => ({
      id,
      icon: railItemGlyphs(id).idle,
      label: railItemLabel(id),
      visible: !hiddenRailItems.has(id),
      locked: !railItemCanHide(id),
    }));
  const handleRailItemReorder = (activeId: string, overId: string) => {
    // Same rule as the nav: an unshipped item (Inbox on Stable) stays out of the saved order.
    // Groups keeps its slot, since it is only switched off, not missing from the build.
    const order = railItemOrder.filter((id) => id !== "inbox" || inboxAvailable);
    const fromIndex = order.indexOf(activeId as RailOrderableItemId);
    const toIndex = order.indexOf(overId as RailOrderableItemId);
    if (fromIndex < 0 || toIndex < 0) return;
    updateSettings({ railItemOrder: arrayMove(order, fromIndex, toIndex) });
  };
  const handleRailItemVisibleChange = (id: string, visible: boolean) => {
    // Ids come from the rail customize rows, which list RailOrderableItemIds only.
    const railId = id as RailOrderableItemId;
    const hidden = [...hiddenRailItems].filter((entry) => entry !== railId);
    updateSettings({ hiddenRailItems: visible ? hidden : [...hidden, railId] });
  };
  const railShortcutCustomizeItems: SidebarCustomizeItem[] = railShortcutItems.map((item) => ({
    id: item.id,
    icon: item.glyphs.idle,
    label: item.label,
    visible: true,
  }));
  const handleRailShortcutReorder = (activeKey: string, overKey: string) => {
    const keys = [...appSettings.railShortcuts];
    const fromIndex = keys.indexOf(activeKey);
    const toIndex = keys.indexOf(overKey);
    if (fromIndex < 0 || toIndex < 0) return;
    updateSettings({ railShortcuts: arrayMove(keys, fromIndex, toIndex) });
  };
  // Unchecking a shortcut removes it from the rail; the "…" menu adds it back.
  const handleRailShortcutVisibleChange = (key: string, visible: boolean) => {
    if (visible) return;
    updateSettings({ railShortcuts: toggleRailShortcutKey(appSettings.railShortcuts, key) });
  };
  const railBottomItems: AppRailItem[] = [
    {
      id: "settings",
      glyphs: railItemGlyphs("settings"),
      label: "Settings",
      badge: null,
      active: railActiveItem === "settings",
      onSelect: () => {
        openSettingsDialog();
      },
    },
  ];
  // Reuse the same destinations if this panel is hosted without a desktop rail.
  // The normal shell and the mobile sheet already expose them in the icon rail.
  const panelSidebarNavIds: readonly SidebarNavItemId[] = ["newThread"];
  const desktopNavigationItems = [...railItems, ...railShortcutItems];
  // Automations owns its panel (its list), like Settings and Groups do.
  const showRailAutomationsPanel = isOnAutomations;
  // A pinned project's panel needs that project; with none (deleted, or an old session's
  // Spaces panel) Home shows instead.
  const showRailProjectPanel =
    railPanelView === "project" &&
    railProject !== null &&
    railProjectSidebarData !== null &&
    !isOnSettings &&
    !activityViewEnabled;
  // Switching Home and a pinned project replays the surface enter animation.
  const sidebarSurfaceKey = showRailProjectPanel
    ? `project:${railProject?.id ?? ""}`
    : activityViewEnabled
      ? "activity"
      : "threads";
  const relocateProjectDialogProject = relocateProjectDialogId
    ? (projectById.get(relocateProjectDialogId) ?? null)
    : null;
  const editProjectDialogProject = editProjectDialog
    ? (projectById.get(editProjectDialog.projectId) ?? null)
    : null;
  const projectAgentDialogProject = projectAgentDialogState
    ? (projectById.get(projectAgentDialogState.projectId) ?? null)
    : null;
  const projectContextMenuProject = projectContextMenuState
    ? (projectById.get(projectContextMenuState.projectId) ?? null)
    : null;
  const projectContextMenuThreads = useMemo(
    () =>
      projectContextMenuState
        ? displaySidebarThreads.filter(
            (thread) => thread.projectId === projectContextMenuState.projectId,
          )
        : [],
    [displaySidebarThreads, projectContextMenuState],
  );
  const projectContextMenuAnchor = useMemo(
    () =>
      projectContextMenuState
        ? createClientPointMenuAnchor(projectContextMenuState.position)
        : null,
    [projectContextMenuState],
  );
  const projectContextMenuHasAnyThreads = projectContextMenuThreads.length > 0;
  const projectContextMenuHasArchivableThreads = projectContextMenuThreads.some(
    (thread) => thread.archivedAt == null,
  );
  const projectContextMenuIsPinned = projectContextMenuProject
    ? pinnedProjectIdSet.has(projectContextMenuProject.id)
    : false;
  const projectContextMenuIsRunning = projectContextMenuProject
    ? Boolean(projectRunsByProjectId[projectContextMenuProject.id])
    : false;
  const projectContextMenuServer = projectContextMenuProject
    ? (projectRunServerByProjectId.get(projectContextMenuProject.id) ?? null)
    : null;
  const projectContextMenuHasOpenServer =
    projectContextMenuServer !== null && firstLocalServerUrl(projectContextMenuServer) !== null;

  const openRailPlugin = (plugin: AppRailPlugin) => {
    railPlugins.recordOpen(plugin.id);
    closeMossCanvas("destination-switch");
    selectRailRouteItem("skills");
    void navigate({ to: "/skills/plugins/$pluginId", params: { pluginId: plugin.id } });
  };
  const railPluginItems: AppRailItem[] = railPlugins.pinned.map((plugin) => {
    const Icon = resolveResourceIcon(plugin.name, plugin.description, PluginIcon);
    return {
      id: `plugin:${plugin.id}`,
      label: plugin.name,
      glyphs: { idle: Icon, active: Icon },
      badge: null,
      active: pathname === `/skills/plugins/${encodeURIComponent(plugin.id)}`,
      onSelect: () => openRailPlugin(plugin),
    };
  });
  const appRailProps = {
    items: railItems.filter((item) => item.id !== "pullRequests"),
    shortcuts: [
      ...(railVisibleItemIds.includes("pullRequests") ? [railItemFor("pullRequests")] : []),
      ...railPluginItems,
      ...railShortcutItems,
    ],
    moreSlot: (
      <SidebarHelpMenu
        {...sidebarHelpMenuProps}
        renderMenu={(helpMenu) => (
          <AppRailMoreMenu
            open={railFeaturesOpen}
            onOpenChange={setRailFeaturesOpen}
            onCustomize={() => setIsCustomizingNav(true)}
            // Codex order leads (项目, 图像, …); every other available destination follows in the
            // user's Customize order so hidden ones (Inbox, Kanban/Tasks) stay reachable.
            destinations={[
              ...new Set<RailOrderableItemId>([...RAIL_MORE_MENU_LEADING_ITEMS, ...railItemOrder]),
            ]
              .filter((id) => isRailItemAvailable(id, railAvailability))
              .map((id) => {
                const item = railItemFor(id);
                return {
                  key: id,
                  label:
                    id === "home"
                      ? t("sidebar.more.projects")
                      : id === "pullRequests"
                        ? t("sidebar.more.codeReview")
                        : item.label,
                  icon: id === "home" ? railItemGlyphs("project").idle : item.glyphs.idle,
                  onSelect: item.onSelect,
                  pinned: !hiddenRailItems.has(id),
                  onTogglePin: railItemCanHide(id)
                    ? () => handleRailItemVisibleChange(id, hiddenRailItems.has(id))
                    : undefined,
                };
              })}
            plugins={railPlugins.items.map((plugin) => ({
              key: `plugin:${plugin.id}`,
              label: plugin.name,
              icon: resolveResourceIcon(plugin.name, plugin.description, PluginIcon),
              onSelect: () => openRailPlugin(plugin),
              pinned: railPlugins.pinned.some(({ id }) => id === plugin.id),
              onTogglePin: () => railPlugins.togglePin(plugin),
            }))}
            shortcuts={{
              projects: allStandardProjectsBase.map((project) => ({
                key: railProjectShortcutKey(project.id),
                label: resolveSidebarProjectRowLabel(project),
              })),
              pinnedKeys: new Set(appSettings.railShortcuts),
              onToggle: (key) =>
                updateSettings({
                  railShortcuts: toggleRailShortcutKey(appSettings.railShortcuts, key),
                }),
            }}
            utilities={railBottomItems.map((item) => ({
              key: item.id,
              label: item.label,
              icon: item.glyphs.idle,
              onSelect: item.onSelect,
            }))}
            helpMenu={helpMenu}
          />
        )}
      />
    ),
    bottomItems: [],
    bottomSlot: (
      <>
        {hasDesktopRail ? <AppRailUsage onOpenUsageSettings={openUsageSettings} /> : null}
        <RailUpdateControl
          desktopUpdate={{
            state: desktopUpdateState,
            visible: showDesktopUpdateButton,
            installing: installingDesktopUpdate,
            onClick: handleDesktopUpdateButtonClick,
          }}
        />
      </>
    ),
    // Codex bottom-left account entry: signed out it leads to /login, signed in it
    // opens the shared account menu beside the rail (same content as the footer view).
    bottomTrailingSlot: <RailAccountMenu />,
    onContextMenu: handleNavContextMenu,
  };

  return (
    <>
      {isMobile ? null : <AppRailPortal {...appRailProps} />}
      {railCustomizeAnchor ? (
        <Popover
          open={isCustomizingNav}
          onOpenChange={(open) => {
            if (!open) setIsCustomizingNav(false);
          }}
        >
          <PopoverPopup
            anchor={railCustomizeAnchor}
            side="right"
            align="start"
            sideOffset={8}
            alignOffset={8}
            className="w-64 [&_[data-slot=popover-viewport]]:p-1.5"
          >
            <SidebarCustomizeHeader onDone={() => setIsCustomizingNav(false)} />
            <SidebarCustomizeList
              items={railCustomizeItems}
              onReorder={handleRailItemReorder}
              onVisibleChange={handleRailItemVisibleChange}
            />
            {railShortcutCustomizeItems.length > 0 ? (
              <>
                <div className={cn(SIDEBAR_SECTION_LABEL_CLASS_NAME, "ps-2 pt-2.5 pb-1")}>
                  Shortcuts
                </div>
                <SidebarCustomizeList
                  items={railShortcutCustomizeItems}
                  onReorder={handleRailShortcutReorder}
                  onVisibleChange={handleRailShortcutVisibleChange}
                />
              </>
            ) : null}
          </PopoverPopup>
        </Popover>
      ) : null}
      {/* Phones show the sidebar as a sheet over the shell, so the rail rides inside it,
          beside the panel. On desktop both wrappers vanish (`contents`) and the rail is
          portaled into the shell instead. */}
      <div className={isMobile ? "flex min-h-0 flex-1" : "contents"}>
        {isMobile ? (
          <div ref={setMobileRailElement} className="flex shrink-0">
            <AppRail {...appRailProps} />
          </div>
        ) : null}
        <div className={isMobile ? "flex min-h-0 min-w-0 flex-1 flex-col" : "contents"}>
          <SidebarContent ref={setSidebarContentElement} className="gap-0 font-system-ui">
            {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
              <SidebarGroup className="px-2 pt-2 pb-0">
                <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
                  <TriangleAlertIcon />
                  <AlertTitle>Intel build on Apple Silicon</AlertTitle>
                  <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
                  {desktopUpdateButtonAction !== "none" ? (
                    <AlertAction>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={desktopUpdateButtonDisabled}
                        onClick={handleDesktopUpdateButtonClick}
                      >
                        {desktopUpdateButtonAction === "download"
                          ? "Preparing ARM build"
                          : desktopUpdateButtonAction === "install"
                            ? "Update ARM build"
                            : "Check for ARM build update"}
                      </Button>
                    </AlertAction>
                  ) : null}
                </Alert>
              </SidebarGroup>
            ) : null}
            {!isMobile && !hasDesktopRail ? (
              <SidebarGroup className="px-1.5 pt-1 pb-1.5" data-sidebar-navigation="desktop">
                <SidebarMenu className="gap-0.5">
                  {desktopNavigationItems.map((item) => (
                    <SidebarPrimaryAction
                      key={item.id}
                      icon={item.glyphs.idle}
                      label={item.label}
                      active={item.active}
                      badge={item.badge}
                      onClick={item.onSelect}
                      {...(item.onMouseEnter ? { onMouseEnter: item.onMouseEnter } : {})}
                      {...(item.onFocus ? { onFocus: item.onFocus } : {})}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ) : null}
            {isOnMossbot ? (
              <MossbotSidebar activeProjectId={activeMossbot?.projectId ?? null} />
            ) : isOnSettings ? (
              <SidebarGroup className="p-0">
                {/* The rail is the way back, so the panel opens on its title like every section. */}
                <SidebarPanelTitle title="Settings" />
                <SettingsSidebarNav
                  activeSection={activeSettingsSection}
                  onSelectSection={(section, options) => {
                    if (section === "plugins") {
                      void navigate({ to: PLUGIN_LIBRARY_SETTINGS_PATH });
                      return;
                    }
                    void navigate({
                      to: "/settings",
                      search: (previous) => ({
                        ...previous,
                        section: section === "general" ? undefined : section,
                        target: options?.target,
                      }),
                    });
                  }}
                />
              </SidebarGroup>
            ) : showRailAutomationsPanel ? (
              <RailAutomationsPanel
                createOpen={automationCreateOpen}
                onCreateOpenChange={setAutomationCreateOpen}
              />
            ) : (
              <>
                {/* Moss has one surface here (Hubs are gone), so the panel opens on its title. */}
                <SidebarPanelTitle title="Moss">
                  <SidebarIconButton
                    icon={SearchIcon}
                    label="Search"
                    glyph="leading"
                    size="header"
                    tooltip={searchShortcutLabel ? `Search (${searchShortcutLabel})` : "Search"}
                    tooltipSide="bottom"
                    onClick={() => {
                      setSearchPaletteOpen(true);
                    }}
                  />
                  <SidebarActivityBellButton
                    active={activityViewEnabled}
                    showUnreadDot={hasUnreadActivity}
                    shortcutLabel={activityShortcutLabel}
                    onClick={() => setActivityViewEnabledSmoothly(!activityViewEnabled)}
                  />
                  {betaBadge}
                </SidebarPanelTitle>
                {/* The keyed content remounts with a short enter animation. */}
                <div key={sidebarSurfaceKey} className="sidebar-surface-enter">
                  {/* Primary sidebar actions stay limited to features we currently ship. */}
                  <SidebarGroup className="px-1.5 pt-1 pb-1.5" onContextMenu={handleNavContextMenu}>
                    <SidebarMenu className="gap-0.5">
                      {panelSidebarNavIds.map((id) => {
                        const item = sidebarNavDescriptors[id];
                        return (
                          <SidebarPrimaryAction
                            key={id}
                            {...(id === "tasks" ? { coachmark: TASKS_COACHMARK } : {})}
                            icon={item.icon}
                            {...(item.iconClassName ? { iconClassName: item.iconClassName } : {})}
                            label={item.label}
                            active={item.active}
                            badge={item.badge}
                            onClick={item.onClick}
                            {...(item.onMouseEnter ? { onMouseEnter: item.onMouseEnter } : {})}
                            {...(item.onFocus ? { onFocus: item.onFocus } : {})}
                          />
                        );
                      })}
                      <SidebarPrimaryAction
                        icon={MossbotIcon}
                        label="Mossbot"
                        onClick={() => void navigate({ to: "/mossbot" })}
                      />
                    </SidebarMenu>
                  </SidebarGroup>

                  <MossbotSidebar compact activeProjectId={null} />

                  {activityViewEnabled ? (
                    <SidebarGroup className="px-1.5 py-1.5">
                      <SidebarActivityView
                        threads={activityNonGroupSidebarThreads}
                        projectById={projectById}
                        activeThreadId={visualActiveSidebarThreadId}
                        pinnedThreadIdSet={pinnedThreadIdSet}
                        settledOverrideByThreadId={settledOverrideByThreadId}
                        threadsHydrated={threadsHydrated}
                        scopeSelection={activityScope}
                        onScopeSelectionChange={setActivityScope}
                        resolveThreadStatus={resolveThreadStatusForSidebar}
                        onOpenThread={activateThreadFromSidebarIntent}
                        onOpenThreadPullRequest={openThreadPullRequest}
                        onSetThreadSettled={setThreadSettledWithToast}
                        onReturnSnoozedThread={(threadId) => setThreadSnoozedUntil(threadId, null)}
                        onToggleThreadPinned={toggleThreadPinned}
                        onArchiveThread={(threadId) => void archiveThreadWithUndo(threadId)}
                        onMarkThreadRead={markThreadVisited}
                        onRenameThread={openRenameThreadDialog}
                        onThreadRenamePointerUp={handleThreadRenamePointerUp}
                        onThreadContextMenu={(threadId, position) => {
                          void handleThreadContextMenu(threadId, position);
                        }}
                        onProjectContextMenu={handleProjectContextMenu}
                        prByThreadId={prByThreadId}
                        threadJumpLabelByThreadId={visibleThreadJumpLabelByThreadId}
                        onVisibleThreadIdsChange={handleActivityVisibleThreadIdsChange}
                        renderThreadHoverCard={(thread, anchorId) =>
                          renderThreadHoverCardPopup(
                            thread,
                            anchorId,
                            visualActiveSidebarThreadId === thread.id,
                          )
                        }
                        onCreateChat={handlePrimaryNewThread}
                        onAddProject={handleStartAddProject}
                      />
                    </SidebarGroup>
                  ) : showRailProjectPanel ? (
                    renderRailProjectPanel()
                  ) : (
                    <SidebarGroup className="px-1.5 py-1.5">
                      {renderPinnedThreadsSection()}
                      {renderListSectionHeader(
                        t("sidebar.projects"),
                        <>
                          {standardProjects.length > 0 ? (
                            <SidebarIconButton
                              icon={allProjectsExpanded ? CollapseAllIcon : ExpandAllIcon}
                              label={
                                allProjectsExpanded
                                  ? focusedProjectId
                                    ? t("sidebar.collapseAllProjectsExceptActive")
                                    : t("sidebar.collapseAllProjects")
                                  : t("sidebar.expandAllProjects")
                              }
                              className="disabled:cursor-default disabled:opacity-45"
                              onClick={handleToggleProjects}
                              tooltip={
                                allProjectsExpanded
                                  ? focusedProjectId
                                    ? t("sidebar.collapseAllProjectsExceptActiveChat")
                                    : t("sidebar.collapseAllProjects")
                                  : t("sidebar.expandAllProjects")
                              }
                              tooltipSide="bottom"
                            />
                          ) : null}
                          <ProjectSortMenu
                            projectSortOrder={appSettings.sidebarProjectSortOrder}
                            onProjectSortOrderChange={(sortOrder) => {
                              updateSettings({ sidebarProjectSortOrder: sortOrder });
                            }}
                            {...threadSortMenuProps}
                          />
                          <SidebarIconButton
                            icon={AddPlusIcon}
                            label="Add project"
                            onClick={handleStartAddProject}
                            tooltip="Add project"
                            tooltipSide="right"
                          />
                        </>,
                      )}

                      {isManualProjectSorting ? (
                        <DndContext
                          sensors={projectDnDSensors}
                          collisionDetection={projectCollisionDetection}
                          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                          onDragStart={handleProjectDragStart}
                          onDragEnd={handleProjectDragEnd}
                          onDragCancel={handleProjectDragCancel}
                        >
                          <SidebarMenu className="gap-3">
                            <SortableContext
                              items={standardProjects.map((project) => project.id)}
                              strategy={verticalListSortingStrategy}
                            >
                              {standardProjects.map((project) => (
                                <SortableProjectItem key={project.id} projectId={project.id}>
                                  {(dragHandleProps) => renderProjectItem(project, dragHandleProps)}
                                </SortableProjectItem>
                              ))}
                            </SortableContext>
                          </SidebarMenu>
                        </DndContext>
                      ) : (
                        <SidebarMenu ref={attachProjectListAutoAnimateRef} className="gap-3">
                          {standardProjects.map((project) => (
                            <SidebarMenuItem key={project.id} className="rounded-md">
                              {renderProjectItem(project, null)}
                            </SidebarMenuItem>
                          ))}
                        </SidebarMenu>
                      )}

                      {projectEmptyState === "loading" && (
                        <div
                          className="space-y-2 px-2 pt-4"
                          aria-live="polite"
                          aria-label="Loading projects"
                        >
                          <div className="text-center text-ui text-muted-foreground/58">
                            Loading projects...
                          </div>
                          <div className="mx-auto grid w-full max-w-42 gap-1.5 opacity-70">
                            <div className="h-2 rounded-full bg-muted/55 animate-pulse" />
                            <div className="mx-auto h-2 w-4/5 rounded-full bg-muted/40 animate-pulse" />
                            <div className="mx-auto h-2 w-3/5 rounded-full bg-muted/30 animate-pulse" />
                          </div>
                        </div>
                      )}

                      {projectEmptyState === "empty" && (
                        <p className="px-2 pt-4 text-center text-ui text-muted-foreground/58">
                          {t("sidebar.noProjectsYet")}
                        </p>
                      )}
                    </SidebarGroup>
                  )}
                </div>
              </>
            )}
            {!isOnMossbot &&
            !isOnSettings &&
            !activityViewEnabled &&
            !showRailProjectPanel &&
            !showRailAutomationsPanel &&
            snoozedSidebarThreads.length > 0 ? (
              <SidebarGroup className="px-1.5 pt-1 pb-2">
                <SidebarSnoozedThreadsSection
                  threads={snoozedSidebarThreads}
                  renderThreadRow={renderSnoozedThreadRow}
                  onVisibleThreadIdsChange={setClassicSnoozedVisibleThreadIds}
                />
              </SidebarGroup>
            ) : null}
            {!isOnMossbot &&
            !isOnSettings &&
            !activityViewEnabled &&
            !showRailProjectPanel &&
            !showRailAutomationsPanel &&
            chatsSectionVisible ? (
              // sidebar-surface-enter: mounts on the Groups -> Projects switch, so it
              // animates in step with the keyed surface wrapper above.
              <SidebarGroup className="sidebar-surface-enter px-1.5 pt-1 pb-2">
                <div className="group/collapsible">
                  <div className="group/project-header relative">
                    <SidebarMenuButton
                      size="sm"
                      aria-expanded={chatSectionExpanded}
                      className={cn(
                        SIDEBAR_HEADER_ROW_CLASS_NAME,
                        SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
                        SIDEBAR_ROW_HOVER_CLASS_NAME,
                        "cursor-pointer",
                      )}
                      onClick={() => setChatSectionExpanded((current) => !current)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        setChatSectionExpanded((current) => !current);
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                        <span className="truncate font-system-ui text-ui font-normal text-muted-foreground/79">
                          {t("sidebar.chats")}
                        </span>
                        <DisclosureChevron
                          open={chatSectionExpanded}
                          className="text-muted-foreground/79"
                        />
                      </div>
                    </SidebarMenuButton>
                    <SidebarSectionToolbar placement="overlay" revealOnHover>
                      <ChatSortMenu {...threadSortMenuProps} />
                      <SidebarIconButton
                        icon={NewThreadIcon}
                        label={t("sidebar.openNewChatHome")}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void handleCreateHomeChat();
                        }}
                        tooltip={
                          newChatShortcutLabel
                            ? `${t("sidebar.newChat")} (${newChatShortcutLabel})`
                            : t("sidebar.newChat")
                        }
                        tooltipSide="top"
                      />
                    </SidebarSectionToolbar>
                  </div>

                  <div className={cn(disclosureShellClassName(chatSectionExpanded), "pt-1")}>
                    <div className={DISCLOSURE_INNER_CLASS}>
                      <SidebarMenu
                        className={cn("gap-1", disclosureContentClassName(chatSectionExpanded))}
                      >
                        {visibleChatThreadRows.length > 0 ? (
                          renderedChatEntries.map((entry) =>
                            renderThreadRow(
                              entry.row.thread,
                              visibleChatThreadIds,
                              entry.row.depth,
                              true,
                            ),
                          )
                        ) : (
                          <div className="px-2 py-2 text-ui text-muted-foreground/48">
                            {t("sidebar.noChatsYet")}
                          </div>
                        )}
                        {canShowMoreChatThreads || canShowLessChatThreads ? (
                          <SidebarMenuItem className="w-full">
                            <div className="flex w-full items-center gap-1">
                              {canShowMoreChatThreads ? (
                                <SidebarMenuButton
                                  size="sm"
                                  className="h-7 flex-1 justify-start rounded-lg pr-2 pl-8 text-left text-ui font-normal text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground"
                                  onMouseDown={preventFocusOnMouseDown}
                                  onClick={() =>
                                    setChatThreadListExtraPages(
                                      chatThreadListEffectiveExtraPages + 1,
                                    )
                                  }
                                >
                                  <span>{t("sidebar.showMore")}</span>
                                </SidebarMenuButton>
                              ) : null}
                              {canShowLessChatThreads ? (
                                <SidebarMenuButton
                                  size="sm"
                                  className={cn(
                                    "h-7 justify-start rounded-lg text-left text-ui font-normal text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground",
                                    // Keep the left indent when "Show less" is the only affordance left.
                                    canShowMoreChatThreads
                                      ? "w-auto flex-none px-2"
                                      : "flex-1 pr-2 pl-8",
                                  )}
                                  onMouseDown={preventFocusOnMouseDown}
                                  onClick={() =>
                                    setChatThreadListExtraPages(
                                      Math.max(0, chatThreadListEffectiveExtraPages - 1),
                                    )
                                  }
                                >
                                  <span>{t("sidebar.showLess")}</span>
                                </SidebarMenuButton>
                              ) : null}
                            </div>
                          </SidebarMenuItem>
                        ) : null}
                      </SidebarMenu>
                    </div>
                  </div>
                </div>
              </SidebarGroup>
            ) : null}
            {!isOnMossbot &&
            !isOnSettings &&
            !activityViewEnabled &&
            !showRailProjectPanel &&
            !showRailAutomationsPanel &&
            visibleRecentSidebarThreads.length > 0 ? (
              // Codex-style fixed bottom group: recent threads that are not
              // already listed under an expanded project.
              <SidebarGroup className="px-1.5 pt-1 pb-2">
                <div className="my-1 flex items-center justify-between px-2 py-1">
                  <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>{t("sidebar.recent")}</span>
                </div>
                <SidebarMenu className="gap-1">
                  {visibleRecentSidebarThreads.map((thread) =>
                    renderThreadRow(
                      thread,
                      visibleRecentSidebarThreadIds,
                      0,
                      true,
                      undefined,
                      "recent",
                    ),
                  )}
                </SidebarMenu>
              </SidebarGroup>
            ) : null}
            {!isOnMossbot && !isOnSettings && !activityViewEnabled ? (
              <SidebarGettingStarted
                onOpenAutomations={() => void navigate({ to: "/automations" })}
                onOpenConnectors={() =>
                  openSettingsDialog({ section: "plugins", pluginTab: "mcp" })
                }
                onCreateChat={() => void handleCreateHomeChat()}
              />
            ) : null}
          </SidebarContent>

          <SidebarFooter
            // Hosts without a rail keep these controls in the panel footer.
            className="gap-2 border-sidebar-border border-t-0 p-2 pt-0 font-system-ui"
          >
            {!isMobile && !hasDesktopRail ? (
              <div ref={setDesktopNavigationElement} className="flex items-center gap-1">
                <RailAccountMenu />
                <AppRailUsage onOpenUsageSettings={openUsageSettings} />
                <div className="ms-auto flex items-center gap-1">
                  {appRailProps.bottomSlot}
                  {appRailProps.moreSlot}
                </div>
              </div>
            ) : null}
            <SidebarMenu>
              <SidebarMenuItem>
                <div className="flex flex-col gap-1">
                  {DebugFeatureFlagsMenu && showDebugFeatureFlagsMenu && !isOnSettings ? (
                    <Suspense fallback={null}>
                      <DebugFeatureFlagsMenu />
                    </Suspense>
                  ) : null}
                </div>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </div>
      </div>

      <CreateProjectDialog
        open={createProjectDialogOpen}
        onOpenChange={setCreateProjectDialogOpen}
        onSubmit={handleCreateProjectSubmit}
      />

      {projectContextMenuState && projectContextMenuProject && projectContextMenuAnchor ? (
        <Menu
          keepOpenOnSubmenuInteraction
          open
          onOpenChange={(open) => {
            if (!open) {
              setProjectContextMenuState(null);
            }
          }}
        >
          <ComposerPickerMenuPopup
            anchor={projectContextMenuAnchor}
            align="start"
            side="bottom"
            sideOffset={0}
            className={PROJECT_CONTEXT_MENU_PANEL_CLASS_NAME}
          >
            <MenuGroup>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "open-in-finder",
                  )
                }
              >
                <ProjectContextMenuIcon icon={FolderOpenIcon} />
                <span>Open in Finder</span>
              </MenuItem>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "open-in-kanban",
                  )
                }
              >
                <ProjectContextMenuIcon icon={KanbanIcon} />
                <span>Open in Kanban</span>
              </MenuItem>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "copy-path",
                  )
                }
              >
                <ProjectContextMenuIcon icon={CopyIcon} />
                <span>Copy Path</span>
              </MenuItem>
              <MenuSeparator />
              {projectContextMenuIsRunning ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "stop-dev",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={StopFilledIcon} />
                  <span>Stop dev</span>
                </MenuItem>
              ) : (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "start-dev",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={PlayIcon} />
                  <span>Start dev</span>
                </MenuItem>
              )}
              {projectContextMenuHasOpenServer ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "open-dev-server",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={ExternalLinkIcon} />
                  <span>Open dev server</span>
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(projectContextMenuState.projectId, "rename")
                }
              >
                <ProjectContextMenuIcon icon={PencilIcon} />
                <span>Edit project</span>
              </MenuItem>
              {isGroupContainerProject(projectContextMenuProject, {
                homeDir,
                chatWorkspaceRoot,
                studioWorkspaceRoot,
                groupsWorkspaceRoot,
              }) && summaryFor(projectContextMenuState.projectId)?.configured ? (
                <>
                  <MenuItem
                    className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                    onClick={() =>
                      void handleProjectContextMenuAction(
                        projectContextMenuState.projectId,
                        "edit-project-agent",
                      )
                    }
                  >
                    <ProjectContextMenuIcon icon={BotIcon} />
                    <span>Edit coordinator</span>
                  </MenuItem>
                  <MenuItem
                    className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                    onClick={() =>
                      void handleProjectContextMenuAction(
                        projectContextMenuState.projectId,
                        "toggle-pin-project-agent",
                      )
                    }
                  >
                    <ProjectContextMenuIcon icon={PinIcon} />
                    <span>
                      {pinActionLabel(
                        "coordinator",
                        pinnedProjectAgentIdSet.has(projectContextMenuState.projectId),
                      )}
                    </span>
                  </MenuItem>
                </>
              ) : null}
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(projectContextMenuState.projectId, "relocate")
                }
              >
                <ProjectContextMenuIcon icon={FolderOpenIcon} />
                <span>Change project path…</span>
              </MenuItem>
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(
                    projectContextMenuState.projectId,
                    "toggle-pin",
                  )
                }
              >
                <ProjectContextMenuIcon icon={PinIcon} />
                <span>{pinActionLabel("project", projectContextMenuIsPinned)}</span>
              </MenuItem>
              {projectContextMenuHasArchivableThreads || projectContextMenuHasAnyThreads ? (
                <MenuSeparator />
              ) : null}
              {projectContextMenuHasArchivableThreads ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "archive-threads",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={ArchiveIcon} />
                  <span>Archive threads</span>
                </MenuItem>
              ) : null}
              {projectContextMenuHasAnyThreads ? (
                <MenuItem
                  className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                  onClick={() =>
                    void handleProjectContextMenuAction(
                      projectContextMenuState.projectId,
                      "delete-threads",
                    )
                  }
                >
                  <ProjectContextMenuIcon icon={Trash2} />
                  <span>Delete threads</span>
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem
                className={PROJECT_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() =>
                  void handleProjectContextMenuAction(projectContextMenuState.projectId, "delete")
                }
              >
                <ProjectContextMenuIcon icon={XIcon} />
                <span>Remove</span>
              </MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}

      {navCustomizeMenuPosition && navCustomizeMenuAnchor ? (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) {
              setNavCustomizeMenuPosition(null);
            }
          }}
        >
          <ComposerPickerMenuPopup
            anchor={navCustomizeMenuAnchor}
            align="start"
            side="bottom"
            sideOffset={0}
            className={SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME}
          >
            <MenuGroup>
              <MenuItem
                className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
                onClick={() => {
                  setNavCustomizeMenuPosition(null);
                  setIsCustomizingNav(true);
                }}
              >
                <SidebarContextMenuIcon icon={CustomizeIcon} />
                <span>Customize</span>
              </MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      ) : null}

      <Dialog
        open={projectRunDialogProjectId !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRunDialog();
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <PlayIcon className="size-4 text-emerald-500" />
              Start dev
            </DialogTitle>
            <DialogDescription>
              {projectRunDialogProject ? projectRunDialogProject.name : "Project"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <label
              htmlFor="project-run-command-input"
              className="block text-ui-xs font-medium text-[var(--color-text-foreground-secondary)]"
            >
              Command
            </label>
            <Input
              id="project-run-command-input"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="e.g. npm run dev"
              value={projectRunDialogCommandDraft}
              aria-invalid={projectRunDialogCommandIsValid ? undefined : true}
              onChange={(event) => setProjectRunDialogCommandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleConfirmProjectRun();
                }
              }}
            />
            {projectRunDialogCommandIsValid ? null : (
              <p className="text-ui-sm text-destructive">Enter a command to run.</p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRunDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirmProjectRun}
              disabled={!projectRunDialogCommandIsValid || Boolean(projectRunDialogExistingRun)}
            >
              <PlayIcon className="size-4" />
              Run
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <SnoozeUntilDialog
        open={snoozeDialogThreadId !== null}
        currentSnoozedUntil={
          snoozeDialogThreadId
            ? (sidebarThreadSummaryById[snoozeDialogThreadId]?.snoozedUntil ?? null)
            : null
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSnoozeDialogThreadId(null);
        }}
        onSnooze={(deadline) => {
          if (snoozeDialogThreadId !== null) snoozeThread(snoozeDialogThreadId, deadline);
        }}
      />
      <RenameThreadDialog
        open={renameDialogThreadId !== null}
        currentTitle={
          renameDialogThreadId ? (sidebarThreadSummaryById[renameDialogThreadId]?.title ?? "") : ""
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRenameDialogThreadId(null);
        }}
        onSave={(newTitle) => {
          if (renameDialogThreadId === null) return;
          const target = sidebarThreadSummaryById[renameDialogThreadId];
          if (!target) return;
          void commitRename(target.id, newTitle, target.title);
        }}
      />

      {relocateProjectDialogProject ? (
        <RelocateProjectDialog
          projectId={relocateProjectDialogProject.id}
          workspaceRoot={relocateProjectDialogProject.cwd}
          onOpenChange={(open) => {
            if (!open) setRelocateProjectDialogId(null);
          }}
        />
      ) : null}

      {editProjectDialogProject ? (
        <EditProjectDialog
          open={editProjectDialog?.open ?? false}
          cwd={editProjectDialogProject.cwd}
          folderName={editProjectDialogProject.folderName}
          initialValue={{
            name: editProjectDialogProject.localName ?? "",
            appearance: editProjectDialogProject.appearance ?? null,
          }}
          onOpenChange={(nextOpen) => {
            if (!nextOpen)
              setEditProjectDialog((current) => current && { ...current, open: false });
          }}
          onSave={(next) =>
            handleEditProjectSave(
              editProjectDialogProject.id,
              next,
              editProjectDialogProject.localName,
            )
          }
          onRemove={() => {
            const projectId = editProjectDialogProject.id;
            setEditProjectDialog(null);
            void removeProjectWithThreads(projectId);
          }}
        />
      ) : null}

      {projectAgentDialogProject ? (
        <GroupSettingsDialog
          key={projectAgentDialogProject.id}
          open={projectAgentDialogState !== null}
          mode={projectAgentDialogState?.mode ?? "onboarding"}
          projectId={projectAgentDialogProject.id}
          projectName={projectAgentDialogProject.name}
          workspacePath={projectAgentDialogProject.cwd}
          defaultModelSelection={projectAgentDialogProject.defaultModelSelection ?? null}
          allowDiscard={projectAgentDialogState?.discardable === true}
          onOpenChange={(open) => {
            if (!open) {
              setProjectAgentDialogState(null);
            }
          }}
          onSaved={(overview) => {
            if (projectAgentDialogState?.mode !== "onboarding") return;
            const coordinatorThreadId = overview.config?.coordinatorThreadId;
            const firstMessage = projectAgentDialogState.firstMessage;
            if (coordinatorThreadId && firstMessage) {
              void postGroupPickupMessage(coordinatorThreadId, firstMessage);
            }
            if (coordinatorThreadId) {
              pendingCoordinatorActivationRef.current?.cancel();
              pendingCoordinatorActivationRef.current = {
                pathname,
                cancel: activateThreadWhenHydrated({
                  hasThread: () =>
                    useStore.getState().sidebarThreadSummaryById[coordinatorThreadId] !== undefined,
                  subscribe: (listener) => useStore.subscribe(listener),
                  // The sidebar intent path resolves against the summary map captured at
                  // render time; a thread created by this dialog hydrates later, so wait
                  // for its row and then open it directly.
                  activate: () => {
                    prewarmThreadDetailForIntent(coordinatorThreadId);
                    setOptimisticActiveThreadId(coordinatorThreadId);
                    setSelectionAnchor(coordinatorThreadId);
                    openChatThreadPage(coordinatorThreadId);
                    rememberLastThreadRouteNow({ threadId: coordinatorThreadId });
                    void navigate({
                      to: "/$threadId",
                      params: { threadId: coordinatorThreadId },
                      search: (previous) => ({ ...previous, splitViewId: undefined }),
                    });
                  },
                }),
              };
            }
          }}
        />
      ) : null}

      {searchPaletteOpen ? (
        <SidebarSearchPaletteController
          open={searchPaletteOpen}
          mode={searchPaletteMode}
          onModeChange={setSearchPaletteMode}
          onOpenChange={(open) => {
            setSearchPaletteOpen(open);
            if (!open) {
              setSearchPaletteMode("search");
            }
          }}
          actions={[...searchPaletteActions, ...searchPaletteNavigationActions]}
          projects={searchPaletteProjects}
          projectById={projectById}
          onCreateChat={() => void handleCreateHomeChat()}
          onCreateThread={handlePrimaryNewThread}
          onAddProjectPath={addProjectFromPath}
          homeDir={homeDir}
          onOpenSettings={(section, options) => {
            openSettingsDialog({ section, target: options?.target });
          }}
          onOpenFeedback={() => openFeedbackDialog()}
          onOpenUsageSettings={openUsageSettings}
          onOpenProject={handleOpenProjectFromSearch}
          providerInstances={sidebarProviderInstances}
          onImportThread={handleImportThread}
          onOpenThread={(threadId) => {
            activateThreadFromSidebarIntent(ThreadId.makeUnsafe(threadId));
          }}
        />
      ) : null}
    </>
  );
}

// Message text projections keyed by the thread's message array, which the
// store keeps reference-stable while that thread's messages are unchanged.
const searchPaletteMessagesByThreadMessages = new WeakMap<
  Thread["messages"],
  SidebarSearchThread["messages"]
>();

function searchPaletteMessagesFor(thread: Thread): SidebarSearchThread["messages"] {
  const cached = searchPaletteMessagesByThreadMessages.get(thread.messages);
  if (cached) {
    return cached;
  }
  const projected = thread.messages.map((message) => ({ text: message.text }));
  searchPaletteMessagesByThreadMessages.set(thread.messages, projected);
  return projected;
}

function SidebarSearchPaletteController(props: {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  projectById: ReadonlyMap<ProjectId, { name: string; remoteName: string }>;
  onCreateChat: () => void;
  onCreateThread: () => void;
  onAddProjectPath: (path: string, options?: { createIfMissing?: boolean }) => Promise<void>;
  homeDir: string | null;
  onOpenSettings: (section?: SettingsSectionId, options?: { target?: string }) => void;
  onOpenFeedback: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (projectId: string) => void;
  providerInstances: readonly ProviderInstanceOption[];
  onImportThread: (target: ThreadImportTarget, externalId: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  // Search keeps automation-run threads as an intent-driven escape hatch, while
  // structurally nested side chats stay out of standalone thread results.
  const selectSidebarDisplayThreads = useMemo(
    () => createSidebarDisplayThreadsSelector({ includeSnoozed: true }),
    [],
  );
  const importCandidates = useMemo(
    () => buildThreadImportCandidates(props.providerInstances),
    [props.providerInstances],
  );
  const importProviderCapabilityQueries = useQueries({
    queries: importCandidates.map((target) =>
      providerComposerCapabilitiesQueryOptions(target.provider, target.instanceId),
    ),
  });
  const threads = useStore(selectAllThreads);
  const sidebarDisplayThreads = useStore(selectSidebarDisplayThreads);
  const importTargets = filterThreadImportTargetsByCapabilities(
    importCandidates,
    importProviderCapabilityQueries.map((query) => query.data),
  ).filter((target) => isBetaFeatureOn(target.provider));
  // `threads` is rebuilt on every streamed store flush, so this projection is
  // cheap by construction (message text is cached per thread-messages array
  // below) and its result keeps the previous identity while nothing the
  // palette shows has changed, sparing the palette a full rescore per token.
  const rebuiltSearchPaletteThreads = useMemo<SidebarSearchThread[]>(() => {
    const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
    return sidebarDisplayThreads.flatMap((threadSummary) => {
      const thread = threadById.get(threadSummary.id);
      if (!thread) {
        return [];
      }

      return [
        {
          id: thread.id,
          title: thread.title,
          projectId: thread.projectId,
          projectName: props.projectById.get(thread.projectId)?.name ?? "Unknown project",
          projectRemoteName:
            props.projectById.get(thread.projectId)?.remoteName ?? "Unknown project",
          spaceName: "",
          provider: thread.modelSelection.provider,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: searchPaletteMessagesFor(thread),
        },
      ];
    });
  }, [props.projectById, sidebarDisplayThreads, threads]);
  const searchPaletteThreads = useStableValue(
    rebuiltSearchPaletteThreads,
    areSidebarSearchThreadListsEqual,
  );

  return (
    <SidebarSearchPalette
      open={props.open}
      mode={props.mode}
      onModeChange={props.onModeChange}
      onOpenChange={props.onOpenChange}
      actions={props.actions}
      projects={props.projects}
      threads={searchPaletteThreads}
      onCreateChat={props.onCreateChat}
      onCreateThread={props.onCreateThread}
      onAddProjectPath={props.onAddProjectPath}
      homeDir={props.homeDir}
      onOpenSettings={props.onOpenSettings}
      onOpenFeedback={props.onOpenFeedback}
      onOpenUsageSettings={props.onOpenUsageSettings}
      onOpenProject={props.onOpenProject}
      importTargets={importTargets}
      onImportThread={props.onImportThread}
      onImportProjects={(providers) => useProjectImportDialogStore.getState().openDialog(providers)}
      onOpenThread={props.onOpenThread}
    />
  );
}
