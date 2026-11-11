import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type ServerProviderStatus,
  type ServerProviderUsageSnapshot,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@moss/contracts";
import { PROVIDER_DESCRIPTORS } from "@moss/shared/providerMetadata";
import { page, userEvent } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode, useState } from "react";

const harness = vi.hoisted(() => ({
  statuses: [] as ServerProviderStatus[],
  usage: [] as ServerProviderUsageSnapshot[],
  reconciled: true,
  refresh: vi.fn(),
  invalidate: vi.fn(async () => {}),
  terminalListener: null as ((event: TerminalEvent) => void) | null,
  api: {
    dialogs: { pickFolder: vi.fn<() => Promise<string | null>>() },
    terminal: {
      open: vi.fn(),
      write: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      ackOutput: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(),
    },
    shell: { openExternal: vi.fn(async () => {}) },
    server: {
      installProvider: vi.fn(async (_input: { provider: string }) => ({
        providers: [] as ServerProviderStatus[],
      })),
      refreshProviders: vi.fn(async () => ({ providers: [] })),
      startProviderLogin: vi.fn(async (_input: { provider: string; instanceId: string }) => ({
        providers: [] as ServerProviderStatus[],
      })),
      cancelProviderLogin: vi.fn(async (_input: { provider: string; instanceId: string }) => ({
        providers: [] as ServerProviderStatus[],
      })),
    },
  },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const queryClient = { invalidateQueries: harness.invalidate };
  return {
    ...(await importOriginal<typeof import("@tanstack/react-query")>()),
    useQueryClient: () => queryClient,
    useQuery: (options: { queryKey?: readonly string[] }) => ({
      data:
        options.queryKey?.[1] === "allProviderUsage"
          ? harness.usage
          : options.queryKey?.[1] === "settings"
            ? DEFAULT_SERVER_SETTINGS
            : { providers: harness.statuses, cwd: "/tmp" },
      isPending: false,
    }),
  };
});
vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  serverConfigQueryOptions: () => ({}),
  serverSettingsQueryOptions: () => ({ queryKey: ["server", "settings"] }),
  hasReconciledServerProviderStatuses: () => harness.reconciled,
  reconcileServerProviderStatuses: vi.fn(async () => {}),
  serverQueryKeys: {
    config: () => ["config"],
    settings: () => ["settings"],
    allProviderUsage: () => ["server", "allProviderUsage"],
  },
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => harness.statuses,
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => harness.refresh,
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

const localizationTestState = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
}));

// The bare mount falls back to the localization context default (zh-CN); pin
// English so role locators match the rendered labels.
vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});

import { AppSettingsSchema, type AppSettings } from "~/appSettings";
import { isMossActiveProvider } from "~/providerProductCatalog";
import { installZhCnUiLocalization } from "~/localization/zhCN";

import { ProvidersSettingsPanel } from "./ProvidersSettingsPanel";
import TerminalViewport from "../terminal/TerminalViewport";
import { terminalRuntimeRegistry } from "../terminal/terminalRuntimeRegistry";

const defaults = AppSettingsSchema.makeUnsafe({});
const props = {
  defaults,
  settings: { ...defaults, disabledProviders: ["grok" as const] },
  updateSettings: vi.fn(),
  updateSettingsAndWait: vi.fn(async () => {}),
  active: true,
  resetEpoch: 0,
  // These legacy cases exercise advanced tools explicitly; the default-collapse
  // regression below mounts without a target.
  providerTarget: "codex" as const,
};

beforeEach(() => {
  harness.api.shell.openExternal.mockClear();
  harness.api.dialogs.pickFolder.mockReset();
  harness.usage = [];
  harness.reconciled = true;
  harness.refresh.mockReset();
  harness.api.terminal.open.mockReset().mockImplementation(async (input: TerminalOpenInput) => ({
    ...input,
    status: "running",
    history: "",
    pid: 1234,
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-02T12:00:00Z",
  }));
  harness.api.terminal.write.mockClear();
  harness.api.terminal.close.mockReset().mockResolvedValue(undefined);
  harness.api.terminal.onEvent.mockImplementation((listener: (event: TerminalEvent) => void) => {
    harness.terminalListener = listener;
    return () => {
      harness.terminalListener = null;
    };
  });
  harness.statuses = PROVIDER_DESCRIPTORS.map(({ kind }) => ({
    provider: kind,
    instanceId: kind,
    driver: kind,
    status: kind === "opencode" ? "error" : "ready",
    available: kind !== "opencode",
    authStatus: kind === "claudeAgent" ? "unauthenticated" : "authenticated",
    checkedAt: "2026-09-16T21:46:18.000Z",
    ...(kind === "opencode"
      ? { message: "OpenCode CLI (`opencode`) is not installed or not on PATH." }
      : {}),
  }));
});

function activityRow(provider: string) {
  return page
    .getByRole("switch", { name: `Disable ${provider}`, exact: true })
    .element()
    .closest('[data-slot="settings-row"]')!;
}

it("keeps technical settings folded until the person asks for them", async () => {
  await page.viewport(1000, 780);
  await render(<ProvidersSettingsPanel {...props} providerTarget={null} />);
  expect(page.getByRole("switch", { name: "Keep Moss responsive" }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: "Advanced settings", exact: true }).click();
  await expect.element(page.getByRole("switch", { name: "Keep Moss responsive" })).toBeVisible();
});

it("opens setup guides through the native browser action", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "cursor"
      ? {
          ...status,
          available: false,
          status: "error",
          readiness: { state: "error", reason: "failed-to-run" },
        }
      : status,
  );
  await render(<ProvidersSettingsPanel {...props} providerTarget={null} />);
  await page.getByRole("button", { name: "Cursor setup guide", exact: true }).click();
  expect(harness.api.shell.openExternal).toHaveBeenCalledWith(
    "https://cursor.com/docs/cli/overview",
  );
});

it("uses a progress cursor while saving an agent switch", async () => {
  let settle!: () => void;
  const updateSettingsAndWait = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  await render(<ProvidersSettingsPanel {...props} updateSettingsAndWait={updateSettingsAndWait} />);
  const control = page.getByRole("switch", { name: "Disable Codex", exact: true });
  await control.click();
  await expect.element(control).toBeDisabled();
  expect(getComputedStyle(control.element()).cursor).toBe("progress");
  settle();
  await expect.element(control).toBeEnabled();
});

it("saves provider CPU priority opt-out and exposes reset to the default", async () => {
  const updateSettings = vi.fn();
  const result = await render(
    <ProvidersSettingsPanel {...props} updateSettings={updateSettings} />,
  );
  const control = page.getByRole("switch", { name: "Keep Moss responsive" });
  await expect.element(control).toBeChecked();
  await control.click();
  expect(updateSettings).toHaveBeenCalledWith({ lowerProviderProcessPriority: false });
  await result.rerender(
    <ProvidersSettingsPanel
      {...props}
      settings={{ ...props.settings, lowerProviderProcessPriority: false }}
      updateSettings={updateSettings}
    />,
  );
  await page.getByRole("button", { name: "Reset Keep Moss responsive to default" }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({ lowerProviderProcessPriority: true });
  expect(control.element().closest('[data-slot="settings-row"]')?.textContent).toContain(
    "Restart existing sessions",
  );
});

it("installs a missing agent in one click and says plainly how it went", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "opencode"
      ? {
          ...status,
          message:
            "OpenCode CLI (`opencode`) is not installed or not on PATH. Install it with `npm install -g opencode-ai`.",
        }
      : status,
  );
  let finish!: () => void;
  harness.api.server.installProvider.mockReset().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ providers: [] });
      }),
  );
  await render(<ProvidersSettingsPanel {...props} />);
  const install = page
    .elementLocator(activityRow("OpenCode"))
    .getByRole("button", { name: "Install", exact: true });
  await install.click();
  expect(harness.api.server.installProvider).toHaveBeenCalledWith({ provider: "opencode" });
  await expect.element(page.getByText("Installing OpenCode…")).toBeVisible();
  await expect.element(install).toBeDisabled();
  finish();
  await expect.element(page.getByText("OpenCode is installed.")).toBeVisible();
});

it("reads how a finished install ended from the agent's install state", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "opencode"
      ? { ...status, readiness: { state: "notInstalled", install: "oneClick" } }
      : status,
  );
  harness.api.server.installProvider.mockReset().mockResolvedValueOnce({
    providers: [
      {
        ...harness.statuses.find((status) => status.provider === "opencode")!,
        installState: {
          status: "failed",
          phase: null,
          source: "cn-mirror",
          startedAt: null,
          finishedAt: null,
          version: null,
          reason: "download-failed",
        },
      },
    ],
  });
  await render(<ProvidersSettingsPanel {...props} />);
  await page
    .elementLocator(activityRow("OpenCode"))
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await expect
    .element(page.getByText("Couldn't download OpenCode. Check your network and try again."))
    .toBeVisible();
  expect(page.getByText(/download-failed/u).elements()).toHaveLength(0);
});

it("opens the official page for an agent Moss cannot install in one click", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "opencode"
      ? {
          ...status,
          readiness: {
            state: "notInstalled",
            install: "externalPage",
            installUrl: "https://opencode.ai/download",
          },
        }
      : status,
  );
  harness.api.server.installProvider.mockReset();
  harness.api.shell.openExternal.mockClear();
  await render(<ProvidersSettingsPanel {...props} />);
  await page
    .elementLocator(activityRow("OpenCode"))
    .getByRole("button", { name: "Install", exact: true })
    .click();
  expect(harness.api.shell.openExternal).toHaveBeenCalledWith("https://opencode.ai/download");
  expect(harness.api.server.installProvider).not.toHaveBeenCalled();
});

it("says a failed install plainly and lets the person try again", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "opencode"
      ? {
          ...status,
          message:
            "OpenCode CLI (`opencode`) is not installed or not on PATH. Install it with `npm install -g opencode-ai`.",
        }
      : status,
  );
  harness.api.server.installProvider
    .mockReset()
    .mockRejectedValueOnce(new Error("npm ERR! code E404 /usr/lib/node_modules"));
  await render(<ProvidersSettingsPanel {...props} />);
  await page
    .elementLocator(activityRow("OpenCode"))
    .getByRole("button", { name: "Install", exact: true })
    .click();
  await expect
    .element(page.getByText("Couldn't download OpenCode. Check your network and try again."))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  expect(page.getByText(/npm ERR/u).elements()).toHaveLength(0);
});

it("shows each agent's state with one plain line and one action, no setup guides", async () => {
  await render(<ProvidersSettingsPanel {...props} />);
  // A missing agent says so plainly and offers one install button, not the CLI's diagnostic.
  expect(activityRow("OpenCode").textContent).toContain("OpenCode isn't on this computer yet.");
  expect(activityRow("OpenCode").textContent).not.toContain("not on PATH");
  await expect
    .element(
      page
        .elementLocator(activityRow("OpenCode"))
        .getByRole("button", { name: "Install", exact: true }),
    )
    .toBeVisible();
  // A signed-out agent asks for a sign-in Moss runs itself, never a command.
  expect(activityRow("Claude").textContent).toContain("Sign in to your Claude account to use it.");
  expect(activityRow("Claude").textContent).not.toMatch(/auth login|codex login/u);
  await expect
    .element(page.getByRole("button", { name: "Sign in for Claude", exact: true }))
    .toBeVisible();
  expect(activityRow("Codex").textContent).toContain("Connected");
  await page.getByRole("button", { name: /Disabled providers/u }).click();
  expect(
    page
      .getByRole("switch", { name: "Enable Grok", exact: true })
      .element()
      .closest('[data-slot="settings-row"]')?.textContent,
  ).toContain("Disabled · enable to check setup");
  // Permission to run remains enabled even if the CLI is missing.
  await expect
    .element(page.getByRole("switch", { name: "Disable OpenCode", exact: true }))
    .toBeChecked();
  // Moss installs and signs agents in itself, so no row sends people to a setup guide.
  expect(page.getByRole("link", { name: /setup guide/u }).elements()).toHaveLength(0);
});

it("says an agent is connected through Moss, with no sign-in, while its Moss lane works", async () => {
  // The owner's own Claude login is signed out, but Claude over Moss is up.
  harness.statuses = [
    ...harness.statuses,
    {
      provider: "claudeAgent",
      instanceId: "claude_moss",
      driver: "claudeAgent",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-09-16T21:46:18.000Z",
    },
  ];
  await render(<ProvidersSettingsPanel {...props} />);
  await vi.waitFor(() =>
    expect(activityRow("Claude").textContent).toContain("Connected through Moss"),
  );
  expect(activityRow("Claude").textContent).not.toContain("Sign in to your Claude account");
  expect(
    page.getByRole("button", { name: "Sign in for Claude", exact: true }).elements(),
  ).toHaveLength(0);
});

it("signs an agent in through the browser and lets the person cancel", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "codex"
      ? {
          ...status,
          status: "error",
          authStatus: "unauthenticated",
          message: "Codex CLI is not authenticated. Run `codex login` and try again.",
        }
      : status,
  );
  harness.api.server.startProviderLogin.mockClear();
  harness.api.server.cancelProviderLogin.mockClear();
  const result = await render(<ProvidersSettingsPanel {...props} />);
  expect(activityRow("Codex").textContent).not.toContain("codex login");
  await page.getByRole("button", { name: "Sign in for Codex", exact: true }).click();
  expect(harness.api.server.startProviderLogin).toHaveBeenCalledWith({
    provider: "codex",
    instanceId: "codex",
  });

  // The server reports the browser step; the row waits calmly with a way out.
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "codex"
      ? {
          ...status,
          loginState: {
            status: "waiting_browser",
            startedAt: "2026-09-16T21:47:00.000Z",
            finishedAt: null,
            message: "Finish sign-in in your browser.",
          },
        }
      : status,
  );
  await result.rerender(<ProvidersSettingsPanel {...props} />);
  await expect.element(page.getByText("Finish signing in in your browser")).toBeVisible();
  await page.getByRole("button", { name: "Cancel sign-in for Codex", exact: true }).click();
  expect(harness.api.server.cancelProviderLogin).toHaveBeenCalledWith({
    provider: "codex",
    instanceId: "codex",
  });

  // The credential landed: the row reads connected and the action is gone.
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "codex"
      ? {
          ...status,
          status: "ready",
          authStatus: "authenticated",
          message: undefined,
          loginState: {
            status: "succeeded",
            startedAt: "2026-09-16T21:47:00.000Z",
            finishedAt: "2026-09-16T21:47:09.000Z",
            message: "Signed in.",
          },
        }
      : status,
  );
  await result.rerender(<ProvidersSettingsPanel {...props} />);
  expect(activityRow("Codex").textContent).toContain("Connected");
  expect(
    page.getByRole("button", { name: "Sign in for Codex", exact: true }).elements(),
  ).toHaveLength(0);
});

it("keeps disabled providers only in a collapsed recovery list", async () => {
  await render(<ProvidersSettingsPanel {...props} />);
  expect(page.getByRole("switch", { name: "Enable Grok", exact: true }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Reorder Grok", exact: true }).elements()).toHaveLength(
    0,
  );
  expect(page.getByRole("button", { name: "Grok", exact: true }).elements()).toHaveLength(0);
  const recovery = page.getByRole("button", { name: /Disabled providers/u });
  await expect.element(recovery).toHaveAttribute("aria-expanded", "false");
  await recovery.click();
  await expect
    .element(page.getByRole("switch", { name: "Enable Grok", exact: true }))
    .toBeVisible();
  expect(page.getByRole("button", { name: "Reorder Grok", exact: true }).elements()).toHaveLength(
    0,
  );
  expect(page.getByRole("button", { name: "Grok", exact: true }).elements()).toHaveLength(0);
});

it("restores provider options and saved configuration after re-enabling", async () => {
  function Harness() {
    const [settings, setSettings] = useState<AppSettings>({
      ...defaults,
      codexBinaryPath: "/custom/codex",
      hiddenProviders: ["codex"],
    });
    const updateSettings = (patch: Partial<AppSettings>) =>
      setSettings((current) => ({ ...current, ...patch }));
    return (
      <ProvidersSettingsPanel
        {...props}
        settings={settings}
        updateSettings={updateSettings}
        updateSettingsAndWait={async (patch) => updateSettings(patch)}
      />
    );
  }
  await render(<Harness />);
  await page.getByRole("switch", { name: "Disable Codex", exact: true }).click();
  expect(page.getByRole("button", { name: "Reorder Codex", exact: true }).elements()).toHaveLength(
    0,
  );
  expect(page.getByRole("button", { name: /Codex Custom/u }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: /Disabled providers/u }).click();
  await page.getByRole("switch", { name: "Enable Codex", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Reorder Codex", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("switch", { name: "Show Codex in the provider picker", exact: true }))
    .not.toBeChecked();
  await expect
    .element(page.getByRole("button", { name: /Codex Custom/u }))
    .toHaveAttribute("aria-expanded", "true");
  const binaryPath = page
    .getByRole("group", { name: "Codex account", exact: true })
    .getByRole("textbox", { name: /^Codex binary path/u });
  await expect.element(binaryPath).toHaveValue("/custom/codex");
});

it("allows recovering after every provider is disabled", async () => {
  await render(
    <ProvidersSettingsPanel
      {...props}
      settings={{ ...defaults, disabledProviders: [...defaults.providerOrder] }}
    />,
  );
  expect(page.getByRole("button", { name: /^Reorder /u }).elements()).toHaveLength(0);
  expect(page.getByRole("switch", { name: /^Disable /u }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: /Disabled providers/u }).click();
  await expect
    .element(page.getByRole("switch", { name: "Enable Codex", exact: true }))
    .toBeVisible();
});

it("does not report cached provider health as connected before reconciliation", async () => {
  harness.reconciled = false;
  await render(<ProvidersSettingsPanel {...props} />);
  expect(activityRow("Codex").textContent).toContain("Checking setup");
  expect(activityRow("Codex").textContent).not.toContain("Connected");
});

it("allows rechecking setup after installing externally and blocks duplicate refreshes", async () => {
  let finish!: () => void;
  harness.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render(<ProvidersSettingsPanel {...props} />);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  expect(harness.refresh).toHaveBeenCalledOnce();
  await expect
    .element(page.getByRole("button", { name: "Checking setup", exact: true }))
    .toBeDisabled();
  finish();
  await expect
    .element(page.getByRole("button", { name: "Refresh status", exact: true }))
    .toBeEnabled();
});

// --- Accounts: one list per provider, default included, with an editor beside it. ---

const WORK_STATUS: ServerProviderStatus = {
  provider: "codex",
  instanceId: "codex_work",
  driver: "codex",
  displayName: "Work",
  status: "error",
  available: true,
  authStatus: "unauthenticated",
  checkedAt: "2026-09-16T21:46:18.000Z",
  message: "Codex CLI is not authenticated.",
};

function accountProps(settings: Partial<typeof defaults> = {}) {
  const updateSettings = vi.fn();
  return {
    updateSettings,
    props: {
      ...props,
      updateSettings,
      providerTarget: "codex" as const,
      settings: {
        ...defaults,
        providerInstances: {
          codex_work: {
            driver: "codex",
            displayName: "Work",
            accentColor: "#16a34a",
            enabled: true,
            config: {},
          },
          codex_old: { driver: "codex", displayName: "Old", enabled: false, config: {} },
        },
        ...settings,
      },
    },
  };
}

function codexAccountRow(name: string) {
  return page
    .getByRole("button", { name: `Select ${name}`, exact: true })
    .element()
    .closest<HTMLElement>('[role="listitem"]')!;
}

it("keeps the default account name when restoring its account defaults", async () => {
  const { props: panelProps, updateSettings } = accountProps({
    providerInstances: {
      codex: { driver: "codex", displayName: "Personal", accentColor: "#16a34a", enabled: false },
    },
  });
  await render(<ProvidersSettingsPanel {...panelProps} />);
  await page.getByRole("button", { name: /Reset Personal account/ }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({
    providerInstances: {
      codex: { driver: "codex", displayName: "Personal" },
    },
  });
});

it("shows a Claude usage authentication failure beside a locally signed-in account", async () => {
  harness.statuses = harness.statuses.map((status) =>
    status.provider === "claudeAgent" ? { ...status, authStatus: "authenticated" } : status,
  );
  harness.statuses.push({
    ...WORK_STATUS,
    provider: "claudeAgent",
    driver: "claudeAgent",
    instanceId: "claude_work",
    authStatus: "authenticated",
    status: "ready",
  });
  harness.usage = [
    {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      status: "needs-auth",
      source: "claude-oauth-usage",
      updatedAt: new Date().toISOString(),
      limits: [],
      usageLines: [],
      detail: "Claude usage credentials were rejected. Sign in again.",
    },
  ];
  const { props: panelProps } = accountProps({
    providerInstances: { claude_work: { driver: "claudeAgent", displayName: "Work", config: {} } },
  });
  await render(<ProvidersSettingsPanel {...panelProps} providerTarget="claudeAgent" />);
  const editor = page.getByRole("group", { name: "Claude account", exact: true });
  await expect.element(editor.getByText("Usage needs attention", { exact: true })).toBeVisible();
  await expect
    .element(editor.getByText("Claude usage credentials were rejected. Sign in again."))
    .toBeVisible();
  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  await expect
    .element(
      page
        .getByRole("group", { name: "Work account", exact: true })
        .getByText("Signed in locally", { exact: true }),
    )
    .toBeVisible();
});

it("lists every account of a provider, default included, with a status title and a switch", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  await render(<ProvidersSettingsPanel {...accountProps().props} />);

  await expect
    .element(page.getByRole("list", { name: "Codex accounts", exact: true }))
    .toBeVisible();
  expect(codexAccountRow("Codex").textContent).toContain("Authenticated");
  expect(codexAccountRow("Work").textContent).toContain("Not authenticated");
  expect(codexAccountRow("Old").textContent).toContain("Disabled");
  // Names tell the accounts apart; an accent washes the icon of the one that has it.
  expect(codexAccountRow("Work").querySelector<HTMLElement>("[data-accent]")?.dataset.accent).toBe(
    "#16a34a",
  );
  expect(codexAccountRow("Codex").querySelector("[data-accent]")).toBeNull();

  await expect
    .element(page.getByRole("switch", { name: "Enable Codex", exact: true }))
    .toBeChecked();
  await expect
    .element(page.getByRole("switch", { name: "Enable Old", exact: true }))
    .not.toBeChecked();

  // The default account opens first: its runtime paths, and no way to remove it.
  const editor = page.getByRole("group", { name: "Codex account", exact: true });
  await expect.element(editor.getByText("Codex binary path")).toBeVisible();
  expect(editor.getByRole("button", { name: "Remove" }).elements()).toHaveLength(0);
});

async function captureHistorySettings(provider: "codex" | "claude", group: HTMLElement) {
  if (import.meta.env.VITE_MOSS_HISTORY_SETTINGS_SHOTS !== "1") return;
  const root = document.documentElement;
  const previous = {
    lang: root.lang,
    locale: root.getAttribute("data-moss-locale"),
    dark: root.classList.contains("dark"),
  };
  try {
    await page.viewport(1040, 980);
    for (const locale of ["en", "zh-CN"] as const) {
      root.lang = locale;
      root.setAttribute("data-moss-locale", locale);
      const restore = installZhCnUiLocalization();
      try {
        const label =
          locale === "en"
            ? `Share ${provider === "codex" ? "Codex" : "Claude"} history across accounts`
            : `在账号之间共享 ${provider === "codex" ? "Codex" : "Claude"} 历史`;
        expect(group.textContent).toContain(label);
        for (const theme of ["light", "dark"]) {
          root.classList.toggle("dark", theme === "dark");
          await page.elementLocator(group).screenshot({
            path: `../../../node_modules/.cache/history-settings/${provider}-${locale}-${theme}.png`,
          });
        }
      } finally {
        restore();
      }
    }
  } finally {
    root.lang = previous.lang;
    if (previous.locale === null) root.removeAttribute("data-moss-locale");
    else root.setAttribute("data-moss-locale", previous.locale);
    root.classList.toggle("dark", previous.dark);
  }
}

it("shows an unavailable version lookup for the installed Codex account in the row and summary", async () => {
  const codex = harness.statuses.find((s) => s.provider === "codex")!;
  harness.statuses = [
    ...harness.statuses.filter((s) => s.provider !== "codex"),
    { ...codex, available: false },
    {
      ...codex,
      instanceId: "codex_own",
      available: true,
      version: "0.166.0",
      versionAdvisory: {
        currentVersion: "0.166.0",
        latestVersion: null,
        latestVersionKnowable: true,
        status: "unknown",
        canUpdate: false,
        updateCommand: null,
        checkedAt: codex.checkedAt,
        message: null,
      },
    },
  ];
  await render(<ProvidersSettingsPanel {...props} />);
  await expect
    .element(page.getByText("Installed v0.166.0 · Latest version unavailable", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("Latest version unavailable for some tools", { exact: true }).first())
    .toBeVisible();
  const root = document.documentElement;
  const previous = { lang: root.lang, locale: root.getAttribute("data-moss-locale") };
  root.lang = "zh-CN";
  root.setAttribute("data-moss-locale", "zh-CN");
  const restore = installZhCnUiLocalization();
  try {
    await expect
      .element(page.getByText("已安装 v0.166.0；暂时无法查询最新版本", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("部分工具暂时无法查询最新版本", { exact: true }).first())
      .toBeVisible();
  } finally {
    restore();
    root.lang = previous.lang;
    if (previous.locale === null) root.removeAttribute("data-moss-locale");
    else root.setAttribute("data-moss-locale", previous.locale);
  }
});

it("keeps the Codex shared source and default account's private directory separate", async () => {
  const { props: panelProps, updateSettings } = accountProps({
    codexShareStateAcrossAccounts: true,
    codexHomePath: "/existing/history",
    providerInstances: { codex: { driver: "codex", config: { cliAlias: "codex-personal" } } },
  });
  vi.stubGlobal("desktopBridge", {});
  try {
    await render(<ProvidersSettingsPanel {...panelProps} />);
    const editor = page.getByRole("group", { name: "Codex account", exact: true });
    const source = editor.getByRole("textbox", { name: "CODEX_HOME path" });
    await expect.element(source).toHaveValue("/existing/history");
    harness.api.dialogs.pickFolder.mockResolvedValueOnce("/private/own");
    await editor.getByRole("button", { name: "Choose folder" }).last().click();
    expect(updateSettings).toHaveBeenLastCalledWith({
      providerInstances: {
        codex: {
          driver: "codex",
          config: { cliAlias: "codex-personal", shadowHomePath: "/private/own" },
        },
      },
    });
    await editor.getByRole("switch", { name: /Share Codex history across accounts/u }).click();
    expect(updateSettings).toHaveBeenLastCalledWith({ codexShareStateAcrossAccounts: false });
    await captureHistorySettings("codex", editor.element() as HTMLElement);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("picks a Claude projects source without enabling sharing or rewriting an account", async () => {
  const { props: panelProps, updateSettings } = accountProps();
  vi.stubGlobal("desktopBridge", {});
  try {
    await render(<ProvidersSettingsPanel {...panelProps} providerTarget="claudeAgent" />);
    const editor = page.getByRole("group", { name: "Claude account", exact: true });
    await expect
      .element(editor.getByRole("switch", { name: /Share Claude history across accounts/u }))
      .not.toBeChecked();
    harness.api.dialogs.pickFolder.mockResolvedValueOnce("/existing/projects");
    await editor.getByRole("button", { name: "Choose folder" }).last().click();
    expect(updateSettings).toHaveBeenLastCalledWith({
      claudeSharedProjectsPath: "/existing/projects",
    });
    await editor.getByRole("switch", { name: /Share Claude history across accounts/u }).click();
    expect(updateSettings).toHaveBeenLastCalledWith({ claudeShareStateAcrossAccounts: true });
    await expect
      .element(editor.getByText(/Existing chats keep their original source/u))
      .toBeVisible();
    await captureHistorySettings("claude", editor.element() as HTMLElement);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("edits the selected account beside the list and offers one-click sign-in", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  const { props: panelProps, updateSettings } = accountProps();
  await render(<ProvidersSettingsPanel {...panelProps} />);

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  await expect.element(editor.getByText("Not authenticated", { exact: true })).toBeVisible();
  await expect.element(editor.getByText(/Use Sign in to authenticate/u)).toBeVisible();
  await expect
    .element(editor.getByRole("button", { name: "Sign in to Work", exact: true }))
    .toBeVisible();
  await expect.element(editor.getByText("Environment variables")).toBeVisible();

  await page.getByRole("switch", { name: "Enable Work", exact: true }).click();
  expect(updateSettings).toHaveBeenLastCalledWith({
    providerInstances: expect.objectContaining({
      codex_work: expect.objectContaining({ enabled: false, displayName: "Work" }),
    }),
  });

  await editor.getByRole("button", { name: "Remove" }).click();
  const removal = updateSettings.mock.lastCall?.[0] as typeof defaults;
  expect(Object.keys(removal.providerInstances)).toEqual(["codex_old"]);
});

it("leaves Artifacts to the default Claude account and keeps another account's binary path", async () => {
  harness.statuses = [
    ...harness.statuses,
    { ...WORK_STATUS, provider: "claudeAgent", instanceId: "claude_work", driver: "claudeAgent" },
  ];
  const { props: panelProps } = accountProps({
    claudeEnableArtifacts: true,
    providerInstances: {
      claude_work: {
        driver: "claudeAgent",
        displayName: "Work",
        enabled: true,
        config: { binaryPath: "/opt/claude-2.1/bin/claude" },
      },
    },
  });
  await render(<ProvidersSettingsPanel {...panelProps} providerTarget="claudeAgent" />);

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  await editor.getByRole("button", { name: "Advanced" }).click();
  await expect
    .element(editor.getByRole("textbox", { name: "Claude binary path" }))
    .toHaveValue("/opt/claude-2.1/bin/claude");
  // The server reads Artifacts from the Claude provider setting for every account.
  expect(editor.getByRole("switch", { name: /^Artifacts/u }).elements()).toHaveLength(0);
});

it("adds an account from a dialog that derives its id from the label", async () => {
  const { props: panelProps, updateSettings } = accountProps();
  await render(<ProvidersSettingsPanel {...panelProps} />);

  await page.getByRole("button", { name: "Add account", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await expect.element(dialog).toBeVisible();

  // An id that is already taken is refused when submitting.
  await dialog.getByRole("textbox", { name: "Label" }).fill("Work");
  await expect
    .element(dialog.getByRole("textbox", { name: "Account ID" }))
    .toHaveValue("codex_work");
  await dialog.getByRole("button", { name: "Add account", exact: true }).click();
  await expect
    .element(dialog.getByText("An account with the ID 'codex_work' already exists."))
    .toBeVisible();
  expect(updateSettings).not.toHaveBeenCalled();

  await dialog.getByRole("textbox", { name: "Label" }).fill("Team EU");
  await expect
    .element(dialog.getByRole("textbox", { name: "Account ID" }))
    .toHaveValue("codex_team_eu");
  await dialog.getByRole("button", { name: /^Accent color #7c3aed/u }).click();
  await dialog.getByRole("textbox", { name: "CODEX_HOME path" }).fill("~/.codex-team");
  await dialog.getByRole("button", { name: "Add account", exact: true }).click();

  const added = updateSettings.mock.lastCall?.[0] as typeof defaults;
  expect(added.providerInstances.codex_team_eu).toEqual({
    driver: "codex",
    displayName: "Team EU",
    accentColor: "#7c3aed",
    enabled: true,
    config: { homePath: "~/.codex-team" },
  });
  // Existing accounts are left as they were.
  expect(added.providerInstances.codex_work).toEqual(
    panelProps.settings.providerInstances.codex_work,
  );
});

it("routes a migrated Codex account's rename to its saved account entry", async () => {
  const { props: panelProps, updateSettings } = accountProps({
    providerInstances: {},
    codexAccounts: [{ id: "work", label: "Work", homePath: "", shadowHomePath: "" }],
  });
  await render(<ProvidersSettingsPanel {...panelProps} />);

  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const editor = page.getByRole("group", { name: "Work account", exact: true });
  const name = editor.getByRole("textbox", { name: "Display name" });
  await name.fill("Office");
  await userEvent.tab();

  expect(updateSettings).toHaveBeenLastCalledWith({
    codexAccounts: [{ id: "work", label: "Office", homePath: "", shadowHomePath: "" }],
  });
  // Its route depends on that entry, so it gets no environment of its own.
  expect(editor.getByText("Environment variables").elements()).toHaveLength(0);
});

it("survives StrictMode, waits for account edits, and verifies selected-account auth rather than trusting CLI exit", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  let finishSave!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  await render(
    <StrictMode>
      <ProvidersSettingsPanel {...accountProps().props} updateSettingsAndWait={save} />
    </StrictMode>,
  );
  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  const signIn = page.getByRole("button", { name: "Sign in to Work", exact: true });
  await signIn.click();
  await expect.element(signIn).toBeDisabled();
  expect(harness.api.terminal.open).not.toHaveBeenCalled();
  finishSave();
  const dialog = page.getByRole("dialog", { name: "Sign in to Work" });
  await expect.element(dialog).toBeVisible();
  await expect.poll(() => harness.api.terminal.open.mock.calls.length).toBeGreaterThan(0);
  const input = harness.api.terminal.open.mock.calls[0]![0] as TerminalOpenInput;
  expect(input.providerAuthInstanceId).toBe("codex_work");
  expect(input.env).toBeUndefined();
  await expect.poll(() => dialog.element().querySelector(".xterm-screen")).not.toBeNull();
  expect(harness.api.terminal.close).not.toHaveBeenCalledWith(
    expect.objectContaining({ threadId: input.threadId }),
  );
  harness.refresh.mockResolvedValue([WORK_STATUS]);
  harness.terminalListener?.({
    type: "exited",
    threadId: input.threadId,
    terminalId: input.terminalId ?? "sign-in",
    exitCode: 0,
    exitSignal: null,
    createdAt: "2026-10-02T12:00:00Z",
  });
  await expect.element(dialog.getByText(/This account is not authenticated yet/u)).toBeVisible();
  harness.refresh.mockResolvedValue([{ ...WORK_STATUS, authStatus: "authenticated" }]);
  await dialog.getByRole("button", { name: "Check authentication" }).click();
  await expect.element(dialog.getByText("Authenticated. You can close this window.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => harness.api.terminal.close.mock.calls.length).toBeGreaterThan(0);
  expect(harness.api.terminal.close).toHaveBeenCalledWith({
    threadId: input.threadId,
    terminalId: input.terminalId,
    deleteHistory: true,
  });
});

it("sends Pi's login selector only after startup and keeps cancellation failures visible", async () => {
  const instanceId = "pi_work";
  const panelProps = {
    ...props,
    providerTarget: "pi" as const,
    settings: {
      ...defaults,
      // Moss disables optional CLIs by default; this account exists and is in use.
      disabledProviders: [],
      providerInstances: { [instanceId]: { driver: "pi", displayName: "Pi work", config: {} } },
    },
  };
  await render(<ProvidersSettingsPanel {...panelProps} />);
  await page.getByRole("button", { name: "Select Pi work", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to Pi work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to Pi work" });
  const options = dialog.getByRole("button", { name: "Sign-in options" });
  await expect.element(options).toBeEnabled();
  expect(harness.api.terminal.write).not.toHaveBeenCalled();
  await options.click();
  expect(harness.api.terminal.write).toHaveBeenCalledWith(
    expect.objectContaining({ data: "/login\r" }),
  );
  await expect.element(options).toBeDisabled();
  harness.api.terminal.close.mockRejectedValueOnce(new Error("Server disconnected; retry closing"));
  await dialog.getByRole("button", { name: "Cancel / close" }).click();
  await expect.element(dialog.getByText("Server disconnected; retry closing")).toBeVisible();
  expect(harness.api.terminal.write).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: "exit\n" }),
  );
  await dialog.getByRole("button", { name: "Cancel / close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
});

it("closes a late authentication open after the settings dialog is cancelled", async () => {
  harness.statuses = [...harness.statuses, WORK_STATUS];
  let finishOpen!: (snapshot: unknown) => void;
  harness.api.terminal.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
  );
  await render(<ProvidersSettingsPanel {...accountProps().props} />);
  await page.getByRole("button", { name: "Select Work", exact: true }).click();
  await page.getByRole("button", { name: "Sign in to Work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to Work" });
  await expect.poll(() => harness.api.terminal.open.mock.calls.length).toBeGreaterThan(0);
  const input = harness.api.terminal.open.mock.calls[0]![0] as TerminalOpenInput;
  await dialog.getByRole("button", { name: "Cancel / close" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  const beforeLate = harness.api.terminal.close.mock.calls.length;
  finishOpen({
    ...input,
    status: "running",
    history: "",
    pid: 1234,
    exitCode: null,
    exitSignal: null,
  });
  await expect.poll(() => harness.api.terminal.close.mock.calls.length).toBeGreaterThan(beforeLate);
});

it.each(["ready", "error", "exited"] as const)(
  "reports a retained %s authentication terminal when its viewport remounts",
  async (status) => {
    const threadId = ThreadId.makeUnsafe(`provider-auth-remount-${status}`);
    const terminalId = "sign-in";
    const onRuntimeStatusChange = vi.fn();
    const viewport = (
      <TerminalViewport
        threadId={threadId}
        terminalId={terminalId}
        terminalLabel="Sign in"
        cwd="/tmp"
        providerAuthInstanceId="pi_work"
        onRuntimeStatusChange={onRuntimeStatusChange}
        onSessionExited={() => {}}
        onTerminalMetadataChange={() => {}}
        onTerminalActivityChange={() => {}}
        focusRequestId={0}
        autoFocus={false}
        isVisible
      />
    );
    try {
      const mounted = await render(viewport);
      await expect.poll(() => onRuntimeStatusChange.mock.calls.at(-1)?.[0]).toBe("ready");
      await mounted.unmount();
      if (status === "error") {
        harness.terminalListener?.({
          type: "error",
          threadId,
          terminalId,
          message: "Authentication failed",
          createdAt: "2026-10-02T12:00:00Z",
        });
      } else if (status === "exited") {
        harness.terminalListener?.({
          type: "exited",
          threadId,
          terminalId,
          exitCode: 0,
          exitSignal: null,
          createdAt: "2026-10-02T12:00:00Z",
        });
      }
      onRuntimeStatusChange.mockClear();
      const reopened = await render(viewport);
      await expect.poll(() => onRuntimeStatusChange.mock.calls.at(-1)?.[0]).toBe(status);
      await reopened.unmount();
    } finally {
      terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
    }
  },
);
