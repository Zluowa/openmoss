// Merge native provider metadata by local workspace identity, retaining each thread's source cwd.
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import type { ProjectId, ProjectImportProvider, ProviderInstanceId } from "@moss/contracts";
import { isMossInternalPath, isWorkspaceRootWithin } from "@moss/shared/threadWorkspace";

import type {
  NativeImportSession,
  NativeProjectImportCatalog,
} from "../provider/projectImportTypes";
import {
  canonicalImportPath,
  findImportGitWorkspace,
  importDirectoryExists,
  importPathIdentity,
  isTemporaryImportRoot,
  projectImportKey,
} from "./projectImportPaths";

export interface ResolvedImportSession extends NativeImportSession {
  key: string;
  provider: ProjectImportProvider;
  /** The account the session was discovered through; undefined means the default. */
  providerInstanceId?: ProviderInstanceId;
  sourceHome: string;
  parentKey?: string;
}

export function importSessionIdentities(session: ResolvedImportSession): string[] {
  return [session.id, ...(session.priorSessionIds ?? [])].map(
    (id) => `${session.provider}:${id.trim().toLowerCase()}`,
  );
}

export interface ResolvedImportProject {
  key: string;
  title: string;
  workspaceRoot: string;
  directoryExists: boolean;
  /** In a temp directory: an agent's own test or scratch run, not selected by default. */
  temporary: boolean;
  existingProjectId: ProjectId | null;
  providers: ProjectImportProvider[];
  threads: ResolvedImportSession[];
}

interface ExistingProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly kind?: string | undefined;
  readonly deletedAt: string | null;
}

function isAbsoluteDirectory(value: string): boolean {
  return value.trim().length > 0 && !value.includes("\0") && path.isAbsolute(value);
}

function contains(root: string, cwd: string): boolean {
  return isWorkspaceRootWithin(cwd, root, { platform: process.platform });
}

function mostSpecificRoot(roots: ReadonlyArray<string>, cwd: string): string | undefined {
  return roots
    .filter((root) => contains(root, cwd))
    .toSorted(
      (left, right) => importPathIdentity(right).length - importPathIdentity(left).length,
    )[0];
}

function claudeWorktreeOrigin(cwd: string): { root: string; originalCwd: string } | undefined {
  const parsed = path.parse(cwd);
  const parts = cwd.slice(parsed.root.length).split(path.sep);
  const names = process.platform === "win32" ? parts.map((part) => part.toLowerCase()) : parts;
  const marker = names.findIndex(
    (part, index) => part === ".claude" && names[index + 1] === "worktrees" && names[index + 2],
  );
  if (marker < 0) return undefined;
  const root = path.join(parsed.root, ...parts.slice(0, marker));
  return { root, originalCwd: path.join(root, ...parts.slice(marker + 3)) };
}

function cachedLookup<T>(lookup: (value: string) => Promise<T>): (value: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (value) => {
    let result = cache.get(value);
    if (!result) {
      result = lookup(value);
      cache.set(value, result);
    }
    return result;
  };
}

// A stale or inaccessible native cwd must not hide other providers' projects.
// Keep unexpected filesystem failures visible instead of treating them as missing paths.
async function availableImportEntry<T>(lookup: () => Promise<T>): Promise<T | undefined> {
  try {
    return await lookup();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EISDIR" || code === "ENOTDIR")
      return undefined;
    throw error;
  }
}

export async function buildProjectImportCatalog(
  sources: ReadonlyArray<{
    provider: ProjectImportProvider;
    catalog: NativeProjectImportCatalog;
    providerInstanceId?: ProviderInstanceId;
  }>,
  existingProjects: ReadonlyArray<ExistingProject>,
  options: {
    /** Folders never offered as projects; Moss's own working folders by default. */
    readonly excludeRoot?: (root: string) => boolean;
    /** Temp directories besides the usual ones; the process's own by default. */
    readonly tempDirs?: ReadonlyArray<string>;
  } = {},
): Promise<ResolvedImportProject[]> {
  const excluded = options.excludeRoot ?? isMossInternalPath;
  const tempDirs =
    options.tempDirs ??
    [os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR].filter(
      (dir): dir is string => typeof dir === "string" && dir.trim().length > 0,
    );
  const canonical = cachedLookup(canonicalImportPath);
  const gitWorkspace = cachedLookup(findImportGitWorkspace);
  const directoryExists = cachedLookup(importDirectoryExists);
  const existingByRoot = new Map<string, ExistingProject>();
  for (const project of existingProjects) {
    if (
      project.deletedAt !== null ||
      (project.kind && project.kind !== "project") ||
      !isAbsoluteDirectory(project.workspaceRoot)
    )
      continue;
    const root = await availableImportEntry(() => canonical(project.workspaceRoot));
    if (!root) continue;
    // Keep a deterministic existing destination even if an older database contains duplicate roots.
    const identity = importPathIdentity(root);
    if (!existingByRoot.has(identity))
      existingByRoot.set(identity, { ...project, workspaceRoot: root });
  }
  const declaredRoots = new Map<string, { root: string; title: string }>();
  for (const { provider, catalog } of sources) {
    // Claude's discovery may mix transcript cwd hints with explicit desktop origins.
    if (provider === "claudeAgent" || !isAbsoluteDirectory(catalog.sourceHome)) continue;
    for (const project of catalog.projects) {
      for (const value of project.roots) {
        if (!isAbsoluteDirectory(value)) continue;
        const root = await availableImportEntry(() => canonical(value));
        if (!root || excluded(root)) continue;
        const identity = importPathIdentity(root);
        if (!declaredRoots.has(identity))
          declaredRoots.set(identity, { root, title: project.title });
      }
    }
  }
  const inferenceRoots = [
    ...[...existingByRoot.values()].map((project) => project.workspaceRoot),
    ...[...declaredRoots.values()].map((project) => project.root),
  ];
  const projects = new Map<string, ResolvedImportProject>();
  // Two accounts of one agent can read the same conversations from different home folders:
  // the Moss-lane Codex account keeps its own home but lists the default account's threads,
  // which doubled the Codex count (297 shown as 594). A session id names one conversation, so
  // it is offered once, from the first source; sources come default account first.
  const offeredSessions = new Map<string, ResolvedImportSession>();
  const placement = new Map<ResolvedImportSession, ResolvedImportProject>();

  const derivedWorkspace = cachedLookup(async (cwd: string): Promise<string> => {
    const claudeWorktree = claudeWorktreeOrigin(cwd);
    if (claudeWorktree) {
      const original = await canonical(claudeWorktree.originalCwd);
      const existing = mostSpecificRoot(inferenceRoots, original);
      const root = await canonical(claudeWorktree.root);
      return existing && contains(root, existing) ? existing : root;
    }
    const git = await gitWorkspace(cwd);
    const existing = mostSpecificRoot(inferenceRoots, cwd);
    if (!git) return existing ?? cwd;
    // Saved Moss and explicitly declared Codex subprojects both outrank Git's root.
    if (existing && contains(git.worktree ?? git.root, existing)) return existing;
    if (git.worktree) {
      const originalCwd = path.join(git.root, path.relative(git.worktree, cwd));
      const originalExisting = mostSpecificRoot(inferenceRoots, originalCwd);
      if (originalExisting && contains(git.root, originalExisting)) return originalExisting;
    }
    return canonical(git.root);
  });

  const ensureProject = async (root: string, title: string, provider: ProjectImportProvider) => {
    const identity = importPathIdentity(root);
    let project = projects.get(identity);
    if (!project) {
      const existing = existingByRoot.get(identity);
      project = {
        key: projectImportKey("project", identity),
        title: existing?.title ?? declaredRoots.get(identity)?.title ?? title,
        workspaceRoot: root,
        directoryExists: await directoryExists(root),
        temporary: isTemporaryImportRoot(root, tempDirs),
        existingProjectId: existing?.id ?? null,
        providers: [],
        threads: [],
      };
      projects.set(identity, project);
    }
    if (!project.providers.includes(provider)) project.providers.push(provider);
    return project;
  };

  let sessionCount = 0;
  for (const { provider, catalog, providerInstanceId } of sources) {
    if (!isAbsoluteDirectory(catalog.sourceHome)) continue;
    const sourceHome = await canonical(catalog.sourceHome);
    const sourceProjects = new Map<
      string,
      { title: string; roots: string[]; hasUnavailableRoot: boolean }
    >();
    for (const sourceProject of catalog.projects) {
      if (provider === "claudeAgent") continue;
      const roots = new Map<string, string>();
      let hasUnavailableRoot = false;
      for (const sourceRoot of sourceProject.roots) {
        if (!isAbsoluteDirectory(sourceRoot)) continue;
        const root = await availableImportEntry(() => canonical(sourceRoot));
        if (!root) {
          hasUnavailableRoot = true;
          continue;
        }
        if (excluded(root)) continue;
        const project = await availableImportEntry(() =>
          ensureProject(root, sourceProject.title, provider),
        );
        if (!project) {
          hasUnavailableRoot = true;
          continue;
        }
        roots.set(importPathIdentity(root), root);
      }
      sourceProjects.set(sourceProject.id, {
        title: sourceProject.title,
        roots: [...roots.values()],
        hasUnavailableRoot,
      });
    }

    for (const session of catalog.sessions) {
      if (++sessionCount % 128 === 0) await setImmediate();
      if (!session.id.trim() || !isAbsoluteDirectory(session.cwd)) continue;
      const key = projectImportKey(provider, sourceHome, session.id);
      const resolved: ResolvedImportSession = {
        ...session,
        key,
        provider,
        ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
        sourceHome,
      };
      const identities = importSessionIdentities(resolved);
      if (identities.some((id) => offeredSessions.has(id))) continue;
      const explicitRoot = session.projectRoot;
      const cwd =
        (await availableImportEntry(() => canonical(session.cwd))) ??
        (explicitRoot && isAbsoluteDirectory(explicitRoot)
          ? await availableImportEntry(() => canonical(explicitRoot))
          : undefined);
      if (!cwd) continue;
      const sourceProject =
        provider !== "claudeAgent" && session.projectId
          ? sourceProjects.get(session.projectId)
          : undefined;
      let root: string | undefined;
      if (sourceProject?.roots.length === 1 && !sourceProject.hasUnavailableRoot) {
        // Explicit assignment survives even after a temporary worktree has been deleted.
        root = sourceProject.roots[0];
      } else if (sourceProject?.roots.length) {
        root = mostSpecificRoot(sourceProject.roots, cwd);
        if (!root) {
          const git = await availableImportEntry(() => gitWorkspace(cwd));
          if (git === undefined) continue;
          if (git?.worktree) {
            const originalCwd = path.join(git.root, path.relative(git.worktree, cwd));
            root = mostSpecificRoot(sourceProject.roots, originalCwd);
          }
        }
      }
      const assigned = root !== undefined;
      if (!root && explicitRoot && isAbsoluteDirectory(explicitRoot))
        root = await availableImportEntry(() => canonical(explicitRoot));
      if (!root) root = await availableImportEntry(() => derivedWorkspace(cwd));
      // Conversations Moss itself ran in its scratch or cache folders are not the person's projects.
      if (!root || excluded(root)) continue;
      const title = assigned ? sourceProject!.title : path.basename(root) || root;
      const project = await availableImportEntry(() => ensureProject(root, title, provider));
      if (!project) continue;
      project.threads.push(resolved);
      placement.set(resolved, project);
      for (const id of identities) offeredSessions.set(id, resolved);
    }
  }

  // Desktop children may run elsewhere (for example in a detached worktree), but their
  // sidebar row belongs to the project of the source thread, including for deeper nesting.
  const parentOf = (session: ResolvedImportSession) =>
    session.parentSessionId
      ? offeredSessions.get(`${session.provider}:${session.parentSessionId.toLowerCase()}`)
      : undefined;
  const movedFrom = new Set<ResolvedImportProject>();
  for (const [session, project] of placement) {
    const parent = parentOf(session);
    if (!parent) continue;
    const visited = new Set([session]);
    let root = parent;
    let ancestor: ResolvedImportSession | undefined = parent;
    while (ancestor && !visited.has(ancestor)) {
      visited.add(ancestor);
      root = ancestor;
      ancestor = parentOf(ancestor);
    }
    if (ancestor) continue; // Cyclic source metadata must not hide the rows.
    session.parentKey = parent.key;
    const parentProject = placement.get(root)!;
    if (parentProject === project) continue;
    project.threads = project.threads.filter((thread) => thread !== session);
    movedFrom.add(project);
    parentProject.threads.push(session);
  }
  for (const [identity, project] of projects) {
    if (
      movedFrom.has(project) &&
      !project.threads.some((thread) => thread.provider === "claudeAgent")
    )
      project.providers = project.providers.filter((provider) => provider !== "claudeAgent");
    if (!project.providers.length) {
      projects.delete(identity);
      continue;
    }
    project.providers = project.providers.toSorted();
    project.threads = project.threads.toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key),
    );
  }
  return [...projects.values()].toSorted(
    (left, right) => left.title.localeCompare(right.title) || left.key.localeCompare(right.key),
  );
}
