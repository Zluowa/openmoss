// FILE: PluginMarketplaceDialog.browser.tsx
// Purpose: Browser checks for the frozen Codex add-plugin-marketplace dialog flow.
// Layer: Browser UI test

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { PluginMarketplaceDialog } from "./PluginMarketplaceDialog";

function Harness({
  onAdd,
}: {
  readonly onAdd: React.ComponentProps<typeof PluginMarketplaceDialog>["onAdd"];
}) {
  const [open, setOpen] = useState(true);
  return <PluginMarketplaceDialog open={open} onOpenChange={setOpen} onAdd={onAdd} />;
}

describe("PluginMarketplaceDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("submits the frozen marketplace parameter shape and closes after success", async () => {
    const onAdd = vi.fn().mockResolvedValue({
      marketplaceName: "OpenAI",
      installedRoot: "/tmp/openai-plugins",
      alreadyAdded: false,
    });
    const screen = await render(<Harness onAdd={onAdd} />);

    try {
      await expect.element(page.getByTestId("plugin-marketplace-title")).toBeInTheDocument();
      await page.getByTestId("plugin-marketplace-source").fill("  openai/plugins  ");
      await page.getByTestId("plugin-marketplace-ref").fill(" main ");
      await page
        .getByTestId("plugin-marketplace-sparse-paths")
        .fill("plugins/codex, plugins/docs\nplugins/ops");
      await page.getByTestId("plugin-marketplace-submit").click();

      expect(onAdd).toHaveBeenCalledWith({
        source: "openai/plugins",
        refName: "main",
        sparsePaths: ["plugins/codex", "plugins/docs", "plugins/ops"],
      });
      await expect.element(page.getByTestId("plugin-marketplace-title")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the dialog open and announces native mutation failures", async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error("Repository is not a plugin marketplace"));
    const screen = await render(<Harness onAdd={onAdd} />);

    try {
      await page.getByTestId("plugin-marketplace-source").fill("broken/repo");
      await page.getByTestId("plugin-marketplace-submit").click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Repository is not a plugin marketplace");
      await expect.element(page.getByTestId("plugin-marketplace-title")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
