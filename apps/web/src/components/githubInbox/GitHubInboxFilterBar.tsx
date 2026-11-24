// FILE: GitHubInboxFilterBar.tsx
// Purpose: The head of the code review list: the panel title with refresh and one Filter menu,
//          the search field, the kind tabs with a count each, and, only while something is
//          filtered, a row of removable chips naming each active filter. Controlled; the page
//          owns persistence and URL overrides.
// Layer: GitHub inbox presentation
// Exports: GitHubInboxFilterBar

import { StatusDot } from "~/components/ui/status-chip";
import { HitArea } from "~/components/ui/hit-area";
import type { GitHubInboxSort, ProjectId } from "@moss/contracts";
import type { ReactNode } from "react";

import type {
  GitHubInboxInvolvementFilter,
  GitHubInboxKindFilter,
  GitHubInboxStateFilter,
} from "~/appSettings";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { MENU_ICON_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import type { ProjectMenuPickerOption } from "~/components/ProjectMenuPicker";
import { GitHubLabelDot } from "~/components/pullRequest/GitHubLabelChips";
import { SidebarPanelTitle } from "~/components/SidebarPanelTitle";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { SearchInput } from "~/components/ui/search-input";
import { Tabs } from "~/components/ui/tabs";
import {
  EllipsisIcon,
  FilterIcon,
  FoldersIcon,
  GitMergedSimpleIcon,
  IssueClosedIcon,
  IssueOpenedIcon,
  RefreshCwIcon,
  SortIcon,
  TagIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation, type TranslationKey } from "~/localization";
import {
  isGitHubInboxLabelSelected,
  toggleGitHubInboxLabel,
  type GitHubInboxFilters,
  type GitHubInboxKindCounts,
  type GitHubInboxLabelOption,
} from "./githubInbox.logic";

const STATE_OPTIONS: ReadonlyArray<{
  value: GitHubInboxStateFilter;
  label: TranslationKey;
  icon: typeof IssueOpenedIcon;
}> = [
  { value: "open", label: "pullRequests.state.open", icon: IssueOpenedIcon },
  // Closed includes merged pull requests; Merged shows only those.
  { value: "closed", label: "pullRequests.state.closed", icon: IssueClosedIcon },
  { value: "merged", label: "pullRequests.state.merged", icon: GitMergedSimpleIcon },
];

const SORT_OPTIONS: ReadonlyArray<{ value: GitHubInboxSort; label: TranslationKey }> = [
  { value: "created", label: "codeReview.sort.created" },
  { value: "updated", label: "codeReview.sort.updated" },
];

const INVOLVEMENT_OPTIONS: ReadonlyArray<{
  value: GitHubInboxInvolvementFilter;
  label: TranslationKey;
}> = [
  { value: "everything", label: "codeReview.involvement.everything" },
  { value: "involved", label: "codeReview.involvement.involved" },
  { value: "reviewRequested", label: "codeReview.involvement.reviewRequested" },
  { value: "authored", label: "codeReview.involvement.authored" },
  { value: "assigned", label: "codeReview.involvement.assigned" },
];

const KIND_TABS: ReadonlyArray<{
  value: GitHubInboxKindFilter;
  label: TranslationKey;
  short: TranslationKey;
}> = [
  { value: "all", label: "codeReview.kind.all", short: "codeReview.kind.all" },
  {
    value: "pullRequest",
    label: "codeReview.kind.pullRequest",
    short: "codeReview.kind.pullRequestShort",
  },
  { value: "issue", label: "codeReview.kind.issue", short: "codeReview.kind.issue" },
];
/** Kind as the shared segmented control over the one list, each choice with its row count. */
function KindTabs({
  value,
  counts,
  onChange,
}: {
  value: GitHubInboxKindFilter;
  counts: GitHubInboxKindCounts | null;
  onChange: (kind: GitHubInboxKindFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <Tabs
      variant="segmented"
      ariaLabel={t("codeReview.kind.group")}
      selected={value}
      onSelect={onChange}
      tabs={KIND_TABS.map((tab) => {
        const count = counts?.[tab.value];
        return {
          id: tab.value,
          label: t(tab.short),
          ...(count === undefined
            ? { accessibleLabel: t(tab.label) }
            : { trailing: count, accessibleLabel: `${t(tab.label)}, ${count}` }),
        };
      })}
    />
  );
}

/** One active filter, named in full, with its own remove button. */
function ActiveFilterChip({
  label,
  icon,
  onRemove,
}: {
  label: string;
  icon?: ReactNode;
  onRemove: () => void;
}) {
  const { format } = useTranslation();
  return (
    <Badge variant="info" className="max-w-full min-w-0 rounded-full pr-0.5 pl-1.5 font-normal">
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <HitArea
        type="button"
        aria-label={format("codeReview.filter.remove", { label })}
        className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-info/16 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onRemove}
      >
        <XIcon aria-hidden className="size-2.5" />
      </HitArea>
    </Badge>
  );
}

export function GitHubInboxFilterBar({
  filters,
  sort,
  onSortChange,
  query,
  kindCounts,
  projectOptions,
  labelOptions,
  refreshing,
  refreshBlockedReason,
  onQueryChange,
  onKindChange,
  onStateChange,
  onInvolvementChange,
  onProjectIdsChange,
  onLabelsChange,
  onClearFilters,
  onRefresh,
  onPasteReference,
}: {
  filters: GitHubInboxFilters;
  sort: GitHubInboxSort;
  onSortChange: (sort: GitHubInboxSort) => void;
  query: string;
  /** Rows each kind would show under the other filters; null while the list loads. */
  kindCounts: GitHubInboxKindCounts | null;
  projectOptions: ReadonlyArray<ProjectMenuPickerOption>;
  labelOptions: ReadonlyArray<GitHubInboxLabelOption>;
  refreshing: boolean;
  /** Why refresh is unavailable right now, or null when it can run. */
  refreshBlockedReason: string | null;
  onQueryChange: (query: string) => void;
  onKindChange: (kind: GitHubInboxKindFilter) => void;
  onStateChange: (state: GitHubInboxStateFilter) => void;
  onInvolvementChange: (involvement: GitHubInboxInvolvementFilter) => void;
  onProjectIdsChange: (projectIds: ProjectId[]) => void;
  onLabelsChange: (labels: string[]) => void;
  onClearFilters: () => void;
  onRefresh: () => void;
  /** Opens the item a pasted link or #number names; false leaves the paste as search text. */
  onPasteReference: (text: string) => boolean;
}) {
  const { t, format } = useTranslation();
  const sortLabel = t(SORT_OPTIONS.find((option) => option.value === sort)!.label);
  const involvement =
    INVOLVEMENT_OPTIONS.find((option) => option.value === filters.involvement) ??
    INVOLVEMENT_OPTIONS[0]!;
  const toggleProject = (projectId: ProjectId) =>
    onProjectIdsChange(
      filters.projectIds.includes(projectId)
        ? filters.projectIds.filter((id) => id !== projectId)
        : [...filters.projectIds, projectId],
    );
  // What the Filter menu holds. The kind tabs and the search text show their own state, so they
  // do not light the Filter button or earn a chip.
  const menuFilterCount =
    (filters.state !== "open" ? 1 : 0) +
    (filters.involvement !== "everything" ? 1 : 0) +
    (filters.projectIds.length > 0 ? 1 : 0) +
    (filters.labels.length > 0 ? 1 : 0);
  const labelColor = (name: string) => labelOptions.find((option) => option.name === name)?.color;

  return (
    <div className="flex flex-col px-2 pt-2">
      <SidebarPanelTitle title={t("codeReview.title")} as="h1">
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={format("codeReview.sort.aria", { label: sortLabel })}
                title={format("codeReview.sort.aria", { label: sortLabel })}
              />
            }
          >
            <SortIcon className="size-4" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-44">
            <MenuGroup>
              <MenuGroupLabel>{t("codeReview.sort.heading")}</MenuGroupLabel>
              <MenuRadioGroup
                value={sort}
                onValueChange={(value) => onSortChange(value as GitHubInboxSort)}
              >
                {SORT_OPTIONS.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    {t(option.label)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={
                  menuFilterCount > 0
                    ? format("codeReview.filter.buttonActive", { count: menuFilterCount })
                    : t("codeReview.filter.button")
                }
                title={t("codeReview.filter.button")}
                className={cn("relative", menuFilterCount > 0 && "text-[var(--color-text-accent)]")}
              />
            }
          >
            <FilterIcon className="size-4" />
            {menuFilterCount > 0 ? (
              <StatusDot
                aria-hidden
                className="absolute top-0.5 right-0.5 bg-[var(--color-text-accent)]"
              />
            ) : null}
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-48">
            <MenuGroup>
              <MenuGroupLabel>{t("codeReview.filter.status")}</MenuGroupLabel>
              <MenuRadioGroup
                value={filters.state}
                onValueChange={(value) => onStateChange(value as GitHubInboxStateFilter)}
              >
                {STATE_OPTIONS.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    <option.icon aria-hidden className={MENU_ICON_CLASS_NAME} />
                    {t(option.label)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("codeReview.filter.involvement")}</MenuGroupLabel>
              <MenuRadioGroup
                value={filters.involvement}
                onValueChange={(value) =>
                  onInvolvementChange(value as GitHubInboxInvolvementFilter)
                }
              >
                {INVOLVEMENT_OPTIONS.map((option) => (
                  <MenuRadioItem key={option.value} value={option.value}>
                    {t(option.label)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>
                <FoldersIcon aria-hidden className={MENU_ICON_CLASS_NAME} />
                {t("codeReview.filter.projects")}
                {filters.projectIds.length > 0 ? (
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {filters.projectIds.length}
                  </span>
                ) : null}
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup className="max-h-80 min-w-48 overflow-y-auto">
                {projectOptions.length === 0 ? (
                  <MenuItem disabled>{t("codeReview.filter.noProjects")}</MenuItem>
                ) : (
                  projectOptions.map((option) => (
                    <MenuCheckboxItem
                      key={option.id}
                      checked={filters.projectIds.includes(option.id)}
                      onCheckedChange={() => toggleProject(option.id)}
                    >
                      <span className="min-w-0 truncate">{option.name}</span>
                    </MenuCheckboxItem>
                  ))
                )}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <TagIcon aria-hidden className={MENU_ICON_CLASS_NAME} />
                {t("codeReview.filter.labels")}
                {filters.labels.length > 0 ? (
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {filters.labels.length}
                  </span>
                ) : null}
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup className="max-h-80 min-w-52 overflow-y-auto">
                {labelOptions.length === 0 ? (
                  <MenuItem disabled>{t("codeReview.filter.noLabels")}</MenuItem>
                ) : (
                  labelOptions.map((option) => (
                    <MenuCheckboxItem
                      key={option.name}
                      checked={isGitHubInboxLabelSelected(filters.labels, option.name)}
                      onCheckedChange={() =>
                        onLabelsChange(toggleGitHubInboxLabel(filters.labels, option.name))
                      }
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <GitHubLabelDot color={option.color} className="size-2" />
                        <span className="min-w-0 truncate">{option.name}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                          {option.count}
                        </span>
                      </span>
                    </MenuCheckboxItem>
                  ))
                )}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
            {menuFilterCount > 0 ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={onClearFilters}>{t("codeReview.filter.clearAll")}</MenuItem>
              </>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("codeReview.more.aria")}
                title={t("codeReview.more.title")}
              />
            }
          >
            <EllipsisIcon className="size-4" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-44">
            <MenuItem
              disabled={refreshBlockedReason !== null}
              title={refreshBlockedReason ?? undefined}
              onClick={onRefresh}
            >
              <RefreshCwIcon
                aria-hidden
                className={cn(MENU_ICON_CLASS_NAME, refreshing && "animate-spin")}
              />
              {refreshing ? t("codeReview.refreshing") : t("codeReview.refresh")}
            </MenuItem>
            {menuFilterCount > 0 ? (
              <MenuItem onClick={onClearFilters}>{t("codeReview.filter.clearAll")}</MenuItem>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>
      </SidebarPanelTitle>
      <div className="flex flex-col gap-2.5 px-4 pt-1 pb-2">
        <SearchInput
          placeholder={t("codeReview.search.placeholder")}
          aria-label={t("codeReview.search.aria")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onPaste={(event) => {
            // A pasted link or #number that names one loaded item opens it instead of searching.
            if (onPasteReference(event.clipboardData.getData("text"))) event.preventDefault();
          }}
        />
        <KindTabs value={filters.kind} counts={kindCounts} onChange={onKindChange} />
        {menuFilterCount > 0 ? (
          <div
            className="flex flex-wrap items-center gap-1"
            aria-label={t("codeReview.filter.active")}
          >
            {filters.state !== "open" ? (
              <ActiveFilterChip
                label={t(
                  filters.state === "merged"
                    ? "pullRequests.state.merged"
                    : "pullRequests.state.closed",
                )}
                onRemove={() => onStateChange("open")}
              />
            ) : null}
            {filters.involvement !== "everything" ? (
              <ActiveFilterChip
                label={t(involvement.label)}
                onRemove={() => onInvolvementChange("everything")}
              />
            ) : null}
            {filters.projectIds.map((projectId) => (
              <ActiveFilterChip
                key={projectId}
                label={
                  projectOptions.find((option) => option.id === projectId)?.name ??
                  t("codeReview.filter.project")
                }
                onRemove={() => toggleProject(projectId)}
              />
            ))}
            {filters.labels.map((label) => (
              <ActiveFilterChip
                key={label}
                label={label}
                icon={<GitHubLabelDot color={labelColor(label)} className="size-2" />}
                onRemove={() => onLabelsChange(toggleGitHubInboxLabel(filters.labels, label))}
              />
            ))}
            <Button
              variant="ghost"
              size="xs"
              className="font-normal text-muted-foreground"
              onClick={onClearFilters}
            >
              {t("codeReview.filter.clear")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
