import { type CSSProperties, type FC, type Ref, type SVGProps } from "react";
import { VscMcp } from "react-icons/vsc";
import { cn } from "./utils";
import { CentralIcon, type CentralIconVariant } from "./central-icons";

// ─── One icon family ────────────────────────────────────────────────────────
// Every UI glyph in the app is a Central outline icon: a 24px grid, a 1.5px round-capped
// stroke, rendered as a CSS mask tinted by `currentColor`. Tabler, Hugeicons and the
// react-icons packs used to sit side by side here, each with its own grid and stroke weight,
// which is what made neighbouring controls look like they came from different apps. The
// few roles Central has no glyph for are drawn on the same grid and stroke in
// `public/moss-icons` (the "moss" variant). Brand marks (MCP, provider logos) are the only
// exceptions; they live in brandIcons / ProviderIcon. See docs/design/visual-system.md.

// Keep the existing icon API stable: every export is still a `LucideIcon` component.
export type LucideIcon = FC<SVGProps<SVGSVGElement>>;

type CentralGlyph = LucideIcon & { centralIconName?: string };

// Callers hang hooks on the glyph itself (`data-*` state for CSS and tests, `aria-*`, a `role`
// such as the spinner's live "status", an id or tooltip title); they belong on the rendered span.
// SVG-only props (strokeWidth, fill, …) do not apply to a masked glyph and are dropped.
// `aria-hidden` and the label are decided by CentralIcon.
function forwardedIconAttributes(props: object): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "aria-label" || key === "aria-hidden") continue;
    if (
      key.startsWith("data-") ||
      key.startsWith("aria-") ||
      key === "id" ||
      key === "title" ||
      key === "role"
    ) {
      forwarded[key] = value;
    }
  }
  return forwarded;
}

// Wraps a Central icon asset behind the LucideIcon API. Rendering via CSS mask
// avoids stroke-on-stroke alpha summation that gave hand-drawn SVGs a
// "stamped twice" look on shared vertices (the previous PinIcon bug).
function centralIconWrapper(name: string, variant?: CentralIconVariant): LucideIcon {
  const Glyph: CentralGlyph = function CentralIconWrapper({ className, style, ref, ...rest }) {
    const ariaLabelRaw = (rest as { ["aria-label"]?: unknown })["aria-label"];
    const label = typeof ariaLabelRaw === "string" ? ariaLabelRaw : undefined;
    return (
      <CentralIcon
        {...forwardedIconAttributes(rest)}
        // Animation hooks (the synchronized live spinners) observe the glyph through its ref.
        ref={ref as Ref<HTMLSpanElement> | undefined}
        name={name}
        variant={variant}
        className={typeof className === "string" ? className : undefined}
        style={style as CSSProperties | undefined}
        label={label}
      />
    );
  };
  // Imperative menus (native and the browser fallback) take outline glyphs by basename.
  if (variant === undefined || variant === "reversed") Glyph.centralIconName = name;
  return Glyph;
}

/** The outline basename behind an icon export, or null for glyphs that are not in that set. */
export function centralIconNameOf(Icon: LucideIcon): string | null {
  return (Icon as CentralGlyph).centralIconName ?? null;
}

export const AppsIcon: LucideIcon = centralIconWrapper("apps");
// Composer stacked-panel glyphs (subagent strip / workflow run card).
export const BackgroundTrayIcon: LucideIcon = centralIconWrapper("arrow-down-wall");
export const ContextCompactionIcon: LucideIcon = centralIconWrapper("arrows-hide");
export const BackToParentIcon: LucideIcon = centralIconWrapper("arrow-share-left");
export const WorkflowIcon: LucideIcon = centralIconWrapper("agents");
export const ComposerSendArrowIcon: LucideIcon = centralIconWrapper("arrow-up");
export const SkillCubeIcon: LucideIcon = centralIconWrapper("building-blocks");
export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
// Command palette (⌘K) action glyphs: one Central outline set so the rows read as a family.
export const ImportThreadIcon: LucideIcon = centralIconWrapper("import");
export const UsageGaugeIcon: LucideIcon = centralIconWrapper("gauge");
export const BugReportIcon: LucideIcon = centralIconWrapper("bug");
export const UserIcon: LucideIcon = centralIconWrapper("user");
/** The "+" affordance behind every add/create action (Add project, activity header). */
export const AddPlusIcon: LucideIcon = centralIconWrapper("plus-medium");
/** 2x3 dot grip for drag-to-reorder handles (provider rows, sidebar nav customize). */
export const DragHandleIcon: LucideIcon = centralIconWrapper("dot-grid-2x3");
export const EraserIcon: LucideIcon = centralIconWrapper("eraser");
export const ArrowLeftIcon: LucideIcon = centralIconWrapper("arrow-left");
export const ArrowRightIcon: LucideIcon = centralIconWrapper("arrow-right");
export const ArrowDownIcon: LucideIcon = centralIconWrapper("arrow-down");
export const ArrowUpIcon: LucideIcon = centralIconWrapper("arrow-up");
export const ArrowUpRightIcon: LucideIcon = centralIconWrapper("arrow-up-right");
export const SortIcon: LucideIcon = centralIconWrapper("arrow-top-bottom");
// Single source for the robot/agent glyph. Every robot affordance (reasoning rows,
// agent-task rows, agent mention chips, subagent menus, agent-activity headers) renders
// one identical icon. Use BotIcon in React; AGENT_ROBOT_ICON_NAME for imperative DOM via
// createCentralIconElement.
export const AGENT_ROBOT_ICON_NAME = "robot-3";
export const BotIcon: LucideIcon = centralIconWrapper(AGENT_ROBOT_ICON_NAME);
export const BookOpenIcon: LucideIcon = centralIconWrapper("newspaper-2");
export const BugIcon: LucideIcon = centralIconWrapper("bug");
export const CameraIcon: LucideIcon = centralIconWrapper("camera-1");
export const CheckIcon: LucideIcon = centralIconWrapper("checkmark-1");
// Chevrons share the medium cut so a disclosure caret, a select trigger and a
// pagination arrow are the same size at the same box.
export const ChevronDownIcon: LucideIcon = centralIconWrapper("chevron-down-medium");
export const ChevronLeftIcon: LucideIcon = centralIconWrapper("chevron-left-medium");
export const ChevronRightIcon: LucideIcon = centralIconWrapper("chevron-right-medium");
export const ChevronUpIcon: LucideIcon = centralIconWrapper("chevron-top-medium");
export const ChevronsUpDownIcon: LucideIcon = centralIconWrapper("chevron-grabber-vertical");
export const CircleAlertIcon: LucideIcon = centralIconWrapper("exclamation-circle");
export const OctagonAlertIcon: LucideIcon = centralIconWrapper("exclamation-circle-bold");
export const CircleCheckIcon: LucideIcon = centralIconWrapper("circle-check");
// User-input rows: a question-mark circle while the agent waits for an answer,
// and an up-arrow circle once the answer is submitted.
export const CircleQuestionIcon: LucideIcon = centralIconWrapper("circle-questionmark");
export const ArrowUpCircleIcon: LucideIcon = centralIconWrapper("arrow-up-circle");
export const CloudSyncIcon: LucideIcon = centralIconWrapper("cloud-sync");
export const Columns2Icon: LucideIcon = centralIconWrapper("layout-column");
export const CoffeeIcon: LucideIcon = centralIconWrapper("cup-hot");
export const ChangesIcon: LucideIcon = centralIconWrapper("changes");
/** The one "Keybindings" glyph: the Help menu row, the feature tour, and (by basename) the
 *  Settings nav entry, so the three always match. */
export const KEYBINDINGS_ICON_NAME = "shortcut";
export const KeyboardIcon: LucideIcon = centralIconWrapper(KEYBINDINGS_ICON_NAME);
export const COPY_ICON_NAME = "square-behind-square-6";
export const CopyIcon: LucideIcon = centralIconWrapper(COPY_ICON_NAME);
export const LightbulbIcon: LucideIcon = centralIconWrapper("light-bulb");
export const LinkIcon: LucideIcon = centralIconWrapper("chain-link-3");
// Pull request menu glyphs: a text page for "View PR", the GitHub mark for the inline
// "Open in GitHub" button, and a plus bubble for "Add to chat".
export const PageTextIcon: LucideIcon = centralIconWrapper("page-text");
export const GitHubMarkIcon: LucideIcon = centralIconWrapper("github");
export const ChatBubblePlusIcon: LucideIcon = centralIconWrapper("bubble-plus");
export const DiffIcon: LucideIcon = centralIconWrapper("difference-modified");
export const DownloadIcon: LucideIcon = centralIconWrapper("arrow-wall-down");
export const BELL_ICON_NAME = "notes";
export const BellIcon: LucideIcon = centralIconWrapper(BELL_ICON_NAME);
export const EllipsisIcon: LucideIcon = centralIconWrapper("dot-grid-1x3-horizontal");
export const EyeIcon: LucideIcon = centralIconWrapper("eye-open");
// Markdown Source/Preview toggle glyphs (raw source = code brackets, rendered preview =
// open eye).
export const CodeIcon: LucideIcon = centralIconWrapper("code");
export const EYE_OPEN_ICON_NAME = "eye-open";
export const EyeOpenIcon: LucideIcon = centralIconWrapper(EYE_OPEN_ICON_NAME);
export const PaperclipIcon: LucideIcon = centralIconWrapper("paperclip-1");
export const ArchiveIcon: LucideIcon = centralIconWrapper("archive-1");
export const BrainIcon: LucideIcon = centralIconWrapper("brain");
export const FileIcon: LucideIcon = centralIconWrapper("page-empty");
export const FileAddIcon: LucideIcon = centralIconWrapper("page-add");
export const CirclePersonIcon: LucideIcon = centralIconWrapper("circle-person");
export const BuildingsIcon: LucideIcon = centralIconWrapper("buildings");
export const FlagIcon: LucideIcon = centralIconWrapper("flag-1");
export const FlaskConicalIcon: LucideIcon = centralIconWrapper("lab");
export const GitCommitIcon: LucideIcon = centralIconWrapper("commits");
export const GitMergeIcon: LucideIcon = centralIconWrapper("merged");
export const PushIcon: LucideIcon = centralIconWrapper("cloud-simple-upload");
/**
 * Thread-header mark: two nodes, each with a line to the right. The header's
 * handoff control uses this shape; other handoff surfaces keep the transfer arrows.
 */
export const ListCircleIcon: LucideIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className} {...props}>
    <circle cx="4" cy="4.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.1" />
    <circle cx="4" cy="11.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.1" />
    <rect x="8" y="4" width="6.5" height="1" rx="0.5" />
    <rect x="8" y="11" width="6.5" height="1" rx="0.5" />
  </svg>
);
/**
 * Thread-header Share mark: an open tray with an arrow leaving it. The Central
 * `share-os` stroke draws the tray sides up beside the shaft, which reads heavier
 * and more closed.
 */
export const ShareOsIcon: LucideIcon = ({ className, ...props }) => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className} {...props}>
    <path
      d="M2.5 8.5v2.75a2.25 2.25 0 0 0 2.25 2.25h6.5a2.25 2.25 0 0 0 2.25-2.25V8.5M8 10V2.75M5.25 5.5 8 2.75l2.75 2.75"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
export const GitHubIcon: LucideIcon = centralIconWrapper("github");
// Issue state glyphs, GitHub's shapes from the same outline set: a ring with a dot
// (open), a checked ring (closed as completed), and a struck ring (closed as not planned).
export const IssueOpenedIcon: LucideIcon = centralIconWrapper("record");
export const IssueClosedIcon: LucideIcon = centralIconWrapper("circle-check");
export const IssueNotPlannedIcon: LucideIcon = centralIconWrapper("circle-ban-sign");
// Three descending-width lines — the app's one "filter controls" glyph (pull
// request list filters, and anywhere else that opens a filter popover).
export const FilterIcon: LucideIcon = centralIconWrapper("filter-2");
// GitHub labels (the code review label filter).
export const TagIcon: LucideIcon = centralIconWrapper("tag");
// Two-person glyph for "reviewers"/"people" rows (pull request meta grid).
export const UsersIcon: LucideIcon = centralIconWrapper("user-group");
// One globe for the whole app (browser rows, web search, favicon fallback, local servers).
export const GlobeIcon: LucideIcon = centralIconWrapper("globe");
export const WebSearchIcon: LucideIcon = GlobeIcon;
// Handset glyph for the iOS Simulator dock pane.
export const DeviceMobileIcon: LucideIcon = centralIconWrapper("phone");
// Hardware-button glyphs for the simulator's control rail.
export const DeviceHomeIcon: LucideIcon = centralIconWrapper("home");
export const DeviceShutterIcon: LucideIcon = centralIconWrapper("camera-1");
// Simulator toolbar: start/stop a screen recording, turn the view, power the device off,
// and let go of it. Central has no power symbol, so that one is drawn in public/moss-icons.
export const DeviceRecordIcon: LucideIcon = centralIconWrapper("record");
export const DeviceRecordStopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const DeviceRotateIcon: LucideIcon = centralIconWrapper("rotate");
export const DevicePowerIcon: LucideIcon = centralIconWrapper("power", "moss");
export const DeviceDetachIcon: LucideIcon = centralIconWrapper("broken-chain-link-1");
// Brand mark: the MCP logo is the one third-party glyph kept outside the outline family.
export const McpIcon: LucideIcon = (props) => (
  <VscMcp className={props.className} style={props.style} />
);
export const PluginIcon: LucideIcon = centralIconWrapper("puzzle");
// Single hammer/build glyph (tool-call rows, codex provider, "build" scripts).
export const HammerIcon: LucideIcon = centralIconWrapper("hammer");
export const HistoryIcon: LucideIcon = centralIconWrapper("history");
/** Hand a to-do to an agent. */
export const DelegateIcon: LucideIcon = centralIconWrapper("sparkles-two");
export const CalendarIcon: LucideIcon = centralIconWrapper("calendar-1");
export const InfoIcon: LucideIcon = centralIconWrapper("circle-info");
export const KanbanIcon: LucideIcon = centralIconWrapper("columns-3-wide");
/** Take-control affordance for the computer dock pane. */
export const CursorClickIcon: LucideIcon = centralIconWrapper("cursor-click");
export const ListChecksIcon: LucideIcon = centralIconWrapper("checklist");
export const ListTodoIcon: LucideIcon = centralIconWrapper("list-bullets");
export const Loader2Icon: LucideIcon = centralIconWrapper("loader");
export const LoaderCircleIcon: LucideIcon = Loader2Icon;
export const LoaderIcon: LucideIcon = Loader2Icon;
export const Maximize2: LucideIcon = centralIconWrapper("fullscreen-1");
export const Minimize2: LucideIcon = centralIconWrapper("minimize");
export const MessageCircleIcon: LucideIcon = centralIconWrapper("bubble-2");
export const MinusIcon: LucideIcon = centralIconWrapper("minus-medium");
export const ChatBubbleIcon: LucideIcon = centralIconWrapper("bubble-text");
export const MicIcon: LucideIcon = centralIconWrapper("microphone");
export const PanelLeftIcon: LucideIcon = centralIconWrapper("sidebar-simple-left-wide");
export const PanelRightCloseIcon: LucideIcon = centralIconWrapper("sidebar-simple-right-wide");
export const WindowIcon: LucideIcon = centralIconWrapper("window");
export const LayoutSidebarIcon: LucideIcon = centralIconWrapper("layout-sidebar");
export const PENCIL_ICON_NAME = "pencil";
export const PencilIcon: LucideIcon = centralIconWrapper(PENCIL_ICON_NAME);
export const PIN_ICON_NAME = "pin";
export const PinIcon: LucideIcon = centralIconWrapper(PIN_ICON_NAME);
// Solid pin from the fill set — used wherever a pin reflects "pinned" status
// (project + thread rows and their hover cards) rather than a neutral action.
export const PinFilledIcon: LucideIcon = centralIconWrapper("pin", "fill");
export const PauseIcon: LucideIcon = centralIconWrapper("pause", "fill");
export const PlayIcon: LucideIcon = centralIconWrapper("play", "fill");
// Outline transport glyphs for surfaces that read as a row of neutral actions rather than
// playback state — e.g. the composer goal strip.
export const PauseOutlineIcon: LucideIcon = centralIconWrapper("pause");
export const PlayOutlineIcon: LucideIcon = centralIconWrapper("play");
export const TrashCanIcon: LucideIcon = centralIconWrapper("trash-can");
// Persistent thread goal ("Pursuing goal" strip, /goal surfaces).
export const GoalIcon: LucideIcon = centralIconWrapper("target-arrow");
export const Plus: LucideIcon = AddPlusIcon;
export const PlusIcon: LucideIcon = AddPlusIcon;
export const RefreshCwIcon: LucideIcon = centralIconWrapper("arrow-rotate-clockwise");
export const RotateCcwIcon: LucideIcon = centralIconWrapper("arrow-rotate-counter-clockwise");
export const Rows3Icon: LucideIcon = centralIconWrapper("bars-three");
export const SearchIcon: LucideIcon = centralIconWrapper("magnifying-glass");
// Single source for the settings gear, so gears stay identical across the chrome.
export const SettingsIcon: LucideIcon = centralIconWrapper("settings-gear-4");
export const StarIcon: LucideIcon = centralIconWrapper("star");
export const StarFilledIcon: LucideIcon = centralIconWrapper("star", "fill");
export const SunIcon: LucideIcon = centralIconWrapper("sun");
export const MoonIcon: LucideIcon = centralIconWrapper("moon");
export const DeviceLaptopIcon: LucideIcon = centralIconWrapper("macbook");
export const MonitorIcon: LucideIcon = centralIconWrapper("imac");
export const StopIcon: LucideIcon = centralIconWrapper("stop", "fill");
export const StopFilledIcon: LucideIcon = StopIcon;
export const SquareSplitHorizontal: LucideIcon = centralIconWrapper("layout-column");
export const SquareSplitVertical: LucideIcon = centralIconWrapper("layout-half");
const TemporaryThreadGlyph = centralIconWrapper("bubble-annotation-5");
// Dotted "annotation" chat bubble — the temporary thread marker shown on the
// composer toggle and beside temporary threads in the sidebar.
export const TemporaryThreadIcon: LucideIcon = ({ className, ...props }) => (
  <TemporaryThreadGlyph className={cn("size-4 shrink-0", className)} {...props} />
);
// Central has no soft-wrap glyph; drawn on the same grid in public/moss-icons.
export const TextWrapIcon: LucideIcon = centralIconWrapper("text-wrap", "moss");
export const Trash2: LucideIcon = TrashCanIcon;
export const TriangleAlertIcon: LucideIcon = centralIconWrapper("exclamation-triangle");
export const Undo2Icon: LucideIcon = centralIconWrapper("arrow-undo-up");
// Single source for every "reset / restore default / revert" affordance (settings
// row resets, Restore defaults, effort-slider reset, space reset, file revert).
export const ResetIcon: LucideIcon = centralIconWrapper("arrow-rotate-counter-clockwise");
export const Redo2Icon: LucideIcon = centralIconWrapper("arrow-redo-down");
export const XIcon: LucideIcon = centralIconWrapper("cross-medium");
export const ZapIcon: LucideIcon = centralIconWrapper("zap");
// Single source for the fast-mode glyph: every fast-mode affordance (composer trait
// badges, the effort-header toggle, the /fast command) renders this one solid bolt.
export const FastModeIcon: LucideIcon = centralIconWrapper("zap", "fill");
// Outline twin of FastModeIcon for the inactive toggle state.
export const FastModeOutlineIcon: LucideIcon = ZapIcon;

// ─── Shell, workspace and git roles ──────────────────────────────────────────
// Sidebar and panel toggles, expand/collapse, handoff, Hubs, the rail's update button, the
// one closed / one open folder every project and path row shares, the stacked-folders
// glyph that stands for a file tree, Home, Inbox, Code review, Tasks, Worktrees, Editor
// view, Computer use, the one terminal glyph, open-outside-the-app, and the schedule clock
// that doubles as the automation glyph everywhere it appears.
export const ThinkingIcon: LucideIcon = BrainIcon;
export const WorkingIcon: LucideIcon = HammerIcon;
export const ActivityLoadingIcon: LucideIcon = Loader2Icon;
export const MessageDeliveryCheckIcon: LucideIcon = centralIconWrapper("bubble-check");
export const WorkDetailsIcon: LucideIcon = centralIconWrapper("book");
export const BookIcon: LucideIcon = WorkDetailsIcon;
export const TasksIcon: LucideIcon = centralIconWrapper("square-checklist");
export const HandoffIcon: LucideIcon = centralIconWrapper("arrow-right-left");
export const CheckboxCheckedIcon: LucideIcon = centralIconWrapper("square-check");
export const CheckboxUncheckedIcon: LucideIcon = centralIconWrapper("square-placeholder");
export const ComputerUseIcon: LucideIcon = centralIconWrapper("computer-use");
export const ClockIcon: LucideIcon = centralIconWrapper("clock");
export const PanelCollapseIcon: LucideIcon = centralIconWrapper("arrows-hide");
export const PanelExpandIcon: LucideIcon = centralIconWrapper("arrows-show");
export const HubIcon: LucideIcon = centralIconWrapper("layout-dashboard");
export const HubActiveIcon: LucideIcon = centralIconWrapper("layout-dashboard", "fill");
export const UpdateDownloadIcon: LucideIcon = DownloadIcon;
export const FolderOpenIcon: LucideIcon = centralIconWrapper("folder-open");
export const FolderAddIcon: LucideIcon = centralIconWrapper("folder-add-right");
export const FolderIcon: LucideIcon = centralIconWrapper("folder-2");
export const GiftIcon: LucideIcon = centralIconWrapper("gift-1");
export const FeedbackIcon: LucideIcon = centralIconWrapper("bubble-annotation-2");
export const CustomizeIcon: LucideIcon = centralIconWrapper("settings-slider-hor");
export const FoldersIcon: LucideIcon = centralIconWrapper("folders");
export const GitMergeConflictIcon: LucideIcon = centralIconWrapper("merge-conflict");
export const GitPullRequestIcon: LucideIcon = centralIconWrapper("pull-request");
export const GitPullRequestClosedIcon: LucideIcon = centralIconWrapper(
  "pull-request-closed-simple",
);
export const CreatePullRequestIcon: LucideIcon = centralIconWrapper("pull-request-simple");
export const GitPullRequestDraftIcon: LucideIcon = centralIconWrapper("draft");
// Forking a thread reuses the branch glyph, so fork and branch share one visual.
export const GitBranchIcon: LucideIcon = centralIconWrapper("branch");
export const GitForkIcon: LucideIcon = GitBranchIcon;
// Canonical side-chat glyph — every sidechat surface (right dock pane, environment
// panel rows, tabs) uses this one so the feature reads consistently.
export const SidechatIcon: LucideIcon = centralIconWrapper("chat-bubbles");
export const EditorViewIcon: LucideIcon = centralIconWrapper("code-brackets");
export const CodeReviewIcon: LucideIcon = centralIconWrapper("code-analyze");
export const HomeIcon: LucideIcon = centralIconWrapper("home");
export const InboxIcon: LucideIcon = centralIconWrapper("inbox-empty");
export const Camera01Icon: LucideIcon = CameraIcon;
export const SteerIcon: LucideIcon = centralIconWrapper("arrow-corner-down-right");
export const Key01Icon: LucideIcon = centralIconWrapper("key-1");
export const MoreHorizontalIcon: LucideIcon = EllipsisIcon;
export const ExternalLinkIcon: LucideIcon = centralIconWrapper("square-arrow-top-right");
export const LayoutAlignLeftIcon: LucideIcon = centralIconWrapper("layout-align-left");
export const LayoutAlignRightIcon: LucideIcon = centralIconWrapper("layout-align-right");
export const LayoutLeftIcon: LucideIcon = centralIconWrapper("layout-left");
export const LayoutRightIcon: LucideIcon = centralIconWrapper("layout-right");
export const PanelTopOpenIcon: LucideIcon = centralIconWrapper("layout-top");
export const PlusSignIcon: LucideIcon = AddPlusIcon;
export const WorktreeIcon: LucideIcon = centralIconWrapper("arrow-split-right");
export const TerminalIcon: LucideIcon = centralIconWrapper("console");
// Merged pull requests (the PR-state glyph); merge *actions* keep GitMergeIcon.
export const GitMergedSimpleIcon: LucideIcon = centralIconWrapper("merged-simple");

/** Small model-switch glyph; keep it distinct from the skills/building-blocks icon. */
export const ModelCubeIcon: LucideIcon = centralIconWrapper("3d-box-top");
export const ClipboardHeartIcon: LucideIcon = centralIconWrapper("clipboard-2");
export const UserScreenIcon: LucideIcon = centralIconWrapper("share-screen");
export const GaugeIcon: LucideIcon = UsageGaugeIcon;
/** Plus-in-circle glyph for the shell tab menu's "new side chat". */
export const CirclePlusIcon: LucideIcon = centralIconWrapper("circle-plus");
/** Pop-out glyph for "open in new window". */
export const PopOutIcon: LucideIcon = centralIconWrapper("expand-45");
/** Plain up-right arrow for the tab menu's "open with". */
export const ArrowUpRightLineIcon: LucideIcon = ArrowUpRightIcon;
/** Tray-with-arrow glyph for the thread header archive menu. */
export const ArchiveTrayIcon: LucideIcon = ArchiveIcon;
/** Compass glyph for the draft "new tab" pill. */
export const CompassLineIcon: LucideIcon = centralIconWrapper("compass-round");
/** Bullet-list glyph for the strip's conversation-sidebar toggle. */
export const ListBulletsIcon: LucideIcon = ListTodoIcon;
/** Four-corner expand glyph for the multi-tab strip's pop-out control. */
export const ExpandArrowsIcon: LucideIcon = centralIconWrapper("expand");
/** Window-grid glyph for the multi-tab strip's hide-tabs control. */
export const LayoutWindowIcon: LucideIcon = centralIconWrapper("layout-window");
/** Muted generic network glyph for transient reconnect status rows. */
export const WifiIcon: LucideIcon = centralIconWrapper("wifi-full");
export const LockIcon: LucideIcon = centralIconWrapper("lock");
export const LockOpenIcon: LucideIcon = centralIconWrapper("unlocked");
export const LogInIcon: LucideIcon = centralIconWrapper("arrow-box-right");
export const LogOutIcon: LucideIcon = centralIconWrapper("arrow-box-left");
export const PanelRightOpenIcon: LucideIcon = PanelRightCloseIcon;
// Roles the components used to pull straight from react-icons / Tabler.
export const SparklesIcon: LucideIcon = DelegateIcon;
export const ShareIcon: LucideIcon = centralIconWrapper("share-os");
export const SlidersIcon: LucideIcon = CustomizeIcon;
export const SidebarSimpleIcon: LucideIcon = PanelLeftIcon;
export const RaisedHandIcon: LucideIcon = centralIconWrapper("raising-hand-5-finger");
export const PlusMinusIcon: LucideIcon = DiffIcon;
export const CornerLeftUpIcon: LucideIcon = centralIconWrapper("arrow-corner-left-up");
export const ServerIcon: LucideIcon = centralIconWrapper("server");
export const BlocksIcon: LucideIcon = centralIconWrapper("blocks");
export const BoxIcon: LucideIcon = centralIconWrapper("box-2");
export const VolumeIcon: LucideIcon = centralIconWrapper("volume-full");
export const MicrophoneOffIcon: LucideIcon = centralIconWrapper("microphone-off");
export const VolumeOffIcon: LucideIcon = centralIconWrapper("volume-off");
