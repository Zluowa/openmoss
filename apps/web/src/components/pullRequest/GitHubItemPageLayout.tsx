// FILE: GitHubItemPageLayout.tsx
// Purpose: The shell of a GitHub item's detail on the code review page, one for pull requests and
//          issues: a top bar (back on a narrow window, the tabs, then the actions at the right),
//          the loading / unavailable / not found states, and the tab bodies. The Summary body
//          scrolls with the info either in a right-hand column or folded into rows under the
//          header; the switch is a container query on the detail pane itself, so a narrow window
//          and an open side chat dock fold it the same way. Every tab docks the question
//          composer in its own row under the scrolling content, so it never covers any text.
// Layer: Pull request presentation
// Exports: GitHubItemDetailPage, GitHubItemTabs, GitHubItemPageBody, GitHubItemTabBody,
//          GitHubItemPageIconActions, GitHubItemAskComposer, GitHubItemPageHost,
//          PullRequestDetailSkeleton

import { useInPageGlassOverlay } from "~/hooks/useInPageGlassOverlay";
import { GITHUB_PERSONAL_PROJECT_ID, type ProjectId, type ThreadId } from "@moss/contracts";
import { useState, type ReactNode } from "react";

import { Tabs } from "~/components/ui/tabs";
import { MENU_ICON_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { IconButton } from "~/components/ui/icon-button";
import { MenuItem } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { ChatBubbleIcon, ExternalLinkIcon, LinkIcon } from "~/lib/icons";
import { PinStatusIcon } from "~/lib/pin";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { SendToAgentMenuItems, type GitHubItemSendTarget } from "./GitHubItemAgentActions";
import { GitHubItemFloatingComposer } from "./GitHubItemFloatingComposer";
import { GitHubItemBackButton } from "./GitHubItemHeader";
import type { GitHubItemInfoThread, GitHubItemInfoVariant } from "./GitHubItemInfo";
import type { GitHubItemAgentTarget } from "./githubItemAgentContext";
import { copyPullRequestLink } from "./PullRequestConfirmActionDialog";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";

/** What the code review page gives a detail panel beyond the item itself. */
export interface GitHubItemPageHost {
  /** The list row's pin, for the top bar's pin control. */
  pin?: { pinned: boolean; onToggle: () => void } | undefined;
  /** The item's side chats, for the Threads row. */
  threads: ReadonlyArray<GitHubItemInfoThread>;
  /** Shows that side chat in the dock, opening the dock when it is closed. */
  onOpenThread?: ((id: ThreadId) => void) | undefined;
  /** Opens the side chat dock without sending anything. */
  onAsk?: ((target: GitHubItemAgentTarget) => void) | undefined;
  /** The floating composer's submit; absent hides the composer. */
  onAskQuestion?: ((target: GitHubItemAgentTarget, text: string) => void) | undefined;
  askPending: boolean;
  /** False while the side chat dock is open: its own composer takes over. */
  composerVisible: boolean;
}

/** A page without the code review page around it: no pin, threads, or composer. */
export const DETACHED_GITHUB_ITEM_PAGE_HOST: GitHubItemPageHost = {
  threads: [],
  askPending: false,
  composerVisible: false,
};

export function PullRequestDetailSkeleton() {
  return (
    <div className="space-y-4 p-5">
      <Skeleton className="h-7 w-4/5" />
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** The floating composer of a detail page, wired to the host's side chat. */
export function GitHubItemAskComposer({
  noun,
  defaultProjectId,
  sendTargets,
  buildTarget,
  host,
  onSendToAgent,
}: {
  noun: "pull request" | "issue";
  defaultProjectId: ProjectId;
  sendTargets: ReadonlyArray<GitHubItemSendTarget>;
  buildTarget: (projectId: ProjectId) => GitHubItemAgentTarget;
  host: GitHubItemPageHost;
  onSendToAgent: (projectId: ProjectId) => void;
}) {
  const { t } = useTranslation();
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | null>(null);
  const projectId =
    chosenProjectId !== null && sendTargets.some((target) => target.projectId === chosenProjectId)
      ? chosenProjectId
      : (sendTargets.find((target) => target.projectId === defaultProjectId)?.projectId ??
        sendTargets[0]?.projectId ??
        defaultProjectId);
  if (!host.onAskQuestion || !host.composerVisible) return null;
  // An item only "My GitHub" lists has no project folder for the chat to run in.
  if (projectId === GITHUB_PERSONAL_PROJECT_ID) return null;
  const { onAskQuestion, onAsk } = host;
  return (
    <GitHubItemFloatingComposer
      placeholder={t(noun === "issue" ? "codeReview.ask.issue" : "codeReview.ask.pullRequest")}
      projects={sendTargets}
      projectId={projectId}
      onProjectChange={setChosenProjectId}
      pending={host.askPending}
      onSubmit={(text) => onAskQuestion(buildTarget(projectId), text)}
      plusMenu={
        <>
          {onAsk ? (
            <MenuItem onClick={() => onAsk(buildTarget(projectId))}>
              <ChatBubbleIcon className={MENU_ICON_CLASS_NAME} />
              <span>{t("codeReview.sideChat.open")}</span>
            </MenuItem>
          ) : null}
          <SendToAgentMenuItems sendTargets={sendTargets} onSendToAgent={onSendToAgent} />
        </>
      }
    />
  );
}

export interface GitHubItemTabOption<T extends string> {
  value: T;
  label: string;
  /** Rides after the label (the Changes tab's diff counts). */
  trailing?: ReactNode;
}

/** A detail's views (概览 / 文件 …): the shared Tabs, as any page switches views inside it. */
export function GitHubItemTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: ReadonlyArray<GitHubItemTabOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the row ("Pull request detail tabs"). */
  label: string;
  className?: string;
}) {
  return (
    <Tabs
      ariaLabel={label}
      selected={value}
      onSelect={onChange}
      tabs={tabs.map((tab) => ({
        id: tab.value,
        label: tab.label,
        ...(tab.trailing != null ? { trailing: tab.trailing } : {}),
      }))}
      {...(className ? { className } : {})}
    />
  );
}

/** Pin, copy link, and open on GitHub: the quiet icon actions at the top bar's right. */
export function GitHubItemPageIconActions({
  url,
  itemLabel,
  pin,
  openLabel,
}: {
  url: string;
  /** "pull request #12", for the pin control's accessible name. */
  itemLabel: string;
  pin: { pinned: boolean; onToggle: () => void } | undefined;
  /** The external open's name; "Open on GitHub" by default. */
  openLabel?: string;
}) {
  const { t, format } = useTranslation();
  const open = openLabel ?? t("codeReview.openOnGitHub");
  const pinLabel = pin
    ? format(pin.pinned ? "codeReview.pin.unpin" : "codeReview.pin.pin", { target: itemLabel })
    : "";
  return (
    <>
      {pin ? (
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={pinLabel}
          tooltip={pinLabel}
          tooltipSide="bottom"
          aria-pressed={pin.pinned}
          onClick={pin.onToggle}
        >
          <PinStatusIcon pinned={pin.pinned} className="size-4" aria-hidden />
        </IconButton>
      ) : null}
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={t("codeReview.copyLink")}
        tooltip={t("codeReview.copyLink")}
        tooltipSide="bottom"
        onClick={() => copyPullRequestLink(url, t)}
      >
        <LinkIcon className="size-4" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-sm"
        label={open}
        tooltip={open}
        tooltipSide="bottom"
        onClick={() => void ensureNativeApi().shell.openExternal(url)}
      >
        <ExternalLinkIcon className="size-4" />
      </IconButton>
    </>
  );
}

/**
 * The whole detail page: the top bar, then the query's loading, unavailable, and not found
 * states, or the loaded tab body under any banners.
 */
export function GitHubItemDetailPage({
  onBack,
  tabs,
  actions,
  query,
  notFound,
  banners,
  children,
  overlay,
}: {
  /** Narrow windows show the detail in place of the list; this returns to it. */
  onBack?: (() => void) | undefined;
  tabs: ReactNode;
  actions: ReactNode;
  query: {
    isPending: boolean;
    /** The first load's failure; later refresh failures are banners. */
    initialError: unknown;
    /** What could not be loaded, for the unavailable state ("Issues"). */
    subject?: string;
    /** External source name ("Linear", "Jira") so failures never blame GitHub. */
    sourceName?: string;
    onRetry: () => void;
    loaded: boolean;
  };
  notFound: { title: string; description: string };
  /** Warnings over the body (a failed background refresh). */
  banners?: ReactNode;
  children: ReactNode;
  /** Rendered after the body, outside the layout (confirm dialogs). */
  overlay?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col app-content-surface text-foreground">
      {/* The top bar is its own container so its controls can tighten once it is narrow (the
          side chat is open) and stay on one row; if even that is too narrow the actions wrap
          under the tabs, still right-aligned. */}
      <div className="@container/topbar shrink-0">
        <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 @max-[46rem]/topbar:px-2">
          <div className="flex shrink-0 items-center gap-0.5">
            {onBack ? <GitHubItemBackButton onBack={onBack} /> : null}
            {tabs}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 @max-[46rem]/topbar:gap-1">
            {actions}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {query.isPending ? (
          <PullRequestDetailSkeleton />
        ) : query.initialError ? (
          <PullRequestsUnavailableState
            error={query.initialError}
            {...(query.subject ? { subject: query.subject } : {})}
            {...(query.sourceName ? { sourceName: query.sourceName } : {})}
            onRetry={query.onRetry}
          />
        ) : !query.loaded ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{notFound.title}</EmptyTitle>
              <EmptyDescription>{notFound.description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {banners}
            {children}
          </>
        )}
      </div>
      {overlay}
    </div>
  );
}

/**
 * Docks the question composer at the bottom right of a tab body, in its own row under the
 * scrolling content, so no text ever sits under it (it used to float over the content and hid
 * the last lines of a long description).
 */
function DockedComposerSlot({ composer }: { composer: ReactNode }) {
  // On a glass window the slot is cut out of the page tint, so the composer takes the same
  // raised tint as the chat composer (see index.css).
  const glassOverlayRef = useInPageGlassOverlay<HTMLDivElement>(Boolean(composer));
  if (!composer) return null;
  return (
    <div
      ref={glassOverlayRef}
      data-glass-cutout=""
      data-github-item-composer-dock=""
      className="flex shrink-0 justify-end px-4 pt-2 pb-4"
    >
      <div className="w-full max-w-[40rem]">{composer}</div>
    </div>
  );
}

/** The Summary body: the header, the info (rows or column), and the item's own content. */
export function GitHubItemPageBody({
  header,
  info,
  children,
  composer,
}: {
  header: ReactNode;
  /** The info in either shape: rows under the header in a narrow pane, a column in a wide one. */
  info: (variant: GitHubItemInfoVariant) => ReactNode;
  children: ReactNode;
  composer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="@container/detail relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" data-github-item-scroll="">
        <div className="mx-auto flex w-full max-w-[76rem] items-start gap-12 px-6 pt-1 pb-8">
          <div className="min-w-0 flex-1">
            {header}
            <div className="mb-4 @min-[52rem]/detail:hidden">{info("rows")}</div>
            {children}
          </div>
          <aside
            aria-label={t("codeReview.details")}
            className="sticky top-1 hidden w-[22rem] shrink-0 @min-[52rem]/detail:block"
          >
            {info("column")}
          </aside>
        </div>
      </div>
      <DockedComposerSlot composer={composer} />
    </div>
  );
}

/** Any other tab (Changes, Timeline): a one-line title over the tab's own scrolling content. */
export function GitHubItemTabBody({
  glyph,
  title,
  composer,
  children,
}: {
  glyph: ReactNode;
  title: string;
  composer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-6 pb-2">
        {glyph}
        <h1 className="m-0 min-w-0 truncate text-ui-lg font-medium">{title}</h1>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <DockedComposerSlot composer={composer} />
    </div>
  );
}
