// FILE: MossBuiltInApps.browser.tsx
// Purpose: Settings › 插件 › 应用 lists Moss's own apps first (icon, name,
//          one Chinese line, switch), opens a working detail page, and starts
//          a chat for 创建应用 and for each "try asking" prompt.

import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MOSS_BUILT_IN_APPS } from "@moss/shared/mossBuiltInApps";

import { PluginManagementPanel } from "../PluginManagementPanel";
import { MossLocalizationProvider } from "~/localization";
import { mossBuiltInAppViews } from "./mossBuiltInAppsPresentation";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: "zh-CN",
        selectedCodexAccountId: "default",
      },
    }),
  };
});

function renderZh(ui: Parameters<typeof render>[0]) {
  return render(<MossLocalizationProvider>{ui}</MossLocalizationProvider>);
}

function panelProps(disabled: ReadonlyArray<string> = []) {
  return {
    settingsPage: true,
    plugins: [],
    apps: [],
    appsLoading: false,
    appsError: null,
    mcpServers: [],
    marketplaces: [],
    onTogglePlugin: vi.fn(),
    onToggleMcp: vi.fn(),
    viewState: { initialTab: "apps", search: "", scrollTop: 0, focusAnchor: null },
    builtInApps: mossBuiltInAppViews(disabled),
    onSetBuiltInAppEnabled: vi.fn(),
    onOpenBuiltInAppPanel: vi.fn(),
    onStartAppPrompt: vi.fn(),
    onCreateApp: vi.fn(),
  } as const;
}

const shotDir = import.meta.env.VITE_MOSS_APPS_SHOT_DIR as string | undefined;
async function shot(name: string) {
  if (!shotDir) return;
  await page.screenshot({ path: `${shotDir}/${name}.png`, element: document.body });
}

describe("Moss built-in apps on the Apps tab", () => {
  it("other apps that fail to load take one quiet line under Moss's own apps", async () => {
    const onRetryApps = vi.fn();
    const screen = await renderZh(
      <PluginManagementPanel
        {...panelProps()}
        appsError={new Error("app/list timed out")}
        onRetryApps={onRetryApps}
      />,
    );
    try {
      await expect.element(page.getByTestId("plugin-manage-moss-app-row").first()).toBeVisible();
      await expect
        .element(page.getByTestId("plugin-manage-other-apps-unavailable"))
        .toHaveTextContent("其他应用暂时没加载出来。");
      expect(document.body.textContent).not.toContain("无法加载应用");
      expect(document.body.textContent).not.toContain("app/list");
      await page
        .getByTestId("plugin-manage-other-apps-unavailable")
        .getByRole("button", { name: "重试" })
        .click();
      expect(onRetryApps).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("lists every built-in app with its one line, a switch and 创建应用", async () => {
    await page.viewport(1000, 860);
    const props = panelProps(["moss.todos"]);
    const screen = await renderZh(<PluginManagementPanel {...props} />);
    try {
      const tab = page.getByTestId("plugin-manage-tab-apps");
      await expect.element(tab).toHaveAttribute("aria-selected", "true");
      await expect.element(tab).toHaveTextContent(String(MOSS_BUILT_IN_APPS.length));

      const rows = page.getByTestId("plugin-manage-moss-app-row");
      await expect.element(rows.first()).toHaveTextContent("资料空间");
      await expect.element(rows.first()).toHaveTextContent("让智能体读写你的页面、表格和资料");
      expect(rows.all()).toHaveLength(MOSS_BUILT_IN_APPS.length);

      const switches = document.querySelectorAll<HTMLElement>(
        '[data-testid="plugin-manage-moss-app-row"] [role="switch"]',
      );
      expect(switches).toHaveLength(MOSS_BUILT_IN_APPS.length);
      // 待办 was saved off; the rest are on.
      const states = [...switches].map((element) => element.getAttribute("aria-checked"));
      expect(states.at(-1)).toBe("false");
      expect(states.slice(0, -1).every((state) => state === "true")).toBe(true);

      await page.getByRole("switch", { name: /图像与视频/u }).click();
      expect(props.onSetBuiltInAppEnabled).toHaveBeenCalledWith("moss.media", false);

      // No CLI apps here, so no 其他应用 section and no "no apps" state.
      expect(document.querySelector('[data-testid="plugin-manage-other-apps"]')).toBeNull();
      await shot("01-apps-tab");

      await page.getByTestId("plugin-manage-create-app").getByRole("button").first().click();
      expect(props.onCreateApp).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("opens a working detail page: switch, 打开, try-asking prompts, back", async () => {
    await page.viewport(1000, 860);
    const props = panelProps();
    const screen = await renderZh(<PluginManagementPanel {...props} />);
    try {
      await page.getByRole("button", { name: "资料空间", exact: true }).click();
      const detail = page.getByTestId("moss-app-detail");
      await expect.element(detail).toHaveAttribute("data-app-id", "moss.space");
      await expect.element(detail).toHaveTextContent("它能做什么");
      await expect
        .element(page.getByTestId("moss-app-detail-status"))
        .toHaveTextContent("已开启：所有智能体都能用");
      await shot("02-space-detail");

      await page.getByTestId("moss-app-detail-open").click();
      expect(props.onOpenBuiltInAppPanel).toHaveBeenCalledWith("library");

      await page.getByTestId("moss-app-detail-prompt").first().click();
      expect(props.onStartAppPrompt).toHaveBeenCalledWith("把这次对话整理成一页笔记，放进资料空间");

      await page.getByRole("switch", { name: /资料空间/u }).click();
      expect(props.onSetBuiltInAppEnabled).toHaveBeenCalledWith("moss.space", false);

      await page.getByRole("button", { name: "返回应用" }).click();
      await expect.element(page.getByTestId("plugin-manage-tab-apps")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a turned-off app as off, with its prompts disabled and no 打开 for 待办", async () => {
    await page.viewport(1000, 860);
    const screen = await renderZh(<PluginManagementPanel {...panelProps(["moss.todos"])} />);
    try {
      await page.getByRole("button", { name: "待办", exact: true }).click();
      await expect
        .element(page.getByTestId("moss-app-detail-status"))
        .toHaveTextContent("已关闭：智能体看不到这个应用");
      expect(document.querySelector('[data-testid="moss-app-detail-open"]')).toBeNull();
      const prompts = document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="moss-app-detail-prompt"]',
      );
      expect(prompts).toHaveLength(3);
      expect([...prompts].every((prompt) => prompt.disabled)).toBe(true);
      await shot("03-todos-detail-off");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the agent's own apps below under 其他应用, and search covers both", async () => {
    await page.viewport(1000, 860);
    const screen = await renderZh(
      <PluginManagementPanel
        {...panelProps()}
        mossApps={[{ slug: "notion", name: "Notion", description: "笔记与文档", logoUrl: null }]}
      />,
    );
    try {
      await expect
        .element(page.getByTestId("plugin-manage-other-apps"))
        .toHaveTextContent("其他应用");
      await expect
        .element(page.getByTestId("plugin-manage-other-apps"))
        .toHaveTextContent("Notion");
      await shot("04-with-other-apps");
    } finally {
      await screen.unmount();
    }

    const searched = await renderZh(
      <PluginManagementPanel
        {...panelProps()}
        viewState={{ initialTab: "apps", search: "幻灯片", scrollTop: 0, focusAnchor: null }}
      />,
    );
    try {
      const rows = page.getByTestId("plugin-manage-moss-app-row");
      await expect.element(rows.first()).toHaveTextContent("幻灯片");
      expect(rows.all()).toHaveLength(1);
      // 创建应用 is not a search result.
      expect(document.querySelector('[data-testid="plugin-manage-create-app"]')).toBeNull();
    } finally {
      await searched.unmount();
    }
  });
});
