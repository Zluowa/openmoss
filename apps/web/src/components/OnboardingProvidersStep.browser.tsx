import "../index.css";

import type { ServerProviderStatus } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProvidersStep } from "../onboarding/steps/ProvidersStep";
import { useProviderDetection } from "../onboarding/useProviderDetection";
import { MOSS_ACTIVE_PROVIDER_KINDS } from "../providerProductCatalog";
import { buildThemeCssVariables, getCodeThemeSeed } from "../theme/theme.logic";

const mocks = vi.hoisted(() => ({
  disabledProviders: [] as string[],
  updateSettingsAndWait: vi.fn(),
  getConfig: vi.fn(),
  refreshProviders: vi.fn(),
  startProviderLogin: vi.fn(),
  cancelProviderLogin: vi.fn(),
  installProvider: vi.fn(),
}));
vi.mock("../nativeApi", () => {
  const api = {
    server: {
      getConfig: mocks.getConfig,
      refreshProviders: mocks.refreshProviders,
      startProviderLogin: mocks.startProviderLogin,
      cancelProviderLogin: mocks.cancelProviderLogin,
      installProvider: mocks.installProvider,
    },
    shell: { openExternal: vi.fn() },
  };
  return { ensureNativeApi: () => api, readNativeApi: () => api };
});
vi.mock("../appSettings", () => {
  return {
    useAppSettings: () => ({
      settings: { disabledProviders: mocks.disabledProviders },
      updateSettingsAndWait: mocks.updateSettingsAndWait,
    }),
    getCustomBinaryPathForProvider: () => null,
  };
});
vi.mock("../workspacePathsStore", () => ({
  useWorkspacePathsStore: (select: (state: { homeDir: null }) => unknown) =>
    select({ homeDir: null }),
}));

const codexStatus: ServerProviderStatus = {
  provider: "codex",
  instanceId: "codex",
  driver: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-09-23T13:33:18.154Z",
};

const clients: QueryClient[] = [];
beforeEach(() => {
  mocks.disabledProviders = [];
  mocks.updateSettingsAndWait
    .mockReset()
    .mockImplementation(async (patch: { disabledProviders: string[] }) => {
      mocks.disabledProviders = patch.disabledProviders;
    });
  mocks.getConfig.mockReset().mockResolvedValue({ providers: [] });
  mocks.refreshProviders.mockReset();
  mocks.startProviderLogin.mockReset();
  mocks.cancelProviderLogin.mockReset();
  mocks.installProvider.mockReset();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function ProvidersStepWithDetection() {
  const detection = useProviderDetection();
  return <ProvidersStep detection={detection} />;
}

async function renderStep(constrained = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <div
        style={
          constrained
            ? { display: "flex", flexDirection: "column", width: 760, height: 320 }
            : undefined
        }
      >
        <ProvidersStepWithDetection />
      </div>
    </QueryClientProvider>,
  );
}

it("does not report agents as not installed while the first probe is running", async () => {
  const pendingRefreshes: Array<(result: { providers: ServerProviderStatus[] }) => void> = [];
  mocks.refreshProviders.mockImplementation(
    () => new Promise((resolve) => pendingRefreshes.push(resolve)),
  );
  await renderStep();

  await expect.element(page.getByText("Detecting agents on this machine…")).toBeVisible();
  expect(page.getByText("Not installed").elements()).toHaveLength(0);

  for (const resolve of pendingRefreshes) resolve({ providers: [codexStatus] });

  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("1 connected · 0 need sign-in · 13 not installed"))
    .toBeVisible();
});

it("keeps unchecked choices visible and preserves a user's opt-out after re-detect", async () => {
  mocks.disabledProviders = [
    "cursor",
    "gemini",
    "antigravity",
    "grok",
    "opencode",
    "omp",
    "hermes",
    "devin",
    "kimi",
    "minimax",
    "zcode",
  ];
  const installedPi = {
    ...codexStatus,
    provider: "pi" as const,
    driver: "pi" as const,
    instanceId: "pi",
  };
  mocks.refreshProviders.mockResolvedValue({
    providers: MOSS_ACTIVE_PROVIDER_KINDS.map((provider) =>
      provider === "codex"
        ? codexStatus
        : provider === "claudeAgent"
          ? signedOutClaude
          : provider === "pi"
            ? installedPi
            : {
                ...codexStatus,
                provider,
                driver: provider,
                instanceId: provider,
                enabled: false,
                available: false,
                readiness: { state: "error", reason: "disabled" },
              },
    ),
  });
  await page.viewport(900, 700);
  await renderStep(true);
  await expect.element(page.getByRole("checkbox", { name: "Disable Codex" })).toBeChecked();
  const pi = page.getByRole("checkbox", { name: "Disable Pi" });
  await expect.element(pi).toBeChecked();
  expect(getComputedStyle(pi.element()).width).toBe("20px");
  const cards = [...document.querySelectorAll("[data-onboarding-agent]")].map((node) =>
    node.getAttribute("data-onboarding-agent"),
  );
  expect(cards.slice(0, 3)).toEqual(["codex", "claudeAgent", "pi"]);
  await pi.click();
  await expect.element(page.getByRole("checkbox", { name: "Enable Pi" })).not.toBeChecked();
  await page.getByRole("button", { name: "Re-detect" }).click();
  await expect.element(page.getByRole("checkbox", { name: "Enable Pi" })).not.toBeChecked();
  expect(mocks.disabledProviders).toContain("pi");
  const card = document.querySelector('[data-onboarding-agent="pi"]')!;
  expect(getComputedStyle(card).opacity).toBe("1");
  await expect.element(page.getByRole("button", { name: "Re-detect" })).toBeVisible();
  await page.screenshot({ path: "provider-selection-feedback.png" });
  const root = document.documentElement;
  const previousStyle = root.getAttribute("style");
  const previousBodyStyle = document.body.getAttribute("style");
  const previousDark = root.classList.contains("dark");
  try {
    root.classList.add("dark");
    const theme = buildThemeCssVariables(
      { codeThemeId: "one", theme: getCodeThemeSeed("one", "dark") },
      "dark",
      { electron: true, systemUiFont: true },
    );
    for (const [key, value] of Object.entries(theme.variables)) root.style.setProperty(key, value);
    document.body.style.background = "var(--background)";
    document.body.style.color = "var(--foreground)";
    await expect.element(page.getByRole("checkbox", { name: "Enable Pi" })).not.toBeChecked();
    await page.screenshot({ path: "provider-selection-one-dark.png" });
  } finally {
    if (previousStyle === null) root.removeAttribute("style");
    else root.setAttribute("style", previousStyle);
    if (previousBodyStyle === null) document.body.removeAttribute("style");
    else document.body.setAttribute("style", previousBodyStyle);
    root.classList.toggle("dark", previousDark);
  }
});

it("leaves missing agents unknown after a timeout and recovers on retry", async () => {
  const pendingRefreshes: Array<(error: Error) => void> = [];
  mocks.refreshProviders.mockImplementation(
    () => new Promise((_resolve, reject) => pendingRefreshes.push(reject)),
  );
  await renderStep();

  await expect.element(page.getByText("Detecting agents on this machine…")).toBeVisible();

  for (const reject of pendingRefreshes) reject(new Error("WebSocket RPC timed out"));

  await expect.element(page.getByText("Couldn't check all agents. Try Re-detect.")).toBeVisible();
  expect(page.getByText("Not installed").elements()).toHaveLength(0);

  mocks.refreshProviders.mockResolvedValue({ providers: [codexStatus] });
  await page.getByRole("button", { name: "Re-detect" }).click();
  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("1 connected · 0 need sign-in · 13 not installed"))
    .toBeVisible();
});

const signedOutClaude: ServerProviderStatus = {
  provider: "claudeAgent",
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  status: "error",
  available: true,
  authStatus: "unauthenticated",
  readiness: { state: "needsLogin", reason: "agent-sign-in" },
  message: "Claude is not authenticated. Run `claude auth login` and try again.",
  checkedAt: "2026-09-23T13:33:18.154Z",
};

const missingOpenCode: ServerProviderStatus = {
  provider: "opencode",
  instanceId: "opencode",
  driver: "opencode",
  status: "error",
  available: false,
  authStatus: "unknown",
  readiness: { state: "notInstalled", install: "oneClick" },
  checkedAt: "2026-09-23T13:33:18.154Z",
};

it("signs in through the browser and installs in place, never with a command", async () => {
  mocks.refreshProviders.mockResolvedValue({
    providers: [codexStatus, signedOutClaude, missingOpenCode],
  });
  mocks.startProviderLogin.mockResolvedValue({
    providers: [
      codexStatus,
      {
        ...signedOutClaude,
        loginState: {
          status: "waiting_browser",
          startedAt: "2026-09-23T13:34:00.000Z",
          finishedAt: null,
          message: "Finish sign-in in your browser.",
        },
      },
      missingOpenCode,
    ],
  });
  mocks.cancelProviderLogin.mockResolvedValue({
    providers: [
      codexStatus,
      {
        ...signedOutClaude,
        loginState: {
          status: "cancelled",
          startedAt: "2026-09-23T13:34:00.000Z",
          finishedAt: "2026-09-23T13:34:05.000Z",
          message: "Sign-in cancelled.",
        },
      },
      missingOpenCode,
    ],
  });
  let finishInstall: ((value: { providers: ServerProviderStatus[] }) => void) | undefined;
  mocks.installProvider.mockImplementation(
    () => new Promise((resolve) => (finishInstall = resolve)),
  );
  // The tour's dialog is 800px wide; the default 414px viewport squeezes each card.
  await page.viewport(900, 700);
  await renderStep();

  await page.getByRole("button", { name: "Sign in for Claude" }).click();
  expect(mocks.startProviderLogin).toHaveBeenCalledWith({
    provider: "claudeAgent",
    instanceId: "claudeAgent",
  });
  await expect.element(page.getByText("Finish in your browser")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(mocks.cancelProviderLogin).toHaveBeenCalledWith({
    provider: "claudeAgent",
    instanceId: "claudeAgent",
  });
  await expect.element(page.getByRole("button", { name: "Sign in for Claude" })).toBeVisible();

  await page.getByRole("button", { name: "Install OpenCode" }).click();
  expect(mocks.installProvider).toHaveBeenCalledWith({ provider: "opencode" });
  await expect.element(page.getByText("Installing…")).toBeVisible();
  finishInstall?.({ providers: [codexStatus, signedOutClaude, { ...missingOpenCode }] });

  // No command, path or CLI diagnostic reaches the person.
  const text = document.body.textContent ?? "";
  expect(text).not.toMatch(/auth login|codex login|Guide|PATH|CLI/u);
});
