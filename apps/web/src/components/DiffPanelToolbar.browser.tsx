import "../index.css";

import { TurnId } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { getAppTypographyScale } from "../lib/appTypography";
import { gitQueryKeys } from "../lib/gitReactQuery";
import { DiffPanelToolbar } from "./DiffPanelToolbar";

const noop = () => {};

afterEach(() => {
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.windowTranslucency;
  for (const token of ["ui", "ui-sm", "ui-xs"]) {
    document.documentElement.style.removeProperty(`--app-font-size-${token}`);
  }
});

// 404px is the dock's minimum width; 352px is a split pane's panel, where the full row of
// tools used to pile onto each other.
it.each([
  { turn: false, width: 404 },
  { turn: true, width: 404 },
  { turn: false, width: 352 },
  { turn: true, width: 352 },
])(
  "keeps diff actions reachable and apart at $width px and the largest UI font (turn: $turn)",
  async ({ turn, width }) => {
    await page.viewport(1280, 800);
    const onReload = vi.fn();
    const onClose = vi.fn();
    const client = new QueryClient();
    client.setQueryData(gitQueryKeys.branches("/fixture"), {
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        {
          name: "feature/work",
          current: true,
          isDefault: false,
          isRemote: false,
          worktreePath: null,
        },
      ],
    });
    client.setQueryData(gitQueryKeys.status("/fixture"), {
      branch: "feature/work",
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 1234, deletions: 567 },
      hasUpstream: true,
      upstreamBranch: "origin/feature/work",
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    });
    const mounted = await render(
      <QueryClientProvider client={client}>
        <div data-testid="toolbar" style={{ width, height: 40 }}>
          <DiffPanelToolbar
            activeCwd="/fixture"
            activeThreadId={null}
            viewSource={
              turn
                ? { kind: "turn", turnId: TurnId.makeUnsafe("long-turn") }
                : { kind: "repo", scope: "workingTree" }
            }
            turnScopeIntent="all"
            scopeFileCounts={{ workingTree: 12 }}
            activeStats={{ additions: 1234, deletions: 567 }}
            orderedTurnDiffSummaries={[]}
            inferredCheckpointTurnCountByTurnId={{ "long-turn": 123456 }}
            selectedTurnId={turn ? TurnId.makeUnsafe("long-turn") : null}
            timestampFormat="locale"
            renderableFiles={[]}
            selectedFilePath={null}
            fileTreeOpen
            resolvedTheme="light"
            diffRenderMode="split"
            diffWordWrap={false}
            diffIgnoreWhitespace={false}
            diffCopyText={null}
            isDiffCopied={false}
            diffCopyLabel="Copy diff"
            reloading={false}
            allFilesCollapsed={false}
            changeMarkersEnabled={false}
            compareRef={null}
            changeNavigation={{
              canGoToPrevious: false,
              canGoToNext: true,
              previousShortcutLabel: null,
              nextShortcutLabel: null,
              onGoToPrevious: noop,
              onGoToNext: noop,
            }}
            onChangeMarkersEnabledChange={noop}
            onSelectRepoScope={noop}
            onSelectCompareRef={noop}
            onSelectAllTurns={noop}
            onSelectLastTurn={noop}
            onSelectTurn={noop}
            onSelectFile={noop}
            onToggleFileTree={noop}
            onDiffRenderModeChange={noop}
            onDiffWordWrapChange={noop}
            onDiffIgnoreWhitespaceChange={noop}
            onCopyDiff={noop}
            onReload={onReload}
            onToggleCollapseAll={noop}
            onClosePanel={onClose}
          />
        </div>
      </QueryClientProvider>,
    );
    const root = mounted.getByTestId("toolbar").element() as HTMLElement;
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      for (const translucency of ["none", "window"]) {
        document.documentElement.dataset.windowTranslucency = translucency;
        for (const font of [13, 18]) {
          const scale = getAppTypographyScale(font);
          for (const [token, value] of Object.entries({
            ui: scale.uiPx,
            "ui-sm": scale.uiSmPx,
            "ui-xs": scale.uiXsPx,
          })) {
            document.documentElement.style.setProperty(`--app-font-size-${token}`, `${value}px`);
          }
          await vi.waitFor(() => {
            const rect = root.getBoundingClientRect();
            const buttons = [...root.querySelectorAll("button")];
            for (const button of buttons) {
              const bounds = button.getBoundingClientRect();
              expect(
                bounds.right,
                `${button.ariaLabel}, ${font}, ${dark}, ${translucency}`,
              ).toBeLessThanOrEqual(rect.right + 1);
              expect(bounds.left).toBeGreaterThanOrEqual(rect.left - 1);
            }
            // Side by side, never on top of each other (the split-pane pile-up).
            for (const [index, button] of buttons.entries()) {
              const a = button.getBoundingClientRect();
              for (const other of buttons.slice(index + 1)) {
                const b = other.getBoundingClientRect();
                expect(
                  Math.min(a.right, b.right) - Math.max(a.left, b.left),
                  `${button.ariaLabel} over ${other.ariaLabel}, ${font}`,
                ).toBeLessThanOrEqual(0.5);
              }
            }
          });
        }
      }
    }
    await expect
      .element(page.getByRole("button", { name: "Choose diff source" }))
      .toHaveAccessibleDescription(
        turn ? "Turn diff, +1234 -567" : "Working tree, 12 files, +1234 -567",
      );
    // At the dock's minimum width the change, file tree and turn tools wait in ···.
    expect(root.querySelector("[data-diff-toolbar]")?.getAttribute("data-diff-toolbar")).toBe(
      "compact",
    );
    await page.getByRole("button", { name: "Diff view options" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Previous change" })).toBeDisabled();
    await expect.element(page.getByRole("menuitem", { name: "Next change" })).toBeEnabled();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Show file tree" }))
      .toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: "Reload diff" }).click();
    expect(onReload).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Close file view" }).click();
    expect(onClose).toHaveBeenCalledOnce();
    // With room for them, they are buttons in the row again.
    root.style.width = "640px";
    await vi.waitFor(() =>
      expect(root.querySelector("[data-diff-toolbar]")?.getAttribute("data-diff-toolbar")).toBe(
        "full",
      ),
    );
    await expect.element(page.getByRole("button", { name: "Previous change" })).toBeDisabled();
    await mounted.unmount();
  },
);
