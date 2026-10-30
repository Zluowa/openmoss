import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { KimiChannelDialog } from "./KimiChannelDialog";
import { MossLocalizationProvider } from "~/localization";

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

// zh-CN 表面：裸挂载默认 localization context 按浏览器语言解析为 en，统一以 zh Provider 包裹。
function renderZh(ui: Parameters<typeof render>[0]) {
  return render(<MossLocalizationProvider>{ui}</MossLocalizationProvider>);
}

describe("KimiChannelDialog", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("saves one Kimi Coding Plan key without exposing a model catalog", async () => {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    const screen = await renderZh(
      <KimiChannelDialog
        open
        connected={false}
        onOpenChange={onOpenChange}
        onSave={onSave}
        onDisconnect={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Kimi", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("K3", { exact: true })).not.toBeInTheDocument();
      const keyInput = page.getByLabelText("API 密钥");
      await keyInput.fill("  kimi-secret-token  ");
      await userEvent.keyboard("{Enter}");

      expect(onSave).toHaveBeenCalledWith("kimi-secret-token");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
    }
  });

  it("rejects malformed keys and disconnects an existing channel", async () => {
    const onDisconnect = vi.fn();
    const screen = await renderZh(
      <KimiChannelDialog
        open
        connected
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
        onDisconnect={onDisconnect}
      />,
    );

    try {
      const keyInput = page.getByLabelText("API 密钥");
      await keyInput.fill("short");
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByText("请输入有效的 Kimi Coding Plan API Key。"))
        .toBeInTheDocument();

      await page.getByRole("button", { name: "断开连接" }).click();
      expect(onDisconnect).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });
});
