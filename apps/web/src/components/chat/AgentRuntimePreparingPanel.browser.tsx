import "../../index.css";
import type { DesktopAgentRuntimeState } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MossLocalizationProvider } from "../../localization";
import { AgentRuntimePreparingPanel } from "./AgentRuntimePreparingPanel";
import { ComposerColumnFrame } from "./ComposerColumnFrame";

let locale: "zh-CN" | "en" = "zh-CN";
vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: locale,
        selectedCodexAccountId: "default",
      },
    }),
  };
});

const downloading: DesktopAgentRuntimeState = {
  name: "codex",
  version: "0.166.0",
  phase: "downloading",
  bytes: 72_400_000,
  total: 114_600_000,
  secondsLeft: 20,
  failure: null,
  retryInMs: null,
};

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

async function mount(props: {
  state: DesktopAgentRuntimeState;
  held?: boolean;
  theme: "light" | "dark";
}) {
  document.documentElement.classList.toggle("dark", props.theme === "dark");
  await page.viewport(800, 260);
  const onRetry = vi.fn();
  const onCancelHeld = vi.fn();
  const screen = await render(
    <MossLocalizationProvider>
      <div data-agent-runtime-shot style={{ width: 736, padding: 24 }} className="bg-background">
        <ComposerColumnFrame>
          <AgentRuntimePreparingPanel
            state={props.state}
            held={props.held ?? false}
            onRetry={onRetry}
            onCancelHeld={onCancelHeld}
          />
        </ComposerColumnFrame>
      </div>
    </MossLocalizationProvider>,
  );
  return { screen, onRetry, onCancelHeld };
}

const visible = (element: Element | null) => {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.opacity !== "0";
};

const painted = (color: string) => color !== "rgba(0, 0, 0, 0)" && color !== "transparent";

describe("AgentRuntimePreparingPanel", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["zh-CN", "en"] as const) {
      it(`shows download progress with the time left (${language}, ${theme})`, async () => {
        locale = language;
        const { screen } = await mount({ state: downloading, theme });
        try {
          const row = document.querySelector('[data-testid="agent-runtime-preparing"]');
          expect(visible(row)).toBe(true);
          expect(row?.getAttribute("role")).toBe("status");
          expect(row?.textContent).toContain(
            language === "zh-CN"
              ? "正在准备智能体，首次使用需要下载 · 63%（72 / 115 MB），约剩 20 秒"
              : "Getting the agent ready. The first time, Moss downloads it · 63% (72 / 115 MB), about 20 s left",
          );
          // The bar is drawn: a visible track and a painted fill about 63% of its width.
          const track = document.querySelector('[data-testid="agent-runtime-progress"]');
          const fill = track?.firstElementChild ?? null;
          expect(visible(track)).toBe(true);
          expect(visible(fill)).toBe(true);
          expect(painted(getComputedStyle(track!).backgroundColor)).toBe(true);
          expect(painted(getComputedStyle(fill!).backgroundColor)).toBe(true);
          const ratio = fill!.getBoundingClientRect().width / track!.getBoundingClientRect().width;
          expect(ratio).toBeGreaterThan(0.6);
          expect(ratio).toBeLessThan(0.66);
          // The message is readable: its text is not the same colour as the row behind it.
          const text = row!.querySelector("span[title]")!;
          expect(getComputedStyle(text).color).not.toBe(getComputedStyle(row!).backgroundColor);
          // Nothing to press while it simply downloads.
          expect(row!.querySelectorAll("button")).toHaveLength(0);
          await page.screenshot({
            path: `../../../.tmp/agent-runtime-shots/panel-downloading-${language}-${theme}.png`,
            element: document.querySelector("[data-agent-runtime-shot]")!,
          });
        } finally {
          await screen.unmount();
        }
      });

      it(`offers 重试 and says what happens next when offline (${language}, ${theme})`, async () => {
        locale = language;
        const { screen, onRetry } = await mount({
          state: {
            ...downloading,
            phase: "waiting",
            failure: "offline",
            retryInMs: 30_000,
            secondsLeft: null,
          },
          theme,
        });
        try {
          const row = document.querySelector('[data-testid="agent-runtime-preparing"]')!;
          expect(row.textContent).toContain(
            language === "zh-CN"
              ? "没有网络连接。联网后会自动继续（已完成 63%）。"
              : "No internet connection. Moss continues by itself when you are back online (63% done).",
          );
          expect(painted(getComputedStyle(row).backgroundColor)).toBe(true);
          const retry = page.getByRole("button", { name: language === "zh-CN" ? "重试" : "Retry" });
          await expect.element(retry).toBeVisible();
          await retry.click();
          expect(onRetry).toHaveBeenCalledTimes(1);
          await page.screenshot({
            path: `../../../.tmp/agent-runtime-shots/panel-offline-${language}-${theme}.png`,
            element: document.querySelector("[data-agent-runtime-shot]")!,
          });
        } finally {
          await screen.unmount();
        }
      });

      it(`shows the message waiting to send by itself, with 取消 (${language}, ${theme})`, async () => {
        locale = language;
        const { screen, onCancelHeld } = await mount({ state: downloading, held: true, theme });
        try {
          const held = document.querySelector('[data-testid="agent-runtime-held-send"]');
          expect(visible(held)).toBe(true);
          expect(held?.textContent).toContain(
            language === "zh-CN"
              ? "智能体准备好后自动发送"
              : "Sends by itself when the agent is ready",
          );
          const cancel = page.getByRole("button", {
            name: language === "zh-CN" ? "取消" : "Cancel",
          });
          await expect.element(cancel).toBeVisible();
          await cancel.click();
          expect(onCancelHeld).toHaveBeenCalledTimes(1);
          await page.screenshot({
            path: `../../../.tmp/agent-runtime-shots/panel-held-${language}-${theme}.png`,
            element: document.querySelector("[data-agent-runtime-shot]")!,
          });
        } finally {
          await screen.unmount();
        }
      });
    }
  }
});
