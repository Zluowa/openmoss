// FILE: ProviderInstallationDialog.browser.tsx
// Purpose: Verifies location, confirmation, disabled-before-removal and external ownership UI.
// Layer: Browser component tests (mock transport; no real installations changed)
import "../../index.css";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "../../localization";
import { ProviderInstallationDialog } from "./ProviderInstallationDialog";

const mocks = vi.hoisted(() => ({ manage: vi.fn(), reveal: vi.fn(), external: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: { manageProviderInstallation: mocks.manage },
    shell: { showInFolder: mocks.reveal, openExternal: mocks.external },
  }),
}));
const installed = {
  provider: "opencode" as const,
  source: "moss" as const,
  path: "/isolated/agents/opencode",
  managedPath: "/isolated/agents/node_modules/opencode-ai",
  canUninstall: true,
  removed: false,
};
const props = {
  provider: "opencode" as const,
  enabled: false,
  guideUrl: "https://opencode.ai/docs/",
  onClose: vi.fn(),
  onDisable: vi.fn(async () => {}),
  onChanged: vi.fn(async () => {}),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.manage.mockResolvedValue(installed);
  mocks.reveal.mockResolvedValue(undefined);
  mocks.external.mockResolvedValue(undefined);
});

it("reveals the installation folder without printing its path, and confirms before uninstalling only the Moss copy", async () => {
  await page.viewport(1000, 780);
  await render(<ProviderInstallationDialog {...props} />);
  await expect.element(page.getByRole("button", { name: "Show in folder" })).toBeVisible();
  expect(document.body.textContent).not.toContain(installed.managedPath);
  await page.getByRole("button", { name: "Show in folder" }).click();
  expect(mocks.reveal).toHaveBeenCalledWith(installed.managedPath);
  await page.getByRole("button", { name: "Uninstall Moss copy", exact: true }).click();
  expect(mocks.manage).toHaveBeenCalledTimes(1);
  await page.screenshot({ path: "managed-agent-confirmation.png" });
  mocks.manage.mockResolvedValue({
    ...installed,
    source: "missing",
    path: null,
    managedPath: null,
    canUninstall: false,
    removed: true,
  });
  await page.getByRole("button", { name: "Confirm uninstall", exact: true }).click();
  expect(mocks.manage).toHaveBeenLastCalledWith({ provider: "opencode", action: "uninstall" });
  await expect
    .element(page.getByText("The Moss-installed copy has been uninstalled."))
    .toBeVisible();
  expect(props.onChanged).toHaveBeenCalledOnce();
});

it("requires an enabled agent to be turned off first", async () => {
  await render(<ProviderInstallationDialog {...props} enabled />);
  await page.getByRole("button", { name: "Turn agent off", exact: true }).click();
  expect(props.onDisable).toHaveBeenCalledOnce();
  expect(
    page.getByRole("button", { name: "Uninstall Moss copy", exact: true }).elements(),
  ).toHaveLength(0);
});

it("keeps external installations in their owner's tools and opens a working official guide", async () => {
  mocks.manage.mockResolvedValue({
    ...installed,
    source: "external",
    managedPath: null,
    canUninstall: false,
  });
  await render(<ProviderInstallationDialog {...props} />);
  await page.getByRole("button", { name: "Setup guide", exact: true }).click();
  expect(mocks.external).toHaveBeenCalledWith(props.guideUrl);
  expect(
    page.getByRole("button", { name: "Uninstall Moss copy", exact: true }).elements(),
  ).toHaveLength(0);
});

it("clearly removes only the idle Moss copy when an external installation is selected", async () => {
  const externalPath = "/external/opencode";
  mocks.manage.mockResolvedValue({ ...installed, source: "external", path: externalPath });
  await render(<ProviderInstallationDialog {...props} />);
  await expect.element(page.getByText(/Only the copy installed by Moss is removed/u)).toBeVisible();
  await page.getByRole("button", { name: "Uninstall Moss copy", exact: true }).click();
  expect(mocks.manage).toHaveBeenCalledTimes(1);
  mocks.manage.mockResolvedValue({
    ...installed,
    source: "external",
    path: externalPath,
    managedPath: null,
    canUninstall: false,
    removed: true,
  });
  await page.getByRole("button", { name: "Confirm uninstall", exact: true }).click();
  await expect
    .element(page.getByText("The Moss-installed copy has been uninstalled."))
    .toBeVisible();
  // The remaining external copy can still be revealed, but its path is not printed.
  await page.getByRole("button", { name: "Show in folder" }).click();
  expect(mocks.reveal).toHaveBeenLastCalledWith(externalPath);
  expect(document.body.textContent).not.toContain(externalPath);
});

it.each([
  ["en", "PROVIDER_INSTALLATION_SESSIONS_RUNNING", "This agent still has conversations running."],
  ["zh-CN", "PROVIDER_INSTALLATION_SESSIONS_RUNNING", "这个智能体还有会话在运行"],
  ["zh-CN", "PROVIDER_INSTALLATION_AGENT_ENABLED", "请先关闭这个智能体"],
  ["zh-CN", "PROVIDER_INSTALLATION_IN_USE", "这个智能体的文件还在使用中"],
  ["zh-CN", "SOMETHING_ELSE", "暂时无法管理此安装"],
] as const)("explains a refused uninstall in plain words (%s, %s)", async (locale, code, text) => {
  localStorage.setItem("moss:app-settings:v1", JSON.stringify({ localeOverride: locale }));
  try {
    const screen = await render(
      <MossLocaleScope locale={locale}>
        <ProviderInstallationDialog {...props} />
      </MossLocaleScope>,
    );
    const uninstall = locale === "zh-CN" ? "卸载 Moss 副本" : "Uninstall Moss copy";
    await page.getByRole("button", { name: uninstall, exact: true }).click();
    mocks.manage.mockRejectedValueOnce(
      Object.assign(new Error("server words stay in the log"), { code }),
    );
    await page
      .getByRole("button", {
        name: locale === "zh-CN" ? "确认卸载" : "Confirm uninstall",
        exact: true,
      })
      .click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(text);
    expect(page.getByText("server words stay in the log").elements()).toHaveLength(0);
    await screen.unmount();
  } finally {
    localStorage.clear();
  }
});
