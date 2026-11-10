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

import { useFeatureTourStore } from "~/featureTour/store";
import { openSettings, settingsDialogStore } from "~/settingsDialogStore";
import { AboutSettingsSection, KeybindingsFileRow } from "./AdvancedSettingsPanel";

describe("AboutSettingsSection (System tools folded into General)", () => {
  beforeEach(() => {
    harness.auth.sessionMethod = "browser-session-cookie";
    harness.auth.role = "client";
    harness.threadShells = [];
    harness.allThreadsMessageless = false;
    harness.projects = [{ id: "project-1" }];
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not offer HTTP browser sign-out for a sessionless startup owner", async () => {
    harness.auth.sessionMethod = undefined;
    harness.auth.role = "owner";
    await render(<AboutSettingsSection onOpenReleaseHistory={() => {}} />);
    await expect
      .element(page.getByRole("button", { name: "Sign out", exact: true }))
      .not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("This browser");
  });

  it.each(["browser-session-cookie", "bearer-session-token"] as const)(
    "keeps sign-out available for a real %s session",
    async (method) => {
      harness.auth.sessionMethod = method;
      await render(<AboutSettingsSection onOpenReleaseHistory={() => {}} />);
      await expect
        .element(page.getByRole("button", { name: "Sign out", exact: true }))
        .toBeVisible();
    },
  );

  it("shows the repair row only when chats are missing, and hands off release notes", async () => {
    const onOpenReleaseHistory = vi.fn();
    const screen = await render(
      <AboutSettingsSection onOpenReleaseHistory={onOpenReleaseHistory} />,
    );
    const repairButton = page.getByRole("button", { name: "Repair", exact: true });
    expect((repairButton.element() as HTMLButtonElement).disabled).toBe(false);
    // No developer text: no file paths, no "visible because…" explanations.
    expect(document.body.textContent).not.toContain("Visible because");
    expect(document.body.textContent).not.toContain("Authenticated as");
    await page.getByRole("button", { name: "View", exact: true }).click();
    expect(onOpenReleaseHistory).toHaveBeenCalledOnce();
    await screen.unmount();

    harness.threadShells = [{ id: "thread-1" }];
    await render(<AboutSettingsSection onOpenReleaseHistory={() => {}} />);
    await expect
      .element(page.getByRole("button", { name: "Repair", exact: true }))
      .not.toBeInTheDocument();
  });

  it("replays the feature tour from About and closes Settings so it isn't left underneath", async () => {
    openSettings({ section: "general" });
    useFeatureTourStore.getState().close();
    await render(<AboutSettingsSection onOpenReleaseHistory={() => {}} />);
    await page.getByRole("button", { name: "Replay feature tour" }).click();
    expect(useFeatureTourStore.getState().replay).toBe(true);
    expect(settingsDialogStore.getState().isOpen).toBe(false);
    useFeatureTourStore.getState().close();
  });

  it("keeps the keybindings file one row with no path on screen", async () => {
    await render(<KeybindingsFileRow />);
    await expect.element(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("/tmp/keybindings.json");
  });
});
