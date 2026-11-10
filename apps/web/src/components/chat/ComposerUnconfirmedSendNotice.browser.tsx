import "../../index.css";

import { CommandId, MessageId, ThreadId } from "@moss/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { useUnconfirmedTurnSends, type UnconfirmedTurnSend } from "~/lib/unconfirmedTurnSends";

const orchestration = vi.hoisted(() => ({
  dispatchCommand: vi.fn(),
  getThreadDetailSnapshot: vi.fn(),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => ({ orchestration }),
}));

// Every (re)connect delivers a welcome; the notice re-checks the server then.
vi.mock("../../wsNativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../wsNativeApi")>()),
  onServerWelcome: (listener: (payload: never) => void) => {
    listener(undefined as never);
    return () => undefined;
  },
}));

import { ComposerUnconfirmedSendNotice } from "./ComposerUnconfirmedSendNotice";

const threadId = ThreadId.makeUnsafe("thread-notice");
const messageId = MessageId.makeUnsafe("message-notice");
const send = {
  command: {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("command-notice"),
    threadId,
    message: { messageId, role: "user", text: "Ship it", attachments: [] },
    createdAt: "2026-11-03T00:00:00.000Z",
  },
  prompt: "Ship it",
} as unknown as UnconfirmedTurnSend;

const snapshotWith = (ids: readonly string[]) => ({
  thread: { messages: ids.map((id) => ({ id })) },
});

describe("ComposerUnconfirmedSendNotice", () => {
  afterEach(async () => {
    orchestration.dispatchCommand.mockReset();
    orchestration.getThreadDetailSnapshot.mockReset();
    useUnconfirmedTurnSends.setState({ sends: {} });
    await cleanup();
  });

  it("keeps an unconfirmed message on screen and sends it again with the same command", async () => {
    orchestration.getThreadDetailSnapshot.mockResolvedValue(snapshotWith([]));
    orchestration.dispatchCommand.mockResolvedValue({ sequence: 3 });
    useUnconfirmedTurnSends.getState().hold(send);
    await render(<ComposerUnconfirmedSendNotice threadId={threadId} onDiscard={vi.fn()} />);

    await expect.element(page.getByText("Not confirmed yet")).toBeVisible();
    await expect.element(page.getByText("Ship it")).toBeVisible();
    await page.getByRole("button", { name: "Send again" }).click();

    await vi.waitFor(() =>
      expect(orchestration.dispatchCommand).toHaveBeenCalledExactlyOnceWith(send.command),
    );
    await expect.element(page.getByText("Not confirmed yet")).not.toBeInTheDocument();
  });

  it("confirms the message on reconnect when the server shows it", async () => {
    orchestration.getThreadDetailSnapshot.mockResolvedValue(snapshotWith([messageId]));
    useUnconfirmedTurnSends.getState().hold(send);
    await render(<ComposerUnconfirmedSendNotice threadId={threadId} onDiscard={vi.fn()} />);

    await vi.waitFor(() =>
      expect(useUnconfirmedTurnSends.getState().sends[threadId]).toBeUndefined(),
    );
    expect(orchestration.dispatchCommand).not.toHaveBeenCalled();
  });

  it("hands a discarded message back for the composer", async () => {
    orchestration.getThreadDetailSnapshot.mockResolvedValue(snapshotWith([]));
    useUnconfirmedTurnSends.getState().hold(send);
    const onDiscard = vi.fn();
    await render(<ComposerUnconfirmedSendNotice threadId={threadId} onDiscard={onDiscard} />);

    await page.getByRole("button", { name: "Discard" }).click();
    expect(onDiscard).toHaveBeenCalledWith("Ship it", messageId);
    expect(orchestration.dispatchCommand).not.toHaveBeenCalled();
    await expect.element(page.getByText("Not confirmed yet")).not.toBeInTheDocument();
  });
});
