import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Schema } from "effect";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AppSettingsSchema } from "~/appSettings";
import { getAppTypographyCssVariables } from "~/lib/appTypography";
import { OnboardingDialog } from "~/onboarding/OnboardingDialog";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";

const state = vi.hoisted(() => ({ settings: {}, update: vi.fn(async () => true) }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => null,
  ensureNativeApi: () => {
    throw new Error("No real RPC in typography fixtures");
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
    queryKey: ["typography-config"],
    queryFn: async () => ({ providers: [], keybindings: [] }),
    staleTime: Infinity,
  }),
}));
// The import step is outside this geometry test; no filesystem scan or provider RPC runs.
vi.mock("../onboarding/steps/ProjectStep", () => ({ ProjectStep: () => null }));

const originalStyle = document.documentElement.getAttribute("style");
const clients: QueryClient[] = [];
beforeEach(() => {
  state.settings = Schema.decodeUnknownSync(AppSettingsSchema)({ chatFontSizePx: 18 });
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
  for (const [key, value] of Object.entries(getAppTypographyCssVariables(18))) {
    document.documentElement.style.setProperty(key, value);
  }
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  if (originalStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", originalStyle);
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
});

function assertFrameFits() {
  const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
  const footer = popup.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
  const bounds = popup.getBoundingClientRect();
  const footerBounds = footer.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
  expect(footerBounds.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
  expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
}

it.each([
  { width: 320, height: 600 },
  { width: 800, height: 500 },
])(
  "keeps the actual onboarding header, provider grid and appearance controls reachable at $width × $height and font 18",
  async ({ width, height }) => {
    await page.viewport(width, height);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const screen = await render(
      <QueryClientProvider client={client}>
        <OnboardingDialog open onOpenChange={() => {}} onComplete={() => {}} />
      </QueryClientProvider>,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Get started", exact: true }))
        .toBeVisible();
      await vi.waitFor(assertFrameFits);
      await page.getByRole("button", { name: "Get started", exact: true }).click();
      assertFrameFits();
      await page.getByRole("button", { name: "Set up", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your agents" })).toBeVisible();
      assertFrameFits();
      const firstCard = document.querySelector<HTMLElement>("[data-onboarding-agent]")!;
      const grid = firstCard.parentElement!;
      expect(firstCard.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        grid.getBoundingClientRect().top - 1,
      );
      expect(grid.clientHeight).toBeGreaterThan(0);
      expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Pick an appearance" })).toBeVisible();
      assertFrameFits();
      const modes = page.getByRole("radiogroup", { name: "Theme preference" }).element();
      expect(modes.getBoundingClientRect().width).toBeGreaterThan(100);
      const body = modes.closest<HTMLElement>(".overflow-y-auto")!;
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      expect(getComputedStyle(document.querySelector('[data-slot="dialog-title"]')!).fontSize).toBe(
        "28px",
      );
    } finally {
      await screen.unmount();
    }
  },
);
