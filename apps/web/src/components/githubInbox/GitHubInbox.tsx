// FILE: GitHubInbox.tsx
// Purpose: The GitHub inbox body under the route header: a resizable list column (filter bar,
//          involvement sections of pull request and issue rows, notes) beside an inline detail pane. On a narrow
//          window it shows the list or the detail, with a back control. Filters persist in the
//          local app settings; URL parameters override them for one visit, and the selection
//          lives in the URL so an open item stays linkable. The detail's floating composer feeds
//          the route's side chat dock; Send to agent picks among the projects the item's
//          repository belongs to.
// Layer: GitHub inbox presentation
// Exports: GitHubInbox

import {
  GITHUB_PERSONAL_PROJECT_ID,
  GITHUB_PERSONAL_PROJECT_TITLE,
  type ExternalIssue,
  type GitHubInboxItem,
  type GitHubInboxListError,
  type ProjectId,
  type ThreadId,
} from "@moss/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type GitHubInboxInvolvementFilter,
  type GitHubInboxKindFilter,
  type GitHubInboxStateFilter,
  type TimestampFormat,
  useAppSettings,
} from "~/appSettings";
import { ProjectSidebarIcon } from "~/components/ProjectSidebarIcon";
import type { GitHubItemSendTarget } from "~/components/pullRequest/GitHubItemAgentActions";
import type { GitHubItemInfoThread } from "~/components/pullRequest/GitHubItemInfo";
import type { GitHubItemPageHost } from "~/components/pullRequest/GitHubItemPageLayout";
import type { GitHubItemAgentTarget } from "~/components/pullRequest/githubItemAgentContext";
import type { PullRequestListGroupKey } from "~/components/pullRequest/pullRequestList.logic";
import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { pullRequestDetailInputKey } from "~/components/pullRequest/pullRequestDetail.logic";
import { focusPullRequestRow } from "~/components/pullRequest/pullRequestFocus";
import { PullRequestList } from "~/components/pullRequest/PullRequestList";
import { pullRequestPinToggleInputs } from "~/components/pullRequest/pullRequestList.logic";
import {
  isPullRequestsUnavailableError,
  PullRequestsUnavailableState,
} from "~/components/pullRequest/PullRequestsUnavailableState";
import { PR_FINE_TEXT_CLASS_NAME } from "~/components/pullRequest/pullRequestText";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { GitPullRequestIcon } from "~/lib/icons";
import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "~/lib/panelResize";
import {
  githubInboxListQueryOptions,
  pullRequestMutationKeys,
  pullRequestQueryErrorState,
  pullRequestsForceRefreshMutationOptions,
  pullRequestSetPinnedMutationOptions,
} from "~/lib/pullRequestReactQuery";
import { cn } from "~/lib/utils";
import { useTranslation, type TranslationKey } from "~/localization";
import {
  issueSourcesForceRefreshMutationOptions,
  issueSourcesQueryKeys,
} from "~/lib/issueSourcesQueryOptions";
import { ExternalIssueDetailPanel } from "~/components/issueSources/ExternalIssueDetailPanel";
import { ExternalIssueListSection } from "~/components/issueSources/ExternalIssueRows";
import {
  formatExternalSelection,
  parseExternalSelection,
} from "~/components/issueSources/issueSources.logic";
import { useExternalIssues } from "~/components/issueSources/useExternalIssues";
import { useStore } from "~/store";
import { formatShortTimestamp } from "~/timestampFormat";
import { GitHubInboxFilterBar } from "./GitHubInboxFilterBar";
import { GitHubIssueDetailPanel } from "./GitHubIssueDetailPanel";
import {
  CLEARED_GITHUB_INBOX_FILTER_SEARCH,
  CLEARED_GITHUB_INBOX_FILTER_SETTINGS,
  CLEARED_GITHUB_INBOX_SELECTION,
  collectInboxLabelOptions,
  DEFAULT_EXPANDED_INBOX_SECTIONS,
  countActiveGitHubInboxFilters,
  countInboxItemsByKind,
  countTruncatedInboxRepositories,
  githubInboxListState,
  githubInboxSelection,
  githubInboxSelectionForItem,
  githubInboxSendTargets,
  groupVisibleInboxItems,
  inboxErrorsInScope,
  isGitHubInboxItemSelected,
  resolveInboxItemReference,
  resolveGitHubInboxFilters,
  selectVisibleInboxItems,
  type GitHubInboxSearch,
  type GitHubInboxSearchPatch,
  type GitHubInboxSelection,
  type GitHubInboxKindCounts,
} from "./githubInbox.logic";

// Without the route's Ask dock the list is a slim column and the detail takes the rest; with it
// open the page is three even columns (list, detail, chat). When the window is too small for
// that, the list gives way first (down to where its compact filter bar still works), then the dock (to its own floor),
// and the detail, which is the content, last.
const LIST_MIN_WIDTH = 16 * 16;
/** Below this the detail header and tab row get cramped; the list gives way before it does. */
const DETAIL_PREFERRED_MIN_WIDTH = 22 * 16;
/** The hard floor a drag of the list handle can leave the detail. */
const DETAIL_MIN_WIDTH = 18 * 16;
// With the dock open the page is three even columns (list at half of what the dock leaves);
// without it the list stays a slim column and the detail gets the room for its info column.
const LIST_DEFAULT_WIDTH_DOCK_OPEN = `clamp(${LIST_MIN_WIDTH}px, 50%, calc(100% - ${DETAIL_PREFERRED_MIN_WIDTH}px))`;
const LIST_DEFAULT_WIDTH_DOCK_CLOSED = `clamp(${LIST_MIN_WIDTH}px, 32%, 26rem)`;
const LIST_KEYBOARD_RESIZE_STEP = 16;

function clampListWidth(width: number, containerWidth: number): number {
  const max = Math.max(LIST_MIN_WIDTH, containerWidth - DETAIL_MIN_WIDTH);
  return Math.round(Math.min(max, Math.max(LIST_MIN_WIDTH, width)));
}

/** A list width set by dragging, for the current dock state only. */
interface DraggedListWidth {
  dockOpen: boolean;
  width: number;
  /** Share of the list + detail width, for the separator's value. */
  percent: number;
}

/** The kind tabs' counts with the other sources' issues added to All and Issues. */
function withExternalCount(counts: GitHubInboxKindCounts, external: number): GitHubInboxKindCounts {
  return external === 0
    ? counts
    : { ...counts, all: counts.all + external, issue: counts.issue + external };
}

const NO_ITEMS_KEYS: Record<GitHubInboxKindFilter, TranslationKey> = {
  all: "codeReview.empty.none.all",
  pullRequest: "codeReview.empty.none.pullRequest",
  issue: "codeReview.empty.none.issue",
};

const NOUN_KEYS: Record<GitHubInboxKindFilter, TranslationKey> = {
  all: "codeReview.noun.all",
  pullRequest: "codeReview.noun.pullRequest",
  issue: "codeReview.noun.issue",
};

function rateLimitedWarningText(
  error: GitHubInboxListError,
  timestampFormat: TimestampFormat,
  translate: Pick<ReturnType<typeof useTranslation>, "t" | "format">,
): string {
  const { t, format } = translate;
  const resetTime = error.retryAt ? formatShortTimestamp(error.retryAt, timestampFormat) : null;
  const refresh = resetTime
    ? format("codeReview.rateLimit.resumeAt", { time: resetTime })
    : t("codeReview.rateLimit.resumeSoon");
  return format(
    error.showingCachedData ? "codeReview.rateLimit.cached" : "codeReview.rateLimit.partial",
    { refresh },
  );
}

/**
 * Drag or arrow-key handle on the list column's right edge. The width it sets holds until the Ask
 * dock opens or closes, which returns the columns to their fractions.
 */
function ListColumnResizeHandle({
  percent,
  columnRef,
  onResize,
}: {
  percent: number;
  columnRef: RefObject<HTMLElement | null>;
  onResize: (width: number, percent: number) => void;
}) {
  const { t, format } = useTranslation();
  const resizeTo = (width: number) => {
    const containerWidth = columnRef.current?.parentElement?.clientWidth;
    if (!containerWidth) return;
    const clamped = clampListWidth(width, containerWidth);
    onResize(clamped, Math.round((clamped / containerWidth) * 100));
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const column = columnRef.current;
    if (!column || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = column.getBoundingClientRect().width;
    const overlay = createPanelResizeOverlay();
    let detach: (() => void) | null = null;
    const finish = () => {
      detach?.();
      removePanelResizeOverlay(overlay);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    detach = attachPanelPointerOverlaySession(overlay, {
      onMove: (moveEvent) => resizeTo(startWidth + moveEvent.clientX - startX),
      onRelease: finish,
      onAbort: finish,
    });
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft"
        ? -LIST_KEYBOARD_RESIZE_STEP
        : event.key === "ArrowRight"
          ? LIST_KEYBOARD_RESIZE_STEP
          : 0;
    const column = columnRef.current;
    if (step === 0 || !column) return;
    event.preventDefault();
    resizeTo(column.getBoundingClientRect().width + step);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("codeReview.list.resize")}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={format("codeReview.list.resizeValue", { percent })}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={handleKeyDown}
      className="absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-[var(--app-surface-divider)] focus-visible:outline-none focus-visible:before:w-0.5 focus-visible:before:bg-ring"
    />
  );
}

function ListSkeleton() {
  const { t } = useTranslation();
  // Mirrors the loaded list's row height and spacing so the switch doesn't jump.
  return (
    <div className="space-y-0.5" aria-busy="true" aria-label={t("codeReview.list.loading")}>
      {Array.from({ length: 7 }, (_, index) => (
        <Skeleton key={index} className="h-[4.75rem] w-full rounded-card" />
      ))}
    </div>
  );
}

/** Calm inline notice for GitHub errors while connected Linear/Jira sections stay visible. */
function GitHubInlineUnavailableNotice({
  error,
  timestampFormat,
  onRetry,
}: {
  error: unknown;
  timestampFormat: TimestampFormat;
  onRetry: () => void;
}) {
  const { t, format } = useTranslation();
  const unavailable = isPullRequestsUnavailableError(error) ? error : null;
  const notInstalled = unavailable?.reason === "gh-not-installed";
  const notAuthenticated = unavailable?.reason === "gh-not-authenticated";
  const rateLimited = unavailable?.reason === "rate-limited";
  const resetTime =
    rateLimited && unavailable?.retryAt
      ? formatShortTimestamp(unavailable.retryAt, timestampFormat)
      : null;
  const title = notInstalled
    ? t("codeReview.gh.required")
    : notAuthenticated
      ? t("codeReview.gh.signIn")
      : rateLimited
        ? t("codeReview.rateLimit.title")
        : format("codeReview.unavailable.title", { subject: t("codeReview.list.subject") });
  const description = notInstalled
    ? t("codeReview.gh.requiredHint")
    : notAuthenticated
      ? t("codeReview.gh.signInHint")
      : rateLimited
        ? resetTime
          ? format("codeReview.rateLimit.pausedAt", { time: resetTime })
          : t("codeReview.rateLimit.paused")
        : t("codeReview.unavailable.failed");
  return (
    <PullRequestWarningNote shape="callout" role="status">
      <span className="flex flex-col gap-2">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{title}</span>
          <span className="text-muted-foreground">{description}</span>
        </span>
        <span>
          <Button variant="outline" size="xs" onClick={onRetry}>
            {t("codeReview.retry")}
          </Button>
        </span>
      </span>
    </PullRequestWarningNote>
  );
}

function DetailEmptyState() {
  const { t } = useTranslation();
  // Quiet and centered; not a card.
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <GitPullRequestIcon aria-hidden className="mb-2 size-6 text-muted-foreground/60" />
      <p className="m-0 text-ui-lg text-foreground">{t("codeReview.detail.emptyTitle")}</p>
      <p className="m-0 text-ui-sm text-muted-foreground">{t("codeReview.detail.emptyHint")}</p>
    </div>
  );
}

function GitHubInboxDetail({
  selection,
  sendTargets,
  onBack,
  onSelectPullRequest,
  pageHost,
}: {
  selection: GitHubInboxSelection;
  sendTargets: ReadonlyArray<GitHubItemSendTarget>;
  onBack: (() => void) | undefined;
  onSelectPullRequest: (number: number) => void;
  pageHost: GitHubItemPageHost;
}) {
  const input = {
    projectId: selection.projectId,
    repository: selection.repository,
    number: selection.number,
  };
  // Keyed by identity so switching items remounts the panel and resets its tab and scroll.
  const key = `${selection.kind}:${pullRequestDetailInputKey(input)}`;
  return selection.kind === "issue" ? (
    <GitHubIssueDetailPanel
      key={key}
      input={input}
      onSelectPullRequest={onSelectPullRequest}
      sendTargets={sendTargets}
      pageHost={pageHost}
      {...(onBack ? { onBack } : {})}
    />
  ) : (
    <PullRequestDetailPanel
      key={key}
      input={input}
      layout="page"
      onSelectPullRequest={onSelectPullRequest}
      sendTargets={sendTargets}
      pageHost={pageHost}
      {...(onBack ? { onBack } : {})}
    />
  );
}

/** The route's side chat, as the page uses it. */
export interface GitHubInboxSidechatHost {
  /** Opens the item's side chat dock (reusing its live chat) without sending anything. */
  ask: (target: GitHubItemAgentTarget) => void;
  /** Sends a question into the item's side chat, starting one when there is none. */
  askQuestion: (target: GitHubItemAgentTarget, question: string) => void;
  askPending: boolean;
  /** The selected item's side chats, newest first. */
  sidechats: ReadonlyArray<GitHubItemInfoThread>;
  /** Shows one of them in the dock, opening the dock when it is closed. */
  openSidechat: (threadId: ThreadId) => void;
}

export function GitHubInbox({
  search,
  onSearchChange,
  sidechat,
  dockOpen: dockOpenProp,
  githubUnavailable = false,
  githubConnectionNotice,
}: {
  search: GitHubInboxSearch;
  onSearchChange: (patch: GitHubInboxSearchPatch) => void;
  /** The route's side chat. Absent hides the floating composer and the Threads row. */
  sidechat?: GitHubInboxSidechatHost;
  /** Whether the route's Ask dock is open; the column fractions reset when it changes. */
  dockOpen?: boolean;
  /** True when the route opened via connected external sources while GitHub CLI is not ready. */
  githubUnavailable?: boolean;
  /** Calm inline GitHub connection card shown while GitHub CLI is not ready. */
  githubConnectionNotice?: ReactNode;
}) {
  const { settings, updateSettings } = useAppSettings();
  const { t, format } = useTranslation();
  const dockOpen = dockOpenProp ?? false;
  const isMobile = useIsMobile();
  const projects = useStore((store) => store.projects);
  const queryClient = useQueryClient();

  const repositoryProjects = useMemo(
    () =>
      projects
        .filter((project) => project.kind === "project")
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    [projects],
  );
  // Fetched before the filters resolve: whether "My GitHub" exists decides which persisted
  // project filters still apply. The list is one per state and sort either way.
  const persistedState = search.state ?? settings.githubInboxState;
  const listQuery = useQuery({
    ...githubInboxListQueryOptions(githubInboxListState(persistedState), settings.githubInboxSort),
    enabled: !githubUnavailable,
  });
  const personalListed = listQuery.data?.personalState === "loaded";
  const projectOptions = useMemo(
    () => [
      // The person's own items across GitHub, listed with or without projects.
      ...(personalListed
        ? [{ id: GITHUB_PERSONAL_PROJECT_ID, name: GITHUB_PERSONAL_PROJECT_TITLE }]
        : []),
      ...repositoryProjects.map((project) => ({
        id: project.id,
        name: project.name,
      })),
    ],
    [personalListed, repositoryProjects],
  );
  const existingProjectIds = useMemo(
    () => new Set(projectOptions.map((project) => project.id)),
    [projectOptions],
  );
  const filters = resolveGitHubInboxFilters(search, settings, existingProjectIds);
  const selection = githubInboxSelection(search);
  const listState = githubInboxListState(filters.state);
  const refreshMutation = useMutation(pullRequestsForceRefreshMutationOptions(queryClient));
  const externalRefreshMutation = useMutation(issueSourcesForceRefreshMutationOptions(queryClient));
  const pinMutation = useMutation(pullRequestSetPinnedMutationOptions(queryClient));
  const activeActionCount = useIsMutating({
    mutationKey: pullRequestMutationKeys.action,
  });
  const { initialError, backgroundError } = pullRequestQueryErrorState(listQuery);
  const listData = listQuery.data;

  // Large result sets: keep typing responsive while React catches the rows up in a
  // lower-priority render. Virtualization can wait for measured need.
  const query = search.q ?? "";
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const entries = selectVisibleInboxItems(listData?.items ?? [], filters, {
    viewer: listData?.viewer,
    sort: settings.githubInboxSort,
    normalizedQuery: deferredQuery,
    preferredProjectId: selection?.projectId,
  });
  const groups = groupVisibleInboxItems(entries);

  // Linear and Jira issues sit under the GitHub rows while issues are in view.
  const linearIssues = useExternalIssues("linear", filters, deferredQuery);
  const jiraIssues = useExternalIssues("jira", filters, deferredQuery);
  const externalSources = [linearIssues, jiraIssues];
  const externalSelection = parseExternalSelection(search.external);
  const selectExternalIssue = (issue: ExternalIssue) =>
    onSearchChange({
      ...CLEARED_GITHUB_INBOX_SELECTION,
      external: formatExternalSelection({ source: issue.source, id: issue.id }),
    });
  // While searching, every section opens so a match is never hidden behind a fold.
  const expandedSections: ReadonlyArray<PullRequestListGroupKey> =
    settings.githubInboxExpandedSections ?? DEFAULT_EXPANDED_INBOX_SECTIONS;
  type FoldableSection = Exclude<PullRequestListGroupKey, "pinned" | "all">;
  const isSectionOpen = (key: PullRequestListGroupKey) =>
    deferredQuery.length > 0 || expandedSections.includes(key);
  const toggleSection = (key: PullRequestListGroupKey) => {
    if (key === "pinned" || key === "all") return;
    const open = expandedSections.filter(
      (entry): entry is FoldableSection => entry !== "pinned" && entry !== "all",
    );
    updateSettings({
      githubInboxExpandedSections: open.includes(key)
        ? open.filter((entry) => entry !== key)
        : [...open, key],
    });
  };
  const labelOptions = collectInboxLabelOptions(listData?.items ?? [], filters);
  const activeFilterCount = countActiveGitHubInboxFilters(filters, query);
  const truncatedRepositoryCount = countTruncatedInboxRepositories(
    listData?.repositoryBatches ?? [],
    filters,
  );
  const scopedErrors = inboxErrorsInScope(listData?.errors ?? [], filters);
  const rateLimitedError = scopedErrors.find((error) => error.reason === "rate-limited");
  const unavailableErrorCount = scopedErrors.filter(
    (error) => error.reason !== "rate-limited",
  ).length;
  const inventoryIncomplete = scopedErrors.length > 0 || listData?.repositoryState === "incomplete";
  const noRemote = listData?.repositoryState === "none";

  // ── Filters: a change persists and drops that filter's one-visit URL override ──
  const setKind = (kind: GitHubInboxKindFilter) => {
    updateSettings({ githubInboxKind: kind });
    if (search.type !== undefined) onSearchChange({ type: undefined });
  };
  const setState = (state: GitHubInboxStateFilter) => {
    updateSettings({ githubInboxState: state });
    if (search.state !== undefined) onSearchChange({ state: undefined });
  };
  const setInvolvement = (involvement: GitHubInboxInvolvementFilter) => {
    updateSettings({ githubInboxInvolvement: involvement });
    if (search.involvement !== undefined) onSearchChange({ involvement: undefined });
  };
  const setProjectIds = (projectIds: ProjectId[]) => {
    updateSettings({ githubInboxProjectIds: projectIds });
    if (search.projectId !== undefined) onSearchChange({ projectId: undefined });
  };
  const setLabels = (labels: string[]) => updateSettings({ githubInboxLabels: labels });
  const clearFilters = () => {
    updateSettings(CLEARED_GITHUB_INBOX_FILTER_SETTINGS);
    onSearchChange(CLEARED_GITHUB_INBOX_FILTER_SEARCH);
  };

  // ── Rows ──
  const selectItem = (item: GitHubInboxItem) => onSearchChange(githubInboxSelectionForItem(item));
  // A pasted PR or issue link (or #number) that names one loaded item opens it.
  const pasteReference = (text: string): boolean => {
    const item = resolveInboxItemReference(text, listData?.items ?? []);
    if (!item) return false;
    selectItem(item);
    onSearchChange({ q: undefined });
    return true;
  };
  const togglePinned = (item: GitHubInboxItem) => {
    for (const input of pullRequestPinToggleInputs(item)) {
      pinMutation.mutate(input, {
        onError: () =>
          toastManager.add({
            type: "error",
            title: t("codeReview.pin.failed"),
            description: t("codeReview.pin.failedDetail"),
          }),
      });
    }
  };
  const isRefreshing = refreshMutation.isPending || externalRefreshMutation.isPending;
  const refreshBlockedReason = isRefreshing
    ? t("codeReview.refreshing")
    : activeActionCount > 0
      ? t("codeReview.refresh.blockedAction")
      : null;
  const refresh = () => {
    if (refreshBlockedReason !== null) return;
    const externalTargets = externalSources
      .filter((source) => source.countable && source.teamIds.length > 0)
      .map((source) => ({
        source: source.source,
        state: source.listState,
        teamIds: source.teamIds,
      }));
    for (const source of externalSources) {
      if (source.statusState === "failed") {
        void queryClient.invalidateQueries({
          queryKey: issueSourcesQueryKeys.status(source.source),
        });
      }
    }
    if (externalTargets.length > 0) {
      externalRefreshMutation.mutate(externalTargets, {
        onError: () =>
          toastManager.add({
            type: "error",
            title: t("codeReview.refresh.failed"),
            description: t("codeReview.refresh.failedDetail"),
          }),
      });
    }
    if (!githubUnavailable) {
      refreshMutation.mutate(
        { state: listState, sort: settings.githubInboxSort },
        {
          onError: () =>
            toastManager.add({
              type: "error",
              title: t("codeReview.refresh.failed"),
              description: t("codeReview.refresh.failedDetail"),
            }),
        },
      );
    }
  };
  const projectById = new Map(repositoryProjects.map((project) => [project.id, project] as const));
  const projectIconFor = (projectId: ProjectId) => {
    const project = projectById.get(projectId);
    return project ? (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        <ProjectSidebarIcon
          cwd={project.cwd}
          expanded={false}
          appearance={project.appearance}
          glyphClassName="size-3"
        />
      </span>
    ) : null;
  };

  // ── Layout ──
  const columnRef = useRef<HTMLElement>(null);
  const [draggedList, setDraggedList] = useState<DraggedListWidth | null>(null);
  // A drag holds only for the dock state it happened in: opening or closing the chat returns the
  // columns to their fractions, as the dock itself re-pins to its share on open.
  const draggedListWidth = draggedList?.dockOpen === dockOpen ? draggedList : null;
  const hasSelection = selection !== null || externalSelection !== null;
  const showList = !isMobile || !hasSelection;
  const showDetail = !isMobile || hasSelection;
  // Narrow windows swap the list for the detail; going back returns focus to the row it opened.
  const goBackToList = () => {
    const rowToRestore = selection;
    onSearchChange(CLEARED_GITHUB_INBOX_SELECTION);
    if (rowToRestore) {
      requestAnimationFrame(() => {
        focusPullRequestRow(document, rowToRestore);
      });
    }
  };

  const selectedListItem = selection
    ? (listData?.items ?? []).find(
        (item) =>
          item.kind === selection.kind &&
          item.number === selection.number &&
          item.repository.toLowerCase() === selection.repository.toLowerCase(),
      )
    : undefined;
  const pageHost: GitHubItemPageHost = {
    pin: selectedListItem
      ? {
          pinned: selectedListItem.isPinned === true,
          onToggle: () => togglePinned(selectedListItem),
        }
      : undefined,
    threads: sidechat?.sidechats ?? [],
    onOpenThread: sidechat?.openSidechat,
    onAsk: sidechat?.ask,
    onAskQuestion: sidechat?.askQuestion,
    askPending: sidechat?.askPending === true,
    composerVisible: !dockOpen,
  };

  const reviewRequestsOnlyOpen =
    filters.involvement === "reviewRequested" && filters.state !== "open";
  const externalMatchingCount = externalSources.reduce(
    (sum, source) => sum + source.matching.length,
    0,
  );
  const hasExternalData = externalSources.some((source) => source.result !== undefined);
  const hasExternalSections = externalSources.some((source) => source.showSection);
  const hasExternalPending = externalSources.some((source) => source.isPending);
  const hasVisibleExternalContent = externalSources.some(
    (source) => source.listed.length > 0 || source.error !== null,
  );
  const externalSectionNodes = externalSources.map((source) =>
    source.showSection ? (
      <ExternalIssueListSection
        key={source.source}
        source={source.source}
        issues={source.listed}
        selectedId={externalSelection?.source === source.source ? externalSelection.id : null}
        failedTeamCount={source.result?.failedTeamIds.length ?? 0}
        truncated={source.result?.truncated ?? false}
        forceOpen={deferredQuery.length > 0}
        error={source.error}
        onRetry={source.refetch}
        onSelect={selectExternalIssue}
      />
    ) : null,
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {showList ? (
        <section
          ref={columnRef}
          aria-label={t("codeReview.list.aria")}
          className={cn(
            "relative flex min-h-0 flex-col",
            isMobile ? "min-w-0 flex-1" : "min-w-[16rem] max-w-[calc(100%-18rem)] shrink-0",
          )}
          style={
            isMobile
              ? undefined
              : {
                  width:
                    draggedListWidth?.width ??
                    (dockOpen ? LIST_DEFAULT_WIDTH_DOCK_OPEN : LIST_DEFAULT_WIDTH_DOCK_CLOSED),
                }
          }
        >
          <div className="shrink-0">
            <GitHubInboxFilterBar
              filters={filters}
              sort={settings.githubInboxSort}
              onSortChange={(sort) => updateSettings({ githubInboxSort: sort })}
              query={query}
              kindCounts={
                listData
                  ? withExternalCount(
                      countInboxItemsByKind(listData.items, filters, {
                        viewer: listData.viewer,
                        normalizedQuery: deferredQuery,
                        repositoryBatches: listData.repositoryBatches,
                      }),
                      externalMatchingCount,
                    )
                  : hasExternalData
                    ? { all: externalMatchingCount, pullRequest: 0, issue: externalMatchingCount }
                    : null
              }
              projectOptions={projectOptions}
              labelOptions={labelOptions}
              refreshing={isRefreshing}
              refreshBlockedReason={refreshBlockedReason}
              onQueryChange={(value) => onSearchChange({ q: value || undefined })}
              onKindChange={setKind}
              onStateChange={setState}
              onInvolvementChange={setInvolvement}
              onProjectIdsChange={setProjectIds}
              onLabelsChange={setLabels}
              onClearFilters={clearFilters}
              onRefresh={refresh}
              onPasteReference={pasteReference}
            />
          </div>
          <div className="@container/list min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-8">
            <div className="flex flex-col gap-3">
              {githubUnavailable ? (
                <>
                  {hasExternalSections ? (
                    externalSectionNodes
                  ) : hasExternalPending ? (
                    <ListSkeleton />
                  ) : null}
                  {githubConnectionNotice}
                </>
              ) : listQuery.isPending ? (
                hasExternalSections ? (
                  externalSectionNodes
                ) : (
                  <ListSkeleton />
                )
              ) : initialError ? (
                hasExternalSections ? (
                  <>
                    {externalSectionNodes}
                    <GitHubInlineUnavailableNotice
                      error={initialError}
                      timestampFormat={settings.timestampFormat}
                      onRetry={() => void listQuery.refetch()}
                    />
                  </>
                ) : (
                  <PullRequestsUnavailableState
                    error={initialError}
                    subject={t("codeReview.list.subject")}
                    onRetry={() => void listQuery.refetch()}
                  />
                )
              ) : (
                <>
                  {entries.length === 0 && !hasVisibleExternalContent ? (
                    <Empty className="py-12">
                      <EmptyHeader>
                        <EmptyTitle>
                          {repositoryProjects.length === 0 &&
                          listData?.personalState === "unavailable"
                            ? t("codeReview.empty.personalUnavailable")
                            : repositoryProjects.length === 0 &&
                                listData?.personalState === "loaded"
                              ? activeFilterCount > 0
                                ? t(NO_ITEMS_KEYS[filters.kind])
                                : t("codeReview.empty.nothingNeedsYou")
                              : repositoryProjects.length === 0
                                ? t("codeReview.empty.noProjects")
                                : inventoryIncomplete && listData?.repositoryBatches.length === 0
                                  ? t("codeReview.empty.uncheckedRepos")
                                  : noRemote
                                    ? t("codeReview.empty.noRemote")
                                    : reviewRequestsOnlyOpen
                                      ? t("codeReview.empty.reviewOnlyOpen")
                                      : t(NO_ITEMS_KEYS[filters.kind])}
                        </EmptyTitle>
                        <EmptyDescription>
                          {repositoryProjects.length === 0 &&
                          listData?.personalState === "unavailable"
                            ? t("codeReview.empty.retryPersonal")
                            : repositoryProjects.length === 0 &&
                                listData?.personalState === "loaded"
                              ? activeFilterCount > 0
                                ? t("codeReview.empty.tryOtherFilter")
                                : t("codeReview.empty.personalHint")
                              : repositoryProjects.length === 0
                                ? t("codeReview.empty.noProjectsHint")
                                : inventoryIncomplete && listData?.repositoryBatches.length === 0
                                  ? t("codeReview.empty.uncheckedHint")
                                  : noRemote
                                    ? t("codeReview.empty.noRemoteHint")
                                    : reviewRequestsOnlyOpen
                                      ? t("codeReview.empty.reviewOnlyOpenHint")
                                      : activeFilterCount > 0
                                        ? t("codeReview.empty.tryOtherFilter")
                                        : t("codeReview.empty.nothingHere")}
                        </EmptyDescription>
                      </EmptyHeader>
                      {activeFilterCount > 0 ? (
                        <EmptyContent>
                          <Button variant="outline" size="sm" onClick={clearFilters}>
                            {t("codeReview.filter.clearAll")}
                          </Button>
                        </EmptyContent>
                      ) : repositoryProjects.length === 0 &&
                        listData?.personalState === "unavailable" ? (
                        <EmptyContent>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void listQuery.refetch()}
                          >
                            {t("codeReview.empty.retry")}
                          </Button>
                        </EmptyContent>
                      ) : null}
                    </Empty>
                  ) : entries.length > 0 ? (
                    <PullRequestList
                      sort={settings.githubInboxSort}
                      groups={groups}
                      isSectionOpen={isSectionOpen}
                      onToggleSection={toggleSection}
                      isSelected={(item) => isGitHubInboxItemSelected(item, selection)}
                      showProjectTitle={
                        filters.projectIds.length !== 1 && projectOptions.length > 1
                      }
                      projectIconFor={projectIconFor}
                      onSelect={selectItem}
                      onTogglePinned={togglePinned}
                    />
                  ) : null}
                  {externalSectionNodes}
                </>
              )}
              {truncatedRepositoryCount > 0 ? (
                <p className={cn(PR_FINE_TEXT_CLASS_NAME, "text-muted-foreground")}>
                  {`${format(
                    filters.state === "merged"
                      ? "codeReview.truncated.merged"
                      : "codeReview.truncated.items",
                    {
                      order: t(
                        settings.githubInboxSort === "created"
                          ? "codeReview.truncated.order.created"
                          : "codeReview.truncated.order.updated",
                      ),
                      noun: t(NOUN_KEYS[filters.kind]),
                    },
                  )} ${format(
                    truncatedRepositoryCount === 1
                      ? "codeReview.truncated.moreOne"
                      : "codeReview.truncated.moreMany",
                    { count: truncatedRepositoryCount },
                  )}`}
                </p>
              ) : null}
              {rateLimitedError ? (
                <PullRequestWarningNote shape="callout" role="status">
                  {rateLimitedWarningText(rateLimitedError, settings.timestampFormat, {
                    t,
                    format,
                  })}
                </PullRequestWarningNote>
              ) : null}
              {unavailableErrorCount > 0 ? (
                <PullRequestWarningNote shape="callout">
                  {format(
                    unavailableErrorCount === 1
                      ? "codeReview.unavailable.one"
                      : "codeReview.unavailable.many",
                    { count: unavailableErrorCount },
                  )}
                </PullRequestWarningNote>
              ) : null}
              {backgroundError ? (
                <PullRequestWarningNote shape="callout" role="status">
                  {t("codeReview.backgroundFailed")}
                </PullRequestWarningNote>
              ) : null}
            </div>
          </div>
          {isMobile ? null : (
            <ListColumnResizeHandle
              percent={draggedListWidth?.percent ?? (dockOpen ? 50 : 32)}
              columnRef={columnRef}
              onResize={(width, percent) => setDraggedList({ dockOpen, width, percent })}
            />
          )}
        </section>
      ) : null}
      {showDetail ? (
        <section
          aria-label={t("codeReview.detail.aria")}
          // The detail's own parts pad for the chat dock; the page gives them more room.
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !isMobile && "px-3 pt-2")}
        >
          {externalSelection ? (
            <ExternalIssueDetailPanel
              key={formatExternalSelection(externalSelection)}
              source={externalSelection.source}
              issueId={externalSelection.id}
              {...(isMobile ? { onBack: goBackToList } : {})}
            />
          ) : selection ? (
            <GitHubInboxDetail
              selection={selection}
              sendTargets={githubInboxSendTargets(listData?.items ?? [], selection, filters)}
              pageHost={pageHost}
              onBack={isMobile ? goBackToList : undefined}
              onSelectPullRequest={(number) =>
                onSearchChange({
                  kind: "pullRequest",
                  selectedProjectId: selection.projectId,
                  selectedRepo: selection.repository,
                  number,
                })
              }
            />
          ) : (
            <DetailEmptyState />
          )}
        </section>
      ) : null}
    </div>
  );
}
