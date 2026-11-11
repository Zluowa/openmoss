// FILE: ProjectImportPanel.tsx
// Purpose: Find every agent's conversations on this computer and import them in one step:
//          agent chips with counts, one primary action, and the per-project list tucked
//          behind a disclosure. Importing only registers conversations, so it takes seconds;
//          each transcript is read when the conversation is first opened.
// Layer: Web UI component

import type {
  ImportProjectResult,
  ListProjectImportsResult,
  ProjectImportProvider,
  ServerProviderStatus,
} from "@moss/contracts";
import { useEffect, useRef, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { CheckIcon, LoaderCircleIcon } from "~/lib/icons";
import { isRpcCapacityExceededError, runWithRpcCapacityWait } from "~/lib/expensiveReadRetry";
import { useReportRunningImport } from "~/lib/runningImportsStore";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  buildProjectImportQueue,
  defaultProjectImportKeys,
  describeImportFailure,
  filterProjectImportsByProvider,
  IMPORT_PROVIDERS,
  IMPORT_PROVIDER_LABELS,
  projectImportProviderCounts,
  projectImportProvidersNotFound,
  isProjectImportProviderTurnedOff,
  projectImportNoConversationsNote,
  projectImportTurnedOffNote,
  projectImportQuietNote,
  splitProjectImportNotFoundByDetection,
  projectImportUnreadableNotes,
  selectableProjectImportKeys,
  type ProjectImportQueueItem,
} from "./logic";
import { ProjectImportProjectCard } from "./ProjectImportProjectCard";

const SCAN_CAPACITY_WAIT_MS = 2 * 60_000;
// The server registers one conversation at a time in a few milliseconds; keeping several
// requests queued keeps it busy instead of waiting on round trips (518 took 15 s with 8).
const IMPORT_CONCURRENCY = 8;

interface ImportOutcome {
  readonly title: string;
  /** Plain words, never a raw system error; null when it was imported. */
  readonly error: string | null;
  /** A failure trying again can fix. Other failures are skipped and only counted. */
  readonly transient: boolean;
  /** Whether it counts toward "N imported": folders added with conversations don't. */
  readonly counted: boolean;
}

/** The one thing to do next, rendered by the panel or by the dialog that hosts it. */
export interface ProjectImportPrimaryAction {
  readonly label: string;
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly run: () => void;
}

export function ProjectImportPanel(props: {
  readonly onBusyChange: (busy: boolean) => void;
  /** Agents ticked at first; every agent is scanned either way. */
  readonly initialProviders?: readonly ProjectImportProvider[];
  /** Called after each scan with whether any conversation or project was found. */
  readonly onScanComplete?: (found: boolean) => void;
  readonly onResult?: (
    result: ImportProjectResult,
    workspaceRoot: string,
    created: boolean,
  ) => void;
  /**
   * When set, the host renders the primary action (for example in a dialog footer that is
   * always visible) and the panel shows none of its own.
   */
  readonly onPrimaryActionChange?: (action: ProjectImportPrimaryAction | null) => void;
  /**
   * Offer to link a moved project folder. Off in onboarding, where a missing folder simply
   * imports its conversations as history.
   */
  readonly relinkMissingFolders?: boolean;
  /** Agent detection (server provider statuses), so "not found" matches the agents list. */
  readonly providerStatuses?: readonly ServerProviderStatus[] | undefined;
  /** Agents switched off on the agents list: not offered here, named in one quiet line. */
  readonly disabledProviders?: readonly string[] | undefined;
}) {
  const [providers, setProviders] = useState<readonly ProjectImportProvider[]>(
    props.initialProviders ?? IMPORT_PROVIDERS,
  );
  const [catalog, setCatalog] = useState<ListProjectImportsResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [workspaceRoots, setWorkspaceRoots] = useState<Record<string, string>>({});
  const [includeArchived, setIncludeArchived] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [failuresOpen, setFailuresOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [outcomes, setOutcomes] = useState<Record<string, ImportOutcome>>({});
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRef = useRef(false);
  const mountedRef = useRef(true);
  const syncSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const { onBusyChange, onScanComplete, onPrimaryActionChange } = props;
  const busy = running || picking;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // Quitting the desktop app mid-import says so instead of stopping it silently.
  useReportRunningImport(running, "");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
      onBusyChange(false);
    };
  }, [onBusyChange]);

  const completedKeys = new Set(
    Object.entries(outcomes)
      .filter(([, value]) => value.error === null)
      .map(([key]) => key),
  );
  // Imported, or skipped because trying again can't help: neither is offered again.
  const settledKeys = new Set(
    Object.entries(outcomes)
      .filter(([, value]) => value.error === null || !value.transient)
      .map(([key]) => key),
  );
  // Unticking an agent leaves its conversations out without forgetting their selection.
  const turnedOff = (provider: ProjectImportProvider) =>
    isProjectImportProviderTurnedOff(provider, props.disabledProviders);
  const projects = filterProjectImportsByProvider(
    catalog?.projects ?? [],
    providers.filter((provider) => !turnedOff(provider)),
  );
  const allProviderCounts = projectImportProviderCounts(catalog?.projects ?? []);
  const providerCounts = allProviderCounts.filter(({ provider }) => !turnedOff(provider));
  const turnedOffNote = projectImportTurnedOffNote(
    allProviderCounts.filter(({ provider }) => turnedOff(provider)),
  );
  const missing = catalog
    ? splitProjectImportNotFoundByDetection(
        projectImportProvidersNotFound(catalog, IMPORT_PROVIDERS).filter(
          (provider) => !turnedOff(provider),
        ),
        props.providerStatuses,
      )
    : null;
  const quietNote =
    catalog && missing ? projectImportQuietNote(missing.notFound, catalog.unreadable ?? []) : null;
  const noConversationsNote = missing
    ? projectImportNoConversationsNote(missing.noConversations)
    : null;
  const unreadableDetails = catalog ? projectImportUnreadableNotes(catalog).join("\n") : "";
  const queue = buildProjectImportQueue({
    projects,
    selected,
    includeArchived,
    workspaceRoots,
  }).filter((item) => !settledKeys.has(item.key));
  const conversationCount = queue.filter((item) => item.input.threadKey !== null).length;
  const selectableKeys = projects.flatMap((project) =>
    selectableProjectImportKeys(project, includeArchived).filter((key) => !settledKeys.has(key)),
  );
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selected.has(key));
  const failures = Object.entries(outcomes).filter(([, value]) => value.error !== null);
  const retryQueue = queue.filter((item) => outcomes[item.key]?.transient);
  const importedCount = Object.values(outcomes).filter(
    (value) => value.error === null && value.counted,
  ).length;

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      // Right after start-up, provider discovery can hold the heavy-read budget for a while;
      // wait for it instead of reporting nothing found.
      const result = await runWithRpcCapacityWait(
        () =>
          ensureNativeApi().orchestration.listProjectImports({
            providers: IMPORT_PROVIDERS,
          }),
        { maxWaitMs: SCAN_CAPACITY_WAIT_MS, isCancelled: () => !mountedRef.current },
      );
      if (!mountedRef.current) return;
      setCatalog(result);
      onScanComplete?.(result.projects.length > 0);
      setSelected(new Set(defaultProjectImportKeys(result.projects, includeArchived)));
      setOutcomes({});
      setProgress(null);
    } catch (caught) {
      if (mountedRef.current)
        setError(
          isRpcCapacityExceededError(caught)
            ? "Moss is still busy starting up. Scan again in a moment."
            : "Could not look for conversations on this computer.",
        );
    } finally {
      if (mountedRef.current) setScanning(false);
    }
  };
  // Look as soon as the panel opens: everything already on this computer is offered.
  const scanRef = useRef(scan);
  scanRef.current = scan;
  useEffect(() => {
    void scanRef.current();
  }, []);

  const run = async (items: readonly ProjectImportQueueItem[]) => {
    if (items.length === 0 || busy) return;
    stopRef.current = false;
    setStopRequested(false);
    setRunning(true);
    setError(null);
    let done = 0;
    // Count what the button promised: conversations, with any folders that ride along
    // left out. A batch of folders alone counts the folders.
    const foldersOnly = items.every((entry) => entry.input.threadKey === null);
    const counts = (item: ProjectImportQueueItem) => foldersOnly || item.input.threadKey !== null;
    const total = items.filter(counts).length;
    setProgress({ current: 0, total });
    try {
      const api = ensureNativeApi();
      let next = 0;
      const worker = async () => {
        while (next < items.length && !stopRef.current && mountedRef.current) {
          const item = items[next++]!;
          try {
            const result = await api.orchestration.importProject(item.input);
            if (!mountedRef.current) return;
            setOutcomes((current) => ({
              ...current,
              [item.key]: {
                title: item.title,
                error: null,
                transient: false,
                counted: counts(item),
              },
            }));
            const project = projects.find((entry) => entry.key === item.input.projectKey);
            props.onResult?.(result, item.workspaceRoot, project?.existingProjectId === null);
          } catch (caught) {
            if (!mountedRef.current) return;
            const failure = describeImportFailure(caught);
            setOutcomes((current) => ({
              ...current,
              [item.key]: {
                title: item.title,
                error: failure.reason,
                transient: failure.transient,
                counted: counts(item),
              },
            }));
          }
          if (counts(item)) {
            done += 1;
            setProgress({ current: done, total });
          }
        }
      };
      await Promise.all(Array.from({ length: IMPORT_CONCURRENCY }, worker));
      // Refresh once per batch. Import events also update the live store while the batch runs.
      try {
        const snapshot = await api.orchestration.getShellSnapshot();
        if (mountedRef.current) syncSnapshot(snapshot);
      } catch {
        // A reconnect will hydrate the store; successful durable imports remain successful.
      }
    } catch {
      if (mountedRef.current) setError("Could not start the import.");
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  };

  const primaryAction: ProjectImportPrimaryAction | null = !catalog
    ? null
    : running
      ? {
          label: stopRequested
            ? "Stopping…"
            : `Importing ${progress?.current ?? 0} of ${progress?.total ?? queue.length}…`,
          disabled: true,
          busy: true,
          run: () => undefined,
        }
      : retryQueue.length > 0
        ? {
            label: `Retry ${retryQueue.length} failed`,
            disabled: busy || scanning,
            busy: false,
            run: () => void run(retryQueue),
          }
        : queue.length > 0
          ? {
              label:
                conversationCount > 0
                  ? `Import ${conversationCount} conversation${conversationCount === 1 ? "" : "s"}`
                  : `Add ${queue.length} project${queue.length === 1 ? "" : "s"}`,
              disabled: busy || scanning,
              busy: false,
              run: () => void run(queue),
            }
          : null;
  const primaryKey = primaryAction
    ? `${primaryAction.label}|${String(primaryAction.disabled)}|${String(primaryAction.busy)}`
    : "";
  const primaryRef = useRef(primaryAction);
  primaryRef.current = primaryAction;
  useEffect(() => {
    if (!onPrimaryActionChange) return;
    const current = primaryRef.current;
    onPrimaryActionChange(current ? { ...current, run: () => primaryRef.current?.run() } : null);
  }, [primaryKey, onPrimaryActionChange]);
  useEffect(() => () => onPrimaryActionChange?.(null), [onPrimaryActionChange]);

  const select = (keys: readonly string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  const query = search.trim().toLowerCase();
  const visibleProjects = projects.filter((project) =>
    `${project.title} ${project.workspaceRoot}`.toLowerCase().includes(query),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 text-ui sm:text-ui">
      {scanning && !catalog ? (
        <p aria-live="polite" className="flex items-center gap-2 text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Looking for conversations from your agents…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-ui-sm text-destructive">
          {error}
          <button
            type="button"
            className="underline underline-offset-2"
            disabled={scanning}
            onClick={() => void scan()}
          >
            Scan again
          </button>
        </p>
      ) : null}
      {catalog && catalog.projects.length === 0 ? (
        <p className="text-muted-foreground">
          No conversations from other agents were found on this computer.
        </p>
      ) : null}
      {providerCounts.length > 0 ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Agents found on this computer"
        >
          {providerCounts.map(({ provider, count }) => (
            <label
              key={provider}
              className={cn(
                "flex h-8 cursor-pointer items-center gap-2 rounded-control border px-2.5 transition-colors motion-reduce:transition-none",
                providers.includes(provider)
                  ? "border-foreground/14 bg-foreground/[0.05] text-foreground"
                  : "border-foreground/8 text-muted-foreground hover:bg-foreground/[0.03]",
              )}
            >
              <Checkbox
                aria-label={IMPORT_PROVIDER_LABELS[provider]}
                checked={providers.includes(provider)}
                disabled={busy || scanning}
                onCheckedChange={(checked) => {
                  setProviders((current) =>
                    checked ? [...current, provider] : current.filter((item) => item !== provider),
                  );
                }}
              />
              <ProviderIcon provider={provider} className="size-4 shrink-0" />
              <span>{IMPORT_PROVIDER_LABELS[provider]}</span>
              <span className="text-muted-foreground tabular-nums">{count}</span>
            </label>
          ))}
        </div>
      ) : null}
      {quietNote ? (
        <p
          className="text-ui-sm text-muted-foreground/80"
          {...(unreadableDetails ? { title: unreadableDetails } : {})}
        >
          {quietNote}
        </p>
      ) : null}
      {noConversationsNote ? (
        <p className="text-ui-sm text-muted-foreground/80">{noConversationsNote}</p>
      ) : null}
      {turnedOffNote ? (
        <p className="text-ui-sm text-muted-foreground/80">{turnedOffNote}</p>
      ) : null}
      {catalog && catalog.projects.length > 0 ? (
        <div className="flex min-h-0 flex-col">
          <button
            type="button"
            aria-expanded={listOpen}
            className="flex w-fit items-center gap-1.5 text-ui-sm text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
            onClick={() => setListOpen((open) => !open)}
          >
            <DisclosureChevron open={listOpen} className="size-3.5" />
            <span>Choose projects</span>
            <span className="tabular-nums">{projects.length}</span>
          </button>
          <DisclosureRegion open={listOpen}>
            <div className="flex flex-col gap-2 pt-2">
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  aria-label="Search imported projects"
                  placeholder="Search projects…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="h-8 min-w-40 flex-1 rounded-control text-ui sm:text-ui"
                />
                <label className="flex items-center gap-2 text-ui-sm text-muted-foreground">
                  <Checkbox
                    checked={includeArchived}
                    disabled={busy || scanning}
                    onCheckedChange={setIncludeArchived}
                  />
                  Include archived
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 rounded-control font-normal text-ui sm:text-ui"
                  disabled={busy || scanning || selectableKeys.length === 0}
                  onClick={() => select(selectableKeys, !allSelected)}
                >
                  {allSelected ? "Remove all" : "Select all"}
                </Button>
              </div>
              <div className="-mr-2 max-h-64 overflow-y-auto pr-2">
                {visibleProjects.length > 0 ? (
                  <div
                    className="divide-y divide-foreground/8 overflow-hidden rounded-card border border-foreground/10"
                    aria-label="Projects available to import"
                  >
                    {visibleProjects.map((project) => (
                      <ProjectImportProjectCard
                        key={project.key}
                        project={project}
                        selected={selected}
                        includeArchived={includeArchived}
                        disabled={busy || scanning}
                        completedKeys={completedKeys}
                        skippedKeys={settledKeys}
                        relinkMissingFolders={props.relinkMissingFolders ?? true}
                        workspaceRoot={workspaceRoots[project.key] ?? ""}
                        onWorkspaceRootChange={(path) =>
                          setWorkspaceRoots((current) => ({ ...current, [project.key]: path }))
                        }
                        onSelectionChange={select}
                        onPickerBusyChange={setPicking}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="py-4 text-center text-muted-foreground">
                    {projects.length === 0
                      ? "Tick an agent above to import its conversations."
                      : "No projects match your search."}
                  </p>
                )}
              </div>
            </div>
          </DisclosureRegion>
        </div>
      ) : null}
      {running ? (
        <p role="status" aria-live="polite" className="flex items-center gap-2">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          {`Importing ${progress?.current ?? 0} of ${progress?.total ?? 0}`}
          <button
            type="button"
            className="ml-auto text-ui-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
            disabled={stopRequested}
            onClick={() => {
              stopRef.current = true;
              setStopRequested(true);
            }}
          >
            Stop
          </button>
        </p>
      ) : progress ? (
        <p role="status" className="flex items-center gap-2">
          <CheckIcon className="size-4 text-success" aria-hidden />
          {stopRequested
            ? `${importedCount} imported. Import stopped; the rest are still selected.`
            : `${importedCount} imported or already present.`}
        </p>
      ) : null}
      {failures.length > 0 && !running ? (
        // One quiet line; what happened to each is one click away, in plain words.
        <div className="flex min-h-0 flex-col text-ui-sm text-muted-foreground">
          <button
            type="button"
            aria-expanded={failuresOpen}
            className="flex w-fit items-center gap-1.5 transition-colors hover:text-foreground motion-reduce:transition-none"
            onClick={() => setFailuresOpen((open) => !open)}
          >
            <DisclosureChevron open={failuresOpen} className="size-3.5" />
            <span>{`${failures.length} conversation${failures.length === 1 ? "" : "s"} couldn't be imported`}</span>
          </button>
          <DisclosureRegion open={failuresOpen}>
            <ul aria-label="Import failures" className="max-h-28 space-y-1 overflow-y-auto pt-1.5">
              {failures.map(([key, failure]) => (
                // Titles and reasons can be long; clamp both and keep the full text on hover.
                <li key={key} className="min-w-0 break-words">
                  <span className="line-clamp-1 text-foreground/80" title={failure.title}>
                    {failure.title}
                  </span>
                  <span className="line-clamp-2" title={failure.error ?? undefined}>
                    {failure.error}
                  </span>
                </li>
              ))}
            </ul>
          </DisclosureRegion>
        </div>
      ) : null}
      {!onPrimaryActionChange && primaryAction ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-foreground/8 pt-2.5">
          <Button
            size="sm"
            className="h-8 rounded-control px-3 font-normal text-ui sm:text-ui"
            disabled={primaryAction.disabled}
            onClick={primaryAction.run}
          >
            {primaryAction.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
