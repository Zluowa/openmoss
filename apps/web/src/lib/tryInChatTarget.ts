// FILE: tryInChatTarget.ts
// Purpose: Pure resolution for the plugin-panel "Try in chat" / "Create" actions
//          so they open a chat thread DIRECTLY (like Codex) instead of gating on
//          "create a project first". Codex opens a projectless thread seeded with
//          `prefillCwd = workspaceRoots[0]` (unless "/"/absent); Moss's
//          `handleNewThread` requires a ProjectId, so with no project we bootstrap
//          one from the workspace cwd via `createOrRecoverProjectFromPath`.
// Layer: Web lib (pure, no React/IO — I/O lives in usePluginResourceActions)
// Exports: resolvePrefillCwd, planProjectResolution, resolveEnsuredProjectId,
//          createSingleFlight, buildTryInChatSeed, buildCreatorPrompt

import type {
  ProjectId,
  ProviderKind,
  ProviderMentionReference,
  ProviderSkillReference,
} from "@synara/contracts";

import type { ResourceDetail } from "~/components/PluginResourceDetailDialog";
import { formatComposerMentionToken, skillMentionPrefix } from "./composerMentions";
import { MOSS_APPS_MARKETPLACE_NAME } from "./mossAppsPlugins";

/**
 * Codex's prefillCwd / usable-cwd rule: the first workspace root, unless it is
 * the filesystem root "/" or absent (then undefined — no cwd is forced). Also
 * the guard that stops a stray "/" server cwd from spawning a root project.
 */
export function resolvePrefillCwd(
  workspaceRoots: ReadonlyArray<string | null | undefined>,
): string | undefined {
  const first = workspaceRoots[0]?.trim();
  if (!first || first === "/") return undefined;
  return first;
}

export type ProjectResolutionPlan =
  | { readonly kind: "use-existing"; readonly projectId: ProjectId }
  | { readonly kind: "create-from-cwd"; readonly workspaceRoot: string }
  | { readonly kind: "abort"; readonly reason: "no-cwd" };

/**
 * Decide how a "Try in chat"/"Create" action gets its project:
 *  - reuse the active project when present (PluginLibrary already folds the
 *    first project into `activeProjectId`);
 *  - otherwise bootstrap one from a usable workspace cwd;
 *  - abort only when there is no project and no usable cwd (keeps the toast).
 * A "/" or blank cwd counts as no cwd (Codex parity — never root a project at "/").
 */
export function planProjectResolution(input: {
  readonly activeProjectId: ProjectId | null;
  readonly cwd: string | null;
}): ProjectResolutionPlan {
  if (input.activeProjectId) return { kind: "use-existing", projectId: input.activeProjectId };
  const workspaceRoot = resolvePrefillCwd([input.cwd]);
  if (workspaceRoot) return { kind: "create-from-cwd", workspaceRoot };
  return { kind: "abort", reason: "no-cwd" };
}

/**
 * Trust only a MATERIALIZED project row from `createOrRecoverProjectFromPath`:
 * on the duplicate-recovery path `projectId` can be a parsed id that is not yet
 * in the store, and `handleNewThread` reads project defaults from the store —
 * so we return null (and keep the retry toast) unless `project` is present.
 */
export function resolveEnsuredProjectId(result: {
  readonly project: { readonly id: ProjectId } | null;
}): ProjectId | null {
  return result.project ? result.project.id : null;
}

/**
 * The composer seed a "Try in chat" action writes into a fresh thread's draft —
 * mirroring exactly what Codex's composer picker does: a chip TOKEN in the prompt
 * STRING plus the matching reference in `skills`/`mentions`. BOTH are required.
 * The visible chip is produced only by re-tokenizing the prompt (`$name`/`/name`
 * for skills, `@name` for a plugin mention), and on send Moss runs
 * `filterPromptSkillReferences` / `filterPromptProviderMentionReferences`, which
 * DROP any reference whose token is absent from the text. So a reference set
 * without its prompt token is silently discarded (no chip, not even attached) —
 * the earlier bug, where a skill was seeded as the `@name` mention prefix.
 */
export interface TryInChatSeed {
  readonly prompt: string;
  readonly skills: ProviderSkillReference[];
  readonly mentions: ProviderMentionReference[];
}

export function buildTryInChatSeed(
  resource: ResourceDetail,
  provider: ProviderKind,
  promptOverride?: string,
): TryInChatSeed {
  switch (resource.kind) {
    case "skill":
      // Skills are `$name` / `/name` tokens (provider-specific prefix via
      // `skillMentionPrefix`) — the same string the composer skill picker inserts,
      // NOT an `@name` mention. The trailing space closes the token so the
      // splitter emits a `skill` segment → `ComposerSkillNode` chip.
      return {
        prompt: `${skillMentionPrefix(provider)}${resource.skill.name} `,
        skills: [{ name: resource.skill.name, path: resource.skill.path }],
        mentions: [],
      };
    case "plugin": {
      // A Moss app is no CLI plugin a mention could resolve; its tools reach
      // every agent through the Moss Apps connector, so the prompt names it.
      if (resource.marketplaceName === MOSS_APPS_MARKETPLACE_NAME) {
        const name = resource.plugin.interface?.displayName ?? resource.plugin.name;
        return { prompt: promptOverride ?? `${name} `, skills: [], mentions: [] };
      }
      // Plugins are `@name` mentions backed by a `plugin://name@marketplace`
      // reference; that reference is what makes the composer render the "plugin"
      // chip variant (`resolveMentionChipKind`) instead of a plain path chip. The
      // plugin's defaultPrompt trails the chip (`[@name](uri) ${defaultPrompt}`).
      const mentionToken = formatComposerMentionToken(resource.plugin.name);
      const defaultPrompt = resource.plugin.interface?.defaultPrompt;
      const trailing =
        promptOverride ??
        (defaultPrompt && defaultPrompt.length > 0 ? defaultPrompt.join("\n") : "");
      return {
        prompt: trailing ? `${mentionToken} ${trailing}` : `${mentionToken} `,
        skills: [],
        mentions: [
          {
            name: resource.plugin.name,
            path: `plugin://${resource.plugin.name}@${resource.marketplaceName}`,
          },
        ],
      };
    }
    case "mcp":
      // No MCP composer chip exists — seed a plain instruction as before.
      return {
        prompt: `Use the ${resource.server.name} MCP server to `,
        skills: [],
        mentions: [],
      };
  }
}

/**
 * The composer prompt for a "Create skill/plugin" action: the creator skill's
 * own chip token (so the attached `skill-creator`/`plugin-creator` renders as a
 * chip AND survives `filterPromptSkillReferences` on send), optionally followed
 * by the first-use instruction. Pass `firstUsePrompt: null` after the first open
 * to seed just the chip.
 */
export function buildCreatorPrompt(input: {
  readonly provider: ProviderKind;
  readonly skillName: string;
  readonly firstUsePrompt: string | null;
}): string {
  const token = `${skillMentionPrefix(input.provider)}${input.skillName} `;
  return input.firstUsePrompt ? `${token}${input.firstUsePrompt}` : token;
}

/**
 * Resolve the workspace boundary for an explicitly dispatched Creator turn.
 *
 * The normal Plugins "Create" action deliberately opens an unsent draft. A
 * caller that wants to run the Creator must opt into a task-owned workspace so
 * a background test or automation cannot accidentally write into the user's
 * current project. Keep this helper browser-safe (no Node `path` import) and
 * reject roots, relative paths, and traversal segments before the path reaches
 * thread.create.
 */
export function resolveCreatorTaskWorkspace(workspace: string | null | undefined): string | null {
  const value = workspace?.trim() ?? "";
  if (!value || value === "/" || value === "\\") return null;
  // Accept POSIX absolute paths, drive-letter paths, and UNC paths. A relative
  // path has no stable ownership boundary for an agent turn.
  const absolute =
    value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
  if (!absolute) return null;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return null;
  // Refuse a drive root for the same reason as `/`: it is too broad to be a
  // task-owned workspace. `C:\\` is accepted only when it names a child.
  if (/^[A-Za-z]:[\\/]?$/.test(value)) return null;
  return value;
}

/**
 * A single-flight guard for actions that navigate away (open a thread). While a
 * run is in flight, further `run()` calls resolve to `true` (handled/ignored)
 * WITHOUT invoking `fn` — so a double-click can't mint two draft threads or fire
 * a spurious error toast. Resets after the in-flight call settles (or throws).
 */
export function createSingleFlight(): {
  run: (fn: () => Promise<boolean>) => Promise<boolean>;
} {
  let inFlight = false;
  return {
    async run(fn) {
      if (inFlight) return true;
      inFlight = true;
      try {
        return await fn();
      } finally {
        inFlight = false;
      }
    },
  };
}
