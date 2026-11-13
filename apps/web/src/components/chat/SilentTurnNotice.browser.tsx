import "../../index.css";

import { TurnId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { buildThemeCssVariables, DEFAULT_THEME_STATE, resolveThemePack } from "~/theme/theme.logic";
import { TRANSCRIPT_CARDS } from "./transcript/cards/transcriptCards";

const notice = vi.hoisted(() => ({
  openToolCall: false,
}));

// The working row reads the chat's newest silent-turn record; give it one.
vi.mock("~/threadDerivation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/threadDerivation")>()),
  getThreadFromState: () => ({}),
}));
vi.mock("./silentTurnNotice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./silentTurnNotice")>()),
  resolveSilentTurnNotice: () => ({
    id: "silent-record",
    turnId: TurnId.makeUnsafe("turn-silent"),
    openToolCall: notice.openToolCall,
    silentForMs: 185_000,
  }),
}));

// The app applies its theme as runtime variables; do the same for each render.
function setTheme(mode: "light" | "dark") {
  const { variables } = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, mode), mode);
  for (const [name, value] of Object.entries(variables))
    document.documentElement.style.setProperty(name, value);
  document.documentElement.classList.toggle("dark", mode === "dark");
}

function WorkingRow(props: {
  locale: "zh-CN" | "en";
  onStopAndRetryTurn: (turnId: TurnId) => Promise<boolean>;
}) {
  const Working = TRANSCRIPT_CARDS.working.Body;
  const env = {
    threadId: "thread-silent",
    workingLabel: "Thinking",
    typography: { chatPx: 15 },
    onStopAndRetryTurn: props.onStopAndRetryTurn,
  } as unknown as Parameters<typeof Working>[0]["env"];
  const row = { kind: "working", id: "working-indicator-row" } as Parameters<
    typeof Working
  >[0]["row"];
  return (
    <MossLocaleScope locale={props.locale}>
      <div className="bg-background p-6 text-foreground" style={{ width: 760 }}>
        <Working row={row} env={env} />
      </div>
    </MossLocaleScope>
  );
}

afterEach(() => {
  setTheme("light");
  notice.openToolCall = false;
});

describe("silent running turn in the working row", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const locale of ["zh-CN", "en"] as const) {
      it(`says the agent is silent and offers both choices (${theme}, ${locale})`, async () => {
        await page.viewport(820, 200);
        setTheme(theme);
        const onStopAndRetryTurn = vi.fn(async () => true);
        const screen = await render(
          <WorkingRow locale={locale} onStopAndRetryTurn={onStopAndRetryTurn} />,
        );
        const zh = locale === "zh-CN";
        await expect
          .element(
            page.getByText(
              zh
                ? "智能体已超过 3 分钟没有任何回应。"
                : "No response from the agent for over 3 min.",
            ),
          )
          .toBeInTheDocument();
        await page.screenshot({
          path: `__screenshots__/silent-turn-notice/working-row-${theme}-${locale}.png`,
          element: screen.container,
        });
        await page.getByRole("button", { name: zh ? "停止并重试" : "Stop and retry" }).click();
        expect(onStopAndRetryTurn).toHaveBeenCalledWith("turn-silent");
        await page.getByRole("button", { name: zh ? "继续等待" : "Keep waiting" }).click();
        await expect
          .element(page.getByRole("button", { name: zh ? "继续等待" : "Keep waiting" }))
          .not.toBeInTheDocument();
      });
    }
  }

  it("names the open tool call in the longer wait", async () => {
    notice.openToolCall = true;
    await render(<WorkingRow locale="zh-CN" onStopAndRetryTurn={async () => true} />);
    await expect
      .element(page.getByText("工具调用已进行超过 3 分钟，智能体没有任何回应。"))
      .toBeInTheDocument();
  });
});
