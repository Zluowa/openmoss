import "../../index.css";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppSettingsSchema, type AppSettings } from "~/appSettings";
import { formatMossTranslation, translateMoss } from "~/localization";
import { ProviderActivitySettings } from "./ProviderActivitySettings";

const defaults = AppSettingsSchema.makeUnsafe({});
const enableHermes = formatMossTranslation("en", "settings.providers.activity.enableAria", {
  provider: "Hermes",
});
const disableHermes = formatMossTranslation("en", "settings.providers.activity.disableAria", {
  provider: "Hermes",
});

describe("ProviderActivitySettings", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets a user enable an optional CLI and reveal it, then disable it again", async () => {
    const save = vi
      .fn<(patch: Partial<AppSettings>) => Promise<void>>()
      .mockResolvedValue(undefined);
    function Harness() {
      const [settings, setSettings] = useState(defaults);
      return (
        <ProviderActivitySettings
          settings={settings}
          defaults={defaults}
          ready
          updateSettingsAndWait={async (patch) => {
            await save(patch);
            setSettings((previous) => ({ ...previous, ...patch }));
          }}
        />
      );
    }
    await render(<Harness />);
    await expect
      .element(page.getByRole("switch", { name: enableHermes, exact: true }))
      .not.toBeChecked();
    await page.getByRole("switch", { name: enableHermes, exact: true }).click();
    await expect
      .element(page.getByRole("switch", { name: disableHermes, exact: true }))
      .toBeChecked();
    expect(save.mock.calls[0]?.[0].disabledProviders).not.toContain("hermes");
    expect(save.mock.calls[0]?.[0].hiddenProviders).not.toContain("hermes");
    expect(save.mock.calls[0]?.[0].disabledProviders).toContain("cursor");
    await page.getByRole("switch", { name: disableHermes, exact: true }).click();
    await expect
      .element(page.getByRole("switch", { name: enableHermes, exact: true }))
      .not.toBeChecked();
    expect(save.mock.calls[1]?.[0].disabledProviders).toContain("hermes");
  });

  it("waits for settings hydration and saving, then allows retry after a failed save", async () => {
    let rejectSave: ((error: Error) => void) | undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const screen = await render(
      <ProviderActivitySettings
        settings={defaults}
        defaults={defaults}
        ready={false}
        updateSettingsAndWait={save}
      />,
    );
    await expect
      .element(page.getByRole("switch", { name: enableHermes, exact: true }))
      .toBeDisabled();
    await screen.rerender(
      <ProviderActivitySettings
        settings={defaults}
        defaults={defaults}
        ready
        updateSettingsAndWait={save}
      />,
    );
    await page.getByRole("switch", { name: enableHermes, exact: true }).click();
    await expect
      .element(page.getByRole("switch", { name: enableHermes, exact: true }))
      .toBeDisabled();
    expect(save).toHaveBeenCalledTimes(1);
    rejectSave?.(new Error("injected save failure"));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(translateMoss("en", "settings.providers.activity.error"));
    await expect
      .element(page.getByRole("switch", { name: enableHermes, exact: true }))
      .toBeEnabled();
  });
});
