// FILE: PullRequestSummaryTab.browser.tsx
// Purpose: Locks zh-CN product labels while preserving pull-request-owned content verbatim.
// Layer: Pull request presentation browser regression

import "../../index.css";

import type { PullRequestDetail } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
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

/** The weight a type role resolves to in Moss's CSS (font-normal is 380, font-medium 475). */
function roleWeight(className: string): string {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const weight = getComputedStyle(probe).fontWeight;
  probe.remove();
  return weight;
}

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

  it("says in one line when GitHub has more unresolved comments than shown", async () => {
    const queryClient = new QueryClient();
    await render(
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <PullRequestSummaryTab detail={{ ...DETAIL, commentsTruncated: true }} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByText("可能还有未解决的评论没有显示，请到 GitHub 查看。", { exact: true }))
      .toBeVisible();
  });

  it("titles the pull request at the panel heading size and names the send button with a Moss tooltip", async () => {
    const queryClient = new QueryClient();
    await render(
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <PullRequestSummaryTab detail={DETAIL} />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );

    const title = page.getByRole("heading", { name: USER_TITLE }).element() as HTMLElement;
    expect(getComputedStyle(title).fontSize).toBe("15px");
    expect(getComputedStyle(title).fontWeight).toBe(roleWeight("font-medium"));

    await userEvent.type(page.getByRole("textbox").last(), "Looks good");
    const send = page.getByRole("button", { name: "发布评论", exact: true });
    await expect.element(send).toBeEnabled();
    expect(send.element().hasAttribute("title")).toBe(false);
    await userEvent.hover(send);
    await expect
      .poll(() =>
        [...document.querySelectorAll<HTMLElement>("[data-slot='tooltip-popup']")].map(
          (popup) => popup.textContent,
        ),
      )
      .toContain("发布评论");
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
