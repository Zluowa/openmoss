// @vitest-environment happy-dom
// FILE: -automations.keptLines.test.tsx
// Purpose: The four 定时任务 lines a person relies on read in Chinese on screen.
// Layer: Web route presentation test (happy-dom, the app's own DOM translator)

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "~/localization/zhCN";
import { AutomationApprovalBanner } from "./-automations.shared";

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
});

afterEach(() => {
  cleanup();
  uninstallZhCnUiLocalization();
  document.documentElement.lang = "en";
  delete document.documentElement.dataset.mossLocale;
});

describe("定时任务 lines kept by REVIEW-RULES rule 1", () => {
  it("says above the approval warnings that nothing is saved before approval", async () => {
    render(
      <AutomationApprovalBanner
        warnings={[
          {
            id: "full-access",
            title: "Full access",
            detail: "Scheduled full-access runs can make changes without per-step approval.",
            requiresAcknowledgement: true,
          },
        ]}
        busy={false}
        onApprove={vi.fn()}
        onApproveAndRun={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("你批准后，Moss 才会保存更改。")).toBeTruthy());
  });

  it.each([
    ["It runs only after you accept it.", "接受后才会运行。"],
    ["It stays paused until setup succeeds.", "设置成功前会保持暂停。"],
    ["Each run appends a turn to the thread you pick.", "每次运行都会在你选择的对话中追加一轮。"],
  ])("shows %s in Chinese", async (english, chinese) => {
    // The same literal the route renders; the app translates it on screen.
    render(<p>{english}</p>);
    await waitFor(() => expect(screen.getByText(chinese)).toBeTruthy());
  });
});
