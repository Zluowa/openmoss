// FILE: PullRequestSummaryTab.browser.tsx
// Purpose: Locks zh-CN product labels while preserving pull-request-owned content verbatim.
// Layer: Pull request presentation browser regression

import "../../index.css";

import type { PullRequestDetail } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { MossLocalizationProvider } from "~/localization";
import { vi } from "vitest";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: "zh-CN",
        selectedCodexAccountId: "default",
      },
    }),
  };
});

const USER_TITLE = "Description: Preserve Project Atlas wording";
const USER_BODY = "Description: Keep Codex, Moss, GPT-5, Project Atlas, and user prose unchanged.";

const DETAIL: PullRequestDetail = {
  projectId: "project-atlas" as PullRequestDetail["projectId"],
  projectTitle: "Project Atlas",
  workspaceRoot: "/repo/project-atlas",
  repository: "acme/project-atlas",
  number: 42,
  title: USER_TITLE,
  body: USER_BODY,
  url: "https://github.com/acme/project-atlas/pull/42",
  author: { login: "moss-user", name: "Moss User", avatarUrl: null, url: null },
  state: "open",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeability: "mergeable",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  headBranch: "feature/description-copy",
  baseBranch: "main",
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T09:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  maintainerCanModify: true,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentsTruncated: false,
  commentsIncomplete: false,
  commits: [],
  mergeCapabilities: {
    merge: true,
    squash: true,
    rebase: true,
    deleteBranchOnMerge: true,
  },
};

describe("PullRequestSummaryTab zh-CN labels", () => {
  beforeEach(() => {
    localStorage.setItem("moss:app-settings:v1", JSON.stringify({ localeOverride: "zh-CN" }));
  });

  afterEach(async () => {
    await cleanup();
    localStorage.removeItem("moss:app-settings:v1");
  });

  it("localizes the product-owned Description heading without translating PR content", async () => {
    const queryClient = new QueryClient();
    await render(
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <PullRequestSummaryTab detail={DETAIL} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("button", { name: "描述" })).toBeInTheDocument();
    await expect.element(page.getByRole("heading", { name: USER_TITLE })).toBeInTheDocument();
    await expect.element(page.getByText(USER_BODY, { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("描述：Keep Codex");
  });

  it("localizes the product-owned empty-description fallback", async () => {
    const queryClient = new QueryClient();
    await render(
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <PullRequestSummaryTab detail={{ ...DETAIL, body: "" }} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("button", { name: "描述" })).toBeInTheDocument();
    await expect.element(page.getByText("暂无描述。", { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("No description provided.");
  });
});
