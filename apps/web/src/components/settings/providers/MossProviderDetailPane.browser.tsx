// FILE: MossProviderDetailPane.browser.tsx
// Purpose: What a person sees in Settings › 模型与智能体 › Moss: no promise that CLIs can use
//          Moss models while signed out, and quiet ticks instead of solid green circles.
// Layer: Browser UI test

import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ state: "signed-out" as string }));

vi.mock("~/components/auth/useMossGatewayUnreachable", () => ({
  useMossAccountGatewayState: () => harness.state,
}));

import { MossProviderDetailPane } from "./MossProviderDetailPane";

function renderPane() {
  return render(
    <MossProviderDetailPane
      activeCliProviders={["codex", "claudeAgent", "opencode"]}
      unifiedProviders={[]}
      defaultUnifiedProviderId={null}
      unifiedProviderByCli={undefined}
      mossCliModelAuthEnabled={true}
      mossCliModelAuthDisabledProviders={[]}
      onToggleMossCliModelAuth={() => {}}
      onToggleMossCliProviderAuth={() => {}}
      onSetAllMossCliProvidersAuth={() => {}}
      onSelectCli={() => {}}
    />,
  );
}

describe("MossProviderDetailPane", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows no ticks, no count and no 'enabled' status while signed out", async () => {
    harness.state = "signed-out";
    await renderPane();
    await expect.element(page.getByRole("button", { name: "Sign in to Moss" })).toBeVisible();
    const marks = [...document.querySelectorAll("[data-moss-cli-auth-mark]")];
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.getAttribute("data-moss-cli-auth-mark")).toBe("off");
      expect(mark.firstElementChild).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/\d+ \/ \d+/);
    expect(document.body.textContent).not.toContain("Enabled");
  });

  it("draws allowed CLIs with a quiet tick, never a filled colour circle, when signed in", async () => {
    harness.state = "connected";
    await renderPane();
    const marks = [...document.querySelectorAll("[data-moss-cli-auth-mark='on']")];
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      const tick = mark.firstElementChild;
      expect(tick).not.toBeNull();
      expect(tick!.getBoundingClientRect().width).toBeGreaterThan(0);
      // Transparent background: the mark is a tick, not a solid green disc.
      expect(getComputedStyle(mark).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    }
    expect(document.body.textContent).toMatch(/\d+ \/ \d+/);
  });
});
