import {
  PROJECT_IMPORT_NATIVE_PROVIDERS,
  PROJECT_IMPORT_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  type ImportProjectInput,
  type ListProjectImportsResult,
  type ProjectImportProject,
  type ProjectImportProvider,
  type ProjectImportUnreadableProvider,
  type ServerProviderStatus,
} from "@moss/contracts";

import { isRpcCapacityExceededError } from "~/lib/expensiveReadRetry";
import { findProviderStatus, resolveAgentReadiness } from "~/lib/providerAvailability";

/** Every agent the import scans; the server reads each one's local history. */
export const IMPORT_PROVIDERS: readonly ProjectImportProvider[] = PROJECT_IMPORT_PROVIDERS;
export const IMPORT_PROVIDER_LABELS: Record<
  ProjectImportProvider | ProjectImportUnreadableProvider,
  string
> = {
  codex: PROVIDER_DISPLAY_NAMES.codex,
  claudeAgent: "Claude Code",
  cursor: PROVIDER_DISPLAY_NAMES.cursor,
  gemini: PROVIDER_DISPLAY_NAMES.gemini,
  antigravity: PROVIDER_DISPLAY_NAMES.antigravity,
  grok: PROVIDER_DISPLAY_NAMES.grok,
  opencode: PROVIDER_DISPLAY_NAMES.opencode,
  pi: PROVIDER_DISPLAY_NAMES.pi,
  hermes: PROVIDER_DISPLAY_NAMES.hermes,
  devin: PROVIDER_DISPLAY_NAMES.devin,
  omp: PROVIDER_DISPLAY_NAMES.omp,
  zcode: PROVIDER_DISPLAY_NAMES.zcode,
  kimi: PROVIDER_DISPLAY_NAMES.kimi,
};

/**
 * One quiet line for everything that won't be imported: agents with nothing on this computer,
 * and conversations Moss found but can't copy. The reasons go in a tooltip.
 */
export function projectImportQuietNote(
  notFound: readonly ProjectImportProvider[],
  unreadable: NonNullable<ListProjectImportsResult["unreadable"]>,
): string | null {
  const parts: string[] = [];
  if (notFound.length > 0) {
    parts.push(
      `Not found: ${notFound.map((provider) => IMPORT_PROVIDER_LABELS[provider]).join(", ")}`,
    );
  }
  const blocked = unreadable.reduce((total, entry) => total + entry.conversationCount, 0);
  if (blocked > 0) {
    parts.push(
      `${blocked} can't be copied (${unreadable
        .map((entry) => IMPORT_PROVIDER_LABELS[entry.provider])
        .join(", ")})`,
    );
  }
  return parts.length > 0 ? `${parts.join(" · ")}.` : null;
}

/** A folder path short enough to read at a glance: `~` for home, middle folders elided. */
export function shortenImportPath(value: string, homeDir: string | null | undefined): string {
  const separator = value.includes("\\") ? "\\" : "/";
  const home = homeDir?.replace(/[\\/]+$/u, "");
  let shown = value;
  if (home && value.toLowerCase().startsWith(home.toLowerCase())) {
    const rest = value.slice(home.length);
    if (rest === "" || rest.startsWith("\\") || rest.startsWith("/")) shown = `~${rest}`;
  }
  const segments = shown.split(/[\\/]/u).filter(Boolean);
  if (shown.length <= 40 || segments.length <= 3) return shown;
  const head = shown.startsWith("~") ? "~" : segments[0]!;
  return [head, "…", ...segments.slice(-2)].join(separator);
}

/** Plain words for conversations Moss found but cannot copy. */
export function projectImportUnreadableNotes(catalog: ListProjectImportsResult): string[] {
  return (catalog.unreadable ?? []).map(({ provider, conversationCount, reason }) => {
    const label = IMPORT_PROVIDER_LABELS[provider];
    const count = `${conversationCount} ${label} conversation${conversationCount === 1 ? "" : "s"}`;
    return reason === "encrypted"
      ? `Found ${count} that can't be copied: ${label} keeps them encrypted.`
      : `Found ${count} that can't be copied yet: Moss can't read this ${label} format.`;
  });
}

/** Codex and Claude Code copies continue natively; other agents' history is copied as messages. */
export function isNativeImportProvider(provider: ProjectImportProvider): boolean {
  return (PROJECT_IMPORT_NATIVE_PROVIDERS as readonly string[]).includes(provider);
}

/** Conversations found per agent, in display order; agents with none are left out. */
export function projectImportProviderCounts(
  projects: readonly ProjectImportProject[],
): ReadonlyArray<{ readonly provider: ProjectImportProvider; readonly count: number }> {
  const counts = new Map<ProjectImportProvider, number>();
  for (const project of projects) {
    for (const thread of project.threads) {
      counts.set(thread.provider, (counts.get(thread.provider) ?? 0) + 1);
    }
  }
  return IMPORT_PROVIDERS.flatMap((provider) => {
    const count = counts.get(provider) ?? 0;
    return count > 0 ? [{ provider, count }] : [];
  });
}

/** Agents that were scanned without an error and had nothing to import. */
export function projectImportProvidersNotFound(
  catalog: ListProjectImportsResult,
  scanned: readonly ProjectImportProvider[],
): ProjectImportProvider[] {
  const found = new Set(
    projectImportProviderCounts(catalog.projects).map((entry) => entry.provider),
  );
  const failed = new Set(
    catalog.sources.flatMap((source) => (source.error ? [source.provider] : [])),
  );
  // Agents whose conversations were found but can't be copied are reported on their own line.
  const unreadable = new Set<string>((catalog.unreadable ?? []).map((entry) => entry.provider));
  return scanned.filter(
    (provider) => !found.has(provider) && !failed.has(provider) && !unreadable.has(provider),
  );
}

/**
 * Splits the agents a scan found nothing for by what agent detection saw, so the import step
 * and the agents step tell the same story: an agent detection found on this computer has "no
 * conversations yet"; only one it didn't find (or hasn't checked) is "not found".
 */
export function splitProjectImportNotFoundByDetection(
  notFound: readonly ProjectImportProvider[],
  providerStatuses: readonly ServerProviderStatus[] | null | undefined,
): {
  readonly notFound: ProjectImportProvider[];
  readonly noConversations: ProjectImportProvider[];
} {
  if (!providerStatuses) return { notFound: [...notFound], noConversations: [] };
  const detected = (provider: ProjectImportProvider) => {
    const status = findProviderStatus(providerStatuses, provider);
    return (
      status !== null &&
      status.enabled !== false &&
      resolveAgentReadiness(status).state !== "notInstalled"
    );
  };
  return {
    notFound: notFound.filter((provider) => !detected(provider)),
    noConversations: notFound.filter(detected),
  };
}

/**
 * Agents switched off on the agents step are not offered for import (their conversations
 * could not be continued), and are not called "not found" either: one line names those that
 * have conversations so the person knows to turn them on.
 */
export function isProjectImportProviderTurnedOff(
  provider: ProjectImportProvider,
  disabledProviders: readonly string[] | null | undefined,
): boolean {
  return disabledProviders?.includes(provider) ?? false;
}

export function projectImportTurnedOffNote(
  counts: ReadonlyArray<{ readonly provider: ProjectImportProvider; readonly count: number }>,
): string | null {
  if (counts.length === 0) return null;
  const listed = counts
    .map(({ provider, count }) => `${IMPORT_PROVIDER_LABELS[provider]} (${count})`)
    .join(", ");
  return `Not turned on: ${listed}. Turn ${counts.length === 1 ? "it" : "them"} on in the agents list to import these conversations.`;
}

/** One quiet line for detected agents that have nothing to import yet. */
export function projectImportNoConversationsNote(
  providers: readonly ProjectImportProvider[],
): string | null {
  return providers.length > 0
    ? `No conversations yet: ${providers.map((provider) => IMPORT_PROVIDER_LABELS[provider]).join(", ")}.`
    : null;
}

/**
 * The catalog restricted to the agents the person kept ticked. Projects found only through
 * unticked agents drop out, including an agent's project folders that have no conversations.
 */
export function filterProjectImportsByProvider(
  projects: readonly ProjectImportProject[],
  providers: readonly ProjectImportProvider[],
): ProjectImportProject[] {
  const included = new Set(providers);
  return projects.flatMap((project) => {
    if (project.threads.length === 0) {
      const keep = project.providers.length === 0 || project.providers.some((p) => included.has(p));
      return keep ? [project] : [];
    }
    const threads = project.threads.filter((thread) => included.has(thread.provider));
    return threads.length > 0
      ? [{ ...project, providers: project.providers.filter((p) => included.has(p)), threads }]
      : [];
  });
}

export interface ProjectImportQueueItem {
  readonly key: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly input: ImportProjectInput;
}

export function projectImportItemKey(projectKey: string, threadKey: string | null): string {
  return JSON.stringify([projectKey, threadKey]);
}

export function selectableProjectImportKeys(
  project: ProjectImportProject,
  includeArchived: boolean,
): string[] {
  if (project.threads.length === 0) {
    return project.existingProjectId ? [] : [projectImportItemKey(project.key, null)];
  }
  return project.threads
    .filter((thread) => !thread.alreadyImported && (includeArchived || !thread.archived))
    .map((thread) => projectImportItemKey(project.key, thread.key));
}

/**
 * What is ticked when the list first appears: everything except projects in a temp folder,
 * which hold agents' own test and scratch runs. They stay one tick away.
 */
export function defaultProjectImportKeys(
  projects: readonly ProjectImportProject[],
  includeArchived: boolean,
): string[] {
  return projects.flatMap((project) =>
    project.temporary ? [] : selectableProjectImportKeys(project, includeArchived),
  );
}

export interface ProjectImportFailure {
  /** Plain words for the expanded details; never a raw system error. */
  readonly reason: string;
  /** Trying again can work (busy, dropped connection); otherwise the item is skipped. */
  readonly transient: boolean;
}

const CANNOT_ADD = "Moss couldn't add this conversation.";
const TRY_AGAIN = "Moss was busy for a moment. It can try again.";

/**
 * Sorts an import failure into one that trying again can fix and one that it can't. The
 * server words its own import failures for people and says whether they can be retried;
 * anything else it rejects is a permanent "couldn't add". Failures that never got a server
 * answer (busy, dropped or interrupted connection) are worth retrying.
 */
export function describeImportFailure(error: unknown): ProjectImportFailure {
  const value = (typeof error === "object" && error !== null ? error : {}) as {
    readonly _tag?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
    readonly retryable?: unknown;
  };
  if (isRpcCapacityExceededError(error)) return { reason: TRY_AGAIN, transient: true };
  if (value._tag === "WsRpcError") {
    const transient = value.retryable === true;
    if (value.code === "PROJECT_IMPORT_FAILED" && typeof value.message === "string") {
      return { reason: value.message || CANNOT_ADD, transient };
    }
    return { reason: transient ? TRY_AGAIN : CANNOT_ADD, transient };
  }
  return { reason: TRY_AGAIN, transient: true };
}

export function buildProjectImportQueue(options: {
  readonly projects: readonly ProjectImportProject[];
  readonly selected: ReadonlySet<string>;
  readonly includeArchived: boolean;
  readonly workspaceRoots: Readonly<Record<string, string>>;
}): ProjectImportQueueItem[] {
  return options.projects.flatMap((project) => {
    const workspaceRoot = options.workspaceRoots[project.key]?.trim();
    const keys = new Set(selectableProjectImportKeys(project, options.includeArchived));
    const threads = project.threads.length === 0 ? [null] : project.threads;
    return threads.flatMap((thread) => {
      const key = projectImportItemKey(project.key, thread?.key ?? null);
      if (!keys.has(key) || !options.selected.has(key)) return [];
      return [
        {
          key,
          title: thread
            ? `${project.title} · ${thread.title || "Untitled conversation"}`
            : project.title,
          workspaceRoot: workspaceRoot || project.workspaceRoot,
          input: {
            projectKey: project.key,
            threadKey: thread?.key ?? null,
            ...(workspaceRoot ? { workspaceRoot } : {}),
            spaceId: null,
          },
        },
      ];
    });
  });
}
