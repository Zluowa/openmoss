import {
  useConnectionSettingsBrowserTheme,
  captureConnectionDialog,
} from "~/test/connectionSettingsBrowserFixture";
// FILE: SshConnectionsSettingsPanel.browser.tsx
// Purpose: Exercise alias selection, manual edits, intent/status separation and explicit trust.
import "../../index.css";
import type {
  DesktopBridge,
  SshConfigHost,
  SshConnection,
  SshConnectionState,
} from "@moss/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { SshConnectionsSettingsPanel } from "./SshConnectionsSettingsPanel";
import { getAppTypographyCssVariables } from "~/lib/appTypography";

useConnectionSettingsBrowserTheme();

const ID = "aabbccdd-1122-3344-5566-778899aabbcc";
let states: SshConnectionState[],
  hosts: SshConfigHost[],
  nextId = 0;
const ssh = {
  list: vi.fn(),
  listConfigHosts: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  pickIdentityFile: vi.fn(),
};
const connection = (overrides: Partial<SshConnection> = {}): SshConnection => ({
  id: ID,
  displayName: "开发电脑",
  host: "dev",
  enabled: false,
  ...overrides,
});
const mount = (locale: "zh-CN" | "en" = "zh-CN", active = true) =>
  render(
    <MossLocaleScope locale={locale}>
      <div style={{ width: 760, padding: 24 }}>
        <SshConnectionsSettingsPanel active={active} />
      </div>
    </MossLocaleScope>,
  );
const dialog = () => page.getByRole("dialog").last();
const menu = async () => page.getByRole("button", { name: "开发电脑 的连接选项" }).click();
const manual = async () => {
  await page.getByRole("button", { name: "添加", exact: true }).first().click();
  await dialog().getByRole("button", { name: "手动添加", exact: true }).click();
  await expect.element(page.getByLabelText("显示名称")).toBeVisible();
};
beforeEach(async () => {
  await page.viewport(1100, 780);
  vi.resetAllMocks();
  states = [];
  nextId = 0;
  hosts = [
    {
      alias: "dev",
      host: "dev.example.test",
      user: "moss",
      port: 2222,
      identityFile: "E:/isolated/dev-key",
      usesProxy: false,
    },
    { alias: "jumped", host: "private.example.test", port: 22, usesProxy: true },
  ];
  ssh.list.mockImplementation(async () => states);
  ssh.listConfigHosts.mockImplementation(async () => hosts);
  ssh.save.mockImplementation(async (input: Omit<SshConnection, "id"> & { id?: string }) => {
    const saved = {
      ...input,
      id: input.id ?? `aabbccdd-1122-3344-5566-${String(++nextId).padStart(12, "0")}`,
    };
    const found = states.some((state) => state.connection.id === saved.id);
    states = found
      ? states.map((state) =>
          state.connection.id === saved.id ? { ...state, connection: saved } : state,
        )
      : [...states, { connection: saved, status: "disconnected" }];
    return saved;
  });
  ssh.connect.mockImplementation(
    async ({ id, trustFingerprint }: { id: string; trustFingerprint?: string }) => {
      const state: SshConnectionState = {
        connection: states.find((item) => item.connection.id === id)!.connection,
        status: trustFingerprint ? "connected" : "host-key-required",
        ...(trustFingerprint ? {} : { fingerprint: "SHA256:isolated-test-fingerprint" }),
      };
      states = states.map((item) => (item.connection.id === id ? state : item));
      return state;
    },
  );
  ssh.disconnect.mockImplementation(async (id: string) => {
    states = states.map((state) =>
      state.connection.id === id ? { connection: state.connection, status: "disconnected" } : state,
    );
  });
  ssh.remove.mockImplementation(async (id: string) => {
    states = states.filter((state) => state.connection.id !== id);
  });
  ssh.pickIdentityFile.mockResolvedValue("E:/isolated/fake-key");
  window.desktopBridge = { ssh, confirm: async () => true } as unknown as DesktopBridge;
});
afterEach(() => {
  delete window.desktopBridge;
});

describe("SSH connection device UI", () => {
  it("adds enabled config aliases serially and waits for explicit trust", async () => {
    const screen = await mount();
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await dialog().getByRole("checkbox", { name: "dev", exact: true }).click();
    await dialog().getByRole("checkbox", { name: "jumped", exact: true }).click();
    await captureConnectionDialog("ssh-config-picker-zh.png");
    await dialog().getByRole("button", { name: "添加", exact: true }).click();
    await expect.element(page.getByTestId("ssh-host-fingerprint")).toBeVisible();
    expect(ssh.save).toHaveBeenNthCalledWith(1, {
      displayName: "dev",
      host: "dev",
      enabled: true,
    });
    expect(ssh.save).toHaveBeenNthCalledWith(2, {
      displayName: "jumped",
      host: "jumped",
      enabled: true,
    });
    expect(ssh.connect).toHaveBeenCalledTimes(1);
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect.element(dialog().getByText("jumped", { exact: true })).toBeVisible();
    expect(ssh.connect).toHaveBeenCalledTimes(3);
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect.poll(() => states.filter((state) => state.status === "connected").length).toBe(2);
    await expect.element(page.getByRole("switch").first()).toBeChecked();
    await expect.element(page.getByRole("switch").last()).toBeChecked();
    await screen.unmount();
  });
  it("recognizes aliases already added and retains failed choices after a partial save", async () => {
    states = [{ connection: connection({ host: "DEV" }), status: "disconnected" }];
    const screen = await mount();
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect
      .element(dialog().getByRole("checkbox", { name: "dev", exact: true }))
      .toBeDisabled();
    await dialog().getByRole("checkbox", { name: "jumped", exact: true }).click();
    ssh.save.mockRejectedValueOnce(new Error("storage"));
    await dialog().getByRole("button", { name: "添加", exact: true }).click();
    await expect.element(dialog().getByRole("alert")).toHaveTextContent("另有 1 个添加失败");
    await expect
      .element(dialog().getByRole("checkbox", { name: "jumped", exact: true }))
      .toBeChecked();
    await dialog().getByRole("button", { name: "添加", exact: true }).click();
    await expect.element(page.getByTestId("ssh-host-fingerprint")).toBeVisible();
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect.element(page.getByText("jumped", { exact: true })).toBeVisible();
    expect(states).toHaveLength(2);
    await screen.unmount();
  });
  it("keeps manual add available when SSH config cannot be read", async () => {
    ssh.listConfigHosts.mockRejectedValue(new Error("unreadable"));
    const screen = await mount();
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect.element(dialog().getByRole("alert")).toHaveTextContent("未能读取 SSH 配置");
    await dialog().getByRole("button", { name: "手动添加", exact: true }).click();
    await expect.element(page.getByLabelText("显示名称")).toBeVisible();
    await screen.unmount();
  });
  it("validates manual ports and supports a typed or chosen identity path", async () => {
    const screen = await mount();
    await manual();
    await page.getByLabelText("显示名称").fill("手动设备");
    await page.getByLabelText("主机名", { exact: true }).fill("tester@device.example.test");
    await page.getByLabelText("SSH 端口（可选）").fill("70000");
    await dialog().getByRole("button", { name: "保存", exact: true }).click();
    await expect.element(dialog().getByRole("alert")).toHaveTextContent("1 到 65535");
    expect(ssh.save).not.toHaveBeenCalled();
    await page.getByLabelText("SSH 端口（可选）").fill("2222");
    await page.getByRole("radio", { name: "身份文件", exact: true }).click();
    await page.getByLabelText("身份文件路径").fill("E:/isolated/typed-key");
    await dialog().getByRole("button", { name: "选择", exact: true }).click();
    await expect.element(page.getByLabelText("身份文件路径")).toHaveValue("E:/isolated/fake-key");
    await captureConnectionDialog("ssh-manual-identity-zh.png");
    await dialog().getByRole("button", { name: "保存", exact: true }).click();
    await expect.element(page.getByTestId("ssh-host-fingerprint")).toBeVisible();
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect.element(page.getByText("手动设备", { exact: true })).toBeVisible();
    expect(ssh.save).toHaveBeenCalledWith({
      displayName: "手动设备",
      host: "tester@device.example.test",
      port: 2222,
      identityFile: "E:/isolated/fake-key",
      enabled: true,
    });
    await screen.unmount();
  });
  it("shows resolved config details and edits only the saved overrides", async () => {
    states = [{ connection: connection({ enabled: true }), status: "disconnected" }];
    const screen = await mount();
    await menu();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await expect.element(dialog().getByText("dev.example.test", { exact: true })).toBeVisible();
    await expect.element(dialog().getByText("2222", { exact: true })).toBeVisible();
    await expect.element(dialog().getByText("E:/isolated/dev-key", { exact: true })).toBeVisible();
    await captureConnectionDialog("ssh-details-zh.png");
    await dialog().getByRole("button", { name: "编辑 开发电脑", exact: true }).click();
    await expect.element(page.getByLabelText("主机名", { exact: true })).toHaveValue("dev");
    await expect.element(page.getByLabelText("SSH 端口（可选）")).toHaveValue("");
    await page.getByLabelText("显示名称").fill("新名称");
    await dialog().getByRole("button", { name: "保存", exact: true }).click();
    await expect.element(page.getByTestId("ssh-host-fingerprint")).toBeVisible();
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect.element(page.getByText("新名称", { exact: true })).toBeVisible();
    expect(ssh.save).toHaveBeenCalledWith({
      id: ID,
      displayName: "新名称",
      host: "dev",
      enabled: true,
    });
    await screen.unmount();
  });
  it("keeps enabled intent separate from an actual disconnected or failed status", async () => {
    states = [
      { connection: connection({ enabled: true }), status: "failed", errorCode: "authentication" },
    ];
    const screen = await mount();
    await expect.element(page.getByRole("switch")).toBeChecked();
    await expect.element(page.getByText("连接中断", { exact: true })).toBeVisible();
    await captureConnectionDialog("ssh-enabled-failed-zh.png");
    await page.getByRole("switch").click();
    await expect.poll(() => states[0]!.connection.enabled).toBe(false);
    expect(ssh.disconnect).toHaveBeenCalledWith(ID);
    await screen.unmount();
  });
  it("requires explicit host trust before completing a switched-on connection", async () => {
    states = [{ connection: connection(), status: "disconnected" }];
    const screen = await mount();
    await page.getByRole("switch").click();
    await expect
      .element(page.getByTestId("ssh-host-fingerprint"))
      .toHaveTextContent("SHA256:isolated-test-fingerprint");
    expect(ssh.save).toHaveBeenCalledWith({ ...connection(), enabled: true });
    expect(ssh.connect).toHaveBeenCalledTimes(1);
    expect(ssh.connect).toHaveBeenCalledWith({ id: ID });
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect.element(page.getByText("已连接", { exact: true })).toBeVisible();
    expect(ssh.connect).toHaveBeenLastCalledWith({
      id: ID,
      trustFingerprint: "SHA256:isolated-test-fingerprint",
    });
    await screen.unmount();
  });
  it("can switch off while preparation is pending and ignores its late result", async () => {
    states = [{ connection: connection(), status: "disconnected" }];
    let complete!: (state: SshConnectionState) => void;
    ssh.connect.mockImplementation(({ id }: { id: string }) => {
      states = states.map((state) =>
        state.connection.id === id ? { ...state, status: "connecting", phase: "agents" } : state,
      );
      return new Promise<SshConnectionState>((resolve) => {
        complete = resolve;
      });
    });
    const screen = await mount();
    await page.getByRole("switch").click();
    await expect.element(page.getByText("正在检查和准备远程智能体…")).toBeVisible();
    await expect.element(page.getByRole("switch")).toBeEnabled();
    await page.getByRole("switch").click();
    await expect.poll(() => states[0]!.connection.enabled).toBe(false);
    complete({
      connection: connection({ enabled: true }),
      status: "host-key-required",
      fingerprint: "SHA256:stale-result",
    });
    await expect.element(page.getByRole("switch")).not.toBeChecked();
    await expect.element(page.getByTestId("ssh-host-fingerprint")).not.toBeInTheDocument();
    await screen.unmount();
  });
  it("requires confirmation before removal and supports cancel", async () => {
    states = [{ connection: connection(), status: "disconnected" }];
    const screen = await mount();
    await menu();
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
    expect(ssh.remove).not.toHaveBeenCalled();
    await menu();
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "删除", exact: true }).click();
    await expect.poll(() => states.length).toBe(0);
    expect(ssh.remove).toHaveBeenCalledWith(ID);
    await screen.unmount();
  });
  it("pauses the batch at each hop and cancels its remaining queue when leaving", async () => {
    const screen = await mount();
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await dialog().getByRole("checkbox", { name: "dev", exact: true }).click();
    await dialog().getByRole("checkbox", { name: "jumped", exact: true }).click();
    await dialog().getByRole("button", { name: "添加", exact: true }).click();
    await expect.element(page.getByTestId("ssh-host-fingerprint")).toBeVisible();
    expect(ssh.connect).toHaveBeenCalledTimes(1);
    const firstId = states[0]!.connection.id;
    await screen.unmount();
    await expect.poll(() => ssh.disconnect.mock.calls.length).toBe(1);
    expect(ssh.disconnect).toHaveBeenCalledWith(firstId);
    expect(ssh.connect).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.connection.enabled)).toEqual([true, true]);
  });
  it("keeps every hop fingerprint visible until explicitly trusted", async () => {
    states = [{ connection: connection(), status: "disconnected" }];
    let step = 0;
    ssh.connect.mockImplementation(async () => {
      const host = step++ === 0 ? "bastion.example.test" : "target.example.test";
      const state: SshConnectionState =
        step <= 2
          ? {
              connection: states[0]!.connection,
              status: "host-key-required",
              hostKeyHost: host,
              fingerprint: `SHA256:${host}`,
            }
          : { connection: states[0]!.connection, status: "connected" };
      states = [state];
      return state;
    });
    const screen = await mount();
    await page.getByRole("switch").click();
    await expect
      .element(dialog().getByText("SSH 主机：bastion.example.test", { exact: true }))
      .toBeVisible();
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect
      .element(dialog().getByText("SSH 主机：target.example.test", { exact: true }))
      .toBeVisible();
    expect(ssh.connect).toHaveBeenCalledTimes(2);
    await dialog().getByRole("button", { name: "信任并连接", exact: true }).click();
    await expect.element(page.getByText("已连接", { exact: true })).toBeVisible();
    expect(ssh.connect).toHaveBeenLastCalledWith({
      id: ID,
      trustFingerprint: "SHA256:target.example.test",
    });
    await screen.unmount();
  });
  it("preserves disabled intent when editing without starting a connection", async () => {
    states = [{ connection: connection(), status: "disconnected" }];
    const screen = await mount();
    await menu();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    await dialog().getByRole("button", { name: "编辑 开发电脑", exact: true }).click();
    await page.getByLabelText("显示名称").fill("保存为关闭");
    await dialog().getByRole("button", { name: "保存", exact: true }).click();
    await expect.element(page.getByText("保存为关闭", { exact: true })).toBeVisible();
    expect(ssh.save).toHaveBeenCalledWith({ ...connection(), displayName: "保存为关闭" });
    expect(ssh.connect).not.toHaveBeenCalled();
    await screen.unmount();
  });
  it("keeps the large-font manual identity form and its actions inside a short viewport", async () => {
    for (const [key, value] of Object.entries(getAppTypographyCssVariables(18)))
      document.documentElement.style.setProperty(key, value);
    await page.viewport(800, 500);
    const screen = await mount();
    await manual();
    await page.getByRole("radio", { name: "身份文件", exact: true }).click();
    await page.getByLabelText("身份文件路径").fill("E:/isolated/large-font-key");
    await expect
      .element(page.getByLabelText("身份文件路径"))
      .toHaveValue("E:/isolated/large-font-key");
    const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"][data-open]')!;
    const footer = popup.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
    await expect.poll(() => Number(getComputedStyle(popup).opacity)).toBe(1);
    const bounds = popup.getBoundingClientRect(),
      actions = footer.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    expect(actions.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
    await expect.element(dialog().getByRole("button", { name: "保存", exact: true })).toBeVisible();
    await captureConnectionDialog("ssh-manual-large-short-zh.png");
    await screen.unmount();
  });
  it("does not poll hidden SSH panels or simulate desktop support in browsers", async () => {
    const hidden = await mount("en", false);
    expect(ssh.list).not.toHaveBeenCalled();
    await hidden.unmount();
    delete window.desktopBridge;
    const browser = await mount("en");
    await expect
      .element(page.getByText("Open the Moss desktop app to manage SSH connections."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await browser.unmount();
  });
});
