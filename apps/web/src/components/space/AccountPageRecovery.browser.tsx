import "../../index.css";
import {
  PageId,
  type PageAccountRecoveryInput,
  type PageAccountRecoveryResult,
  type PageSpace,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "~/test/browserThemeFixture";
import { mossServerQueryKeys } from "../auth/mossServerReactQuery";
import { AccountPageRecovery } from "./AccountPageRecovery";
import { SpaceHome } from "./SpaceHome";
import { SpaceSidebar } from "./SpaceSidebar";

const { recovery, sync } = vi.hoisted(() => ({
  recovery: vi.fn<(input: PageAccountRecoveryInput) => Promise<PageAccountRecoveryResult>>(),
  sync: vi.fn(),
}));
vi.mock("~/nativeApi", async (original) => ({
  ...(await original<typeof import("~/nativeApi")>()),
  ensureNativeApi: () => ({ pages: { accountRecovery: recovery, spaceSync: sync } }),
}));
const art = import.meta.env.VITE_MOSS_ACCOUNT_RECOVERY_SCREENSHOTS;
const date = "2026-11-06T09:18:00.000Z";
const entry = (id: string, title: string, version = "a") => ({
  recoveryId: id,
  title,
  confirmedAt: date,
  observation: version.repeat(64),
});
const directory = (version = "a"): PageAccountRecoveryResult => ({
  kind: "list",
  items: [entry("review", "秋季项目复盘", version), entry("spec", "交付清单", version)],
});
const available = { kind: "availability", available: true } as const;
const space = {
  id: "weekly",
  title: "项目资料",
  rootPageId: "root",
  scopeSpaceId: null,
  revision: 1,
  trashedAt: null,
  createdAt: date,
  updatedAt: date,
} as PageSpace;
const noop = () => {};
const openButton = () => page.getByRole("button", { name: "从账号取回页面", exact: true });
const clients: QueryClient[] = [];
const restoreThemes: Array<() => void> = [];
afterEach(async () => {
  await cleanup();
  for (const client of clients.splice(0)) client.clear();
  for (const restore of restoreThemes.splice(0)) restore();
  recovery.mockReset();
  sync.mockReset();
});
function account(client: QueryClient, id: string) {
  client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
    authenticated: true,
    session: { user: { id } },
    activeRealm: "cn",
  });
}
async function mount(options: { menu?: boolean; theme?: "light" | "dark" } = {}) {
  await page.viewport(960, 540);
  restoreThemes.push(installBrowserFixtureTheme(options.theme ?? "light"));
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(qc);
  account(qc, "account-a");
  const restored = vi.fn();
  await render(
    <QueryClientProvider client={qc}>
      <MossLocaleScope locale="zh-CN">
        <BrowserThemeFixture>
          <div
            className="flex bg-background text-foreground"
            style={{ width: "100vw", height: "100vh" }}
          >
            <SpaceSidebar
              scopeSpaceId={null}
              section={{ type: "all" }}
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
            <SpaceHome
              section={{ type: "all" }}
              title="全部条目"
              description="此处显示资料空间的条目。"
              items={[]}
              loading={false}
              error={null}
              onRetry={noop}
              onCreate={noop}
              onOpen={noop}
              placeOf={() => "个人"}
              emptyCreate="page"
              headerAction={
                options.menu ? undefined : <AccountPageRecovery onRestored={restored} />
              }
            />
          </div>
        </BrowserThemeFixture>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
  return { qc, restored };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe("account page recovery", () => {
  it("hides an unavailable entry and does not request a catalog in the background", async () => {
    recovery.mockResolvedValue({ kind: "availability", available: false });
    await mount();
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledWith({ op: "availability" }));
    expect(openButton().query()).toBeNull();
    expect(recovery.mock.calls.every(([i]) => i.op === "availability")).toBe(true);
  });
  it.each(["light", "dark"] as const)(
    "lists only after a click and restores the selected confirmed copy in %s",
    async (theme) => {
      recovery.mockImplementation(async (i) =>
        i.op === "availability"
          ? available
          : i.op === "list"
            ? directory()
            : { kind: "restored", pageId: PageId.makeUnsafe("local-copy") },
      );
      const { restored } = await mount({ theme });
      await expect.element(openButton()).toBeVisible();
      expect(recovery.mock.calls.every(([i]) => i.op === "availability")).toBe(true);
      await openButton().click();
      await expect.element(page.getByText("秋季项目复盘", { exact: true })).toBeVisible();
      await expect.element(page.getByText("交付清单", { exact: true })).toBeVisible();
      const time = document.querySelector<HTMLTimeElement>('[role="dialog"] time');
      expect(time?.dateTime).toBe(date);
      await expect
        .element(page.getByText("选择已确认的快照，取回为本机的新页面。", { exact: true }))
        .toBeVisible();
      if (art) await page.screenshot({ path: `${art}/page-account-recovery-zh-${theme}.png` });
      await page.getByRole("button", { name: "取回副本", exact: true }).first().click();
      expect(recovery).toHaveBeenCalledWith({
        op: "restore",
        recoveryId: "review",
        observation: "a".repeat(64),
      });
      expect(restored).toHaveBeenCalledTimes(1);
      expect(restored).toHaveBeenCalledWith("local-copy");
    },
  );
  it("refreshes after a stale observation and does not repeat a restore without another click", async () => {
    let reads = 0;
    recovery.mockImplementation(async (i) => {
      if (i.op === "availability") return available;
      if (i.op === "list") return directory(++reads === 1 ? "a" : "b");
      throw { code: "conflict" };
    });
    const { restored } = await mount();
    await openButton().click();
    await page.getByRole("button", { name: "取回副本", exact: true }).first().click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("快照目录已更新");
    expect(reads).toBe(2);
    expect(restored).not.toHaveBeenCalled();
    expect(recovery.mock.calls.filter(([i]) => i.op === "restore")).toHaveLength(1);
    await page.getByRole("button", { name: "取回副本", exact: true }).first().click();
    expect(recovery).toHaveBeenCalledWith({
      op: "restore",
      recoveryId: "review",
      observation: "b".repeat(64),
    });
  });
  it.each(["list", "restore"] as const)(
    "drops a late %s response across A to B to A and clears the dialog",
    async (phase) => {
      const late = deferred<PageAccountRecoveryResult>();
      let initial = true;
      recovery.mockImplementation(async (i) => {
        if (i.op === "availability") return available;
        if (i.op === "list") {
          if (phase === "list" && initial) {
            initial = false;
            return late.promise;
          }
          return directory();
        }
        return late.promise;
      });
      const { qc, restored } = await mount();
      await openButton().click();
      if (phase === "restore")
        await page.getByRole("button", { name: "取回副本", exact: true }).first().click();
      await vi.waitFor(() => expect(recovery.mock.calls.some(([i]) => i.op === phase)).toBe(true));
      account(qc, "account-b");
      account(qc, "account-a");
      late.resolve(
        phase === "restore"
          ? { kind: "restored", pageId: PageId.makeUnsafe("stale-page") }
          : directory(),
      );
      await vi.waitFor(() => expect(page.getByRole("dialog").query()).toBeNull());
      expect(page.getByText("秋季项目复盘", { exact: true }).query()).toBeNull();
      expect(restored).not.toHaveBeenCalled();
      await expect.element(openButton()).toBeVisible();
    },
  );
  it("shows server confirmation separately from consent and requires a second action before revocation", async () => {
    sync.mockResolvedValue({
      available: true,
      enabled: true,
      connected: false,
      canClear: false,
      observation: "c".repeat(64),
    });
    let allowed = false,
      stamp = "a";
    recovery.mockImplementation(async (i) => {
      if (i.op === "set-publication") {
        expect(i.observation).toBe(stamp.repeat(64));
        allowed = i.enabled;
        stamp = allowed ? "b" : "c";
      }
      return {
        kind: "publication",
        available: true,
        allowed,
        confirmedCount: 0,
        lastConfirmedAt: null,
        observation: stamp.repeat(64),
      };
    });
    await mount({ menu: true, theme: "dark" });
    await page.getByRole("button", { name: "项目资料 的操作" }).click();
    const toggle = page.getByRole("menuitemcheckbox", { name: "保留可从账号取回的副本" });
    await expect.element(toggle).toHaveAttribute("aria-checked", "false");
    expect(recovery.mock.calls.filter(([i]) => i.op === "set-publication")).toHaveLength(0);
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByRole("status")).toHaveTextContent("正在等待快照确认");
    await toggle.click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("关闭后，此空间的账号副本将无法取回。");
    expect(recovery.mock.calls.filter(([i]) => i.op === "set-publication")).toHaveLength(1);
    if (art) await page.screenshot({ path: `${art}/page-account-publication-revoke-zh-dark.png` });
    await page.getByRole("menuitem", { name: "取消", exact: true }).click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await page.getByRole("menuitem", { name: "关闭账号副本", exact: true }).click();
    await expect.element(toggle).toHaveAttribute("aria-checked", "false");
    expect(recovery).toHaveBeenCalledWith({
      op: "set-publication",
      spaceId: space.id,
      enabled: false,
      observation: "b".repeat(64),
    });
  });
  it("displays confirmed count/time only from the server and refreshes without claiming a failed change", async () => {
    sync.mockResolvedValue({
      available: true,
      enabled: true,
      connected: false,
      canClear: false,
      observation: "c".repeat(64),
    });
    let statusReads = 0;
    recovery.mockImplementation(async (i) => {
      if (i.op === "set-publication") throw { code: "conflict" };
      statusReads++;
      return {
        kind: "publication",
        available: true,
        allowed: true,
        confirmedCount: 2,
        lastConfirmedAt: date,
        observation: "a".repeat(64),
      };
    });
    await mount({ menu: true });
    await page.getByRole("button", { name: "项目资料 的操作" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("已确认 2 份");
    if (art)
      await page.screenshot({ path: `${art}/page-account-publication-confirmed-zh-light.png` });
    await page.getByRole("menuitemcheckbox", { name: "保留可从账号取回的副本" }).click();
    await page.getByRole("menuitem", { name: "关闭账号副本", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("未能确认更改");
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "保留可从账号取回的副本" }))
      .toHaveAttribute("aria-checked", "true");
    expect(statusReads).toBe(2);
  });
});
