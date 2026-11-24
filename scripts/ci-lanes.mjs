// FILE: ci-lanes.mjs
// Purpose: Which CI test lanes a change needs, from the paths it changes. The gates poller
//          (scripts/public-mirror/pr-gates.ts) computes them on the PC from the pull request's own
//          diff against its merge base with main and writes them into the mirror snapshot's
//          commit message as a `Moss-Lanes:` line; the test jobs of .github/workflows/ci.yml read that
//          line. A commit without that line (a push to main, a manual run, any other snapshot)
//          runs every lane: that full run after each merge is where the lanes a pull request
//          skipped still run before a release.
// Layer: CI tooling (plain JavaScript: the poller loads it from main's tree as it is)
// Exports: lanesFor, lanesLine, quickCovers, chatCovers, ALL_LANES, ALL_UNIT_LANES

export const ALL_UNIT_LANES = [
  "web-1",
  "web-2",
  "web-3",
  "desktop",
  "server-1",
  "server-2",
  "server-3",
  "shared",
];

/** @typedef {{ unit: readonly string[], browser: boolean, windows: boolean }} Lanes */

/** @type {Lanes} */
export const ALL_LANES = { unit: ALL_UNIT_LANES, browser: true, windows: true };

const WEB = ["web-1", "web-2", "web-3"];
const SERVER = ["server-1", "server-2", "server-3"];
/** @type {Lanes} */
const NOTHING = { unit: [], browser: false, windows: false };
/**
 * The shared component set, the global styles, the theme and localization.tsx (the translate
 * code every screen runs). The translation tables in localization/ are not here: the Quick Check
 * picks their tests by the strings a change touches (tools/check).
 */
const WEB_SHARED_PARTS =
  /^apps\/web\/src\/(components\/ui\/|index\.css$|theme\/|localization\.tsx$)/;

/**
 * The CI's own machinery: the quarantine list's loader (every lane), the Quick Check and this lane
 * picker, and the scripts the workflow's steps run (ci-lanes.test.mjs checks the list against
 * ci.yml). A change to any of them runs every lane.
 */
const CI_MACHINERY = new RegExp(
  "^(tools/(test-quarantine|check)/|scripts/(ci-[^/]+|node-pty-smoke\\.mjs|release-smoke\\.ts|" +
    "check-migration-lineage\\.ts|build-windows-job-launcher\\.mjs|moss-managed-plugin-smoke\\.ts|" +
    "verify-packaged-desktop-startup\\.ts|desktop-stage-lock/|gha/|lib/bundled-codex-runtime\\.ts))",
);

/**
 * @typedef {{ selection?: { rootConfig?: string[] }, steps?: { name: string, status: string }[] }} QuickPlan
 * The Quick Check's dry run (`bun run check --dry-run --json ...`, with the same base, budget and
 * browser limit as the job itself).
 */

/** @param {QuickPlan} report @param {string} name */
function leaves(report, name) {
  return (report.steps ?? []).some((step) => step.name === name && step.status === "left");
}

/**
 * Whether the Quick Check runs every unit and component browser test the change reaches: false
 * for a wide change over its time budget, more component files than its limit, or a root
 * configuration change. When false, the web lanes and the component shards run.
 * @param {QuickPlan} report
 */
export function quickCovers(report) {
  if ((report.selection?.rootConfig ?? []).length > 0) return false;
  return !leaves(report, "tests") && !leaves(report, "browser");
}

/**
 * Whether no chat-project browser test (the ChatView.*.browser.tsx files, which the Quick Check never runs:
 * it needs the four chat partitions) is reached. When false, the chat partitions run.
 * @param {QuickPlan} report
 */
export function chatCovers(report) {
  if ((report.selection?.rootConfig ?? []).length > 0) return false;
  return !leaves(report, "tests") && !leaves(report, "browser (chat)");
}

/**
 * What one changed path needs. The always-on jobs (format, lint, typecheck, the changed-files
 * check, migration lineage) run regardless. Anything not named here (root configs, the lockfile,
 * workflows, patches, the quarantine list, shared packages) takes every lane.
 */
/** @param {string} path @returns {Lanes | null} */
function lanesForPath(path) {
  if (CI_MACHINERY.test(path)) return ALL_LANES;
  // Words only: no test reads them.
  if (/^docs\//.test(path) || /^[^/]+\.md$/.test(path) || path.startsWith(".vscode/")) return null;
  // A web source file outside the shared parts: the Quick Check runs the unit and browser test
  // files that import it (tools/check). When that selection is too wide for the Quick Check, the
  // workflow runs the full web lanes after all (see quickCovers).
  if (path.startsWith("apps/web/src/") && !WEB_SHARED_PARTS.test(path)) return NOTHING;
  // Shared parts reach nearly every screen, and the web package's own configuration reaches every
  // test: the whole web suite.
  if (path.startsWith("apps/web/")) return { unit: WEB, browser: true, windows: false };
  // The desktop shell starts the server and its tests import server code.
  if (path.startsWith("apps/server/") || path.startsWith("supabase/functions/")) {
    return { unit: [...SERVER, "desktop"], browser: false, windows: true };
  }
  if (path.startsWith("apps/desktop/")) return { unit: ["desktop"], browser: false, windows: true };
  // Root scripts, tools and agent skills are tested in the shared lane (and by the Quick Check).
  if (/^(scripts|tools|\.agents)\//.test(path))
    return { unit: ["shared"], browser: false, windows: false };
  return ALL_LANES;
}

/** @param {readonly string[]} paths @returns {Lanes} */
export function lanesFor(paths) {
  const unit = new Set();
  let browser = false;
  let windows = false;
  for (const path of paths) {
    const needs = lanesForPath(path);
    if (!needs) continue;
    for (const lane of needs.unit) unit.add(lane);
    browser ||= needs.browser;
    windows ||= needs.windows;
  }
  return { unit: ALL_UNIT_LANES.filter((lane) => unit.has(lane)), browser, windows };
}

/**
 * The commit-message line the workflow reads. Each token ends in ";" so one lane's name is never
 * a prefix match for another's (GitHub's contains() is a substring test).
 * @param {Lanes} lanes
 */
export function lanesLine(lanes) {
  const tokens = [
    ...lanes.unit.map((lane) => `unit:${lane};`),
    ...(lanes.browser ? ["browser;"] : []),
    ...(lanes.windows ? ["windows;"] : []),
  ];
  return `Moss-Lanes: ${tokens.join(" ") || "none;"}`;
}

// CLI for the Static Checks job: node scripts/ci-lanes.mjs --quick-plan <dry-run report.json>
// prints `quick_covers=` and `chat_covers=` lines for $GITHUB_OUTPUT.
const planAt = process.argv.indexOf("--quick-plan");
if (planAt > 1 && process.argv[planAt + 1]) {
  const { readFileSync } = await import("node:fs");
  const report = JSON.parse(readFileSync(process.argv[planAt + 1], "utf8"));
  console.log(`quick_covers=${quickCovers(report)}`);
  console.log(`chat_covers=${chatCovers(report)}`);
  for (const step of report.steps ?? []) {
    if (step.status === "left")
      console.error(`left to the full lanes: ${step.name}: ${step.detail}`);
  }
}
