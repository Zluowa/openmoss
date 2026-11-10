import "../../index.css";

import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";

import { SelectItem } from "../ui/select";
import { SettingResetButton, SettingsSelectControl } from "./SettingControls";

it("puts a Chinese label inside the reset button's name in Simplified Chinese", async () => {
  await render(
    <MossLocaleScope locale="zh-CN">
      <SettingResetButton label="enabled providers" onClick={vi.fn()} />
    </MossLocaleScope>,
  );
  await expect
    .element(page.getByRole("button", { name: "将已启用的服务商重置为默认值", exact: true }))
    .toBeInTheDocument();
});

it("keeps the English label inside the reset button's name in English", async () => {
  await render(
    <MossLocaleScope locale="en">
      <SettingResetButton label="enabled providers" onClick={vi.fn()} />
    </MossLocaleScope>,
  );
  await expect
    .element(page.getByRole("button", { name: "Reset enabled providers to default", exact: true }))
    .toBeInTheDocument();
});

it("lets the user choose an enabled provider while the saved default is hidden", async () => {
  const onValueChange = vi.fn();
  await render(
    <SettingsSelectControl
      value={null}
      onValueChange={onValueChange}
      ariaLabel="Default provider"
      valueContent="Choose an enabled provider"
    >
      <SelectItem value="claudeAgent">Claude</SelectItem>
    </SettingsSelectControl>,
  );
  await page.getByRole("combobox", { name: "Default provider" }).click();
  expect(page.getByRole("option", { name: "Codex", exact: true }).elements()).toHaveLength(0);
  await page.getByRole("option", { name: "Claude", exact: true }).click();
  expect(onValueChange).toHaveBeenCalledWith("claudeAgent");
});

it("disables the empty default-provider selector when every provider is disabled", async () => {
  await render(
    <SettingsSelectControl
      value={null}
      disabled
      onValueChange={vi.fn()}
      ariaLabel="Default provider"
      valueContent="Choose an enabled provider"
    >
      {null}
    </SettingsSelectControl>,
  );
  await expect.element(page.getByRole("combobox", { name: "Default provider" })).toBeDisabled();
});
