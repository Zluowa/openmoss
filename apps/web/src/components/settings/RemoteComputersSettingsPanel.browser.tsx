import { useConnectionSettingsBrowserTheme } from "~/test/connectionSettingsBrowserFixture";
import "../../index.css";
import type { DesktopBridge, RemoteComputerState } from "@moss/contracts";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { RemoteComputersSettingsPanel } from "./RemoteComputersSettingsPanel";

useConnectionSettingsBrowserTheme();

const oldId = "aabbccdd-1122-3344-5566-778899aabbcc";
const device = (status: RemoteComputerState["status"] = "disconnected"): RemoteComputerState => ({
  connection: {
    id: oldId,
    displayName: "测试电脑",
    origin: "https://moss.example.test",
    expiresAt: "2027-01-01T00:00:00.000Z",
  },
  status,
});
let states: RemoteComputerState[];
const remote = {
  list: vi.fn(),
  pair: vi.fn(),
  cancelPairing: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  remove: vi.fn(),
};
const mount = () =>
  render(
    <MossLocaleScope locale="zh-CN">
      <div style={{ width: 760, padding: 24 }}>
        <RemoteComputersSettingsPanel active />
      </div>
    </MossLocaleScope>,
  );
const dialog = () => page.getByRole("dialog");
const fill = async (origin = "https://moss.example.test") => {
  await page.getByLabelText("显示名称").fill("测试电脑");
  await page.getByLabelText("对方设备的 Moss 地址").fill(origin);
  await page.getByLabelText("一次性配对码").fill("isolated-one-time-fixture");
};
beforeEach(async () => {
  await page.viewport(1100, 780);
  vi.resetAllMocks();
  states = [];
  remote.list.mockImplementation(async () => states);
  remote.cancelPairing.mockResolvedValue(undefined);
  remote.pair.mockImplementation(async ({ id, displayName, origin }) => {
    const state: RemoteComputerState = {
      ...device(),
      connection: { ...device().connection, id, displayName, origin },
    };
    states.push(state);
    return state;
  });
  remote.connect.mockImplementation(async (id: string) => {
    states = states.map((state) =>
      state.connection.id === id ? { ...state, status: "connected" } : state,
    );
    return states.find((state) => state.connection.id === id)!;
  });
  remote.disconnect.mockImplementation(async (id: string) => {
    states = states.map((state) =>
      state.connection.id === id ? { ...state, status: "disconnected" } : state,
    );
  });
  remote.remove.mockImplementation(async (id: string) => {
    states = states.filter((state) => state.connection.id !== id);
    return { revoked: true };
  });
  window.desktopBridge = { remoteComputers: remote } as unknown as DesktopBridge;
});
afterEach(() => {
  delete window.desktopBridge;
});

it("validates origins, masks the ephemeral code and clears it on cancel", async () => {
  const screen = await mount();
  await page.getByRole("button", { name: "添加设备", exact: true }).click();
  await fill("http://device.example.test");
  await expect.element(page.getByLabelText("一次性配对码")).toHaveAttribute("type", "password");
  await dialog().getByRole("button", { name: "配对设备", exact: true }).click();
  await expect.element(dialog().getByRole("alert")).toHaveTextContent("HTTPS");
  expect(remote.pair).not.toHaveBeenCalled();
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "添加设备", exact: true }).click();
  await expect.element(page.getByLabelText("一次性配对码")).toHaveValue("");
  await screen.unmount();
});
it("pairs a device without opening it until the user chooses connect", async () => {
  const screen = await mount();
  await page.getByRole("button", { name: "添加设备", exact: true }).click();
  await fill();
  await expect.element(dialog()).toHaveTextContent("访问对方设备的 Moss 工作区");
  await dialog().getByRole("button", { name: "配对设备", exact: true }).click();
  await expect.element(page.getByText("未连接", { exact: true })).toBeVisible();
  expect(remote.connect).not.toHaveBeenCalled();
  await expect
    .poll(() => document.querySelector<HTMLInputElement>('input[type="password"]')?.value ?? "")
    .toBe("");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect.element(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await expect.element(page.getByText("未连接", { exact: true })).toBeVisible();
  await screen.unmount();
});
it("cancels an in-flight pairing and ignores its late reply", async () => {
  let finish!: (state: RemoteComputerState) => void;
  remote.pair.mockImplementation(
    () =>
      new Promise<RemoteComputerState>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await mount();
  await page.getByRole("button", { name: "添加设备", exact: true }).click();
  await fill();
  await dialog().getByRole("button", { name: "配对设备", exact: true }).click();
  await expect
    .element(dialog().getByRole("button", { name: "正在配对…", exact: true }))
    .toBeDisabled();
  const id = remote.pair.mock.calls[0]![0].id;
  await dialog().getByRole("button", { name: "取消", exact: true }).click();
  expect(remote.cancelPairing).toHaveBeenCalledWith(id);
  finish(device());
  await expect
    .element(page.getByText("设备已配对。点击「连接」即可打开对方的 Moss 工作区。"))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "添加设备", exact: true }).click();
  await expect.element(page.getByLabelText("一次性配对码")).toHaveValue("");
  await screen.unmount();
});
it("keeps an expired record when re-pairing fails and replaces it only after success", async () => {
  states = [device("needs-pairing")];
  remote.pair.mockRejectedValueOnce(new Error("needs-pairing"));
  const screen = await mount();
  await page.getByRole("button", { name: "重新配对", exact: true }).click();
  await page.getByLabelText("一次性配对码").fill("isolated-expired-fixture");
  await dialog().getByRole("button", { name: "配对设备", exact: true }).click();
  await expect.element(dialog().getByRole("alert")).toHaveTextContent("获取新配对码");
  expect(remote.remove).not.toHaveBeenCalled();
  expect(states[0]!.connection.id).toBe(oldId);
  await page.getByLabelText("一次性配对码").fill("isolated-new-fixture");
  await dialog().getByRole("button", { name: "配对设备", exact: true }).click();
  await expect.poll(() => states.length).toBe(1);
  await expect.poll(() => states[0]!.connection.id).not.toBe(oldId);
  expect(remote.remove).toHaveBeenCalledWith(oldId);
  expect(remote.connect).not.toHaveBeenCalled();
  await screen.unmount();
});
it("can cancel connection preparation without accepting a late connected result", async () => {
  states = [device()];
  let finish!: (state: RemoteComputerState) => void;
  remote.connect.mockImplementation(() => {
    states = [device("connecting")];
    return new Promise<RemoteComputerState>((resolve) => {
      finish = resolve;
    });
  });
  const screen = await mount();
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "取消连接", exact: true }).click();
  finish(device("connected"));
  await expect.element(page.getByText("未连接", { exact: true })).toBeVisible();
  expect(remote.disconnect).toHaveBeenCalledWith(oldId);
  await screen.unmount();
});
it("confirms removal and distinguishes an unconfirmed remote revocation", async () => {
  states = [device()];
  remote.remove.mockImplementation(async () => {
    states = [];
    return { revoked: false };
  });
  const screen = await mount();
  await page.getByRole("button", { name: "移除 测试电脑", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(remote.remove).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "移除 测试电脑", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "移除", exact: true }).click();
  await expect.element(page.getByText(/尚未确认远端撤销成功/u)).toBeVisible();
  await screen.unmount();
});

it.each([false, true])(
  "cleans up a persisted late pairing after cancellation (cleanup fails: %s)",
  async (cleanupFails) => {
    states = [device("needs-pairing")];
    let finish!: (state: RemoteComputerState) => void;
    let saved!: RemoteComputerState;
    remote.pair.mockImplementation(({ id, displayName, origin }) => {
      saved = { ...device(), connection: { ...device().connection, id, displayName, origin } };
      states.push(saved); // Model main already persisted while its IPC reply is still in flight.
      return new Promise<RemoteComputerState>((resolve) => {
        finish = resolve;
      });
    });
    if (cleanupFails) remote.remove.mockRejectedValue(new Error("storage-failed"));
    const screen = await mount();
    await page.getByRole("button", { name: "重新配对", exact: true }).click();
    await page.getByLabelText("一次性配对码").fill("isolated-late-fixture");
    await dialog().getByRole("button", { name: "配对设备", exact: true }).click();
    await expect
      .element(dialog().getByRole("button", { name: "正在配对…", exact: true }))
      .toBeDisabled();
    await dialog().getByRole("button", { name: "取消", exact: true }).click();
    finish(saved);
    await expect.poll(() => remote.remove.mock.calls.length).toBe(1);
    expect(remote.remove).toHaveBeenCalledWith(saved.connection.id);
    expect(remote.remove).not.toHaveBeenCalledWith(oldId);
    if (cleanupFails)
      await expect.element(page.getByRole("alert")).toHaveTextContent("未能清理已取消的配对");
    else expect(states.map((state) => state.connection.id)).toEqual([oldId]);
    expect(remote.connect).not.toHaveBeenCalled();
    await screen.unmount();
  },
);
