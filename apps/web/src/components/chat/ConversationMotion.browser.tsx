import "../../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import ChatMarkdown from "../ChatMarkdown";
import { ConversationShimmer } from "./ConversationShimmer";

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

function MarkdownHarness() {
  const [text, setText] = useState("Inspect the motion.");
  const [active, setActive] = useState(true);
  return (
    <>
      <button onClick={() => setText("Inspect the motion. Then verify the result.")}>Append</button>
      <button onClick={() => setActive(false)}>Settle</button>
      <ChatMarkdown cwd={undefined} text={text} isStreaming={active} findQuery="motion" />
      <ChatMarkdown cwd={undefined} text={"```txt\nno animated code\n```"} isStreaming={active} />
      <ChatMarkdown
        cwd={undefined}
        text="User text stays still."
        isStreaming={active}
        variant="user"
      />
    </>
  );
}

function ShimmerHarness() {
  const [active, setActive] = useState(true);
  return (
    <>
      <button onClick={() => setActive(false)}>Settle</button>
      <ConversationShimmer active={active}>
        Thinking <button>Details</button>
      </ConversationShimmer>
    </>
  );
}

describe("conversation motion", () => {
  afterEach(async () => {
    await motionCommands.emulateReducedMotion("no-preference");
  });

  it("fades new prose once while preserving search, code, user text, and settlement", async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    const screen = await render(<MarkdownHarness />);
    try {
      const first = document.querySelector<HTMLElement>('[data-stream-text-start="0"]');
      if (!first) throw new Error("Streaming prose segment missing");
      expect(getComputedStyle(first).animationDuration).toBe("0.15s");
      expect(getComputedStyle(first).animationTimingFunction).toBe(
        "cubic-bezier(0.37, 0.55, 0.86, 0.88)",
      );
      await expect.poll(() => getComputedStyle(first).opacity).toBe("1");
      expect(document.querySelector("pre .codex-stream-segment")).toBeNull();
      expect(document.querySelector(".chat-markdown--user .codex-stream-segment")).toBeNull();
      expect(document.querySelector("[data-chat-find-match]")?.textContent).toBe("motion");
      await page.getByRole("button", { name: "Append" }).click();
      await expect
        .poll(() => document.querySelector(".chat-markdown")?.textContent)
        .toBe("Inspect the motion. Then verify the result.");
      expect(document.querySelector('[data-stream-text-start="0"]')).toBe(first);
      expect(getComputedStyle(first).animationName).toBe("none");
      await page.getByRole("button", { name: "Settle" }).click();
      expect(document.querySelector("[data-codex-streaming]")).toBeNull();
      expect(document.querySelector(".codex-stream-segment")).toBeNull();
      expect(document.querySelector("[data-chat-find-match]")?.textContent).toBe("motion");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps reduced-motion prose visible without animation", async () => {
    await motionCommands.emulateReducedMotion("reduce");
    const screen = await render(<MarkdownHarness />);
    try {
      const segment = document.querySelector<HTMLElement>(".codex-stream-segment");
      if (!segment) throw new Error("Streaming prose segment missing");
      expect(getComputedStyle(segment).animationName).toBe("none");
      expect(getComputedStyle(segment).opacity).toBe("1");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the shimmer copy inert and stops it when settling or changing motion preference", async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    const screen = await render(<ShimmerHarness />);
    try {
      const sweep = document.querySelector<HTMLElement>(".codex-text-shimmer-sweep");
      if (!sweep) throw new Error("Shimmer overlay missing");
      expect(sweep.getAttribute("aria-hidden")).toBe("true");
      expect(sweep.hasAttribute("inert")).toBe(true);
      expect(sweep.getAttribute("data-thread-find-skip")).toBe("true");
      await expect.element(page.getByRole("button", { name: "Details" })).toBeVisible();
      await expect
        .poll(() => getComputedStyle(sweep).animationName)
        .toBe("codex-text-shimmer-sweep");
      await motionCommands.emulateReducedMotion("reduce");
      await expect.poll(() => getComputedStyle(sweep).animationName).toBe("none");
      await expect.poll(() => document.querySelector(".codex-text-shimmer-active")).toBeNull();
      await page.getByRole("button", { name: "Settle" }).click();
      expect(document.querySelector(".codex-text-shimmer-sweep")).toBeNull();
      expect(document.querySelector("[data-conversation-shimmer]")).toBeNull();
      await expect.element(page.getByRole("button", { name: "Details" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
