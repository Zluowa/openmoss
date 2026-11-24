import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isBetaFeatureEnabled } from "@moss/shared/betaFeatures";
import { act } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useFeatureTourStore } from "~/featureTour/store";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { FeatureTourDialog } from "./FeatureTourDialog";
import { Button } from "./ui/button";

const tourState = vi.hoisted(() => ({
  installation: "/first/worktrees",
  flavor: "production" as "production" | "beta",
}));
let installation = tourState.installation;
vi.mock("../lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({
    queryKey: ["server", "config", tourState.installation],
    queryFn: async () => ({ worktreesDir: tourState.installation }),
    staleTime: Infinity,
  }),
}));
vi.mock("../betaFeatures", () => ({
  isBetaFeatureOn: (feature: string) => isBetaFeatureEnabled(feature, tourState.flavor),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
  useSearch: () => ({}),
}));

const tourKey = "moss:feature-tour:since-0.9.2:v1";
const importKey = "moss:project-import-announcement:v1";
const clients: QueryClient[] = [];
const screens: Awaited<ReturnType<typeof render>>[] = [];
const originalBridge = window.desktopBridge;

beforeEach(async () => {
  await page.viewport(1280, 900);
  installation = "/first/worktrees";
  tourState.installation = installation;
  tourState.flavor = "production";
  localStorage.removeItem(tourKey);
  localStorage.setItem(importKey, JSON.stringify([installation]));
  localStorage.removeItem("moss:appsnap-welcome:v1");
  useOnboardingDialogStore.setState({
    isOpen: false,
    startupGateSettled: true,
    betaWelcomePending: false,
  });
  useProjectImportDialogStore.setState({ isOpen: false });
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
  useFeatureTourStore.setState({ replay: false });
});
afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
  for (const client of clients.splice(0)) client.clear();
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  localStorage.removeItem(tourKey);
  localStorage.removeItem(importKey);
  localStorage.removeItem("moss:appsnap-welcome:v1");
});
async function show(children = <FeatureTourDialog />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  );
  screens.push(screen);
  return screen;
}

it("WALK-6 H-1: opens nothing by itself on a fresh profile; only Replay shows the tour", async () => {
  // Fresh profile: this installation was never seen, no replay asked.
  localStorage.removeItem(tourKey);
  await show();
  // Longer than the startup announcements took to appear in the walk.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(page.getByRole("dialog").elements()).toHaveLength(0);
  act(() => useFeatureTourStore.getState().open());
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
});

it("keeps the tour usable on a narrow screen and with large UI text", async () => {
  await page.viewport(390, 700);
  const sizes = {
    "--app-font-size-ui": 18,
    "--app-font-size-ui-lg": 19,
    "--app-font-size-ui-sm": 17,
    "--app-font-size-ui-xs": 15,
  };
  for (const [key, value] of Object.entries(sizes))
    document.documentElement.style.setProperty(key, `${value}px`);
  try {
    act(() => useFeatureTourStore.getState().open());
    await show();
    await expect
      .element(page.getByRole("dialog", { name: "A new home for your work" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const dialog = document.querySelector("[data-feature-tour]") as HTMLElement;
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    const points = dialog.querySelector("ul")!.getBoundingClientRect();
    const footer = dialog.querySelector("[data-slot=dialog-footer]")!.getBoundingClientRect();
    expect(footer.top).toBeGreaterThanOrEqual(points.bottom);
    await page
      .getByRole("dialog")
      .screenshot({ path: "node_modules/.cache/feature-tour-mobile.png" });
    await page.getByRole("button", { name: "Skip tour" }).click();
  } finally {
    for (const key of Object.keys(sizes)) document.documentElement.style.removeProperty(key);
    await page.viewport(1280, 900);
  }
});

it("restores manual replay focus after keyboard navigation and Escape", async () => {
  localStorage.setItem(tourKey, JSON.stringify([installation]));
  await show(
    <>
      <Button onClick={() => useFeatureTourStore.getState().open()}>Replay highlights</Button>
      <FeatureTourDialog />
    </>,
  );
  await page.getByRole("button", { name: "Replay highlights" }).click();
  await expect
    .element(page.getByRole("dialog", { name: "A new home for your work" }))
    .toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("dialog", { name: "Your agents, together" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Replay highlights" }).element(),
    ),
  );
});
