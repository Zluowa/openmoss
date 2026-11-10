import "../../index.css";
import type { GitHubConnectionInput, GitHubConnectionResult, NativeApi } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { GitHubSignInIntroduction } from "~/onboarding/GitHubSignInIntroduction";
import { useOnboardingDialogStore } from "~/onboarding/onboardingDialogStore";
import {
  mossServerMutationKeys,
  mossServerQueryKeys,
  serverMossEnterpriseKeySignInMutationOptions,
} from "../auth/mossServerReactQuery";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { GitHubConnectionGate } from "./GitHubConnectionGate";
import { useAnnouncementSheetSlotStore } from "../announcementSheetSlot";

const connection = vi.fn<(input: GitHubConnectionInput) => Promise<GitHubConnectionResult>>();
const openExternal = vi.fn(async (_url: string) => {});
let client: QueryClient;
let prior: NativeApi | undefined;
const member = { authenticated: true, activeRealm: "cn", session: { user: { id: "qa-a" } } };

beforeEach(() => {
  prior = window.nativeApi;
  window.nativeApi = {
    githubInbox: { connection },
    shell: { openExternal },
  } as unknown as NativeApi;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  connection.mockReset();
  openExternal.mockClear();
  localStorage.clear();
  useOnboardingDialogStore.setState({
    startupGateSettled: true,
    isOpen: false,
    betaWelcomePending: false,
  });
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false, startupSettled: true });
});
afterEach(async () => {
  await cleanup();
  client.clear();
  if (prior) window.nativeApi = prior;
  else delete window.nativeApi;
});

async function mount(intro = false) {
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <SidebarProvider>
            <div style={{ display: "flex", minHeight: "100vh", width: "100%" }}>
              {intro ? (
                <GitHubSignInIntroduction />
              ) : (
                <GitHubConnectionGate>
                  <h1>Verified GitHub inbox</h1>
                </GitHubConnectionGate>
              )}
            </div>
          </SidebarProvider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
}
function authenticate() {
  const mutation = client.getMutationCache().build(client, {
    mutationKey: mossServerMutationKeys.mossPhoneLogin(),
    mutationFn: async () => {
      client.setQueryData(mossServerQueryKeys.mossAccountSession(), member);
      return member;
    },
  });
  return mutation.execute(undefined);
}
describe("GitHub connection entry", () => {
  it.each([
    ["desktop", 1040, 680],
    ["phone", 390, 760],
  ] as const)(
    "starts only after a click and displays the verified inbox after approval on %s",
    async (name, width, height) => {
      await page.viewport(width, height);
      let approved = false;
      connection.mockImplementation(async (input) => {
        if (input.op === "status") return { state: "disconnected" };
        if (input.op === "cancel") return { state: "cancelled" };
        return approved
          ? { state: "connected", login: "verified-user" }
          : { state: "pending", code: "ABCD-1234" };
      });
      await mount();
      await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
      const open = page.getByRole("button", { name: "Open GitHub", exact: true });
      await expect.element(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
      expect(openExternal).not.toHaveBeenCalled();
      const shot = import.meta.env.VITE_MOSS_GITHUB_SHOTS;
      if (shot) await page.screenshot({ path: `${shot}/github-device-${name}.png` });
      await open.click();
      expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device");
      approved = true;
      await expect
        .element(page.getByRole("heading", { name: "Verified GitHub inbox" }))
        .toBeVisible();
      expect(connection.mock.calls.filter(([i]) => i.op === "start")).toHaveLength(1);
    },
  );
  it("cancels on dismissal and does not accept a late verified response", async () => {
    let finish!: (result: GitHubConnectionResult) => void;
    connection.mockImplementation(async (i) => {
      if (i.op === "status") return { state: "disconnected" };
      if (i.op === "start")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return { state: "cancelled" };
    });
    await mount();
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    finish({ state: "connected", login: "old-user" });
    await vi.waitFor(() =>
      expect(connection.mock.calls.some(([i]) => i.op === "cancel")).toBe(true),
    );
    await expect
      .element(page.getByRole("button", { name: "Connect GitHub", exact: true }))
      .toBeVisible();
    expect(page.getByRole("heading", { name: "Verified GitHub inbox" }).query()).toBeNull();
  });
  it("cancels the private ticket across a batched A to B to A account transition", async () => {
    client.setQueryData(mossServerQueryKeys.mossAccountSession(), member);
    connection.mockImplementation(async (i) =>
      i.op === "start" || i.op === "poll"
        ? { state: "pending", code: "ABCD-1234" }
        : { state: "disconnected" },
    );
    await mount();
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    await expect.element(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
    client.setQueryData(mossServerQueryKeys.mossAccountSession(), {
      ...member,
      session: { user: { id: "qa-b" } },
    });
    client.setQueryData(mossServerQueryKeys.mossAccountSession(), member);
    await vi.waitFor(() =>
      expect(connection.mock.calls.some(([i]) => i.op === "cancel")).toBe(true),
    );
    await expect
      .element(page.getByRole("button", { name: "Connect GitHub", exact: true }))
      .toBeVisible();
    expect(page.getByText("ABCD-1234", { exact: true }).query()).toBeNull();
  });
  it("installs GitHub CLI in place, shows progress and continues to the sign-in step", async () => {
    let polls = 0;
    connection.mockImplementation(async (i) => {
      if (i.op === "install") return { state: "installing", phase: "installing" };
      if (i.op === "status") {
        if (!connection.mock.calls.some(([input]) => input.op === "install"))
          return { state: "missing" };
        polls += 1;
        return polls < 3
          ? { state: "installing", phase: "downloading" }
          : polls < 5
            ? { state: "installing", phase: "downloading", percent: 42 }
            : { state: "disconnected" };
      }
      return { state: "cancelled" };
    });
    await mount();
    await page.getByRole("button", { name: "Install GitHub CLI", exact: true }).click();
    await expect.element(page.getByText("Downloading GitHub CLI…", { exact: true })).toBeVisible();
    const shot = import.meta.env.VITE_MOSS_GITHUB_SHOTS;
    if (shot) await page.screenshot({ path: `${shot}/github-cli-installing.png` });
    const bar = page.getByRole("progressbar", { name: "GitHub CLI download" });
    await expect.element(bar).toHaveAttribute("aria-valuenow", "42");
    await expect.element(page.getByText("42%", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Connect GitHub", exact: true }))
      .toBeVisible();
    expect(connection.mock.calls.filter(([i]) => i.op === "install")).toHaveLength(1);
    expect(openExternal).not.toHaveBeenCalled();
  });
  it("explains a failed install plainly and keeps the website as the fallback", async () => {
    connection.mockImplementation(async (i) => {
      if (i.op === "install") return { state: "installing", phase: "installing" };
      if (i.op === "status")
        return connection.mock.calls.some(([input]) => input.op === "install")
          ? { state: "installFailed", reason: "download-failed" }
          : { state: "missing" };
      return { state: "cancelled" };
    });
    await mount();
    await page.getByRole("button", { name: "Install GitHub CLI", exact: true }).click();
    await expect
      .element(page.getByText("GitHub CLI could not be installed", { exact: true }))
      .toBeVisible();
    const shot = import.meta.env.VITE_MOSS_GITHUB_SHOTS;
    if (shot) await page.screenshot({ path: `${shot}/github-cli-install-failed.png` });
    await expect
      .element(page.getByRole("button", { name: "Try again", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Open the GitHub CLI website", exact: true }).click();
    expect(openExternal).toHaveBeenCalledWith("https://cli.github.com/");
  });
  it("offers the fixed verification address when the system browser cannot open", async () => {
    openExternal.mockRejectedValueOnce(new Error("unavailable"));
    connection.mockImplementation(async (i) =>
      i.op === "start" || i.op === "poll"
        ? { state: "pending", code: "ABCD-1234" }
        : { state: "disconnected" },
    );
    await mount();
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    await page.getByRole("button", { name: "Open GitHub", exact: true }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect
      .element(page.getByText("https://github.com/login/device", { exact: true }))
      .toBeVisible();
  });
  it("offers GitHub on an actual first Moss sign-in, permits skip and remembers it across a remount", async () => {
    connection.mockResolvedValue({ state: "disconnected" });
    await mount(true);
    expect(connection).not.toHaveBeenCalled();
    await authenticate();
    await expect
      .element(page.getByRole("heading", { name: "Connect GitHub to Moss" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await cleanup();
    await mount(true);
    expect(page.getByRole("dialog").query()).toBeNull();
    expect(connection.mock.calls.every(([i]) => i.op === "status")).toBe(true);
  });
  it("keeps an existing signed-in profile quiet on upgrade", async () => {
    client.setQueryData(mossServerQueryKeys.mossAccountSession(), member);
    await mount(true);
    expect(connection).not.toHaveBeenCalled();
    expect(page.getByRole("dialog").query()).toBeNull();
  });
  it("observes the real enterprise login mutation after rendering the signed-out home", async () => {
    const signedOut = {
      configured: true,
      authenticated: false,
      keyPrefix: null,
      verifiedAt: null,
      modelCount: 0,
      active: false,
    };
    const signedIn = {
      ...signedOut,
      authenticated: true,
      active: true,
      keyPrefix: "qa",
      modelCount: 1,
    };
    const signIn = vi.fn(async () => signedIn);
    Object.assign(window.nativeApi!, {
      server: {
        signInMossEnterpriseKey: signIn,
        refreshProviders: async () => {},
        getConfig: async () => ({}),
        getSettings: async () => ({}),
      },
    });
    connection.mockResolvedValue({ state: "disconnected" });
    client.setQueryData(mossServerQueryKeys.mossEnterpriseKeyState(), signedOut);
    await mount(true);
    expect(connection).not.toHaveBeenCalled();
    const mutation = client
      .getMutationCache()
      .build(client, serverMossEnterpriseKeySignInMutationOptions({ queryClient: client }));
    await mutation.execute({ apiKey: "isolated-fixture-only" });
    expect(signIn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(connection).toHaveBeenCalledWith({ op: "status" }), {
      timeout: 2000,
    });
    await expect
      .element(page.getByRole("heading", { name: "Connect GitHub to Moss" }))
      .toBeVisible();
  });
});
