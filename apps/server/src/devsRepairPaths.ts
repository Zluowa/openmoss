/**
 * Path policy for public repair jobs, shared by the agent's workspace tools and the controller.
 *
 * The workspace tools are a convenience, not the boundary: Codex can also edit files with its
 * built-in patch tool, so the controller applies the same policy to every changed path itself.
 */

/** Never read or written by the agent: Git metadata, agent configuration and secrets. */
const HIDDEN = /(?:^|\/)(?:\.git|\.github|\.codex|\.agents|\.aws|\.env(?:\.[^/]*)?)(?:\/|$)/i;

/**
 * Never written. Git and Git LFS read `.git*` files (attributes, modules, ignore rules) and
 * `.lfsconfig` as configuration, which can run filters or send credentials elsewhere.
 * Workflows, agent instructions, dependencies and verification configuration are protected
 * because the trusted checks depend on them.
 */
const PROTECTED =
  /(?:^|\/)(?:\.git[^/]*|\.lfsconfig|\.github|node_modules|patches|\.moss|\.turbo|dist|third_party)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|package\.json|bun\.lock|bunfig\.toml|turbo\.json|tsconfig[^/]*\.json|vitest[^/]*\.[cm]?[jt]s|\.editorconfig|\.npmrc|\.oxlintrc\.jsonc?|\.oxfmtrc\.jsonc?)$/i;

/** The agent's report to the controller. It is read, never committed. */
export const DEVS_RESULT_FILE = "MOSS_DEVS_RESULT.md";

export function isHiddenRepairPath(name: string): boolean {
  return HIDDEN.test(name.replaceAll("\\", "/"));
}

/** True when a public repair may not add, change or delete this repository path. */
export function isProtectedRepairPath(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  return HIDDEN.test(normalized) || PROTECTED.test(normalized);
}

/**
 * Windows resolves `name.`, `name ` and `name::$DATA` to `name`, so such a segment could
 * alias a protected file that the patterns above would not recognize.
 */
export function hasAmbiguousPathSegment(name: string): boolean {
  return name
    .replaceAll("\\", "/")
    .split("/")
    .some(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        (/[.\s]$/.test(segment) ||
          /[:<>"|?*]/.test(segment) ||
          [...segment].some((character) => character.charCodeAt(0) < 32)),
    );
}
