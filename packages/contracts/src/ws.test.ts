import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WsFeatureRpcGroup } from "./rpc";
import {
  AUTH_MANAGEMENT_WS_METHODS,
  COMPUTER_HISTORY_WS_METHODS,
  WebSocketRequest,
  WsResponse,
  WS_CHANNELS,
  WS_METHODS,
} from "./ws";

it.effect("registers network access RPCs in both wire payloads and the actual served group", () =>
  Effect.gen(function* () {
    const cases = [
      [WS_METHODS.serverGetAuthSession, {}],
      [WS_METHODS.serverCreateAuthPairingToken, { label: "My phone" }],
      [WS_METHODS.serverListAuthPairingLinks, {}],
      [WS_METHODS.serverRevokeAuthPairingLink, { id: "pair-1" }],
      [WS_METHODS.serverListAuthClients, {}],
      [WS_METHODS.serverRevokeAuthClient, { sessionId: "session-1" }],
      [WS_METHODS.serverRevokeOtherAuthClients, {}],
    ] as const;
    assert.deepStrictEqual<ReadonlyArray<string>>(
      AUTH_MANAGEMENT_WS_METHODS,
      cases.slice(1).map(([method]) => method),
    );
    for (const [method, payload] of cases) {
      const rpc = WsFeatureRpcGroup.requests.get(method);
      assert.ok(rpc);
      assert.deepStrictEqual(yield* decode(rpc.payloadSchema, payload), payload);
      const wire = yield* decode(WebSocketRequest, {
        id: "auth-1",
        body: { _tag: method, ...payload },
      });
      assert.strictEqual(wire.body._tag, method);
    }
  }),
);

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it("lists every Computer History RPC, including reads, as owner-only private data", () => {
  const historyMethods = Object.values(WS_METHODS).filter((method) =>
    method.startsWith("computerHistory."),
  );
  assert.deepStrictEqual(COMPUTER_HISTORY_WS_METHODS.toSorted(), historyMethods.toSorted());
  assert.include(COMPUTER_HISTORY_WS_METHODS, WS_METHODS.computerHistoryListHistory);
  assert.include(COMPUTER_HISTORY_WS_METHODS, WS_METHODS.computerHistoryGetState);
});

it.effect("accepts only the typed inspection or removal actions for agent installations", () =>
  Effect.gen(function* () {
    for (const action of ["inspect", "uninstall"] as const) {
      const result = yield* decode(WebSocketRequest, {
        id: "agent-installation",
        body: {
          _tag: WS_METHODS.serverManageProviderInstallation,
          provider: "pi",
          action,
        },
      });
      assert.strictEqual(result.body._tag, WS_METHODS.serverManageProviderInstallation);
    }
    const result = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "agent-installation",
        body: {
          _tag: WS_METHODS.serverManageProviderInstallation,
          provider: "pi",
          action: "remove-everything",
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("registers agent installation management on the served RPC group", () =>
  Effect.gen(function* () {
    const rpc = WsFeatureRpcGroup.requests.get(WS_METHODS.serverManageProviderInstallation);
    assert.ok(rpc);
    for (const action of ["inspect", "uninstall"] as const) {
      const request = yield* decode(rpc.payloadSchema, { provider: "pi", action });
      assert.deepStrictEqual(request, { provider: "pi", action });
    }
    const rejected = yield* Effect.exit(
      decode(rpc.payloadSchema, { provider: "pi", action: "remove-everything" }),
    );
    assert.strictEqual(rejected._tag, "Failure");
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts typed websocket push envelopes with sequence", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.type, "push");
    assert.strictEqual(parsed.sequence, 1);
    assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
  }),
);

it.effect("accepts server.keepAwakeUpdated push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.serverKeepAwakeUpdated,
      data: {
        keepAwake: { available: true, mode: "agent", active: false, error: null },
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.serverKeepAwakeUpdated);
    if (parsed.channel === WS_CHANNELS.serverKeepAwakeUpdated) {
      assert.strictEqual(parsed.data.keepAwake.mode, "agent");
    }
  }),
);

it.effect("rejects push envelopes when channel payload does not match the channel schema", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WsResponse, {
        type: "push",
        sequence: 2,
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: {
          cwd: "/tmp/workspace",
          projectName: "workspace",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
