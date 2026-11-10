import { useConnectionSettingsBrowserTheme } from "~/test/connectionSettingsBrowserFixture";
import "../../index.css";
import type { AuthClientSession, AuthPairingLink } from "@moss/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MossLocaleScope } from "~/localization";
import { IncomingComputerConnections } from "./IncomingComputerConnections";
useConnectionSettingsBrowserTheme();

const calls = vi.hoisted(() => ({
  session: vi.fn(),
  config: vi.fn(),
  links: vi.fn(),
  clients: vi.fn(),
  create: vi.fn(),
  revokeCode: vi.fn(),
  revokeClient: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      getAuthSession: calls.session,
      getConfig: calls.config,
      listAuthPairingLinks: calls.links,
      listAuthClients: calls.clients,
      createAuthPairingToken: calls.create,
      revokeAuthPairingLink: calls.revokeCode,
      revokeAuthClient: calls.revokeClient,
    },
  }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: calls.toast } }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ copyTextToClipboard: calls.copy }));
let links: AuthPairingLink[], clients: AuthClientSession[];
const code = {
  id: "isolated-pairing-id",
  credential: "isolated-visible-fixture",
  role: "client",
  subject: "fixture",
  expiresAt: "2027-01-01T00:00:00.000Z",
  createdAt: "2026-11-07T00:00:00.000Z",
} as unknown as AuthPairingLink;
const content = (active = true) => (
  <MossLocaleScope locale="zh-CN">
    <div style={{ width: 760, padding: 24 }}>
      <IncomingComputerConnections active={active} />
    </div>
  </MossLocaleScope>
);
beforeEach(async () => {
  await page.viewport(1100, 780);
  vi.resetAllMocks();
  links = [];
  clients = [];
  calls.session.mockResolvedValue({ authenticated: true, role: "owner" });
  calls.config.mockResolvedValue({});
  calls.links.mockImplementation(async () => links);
  calls.clients.mockImplementation(async () => clients);
  calls.create.mockImplementation(async () => {
    links = [code];
    return code;
  });
  calls.revokeCode.mockImplementation(async () => {
    links = [];
    return { revoked: true };
  });
  calls.revokeClient.mockImplementation(async () => {
    clients = [];
    return { revoked: true };
  });
  calls.copy.mockResolvedValue(undefined);
});
it("explains local-only reachability and never creates a code automatically", async () => {
  const screen = await render(content());
  await expect.element(page.getByText(/其他设备暂时还连不到这台电脑/u)).toBeVisible();
  expect(calls.create).not.toHaveBeenCalled();
  await expect.element(page.getByLabelText("可访问的 Moss 地址")).not.toBeInTheDocument();
  calls.session.mockResolvedValue({ authenticated: true, role: "client" });
  await page.getByRole("button", { name: "刷新配对访问", exact: true }).click();
  await expect.element(page.getByText(/只有这台 Moss 的所有者/u)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "生成一次性配对码", exact: true }))
    .not.toBeInTheDocument();
  await screen.unmount();
});
it("uses explicit masked one-time codes, copies only on request and confirms revocation", async () => {
  calls.config.mockResolvedValue({ shareableOrigin: "https://moss.example.test" });
  const screen = await render(content());
  await expect
    .element(page.getByLabelText("可访问的 Moss 地址"))
    .toHaveValue("https://moss.example.test");
  await page.getByRole("button", { name: "生成一次性配对码", exact: true }).click();
  await expect.element(page.getByLabelText("一次性配对码")).toHaveAttribute("type", "password");
  expect(calls.copy).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "显示配对码", exact: true }).click();
  await expect.element(page.getByLabelText("一次性配对码")).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "复制配对码", exact: true }).click();
  expect(calls.copy).toHaveBeenCalledWith(code.credential);
  await page.getByRole("button", { name: "撤销配对码", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(calls.revokeCode).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "撤销配对码", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "撤销", exact: true }).click();
  await expect.element(page.getByLabelText("一次性配对码")).not.toBeInTheDocument();
  expect(calls.revokeCode).toHaveBeenCalledWith({ id: code.id });
  await screen.unmount();
});
it("clears hidden credentials and revokes a code that arrives after leaving the tab", async () => {
  let finish!: (result: AuthPairingLink) => void;
  calls.create.mockImplementation(
    () =>
      new Promise<AuthPairingLink>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(content());
  await page.getByRole("button", { name: "生成一次性配对码", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "正在生成配对码…", exact: true }))
    .toBeDisabled();
  await screen.rerender(content(false));
  finish(code);
  await expect.poll(() => calls.revokeCode.mock.calls.length).toBe(1);
  expect(document.querySelector("input")).toBeNull();
  await screen.unmount();
});

it("shows only other client grants and confirms revoking their workspace access", async () => {
  clients = [
    {
      sessionId: "own-session",
      role: "owner",
      current: true,
      connected: true,
      client: { label: "所有者自己" },
    },
    {
      sessionId: "other-session",
      role: "client",
      current: false,
      connected: true,
      client: { label: "另一台电脑" },
    },
  ] as unknown as AuthClientSession[];
  const screen = await render(content());
  await expect.element(page.getByText("另一台电脑", { exact: true })).toBeVisible();
  await expect.element(page.getByText("所有者自己", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "撤销访问", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(calls.revokeClient).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "撤销访问", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "撤销", exact: true }).click();
  await expect.element(page.getByText("尚未授权其他客户端。")).toBeVisible();
  expect(calls.revokeClient).toHaveBeenCalledWith({ sessionId: "other-session" });
  await screen.unmount();
});

it("leaves a recovery notice when revoking an unseen late code fails after leaving", async () => {
  let finish!: (result: AuthPairingLink) => void;
  calls.create.mockImplementation(
    () =>
      new Promise<AuthPairingLink>((resolve) => {
        finish = resolve;
      }),
  );
  calls.revokeCode.mockRejectedValue(new Error("isolated-unavailable"));
  const screen = await render(content());
  await page.getByRole("button", { name: "生成一次性配对码", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "正在生成配对码…", exact: true }))
    .toBeDisabled();
  await screen.rerender(content(false));
  await expect.element(page.getByTestId("incoming-computer-connections")).not.toBeInTheDocument();
  finish(code);
  await expect.poll(() => calls.toast.mock.calls.length).toBe(1);
  expect(calls.toast.mock.calls[0]![0].title).toContain("撤销未使用的配对码");
  expect(JSON.stringify(calls.toast.mock.calls)).not.toContain(code.credential);
  await screen.unmount();
});
