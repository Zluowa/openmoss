// @vitest-environment happy-dom
import { CommandId, MessageId, ThreadId } from "@moss/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UnconfirmedTurnSend } from "./unconfirmedTurnSends";

const threadId = ThreadId.makeUnsafe("thread-unconfirmed");
const messageId = MessageId.makeUnsafe("message-unconfirmed");

const send = {
  command: {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("command-unconfirmed"),
    threadId,
    message: { messageId, role: "user", text: "Ship it", attachments: [] },
    createdAt: "2026-11-03T00:00:00.000Z",
  },
  prompt: "Ship it",
} as unknown as UnconfirmedTurnSend;

/** The transport's error for a request that died with the connection. */
const lostReply = Object.assign(new Error("WebSocket RPC timed out"), {
  _tag: "WsTransportRequestInterruptedError",
  code: "WS_REQUEST_TIMEOUT",
});

function snapshotWith(messageIds: readonly string[]) {
  return { thread: { messages: messageIds.map((id) => ({ id })) } };
}

async function loadModule() {
  return import("./unconfirmedTurnSends");
}

describe("unconfirmed turn sends", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  it("holds a lost reply when the confirmation check fails, without sending it again", async () => {
    const { settleFailedTurnSend, getUnconfirmedTurnSend } = await loadModule();
    const api = {
      getThreadDetailSnapshot: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      dispatchCommand: vi.fn(),
    };

    await expect(
      settleFailedTurnSend({ error: lostReply, api, send, alreadyReceived: () => false }),
    ).resolves.toBe("unconfirmed");

    expect(api.getThreadDetailSnapshot).toHaveBeenCalledOnce();
    expect(api.dispatchCommand).not.toHaveBeenCalled();
    expect(getUnconfirmedTurnSend(threadId)?.command.commandId).toBe(send.command.commandId);
  });

  it("confirms a held message after a reload once the server shows it", async () => {
    const first = await loadModule();
    await first.settleFailedTurnSend({
      error: lostReply,
      api: { getThreadDetailSnapshot: vi.fn(async () => snapshotWith([])) as never },
      send,
      alreadyReceived: () => false,
    });

    // A page reload starts a fresh module that reads the held send back.
    vi.resetModules();
    const reloaded = await loadModule();
    expect(reloaded.getUnconfirmedTurnSend(threadId)?.prompt).toBe("Ship it");

    const notYet = { getThreadDetailSnapshot: vi.fn(async () => snapshotWith(["other"])) };
    await expect(reloaded.confirmUnconfirmedTurnSend(notYet as never, threadId)).resolves.toBe(
      false,
    );
    expect(reloaded.getUnconfirmedTurnSend(threadId)).not.toBeNull();

    const arrived = { getThreadDetailSnapshot: vi.fn(async () => snapshotWith([messageId])) };
    await expect(reloaded.confirmUnconfirmedTurnSend(arrived as never, threadId)).resolves.toBe(
      true,
    );
    expect(reloaded.getUnconfirmedTurnSend(threadId)).toBeNull();
  });

  it("keeps the PR's one-shot check as the first confirmation and refuses real rejections", async () => {
    const { settleFailedTurnSend, getUnconfirmedTurnSend } = await loadModule();
    const accepted = { getThreadDetailSnapshot: vi.fn(async () => snapshotWith([messageId])) };
    await expect(
      settleFailedTurnSend({
        error: lostReply,
        api: accepted as never,
        send,
        alreadyReceived: () => false,
      }),
    ).resolves.toBe("accepted");
    expect(getUnconfirmedTurnSend(threadId)).toBeNull();

    const missing = { getThreadDetailSnapshot: vi.fn(async () => snapshotWith([])) };
    await expect(
      settleFailedTurnSend({
        error: new Error("Thread is archived"),
        api: missing as never,
        send,
        alreadyReceived: () => false,
      }),
    ).resolves.toBe("rejected");
    expect(getUnconfirmedTurnSend(threadId)).toBeNull();
  });

  it("retries with the original command id and stays held while the outcome is unknown", async () => {
    const { settleFailedTurnSend, retryUnconfirmedTurnSend, getUnconfirmedTurnSend } =
      await loadModule();
    const missing = vi.fn(async () => snapshotWith([]));
    await settleFailedTurnSend({
      error: lostReply,
      api: { getThreadDetailSnapshot: missing } as never,
      send,
      alreadyReceived: () => false,
    });

    const stillLost = {
      getThreadDetailSnapshot: missing,
      dispatchCommand: vi.fn(async () => {
        throw lostReply;
      }),
    };
    await expect(retryUnconfirmedTurnSend(stillLost as never, threadId)).resolves.toBe(
      "unconfirmed",
    );
    expect(getUnconfirmedTurnSend(threadId)).not.toBeNull();

    const delivered = {
      getThreadDetailSnapshot: missing,
      dispatchCommand: vi.fn(async () => ({ sequence: 7 })),
    };
    await expect(retryUnconfirmedTurnSend(delivered as never, threadId)).resolves.toBe("confirmed");
    expect(delivered.dispatchCommand).toHaveBeenCalledExactlyOnceWith(send.command);
    expect(getUnconfirmedTurnSend(threadId)).toBeNull();
  });

  it("returns a discarded message so its text can go back to the composer", async () => {
    const { settleFailedTurnSend, discardUnconfirmedTurnSend, getUnconfirmedTurnSend } =
      await loadModule();
    await settleFailedTurnSend({
      error: lostReply,
      api: { getThreadDetailSnapshot: vi.fn(async () => snapshotWith([])) } as never,
      send,
      alreadyReceived: () => false,
    });
    expect(discardUnconfirmedTurnSend(threadId)?.prompt).toBe("Ship it");
    expect(getUnconfirmedTurnSend(threadId)).toBeNull();
  });
});
