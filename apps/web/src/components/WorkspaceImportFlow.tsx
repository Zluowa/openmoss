// FILE: WorkspaceImportFlow.tsx
// Purpose: Codex-style external-agent import surface for Moss.
// Layer: Web UI component

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  SupportedProviderKind,
  WorkspaceImportApplyResult,
  WorkspaceImportCategoryKind,
  WorkspaceImportHistoryEntry,
  WorkspaceImportResourceCopy,
  WorkspaceImportSourceKind,
  WorkspaceImportSourcePreview,
  WorkspaceImportSyncPreferences,
} from "@synara/contracts";
import { WORKSPACE_IMPORT_DEFAULT_CATEGORIES } from "@synara/contracts";

import { useAppSettings } from "../appSettings";
import { useTheme } from "../hooks/useTheme";
import { useTranslation } from "../localization";
import { readNativeApi } from "../nativeApi";
import {
  CircleCheckIcon,
  CodeIcon,
  FolderIcon,
  FoldersIcon,
  InfoIcon,
  MessageCircleIcon,
  PluginIcon,
  SettingsIcon,
  SkillCubeIcon,
  BotIcon,
  LoaderCircleIcon,
} from "../lib/icons";
import { cn } from "../lib/utils";
import { ProviderIcon } from "./ProviderIcon";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";
import { toastManager } from "./ui/toast";
import { SettingsCard, SettingsSectionShell } from "./settings/SettingsPanelPrimitives";
import {
  emptyWorkspaceImportCategoryCounts,
  presentWorkspaceImportSources,
  reduceWorkspaceImportError,
  reduceWorkspaceImportProbe,
  workspaceImportCategoryCounts,
  workspaceImportDefaultCategories,
  workspaceImportSourceLabel,
  workspaceImportToolsSelectionState,
  toggleWorkspaceImportCategory,
  toggleWorkspaceImportTools,
  WORKSPACE_IMPORT_TOOLS_CATEGORIES,
  type WorkspaceImportUiState,
  INITIAL_WORKSPACE_IMPORT_UI_STATE,
} from "../workspaceImportUi";

const SOURCE_PROVIDER: Record<WorkspaceImportSourceKind, SupportedProviderKind> = {
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
  cursor: "cursor",
  codex: "codex",
  grok: "grok",
  opencode: "opencode",
};

const TOOL_CATEGORY_ICONS: Record<WorkspaceImportCategoryKind, typeof SettingsIcon> = {
  settings: SettingsIcon,
  skills: SkillCubeIcon,
  agents: BotIcon,
  commands: CodeIcon,
  hooks: PluginIcon,
  mcp: PluginIcon,
  plugins: PluginIcon,
  memory: FoldersIcon,
  projects: FolderIcon,
  chats: MessageCircleIcon,
};

function categoryLabel(
  category: WorkspaceImportCategoryKind,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const labels: Record<WorkspaceImportCategoryKind, string> = {
    settings: t("import.modal.settings"),
    skills: t("import.modal.skills"),
    agents: t("import.modal.agents"),
    commands: t("import.modal.commands"),
    hooks: t("import.modal.hooks"),
    mcp: t("import.modal.mcp"),
    plugins: t("import.modal.plugins"),
    memory: t("import.modal.memory"),
    projects: t("import.modal.projects").replace("{count}", "0"),
    chats: t("import.modal.chats").replace("{count}", "0"),
  };
  return labels[category];
}

function providerForSource(source: WorkspaceImportSourceKind): SupportedProviderKind {
  return SOURCE_PROVIDER[source] ?? "codex";
}

function sourceSummary(
  preview: WorkspaceImportSourcePreview,
  format: ReturnType<typeof useTranslation>["format"],
): string {
  const counts = workspaceImportCategoryCounts(preview);
  return format("import.source.summary", {
    skills: counts.skills,
    settings: counts.settings,
    chats: counts.chats,
  });
}

function formatHistoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

export function WorkspaceImportFlow({
  onCancel,
  variant,
}: {
  onCancel?: () => void;
  variant: "dialog" | "panel";
}) {
  const { t, format } = useTranslation();
  const { setTheme } = useTheme();
  const { updateSettings } = useAppSettings();
  const [state, setState] = useState<WorkspaceImportUiState>(INITIAL_WORKSPACE_IMPORT_UI_STATE);
  const [activeSource, setActiveSource] = useState<WorkspaceImportSourcePreview | null>(null);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [selection, setSelection] = useState<Set<WorkspaceImportCategoryKind>>(new Set());
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncCategories, setSyncCategories] = useState<WorkspaceImportCategoryKind[]>([
    ...WORKSPACE_IMPORT_DEFAULT_CATEGORIES,
  ]);
  const [syncSources, setSyncSources] = useState<WorkspaceImportSourceKind[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncRequestRef = useRef(0);
  const syncTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const syncStateRef = useRef<{
    enabled: boolean;
    categories: WorkspaceImportCategoryKind[];
    sources: WorkspaceImportSourceKind[];
  }>({
    enabled: false,
    categories: [...WORKSPACE_IMPORT_DEFAULT_CATEGORIES],
    sources: [],
  });
  const importOperationRef = useRef(0);
  const [history, setHistory] = useState<WorkspaceImportHistoryEntry[]>([]);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const api = readNativeApi();
    if (!api) {
      setState(reduceWorkspaceImportError(t("import.error.unavailable")));
      return () => {
        cancelled = true;
      };
    }
    void api.server
      .probeWorkspaceImport()
      .then((probe) => {
        if (cancelled) return;
        setState(reduceWorkspaceImportProbe(probe));
        setHistory(probe.history ? probe.history.toReversed() : []);
        if (probe.sync) {
          syncStateRef.current = {
            enabled: probe.sync.enabled,
            categories: [...probe.sync.categories],
            sources: [...probe.sync.sources],
          };
          setSyncEnabled(probe.sync.enabled);
          setSyncCategories([...probe.sync.categories]);
          setSyncSources([...probe.sync.sources]);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState(
            reduceWorkspaceImportError(
              error instanceof Error ? error.message : t("import.error.probe"),
            ),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const present = useMemo(
    () => (state.probe ? presentWorkspaceImportSources(state.probe) : []),
    [state.probe],
  );

  const persistSyncPreferences = async (
    enabled: boolean,
    categories: readonly WorkspaceImportCategoryKind[],
    sources: readonly WorkspaceImportSourceKind[] = syncStateRef.current.sources,
  ): Promise<boolean> => {
    const api = readNativeApi();
    if (!api) return false;
    const requestId = syncRequestRef.current + 1;
    syncRequestRef.current = requestId;
    const previous = {
      enabled: syncStateRef.current.enabled,
      categories: [...syncStateRef.current.categories],
      sources: [...syncStateRef.current.sources],
    };
    const optimistic = {
      enabled,
      categories: [...categories],
      sources: [...sources],
    };
    syncStateRef.current = optimistic;
    setSyncError(null);
    setSyncEnabled(enabled);
    setSyncCategories([...categories]);
    setSyncSources([...sources]);
    const request = syncTailRef.current.then(() =>
      api.server.syncWorkspaceImport({
        enabled,
        categories: [...categories],
        sources: [...sources],
      }),
    );
    // A rejected request must not poison the queue for a later toggle.
    syncTailRef.current = request.catch(() => undefined);
    try {
      const next = await request;
      if (syncRequestRef.current !== requestId) return true;
      syncStateRef.current = {
        enabled: next.enabled,
        categories: [...next.categories],
        sources: [...next.sources],
      };
      setSyncEnabled(next.enabled);
      setSyncCategories([...next.categories]);
      setSyncSources([...next.sources]);
      return true;
    } catch {
      if (syncRequestRef.current !== requestId) return false;
      syncStateRef.current = previous;
      setSyncEnabled(previous.enabled);
      setSyncCategories([...previous.categories]);
      setSyncSources([...previous.sources]);
      setSyncError(t("import.sync.error"));
      return false;
    }
  };

  const openSelection = (source: WorkspaceImportSourcePreview) => {
    if (state.step === "importing") return;
    const defaults = workspaceImportDefaultCategories(source);
    const fallback = [
      ...WORKSPACE_IMPORT_DEFAULT_CATEGORIES,
      ...(workspaceImportCategoryCounts(source).projects > 0 ? ["projects" as const] : []),
      ...(workspaceImportCategoryCounts(source).chats > 0 ? ["chats" as const] : []),
    ];
    setActiveSource(source);
    setState((current) => ({
      ...current,
      step: current.probe ? "ready" : current.step,
      result: null,
      error: null,
    }));
    setSelection(new Set(defaults.length > 0 ? defaults : fallback));
    setToolsExpanded(false);
    setSelectionOpen(true);
  };

  const startImport = async () => {
    const api = readNativeApi();
    if (!api || !activeSource || selection.size === 0) return;
    const operationId = importOperationRef.current + 1;
    importOperationRef.current = operationId;
    const sourceSnapshot = activeSource;
    const categoriesSnapshot = [...selection];
    const keepInSyncSnapshot = syncStateRef.current.enabled;
    const syncSourcesSnapshot = [...syncStateRef.current.sources];
    setState((current) => ({ ...current, step: "importing", error: null }));
    try {
      const result = await api.server.applyWorkspaceImport({
        sources: [sourceSnapshot.source],
        categories: categoriesSnapshot,
        keepInSync: keepInSyncSnapshot,
      });
      if (importOperationRef.current !== operationId) return;
      if (result.clientPreferences.theme) setTheme(result.clientPreferences.theme);
      if (result.clientPreferences.locale)
        updateSettings({ localeOverride: result.clientPreferences.locale });
      setState((current) => ({ ...current, step: "success", result }));
      toastManager.add({
        type: result.historyEntry?.status === "failed" ? "error" : "success",
        title: t("import.modal.complete"),
        description: format("import.history.imported", {
          count: result.historyEntry?.importedCount ?? 0,
        }),
      });
      if (result.historyEntry)
        setHistory((current) => [result.historyEntry!, ...current].slice(0, 100));
      if (keepInSyncSnapshot) {
        const nextSources = [...new Set([...syncSourcesSnapshot, sourceSnapshot.source])];
        setSyncSources(nextSources);
        const categoriesForSync =
          syncStateRef.current.categories.length > 0
            ? syncStateRef.current.categories
            : categoriesSnapshot;
        await persistSyncPreferences(true, categoriesForSync, nextSources);
      }
    } catch (error) {
      if (importOperationRef.current !== operationId) return;
      setState((current) => ({
        ...current,
        step: "error",
        error: error instanceof Error ? error.message : t("import.error.apply"),
      }));
    }
  };

  const syncPreference: WorkspaceImportSyncPreferences | undefined = state.probe?.sync;
  const isBusy = state.step === "importing";
  const canCustomizeSync =
    syncEnabled || syncSources.length > 0 || Boolean(syncPreference?.enabled);
  const reviewItems = useMemo<WorkspaceImportResourceCopy[]>(() => {
    const seen = new Set<string>();
    return (
      state.result?.resources?.filter((resource) => {
        if (resource.reviewRequired !== true && resource.action !== "skipped") return false;
        const key = `${resource.source}:${resource.category}:${resource.name}:${resource.action}:${resource.reason ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }) ?? []
    );
  }, [state.result]);
  const attentionCount = useMemo(() => {
    const fromResult =
      state.result?.resources?.filter(
        (resource) => resource.reviewRequired === true || resource.action === "skipped",
      ).length ?? 0;
    const fromHistory = history.reduce((total, entry) => total + entry.warningCount, 0);
    return Math.max(fromResult, fromHistory);
  }, [history, state.result]);

  return (
    <div className={cn("space-y-8", variant === "dialog" && "px-5 pb-3 pt-1")}>
      {state.step === "loading" || state.step === "importing" ? (
        <div
          className="flex items-center gap-3 rounded-xl border border-border/70 bg-background/30 px-4 py-5 text-ui-lg text-muted-foreground"
          role="status"
        >
          <Spinner className="size-4" />
          <span>
            {state.step === "loading" ? t("import.loading.probe") : t("import.loading.apply")}
          </span>
        </div>
      ) : null}

      {state.step === "error" ? (
        <div
          className="rounded-xl border border-destructive/35 bg-destructive/5 px-4 py-4 text-ui-lg text-destructive"
          role="alert"
        >
          {state.error ?? t("import.error.apply")}
        </div>
      ) : null}

      {state.step === "empty" ? (
        <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center text-ui-lg text-muted-foreground">
          <FoldersIcon className="mx-auto mb-3 size-7 opacity-60" />
          <p>{t("import.empty")}</p>
        </div>
      ) : null}

      {present.length > 0 ? (
        <>
          <SettingsSectionShell title={t("import.autosync.title")}>
            <SettingsCard>
              <div className="flex items-center justify-between gap-4 px-4 py-4">
                <div className="min-w-0">
                  <div className="text-ui-lg font-medium text-foreground">
                    {t("import.autosync.label")}
                  </div>
                  <div className="mt-1 text-ui-sm text-muted-foreground">
                    {syncEnabled ? t("import.autosync.description") : t("import.autosync.paused")}
                  </div>
                </div>
                <Switch
                  aria-label={t("import.autosync.label")}
                  checked={syncEnabled}
                  disabled={isBusy}
                  onCheckedChange={(checked) => {
                    const enabled = Boolean(checked);
                    const sources =
                      syncStateRef.current.sources.length > 0
                        ? syncStateRef.current.sources
                        : present.map((source) => source.source);
                    void persistSyncPreferences(enabled, syncCategories, sources);
                  }}
                />
              </div>
              <div className="flex items-center justify-end border-t border-border/70 px-4 py-2.5">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={!canCustomizeSync || isBusy}
                  onClick={() => setCustomizeOpen(true)}
                >
                  {t("import.autosync.customize")}
                </Button>
              </div>
            </SettingsCard>
          </SettingsSectionShell>

          <SettingsSectionShell title={t("import.sources.title")}>
            <p className="px-2 pb-2 text-ui-sm text-muted-foreground">
              {t("import.sources.description")}
            </p>
            <SettingsCard>
              {present.map((source) => (
                <SourceRow
                  key={source.source}
                  source={source}
                  summary={sourceSummary(source, format)}
                  disabled={isBusy}
                  onImport={() => openSelection(source)}
                />
              ))}
            </SettingsCard>
          </SettingsSectionShell>

          {attentionCount > 0 ? (
            <SettingsSectionShell title={t("import.attention.title")}>
              <SettingsCard>
                <div className="flex items-center justify-between gap-3 px-4 py-4">
                  <div className="min-w-0">
                    <div className="text-ui-lg font-medium text-foreground">
                      {t("import.attention.title")}
                    </div>
                    <div className="mt-1 text-ui-sm text-muted-foreground">
                      {t("import.attention.description")}
                    </div>
                    <div className="mt-2 text-ui-sm text-amber-600 dark:text-amber-400">
                      {t("import.attention.safeCopy")}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setReviewOpen(true)}
                  >
                    {t("import.attention.review")}
                  </Button>
                </div>
              </SettingsCard>
            </SettingsSectionShell>
          ) : null}

          <SettingsSectionShell title={t("import.history.title")}>
            <SettingsCard>
              {history.length === 0 ? (
                <div className="px-4 py-5 text-ui-sm text-muted-foreground">
                  {t("import.history.empty")}
                </div>
              ) : (
                history.map((entry) => (
                  <HistoryRow
                    key={entry.id}
                    entry={entry}
                    expanded={expandedHistory.has(entry.id)}
                    onToggle={() =>
                      setExpandedHistory((current) => {
                        const next = new Set(current);
                        if (next.has(entry.id)) next.delete(entry.id);
                        else next.add(entry.id);
                        return next;
                      })
                    }
                  />
                ))
              )}
            </SettingsCard>
          </SettingsSectionShell>
        </>
      ) : null}

      {variant === "dialog" && onCancel ? (
        <div className="flex justify-end border-t border-border/70 pt-3">
          <Button type="button" variant="ghost" disabled={isBusy} onClick={onCancel}>
            {state.step === "success" ? t("import.done") : t("import.cancel")}
          </Button>
        </div>
      ) : null}

      <ImportSelectionDialog
        open={selectionOpen}
        source={activeSource}
        selection={selection}
        toolsExpanded={toolsExpanded}
        step={state.step}
        result={state.result}
        error={state.error}
        onOpenChange={(open) => {
          if (!isBusy) setSelectionOpen(open);
        }}
        onToggleTools={() =>
          setSelection((current) =>
            toggleWorkspaceImportTools(current, availableCategories(activeSource)),
          )
        }
        onToggleToolsExpanded={() => setToolsExpanded((current) => !current)}
        onToggleCategory={(category) =>
          setSelection((current) => toggleWorkspaceImportCategory(current, category))
        }
        onImport={() => void startImport()}
        disabled={isBusy}
      />

      <SyncCustomizeDialog
        open={customizeOpen}
        categories={syncCategories}
        onOpenChange={setCustomizeOpen}
        onSave={async (next) => {
          const sources =
            syncStateRef.current.sources.length > 0
              ? syncStateRef.current.sources
              : present.map((source) => source.source);
          if (await persistSyncPreferences(syncEnabled, next, sources)) setCustomizeOpen(false);
        }}
      />

      <ImportReviewDialog
        open={reviewOpen}
        items={reviewItems}
        hasHistoricalWarnings={history.some((entry) => entry.warningCount > 0)}
        onOpenChange={setReviewOpen}
      />

      {syncError ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {syncError}
        </p>
      ) : null}
    </div>
  );
}

function availableCategories(
  source: WorkspaceImportSourcePreview | null,
): Set<WorkspaceImportCategoryKind> {
  if (!source) return new Set();
  const counts = workspaceImportCategoryCounts(source);
  const categories = (Object.keys(counts) as WorkspaceImportCategoryKind[]).filter(
    (category) => counts[category] > 0,
  );
  // Keep the familiar Codex rows visible even when an installation has an
  // empty optional category; disabled rows communicate what can be added.
  for (const category of ["settings", "skills", "agents"] as const) {
    if (!categories.includes(category)) categories.push(category);
  }
  return new Set(categories);
}

function SourceRow({
  source,
  summary,
  disabled,
  onImport,
}: {
  source: WorkspaceImportSourcePreview;
  summary: string;
  disabled?: boolean;
  onImport: () => void;
}) {
  const { t, format } = useTranslation();
  const provider = providerForSource(source.source);
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-foreground/5">
        <ProviderIcon provider={provider} className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
          <span className="truncate">
            {source.displayName ?? workspaceImportSourceLabel(source.source)}
          </span>
        </div>
        <div className="truncate text-ui-sm text-muted-foreground">{summary}</div>
        {source.detectedPath ? (
          <div className="truncate text-ui-xs text-muted-foreground/70">
            {format("import.source.path", { path: source.detectedPath })}
          </div>
        ) : null}
      </div>
      <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={onImport}>
        {t("import.start")}
      </Button>
    </div>
  );
}

function ImportSelectionDialog({
  open,
  source,
  selection,
  toolsExpanded,
  step,
  result,
  error,
  onOpenChange,
  onToggleTools,
  onToggleToolsExpanded,
  onToggleCategory,
  onImport,
  disabled = false,
}: {
  open: boolean;
  source: WorkspaceImportSourcePreview | null;
  selection: ReadonlySet<WorkspaceImportCategoryKind>;
  toolsExpanded: boolean;
  step: WorkspaceImportUiState["step"];
  result: WorkspaceImportApplyResult | null;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onToggleTools: () => void;
  onToggleToolsExpanded: () => void;
  onToggleCategory: (category: WorkspaceImportCategoryKind) => void;
  onImport: () => void;
  disabled?: boolean;
}) {
  const { t, format } = useTranslation();
  const counts = source
    ? workspaceImportCategoryCounts(source)
    : emptyWorkspaceImportCategoryCounts();
  const available = availableCategories(source);
  const toolsAvailable = new Set(
    [...available].filter((category) =>
      WORKSPACE_IMPORT_TOOLS_CATEGORIES.includes(
        category as (typeof WORKSPACE_IMPORT_TOOLS_CATEGORIES)[number],
      ),
    ),
  );
  const toolsState = workspaceImportToolsSelectionState(selection, toolsAvailable);
  const isImporting = step === "importing";
  const isComplete = Boolean(step === "success" && result);
  const toolRows = (Object.keys(counts) as WorkspaceImportCategoryKind[]).filter(
    (category) =>
      WORKSPACE_IMPORT_TOOLS_CATEGORIES.includes(
        category as (typeof WORKSPACE_IMPORT_TOOLS_CATEGORIES)[number],
      ) && available.has(category),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-[520px]" showCloseButton>
        <DialogHeader className="gap-1 px-5 pb-3 pt-5">
          <DialogTitle className="text-xl tracking-[-0.02em]">
            {t("import.modal.title")}
          </DialogTitle>
          <DialogDescription>{t("import.modal.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-1">
          {source ? (
            <div className="mb-3 text-ui-sm font-medium text-muted-foreground">
              {source.displayName ?? workspaceImportSourceLabel(source.source)}
            </div>
          ) : null}
          {isComplete && result ? (
            <div className="space-y-3" role="status">
              <div className="space-y-2 rounded-xl border border-emerald-500/35 bg-emerald-500/8 px-4 py-3">
                <div className="flex items-center gap-2 text-ui-lg font-medium text-emerald-600 dark:text-emerald-400">
                  <CircleCheckIcon className="size-4" />
                  {t("import.modal.complete")}
                </div>
                <p className="text-ui-sm text-muted-foreground">{t("import.success.lead")}</p>
                {result.historyEntry ? (
                  <p className="text-ui-sm text-muted-foreground">
                    {format("import.history.imported", {
                      count: result.historyEntry.importedCount,
                    })}
                  </p>
                ) : null}
              </div>
              <div className="overflow-hidden rounded-xl border border-border/90 bg-background/20">
                <SelectionGroupRow
                  icon={SettingsIcon}
                  title={t("import.modal.tools")}
                  description={t("import.modal.toolsDescription")}
                  checked={toolsState}
                  expanded={false}
                  onToggle={() => undefined}
                  onExpand={() => undefined}
                  disabled
                />
                <SelectionTopRow
                  icon={FolderIcon}
                  title={format("import.modal.projects", { count: counts.projects })}
                  description={t("import.modal.projectsDescription")}
                  checked={selection.has("projects")}
                  disabled
                  info={t("import.modal.projectsDescription")}
                  onToggle={() => undefined}
                />
                <SelectionTopRow
                  icon={MessageCircleIcon}
                  title={format("import.modal.chats", { count: counts.chats })}
                  description={t("import.modal.chatsDescription")}
                  checked={selection.has("chats")}
                  disabled
                  info={t("import.modal.chatsDescription")}
                  onToggle={() => undefined}
                />
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/90 bg-background/20">
              {error ? (
                <div
                  className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}
              <SelectionGroupRow
                icon={SettingsIcon}
                title={t("import.modal.tools")}
                description={t("import.modal.toolsDescription")}
                checked={toolsState}
                expanded={toolsExpanded}
                onToggle={onToggleTools}
                onExpand={onToggleToolsExpanded}
                disabled={disabled}
              />
              <DisclosureRegion
                open={toolsExpanded}
                className="border-t border-border/70"
                contentClassName="px-3 py-1.5"
              >
                {toolRows.map((category) => (
                  <SelectionChildRow
                    key={category}
                    category={category}
                    count={counts[category]}
                    checked={selection.has(category)}
                    onToggle={() => onToggleCategory(category)}
                    disabled={disabled}
                    label={categoryLabel(category, t)}
                  />
                ))}
              </DisclosureRegion>
              <SelectionTopRow
                icon={FolderIcon}
                title={format("import.modal.projects", { count: counts.projects })}
                description={t("import.modal.projectsDescription")}
                checked={selection.has("projects")}
                disabled={!available.has("projects") || disabled}
                info={t("import.modal.projectsDescription")}
                onToggle={() => onToggleCategory("projects")}
              />
              <SelectionTopRow
                icon={MessageCircleIcon}
                title={format("import.modal.chats", { count: counts.chats })}
                description={t("import.modal.chatsDescription")}
                checked={selection.has("chats")}
                disabled={!available.has("chats") || disabled}
                info={t("import.modal.chatsDescription")}
                onToggle={() => onToggleCategory("chats")}
              />
            </div>
          )}
        </div>
        <DialogFooter className="px-5 pb-4 pt-3">
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => onOpenChange(false)}
          >
            {isComplete ? t("import.done") : t("import.modal.cancel")}
          </Button>
          {!isComplete ? (
            <Button
              type="button"
              disabled={isImporting || disabled || selection.size === 0}
              onClick={onImport}
            >
              {isImporting ? (
                <>
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  {t("import.modal.importing")}
                </>
              ) : (
                t("import.modal.import")
              )}
            </Button>
          ) : (
            <Button type="button" onClick={() => onOpenChange(false)}>
              {t("import.modal.viewImported")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SelectionGroupRow({
  icon: Icon,
  title,
  description,
  checked,
  expanded,
  onToggle,
  onExpand,
  disabled,
}: {
  icon: typeof SettingsIcon;
  title: string;
  description: string;
  checked: boolean | "indeterminate";
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <button
        type="button"
        disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onExpand}
        aria-expanded={expanded}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui-lg font-medium text-foreground">{title}</span>
          <span className="block text-ui-sm text-muted-foreground">{description}</span>
        </span>
        <DisclosureChevron open={expanded} className="size-4" />
      </button>
      <Checkbox
        checked={checked === true}
        indeterminate={checked === "indeterminate"}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={title}
      />
    </div>
  );
}

function SelectionChildRow({
  category,
  count,
  checked,
  onToggle,
  label,
  disabled,
}: {
  category: WorkspaceImportCategoryKind;
  count: number;
  checked: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
}) {
  const Icon = TOOL_CATEGORY_ICONS[category];
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-foreground/5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1 text-ui-lg text-foreground">{label}</span>
      <span className="text-ui-sm tabular-nums text-muted-foreground">{count}</span>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={label}
      />
    </label>
  );
}

function SelectionTopRow({
  icon: Icon,
  title,
  description,
  checked,
  disabled,
  info,
  onToggle,
}: {
  icon: typeof FolderIcon;
  title: string;
  description: string;
  checked: boolean;
  info: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-border/70 px-3 py-3",
        disabled && "opacity-55",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui-lg font-medium text-foreground">{title}</span>
        <span className="block text-ui-sm text-muted-foreground">{description}</span>
      </span>
      <span
        className={cn("rounded-full p-1 text-muted-foreground", disabled && "opacity-60")}
        title={info}
        role="img"
        aria-label={info}
      >
        <InfoIcon className="size-3.5" aria-hidden="true" />
      </span>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        aria-label={title}
      />
    </div>
  );
}

function HistoryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: WorkspaceImportHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, format } = useTranslation();
  const sourceLabel = entry.sources.map(workspaceImportSourceLabel).join(", ");
  const statusTone =
    entry.status === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : entry.status === "partial"
        ? "text-amber-600 dark:text-amber-400"
        : "text-destructive";
  return (
    <div className="border-b border-border/70 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-foreground/5"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <ProviderIcon
          provider={entry.sources[0] ? providerForSource(entry.sources[0]) : "codex"}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-lg font-medium text-foreground">
            {t("import.history.title")}
          </span>
          <span className="block truncate text-ui-sm text-muted-foreground">
            {sourceLabel} · {formatHistoryDate(entry.importedAt)}
          </span>
        </span>
        <span className={cn("shrink-0 text-ui-sm", statusTone)}>
          {entry.status === "success"
            ? format("import.history.imported", { count: entry.importedCount })
            : entry.status === "partial"
              ? format("import.history.partial", {
                  count: entry.importedCount,
                  warnings: entry.warningCount,
                })
              : format("import.history.failed", {
                  count: entry.importedCount,
                  failed: entry.failedCount,
                })}
        </span>
        <DisclosureChevron open={expanded} className="size-4" />
      </button>
      <DisclosureRegion
        open={expanded}
        contentClassName="grid grid-cols-2 gap-2 px-11 pb-4 text-ui-sm text-muted-foreground"
      >
        {(Object.entries(entry.categories) as Array<[WorkspaceImportCategoryKind, number]>)
          .filter(([, count]) => count > 0)
          .map(([category, count]) => (
            <div key={category} className="flex justify-between gap-3">
              <span>{categoryLabel(category, t)}</span>
              <span className="tabular-nums">{count}</span>
            </div>
          ))}
        {entry.warningCount > 0 ? (
          <div className="col-span-2 text-amber-600 dark:text-amber-400">
            {t("import.attention.safeCopy")}
          </div>
        ) : null}
      </DisclosureRegion>
    </div>
  );
}

function SyncCustomizeDialog({
  open,
  categories,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  categories: readonly WorkspaceImportCategoryKind[];
  onOpenChange: (open: boolean) => void;
  onSave: (categories: WorkspaceImportCategoryKind[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Set<WorkspaceImportCategoryKind>>(new Set(categories));
  useEffect(() => setDraft(new Set(categories)), [categories, open]);
  const options = WORKSPACE_IMPORT_TOOLS_CATEGORIES;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t("import.sync.customizeTitle")}</DialogTitle>
          <DialogDescription>{t("import.sync.customizeDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1 px-4 pb-2">
          {options.map((category) => {
            const Icon = TOOL_CATEGORY_ICONS[category];
            return (
              <label
                key={category}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-foreground/5"
              >
                <Checkbox
                  checked={draft.has(category)}
                  onCheckedChange={() =>
                    setDraft((current) => toggleWorkspaceImportCategory(current, category))
                  }
                />
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-ui-lg text-foreground">{categoryLabel(category, t)}</span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("import.modal.cancel")}
          </Button>
          <Button type="button" onClick={() => onSave([...draft])}>
            {t("import.sync.save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ImportReviewDialog({
  open,
  items,
  hasHistoricalWarnings,
  onOpenChange,
}: {
  open: boolean;
  items: readonly WorkspaceImportResourceCopy[];
  hasHistoricalWarnings: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t("import.review.title")}</DialogTitle>
          <DialogDescription>{t("import.review.description")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(52vh,20rem)] overflow-y-auto px-4 pb-2">
          {items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-5 text-ui-lg text-muted-foreground">
              {hasHistoricalWarnings ? t("import.attention.safeCopy") : t("import.review.empty")}
            </div>
          ) : (
            <div className="divide-y divide-border/70 rounded-lg border border-border/80">
              {items.map((item) => (
                <div
                  key={`${item.source}:${item.category}:${item.name}:${item.action}:${item.reason ?? ""}`}
                  className="px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-ui-lg font-medium text-foreground">
                        {item.name}
                      </div>
                      <div className="mt-1 text-ui-sm text-muted-foreground">
                        {workspaceImportSourceLabel(item.source)} ·{" "}
                        {categoryLabel(item.category, t)}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
                        item.action === "skipped"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-amber-500/12 text-amber-700 dark:text-amber-300",
                      )}
                    >
                      {item.action === "skipped"
                        ? t("import.review.skipped")
                        : t("import.review.quarantined")}
                    </span>
                  </div>
                  {item.reason ? (
                    <p className="mt-2 text-ui-sm text-muted-foreground">{item.reason}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("import.done")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
