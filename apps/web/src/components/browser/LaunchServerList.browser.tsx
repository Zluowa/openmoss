// What the browser pane's server page says at its foot (WALK-1 R-4, WALK-4 N4-4).

import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";

import { LaunchServersPage } from "./LaunchServerList";
import type { ProjectLaunchServers } from "./useProjectLaunchServers";

function servers(overrides: Partial<ProjectLaunchServers>): ProjectLaunchServers {
  return {
    rows: [],
    elsewhere: [] as unknown as ProjectLaunchServers["elsewhere"],
    loaded: true,
    source: "none",
    editFile: ".moss/launch.json",
    editFilePath: "/work/app/.moss/launch.json",
    problems: [],
    loading: false,
    refreshing: false,
    refresh: () => {},
    openOrStart: () => {},
    stop: () => {},
    ...overrides,
  };
}

function footerText(): string {
  return document.querySelector("[data-browser-servers-footer]")?.textContent?.trim() ?? "";
}

afterEach(async () => {
  await cleanup();
});

it("ends the empty page with nothing: no file path and no line about listing servers", async () => {
  await render(
    <MossLocaleScope locale="zh-CN">
      <LaunchServersPage servers={servers({ source: "none" })} onEditFile={vi.fn()} />
    </MossLocaleScope>,
  );
  await expect.element(page.getByText("编辑服务器列表")).not.toBeInTheDocument();
  expect(footerText()).toBe("");
  expect(document.body.textContent).not.toContain("launch.json");
  expect(document.body.textContent).not.toContain("列出项目的服务器");
  expect(document.querySelector("[data-browser-servers-footer] button")).toBeNull();
});

it("offers to edit a list that exists, as an action without its path", async () => {
  const onEditFile = vi.fn();
  await render(
    <MossLocaleScope locale="zh-CN">
      <LaunchServersPage servers={servers({ source: "moss" })} onEditFile={onEditFile} />
    </MossLocaleScope>,
  );
  await page.getByRole("button", { name: "编辑服务器列表" }).click();
  expect(onEditFile).toHaveBeenCalledWith("/work/app/.moss/launch.json");
  expect(document.body.textContent).not.toContain("launch.json");
});
