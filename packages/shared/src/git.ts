/**
 * Sanitize an arbitrary string into a valid, lowercase git branch fragment.
 * Strips quotes, collapses separators, limits to 64 chars.
 */
export const WORKTREE_BRANCH_PREFIX = "moss";
const LEGACY_WORKTREE_BRANCH_PREFIXES = ["dpcode", "t3code"] as const;
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(
  `^(${[WORKTREE_BRANCH_PREFIX, ...LEGACY_WORKTREE_BRANCH_PREFIXES].join("|")})\\/[0-9a-f]{8}$`,
);
const LEGACY_THREAD_PLACEHOLDER_PREFIX = String.fromCharCode(115, 121, 110, 97, 114, 97);
const LEGACY_THREAD_PLACEHOLDER_PATTERN = new RegExp(
  `^${LEGACY_THREAD_PLACEHOLDER_PREFIX}\\/[0-9a-f]{8}$`,
);

export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

/**
 * Sanitize a string into a `feature/…` branch name.
 * Preserves an existing `feature/` prefix or slash-separated namespace.
 */
export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  if (sanitized.includes("/")) {
    return sanitized.startsWith("feature/") ? sanitized : `feature/${sanitized}`;
  }
  return `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";
const MOSS_BRANCH_FALLBACK = "update";

function resolveUniqueBranchName(
  existingBranchNames: readonly string[],
  resolvedBase: string,
): string {
  const existingNames = new Set(existingBranchNames.map((branch) => branch.toLowerCase()));

  const conflictComponent = (name: string): number | undefined => {
    const components = name.split("/");
    for (let index = 0; index < components.length; index += 1) {
      if (existingNames.has(components.slice(0, index + 1).join("/"))) {
        return index;
      }
    }
    if ([...existingNames].some((branch) => branch.startsWith(`${name}/`))) {
      return components.length - 1;
    }
    return undefined;
  };

  let component = conflictComponent(resolvedBase);
  if (component === undefined) return resolvedBase;

  const components = resolvedBase.split("/");
  let suffix = 2;
  while (true) {
    const candidateComponents = [...components];
    candidateComponents[component] = `${components[component]}-${suffix}`;
    const candidate = candidateComponents.join("/");
    const conflict = conflictComponent(candidate);
    if (conflict === undefined) return candidate;
    // A suffixed candidate can encounter a shorter occupied namespace.
    if (conflict < component) {
      component = conflict;
      suffix = 2;
    } else {
      suffix += 1;
    }
  }
}

/**
 * Resolve a unique `feature/…` branch name that doesn't collide with
 * any existing branch. Appends a numeric suffix when needed.
 */
export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  return resolveUniqueBranchName(existingBranchNames, resolvedBase);
}

export function buildMossBranchName(preferredBranch?: string | null): string {
  const normalizedExisting =
    preferredBranch?.trim().replace(/^(codex|t3code|dpcode|moss|moss)\//i, "") ?? "";
  return `${WORKTREE_BRANCH_PREFIX}/${sanitizeBranchFragment(
    normalizedExisting || MOSS_BRANCH_FALLBACK,
  )}`;
}

export function resolveUniqueMossBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string | null,
): string {
  const resolvedBase = buildMossBranchName(preferredBranch);
  return resolveUniqueBranchName(existingBranchNames, resolvedBase);
}

export function isTemporaryWorktreeBranch(branch: string): boolean {
  // Legacy upstream temp branches share the same 8-hex shape under their own
  // namespace and must rename/clean up identically.
  return isThreadMetadataPlaceholderBranch(branch);
}

/**
 * Any transient branch a thread may briefly point at during worktree
 * bootstrap/rename: this build's temporary worktree branches plus legacy
 * placeholder namespaces. Semantic branches must never regress to these.
 */
export function isTransientThreadBranch(branch: string): boolean {
  return isThreadMetadataPlaceholderBranch(branch);
}

export function buildTemporaryWorktreeBranchName(): string {
  const token = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

function isThreadMetadataPlaceholderBranch(branch: string): boolean {
  const normalized = branch.trim().toLowerCase();
  return (
    TEMP_WORKTREE_BRANCH_PATTERN.test(normalized) ||
    LEGACY_THREAD_PLACEHOLDER_PATTERN.test(normalized)
  );
}

// Preserve semantic thread branches when transient worktree placeholders briefly
// appear in git status during rename/bootstrap transitions.
export function resolveThreadBranchRegressionGuard(input: {
  currentBranch: string | null;
  nextBranch: string | null;
}): string | null {
  if (
    input.currentBranch !== null &&
    input.nextBranch !== null &&
    !isThreadMetadataPlaceholderBranch(input.currentBranch) &&
    isThreadMetadataPlaceholderBranch(input.nextBranch)
  ) {
    return input.currentBranch;
  }

  return input.nextBranch;
}

export function mergeGitStatusParts<Local extends object, Remote extends object>(
  local: Local,
  remote: Remote | null,
): Local & Remote {
  return {
    ...local,
    ...(remote ?? {
      hasUpstream: false,
      upstreamBranch: null,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  } as Local & Remote;
}
