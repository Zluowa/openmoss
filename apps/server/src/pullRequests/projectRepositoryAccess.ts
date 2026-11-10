// Project and repository checks shared by the GitHub inbox and the pull request service. Every
// read or mutation names a project and a repository; both must be live and must belong together
// before any `gh` command runs.

import {
  GITHUB_PERSONAL_PROJECT_ID,
  GITHUB_PERSONAL_PROJECT_TITLE,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@moss/contracts";
import { Effect } from "effect";

import { GitHubCliError } from "../git/Errors";
import { isValidGitHubRepositoryNameWithOwner } from "../pullRequests.logic";
import type { GitHubRepositoryInventory } from "./repositoryResolution";

/**
 * The shell snapshot already excludes soft-deleted projects, so the field it omits is
 * known to be null. Restoring it keeps the shared PR helpers on one project type.
 */
export function liveProjectFromShell(shell: OrchestrationProjectShell): OrchestrationProject {
  return { ...shell, deletedAt: null };
}

/** gh setup failures that affect every repository; callers fail the whole request on these. */
// Boolean rather than a type predicate: it is called on values already typed GitHubCliError,
// where a predicate would narrow the false branch to `never`.
export function isGlobalGitHubCliError(error: unknown): boolean {
  return (
    error instanceof GitHubCliError &&
    (error.reason === "not-installed" || error.reason === "not-authenticated")
  );
}

export function isLiveRepositoryProject(project: OrchestrationProject): boolean {
  return project.kind === "project" && project.deletedAt === null;
}

const PERSONAL_PROJECT_EPOCH = new Date(0).toISOString();

/**
 * The built-in "My GitHub" scope as a project, so the pull request and issue panels can open the
 * person's own items with the same code as project items. `workspaceRoot` is only where gh runs
 * (Moss's own home); every gh call names its repository explicitly.
 */
export function personalGitHubProject(workspaceRoot: string): OrchestrationProject {
  return {
    id: GITHUB_PERSONAL_PROJECT_ID,
    kind: "project",
    title: GITHUB_PERSONAL_PROJECT_TITLE,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    spaceId: null,
    additionalFolders: [],
    createdAt: PERSONAL_PROJECT_EPOCH,
    updatedAt: PERSONAL_PROJECT_EPOCH,
    deletedAt: null,
  };
}

export function makeProjectRepositoryAccess(dependencies: {
  readonly listProjects: () => Effect.Effect<ReadonlyArray<OrchestrationProject>, unknown>;
  readonly resolveProjectRepositories: (
    project: OrchestrationProject,
  ) => Effect.Effect<GitHubRepositoryInventory, unknown>;
  /** The "My GitHub" scope ({@link personalGitHubProject}); omitted where it is not offered. */
  readonly personalProject?: OrchestrationProject;
}) {
  const personal = dependencies.personalProject;
  const findProject = (projectId: ProjectId) =>
    personal && projectId === personal.id
      ? Effect.succeed(personal)
      : dependencies.listProjects().pipe(
          Effect.flatMap((allProjects) => {
            const project = allProjects.find(
              (candidate) => candidate.id === projectId && isLiveRepositoryProject(candidate),
            );
            return project ? Effect.succeed(project) : Effect.fail(new Error("Project not found."));
          }),
        );

  const validateRepository = (repository: string) => {
    const normalized = repository.trim();
    return isValidGitHubRepositoryNameWithOwner(normalized)
      ? Effect.succeed(normalized)
      : Effect.fail(new Error("Invalid GitHub repository identity."));
  };

  /** Checks against the project's full remote inventory, not just the repository the inbox
   * lists, so pull request panels opened from a fork's upstream keep working. */
  const validateProjectRepository = (project: OrchestrationProject, repositoryInput: string) =>
    Effect.gen(function* () {
      const repository = yield* validateRepository(repositoryInput);
      // The person's own items can live in any repository their gh account can see; GitHub
      // itself decides access, as it would for the same gh command in a terminal.
      if (personal && project.id === personal.id) return repository;
      const inventory = yield* dependencies.resolveProjectRepositories(project);
      if (!inventory.authoritative) {
        return yield* Effect.fail(new Error("GitHub repository inventory is unavailable."));
      }
      const matched = inventory.repositories.find(
        (candidate) => candidate.nameWithOwner.toLowerCase() === repository.toLowerCase(),
      );
      if (!matched) {
        return yield* Effect.fail(
          new Error("GitHub repository does not belong to the selected project."),
        );
      }
      return matched.nameWithOwner;
    });

  return { findProject, validateRepository, validateProjectRepository };
}
