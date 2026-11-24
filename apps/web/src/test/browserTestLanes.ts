/**
 * Which browser lane owns which browser test file. One list for the Vitest browser configs and for
 * `bun run check` (tools/check/lib/plan.ts), so the Quick Check never hands a file to a project
 * whose config leaves it out ("No test files found"). No imports: tools/check reads it as is.
 * Paths are relative to apps/web.
 */

/** The browser test files of the stable configs (vitest.browser.config.ts). */
export const BROWSER_TEST_INCLUDE = [
  "src/components/**/*.browser.tsx",
  "src/hooks/**/*.browser.ts",
  "src/hooks/**/*.browser.tsx",
  "src/lib/**/*.browser.ts",
  "src/lib/**/*.browser.tsx",
  "src/whatsNew/**/*.browser.tsx",
] as const;

/** The full-app ChatView file: the CI config's `chat` project, in four case partitions. */
export const CHAT_VIEW_BROWSER_SPEC = "src/components/ChatView.browser.tsx";

/**
 * Drives the real Canvas Plate editor, which exists only after the pinned Canvas bundle is
 * built; `test:browser:page-editor` serves that bundle and runs it in the private CI's Desktop
 * Build job. The stable lanes exclude these files.
 */
export const PAGE_EDITOR_BROWSER_SPEC = "src/components/MossDataSpaceDestination.browser.tsx";
export const PAGE_EDITOR_BROWSER_SPECS = [
  PAGE_EDITOR_BROWSER_SPEC,
  "src/components/MossDataSpaceBoardStability.browser.tsx",
  "src/components/chat/RightDockCanvas.browser.tsx",
] as const;
