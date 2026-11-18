import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { HELD_SEND_AFTER_READY_MS, useAgentRuntimeHeldSend } from "./useAgentRuntimeDownloads";

let latest: ReturnType<typeof useAgentRuntimeHeldSend> | null = null;

function Probe(props: { threadId: string; pending: boolean; send: () => void }) {
  latest = useAgentRuntimeHeldSend(props);
  return <span data-held={latest.held ? "yes" : "no"} />;
}

const threadId = "thread-held-send-test";
afterEach(() => {
  window.localStorage.removeItem(`moss.agentRuntimeHeldSend.${threadId}`);
  latest = null;
});

const until = async (check: () => boolean, ms = HELD_SEND_AFTER_READY_MS + 3_000) => {
  await expect.poll(check, { timeout: ms, interval: 50 }).toBe(true);
};

describe("a message held until the agent is ready", () => {
  it("is kept while the agent downloads and sent once when it is ready", async () => {
    const send = vi.fn();
    const screen = await render(<Probe threadId={threadId} pending send={send} />);
    latest!.hold();
    await until(() => latest!.held);
    await new Promise((resolve) => setTimeout(resolve, HELD_SEND_AFTER_READY_MS + 200));
    expect(send).not.toHaveBeenCalled();

    await screen.rerender(<Probe threadId={threadId} pending={false} send={send} />);
    await until(() => send.mock.calls.length === 1);
    expect(latest!.held).toBe(false);
    expect(window.localStorage.getItem(`moss.agentRuntimeHeldSend.${threadId}`)).toBeNull();
    await screen.unmount();
  });

  it("survives Moss being closed and opened while the agent downloads", async () => {
    const send = vi.fn();
    const first = await render(<Probe threadId={threadId} pending send={send} />);
    latest!.hold();
    await until(() => latest!.held);
    await first.unmount();

    // A new window after a restart: the mark is still there and the send still happens.
    const second = await render(<Probe threadId={threadId} pending send={send} />);
    expect(latest!.held).toBe(true);
    await second.rerender(<Probe threadId={threadId} pending={false} send={send} />);
    await until(() => send.mock.calls.length === 1);
    await second.unmount();
  });

  it("still sends while the window re-renders constantly with a new send each time", async () => {
    // ChatView re-renders many times a second while the other agent downloads, and its send
    // callback is new each render. The held message must still go out, exactly once.
    const calls: number[] = [];
    let generation = 0;
    const makeSend = (n: number) => () => calls.push(n);
    const screen = await render(<Probe threadId={threadId} pending send={makeSend(0)} />);
    latest!.hold();
    await until(() => latest!.held);
    const started = Date.now();
    while (Date.now() - started < HELD_SEND_AFTER_READY_MS + 1_500) {
      generation += 1;
      await screen.rerender(
        <Probe threadId={threadId} pending={false} send={makeSend(generation)} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    expect(calls).toHaveLength(1);
    // The latest send at that moment ran, not a stale one from before the agent was ready.
    expect(calls[0]).toBeGreaterThan(0);
    await screen.unmount();
  });

  it("sends nothing after 取消", async () => {
    const send = vi.fn();
    const screen = await render(<Probe threadId={threadId} pending send={send} />);
    latest!.hold();
    await until(() => latest!.held);
    latest!.cancel();
    await until(() => !latest!.held);
    await screen.rerender(<Probe threadId={threadId} pending={false} send={send} />);
    await new Promise((resolve) => setTimeout(resolve, HELD_SEND_AFTER_READY_MS + 300));
    expect(send).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
