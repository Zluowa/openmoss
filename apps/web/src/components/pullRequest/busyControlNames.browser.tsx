// FILE: busyControlNames.browser.tsx
// Purpose: A control that is busy keeps the name it has when idle. The spinner inside Reopen,
//          Close issue, Merge and a pending check row is decorative, so no name gains "Loading".
// Layer: Code review screen test (real Chromium).

import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { GitHubIssueStateAction } from "../githubInbox/GitHubIssueEditors";
import { HitArea } from "../ui/hit-area";
import { PullRequestCheckStatusIcon } from "./PullRequestCheckStatusIcon";
import { PullRequestPrimaryButton } from "./PullRequestActions";

describe("busy controls keep their names", () => {
  it("finds Reopen by exactly its name while the issue is changing", async () => {
    await render(<GitHubIssueStateAction state="closed" pending onChange={() => {}} />);
    await expect
      .element(page.getByRole("button", { name: "Reopen", exact: true }))
      .toBeInTheDocument();
  });

  it("finds Close issue by exactly its name while the issue is changing", async () => {
    await render(<GitHubIssueStateAction state="open" pending onChange={() => {}} />);
    await expect
      .element(page.getByRole("button", { name: "Close issue", exact: true }))
      .toBeInTheDocument();
  });

  it("finds Merging… by exactly its name while it merges", async () => {
    await render(
      <PullRequestPrimaryButton
        action={{ kind: "merge", blockedReason: null, stackCount: null }}
        merging
        disabled
        onReady={() => {}}
        onMerge={() => {}}
        size="sm"
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Merging…", exact: true }))
      .toBeInTheDocument();
  });

  it("finds a pending check row by its check's name, with no Loading status inside", async () => {
    await render(
      <HitArea type="button">
        <PullRequestCheckStatusIcon status="pending" />
        <span>lint</span>
      </HitArea>,
    );
    const row = page.getByRole("button", { name: "lint", exact: true });
    await expect.element(row).toBeInTheDocument();
    expect(row.element().querySelector("[role='status']")).toBeNull();
  });
});
