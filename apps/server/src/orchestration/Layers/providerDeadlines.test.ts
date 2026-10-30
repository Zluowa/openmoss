import { Duration } from "effect";
import { describe, expect, it } from "vitest";

import { PROVIDER_START_SESSION_TIMEOUT } from "../../provider/Layers/ProviderService.ts";
import { PROVIDER_COMMAND_EVENT_TIMEOUT } from "./ProviderCommandReactor.ts";

describe("provider deadlines", () => {
  it("let a slow session start fail on its own deadline inside the turn-start delivery deadline", () => {
    // Once the session is ready the turn itself still needs room to start.
    expect(Duration.toMillis(PROVIDER_START_SESSION_TIMEOUT) + 15_000).toBeLessThanOrEqual(
      Duration.toMillis(PROVIDER_COMMAND_EVENT_TIMEOUT),
    );
  });
});
