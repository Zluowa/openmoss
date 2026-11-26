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

import { APP_VERSION } from "~/branding";
import { mossReleasesUpTo } from "~/whatsNew/mossReleases";

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
    await render(<AboutSettingsSection />);
    await expect
      .element(page.getByRole("button", { name: "Sign out", exact: true }))
      .not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("This browser");
  });

  it.each(["browser-session-cookie", "bearer-session-token"] as const)(
    "keeps sign-out available for a real %s session",
    async (method) => {
      harness.auth.sessionMethod = method;
      await render(<AboutSettingsSection />);
      await expect
        .element(page.getByRole("button", { name: "Sign out", exact: true }))
        .toBeVisible();
    },
  );

  it("shows the repair row only when chats are missing", async () => {
    const screen = await render(<AboutSettingsSection />);
    const repairButton = page.getByRole("button", { name: "Repair", exact: true });
    expect((repairButton.element() as HTMLButtonElement).disabled).toBe(false);
    // No developer text: no file paths, no "visible because…" explanations.
    expect(document.body.textContent).not.toContain("Visible because");
    expect(document.body.textContent).not.toContain("Authenticated as");
    await screen.unmount();

    harness.threadShells = [{ id: "thread-1" }];
    await render(<AboutSettingsSection />);
    await expect
      .element(page.getByRole("button", { name: "Repair", exact: true }))
      .not.toBeInTheDocument();
  });

  it("opens Moss's own release notes in place, newest installed version first", async () => {
    await render(<AboutSettingsSection />);
    await page.getByRole("button", { name: "View", exact: true }).click();
    const list = page.getByTestId("moss-release-history");
    await expect.element(list).toBeVisible();
    // No dialog stacked on Settings: the list sits inside the About section.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const versions = [...document.querySelectorAll("[data-moss-release]")].map((row) =>
      row.getAttribute("data-moss-release"),
    );
    const newestVersion = mossReleasesUpTo(APP_VERSION)[0]?.version;
    expect(newestVersion).toBeTruthy();
    expect(versions[0]).toBe(newestVersion);
    expect(versions).toContain("1.0.2");
    // Not the upstream history this app grew from.
    expect(versions).not.toContain("1.0.2-beta.1");
    expect(versions).not.toContain("0.8.0");
    // Older versions start folded.
    expect(page.getByText("Each canvas keeps its own drawing").elements()).toHaveLength(0);
    // The newest row starts open with its changes visible.
    const newest = document.querySelector(`[data-moss-release="${newestVersion}"]`) as HTMLElement;
    expect(newest.getBoundingClientRect().height).toBeGreaterThan(60);
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    // Folded away: the region collapses to no height and is hidden from assistive tech.
    const region = list.element().closest("[inert]") as HTMLElement | null;
    expect(region?.getAttribute("aria-hidden")).toBe("true");
    await expect.poll(() => Math.round(region!.getBoundingClientRect().height)).toBe(0);
  });

  it("keeps one tour entry: 关于 has no feature tour", async () => {
    await render(<AboutSettingsSection />);
    await expect.element(page.getByText("Release notes", { exact: true })).toBeVisible();
    expect(page.getByText("Feature tour", { exact: true }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Replay feature tour" }).elements()).toHaveLength(0);
  });

  it("keeps the keybindings file one row with no path on screen", async () => {
    await render(<KeybindingsFileRow />);
    await expect.element(page.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("/tmp/keybindings.json");
  });
});
