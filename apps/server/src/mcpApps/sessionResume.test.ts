import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { whenProviderSessionResumed } from "./operations.ts";

const withSessions = (live: () => boolean) =>
  Effect.provideService(ProviderService, {
    listSessions: () => Effect.succeed(live() ? [{ threadId: "t-resume", status: "ready" }] : []),
  } as never);

describe("whenProviderSessionResumed", () => {
  it("runs widget calls one at a time while the session resumes, then all of them", async () => {
    let live = false;
    let running = 0;
    let most = 0;
    const call = (label: string) =>
      Effect.gen(function* () {
        running += 1;
        most = Math.max(most, running);
        // The first call is the one that brings the session back.
        yield* Effect.sleep("20 millis");
        live = true;
        running -= 1;
        return label;
      });
    const results = await Effect.runPromise(
      Effect.all(
        ["a", "b", "c"].map((label) => whenProviderSessionResumed("t-resume", call(label))),
        { concurrency: "unbounded" },
      ).pipe(withSessions(() => live)),
    );
    expect(results).toEqual(["a", "b", "c"]);
    expect(most).toBe(1);
  });

  it("runs at once when the session is live", async () => {
    const result = await Effect.runPromise(
      whenProviderSessionResumed("t-live", Effect.succeed("ok")).pipe(withSessions(() => true)),
    );
    expect(result).toBe("ok");
  });
});
