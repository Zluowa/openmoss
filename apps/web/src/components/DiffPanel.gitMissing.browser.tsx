// FILE: DiffPanel.gitMissing.browser.tsx
// Purpose: WALK-1 R-1 — with git missing, the changes panel says so in one sentence instead of
//          the raw `GitCore.listBranches` error.
// Layer: Focused component integration tests

import "../index.css";

import { type NativeApi } from "@moss/contracts";
import { GIT_NOT_INSTALLED_DETAIL } from "@moss/shared/git";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { useStore } from "../store";
import type { SplitViewPanePanelState } from "../splitViewStore";
import { makeState, makeThread } from "../storeTestFixtures";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
}));

vi.mock("../hooks/useDiffRouteSearch", () => ({
  useDiffRouteSearch: () => ({}),
}));

import DiffPanel from "./DiffPanel";

// What the server sends when `git` cannot be spawned (GitCore + GIT_NOT_INSTALLED_DETAIL).
const WIRE_ERROR = `Git command failed in GitCore.listBranches.branchNoColor: git branch --no-color (D:\\demo) - ${GIT_NOT_INSTALLED_DETAIL}`;
const SENTENCE = "这台电脑没有安装 Git，安装后即可在这里查看更改。";

const initialStore = useStore.getState();
let screen: Awaited<ReturnType<typeof render>> | undefined;
let queryClient: QueryClient | undefined;

function Harness() {
  const [panelState, setPanelState] = useState<
    Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">
  >({ panel: "diff", diffTurnId: null, diffFilePath: null });
  return (
    <div style={{ width: 900, height: 600, display: "flex" }}>
      <DiffPanel
        mode="sidebar"
        threadId={makeThread().id}
        panelState={panelState}
        onUpdatePanelState={(patch) => setPanelState((previous) => ({ ...previous, ...patch }))}
      />
    </div>
  );
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

it("says in one sentence that Git is not installed instead of the raw git error", async () => {
  const gitError = Object.assign(new Error(WIRE_ERROR), { _tag: "GitCommandError" });
  vi.stubGlobal("nativeApi", {
    orchestration: { getTurnDiff: vi.fn(), getFullThreadDiff: vi.fn() },
    git: {
      listBranches: vi.fn().mockRejectedValue(gitError),
      status: vi.fn().mockRejectedValue(gitError),
      workingTreeDiffStats: vi.fn().mockRejectedValue(gitError),
      readWorkingTreeDiff: vi.fn().mockRejectedValue(gitError),
      onActionProgress: () => () => undefined,
    },
  } as unknown as NativeApi);
  await page.viewport(1000, 700);
  useStore.setState(makeState(makeThread()));
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
  screen = await render(
    <MossLocaleScope locale="zh-CN">
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    </MossLocaleScope>,
  );

  const sentence = page.getByText(SENTENCE, { exact: true });
  await expect.element(sentence, { timeout: 5_000 }).toBeVisible();
  const box = sentence.element().getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(document.body.textContent).not.toContain("GitCore.listBranches");
  expect(document.body.textContent).not.toContain("failed to spawn");
});
