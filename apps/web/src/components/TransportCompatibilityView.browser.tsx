// FILE: TransportCompatibilityView.browser.tsx
// Purpose: Verifies terminal compatibility failures expose only localized UI copy.
// Layer: Browser localization test

import "../index.css";

import {
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WsCompatibilityError,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it } from "vitest";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { TransportCompatibilityView } from "./TransportCompatibilityView";
import { MossLocalizationProvider } from "../localization";
import { vi } from "vitest";

vi.mock("../appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../appSettings")>();
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

function issue(input: {
  readonly code: WsCompatibilityError["code"];
  readonly action: WsCompatibilityError["action"];
}): WsCompatibilityError {
  return new WsCompatibilityError({
    message: "The legacy server emitted a raw English diagnostic.",
    code: input.code,
    retryable: false,
    action: input.action,
    serverBuild: "9.8.7-test",
    protocolEpoch: WS_PROTOCOL_EPOCH,
    minRevision: WS_PROTOCOL_MIN_REVISION,
    maxRevision: WS_PROTOCOL_MAX_REVISION,
  });
}

describe("TransportCompatibilityView", () => {
  it("renders localized recovery copy while preserving version values", async () => {
    const screen = await renderZh(
      <TransportCompatibilityView
        issue={issue({ code: "WS_SERVER_GENERATION_CHANGED", action: "reload" })}
      />,
    );

    try {
      await expect
        .element(page.getByRole("heading"))
        .toHaveTextContent(`${APP_DISPLAY_NAME} 需要使用匹配的版本重新连接。`);
      await expect
        .element(page.getByText("服务器已在连接期间重启，请重新加载应用以建立新连接。"))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "重新加载应用" })).toBeVisible();

      const body = document.body.textContent ?? "";
      expect(body.replace(/\s+/g, " ")).toContain(`客户端 ${APP_VERSION} · 服务器 9.8.7-test`);
      expect(body).not.toContain("The legacy server emitted");
      expect(body).not.toContain("legacy server");
      expect(document.querySelectorAll('[data-localization-origin="runtime"]')).toHaveLength(2);
      expect(
        (document.querySelector("section")?.textContent ?? "")
          .replaceAll(APP_DISPLAY_NAME, "")
          .replaceAll("WebSocket", "")
          .replaceAll(APP_VERSION, "")
          .replaceAll("9.8.7-test", ""),
      ).not.toMatch(/[A-Za-z]/);
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["WS_PROTOCOL_INCOMPATIBLE", "客户端与服务器的 WebSocket 协议不兼容。"],
    ["WS_CAPABILITIES_INCOMPATIBLE", "服务器缺少客户端所需的 WebSocket 能力。"],
    ["WS_NEGOTIATION_REQUIRED", "连接尚未完成 WebSocket 兼容性协商。"],
    ["WS_SERVER_GENERATION_CHANGED", "服务器已在连接期间重启，请重新加载应用以建立新连接。"],
  ] as const)("renders Chinese copy for %s", async (code, expected) => {
    const screen = await renderZh(
      <TransportCompatibilityView issue={issue({ code, action: "reload" })} />,
    );

    try {
      await expect.element(page.getByText(expected)).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["update-client", "此 Moss 客户端需要更新。"],
    ["update-server", "Moss 服务器需要更新。"],
    ["reload", "Moss 需要使用匹配的版本重新连接。"],
  ] as const)("renders Chinese title for the %s action", async (action, expected) => {
    const screen = await renderZh(
      <TransportCompatibilityView issue={issue({ code: "WS_PROTOCOL_INCOMPATIBLE", action })} />,
    );

    try {
      await expect
        .element(page.getByRole("heading", { name: expected.replaceAll("Moss", APP_DISPLAY_NAME) }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
