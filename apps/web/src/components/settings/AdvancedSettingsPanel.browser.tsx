// FILE: AdvancedSettingsPanel.browser.tsx
// Purpose: Browser characterization for advanced-settings ownership and disclosure behavior.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  config: {
    keybindingsConfigPath: "/tmp/keybindings.json",
    availableEditors: [],
  },
  auth: {
    authenticated: true,
    role: "client",
    sessionMethod: "browser-session-cookie" as
      | "browser-session-cookie"
      | "bearer-session-token"
      | undefined,
  },
  threadShells: [] as unknown[],
  allThreadsMessageless: false,
  projects: [{ id: "project-1" }],
  threadsHydrated: true,
  syncServerReadModel: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: { queryKey: readonly string[] }) => ({
      data: options.queryKey[0] === "config" ? harness.config : harness.auth,
    }),
  };
});

vi.mock("~/lib/serverReactQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/serverReactQuery")>();
  return {
    ...actual,
    serverConfigQueryOptions: () => ({ queryKey: ["config"] }),
    serverAuthSessionQueryOptions: () => ({ queryKey: ["auth"] }),
  };
});

vi.mock("~/storeSelectors", () => ({
  createThreadShellsSelector: () => () => harness.threadShells,
  createAllThreadsMessagelessSelector: () => () => harness.allThreadsMessageless,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      projects: harness.projects,
      threadsHydrated: harness.threadsHydrated,
      syncServerReadModel: harness.syncServerReadModel,
    }),
}));

import { AdvancedSettingsPanel } from "./AdvancedSettingsPanel";

describe("AdvancedSettingsPanel", () => {
  beforeEach(() => {
    harness.auth.sessionMethod = "browser-session-cookie";
    harness.auth.role = "client";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not offer HTTP browser sign-out for a sessionless startup owner", async () => {
    harness.auth.sessionMethod = undefined;
    harness.auth.role = "owner";
    await render(<AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />);
    await expect
      .element(page.getByRole("button", { name: "Sign out", exact: true }))
      .not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("This browser");
  });

  it.each(["browser-session-cookie", "bearer-session-token"] as const)(
    "keeps sign-out available for a real %s session",
    async (method) => {
      harness.auth.sessionMethod = method;
      await render(<AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />);
      await expect
        .element(page.getByRole("button", { name: "Sign out", exact: true }))
        .toBeVisible();
    },
  );

  it("owns recovery eligibility, shared disclosure motion, and the release-history handoff", async () => {
    const onOpenReleaseHistory = vi.fn();
    await render(
      <AdvancedSettingsPanel active onOpenReleaseHistory={onOpenReleaseHistory} resetEpoch={0} />,
    );

    const repairButton = page.getByRole("button", { name: "Repair state" });
    expect((repairButton.element() as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).toContain("Authenticated as client.");

    const disclosureButton = page.getByRole("button", { name: "What this does" });
    expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("false");
    const disclosureShell = disclosureButton.element().parentElement?.querySelector("div[inert]");
    expect(disclosureShell?.className).toContain("duration-220");
    await disclosureButton.click();
    await vi.waitFor(() =>
      expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("true"),
    );

    await page.getByRole("button", { name: "View release history" }).click();
    expect(onOpenReleaseHistory).toHaveBeenCalledOnce();
  });
});
