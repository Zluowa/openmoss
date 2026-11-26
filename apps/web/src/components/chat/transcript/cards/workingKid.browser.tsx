import "../../../../index.css";

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { WorkingCompanionContext } from "../workingCompanionContext";
import { WorkingMarkContext } from "../workingMarkContext";
import type { WorkingMarkSignal } from "../workingStatus";
import { TRANSCRIPT_CARDS } from "./transcriptCards";

const Working = TRANSCRIPT_CARDS.working.Body;
const env = {
  threadId: null,
  workingLabel: "Thinking",
  typography: { chatPx: 15 },
} as unknown as Parameters<typeof Working>[0]["env"];
const row = { kind: "working", id: "working-indicator-row" } as Parameters<
  typeof Working
>[0]["row"];

function WorkingLine(props: {
  companion: { icon: string | null; color: string | null } | null;
  signal: WorkingMarkSignal;
}) {
  return (
    <MossLocaleScope locale="zh-CN">
      <WorkingCompanionContext.Provider value={props.companion}>
        <WorkingMarkContext.Provider value={props.signal}>
          <div className="bg-background p-6 text-foreground" style={{ width: 480 }}>
            <Working row={row} env={env} />
          </div>
        </WorkingMarkContext.Provider>
      </WorkingCompanionContext.Provider>
    </MossLocaleScope>
  );
}

const running: WorkingMarkSignal = {
  activity: "working",
  progress: 3,
  tool: { itemType: "command_execution", command: "bun run test" },
};

describe("the working line in a Mossbot conversation", () => {
  it("shows the assistant's pinwheel kid acting out the running tool", async () => {
    const screen = await render(
      <WorkingLine companion={{ icon: "mossbot-kid-penguin", color: "blue" }} signal={running} />,
    );
    const kid = screen.container.querySelector<HTMLElement>("[data-working-kid]");
    expect(kid?.dataset.mossbotKid).toBe("live");
    const canvas = kid!.querySelector("canvas")!;
    await expect
      .poll(() => {
        const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        return data.some((value, index) => index % 4 === 3 && value > 0);
      })
      .toBe(true);
  });

  it("keeps the Moss mark for an assistant that wears another face, and outside Mossbot", async () => {
    const companion = await render(
      <WorkingLine companion={{ icon: "mossbot-pebble", color: null }} signal={running} />,
    );
    expect(companion.container.querySelector("[data-working-kid]")).toBeNull();
    await companion.unmount();
    const plain = await render(<WorkingLine companion={null} signal={running} />);
    expect(plain.container.querySelector("[data-working-kid]")).toBeNull();
  });
});
