import "../../index.css";

import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useTheme } from "~/hooks/useTheme";
import type { McpAppHostDialog, McpAppHostPrompt } from "~/lib/mcpAppHost";
import type { McpAppBinding } from "~/lib/mcpApps/contracts";
import { mcpAppStylesForThemePacks } from "~/lib/mcpApps/hostStyles";
import { classifyMcpAppLink } from "~/lib/mcpApps/openLink";
import { chainMcpAppWheel } from "~/lib/mcpApps/wheelChain";
import { CHAT_CONTENT_CARD_CLASS_NAME } from "./composerPickerStyles";
import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { MossLocaleScope } from "~/localization";
import { DEFAULT_THEME_STATE, resolveThemePack } from "~/theme/theme.logic";
import { McpAppBlockView, type McpAppBlockViewProps } from "./McpAppBlockView";

const WIDTH = 720;

const binding: McpAppBinding = {
  server: "moss-probe",
  serverKey: "moss-probe",
  serverLabel: "moss-probe",
  toolName: "probe_widget",
  toolTitle: "天气小组件",
  resourceUri: "ui://probe/widget",
  source: "toolDefinition",
  isFirstParty: false,
  visibility: [],
};

const projection = {
  kind: "codex.mcp_tool_call",
  version: 1,
  callId: "call-1",
  server: "moss-probe",
  tool: "probe_widget",
  status: "completed",
  arguments: { city: "上海" },
  result: {
    content: [{ type: "text", text: "上海：晴，22°C。明天多云，后天小雨。" }],
  },
  truncation: { truncated: false, deferredBinary: false },
} as WorkLogMcpToolResult;

const styles = mcpAppStylesForThemePacks(
  resolveThemePack(DEFAULT_THEME_STATE, "light"),
  resolveThemePack(DEFAULT_THEME_STATE, "dark"),
);

/** A stand-in widget document styled only by the host-context variables Moss sends. */
function widgetDocument(theme: "light" | "dark"): string {
  const vars = Object.entries(styles.variables ?? {})
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `<!doctype html><html><head><style>
:root{color-scheme:${theme};${vars}}
body{margin:0;padding:16px;font-family:var(--font-sans);background:var(--color-background-primary);color:var(--color-text-primary);font-size:var(--font-text-sm-size);line-height:var(--font-text-sm-line-height)}
h1{margin:0 0 4px;font-size:var(--font-heading-md-size);font-weight:var(--font-weight-medium)}
p{margin:0 0 12px;color:var(--color-text-secondary)}
.row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--color-border-tertiary)}
.row span:last-child{color:var(--color-text-secondary)}
button{margin-top:12px;font:inherit;padding:4px 12px;border-radius:var(--border-radius-md);border:1px solid var(--color-border-secondary);background:var(--color-background-secondary);color:var(--color-text-primary)}
</style></head><body><h1>上海 · 未来三天</h1><p>数据来自 moss-probe</p>
<div class="row"><span>今天</span><span>晴 22°C</span></div>
<div class="row"><span>明天</span><span>多云 19°C</span></div>
<div class="row"><span>后天</span><span>小雨 17°C</span></div>
<button>刷新</button></body></html>`;
}

function Harness(props: { children: ReactNode }) {
  // Mounting the theme store keeps its storage listener alive for the dark runs.
  useTheme();
  return (
    <MossLocaleScope locale="zh-CN">
      <div
        className="bg-background p-6 text-foreground"
        style={{ width: WIDTH }}
        data-testid="mcp-app-harness"
      >
        <p className="mb-2 text-ui text-muted-foreground">调用了 moss-probe 的 probe_widget</p>
        {props.children}
        <p className="mt-3 text-ui text-foreground">上海今天天气晴朗，适合出门。</p>
      </div>
    </MossLocaleScope>
  );
}

function view(overrides: Partial<McpAppBlockViewProps> = {}): McpAppBlockViewProps {
  return {
    binding,
    projection,
    phase: "ready",
    loading: false,
    open: true,
    hidden: false,
    hideOffered: true,
    height: 218,
    prefersBorder: true,
    docked: false,
    dockShowing: false,
    canOpenPane: true,
    prompt: null,
    dialog: null,
    reducedMotion: true,
    onToggle: () => undefined,
    onToggleHidden: () => undefined,
    onOpenPane: () => undefined,
    onDockAction: () => undefined,
    onPromptAnswer: () => undefined,
    onConnect: () => undefined,
    onDialogAnswer: () => undefined,
    ...overrides,
  };
}

function ThemeKeeper() {
  useTheme();
  return null;
}

let themeKeeper: { unmount: () => unknown } | null = null;

async function switchAppTheme(mode: "light" | "dark") {
  // The theme store listens for storage events only while a consumer is mounted.
  themeKeeper ??= await render(<ThemeKeeper />);
  localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode }));
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  await vi.waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(mode === "dark"),
  );
}

async function shot(name: string, theme: "light" | "dark", full = false) {
  const harness = document.querySelector<HTMLElement>('[data-testid="mcp-app-harness"]');
  if (!harness) throw new Error("harness missing");
  await page.screenshot({
    path: `__screenshots__/mcp-app/${name}-${theme}.png`,
    ...(full ? {} : { element: harness }),
  });
}

afterEach(async () => {
  localStorage.removeItem("moss:theme");
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  await themeKeeper?.unmount();
  themeKeeper = null;
});

const linkPlan = classifyMcpAppLink("https://example.com/forecast?city=shanghai", null);
const downloadDialog: McpAppHostDialog = {
  kind: "download",
  items: [
    {
      fileName: "上海天气.csv",
      mimeType: "text/csv",
      source: { kind: "embedded", text: "day,temp" },
    },
  ],
};
const approvalPrompt: McpAppHostPrompt = {
  kind: "approval",
  toolName: "probe_refresh",
  serverLabel: "moss-probe",
};
const permissionPrompt: McpAppHostPrompt = {
  kind: "permission",
  permissions: ["camera", "microphone"],
};

for (const theme of ["light", "dark"] as const) {
  describe(`connector widget block (${theme})`, () => {
    it("draws every state with Moss copy", async () => {
      await page.viewport(WIDTH + 80, 900);
      await switchAppTheme(theme);
      const live = (
        <iframe
          title="probe"
          srcDoc={widgetDocument(theme)}
          sandbox=""
          className="block h-full w-full border-0"
        />
      );
      const states: Array<[string, McpAppBlockViewProps]> = [
        ["01-loading", view({ phase: "loading", loading: true, height: 0, canOpenPane: false })],
        ["02-live", view({ frameSlot: live })],
        ["03-collapsed", view({ open: false, canOpenPane: false })],
        ["04-hidden-connector", view({ open: false, hidden: true, canOpenPane: false })],
        ["05-docked", view({ docked: true, dockShowing: true, canOpenPane: false })],
        ["06-failure-fallback", view({ phase: "failed", canOpenPane: false })],
        ["09-approval", view({ frameSlot: live, prompt: approvalPrompt })],
        [
          "10-permission",
          view({
            phase: "loading",
            loading: true,
            height: 0,
            prompt: permissionPrompt,
            canOpenPane: false,
          }),
        ],
      ];
      for (const [name, props] of states) {
        const screen = await render(
          <Harness>
            <McpAppBlockView {...props} />
          </Harness>,
        );
        await expect
          .element(
            page.getByText(
              props.loading ? "正在加载 moss-probe 的小组件" : "来自 moss-probe 的小组件",
            ),
          )
          .toBeInTheDocument();
        if (name === "02-live") {
          const frame = document.querySelector<HTMLElement>('[data-mcp-app-frame="true"]')!;
          const style = getComputedStyle(frame);
          expect(style.borderTopLeftRadius).toBe("8px");
          expect(style.borderTopWidth).toBe("1px");
          expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
          expect(style.boxShadow).toBe("none");
          expect(frame.getBoundingClientRect().height).toBe(218);
          // Give the stand-in document a moment to paint.
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await shot(name, theme);
        await screen.unmount();
      }
    });

    it("draws the link and download dialogs", async () => {
      await page.viewport(WIDTH + 80, 640);
      await switchAppTheme(theme);
      if (linkPlan.action !== "confirm") throw new Error("expected a confirm plan");
      const link = await render(
        <Harness>
          <McpAppBlockView {...view({ dialog: { kind: "open_link", plan: linkPlan } })} />
        </Harness>,
      );
      await expect.element(page.getByText("打开外部链接")).toBeInTheDocument();
      await expect.element(page.getByText("打开 example.com 的链接时不再询问")).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 450));
      await shot("07-open-link-dialog", theme, true);
      await link.unmount();

      const download = await render(
        <Harness>
          <McpAppBlockView {...view({ dialog: downloadDialog })} />
        </Harness>,
      );
      await expect.element(page.getByText("此应用想下载一个文件到你的电脑：")).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await shot("08-download-dialog", theme, true);
      await download.unmount();
    });
  });
}

const failedProjection = {
  ...projection,
  status: "failed",
  result: undefined,
  error: { message: "fixture_bad_structured 返回的结果不符合格式要求，未能交给小组件。" },
} as WorkLogMcpToolResult;
const structuredProjection = {
  ...projection,
  result: { content: [], structuredContent: { city: "上海", days: [{ day: "今天", temp: 22 }] } },
} as WorkLogMcpToolResult;

for (const theme of ["light", "dark"] as const) {
  describe(`connector widget block, Claude parity (${theme})`, () => {
    it("shows a failed call's text above the footnote", async () => {
      await page.viewport(WIDTH + 80, 600);
      await switchAppTheme(theme);
      const screen = await render(
        <Harness>
          <McpAppBlockView {...view({ phase: "failed", projection: failedProjection })} />
        </Harness>,
      );
      const fallback = document.querySelector<HTMLElement>('[data-mcp-app-fallback="true"]')!;
      const text = fallback.querySelector<HTMLElement>('[data-mcp-app-fallback-text="true"]')!;
      const note = fallback.querySelector<HTMLElement>('[data-mcp-app-footnote="true"]')!;
      expect(text.textContent).toContain("返回的结果不符合格式要求");
      expect(note.textContent).toBe("小组件加载失败，已改为显示文字结果。");
      expect(text.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        note.getBoundingClientRect().top,
      );
      expect(fallback.textContent).not.toMatch(/json/iu);
      await shot("parity-01-failed-call-text", theme);
      await screen.unmount();

      const structured = await render(
        <Harness>
          <McpAppBlockView {...view({ phase: "failed", projection: structuredProjection })} />
        </Harness>,
      );
      const structuredText = document.querySelector('[data-mcp-app-fallback="true"]')!.textContent;
      expect(structuredText).toContain("上海");
      expect(structuredText).not.toMatch(/json/iu);
      await shot("parity-02-failed-structured", theme);
      await structured.unmount();
    });

    it("draws the header caret at 14 px", async () => {
      await page.viewport(WIDTH + 80, 400);
      await switchAppTheme(theme);
      const screen = await render(
        <Harness>
          <McpAppBlockView {...view({ open: false, canOpenPane: false })} />
        </Harness>,
      );
      const caret = document.querySelector<HTMLElement>('[data-mcp-app-chevron="true"]')!;
      const box = caret.getBoundingClientRect();
      expect(Math.abs(box.width - 14)).toBeLessThan(0.1);
      expect(Math.abs(box.height - 14)).toBeLessThan(0.1);
      expect(getComputedStyle(caret).scale).toBe("1.14");
      await shot("parity-03-caret-14px", theme);
      await screen.unmount();
    });
  });
}

describe("connector widget block behaviour", () => {
  it("keeps the chat card itself from scrolling when something inside scrolls into view", async () => {
    await page.viewport(WIDTH + 80, 400);
    const screen = await render(
      <div className={CHAT_CONTENT_CARD_CLASS_NAME} style={{ height: 300 }}>
        <div style={{ height: 1000 }} />
        <div data-testid="below">widget slot</div>
      </div>,
    );
    const card = document.querySelector<HTMLElement>(".chat-content-card")!;
    expect(getComputedStyle(card).overflowY).toBe("clip");
    document.querySelector('[data-testid="below"]')!.scrollIntoView();
    expect(card.scrollTop).toBe(0);
    await screen.unmount();
  });

  it("names a widget tool without a declared title by its name, like Claude", async () => {
    await page.viewport(WIDTH + 80, 300);
    const screen = await render(
      <Harness>
        <McpAppBlockView
          {...view({ binding: { ...binding, toolTitle: undefined, toolName: "display_pdf" } })}
        />
      </Harness>,
    );
    await expect.element(page.getByText("Display pdf")).toBeInTheDocument();
    await screen.unmount();
  });

  it("scrolls a real transcript by the wheel the widget did not use", async () => {
    await page.viewport(WIDTH + 80, 400);
    const screen = await render(
      <div data-chat-scroll-container="true" style={{ height: 300, overflowY: "auto" }}>
        <div style={{ height: 2000 }}>
          <div data-testid="widget-slot" style={{ height: 200 }} />
        </div>
      </div>,
    );
    const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]')!;
    const slot = document.querySelector('[data-testid="widget-slot"]');
    expect(chainMcpAppWheel(slot, { deltaX: 0, deltaY: 240 })).toBe(true);
    expect(scroller.scrollTop).toBe(240);
    chainMcpAppWheel(slot, { deltaX: 0, deltaY: -100 });
    expect(scroller.scrollTop).toBe(140);
    await screen.unmount();
  });

  it("keeps the link button disarmed for 400 ms with Cancel focused, then answers", async () => {
    await page.viewport(WIDTH + 80, 640);
    if (linkPlan.action !== "confirm") throw new Error("expected a confirm plan");
    const answers: unknown[] = [];
    const screen = await render(
      <Harness>
        <McpAppBlockView
          {...view({
            dialog: { kind: "open_link", plan: linkPlan },
            onDialogAnswer: (answer) => answers.push(answer),
          })}
        />
      </Harness>,
    );
    const confirm = page.getByRole("button", { name: "打开链接" });
    await expect.element(confirm).toBeDisabled();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("取消"));
    await expect.element(confirm, { timeout: 2_000 }).toBeEnabled();
    await page.getByText("打开 example.com 的链接时不再询问").click();
    await confirm.click();
    expect(answers).toEqual([{ dontAskAgain: true }]);
    await screen.unmount();
  });

  it("shows mail details and the look-alike warning", async () => {
    await page.viewport(WIDTH + 80, 640);
    const mail = classifyMcpAppLink("mailto:a@b.cn?subject=周报", null);
    const punycode = classifyMcpAppLink("https://xn--80ak6aa92e.com/", null);
    if (mail.action !== "confirm" || punycode.action !== "confirm") throw new Error("plan");
    const first = await render(
      <Harness>
        <McpAppBlockView {...view({ dialog: { kind: "open_link", plan: mail } })} />
      </Harness>,
    );
    await expect.element(page.getByText("要写一封邮件吗？")).toBeInTheDocument();
    await expect.element(page.getByText("周报")).toBeInTheDocument();
    await first.unmount();
    const second = await render(
      <Harness>
        <McpAppBlockView {...view({ dialog: { kind: "open_link", plan: punycode } })} />
      </Harness>,
    );
    await expect
      .element(page.getByText("这个网址含有特殊字符，可能在冒充其他网站。请确认后再打开。"))
      .toBeInTheDocument();
    await second.unmount();
  });

  it("toggles from the header, disables hide while a request waits, and answers prompts", async () => {
    await page.viewport(WIDTH + 80, 640);
    const toggles: string[] = [];
    function Stateful() {
      const [open, setOpen] = useState(true);
      const [prompt, setPrompt] = useState<McpAppHostPrompt | null>(approvalPrompt);
      return (
        <McpAppBlockView
          {...view({
            open,
            canOpenPane: open,
            prompt,
            onToggle: () => {
              toggles.push(open ? "close" : "open");
              setOpen(!open);
            },
            onPromptAnswer: (answer) => {
              toggles.push(answer ? "allow" : "deny");
              setPrompt(null);
            },
          })}
        />
      );
    }
    const screen = await render(
      <Harness>
        <Stateful />
      </Harness>,
    );
    const hide = page.getByRole("button", { name: "隐藏此连接器的小组件" });
    await expect.element(hide).toBeDisabled();
    await expect
      .element(page.getByText("moss-probe 的小组件想使用 probe_refresh"))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "允许" }).click();
    await expect.element(hide).toBeEnabled();
    const header = page.getByRole("button", { name: /来自 moss-probe 的小组件/u });
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(header);
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    expect(toggles).toEqual(["allow", "close"]);
    expect(document.querySelector('[data-mcp-app-open-pane="true"]')?.className).toContain(
      "invisible",
    );
    await screen.unmount();
  });

  it("offers 「显示」 when the side panel is not showing the docked widget", async () => {
    await page.viewport(WIDTH + 80, 400);
    const screen = await render(
      <Harness>
        <McpAppBlockView {...view({ docked: true, dockShowing: false })} />
      </Harness>,
    );
    await expect.element(page.getByText("正在侧边面板中显示")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "显示", exact: true }))
      .toBeInTheDocument();
    await screen.unmount();
  });
});
