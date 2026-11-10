import "../../index.css";

import type { ProviderInstanceId, ProviderKind } from "@moss/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { Menu, MenuGroup, MenuGroupLabel, MenuTrigger } from "../ui/menu";
import { HandoffAgentRows } from "./ChatHeader";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "zh-CN",
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("zh-CN", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("zh-CN", key, values),
    }),
  };
});

const target = (provider: ProviderKind, instanceId: string, label: string) => ({
  provider,
  instanceId: instanceId as ProviderInstanceId,
  label,
});

// The owner's 30.webp list: every agent had a local row and a "Moss" row.
const TARGETS = [
  target("codex", "codex", "Codex"),
  target("codex", "codex_moss", "Moss"),
  target("opencode", "opencode", "OpenCode"),
  target("opencode", "opencode_moss", "Moss DeepSeek & Kimi"),
  target("grok", "grok", "Grok"),
  target("grok", "grok_moss", "Moss"),
  target("pi", "pi", "Pi"),
  target("devin", "devin", "Devin"),
  target("hermes", "hermes", "Hermes"),
  target("hermes", "hermes_moss", "Moss"),
];

describe("HandoffAgentRows", () => {
  it("shows each agent once and its accounts in a submenu", async () => {
    await page.viewport(520, 560);
    const onSelect = vi.fn();
    const screen = await render(
      <Menu open modal={false}>
        <MenuTrigger>handoff</MenuTrigger>
        <ComposerPickerMenuPopup align="start" side="bottom" className="w-56 min-w-56">
          <MenuGroup>
            <MenuGroupLabel>在新对话中继续</MenuGroupLabel>
            <HandoffAgentRows
              targets={TARGETS}
              destination="new-thread"
              onSelect={onSelect}
              renderProviderIcon={() => <span className="size-4 shrink-0" />}
            />
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>,
    );
    try {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-handoff-agent]")];
      expect(rows.map((row) => row.dataset.handoffAgent)).toEqual([
        "codex",
        "opencode",
        "grok",
        "pi",
        "devin",
        "hermes",
      ]);
      expect(page.getByText("Moss", { exact: true }).elements()).toHaveLength(0);
      await page.getByRole("menuitem", { name: "Codex" }).hover();
      await expect.element(page.getByRole("menuitem", { name: "本机账号" })).toBeVisible();
      await page.getByRole("menuitem", { name: "Moss", exact: true }).click();
      expect(onSelect).toHaveBeenCalledWith(TARGETS[1]);
      onSelect.mockClear();
      await page.getByRole("menuitem", { name: "Pi" }).click();
      expect(onSelect).toHaveBeenCalledWith(target("pi", "pi", "Pi"));
    } finally {
      await screen.unmount();
    }
  });
});
