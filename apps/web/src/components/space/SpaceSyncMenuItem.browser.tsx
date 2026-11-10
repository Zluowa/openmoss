import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PageSpace, PageSpaceSyncInput, PageSpaceSyncState } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "~/test/browserThemeFixture";
import { SpaceSidebar } from "./SpaceSidebar";
const { call } = vi.hoisted(() => ({
  call: vi.fn<(input: PageSpaceSyncInput) => Promise<PageSpaceSyncState>>(),
}));
vi.mock("~/nativeApi", async (original) => ({
  ...(await original<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({ pages: { spaceSync: call } }),
}));

const space = {
  id: "space-menu",
  title: "协作资料",
  rootPageId: "root",
  scopeSpaceId: null,
  revision: 1,
  trashedAt: null,
  createdAt: "2026-11-06T00:00:00Z",
  updatedAt: "2026-11-06T00:00:00Z",
} as PageSpace;
const state = (
  id: string,
  enabled = false,
  available = true,
  canClear = false,
): PageSpaceSyncState => ({
  observation: id.repeat(64),
  enabled,
  available,
  connected: enabled,
  canClear,
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const noop = () => {};
  return render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale="zh-CN">
        <BrowserThemeFixture>
          <div style={{ width: 264, height: 600 }}>
            <SpaceSidebar
              scopeSpaceId={null}
              section={{ type: "space", spaceId: space.id }}
              openKey={null}
              recent={[]}
              spaces={[space]}
              pages={[]}
              onSection={noop}
              onOpen={noop}
              onOpenPage={noop}
              onCreate={noop}
              onCreateSubpage={noop}
              onRenameSpace={noop}
              onSpaceIcon={noop}
              onTrashSpace={noop}
              onClose={noop}
            />
          </div>
        </BrowserThemeFixture>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
}
describe("Space menu sync setting", () => {
  it("queries on open and sends the observation actually displayed for this Space", async () => {
    const restore = installBrowserFixtureTheme("dark");
    call.mockReset();
    let value = state("a");
    call.mockImplementation(async (input) => {
      if (input.enabled !== undefined) {
        expect(input.observation).toBe(value.observation);
        value = state("b", input.enabled);
      }
      return value;
    });
    const mounted = await mount();
    try {
      expect(call).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "协作资料 的操作" }).click();
      const toggle = page.getByRole("menuitemcheckbox", { name: "同步到我的其他设备" });
      await expect.element(toggle).toBeVisible();
      await expect.element(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect.element(toggle).toHaveAttribute("aria-checked", "true");
      expect(call.mock.calls.filter(([input]) => input.enabled === true)).toEqual([
        [{ scopeSpaceId: null, spaceId: space.id, enabled: true, observation: "a".repeat(64) }],
      ]);
      await page.screenshot({ path: "node_modules/.cache/space-sync-menu-zh-dark.png" });
    } finally {
      await mounted.unmount();
      restore();
    }
  });
  it("hides A's cached selection on reopen until B's local result arrives; clears only B's observation", async () => {
    call.mockReset().mockResolvedValueOnce(state("a", true));
    let release!: (value: PageSpaceSyncState) => void;
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    call.mockResolvedValue(state("c", false, false));
    const mounted = await mount();
    const trigger = page.getByRole("button", { name: "协作资料 的操作" });
    const toggle = page.getByRole("menuitemcheckbox", { name: "同步到我的其他设备" });
    try {
      await trigger.click();
      await expect.element(toggle).toHaveAttribute("aria-checked", "true");
      await userEvent.keyboard("{Escape}");
      await trigger.click();
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
      expect(toggle.query()).toBeNull();
      release(state("b", false, false, true));
      await page.getByRole("menuitem", { name: "清除之前的同步设置" }).click();
      expect(
        call.mock.calls.some(
          ([input]) => input.enabled === false && input.observation === "b".repeat(64),
        ),
      ).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});
