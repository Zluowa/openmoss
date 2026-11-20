// FILE: IssueSourcesSettings.browser.tsx
// Purpose: Browser coverage for Settings › Issue sources: Connect while Linear or Jira is not
//          signed in, and one switch per team or site once it is, which hides it in code review.
// Layer: Settings test

import "../../index.css";

import type { NativeApi } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { IssueSourcesSettings } from "./IssueSourcesSettings";

const status = vi.fn();

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IssueSourcesSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  status.mockReset();
  window.nativeApi = { issueSources: { status } } as unknown as NativeApi;
});

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as { nativeApi?: NativeApi }).nativeApi;
});

describe("IssueSourcesSettings", () => {
  it("offers Connect for each source not signed in", async () => {
    status.mockImplementation(({ source }: { source: string }) =>
      Promise.resolve({ source, state: "not-connected", teams: [] }),
    );
    await mount();
    await expect
      .poll(() => page.getByRole("button", { name: "Connect" }).elements())
      .toHaveLength(2);
    await expect.element(page.getByText(/Connect once to see Linear issues/)).toBeVisible();
    await expect.element(page.getByText(/Sign in to Atlassian once/)).toBeVisible();
  });

  it("lists each team and site with a switch that hides it from code review", async () => {
    status.mockImplementation(({ source }: { source: string }) =>
      Promise.resolve(
        source === "linear"
          ? {
              source,
              state: "connected",
              teams: [
                { id: "team-eng", name: "Engineering", key: "ENG" },
                { id: "team-ops", name: "Ops", key: null },
              ],
            }
          : {
              source,
              state: "connected",
              teams: [{ id: "cloud-1", name: "Acme", key: "acme.atlassian.net" }],
            },
      ),
    );
    await mount();
    const ops = page.getByRole("switch", { name: "Show Ops issues in code review" });
    await expect.element(ops).toBeChecked();

    await ops.click();

    await expect.element(ops).not.toBeChecked();
    await expect
      .poll(
        () =>
          JSON.parse(localStorage.getItem("moss:app-settings:v1") ?? "{}").issueSourceHiddenTeams,
      )
      .toEqual(["linear:team-ops"]);
    await expect
      .element(page.getByRole("switch", { name: "Show Engineering issues in code review" }))
      .toBeChecked();

    await page.getByRole("switch", { name: "Show Acme issues in code review" }).click();
    await expect
      .poll(
        () =>
          JSON.parse(localStorage.getItem("moss:app-settings:v1") ?? "{}").issueSourceHiddenTeams,
      )
      .toEqual(["linear:team-ops", "jira:cloud-1"]);
  });
});
