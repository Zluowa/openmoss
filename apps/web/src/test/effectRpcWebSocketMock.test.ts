import { describe, expect, it } from "vitest";
import { WsProviderGetComposerCapabilitiesRpc, WsRpcError } from "@synara/contracts";
import { Cause, Exit, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import {
  canSendEffectRpcChunk,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcFailure,
  type EffectRpcWebSocketClient,
} from "./effectRpcWebSocketMock";

describe("effectRpcWebSocketMock request lifecycle", () => {
  it("encodes a contract-valid RPC failure and discards pending stream chunks", () => {
    const sent: string[] = [];
    const client: EffectRpcWebSocketClient = { send: (data) => sent.push(data) };
    readEffectRpcClientMessage(
      client,
      JSON.stringify({ _tag: "Request", id: "failed-1", tag: "subscribe", payload: {} }),
    );
    sendEffectRpcChunk(client, "failed-1", { value: "first" });
    sendEffectRpcChunk(client, "failed-1", { value: "pending" });
    sendEffectRpcFailure(client, "failed-1", new WsRpcError({ message: "Unknown instance" }));

    const frame = JSON.parse(sent[1]!);
    const exit = Schema.decodeUnknownSync(
      Schema.toCodecJson(Rpc.exitSchema(WsProviderGetComposerCapabilitiesRpc)),
    )(frame.exit);
    expect(frame.requestId).toBe("failed-1");
    expect(Exit.match(exit, { onSuccess: () => null, onFailure: Cause.squash })).toMatchObject({
      _tag: "WsRpcError",
      message: "Unknown instance",
    });
    expect(canSendEffectRpcChunk(client, "failed-1")).toBe(false);
    readEffectRpcClientMessage(client, JSON.stringify({ _tag: "Ack", requestId: "failed-1" }));
    expect(sent).toHaveLength(2);
  });

  it("stops treating an interrupted request as a writable stream", () => {
    const sent: string[] = [];
    const client: EffectRpcWebSocketClient = {
      send: (data) => sent.push(data),
    };

    expect(
      readEffectRpcClientMessage(
        client,
        JSON.stringify({ _tag: "Request", id: "stream-1", tag: "subscribe", payload: {} }),
      ).kind,
    ).toBe("request");
    expect(canSendEffectRpcChunk(client, "stream-1")).toBe(true);

    sendEffectRpcChunk(client, "stream-1", { kind: "snapshot" });
    expect(sent).toHaveLength(1);
    expect(canSendEffectRpcChunk(client, "stream-1")).toBe(false);

    readEffectRpcClientMessage(client, JSON.stringify({ _tag: "Ack", requestId: "stream-1" }));
    expect(canSendEffectRpcChunk(client, "stream-1")).toBe(true);

    readEffectRpcClientMessage(
      client,
      JSON.stringify({ _tag: "Interrupt", requestId: "stream-1" }),
    );
    expect(canSendEffectRpcChunk(client, "stream-1")).toBe(false);
  });
});
