// FILE: ComposerExtrasMenu.browser.tsx
// Purpose: Verifies the composer `+` menu exposes generic file uploads and quick mode toggles.
// Layer: Browser UI test
// Depends on: vitest browser rendering helpers and the ComposerExtrasMenu component.

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ProviderInteractionMode } from "@synara/contracts";

import { ComposerExtrasMenu } from "./ComposerExtrasMenu";
import { translateMoss } from "../../localization";
import { DEFAULT_LOCALE_OVERRIDE } from "../../uiLocale";
import { MossLocalizationProvider } from "../../localization";

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

const composerExtrasLabel = translateMoss(DEFAULT_LOCALE_OVERRIDE, "chat.composer.extras");
const addFilesLabel = translateMoss(DEFAULT_LOCALE_OVERRIDE, "chat.composer.addFiles");
const planModeLabel = translateMoss(DEFAULT_LOCALE_OVERRIDE, "chat.composer.planMode");
const fastLabel = translateMoss(DEFAULT_LOCALE_OVERRIDE, "chat.composer.fast");
const defaultLabel = translateMoss(DEFAULT_LOCALE_OVERRIDE, "chat.composer.default");
const modeLabel = "Mode";
const debugLabel = "Debug";

async function mountMenu(props?: {
  fastModeEnabled?: boolean;
  interactionMode?: ProviderInteractionMode;
  supportsFastMode?: boolean;
}) {
  const onAddAttachments = vi.fn();
  const onToggleFastMode = vi.fn();
  const onInteractionModeChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <MossLocalizationProvider>
      <ComposerExtrasMenu
        interactionMode={props?.interactionMode ?? "default"}
        supportsFastMode={props?.supportsFastMode ?? true}
        fastModeEnabled={props?.fastModeEnabled ?? false}
        onAddAttachments={onAddAttachments}
        onToggleFastMode={onToggleFastMode}
        onInteractionModeChange={onInteractionModeChange}
      />
    </MossLocalizationProvider>,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onAddAttachments,
    onToggleFastMode,
    onInteractionModeChange,
  };
}

describe("ComposerExtrasMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses an unrestricted file picker and forwards every selected file", async () => {
    await using menu = await mountMenu();

    const input = document.querySelector<HTMLInputElement>("[data-testid='composer-file-input']");
    expect(input).not.toBeNull();
    expect(input?.hasAttribute("accept")).toBe(false);

    const files = new DataTransfer();
    files.items.add(new File(["photo"], "photo.png", { type: "image/png" }));
    files.items.add(new File(["document"], "document.pdf", { type: "application/pdf" }));
    Object.defineProperty(input, "files", {
      configurable: true,
      value: files.files,
    });
    input?.dispatchEvent(new Event("change", { bubbles: true }));

    expect(menu.onAddAttachments).toHaveBeenCalledTimes(1);
    expect(menu.onAddAttachments.mock.calls[0]?.[0]?.map((file: File) => file.name)).toEqual([
      "photo.png",
      "document.pdf",
    ]);
  });

  it("shows the attachment action in the menu", async () => {
    await using _ = await mountMenu({ interactionMode: "plan", fastModeEnabled: true });

    await page.getByLabelText(composerExtrasLabel).click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain(addFilesLabel);
      expect(text).toContain(modeLabel);
      expect(text).toContain(fastLabel);
      expect(text).not.toContain("Plugins");
    });

    await page.getByText(modeLabel, { exact: true }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: planModeLabel, exact: true }))
      .toBeVisible();
  });

  it("selects Default, Plan, and Debug exclusively", async () => {
    await using menu = await mountMenu();

    await page.getByLabelText(composerExtrasLabel).click();
    await page.getByText(modeLabel, { exact: true }).click();

    await expect
      .element(page.getByRole("menuitemradio", { name: defaultLabel, exact: true }))
      .toBeVisible();
    expect(page.getByRole("menuitemradio").length).toBe(3);
    for (const label of [defaultLabel, planModeLabel, debugLabel]) {
      await expect
        .element(page.getByRole("menuitemradio", { name: label, exact: true }))
        .toBeVisible();
    }
    await expect
      .element(page.getByRole("menuitemradio", { name: defaultLabel, exact: true }))
      .toHaveAttribute("aria-checked", "true");

    await page.getByRole("menuitemradio", { name: debugLabel, exact: true }).click();

    expect(menu.onInteractionModeChange).toHaveBeenCalledWith("debug");
  });

  it("wires the speed control", async () => {
    await using menu = await mountMenu();

    await page.getByLabelText(composerExtrasLabel).click();
    await page.getByText(fastLabel, { exact: true }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: defaultLabel, exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: fastLabel, exact: true }).click();

    expect(menu.onToggleFastMode).toHaveBeenCalledTimes(1);
  });
});
