// FILE: GitHubIssueEditors.tsx
// Purpose: The controls that change a GitHub issue from its detail page: the top bar's close and
//          reopen control, the label and assignee pickers that open from their whole info row,
//          and the list of pull requests linked to the issue. A picker keeps its choices while
//          it is open and saves them once, on close, so quick toggles never race each other as
//          separate whole-set writes.
// Layer: GitHub inbox presentation
// Exports: GitHubIssueStateAction, GitHubIssueLabelPicker, GitHubIssueAssigneePicker,
//          GitHubIssueLinkedPullRequests, GitHubIssueEditHint, mergePickerNames,
//          GITHUB_ISSUE_ASSIGNEE_LIMIT
// Why: Adapted from T3 Code's issue detail panel (pingdotgg/t3code, MIT); see
//      THIRD_PARTY_NOTICES.md.

import type {
  GitHubIssueCandidates,
  GitHubIssueCandidatesInput,
  GitHubIssueCloseReason,
  GitHubIssueDetail,
  GitHubIssueLinkedPullRequest,
  PullRequestActor,
  PullRequestLabel,
} from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import {
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
  ChatHeaderSplitGroup,
} from "~/components/chat/chatHeaderControls";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { MENU_ICON_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { TOP_BAR_NARROW_LABEL_CLASS_NAME } from "~/components/pullRequest/GitHubItemAgentActions";
import { GitHubLabelDot } from "~/components/pullRequest/GitHubLabelChips";
import { PullRequestAvatar } from "~/components/pullRequest/PullRequestAvatar";
import { safeGitHubLabelColor } from "~/components/pullRequest/pullRequestList.logic";
import { PullRequestStateGlyph } from "~/components/pullRequest/PullRequestStateGlyph";
import { PR_FINE_TEXT_CLASS_NAME } from "~/components/pullRequest/pullRequestText";
import { Button } from "~/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "~/components/ui/combobox";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import {
  ChevronDownIcon,
  IssueClosedIcon,
  IssueNotPlannedIcon,
  IssueOpenedIcon,
  LoaderIcon,
} from "~/lib/icons";
import { githubIssueCandidatesQueryOptions } from "~/lib/githubInboxQueryOptions";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";

/** GitHub refuses an issue with more assignees than this. */
export const GITHUB_ISSUE_ASSIGNEE_LIMIT = 10;

export type GitHubIssueStateChange =
  | { readonly op: "close"; readonly reason: GitHubIssueCloseReason }
  | { readonly op: "reopen" };

/**
 * The top bar's state control. An open issue gets one split button: its label closes the issue as
 * completed, the common case, and its chevron offers closing it as not planned. A closed issue
 * gets Reopen.
 */
export function GitHubIssueStateAction({
  state,
  pending,
  onChange,
}: {
  state: GitHubIssueDetail["state"];
  pending: boolean;
  onChange: (change: GitHubIssueStateChange) => void;
}) {
  const { t } = useTranslation();
  const busyIcon = <LoaderIcon className="animate-spin" />;
  if (state === "closed") {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        title={t("githubIssue.state.reopen")}
        onClick={() => onChange({ op: "reopen" })}
      >
        {pending ? busyIcon : <IssueOpenedIcon />}
        <span className={TOP_BAR_NARROW_LABEL_CLASS_NAME}>{t("githubIssue.state.reopen")}</span>
      </Button>
    );
  }
  return (
    <Menu>
      <ChatHeaderSplitGroup label={t("githubIssue.state.closeGroup")}>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          title={t("githubIssue.state.closeCompleted")}
          className={CHAT_HEADER_SPLIT_LEADING_CLASS_NAME}
          onClick={() => onChange({ op: "close", reason: "completed" })}
        >
          {pending ? busyIcon : <IssueClosedIcon />}
          <span className={TOP_BAR_NARROW_LABEL_CLASS_NAME}>{t("githubIssue.state.close")}</span>
        </Button>
        <MenuTrigger
          disabled={pending}
          render={
            <Button
              variant="outline"
              size="sm"
              aria-label={t("githubIssue.state.closeOptions")}
              title={t("githubIssue.state.closeOptions")}
              className={cn(CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME, "border-s px-1.5")}
            />
          }
        >
          <ChevronDownIcon aria-hidden className="size-3" />
        </MenuTrigger>
      </ChatHeaderSplitGroup>
      <ComposerPickerMenuPopup align="end" side="bottom" className="w-52 min-w-52">
        <MenuItem onClick={() => onChange({ op: "close", reason: "completed" })}>
          <IssueClosedIcon className={MENU_ICON_CLASS_NAME} />
          <span>{t("githubIssue.state.closeCompleted")}</span>
        </MenuItem>
        <MenuItem onClick={() => onChange({ op: "close", reason: "not-planned" })}>
          <IssueNotPlannedIcon className={MENU_ICON_CLASS_NAME} />
          <span>{t("githubIssue.state.closeNotPlanned")}</span>
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function sameSelection(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const a = new Set(left.map((name) => name.toLowerCase()));
  const b = new Set(right.map((name) => name.toLowerCase()));
  return a.size === b.size && [...a].every((name) => b.has(name));
}

/**
 * Names the picker offers: the repository's, plus any the issue already carries that the first
 * page left out, so saving never drops a value the person did not touch.
 */
export function mergePickerNames(
  candidates: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
): string[] {
  const seen = new Set(candidates.map((name) => name.toLowerCase()));
  return [...candidates, ...current.filter((name) => !seen.has(name.toLowerCase()))];
}

/** The quiet chevron at the end of an editable info row's label: the row opens a picker. */
export function GitHubIssueEditHint() {
  return <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />;
}

/** A picker's choices as its source loaded them. */
export interface IssuePickerCandidates<T> {
  readonly data: T | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  /** The source has more than it listed. */
  readonly truncated: boolean;
}

/** A picker's input from its source's query result. */
export function issuePickerCandidates<T>(
  query: { data: T | undefined; isPending: boolean; isError: boolean },
  truncated: (data: T) => boolean = () => false,
): IssuePickerCandidates<T> {
  return {
    data: query.data,
    isPending: query.isPending,
    isError: query.isError,
    truncated: query.data ? truncated(query.data) : false,
  };
}

/**
 * A searchable list of an issue's labels or people, opened from its whole info row. Shared by
 * every issue source (GitHub, Linear, Jira); each passes where its choices come from.
 */
export function IssueValuePicker<T>({
  label,
  filterPlaceholder,
  source,
  current,
  namesFrom,
  renderItem,
  textOf,
  limit,
  limitNote,
  single,
  disabled,
  onSave,
  children,
}: {
  label: string;
  filterPlaceholder: string;
  source: {
    open: boolean;
    setOpen: (open: boolean) => void;
    candidates: IssuePickerCandidates<T>;
  };
  current: ReadonlyArray<string>;
  namesFrom: (candidates: T) => ReadonlyArray<string>;
  renderItem: (name: string, candidates: T | undefined) => ReactNode;
  /** The text the search matches when a value is an opaque id (a Jira account); the value otherwise. */
  textOf?: (name: string, candidates: T | undefined) => string;
  limit?: number;
  limitNote?: string;
  /** One value at most: choosing another replaces it (Linear's single assignee). */
  single?: boolean;
  disabled: boolean;
  /** The chosen names, with the candidates they were picked from (absent if never loaded). */
  onSave: (names: string[], candidates: T | undefined) => void;
  /** The info row the picker opens from: the whole row is the control. */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { open, setOpen } = source;
  const [draft, setDraft] = useState<string[]>([...current]);
  const [filter, setFilter] = useState("");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const candidatesQuery = source.candidates;
  const candidates = candidatesQuery.data;
  const names = mergePickerNames(candidates ? namesFrom(candidates) : [], current);
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredNames = normalizedFilter
    ? names.filter((name) =>
        (textOf ? textOf(name, candidates) : name).toLowerCase().includes(normalizedFilter),
      )
    : names;
  const atLimit = limit !== undefined && draft.length >= limit;
  const selected = new Set(draft.map((name) => name.toLowerCase()));

  const status = candidatesQuery.isPending
    ? t("githubIssue.picker.loading")
    : candidatesQuery.isError
      ? t("githubIssue.picker.loadFailed")
      : null;

  return (
    <Combobox
      multiple
      items={names}
      filteredItems={filteredNames}
      value={draft}
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft([...current]);
          setFilter("");
        } else if (!sameSelection(draft, current)) {
          onSave(draft, candidates);
        }
        setOpen(next);
      }}
      onValueChange={(next: string[]) =>
        setDraft(single ? next.slice(-1) : limit === undefined ? next : next.slice(0, limit))
      }
    >
      <ComboboxTrigger
        ref={setAnchor}
        disabled={disabled}
        aria-label={label}
        render={
          <div
            className={cn(
              "-mx-2 block cursor-pointer rounded-row px-2 py-1 text-left transition-colors",
              "hover:bg-[var(--color-background-button-secondary-hover)]",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "data-[popup-open]:bg-[var(--color-background-button-secondary-hover)]",
              "aria-disabled:cursor-default aria-disabled:hover:bg-transparent",
            )}
          />
        }
      >
        {children}
      </ComboboxTrigger>
      <ComboboxPopup align="end" anchor={anchor} className="w-72">
        <div className="border-b border-border px-1 py-0.5">
          <ComboboxInput
            size="sm"
            unstyled
            showTrigger={false}
            placeholder={filterPlaceholder}
            aria-label={filterPlaceholder}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {status ? (
          <ComboboxStatus className="px-3 py-2 text-ui-sm text-muted-foreground empty:hidden">
            {status}
          </ComboboxStatus>
        ) : (
          <ComboboxEmpty className="px-3 py-2 text-ui-sm text-muted-foreground empty:hidden">
            {t("githubIssue.picker.empty")}
          </ComboboxEmpty>
        )}
        <ComboboxList className="overflow-y-auto p-1">
          {filteredNames.map((name, index) => (
            <ComboboxItem
              key={name}
              value={name}
              index={index}
              disabled={atLimit && !selected.has(name.toLowerCase())}
              className="min-h-control-sm"
            >
              {renderItem(name, candidates)}
            </ComboboxItem>
          ))}
        </ComboboxList>
        {candidatesQuery.truncated || (atLimit && limitNote) ? (
          <p className="m-0 border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
            {atLimit && limitNote ? limitNote : t("githubIssue.picker.truncated")}
          </p>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}

export function GitHubIssueLabelPicker({
  candidatesInput,
  labels,
  disabled,
  onSave,
  children,
}: {
  candidatesInput: GitHubIssueCandidatesInput;
  labels: ReadonlyArray<PullRequestLabel>;
  disabled: boolean;
  onSave: (labels: PullRequestLabel[]) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery(githubIssueCandidatesQueryOptions(candidatesInput, { enabled: open }));
  const source = {
    open,
    setOpen,
    candidates: issuePickerCandidates(query, (data) => data.truncated),
  };
  const labelFor = (name: string, candidates: GitHubIssueCandidates | undefined) => {
    const key = name.toLowerCase();
    return (
      candidates?.labels.find((label) => label.name.toLowerCase() === key) ??
      labels.find((label) => label.name.toLowerCase() === key) ?? {
        name,
        color: null,
        description: null,
      }
    );
  };
  return (
    <IssueValuePicker<GitHubIssueCandidates>
      label={t("githubIssue.edit.labels")}
      filterPlaceholder={t("githubIssue.picker.filterLabels")}
      source={source}
      current={labels.map((label) => label.name)}
      namesFrom={(candidates) => candidates.labels.map((label) => label.name)}
      disabled={disabled}
      renderItem={(name, candidates) => {
        const label = labelFor(name, candidates);
        const description = "description" in label ? label.description : null;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <GitHubLabelDot color={safeGitHubLabelColor(label.color)} className="size-2" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{label.name}</span>
              {description ? (
                <span className={cn(PR_FINE_TEXT_CLASS_NAME, "truncate text-muted-foreground")}>
                  {description}
                </span>
              ) : null}
            </span>
          </span>
        );
      }}
      onSave={(names, candidates) =>
        onSave(
          names.map((name) => {
            const label = labelFor(name, candidates);
            return { name: label.name, color: label.color };
          }),
        )
      }
    >
      {children}
    </IssueValuePicker>
  );
}

export function GitHubIssueAssigneePicker({
  candidatesInput,
  assignees,
  disabled,
  onSave,
  children,
}: {
  candidatesInput: GitHubIssueCandidatesInput;
  assignees: ReadonlyArray<PullRequestActor>;
  disabled: boolean;
  onSave: (assignees: PullRequestActor[]) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery(githubIssueCandidatesQueryOptions(candidatesInput, { enabled: open }));
  const source = {
    open,
    setOpen,
    candidates: issuePickerCandidates(query, (data) => data.truncated),
  };
  const actorFor = (login: string, candidates: GitHubIssueCandidates | undefined) => {
    const key = login.toLowerCase();
    return (
      candidates?.assignees.find((actor) => actor.login.toLowerCase() === key) ??
      assignees.find((actor) => actor.login.toLowerCase() === key) ?? {
        login,
        name: null,
        avatarUrl: null,
        url: null,
      }
    );
  };
  return (
    <IssueValuePicker<GitHubIssueCandidates>
      label={t("githubIssue.edit.assignees")}
      filterPlaceholder={t("githubIssue.picker.filterPeople")}
      source={source}
      current={assignees.map((actor) => actor.login)}
      namesFrom={(candidates) => candidates.assignees.map((actor) => actor.login)}
      limit={GITHUB_ISSUE_ASSIGNEE_LIMIT}
      limitNote={t("githubIssue.picker.assigneeLimit")}
      disabled={disabled}
      renderItem={(login, candidates) => {
        const actor = actorFor(login, candidates);
        return (
          <span className="flex min-w-0 items-center gap-2">
            <PullRequestAvatar actor={actor} />
            <span className="truncate">{actor.name ?? actor.login}</span>
            {actor.name ? (
              <span className={cn(PR_FINE_TEXT_CLASS_NAME, "truncate text-muted-foreground")}>
                {actor.login}
              </span>
            ) : null}
          </span>
        );
      }}
      onSave={(logins, candidates) => onSave(logins.map((login) => actorFor(login, candidates)))}
    >
      {children}
    </IssueValuePicker>
  );
}

/**
 * Pull requests linked to the issue. One in the issue's own repository opens in the code review
 * page; one elsewhere opens on GitHub, since its repository may not be in any project.
 */
export function GitHubIssueLinkedPullRequests({
  repository,
  pullRequests,
  onSelectPullRequest,
}: {
  repository: string;
  pullRequests: ReadonlyArray<GitHubIssueLinkedPullRequest>;
  onSelectPullRequest?: ((number: number) => void) | undefined;
}) {
  const { t } = useTranslation();
  if (pullRequests.length === 0) {
    return <span className="text-muted-foreground">{t("githubIssue.linked.none")}</span>;
  }
  return (
    <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
      {pullRequests.map((pr) => {
        const local = pr.repository.toLowerCase() === repository.toLowerCase();
        const opensHere = local && onSelectPullRequest !== undefined;
        const reference = local ? `#${pr.number}` : `${pr.repository}#${pr.number}`;
        return (
          <li key={`${pr.repository}#${pr.number}`} className="min-w-0">
            <Button
              variant="ghost"
              className="-mx-2 h-auto w-[calc(100%+1rem)] min-w-0 items-start justify-start gap-2 rounded-row px-2 py-1 text-left font-normal whitespace-normal"
              title={opensHere ? pr.title : `${pr.title} · ${t("githubIssue.linked.openOnGitHub")}`}
              onClick={() =>
                opensHere
                  ? onSelectPullRequest(pr.number)
                  : void ensureNativeApi().shell.openExternal(pr.url)
              }
            >
              <PullRequestStateGlyph
                state={pr.state}
                isDraft={pr.isDraft}
                className="mt-0.5 size-4 shrink-0"
              />
              <span className="flex min-w-0 flex-col">
                <span className="line-clamp-2 break-words text-foreground">{pr.title}</span>
                <span className={cn(PR_FINE_TEXT_CLASS_NAME, "truncate text-muted-foreground")}>
                  {reference}
                  {pr.closesIssue ? ` · ${t("githubIssue.linked.closes")}` : ""}
                </span>
              </span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
