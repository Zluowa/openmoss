import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { recoverInterruptedAgentGatewayOperations } from "./startupRecovery.ts";

describe("agent gateway startup recovery branding", () => {
  it("persists a Moss-branded replay error for an interrupted reserved operation", async () => {
    const failureJson: string[] = [];

    await Effect.runPromise(
      recoverInterruptedAgentGatewayOperations({
        operationRepository: {
          listNonTerminal: () =>
            Effect.succeed([
              { operationId: "gateway:reserved", status: "reserved", planJson: "[]" },
            ]),
          fail: (input: { readonly errorJson: string }) =>
            Effect.sync(() => {
              failureJson.push(input.errorJson);
            }),
          markCompensating: () => Effect.die("not used"),
          recordCompensationFailure: () => Effect.die("not used"),
        } as never,
        snapshotQuery: {} as never,
        orchestrationEngine: {} as never,
        git: {} as never,
      }),
    );

    assert.lengthOf(failureJson, 1);
    const failure = JSON.parse(failureJson[0] ?? "{}") as { message?: string };
    assert.include(failure.message ?? "", "Moss restarted");
  });
});
