/**
 * Moss unified-source layout — the single source for every `.moss` path
 * literal in the monorepo.
 *
 * Ported from 1code `moss-source/layout.ts` + `types.ts` with moss-specific
 * semantics:
 *
 * - `workspaceConfig` points at the existing canonical `.moss/config.json`
 *   already consumed by `mossConfigProjection`/`mossLaunchPlan`. 1code keeps a
 *   separate `source/workspace.yaml`; moss must not grow a second workspace
 *   config source.
 * - `pluginsRoot` is the canonical plugin bundle root. Bootstrap creates the
 *   directory but never invents a plugin or rewrites an imported bundle.
 * - Control-plane read-only paths (projections output, provider-runtime replay
 *   fixtures, mission sentinel, loop ledger) are exposed so server and scripts
 *   stop hardcoding `.moss` literals, but {@link getMossBootstrapDirectories}
 *   never creates them.
 */
import { dirname, isAbsolute, join, relative } from "node:path";

export const MOSS_SOURCE_VERSION = 1;
export const MOSS_ROOT_DIR = ".moss";

/**
 * Repo-root-relative `.moss` paths (posix-style separators; safe as `path.join`
 * input and stable for display/report strings). This map is the only place in
 * the monorepo allowed to spell `.moss` path literals.
 */
export const MOSS_RELATIVE_PATHS = {
  root: MOSS_ROOT_DIR,
  sourceInstruction: `${MOSS_ROOT_DIR}/source/moss.md`,
  workspaceConfig: `${MOSS_ROOT_DIR}/config.json`,
  memoryRoot: `${MOSS_ROOT_DIR}/memory`,
  skillsRoot: `${MOSS_ROOT_DIR}/skills`,
  pluginsRoot: `${MOSS_ROOT_DIR}/plugins`,
  mcpConfig: `${MOSS_ROOT_DIR}/mcp/config.json`,
  hooksRoot: `${MOSS_ROOT_DIR}/hooks`,
  subagentsRoot: `${MOSS_ROOT_DIR}/subagents`,
  providersConfig: `${MOSS_ROOT_DIR}/providers.yaml`,
  projectionsRoot: `${MOSS_ROOT_DIR}/projections`,
  projectionsManifest: `${MOSS_ROOT_DIR}/projections/manifest.json`,
  providerRuntimeFixturesRoot: `${MOSS_ROOT_DIR}/fixtures/provider-runtime`,
  missionFile: `${MOSS_ROOT_DIR}/mission.md`,
  ledgerRoot: `${MOSS_ROOT_DIR}/ledger`,
} as const;

export interface MossSourceLayout {
  readonly version: typeof MOSS_SOURCE_VERSION;
  readonly projectPath: string;
  readonly root: string;
  /** Canonical workspace rules file bootstrapped under `source/`. */
  readonly sourceInstruction: string;
  /** Canonical Moss config (`MossCanonicalConfig` JSON) consumed by the control plane. */
  readonly workspaceConfig: string;
  readonly memoryRoot: string;
  readonly skillsRoot: string;
  /** Canonical Moss plugins root (`.moss/plugins`), projected into engine plugin dirs. */
  readonly pluginsRoot: string;
  readonly mcpConfig: string;
  readonly hooksRoot: string;
  readonly subagentsRoot: string;
  readonly providersConfig: string;
  /** Control-plane projection output root (managed by projection tooling, not bootstrap). */
  readonly projectionsRoot: string;
  /** Projection provenance manifest written by the projection materializer only (never bootstrap). */
  readonly projectionsManifest: string;
  /** Provider runtime replay fixture root (read-only input of the replay gate). */
  readonly providerRuntimeFixturesRoot: string;
  /** Mission sentinel used to resolve the Moss repo root. */
  readonly missionFile: string;
  /** Loop ledger root owned by the existing final-shell parity line; never bootstrapped. */
  readonly ledgerRoot: string;
}

export function getMossSourceLayout(projectPath: string): MossSourceLayout {
  return {
    version: MOSS_SOURCE_VERSION,
    projectPath,
    root: join(projectPath, MOSS_RELATIVE_PATHS.root),
    sourceInstruction: join(projectPath, MOSS_RELATIVE_PATHS.sourceInstruction),
    workspaceConfig: join(projectPath, MOSS_RELATIVE_PATHS.workspaceConfig),
    memoryRoot: join(projectPath, MOSS_RELATIVE_PATHS.memoryRoot),
    skillsRoot: join(projectPath, MOSS_RELATIVE_PATHS.skillsRoot),
    pluginsRoot: join(projectPath, MOSS_RELATIVE_PATHS.pluginsRoot),
    mcpConfig: join(projectPath, MOSS_RELATIVE_PATHS.mcpConfig),
    hooksRoot: join(projectPath, MOSS_RELATIVE_PATHS.hooksRoot),
    subagentsRoot: join(projectPath, MOSS_RELATIVE_PATHS.subagentsRoot),
    providersConfig: join(projectPath, MOSS_RELATIVE_PATHS.providersConfig),
    projectionsRoot: join(projectPath, MOSS_RELATIVE_PATHS.projectionsRoot),
    projectionsManifest: join(projectPath, MOSS_RELATIVE_PATHS.projectionsManifest),
    providerRuntimeFixturesRoot: join(projectPath, MOSS_RELATIVE_PATHS.providerRuntimeFixturesRoot),
    missionFile: join(projectPath, MOSS_RELATIVE_PATHS.missionFile),
    ledgerRoot: join(projectPath, MOSS_RELATIVE_PATHS.ledgerRoot),
  };
}

export function toMossProjectPath(projectPath: string, filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  return relative(projectPath, filePath);
}

/**
 * Directories `ensureMossSource` may create. Control-plane paths
 * (projections/fixtures/mission/ledger) are intentionally excluded: bootstrap
 * must never create or touch them.
 */
export function getMossBootstrapDirectories(layout: MossSourceLayout): ReadonlyArray<string> {
  return [
    dirname(layout.sourceInstruction),
    layout.memoryRoot,
    layout.skillsRoot,
    layout.pluginsRoot,
    dirname(layout.mcpConfig),
    layout.hooksRoot,
    layout.subagentsRoot,
  ];
}
