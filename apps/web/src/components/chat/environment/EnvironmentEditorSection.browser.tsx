// FILE: EnvironmentEditorSection.browser.tsx
// Purpose: The Environment panel's "Open in <editor>" row as a person reads it in Chinese.
// Layer: Vitest browser tests

import "../../../index.css";

import type { EditorId } from "@moss/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "~/localization/zhCN";

import { EnvironmentEditorSection } from "./EnvironmentEditorSection";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
});

afterEach(async () => {
  await cleanup();
  uninstallZhCnUiLocalization();
  document.documentElement.lang = "en";
  delete document.documentElement.dataset.mossLocale;
  localStorage.clear();
});

// The walk's Linux build had only a terminal: 「在 终端 中打开」 put Latin-style spaces
// around a Chinese name. A Latin name keeps them (Chinese typography).
it.each<[EditorId, string]>([
  ["terminal", "在终端中打开"],
  ["cursor", "在 Cursor 中打开"],
])("the open-in row with %s reads 「%s」 (walk N12-8)", async (editor, expected) => {
  await page.viewport(360, 200);
  await render(
    <MossLocaleScope locale="zh-CN">
      <div className="w-[320px]">
        <EnvironmentEditorSection
          keybindings={[]}
          availableEditors={[editor]}
          openInTarget="/repo/project"
          bare
        />
      </div>
    </MossLocaleScope>,
  );
  await expect.element(page.getByText(expected, { exact: true })).toBeVisible();
});
