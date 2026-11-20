// FILE: ExternalIssueDetailPanel.tsx
// Purpose: A Linear or Jira issue on the code review page, in the same page shell, header, info
//          column, pickers and comments as a GitHub issue: the top bar's state menu lists the
//          states the issue can take (a Linear team's workflow, or the statuses Jira's
//          transitions lead to), the Assignee row picks one person, the Labels row any labels,
//          and comments post as the person's own account. Every change shows at once and goes
//          back if the source refuses, with one plain sentence.
// Layer: Issue sources presentation
// Exports: ExternalIssueDetailPanel

import type {
  ExternalIssueCandidates,
  ExternalIssueDetail,
  ExternalIssueSource,
  ExternalIssueState,
} from "@moss/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ConnectorIcon } from "~/components/ConnectorIcon";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  GitHubIssueEditHint,
  IssueValuePicker,
  issuePickerCandidates,
  type IssuePickerCandidates,
} from "~/components/githubInbox/GitHubIssueEditors";
import { TOP_BAR_NARROW_LABEL_CLASS_NAME } from "~/components/pullRequest/GitHubItemAgentActions";
import { GitHubLabelChips } from "~/components/pullRequest/GitHubLabelChips";
import { InfoSection } from "~/components/pullRequest/GitHubItemInfo";
import {
  GitHubItemDetailPage,
  GitHubItemPageBody,
  GitHubItemPageIconActions,
  GitHubItemTabs,
} from "~/components/pullRequest/GitHubItemPageLayout";
import { GitHubLabelDot } from "~/components/pullRequest/GitHubLabelChips";
import { PullRequestActorLabel } from "~/components/pullRequest/PullRequestActorLabel";
import { PullRequestAvatar } from "~/components/pullRequest/PullRequestAvatar";
import { safeGitHubLabelColor } from "~/components/pullRequest/pullRequestList.logic";
import { PullRequestMetaLine } from "~/components/pullRequest/PullRequestMetaLine";
import {
  GitHubItemComments,
  GitHubItemPageSummary,
} from "~/components/pullRequest/PullRequestSummaryTab";
import {
  PR_FINE_TEXT_CLASS_NAME,
  PR_META_TEXT_CLASS_NAME,
} from "~/components/pullRequest/pullRequestText";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import { Button } from "~/components/ui/button";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { ChatBubbleIcon, ChevronDownIcon, TagIcon, UsersIcon } from "~/lib/icons";
import {
  issueSourceCandidatesQueryOptions,
  issueSourceCommentMutationOptions,
  issueSourceDetailQueryOptions,
  issueSourceUpdateMutationOptions,
  type ExternalIssueUpdateVariables,
} from "~/lib/issueSourcesQueryOptions";
import { pullRequestQueryErrorState } from "~/lib/pullRequestReactQuery";
import { formatTimeAgo } from "~/lib/timeFormat";
import { cn } from "~/lib/utils";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";
import { useTranslation, type TranslationKey } from "~/localization";
import { ExternalIssueStateGlyph } from "./ExternalIssueRows";
import { ISSUE_SOURCE_PRESENTATION } from "./issueSources.logic";

const UPDATE_ERROR_KEYS: Record<
  ExternalIssueUpdateVariables["input"]["update"]["op"],
  TranslationKey
> = {
  setState: "issueSources.error.state",
  setLabels: "issueSources.error.labels",
  setAssignee: "issueSources.error.assignee",
};

/** The order a state menu lists the categories in, as Linear's own menu does. */
const STATE_ORDER: ReadonlyArray<ExternalIssueState["type"]> = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "unknown",
];

/** What the candidates query asks for: the issue's team or site, and the issue itself. */
interface CandidatesScope {
  readonly source: ExternalIssueSource;
  readonly teamId: string;
  readonly issueId: string;
}

/**
 * One picker's open state and the issue's choices, loaded when it opens. The info renders in two
 * shapes (column and rows), so each picker keeps its own state; the choices are one shared query.
 */
function WithCandidates({
  scope,
  children,
}: {
  scope: CandidatesScope;
  children: (source: {
    open: boolean;
    setOpen: (open: boolean) => void;
    candidates: IssuePickerCandidates<ExternalIssueCandidates>;
  }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery(issueSourceCandidatesQueryOptions(scope, { enabled: open }));
  return children({ open, setOpen, candidates: issuePickerCandidates(query) });
}

/** A person the issue names, found among the candidates or the issue itself. */
function actorFor(
  login: string,
  candidates: ExternalIssueCandidates | undefined,
  issue: ExternalIssueDetail,
) {
  return (
    candidates?.assignees.find((person) => person.login === login) ??
    (issue.assignee?.login === login ? issue.assignee : null) ?? {
      login,
      name: null,
      avatarUrl: null,
      url: null,
    }
  );
}

function ExternalIssueHeader({ issue }: { issue: ExternalIssueDetail }) {
  const { locale } = useTranslation();
  return (
    <header className="shrink-0 pb-4">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            PR_META_TEXT_CLASS_NAME,
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-muted-foreground",
          )}
        >
          <ExternalIssueStateGlyph state={issue.state} />
          <span>{issue.state?.name ?? "—"}</span>
        </span>
        <span
          className={cn(
            PR_META_TEXT_CLASS_NAME,
            "flex min-w-0 items-center gap-1.5 truncate text-muted-foreground",
          )}
        >
          <ConnectorIcon
            name={ISSUE_SOURCE_PRESENTATION[issue.source].iconName}
            className="size-3.5 shrink-0"
          />
          <span className="truncate">
            {issue.team?.name ? `${issue.team.name} ` : ""}
            {issue.identifier}
          </span>
        </span>
      </div>
      <h1 className={cn("mt-3 break-words", PAGE_TITLE_CLASS_NAME)} data-translation-skip="true">
        {issue.title}
      </h1>
      <PullRequestMetaLine
        className={cn(PR_META_TEXT_CLASS_NAME, "mt-3 flex-wrap text-muted-foreground")}
      >
        {issue.author ? (
          <PullRequestActorLabel actor={issue.author} className="font-medium text-foreground" />
        ) : null}
        {issue.createdAt ? (
          <span title={new Date(issue.createdAt).toLocaleString()}>
            {formatTimeAgo(issue.createdAt, { locale })}
          </span>
        ) : null}
      </PullRequestMetaLine>
    </header>
  );
}

/** The top bar's state menu: the states the issue can take, the current one checked. */
function ExternalIssueStateMenu({
  issue,
  candidates,
  isError,
  pending,
  onOpen,
  onChange,
}: {
  issue: ExternalIssueDetail;
  candidates: ExternalIssueCandidates | undefined;
  isError: boolean;
  pending: boolean;
  onOpen: () => void;
  onChange: (state: ExternalIssueState) => void;
}) {
  const { t } = useTranslation();
  // Jira offers only the statuses its transitions lead to; the current one stays listed, checked.
  const offered = candidates?.states ?? [];
  const withCurrent =
    issue.state && candidates && !offered.some((state) => state.name === issue.state?.name)
      ? [issue.state, ...offered]
      : offered;
  const states = withCurrent.toSorted(
    (left, right) => STATE_ORDER.indexOf(left.type) - STATE_ORDER.indexOf(right.type),
  );
  return (
    <Menu onOpenChange={(open) => (open ? onOpen() : undefined)}>
      <MenuTrigger
        disabled={pending}
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={t("issueSources.state.change")}
            title={t("issueSources.state.change")}
          />
        }
      >
        <ExternalIssueStateGlyph state={issue.state} />
        <span className={TOP_BAR_NARROW_LABEL_CLASS_NAME}>
          {issue.state?.name ?? t("issueSources.state.change")}
        </span>
        <ChevronDownIcon aria-hidden className="size-3" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="bottom" className="w-56 min-w-56">
        {states.length === 0 ? (
          <p className={cn(PR_FINE_TEXT_CLASS_NAME, "m-0 px-2 py-1.5 text-muted-foreground")}>
            {candidates
              ? t(
                  issue.source === "jira"
                    ? "issueSources.state.none.jira"
                    : "issueSources.state.none.linear",
                )
              : isError
                ? t("githubIssue.picker.loadFailed")
                : t("githubIssue.picker.loading")}
          </p>
        ) : (
          <MenuRadioGroup
            value={issue.state?.name ?? ""}
            onValueChange={(name) => {
              const next = states.find((state) => state.name === name);
              if (next && next.name !== issue.state?.name) onChange(next);
            }}
          >
            {states.map((state) => (
              <MenuRadioItem key={state.name} value={state.name}>
                <ExternalIssueStateGlyph state={state} />
                <span className="truncate">{state.name}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function ExternalIssueDetailPanel({
  source,
  issueId,
  onBack,
}: {
  source: ExternalIssueSource;
  issueId: string;
  /** Narrow windows show the detail in place of the list; this returns to it. */
  onBack?: () => void;
}) {
  const { t, format } = useTranslation();
  const queryClient = useQueryClient();
  const sourceName = ISSUE_SOURCE_PRESENTATION[source].name;
  const detailQuery = useQuery(issueSourceDetailQueryOptions(source, issueId));
  const updateMutation = useMutation(issueSourceUpdateMutationOptions(queryClient));
  const commentMutation = useMutation(issueSourceCommentMutationOptions(queryClient));
  const issue = detailQuery.data;
  const teamId = issue?.team?.id ?? null;
  const scope: CandidatesScope | null =
    issue && teamId ? { source, teamId, issueId: issue.id } : null;
  // The issue's states, labels and people load when a menu or picker first opens.
  const [candidatesWanted, setCandidatesWanted] = useState(false);
  const candidatesQuery = useQuery(
    issueSourceCandidatesQueryOptions(scope ?? { source, teamId: "", issueId }, {
      enabled: candidatesWanted && scope !== null,
    }),
  );
  const { initialError, backgroundError } = pullRequestQueryErrorState(detailQuery);
  const pending = updateMutation.isPending;

  const runUpdate = (
    current: ExternalIssueDetail,
    update: ExternalIssueUpdateVariables["input"]["update"],
    preview: ExternalIssueUpdateVariables["preview"],
  ) =>
    updateMutation.mutate(
      { input: { source, id: current.id, update }, preview },
      {
        onError: () =>
          toastManager.add({
            type: "error",
            title: format(UPDATE_ERROR_KEYS[update.op], { source: sourceName }),
          }),
      },
    );

  return (
    <GitHubItemDetailPage
      onBack={onBack}
      tabs={
        <GitHubItemTabs
          label={format("issueSources.tabs", { source: sourceName })}
          tabs={[{ value: "summary", label: t("codeReview.tab.summary") }]}
          value="summary"
          onChange={() => undefined}
        />
      }
      actions={
        issue ? (
          <>
            {issue.url ? (
              <GitHubItemPageIconActions
                url={issue.url}
                itemLabel={issue.identifier}
                pin={undefined}
                openLabel={format("issueSources.openIn", { source: sourceName })}
              />
            ) : null}
            {scope ? (
              <ExternalIssueStateMenu
                issue={issue}
                candidates={candidatesQuery.data}
                isError={candidatesQuery.isError && !candidatesQuery.isFetching}
                pending={pending}
                onOpen={() => {
                  if (!candidatesWanted) setCandidatesWanted(true);
                  else if (candidatesQuery.isError) void candidatesQuery.refetch();
                }}
                onChange={(state) =>
                  runUpdate(issue, { op: "setState", state: state.name }, { state })
                }
              />
            ) : null}
          </>
        ) : null
      }
      query={{
        isPending: detailQuery.isPending,
        initialError,
        subject: format("issueSources.subject", { source: sourceName }),
        sourceName,
        onRetry: () => void detailQuery.refetch(),
        loaded: issue !== undefined,
      }}
      notFound={{
        title: t("issueSources.notFound"),
        description: format("issueSources.notFoundHint", { source: sourceName }),
      }}
      banners={
        backgroundError ? (
          <PullRequestWarningNote shape="banner" role="status">
            {format("issueSources.refreshFailed", { source: sourceName })}
          </PullRequestWarningNote>
        ) : null
      }
    >
      {!issue ? null : (
        <GitHubItemPageBody
          header={<ExternalIssueHeader issue={issue} />}
          info={(variant) => {
            const assigneeRow = (
              <InfoSection
                variant={variant}
                label={t("issueSources.info.assignee")}
                icon={<UsersIcon className="size-4" />}
                action={scope ? <GitHubIssueEditHint /> : undefined}
              >
                {issue.assignee ? (
                  <PullRequestActorLabel actor={issue.assignee} className="max-w-full" />
                ) : (
                  <span className="text-muted-foreground">
                    {t(scope ? "issueSources.add.assignee" : "codeReview.info.unassigned")}
                  </span>
                )}
              </InfoSection>
            );
            const labelsRow = (
              <InfoSection
                variant={variant}
                label={t("codeReview.info.labels")}
                icon={<TagIcon className="size-4" />}
                action={scope ? <GitHubIssueEditHint /> : undefined}
              >
                {issue.labels.length === 0 ? (
                  <span className="text-muted-foreground">
                    {t(scope ? "githubIssue.add.labels" : "codeReview.info.none")}
                  </span>
                ) : (
                  <GitHubLabelChips labels={issue.labels} className="flex-wrap" />
                )}
              </InfoSection>
            );
            return (
              <div
                className={cn(variant === "column" ? "flex flex-col gap-7" : "flex flex-col")}
                data-info-variant={variant}
              >
                {scope ? (
                  <WithCandidates scope={scope}>
                    {(picker) => (
                      <IssueValuePicker<ExternalIssueCandidates>
                        label={t("issueSources.edit.assignee")}
                        filterPlaceholder={t("githubIssue.picker.filterPeople")}
                        source={picker}
                        current={issue.assignee ? [issue.assignee.login] : []}
                        namesFrom={(data) => data.assignees.map((actor) => actor.login)}
                        textOf={(login, data) => {
                          const actor = actorFor(login, data, issue);
                          return actor.name ? `${actor.name} ${actor.login}` : actor.login;
                        }}
                        single
                        disabled={pending}
                        renderItem={(login, data) => {
                          const actor = actorFor(login, data, issue);
                          return (
                            <span className="flex min-w-0 items-center gap-2">
                              <PullRequestAvatar actor={actor} />
                              {/* Jira knows a person by an opaque account id: show the name. */}
                              <span className="truncate">
                                {source === "jira" ? (actor.name ?? actor.login) : actor.login}
                              </span>
                            </span>
                          );
                        }}
                        onSave={(logins, data) => {
                          const login = logins[0] ?? null;
                          runUpdate(
                            issue,
                            { op: "setAssignee", assignee: login },
                            { assignee: login === null ? null : actorFor(login, data, issue) },
                          );
                        }}
                      >
                        {assigneeRow}
                      </IssueValuePicker>
                    )}
                  </WithCandidates>
                ) : (
                  assigneeRow
                )}
                {scope ? (
                  <WithCandidates scope={scope}>
                    {(picker) => (
                      <IssueValuePicker<ExternalIssueCandidates>
                        label={t("githubIssue.edit.labels")}
                        filterPlaceholder={t("githubIssue.picker.filterLabels")}
                        source={picker}
                        current={issue.labels.map((label) => label.name)}
                        namesFrom={(data) => data.labels.map((label) => label.name)}
                        disabled={pending}
                        renderItem={(name, data) => {
                          const label = data?.labels.find((candidate) => candidate.name === name);
                          return (
                            <span className="flex min-w-0 items-center gap-2">
                              <GitHubLabelDot
                                color={safeGitHubLabelColor(label?.color)}
                                className="size-2"
                              />
                              <span className="truncate">{name}</span>
                            </span>
                          );
                        }}
                        onSave={(names, data) =>
                          runUpdate(
                            issue,
                            { op: "setLabels", labels: names },
                            {
                              labels: names.map((name) => ({
                                name,
                                color:
                                  data?.labels.find((label) => label.name === name)?.color ??
                                  issue.labels.find((label) => label.name === name)?.color ??
                                  null,
                              })),
                            },
                          )
                        }
                      >
                        {labelsRow}
                      </IssueValuePicker>
                    )}
                  </WithCandidates>
                ) : (
                  labelsRow
                )}
                <InfoSection
                  variant={variant}
                  label={t("codeReview.info.comments")}
                  icon={<ChatBubbleIcon className="size-4" />}
                >
                  <span
                    className={issue.comments.length === 0 ? "text-muted-foreground" : undefined}
                  >
                    {issue.comments.length === 0
                      ? t("codeReview.info.noComments")
                      : format(
                          issue.comments.length === 1
                            ? "codeReview.info.commentsOne"
                            : "codeReview.info.commentsMany",
                          { count: issue.comments.length },
                        )}
                  </span>
                </InfoSection>
              </div>
            );
          }}
        >
          <GitHubItemPageSummary
            body={issue.description}
            workspaceRoot=""
            commentCount={issue.comments.length}
          >
            <GitHubItemComments
              comments={issue.comments}
              itemUrl={issue.url}
              workspaceRoot=""
              warning={null}
              mutation={{ isPending: commentMutation.isPending }}
              post={(body) => commentMutation.mutateAsync({ source, id: issue.id, body })}
              account={{
                icon: (
                  <ConnectorIcon
                    name={ISSUE_SOURCE_PRESENTATION[source].iconName}
                    className="size-3"
                  />
                ),
                label: format("issueSources.comment.asAccount", { source: sourceName }),
              }}
              replyTitle={format("issueSources.comment.replyIn", { source: sourceName })}
            />
          </GitHubItemPageSummary>
        </GitHubItemPageBody>
      )}
    </GitHubItemDetailPage>
  );
}
