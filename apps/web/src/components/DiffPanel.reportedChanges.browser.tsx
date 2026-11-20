// FILE: DiffPanel.reportedChanges.browser.tsx
// Purpose: The turn diff must never hang on a skeleton when Moss has no
//          before-turn snapshot (missing baseline, folder outside Git): it shows
//          the files the agent reported and the selected file's content.
// Layer: Focused component integration tests

import "../index.css";

import { CheckpointRef, TurnId, type NativeApi } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../store";
import type { SplitViewPanePanelState } from "../splitViewStore";
import type { TurnDiffSummary } from "../types";
import { makeState, makeThread } from "../storeTestFixtures";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
}));

vi.mock("../hooks/useDiffRouteSearch", () => ({
  useDiffRouteSearch: () => ({}),
}));

import DiffPanel from "./DiffPanel";

const TURN_ID = TurnId.makeUnsafe("01a1f839-f83e-7d21-8d8d-fd76f877f5e0");
// Owner 1.0.8 chat (server-child.log 17:16, projection_turns row): Codex reported a
// skill file added outside the chat's Git folder; the before-turn snapshot is missing.
const OUTSIDE_FILE = "/home/owner/moss/skills/meeting-followup-board/SKILL.md";
const OWNER_SUMMARY: TurnDiffSummary = {
  turnId: TURN_ID,
  completedAt: "2026-11-20T09:16:28.692Z",
  status: "missing",
  checkpointRef: CheckpointRef.makeUnsafe("provider-diff:c9dcc9ea-cb4d-4b0b-9d93-104443215cc0"),
  checkpointTurnCount: 1,
  files: [{ path: OUTSIDE_FILE, kind: "added", additions: 25, deletions: 0 }],
};
const NOT_READY = "Checkpoint diff is not available yet for turn 1.";
const SKILL_TEXT = "Meeting follow-up board skill body";
const PATCH =
  "diff --git a/notes/plan.md b/notes/plan.md\n--- a/notes/plan.md\n+++ b/notes/plan.md\n@@ -1 +1 @@\n-old plan line\n+new plan line\n";

const initialStore = useStore.getState();
let screen: Awaited<ReturnType<typeof render>> | undefined;
let queryClient: QueryClient | undefined;

function Harness(props: { filePath: string | null }) {
  const [panelState, setPanelState] = useState<
    Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">
  >({ panel: "diff", diffTurnId: TURN_ID, diffFilePath: props.filePath });
  return (
    <div style={{ width: 900, height: 700, display: "flex" }}>
      <DiffPanel
        mode="sidebar"
        threadId={makeThread().id}
        panelState={panelState}
        onUpdatePanelState={(patch) => setPanelState((previous) => ({ ...previous, ...patch }))}
      />
    </div>
  );
}

async function mountPanel(input: {
  summary: TurnDiffSummary;
  getTurnDiff: ReturnType<typeof vi.fn>;
  isRepo: boolean;
  filePath: string | null;
  readFile?: ReturnType<typeof vi.fn>;
}) {
  const readFile =
    input.readFile ??
    vi.fn(async (request: { relativePath: string }) => ({
      relativePath: request.relativePath,
      contents: `# ${SKILL_TEXT}\n`,
      truncated: false,
      version: "v1",
      encoding: "utf8",
      lineEnding: "lf",
    }));
  vi.stubGlobal("nativeApi", {
    orchestration: { getTurnDiff: input.getTurnDiff, getFullThreadDiff: input.getTurnDiff },
    git: {
      listBranches: vi.fn().mockResolvedValue({ isRepo: input.isRepo, branches: [] }),
      status: vi.fn().mockResolvedValue(null),
      workingTreeDiffStats: vi.fn().mockResolvedValue({ fileCount: 0 }),
      onActionProgress: () => () => undefined,
    },
    projects: {
      readFile,
      createLocalFilePreviewGrant: vi.fn().mockResolvedValue({
        grant: "grant-1",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
      watchFile: () => () => undefined,
      onFileChange: () => () => undefined,
    },
  } as unknown as NativeApi);
  await page.viewport(1000, 800);
  useStore.setState(makeState(makeThread({ turnDiffSummaries: [input.summary] })));
  queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, refetchOnReconnect: false } },
  });
  screen = await render(
    <QueryClientProvider client={queryClient}>
      <Harness filePath={input.filePath} />
    </QueryClientProvider>,
  );
  return { readFile };
}

afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  queryClient?.clear();
  queryClient = undefined;
  useStore.setState(initialStore);
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("shows the reported file and its content at once when the before-turn snapshot is missing", async () => {
  const getTurnDiff = vi.fn().mockRejectedValue(new Error(NOT_READY));
  const startedAt = performance.now();
  await mountPanel({ summary: OWNER_SUMMARY, getTurnDiff, isRepo: true, filePath: OUTSIDE_FILE });

  const list = page.getByRole("list", { name: "Reported changes", exact: true });
  await expect
    .element(list.getByText("SKILL.md", { exact: true }), { timeout: 2_000 })
    .toBeVisible();
  const settledMs = performance.now() - startedAt;
  await expect.element(list.getByText("+25", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Line-by-line changes are unavailable for this turn.", { exact: true }))
    .toBeVisible();
  // The selected file opens through the server file read, outside the Git folder too.
  await expect.element(page.getByText(SKILL_TEXT, { exact: true })).toBeVisible();
  expect(
    document.querySelector('[role="status"][aria-label="Loading checkpoint diff..."]'),
  ).toBeNull();
  expect(settledMs).toBeLessThan(2_000);

  // No retry storm: a missing snapshot is the final answer until the turn changes.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(getTurnDiff).toHaveBeenCalledTimes(1);
  expect(
    document.querySelector('[role="status"][aria-label="Loading checkpoint diff..."]'),
  ).toBeNull();

  // Retry asks once more; when the diff exists it replaces the fallback.
  getTurnDiff.mockResolvedValue({ diff: PATCH });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(page.getByText("new plan line", { exact: true })).toBeVisible();
  expect(getTurnDiff).toHaveBeenCalledTimes(2);
});

it("shows the reported files for a folder that is not a Git repository", async () => {
  const getTurnDiff = vi
    .fn()
    .mockRejectedValue(new Error("fatal: not a git repository (or any of the parent directories)"));
  const { readFile } = await mountPanel({
    summary: {
      ...OWNER_SUMMARY,
      status: "ready",
      checkpointRef: CheckpointRef.makeUnsafe("provider-diff:event-2"),
      files: [
        { path: "notes/plan.md", kind: "modified", additions: 3, deletions: 1 },
        { path: "notes/todo.md", kind: "added", additions: 7, deletions: 0 },
      ],
    },
    getTurnDiff,
    isRepo: false,
    filePath: null,
  });

  const list = page.getByRole("list", { name: "Reported changes", exact: true });
  await expect
    .element(list.getByText("plan.md", { exact: true }), { timeout: 2_000 })
    .toBeVisible();
  await expect.element(list.getByText("todo.md", { exact: true })).toBeVisible();
  await expect
    .element(
      page.getByText(
        "This folder is not a Git repository, so Moss keeps no snapshot to compare with. These are the files the agent reported changing.",
        { exact: true },
      ),
    )
    .toBeVisible();
  // The first file is opened by default; picking another one reads that file.
  await expect.element(page.getByText(SKILL_TEXT, { exact: true })).toBeVisible();
  const todoRow = list.getByRole("button", { name: /todo\.md/ });
  await todoRow.click();
  await expect.element(todoRow).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() =>
    expect(readFile.mock.calls.map(([request]) => request.relativePath)).toContain("notes/todo.md"),
  );
});
