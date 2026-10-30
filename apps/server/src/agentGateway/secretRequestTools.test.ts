import { SECRET_REQUEST_DEFAULT_WAIT_MS, ThreadId, TurnId } from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type {
  SecretRequestInput,
  SecretRequestResult,
} from "../secretRequests/Services/SecretRequests.ts";
import { SecretRequestError } from "../secretRequests/Services/SecretRequests.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { makeAgentGatewaySecretRequestTools } from "./secretRequestTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "gateway-session:secret",
    threadId: "thread-caller",
    provider: "codex",
    turnId: "turn-caller",
  },
  callerThreadId: "thread-caller",
  callerThreadLabel: "Caller",
  callerSessionKey: "gateway-session:secret",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn-caller",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

function makeTool(answer: Effect.Effect<SecretRequestResult, SecretRequestError>) {
  const requests: Array<SecretRequestInput> = [];
  const [tool] = makeAgentGatewaySecretRequestTools({
    secretRequests: {
      request: (input) => {
        requests.push(input);
        return answer;
      },
    },
  });
  return { tool: tool!, requests };
}

const json = (result: McpToolCallResult) => {
  const block = result.content[0];
  assert.strictEqual(block?.type, "text");
  return JSON.parse(block?.type === "text" ? block.text : "null") as Record<string, unknown>;
};

describe("moss_request_secret", () => {
  it("asks only while a turn is running, under thread write authority", () => {
    const { tool } = makeTool(Effect.succeed({ outcome: "declined" }));
    assert.strictEqual(tool.definition.name, "moss_request_secret");
    assert.strictEqual(tool.requiredCapability, "thread:write");
    assert.strictEqual(tool.requiresActiveTurn, true);
  });

  it.effect("returns the private file for a saved secret, never a value", () =>
    Effect.gen(function* () {
      const { tool, requests } = makeTool(
        Effect.succeed({
          outcome: "saved",
          file: "/state/secrets/requests/abc",
          expiresAt: "2026-10-30T12:00:00.000Z",
        }),
      );
      const result = yield* tool.handler(
        { label: " Cloudflare API token ", reason: "Deploy the worker." },
        context,
      );
      assert.notStrictEqual(result.isError, true);
      assert.deepStrictEqual(json(result), {
        status: "saved",
        file: "/state/secrets/requests/abc",
        expiresAt: "2026-10-30T12:00:00.000Z",
      });
      assert.deepStrictEqual(requests, [
        {
          threadId: ThreadId.makeUnsafe("thread-caller"),
          turnId: TurnId.makeUnsafe("turn-caller"),
          label: "Cloudflare API token",
          reason: "Deploy the worker.",
          placeholder: undefined,
          waitMs: SECRET_REQUEST_DEFAULT_WAIT_MS,
        },
      ]);
    }),
  );

  it.effect("tells the agent why nothing was saved", () =>
    Effect.gen(function* () {
      const { tool } = makeTool(Effect.succeed({ outcome: "timed_out" }));
      const result = yield* tool.handler(
        { label: "Token", reason: "Needed.", timeoutMs: 120_000 },
        context,
      );
      assert.deepStrictEqual(json(result), {
        status: "timed_out",
        message: "The user did not answer in time.",
      });
    }),
  );

  it.effect("refuses bad input before showing a card", () =>
    Effect.gen(function* () {
      const { tool, requests } = makeTool(Effect.succeed({ outcome: "declined" }));
      for (const args of [
        { reason: "No label." },
        { label: "Token" },
        { label: "Token", reason: "Too short a wait.", timeoutMs: 10 },
        { label: "Token", reason: "Too long a wait.", timeoutMs: 2 * 60 * 60 * 1000 },
        { label: "x".repeat(201), reason: "Label too long." },
      ]) {
        const result = yield* tool.handler(args, context);
        assert.strictEqual(result.isError, true, JSON.stringify(args));
      }
      assert.deepStrictEqual(requests, []);
    }),
  );

  it.effect("reports a full queue as a tool error", () =>
    Effect.gen(function* () {
      const { tool } = makeTool(
        Effect.fail(
          new SecretRequestError({ code: "queue_full", message: "Too many secret requests." }),
        ),
      );
      const result = yield* tool.handler({ label: "Token", reason: "Needed." }, context);
      assert.strictEqual(result.isError, true);
    }),
  );
});
