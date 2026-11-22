import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type MossPayCatalog,
  type MossPayQuota,
  type ServerProviderUsageSnapshot,
  type ServerSettingsView,
} from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const settings = vi.hoisted(() => ({
  codexHomePath: "",
  disabledProviders: [] as string[],
  railUsageProviders: ["codex"],
  railUsageInstanceIds: null as string[] | null,
  railUsageWindow: "both",
}));
const updateSettings = vi.hoisted(() => vi.fn());
const refreshProviderUsage = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("~/appSettings", () => ({ useAppSettings: () => ({ settings, updateSettings }) }));
vi.mock("~/lib/serverReactQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/serverReactQuery")>()),
  fetchAllProviderUsage: refreshProviderUsage,
}));

import {
  serverMossAccountSessionQueryOptions,
  serverMossCloudAccountStateQueryOptions,
  serverMossPayCatalogQueryOptions,
  serverMossPayQuotaQueryOptions,
} from "~/components/auth/mossServerReactQuery";
import { MossLocaleScope } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";

import { AppRailUsage } from "./AppRailUsage";
import { MOSS_RAIL_USAGE_ID } from "./AppRailUsage.logic";
import { ProviderUsageSettingsPanel } from "./settings/ProviderUsageSettingsPanel";

async function renderAccounts(
  snapshots: readonly ServerProviderUsageSnapshot[],
  serverSettings: ServerSettingsView = DEFAULT_SERVER_SETTINGS_VIEW,
  showSettings = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  client.setQueryData(serverQueryKeys.allProviderUsage(), snapshots);
  client.setQueryData(serverQueryKeys.settings(), serverSettings);
  const onOpenUsageSettings = vi.fn();
  const content = () => (
    <QueryClientProvider client={client}>
      {showSettings ? (
        <div className="flex items-start gap-6 p-6">
          <div
            data-testid="usage-rail"
            className="flex w-12 shrink-0 flex-col items-center gap-1 rounded-lg bg-sidebar py-2"
          >
            <AppRailUsage onOpenUsageSettings={onOpenUsageSettings} />
          </div>
          <div className="w-[520px] space-y-6">
            <ProviderUsageSettingsPanel />
          </div>
        </div>
      ) : (
        <AppRailUsage onOpenUsageSettings={onOpenUsageSettings} />
      )}
    </QueryClientProvider>
  );
  const view = await render(content());
  return { client, onOpenUsageSettings, rerender: () => view.rerender(content()) };
}

async function renderUsage(
  limits: ServerProviderUsageSnapshot["limits"],
  status: ServerProviderUsageSnapshot["status"] = "ok",
) {
  const { onOpenUsageSettings } = await renderAccounts([
    {
      provider: "codex",
      updatedAt: "2026-10-02T12:00:00.000Z",
      status,
      source: "test",
      limits,
      usageLines: [],
    } satisfies ServerProviderUsageSnapshot,
  ]);
  return onOpenUsageSettings;
}

const claudeSettings: ServerSettingsView = {
  ...DEFAULT_SERVER_SETTINGS_VIEW,
  providerInstances: {
    claude_work: { driver: "claudeAgent", displayName: "Work", accentColor: "#2563eb" },
  },
};
const claudeSnapshots: readonly ServerProviderUsageSnapshot[] = [
  {
    provider: "claudeAgent",
    instanceId: "claude_work",
    updatedAt: "2026-10-02T12:00:00.000Z",
    status: "ok",
    source: "test",
    limits: [{ window: "Weekly", usedPercent: 80 }],
    usageLines: [],
  },
  {
    provider: "claudeAgent",
    instanceId: "claudeAgent",
    updatedAt: "2026-10-02T12:00:00.000Z",
    status: "ok",
    source: "test",
    limits: [{ window: "Weekly", usedPercent: 25 }],
    usageLines: [],
  },
];

describe("AppRailUsage", () => {
  beforeEach(() => {
    settings.railUsageWindow = "both";
    settings.disabledProviders = [];
    settings.railUsageProviders = ["codex"];
    settings.railUsageInstanceIds = null;
    updateSettings.mockReset().mockImplementation((patch) => Object.assign(settings, patch));
    refreshProviderUsage.mockReset();
  });

  it.each(["providerInstanceId", "instanceId"] as const)(
    "keeps %s account labels, rings and refreshed cards independent",
    async (identityField) => {
      settings.railUsageInstanceIds = ["claudeAgent", "claude_work"];
      const snapshots: ServerProviderUsageSnapshot[] = claudeSnapshots.map(
        ({ instanceId, ...snapshot }) => ({
          ...snapshot,
          [identityField]: instanceId,
        }),
      );
      const refreshed = snapshots.map((snapshot) => ({
        ...snapshot,
        limits: [
          { window: "Weekly", usedPercent: snapshot[identityField] === "claude_work" ? 90 : 40 },
        ],
      }));
      refreshProviderUsage.mockResolvedValue(refreshed);
      const consoleError = vi.spyOn(console, "error");
      try {
        const { client } = await renderAccounts(snapshots, claudeSettings, true);
        const personal = page.getByRole("button", { name: /^Claude · Local account usage:/ });
        const work = page.getByRole("button", { name: /^Claude · Work usage:/ });
        await expect.element(personal).toBeVisible();
        await expect.element(work).toBeVisible();
        await expect.element(page.getByTitle("Work", { exact: true })).toBeVisible();
        await expect.element(page.getByTitle("Default account", { exact: true })).toBeVisible();
        expect(
          personal
            .element()
            .querySelector("circle[stroke-dasharray]")
            ?.getAttribute("stroke-dasharray"),
        ).toBe("75 100");
        expect(
          work
            .element()
            .querySelector("circle[stroke-dasharray]")
            ?.getAttribute("stroke-dasharray"),
        ).toBe("20 100");

        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect
          .poll(() =>
            personal
              .element()
              .querySelector("circle[stroke-dasharray]")
              ?.getAttribute("stroke-dasharray"),
          )
          .toBe("60 100");
        await expect
          .poll(() =>
            work
              .element()
              .querySelector("circle[stroke-dasharray]")
              ?.getAttribute("stroke-dasharray"),
          )
          .toBe("10 100");
        expect(refreshProviderUsage).toHaveBeenCalledOnce();
        expect(client.getQueryData(serverQueryKeys.allProviderUsage())).toEqual(refreshed);
        expect(
          consoleError.mock.calls.filter((args) =>
            args.some((arg) => String(arg).includes("same key")),
          ),
        ).toEqual([]);
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it("hides globally disabled selected accounts without erasing their saved selection", async () => {
    settings.disabledProviders = ["codex"];
    await renderUsage([{ window: "Weekly", usedPercent: 35 }]);
    expect(page.getByRole("button", { name: /^Codex usage:/ }).elements()).toHaveLength(0);
    expect(settings.railUsageProviders).toEqual(["codex"]);
  });

  it("selects two Claude accounts in Settings and shows each account's ring and hover card", async () => {
    settings.railUsageInstanceIds = [];
    const { rerender } = await renderAccounts(claudeSnapshots, claudeSettings, true);
    const personalSwitch = page.getByRole("switch", {
      name: "Show Claude · Local account usage at the bottom of the sidebar",
    });
    const workSwitch = page.getByRole("switch", {
      name: "Show Claude · Work usage at the bottom of the sidebar",
    });
    await personalSwitch.click();
    await rerender();
    await workSwitch.click();
    await rerender();
    expect(updateSettings).toHaveBeenLastCalledWith({
      railUsageInstanceIds: ["claudeAgent", "claude_work"],
    });
    await expect.element(personalSwitch).toBeChecked();
    await expect.element(workSwitch).toBeChecked();
    // No account limit: a third account stays clickable with two rings already on.
    await expect
      .element(
        page.getByRole("switch", {
          name: "Show Codex usage at the bottom of the sidebar",
        }),
      )
      .toBeEnabled();

    const personal = page.getByRole("button", { name: /^Claude · Local account usage:/ });
    const work = page.getByRole("button", { name: /^Claude · Work usage:/ });
    await expect.element(personal).toBeVisible();
    await expect.element(work).toBeVisible();
    expect(
      personal
        .element()
        .querySelector("circle[stroke-dasharray]")
        ?.getAttribute("stroke-dasharray"),
    ).toBe("75 100");
    expect(
      work.element().querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray"),
    ).toBe("20 100");
    const accountDot = work.element().querySelector('[data-accent="#2563eb"]');
    expect(accountDot).not.toBeNull();
    const dotBounds = accountDot!.getBoundingClientRect();
    const glyphBounds = Array.from(work.element().querySelectorAll("svg"))
      .at(-1)!
      .getBoundingClientRect();
    // The account mark belongs beside the glyph, as in the model picker.
    expect(dotBounds.x + dotBounds.width / 2).toBeGreaterThan(
      glyphBounds.x + glyphBounds.width / 2,
    );
    expect(dotBounds.y + dotBounds.height / 2).toBeLessThan(glyphBounds.y + glyphBounds.height / 2);
    expect(dotBounds.right).toBeLessThanOrEqual(glyphBounds.right + 5);
    await work.click();
    await expect.element(page.getByText("Usage source: Claude · Work")).toBeVisible();
    await expect.element(page.getByText("Claude · Work", { exact: true }).last()).toBeVisible();
    await expect.element(page.getByText("20% left", { exact: true }).last()).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Manage usage", exact: true }))
      .toBeVisible();
    await page
      .getByTestId("usage-rail")
      .screenshot({ path: "node_modules/.cache/multiple-claude-accounts.png" });
    await page.getByRole("button", { name: "Manage usage", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Manage usage", exact: true }))
      .not.toBeInTheDocument();

    await workSwitch.click();
    await rerender();
    await expect.element(work).not.toBeInTheDocument();
    await expect
      .element(
        page.getByRole("switch", {
          name: "Show Codex usage at the bottom of the sidebar",
        }),
      )
      .toBeEnabled();
  });

  it("stacks more than two rings compactly and scrolls them inside a short rail", async () => {
    const manySettings: ServerSettingsView = {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: {
        claude_work: { driver: "claudeAgent", displayName: "Work" },
        claude_lab: { driver: "claudeAgent", displayName: "Lab" },
        claude_team: { driver: "claudeAgent", displayName: "Team" },
        claude_ops: { driver: "claudeAgent", displayName: "Ops" },
      },
    };
    const ids = ["codex", "claudeAgent", "claude_work", "claude_lab", "claude_team", "claude_ops"];
    settings.railUsageInstanceIds = ids;
    const snapshots: ServerProviderUsageSnapshot[] = ids.map((instanceId, index) => ({
      provider: instanceId === "codex" ? "codex" : "claudeAgent",
      instanceId,
      updatedAt: "2026-10-02T12:00:00.000Z",
      status: "ok",
      source: "test",
      limits: [
        { window: "Weekly", usedPercent: 10 + index * 10 },
        { window: "5h", usedPercent: 5 + index * 5 },
      ],
      usageLines: [],
    }));
    await renderAccounts(snapshots, manySettings);
    const list = page.getByRole("button", { name: /usage:/ });
    await expect.poll(() => list.elements().length).toBe(ids.length);
    const container = document.querySelector<HTMLElement>("[data-rail-usage-list]");
    expect(container).not.toBeNull();
    for (const button of list.elements()) {
      const bounds = button.getBoundingClientRect();
      expect(bounds.height).toBeLessThanOrEqual(28);
      expect(bounds.width).toBeLessThanOrEqual(28);
    }
    // Six compact rings are taller than the stack, so it scrolls instead of growing.
    expect(container!.getBoundingClientRect().height).toBeLessThanOrEqual(128);
    expect(container!.scrollHeight).toBeGreaterThan(container!.clientHeight);
    const last = list.elements().at(-1)!;
    last.scrollIntoView();
    await expect.element(page.getByRole("button", { name: /^Claude · Ops usage:/ })).toBeVisible();
  });

  it("keeps full-size rings without a scroll stack for one or two accounts", async () => {
    settings.railUsageInstanceIds = ["claudeAgent", "claude_work"];
    await renderAccounts(claudeSnapshots, claudeSettings);
    await expect.element(page.getByRole("button", { name: /^Claude · Work usage:/ })).toBeVisible();
    expect(document.querySelector("[data-rail-usage-list]")).toBeNull();
    expect(
      page
        .getByRole("button", { name: /^Claude · Work usage:/ })
        .element()
        .getBoundingClientRect().height,
    ).toBe(32);
  });

  it("never borrows a sibling's usage when the selected account has no matching snapshot", async () => {
    settings.railUsageInstanceIds = ["claudeAgent"];
    await renderAccounts(
      claudeSnapshots.filter((snapshot) => snapshot.instanceId === "claude_work"),
      claudeSettings,
    );
    await expect
      .element(page.getByRole("button", { name: /Claude.*usage:/ }))
      .not.toBeInTheDocument();
  });

  it("keeps the model picker's neutral marker for an additional account without an accent", async () => {
    settings.railUsageInstanceIds = ["claudeAgent", "claude_work"];
    await renderAccounts(claudeSnapshots, {
      ...claudeSettings,
      providerInstances: { claude_work: { driver: "claudeAgent", displayName: "Work" } },
    });
    const personal = page.getByRole("button", { name: /^Claude · Local account usage:/ });
    const work = page.getByRole("button", { name: /^Claude · Work usage:/ });
    expect(personal.element().querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(work.element().querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it("preserves a disabled account selection when another ring is changed", async () => {
    settings.railUsageInstanceIds = ["claude_work", "codex"];
    const { client, rerender } = await renderAccounts(
      claudeSnapshots,
      {
        ...claudeSettings,
        providerInstances: {
          claude_work: { driver: "claudeAgent", displayName: "Work", enabled: false },
        },
      },
      true,
    );
    await page
      .getByRole("switch", { name: "Show Codex usage at the bottom of the sidebar" })
      .click();
    await rerender();
    expect(settings.railUsageInstanceIds).toEqual(["claude_work"]);
    await page
      .getByRole("switch", { name: "Show Claude usage at the bottom of the sidebar" })
      .click();
    await rerender();
    await page
      .getByRole("switch", { name: "Show Codex usage at the bottom of the sidebar" })
      .click();
    await rerender();
    expect(settings.railUsageInstanceIds).toEqual(["claude_work", "claudeAgent", "codex"]);
    client.setQueryData(serverQueryKeys.settings(), claudeSettings);
    await rerender();
    await expect
      .element(
        page.getByRole("switch", { name: "Show Claude · Work usage at the bottom of the sidebar" }),
      )
      .toBeChecked();
    await expect.element(page.getByRole("button", { name: /^Claude · Work usage:/ })).toBeVisible();
    // Every saved choice shows again once its account is back: there is no two-account cap.
    await expect
      .element(page.getByRole("switch", { name: "Show Codex usage at the bottom of the sidebar" }))
      .toBeChecked();
    expect(settings.railUsageInstanceIds).toEqual(["claude_work", "claudeAgent", "codex"]);
  });

  it("hides disabled and removed accounts even when their usage remains cached", async () => {
    settings.railUsageInstanceIds = ["claude_work", "claude_removed"];
    await renderAccounts(
      [...claudeSnapshots, { ...claudeSnapshots[0]!, instanceId: "claude_removed" }],
      {
        ...claudeSettings,
        providerInstances: { claude_work: { driver: "claudeAgent", enabled: false } },
      },
    );
    await expect
      .element(page.getByRole("button", { name: /Claude.*usage:/ }))
      .not.toBeInTheDocument();
  });

  it("shows independent weekly and five-hour rings even when a model sublimit is tighter", async () => {
    const onOpenUsageSettings = await renderUsage([
      { window: "seven_day", usedPercent: 57, windowDurationMins: 10_080 },
      { window: "five_hour", usedPercent: 22, windowDurationMins: 300 },
      { window: "seven_day_sonnet", usedPercent: 96, windowDurationMins: 10_080 },
    ]);

    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(Array.from(fills, (circle) => circle.getAttribute("stroke-dasharray"))).toEqual([
      "43 100",
      "78 100",
    ]);
    expect(Number(fills[0]?.getAttribute("r"))).toBeGreaterThan(
      Number(fills[1]?.getAttribute("r")),
    );
    // Both rings colour by the same remaining-quota scale: 43% is fair, 78% is healthy.
    expect(fills[0]?.getAttribute("class")).toContain("stroke-yellow-500");
    expect(fills[1]?.getAttribute("class")).toContain("stroke-emerald-500");

    await button.click();
    expect(onOpenUsageSettings).not.toHaveBeenCalled();
    await expect.element(page.getByText("Usage source: Codex")).toBeVisible();
    await expect.element(page.getByText("Weekly · outer")).toBeVisible();
    await expect.element(page.getByText("5h · inner")).toBeVisible();
    await expect.element(page.getByText("43% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("78% left", { exact: true })).toBeVisible();
    const manageButton = page.getByRole("button", { name: "Manage usage", exact: true });
    await expect.element(manageButton).toBeVisible();
    await manageButton.click();
    expect(onOpenUsageSettings).toHaveBeenCalledOnce();
    await expect.element(manageButton).not.toBeInTheDocument();
  });

  it.each([
    ["fiveHour", "85 100", "stroke-emerald-500"],
    ["weekly", "8 100", "stroke-red-500"],
  ])("draws a single ring for the %s setting", async (window, dasharray, strokeClassName) => {
    settings.railUsageWindow = window;
    await renderUsage([
      { window: "Weekly", usedPercent: 92 },
      { window: "5h", usedPercent: 15 },
    ]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe(dasharray);
    expect(fills[0]?.getAttribute("class")).toContain(strokeClassName);
  });

  it.each(["Weekly", "5h"])("shows only the reported %s ring", async (window) => {
    await renderUsage([{ window, usedPercent: 35 }]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("65 100");
  });

  it("keeps an empty track for an exhausted window without drawing a remaining arc", async () => {
    await renderUsage([
      { window: "Weekly", usedPercent: 0 },
      { window: "5h", usedPercent: 100 },
    ]);
    const button = page.getByRole("button", {
      name: "Codex usage: 5h 0% remaining, Weekly 100% remaining. Show usage",
    });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelectorAll("circle")).toHaveLength(3);
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("100 100");
  });

  it("preserves the single-ring fallback for providers with other limit windows", async () => {
    await renderUsage([{ window: "Monthly", usedPercent: 60 }]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("40 100");
  });

  it("keeps the unavailable provider visible without a quota arc", async () => {
    await renderUsage([], "error");
    const button = page.getByRole("button", {
      name: "Codex usage: Unavailable. Show usage",
    });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelectorAll("circle")).toHaveLength(1);
    expect(button.element().querySelectorAll("circle[stroke-dasharray]")).toHaveLength(0);
  });

  it("shows a free Moss account's sidebar ring and Settings quota bar without any yuan amount", async () => {
    settings.railUsageInstanceIds = [MOSS_RAIL_USAGE_ID];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const freeQuota: MossPayQuota = {
      planCode: "starter-trial",
      billingModel: "wallet_credits_v1",
      usageLimits: [{ key: "lifetime", durationSeconds: null, limit: 5, used: 1, resetsAt: null }],
      quotaPolicyMode: "metered",
      periodStart: "2026-11-19T00:00:00.000Z",
      periodEnd: null,
      windowId: "quota-free",
      windowSource: null,
      windowDurationSeconds: null,
      tokenLimit: null,
      tokensUsed: 1_600,
      requestLimit: null,
      requestsUsed: 3,
      creditBalance: 5,
      realtimeConfigured: true,
      realtimeModelAllowlist: ["gpt-realtime-2.1"],
      realtimeCostLimitNanoUsd: 0,
      realtimeCostUsedNanoUsd: 0,
      realtimeCostReservedNanoUsd: 0,
      realtimeSessionLimit: null,
      realtimeSessionsUsed: 0,
      realtimeEstimatedMinutesRemaining: null,
    };
    const freeCatalog: MossPayCatalog = {
      plans: [],
      pointPackages: [],
      paymentMethods: [],
    };
    client.setQueryData(serverQueryKeys.allProviderUsage(), []);
    client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
    client.setQueryData(serverMossAccountSessionQueryOptions().queryKey, {
      configured: true,
      authenticated: true,
      session: {
        id: "phone-session-1",
        user: { id: "free-user-1", phoneNumber: "+8613800138000", displayName: null },
      },
    } as never);
    client.setQueryData(serverMossCloudAccountStateQueryOptions().queryKey, {
      configured: false,
      authenticated: false,
      account: null,
      session: null,
      modelGatewayConfigured: false,
    } as never);
    client.setQueryData(serverMossPayCatalogQueryOptions().queryKey, freeCatalog);
    client.setQueryData(
      serverMossPayQuotaQueryOptions({ accountIdentity: "phone:free-user-1:phone-session-1" })
        .queryKey,
      freeQuota,
    );

    const onOpenUsageSettings = vi.fn();
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <QueryClientProvider client={client}>
          <div className="flex items-start gap-6 p-6">
            <div
              data-testid="usage-rail"
              className="flex w-12 shrink-0 flex-col items-center gap-1 rounded-lg bg-sidebar py-2"
            >
              <AppRailUsage onOpenUsageSettings={onOpenUsageSettings} />
            </div>
            <div className="w-[520px] space-y-6">
              <ProviderUsageSettingsPanel />
            </div>
          </div>
        </QueryClientProvider>
      </MossLocaleScope>,
    );

    try {
      const mossRing = page.getByRole("button", { name: /Moss, 剩余 80%/ });
      await expect.element(mossRing).toBeVisible();
      const fill = mossRing.element().querySelector("circle[stroke-dasharray]");
      expect(fill?.getAttribute("stroke-dasharray")).toBe("80 100");
      expect(fill?.getAttribute("class")).toContain("stroke-emerald-500");

      await mossRing.click();
      expect(onOpenUsageSettings).not.toHaveBeenCalled();
      await expect.element(page.getByText("额度来源：Moss · 免费版")).toBeVisible();
      const manageUsage = page.getByRole("button", { name: "管理用量", exact: true });
      await expect.element(manageUsage).toBeVisible();
      await expect.element(page.getByText("免费额度", { exact: true }).first()).toBeVisible();
      await expect.element(page.getByText("剩余 80%", { exact: true }).first()).toBeVisible();

      const settingsPanel = page.getByTestId("moss-billing-settings-panel");
      await expect.element(settingsPanel).toBeVisible();
      await expect.element(settingsPanel.getByText("免费版", { exact: true })).toBeVisible();
      await expect.element(settingsPanel.getByText("免费额度", { exact: true })).toBeVisible();
      const progressBar = settingsPanel.getByRole("progressbar");
      await expect.element(progressBar).toBeVisible();
      await expect.element(progressBar).toHaveAttribute("aria-valuenow", "80");
      expect(progressBar.element().getBoundingClientRect().width).toBeGreaterThan(20);
      await expect.element(settingsPanel.getByText("剩余 80%", { exact: true })).toBeVisible();

      // Critical constraint: never display 5元 / ¥5 / 5 RMB / internal plan slug / credit balance card.
      const text = document.body.textContent ?? "";
      expect(text).not.toMatch(/5\s*元|[¥￥]\s*5|5\s*RMB|CNY\s*5/i);
      expect(text).not.toContain("starter-trial");
      expect(text).not.toContain("积分余额");

      await manageUsage.click();
      expect(onOpenUsageSettings).toHaveBeenCalledOnce();
      await expect.element(manageUsage).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
