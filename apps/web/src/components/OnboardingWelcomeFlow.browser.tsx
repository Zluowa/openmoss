// FILE: OnboardingWelcomeFlow.browser.tsx
// Purpose: The welcome tour as a person meets it on a fresh start: keyboard focus on each step's
//          primary action (Enter moves forward, it never skips the tour), the agent and theme
//          grids shown whole in a desktop window and visibly scrollable in a small one, a short
//          welcome without explanatory cards, and no repeated shortcut list at the end.
// Layer: Web browser test (real Chromium layout)

import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppSettingsSchema } from "~/appSettings";
import { OnboardingDialog } from "~/onboarding/OnboardingDialog";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";

const state = vi.hoisted(() => ({ settings: {}, update: vi.fn(async () => true) }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => null,
  ensureNativeApi: () => {
    throw new Error("No real RPC in welcome-flow fixtures");
  },
}));
vi.mock("../appSettings", async (original) => ({
  ...(await original<typeof import("../appSettings")>()),
  useAppSettings: () => ({ settings: state.settings, updateSettingsAndWait: state.update }),
}));
vi.mock("../hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => [],
}));
vi.mock("../onboarding/useProviderDetection", () => ({
  useProviderDetection: () => ({ detecting: false, failed: false, detect: async () => {} }),
}));
vi.mock("../lib/serverReactQuery", async (original) => ({
  ...(await original<typeof import("../lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({
    queryKey: ["welcome-flow-config"],
    queryFn: async () => ({ providers: [], keybindings: [] }),
    staleTime: Infinity,
  }),
}));
// The import step scans folders and calls the server; its placeholder is unit-tested.
vi.mock("../onboarding/steps/ProjectStep", () => ({ ProjectStep: () => null }));

const clients: QueryClient[] = [];
beforeEach(() => {
  state.settings = Schema.decodeUnknownSync(AppSettingsSchema)({});
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
  document.body.innerHTML = "";
});

async function mountTour(onComplete = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>
      <OnboardingDialog open onOpenChange={() => {}} onComplete={onComplete} />
    </QueryClientProvider>,
  );
  return { screen, onComplete };
}

const heading = () => document.querySelector('[data-slot="dialog-title"]')?.textContent ?? "";
const focusedPrimary = () =>
  document.activeElement instanceof HTMLElement &&
  document.activeElement.hasAttribute("data-onboarding-primary");

/** Whether every child of `container` lies inside its visible box. */
function allChildrenShown(container: HTMLElement): boolean {
  const box = container.getBoundingClientRect();
  return [...container.children].every((child) => {
    const rect = child.getBoundingClientRect();
    return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  });
}

describe("welcome tour", () => {
  it("starts every step on its primary action, and Enter moves forward instead of skipping", async () => {
    await page.viewport(1280, 800);
    const { screen, onComplete } = await mountTour();
    try {
      const steps = [
        "Welcome to Moss",
        "Choose your agents",
        "Pick an appearance",
        "Add your first project",
        "You're all set",
      ];
      for (const [index, title] of steps.entries()) {
        await expect.poll(heading).toBe(title);
        // Every step focuses its primary action.
        await expect.poll(focusedPrimary).toBe(true);
        if (index < steps.length - 1) {
          await userEvent.keyboard("{Enter}");
          expect(onComplete).not.toHaveBeenCalled();
        }
      }
      await userEvent.keyboard("{Enter}");
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    it(`shows every agent and theme whole at ${viewport.width} × ${viewport.height}`, async () => {
      await page.viewport(viewport.width, viewport.height);
      const { screen } = await mountTour();
      try {
        await page.getByRole("button", { name: "Get started", exact: true }).click();
        await expect.poll(heading).toBe("Choose your agents");
        const grid = document.querySelector<HTMLElement>("[data-onboarding-agent]")!.parentElement!;
        expect(grid.children.length).toBeGreaterThanOrEqual(12);
        expect(grid.scrollHeight).toBeLessThanOrEqual(grid.clientHeight + 1);
        expect(allChildrenShown(grid)).toBe(true);
        // Every agent's name reads in full ("MiniMax Code", not "MiniMax …").
        const names = [
          ...grid.querySelectorAll<HTMLElement>("[data-onboarding-agent] label > span:first-child"),
        ];
        expect(names.length).toBe(grid.children.length);
        for (const name of names) {
          expect(name.scrollWidth, name.textContent ?? "").toBeLessThanOrEqual(
            name.clientWidth + 1,
          );
        }

        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await expect.poll(heading).toBe("Pick an appearance");
        const packs = page
          .getByRole("radiogroup", { name: "Theme", exact: true })
          .element() as HTMLElement;
        const body = packs.closest<HTMLElement>(".overflow-y-auto")!;
        expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
        const bodyBox = body.getBoundingClientRect();
        expect(packs.getBoundingClientRect().bottom).toBeLessThanOrEqual(bodyBox.bottom + 1);
      } finally {
        await screen.unmount();
      }
    });
  }

  it("fades the agent grid at its edge when a small window makes it scroll", async () => {
    await page.viewport(800, 500);
    const { screen } = await mountTour();
    try {
      await page.getByRole("button", { name: "Get started", exact: true }).click();
      await expect.poll(heading).toBe("Choose your agents");
      const grid = document.querySelector<HTMLElement>("[data-onboarding-agent]")!.parentElement!;
      expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight);
      // At the top, the bottom edge fades: more rows read as "below", not as cut off.
      await expect
        .poll(() =>
          Number.parseFloat(getComputedStyle(grid).getPropertyValue("--onboarding-scroll-fade")),
        )
        .toBeGreaterThan(20);
      grid.scrollTop = grid.scrollHeight;
      await expect
        .poll(() =>
          Number.parseFloat(getComputedStyle(grid).getPropertyValue("--onboarding-scroll-fade")),
        )
        .toBeLessThan(1);
    } finally {
      await screen.unmount();
    }
  });

  it("welcomes in one short screen: logo, one line, one button, no cards or paragraphs (walk D-7)", async () => {
    await page.viewport(1101, 782);
    const { screen } = await mountTour();
    try {
      await expect.poll(heading).toBe("Welcome to Moss");
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
      // Nothing but the title and the footer's controls: no explanatory tiles, no subtitle.
      expect(dialog.querySelectorAll("li")).toHaveLength(0);
      expect(dialog.getAttribute("aria-describedby")).toBeNull();
      expect(dialog.textContent).not.toMatch(/Local-first|Your own agents|Verify before done/);
      // Short: the dialog hugs its content instead of a fixed 600px frame.
      expect(dialog.getBoundingClientRect().height).toBeLessThan(400);

      await page.getByRole("button", { name: "Get started", exact: true }).click();
      // Straight into setup: no tour page listing every agent by name.
      await expect.poll(heading).toBe("Choose your agents");
      for (const label of ["Continue", "Continue"]) {
        await page.getByRole("button", { name: label, exact: true }).click();
      }
      await expect.poll(heading).toBe("Add your first project");
      // Title alone, no subtitle about importing conversations from other agents.
      const projectDialog = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
      expect(projectDialog.textContent).not.toContain("Bring in conversations");
      expect(projectDialog.textContent).not.toContain("No conversations from other agents");
    } finally {
      await screen.unmount();
    }
  });

  it("ends with the summary right above its button, without an empty band", async () => {
    await page.viewport(1101, 782);
    const { screen } = await mountTour();
    try {
      // Through each step by its primary button, whatever it is called.
      for (const step of ["Welcome", "agents", "theme", "project"]) {
        const before = heading();
        document.querySelector<HTMLElement>("[data-onboarding-primary]")!.click();
        await expect.poll(heading, { message: step }).not.toBe(before);
      }
      await expect.poll(heading).toBe("You're all set");
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
      const description = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
      const primary = dialog.querySelector<HTMLElement>("[data-onboarding-primary]")!;
      const gap = primary.getBoundingClientRect().top - description.getBoundingClientRect().bottom;
      expect(gap).toBeLessThanOrEqual(56);
      expect(
        dialog.getBoundingClientRect().bottom - primary.getBoundingClientRect().bottom,
      ).toBeLessThanOrEqual(40);
    } finally {
      await screen.unmount();
    }
  });
});
