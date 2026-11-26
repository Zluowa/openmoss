// FILE: _chat.automations.index.tsx
// Purpose: Redesigned Scheduled Tasks (定时任务) landing page unifying Claude Desktop's
//          Yours | Templates + New task dropdown and ChatGPT Desktop's calm empty state,
//          built with shared Moss UI primitives and Central linear icons.
// Layer: Route view

import type { AutomationDefinition } from "@moss/contracts";
import {
  localizedTemplateText,
  SCHEDULED_PAGE_COPY,
  SCHEDULED_TASK_TEMPLATES,
  type ScheduledTaskTemplate,
} from "@moss/shared/scheduledTaskTemplates";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { HitArea } from "~/components/ui/hit-area";
import { IconButton } from "~/components/ui/icon-button";
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { PageHeader } from "~/components/ui/page-header";
import { SearchInput } from "~/components/ui/search-input";
import { Spinner } from "~/components/ui/spinner";
import { StatusDot } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { Tabs, type TabItem } from "~/components/ui/tabs";
import { TextAction } from "~/components/ui/text-action";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useHandleNewChat } from "~/hooks/useHandleNewChat";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { automationDisplayName } from "~/lib/automationDisplayName";
import type { AutomationCreateDraft } from "~/lib/automationForm";
import { automationLifecycleState, canPauseAutomation } from "~/lib/automationStatus";
import { CentralIcon } from "~/lib/central-icons";
import { AddPlusIcon, ChevronDownIcon, FilterIcon, SearchIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import {
  AutomationCreateDialog,
  automationRowSubtitle,
  hasUnreadResult,
  useAutomationListClock,
} from "./-automations.list";
import {
  automationListRowIcon,
  createDraftFromTemplate,
  useAutomations,
} from "./-automations.shared";

export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationsRouteView,
});

type ScheduledPageTab = "yours" | "templates";
type TaskFilterMode = "all" | "active" | "paused";

function ScheduledTemplateCard({
  template,
  isZh,
  onSelect,
}: {
  readonly template: ScheduledTaskTemplate;
  readonly isZh: boolean;
  readonly onSelect: (template: ScheduledTaskTemplate) => void;
}) {
  return (
    <Card className="transition-colors hover:bg-[var(--color-background-elevated-secondary)]">
      <HitArea
        onClick={() => onSelect(template)}
        className="flex h-full w-full items-start gap-3.5 p-4 text-left"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-foreground/5 text-foreground/80">
          <CentralIcon name={template.desktopIconName} className="size-4.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-ui font-medium text-foreground">
            {localizedTemplateText(template.title, isZh)}
          </span>
          <span className="mt-1 line-clamp-2 text-ui-sm leading-snug text-muted-foreground">
            {localizedTemplateText(template.summary, isZh)}
          </span>
          <span className="mt-2.5 flex items-center gap-1.5 text-ui-xs text-muted-foreground">
            <CentralIcon name="clock" className="size-3.5 shrink-0" />
            <span>{localizedTemplateText(template.scheduleMeta, isZh)}</span>
          </span>
        </span>
      </HitArea>
    </Card>
  );
}

function ScheduledTaskCard({
  definition,
  subtitle,
  hasUnread,
  iconName,
  iconClassName,
  onOpen,
  onToggleEnabled,
  onRunNow,
  onDelete,
  isZh,
}: {
  readonly definition: AutomationDefinition;
  readonly subtitle: string;
  readonly hasUnread: boolean;
  readonly iconName: string;
  readonly iconClassName: string;
  readonly onOpen: () => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onRunNow: () => void;
  readonly onDelete: () => void;
  readonly isZh: boolean;
}) {
  const { locale } = useTranslation();
  const lifecycle = automationLifecycleState(definition);
  const canPause = canPauseAutomation(definition);
  const statusLabel =
    lifecycle === "active"
      ? localizedTemplateText(SCHEDULED_PAGE_COPY.statusActive, isZh)
      : lifecycle === "paused"
        ? localizedTemplateText(SCHEDULED_PAGE_COPY.statusPaused, isZh)
        : lifecycle === "scheduled"
          ? localizedTemplateText(SCHEDULED_PAGE_COPY.statusScheduled, isZh)
          : localizedTemplateText(SCHEDULED_PAGE_COPY.statusDone, isZh);

  return (
    <Card className="transition-colors hover:bg-[var(--color-background-elevated-secondary)]">
      <div className="flex items-start gap-3.5 p-4">
        <HitArea
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
          aria-label={automationDisplayName(definition, locale)}
        >
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-foreground/5">
            <CentralIcon name={iconName} className={iconClassName} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "truncate text-ui font-medium",
                  definition.enabled ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {automationDisplayName(definition, locale)}
              </span>
              {hasUnread ? (
                <StatusDot
                  aria-label={isZh ? "有新结果" : "New result"}
                  className="bg-[var(--color-text-accent)]"
                />
              ) : null}
            </span>
            <span className="line-clamp-2 text-ui-sm leading-snug text-muted-foreground">
              {definition.prompt}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs tabular-nums text-muted-foreground">
              <span>{statusLabel}</span>
              <span aria-hidden="true">·</span>
              <span>{subtitle}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <CentralIcon name="imac" className="size-3" />
                <span>{localizedTemplateText(SCHEDULED_PAGE_COPY.onlyOnThisComputer, isZh)}</span>
              </span>
            </span>
          </span>
        </HitArea>

        <div className="flex shrink-0 items-center gap-1.5">
          {canPause ? (
            <Switch
              aria-label={automationDisplayName(definition, locale)}
              checked={definition.enabled}
              onCheckedChange={onToggleEnabled}
            />
          ) : null}
          <IconButton
            size="icon-sm"
            variant="ghost"
            label={localizedTemplateText(SCHEDULED_PAGE_COPY.runNow, isZh)}
            tooltip={localizedTemplateText(SCHEDULED_PAGE_COPY.runNow, isZh)}
            onClick={onRunNow}
          >
            <CentralIcon name="play" className="size-3.5" />
          </IconButton>
          <IconButton
            size="icon-sm"
            variant="ghost"
            label={localizedTemplateText(SCHEDULED_PAGE_COPY.deleteTask, isZh)}
            tooltip={localizedTemplateText(SCHEDULED_PAGE_COPY.deleteTask, isZh)}
            onClick={onDelete}
          >
            <CentralIcon name="trash-can-simple" className="size-3.5" />
          </IconButton>
        </div>
      </div>
    </Card>
  );
}

function AutomationsRouteView() {
  return <AutomationsPage />;
}

export function AutomationsPage() {
  const navigate = useNavigate();
  const { locale, t } = useTranslation();
  const isZh = locale === "zh-CN";
  const projects = useStore((state) => state.projects);
  const { handleNewChat } = useHandleNewChat();
  const { handleNewThread } = useHandleNewThread();

  const [activeTab, setActiveTab] = useState<ScheduledPageTab>("yours");
  const [filterMode, setFilterMode] = useState<TaskFilterMode>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDraft, setDialogDraft] = useState<AutomationCreateDraft | undefined>(undefined);

  const {
    data,
    isLoading,
    error,
    refetch,
    createMutation,
    updateMutation,
    deleteMutation,
    runNowMutation,
    runsByAutomationId,
  } = useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));
  const now = useAutomationListClock();

  const openManualCreate = (draft?: AutomationCreateDraft) => {
    setDialogDraft(draft);
    setDialogOpen(true);
  };

  const openFromTemplate = (template: ScheduledTaskTemplate) => {
    openManualCreate(createDraftFromTemplate(template, isZh));
  };

  const startGuidedChatCreation = async () => {
    const starter = localizedTemplateText(SCHEDULED_PAGE_COPY.guidedStarter, isZh);
    const result = await handleNewChat({ fresh: true });
    if (result.ok && result.threadId) {
      useComposerDraftStore.getState().setPrompt(result.threadId, starter);
      return;
    }
    const fallbackProject = projects[0];
    if (fallbackProject) {
      const threadId = await handleNewThread(fallbackProject.id, { fresh: true });
      if (threadId) {
        useComposerDraftStore.getState().setPrompt(threadId, starter);
        return;
      }
    }
    void navigate({ to: "/" });
  };

  const definitions = data.definitions;
  const filteredDefinitions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return definitions.filter((definition) => {
      if (filterMode === "active" && !definition.enabled) return false;
      if (filterMode === "paused" && definition.enabled) return false;
      if (!query) return true;
      const name = automationDisplayName(definition, locale).toLowerCase();
      return name.includes(query) || definition.prompt.toLowerCase().includes(query);
    });
  }, [definitions, filterMode, locale, searchQuery]);

  const emptyQuickStartTemplates = useMemo(
    () => SCHEDULED_TASK_TEMPLATES.filter((template) => template.featuredInEmpty).slice(0, 6),
    [],
  );

  const tabs: readonly TabItem<ScheduledPageTab>[] = [
    {
      id: "yours",
      label: localizedTemplateText(SCHEDULED_PAGE_COPY.tabYours, isZh),
      trailing: definitions.length > 0 ? definitions.length : undefined,
    },
    {
      id: "templates",
      label: localizedTemplateText(SCHEDULED_PAGE_COPY.tabTemplates, isZh),
    },
  ];

  const text = (entry: { readonly zh: string; readonly en: string }) =>
    localizedTemplateText(entry, isZh);

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <RouteSurfaceHeader divider={false}>
          <div className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
            <IconButton
              size="icon-sm"
              variant="ghost"
              label={t("automations.refresh")}
              tooltip={t("automations.refresh")}
              onClick={() => void refetch()}
            >
              <CentralIcon name="arrow-rotate-clockwise" className="size-4" />
            </IconButton>
          </div>
        </RouteSurfaceHeader>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col px-6 pt-4 pb-12">
            <PageHeader title={text(SCHEDULED_PAGE_COPY.title)} className="pb-ui-pad-sm" />

            <div className="flex flex-wrap items-center justify-between gap-3 pb-6">
              <Tabs
                ariaLabel={text(SCHEDULED_PAGE_COPY.title)}
                tabs={tabs}
                selected={activeTab}
                onSelect={setActiveTab}
              />

              <div className="flex items-center gap-1.5">
                {activeTab === "yours" && definitions.length > 0 ? (
                  <>
                    {searchOpen ? (
                      <div className="w-44 sm:w-52">
                        <SearchInput
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          placeholder={text(SCHEDULED_PAGE_COPY.searchPlaceholder)}
                          aria-label={text(SCHEDULED_PAGE_COPY.searchPlaceholder)}
                          autoFocus
                        />
                      </div>
                    ) : null}
                    <IconButton
                      size="icon-sm"
                      variant={searchOpen ? "secondary" : "ghost"}
                      label={text(SCHEDULED_PAGE_COPY.searchPlaceholder)}
                      tooltip={text(SCHEDULED_PAGE_COPY.searchPlaceholder)}
                      onClick={() => {
                        setSearchOpen((prev) => !prev);
                        if (searchOpen) setSearchQuery("");
                      }}
                    >
                      <SearchIcon className="size-4" />
                    </IconButton>
                    <Menu>
                      <MenuTrigger
                        render={
                          <IconButton
                            size="icon-sm"
                            variant={filterMode !== "all" ? "secondary" : "ghost"}
                            label={text(SCHEDULED_PAGE_COPY.filterAll)}
                            tooltip={text(SCHEDULED_PAGE_COPY.filterAll)}
                          >
                            <FilterIcon className="size-4" />
                          </IconButton>
                        }
                      />
                      <ComposerPickerMenuPopup align="end" className="w-36">
                        <MenuRadioGroup
                          value={filterMode}
                          onValueChange={(value) => setFilterMode(value as TaskFilterMode)}
                        >
                          <MenuRadioItem value="all">
                            {text(SCHEDULED_PAGE_COPY.filterAll)}
                          </MenuRadioItem>
                          <MenuRadioItem value="active">
                            {text(SCHEDULED_PAGE_COPY.filterActive)}
                          </MenuRadioItem>
                          <MenuRadioItem value="paused">
                            {text(SCHEDULED_PAGE_COPY.filterPaused)}
                          </MenuRadioItem>
                        </MenuRadioGroup>
                      </ComposerPickerMenuPopup>
                    </Menu>
                  </>
                ) : null}

                <Menu>
                  <MenuTrigger
                    render={
                      <Button variant="default" size="sm">
                        <AddPlusIcon className="size-4" />
                        <span>{text(SCHEDULED_PAGE_COPY.newTask)}</span>
                        <ChevronDownIcon className="size-3.5 opacity-80" />
                      </Button>
                    }
                  />
                  <ComposerPickerMenuPopup align="end" className="w-48">
                    <MenuItem onClick={() => void startGuidedChatCreation()}>
                      <CentralIcon name="bubble-2" className="size-4" />
                      {text(SCHEDULED_PAGE_COPY.createWithMoss)}
                    </MenuItem>
                    <MenuItem onClick={() => openManualCreate()}>
                      <CentralIcon name="settings-slider-hor" className="size-4" />
                      {text(SCHEDULED_PAGE_COPY.setUpManually)}
                    </MenuItem>
                  </ComposerPickerMenuPopup>
                </Menu>
              </div>
            </div>

            {activeTab === "templates" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SCHEDULED_TASK_TEMPLATES.map((template) => (
                  <ScheduledTemplateCard
                    key={template.id}
                    template={template}
                    isZh={isZh}
                    onSelect={openFromTemplate}
                  />
                ))}
              </div>
            ) : isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Spinner />
              </div>
            ) : error && definitions.length === 0 ? (
              <Alert variant="error">
                <AlertDescription className="flex items-center justify-between gap-3">
                  <span>{isZh ? "无法加载定时任务。" : "Could not load automations."}</span>
                  <Button variant="outline" size="sm" onClick={() => void refetch()}>
                    {isZh ? "重试" : "Retry"}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : definitions.length === 0 ? (
              <div className="flex flex-col items-center pt-6 text-center">
                <CentralIcon name="calendar-check" className="mb-3 size-8 text-muted-foreground" />
                <h2 className="text-ui-lg font-medium text-foreground">
                  {text(SCHEDULED_PAGE_COPY.emptyTitle)}
                </h2>
                <p className="mt-1 max-w-md text-ui text-muted-foreground">
                  {text(SCHEDULED_PAGE_COPY.emptyDescription)}
                </p>

                <div className="mt-7 grid w-full max-w-2xl grid-cols-1 gap-3 text-left sm:grid-cols-2">
                  {emptyQuickStartTemplates.map((template) => (
                    <ScheduledTemplateCard
                      key={template.id}
                      template={template}
                      isZh={isZh}
                      onSelect={openFromTemplate}
                    />
                  ))}
                </div>

                <TextAction size="sm" className="mt-5" onClick={() => setActiveTab("templates")}>
                  {text(SCHEDULED_PAGE_COPY.browseTemplates)}
                </TextAction>
                <p className="mt-8 text-ui-xs text-muted-foreground">
                  {text(SCHEDULED_PAGE_COPY.localHint)}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {filteredDefinitions.length === 0 ? (
                  <p className="py-12 text-center text-ui text-muted-foreground">
                    {text(SCHEDULED_PAGE_COPY.noSearchResults)}
                  </p>
                ) : (
                  filteredDefinitions.map((definition) => {
                    const latestRun = runsByAutomationId.get(definition.id)?.[0] ?? null;
                    const icon = automationListRowIcon(definition, latestRun);
                    return (
                      <ScheduledTaskCard
                        key={definition.id}
                        definition={definition}
                        subtitle={automationRowSubtitle(definition, latestRun, now, t)}
                        hasUnread={hasUnreadResult(latestRun)}
                        iconName={icon.name}
                        iconClassName={icon.className}
                        isZh={isZh}
                        onOpen={() =>
                          void navigate({
                            to: "/automations/$automationId",
                            params: { automationId: definition.id },
                          })
                        }
                        onToggleEnabled={(enabled) =>
                          void updateMutation.mutate({ id: definition.id, enabled })
                        }
                        onRunNow={() => void runNowMutation.mutate(definition)}
                        onDelete={() => void deleteMutation.mutate(definition)}
                      />
                    );
                  })
                )}
                <p className="mt-4 text-ui-xs text-muted-foreground">
                  {text(SCHEDULED_PAGE_COPY.localHint)}
                </p>
              </div>
            )}
          </div>
        </main>
      </div>

      <AutomationCreateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        {...(dialogDraft !== undefined ? { initialDraft: dialogDraft } : {})}
        createAutomation={(input, onCreated, onError) => {
          void createMutation
            .mutateAsync(input)
            .then(onCreated, (cause: unknown) =>
              onError?.(
                cause instanceof Error
                  ? cause
                  : new Error("Could not confirm automation creation."),
              ),
            );
        }}
        busy={createMutation.isPending}
      />
    </RouteInsetSurface>
  );
}
