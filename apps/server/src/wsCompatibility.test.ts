import {
  WS_COMPATIBILITY_QUERY,
  WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  WS_SERVER_CAPABILITIES,
  WS_SERVER_HOSTED_BROWSER_CAPABILITY,
  WS_THREAD_GOAL_VISIBLE_START_CAPABILITY,
} from "@moss/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  advertiseWsRuntimeCapability,
  makeCurrentWsFeatureCompatibilitySearchParams,
  negotiateWsCompatibility,
  validateWsFeatureCompatibility,
} from "./wsCompatibility";

describe("WebSocket compatibility bootstrap", () => {
  it("adds a runtime capability once this process advertises it", async () => {
    const negotiate = () =>
      Effect.runPromise(
        negotiateWsCompatibility({
          protocolEpoch: WS_PROTOCOL_EPOCH,
          minRevision: WS_PROTOCOL_MIN_REVISION,
          maxRevision: WS_PROTOCOL_MAX_REVISION,
          clientBuild: "test-client",
          requiredCapabilities: [],
        }),
      );
    // Not part of the build's list: only a server whose agents use its own browser says it.
    expect(WS_SERVER_CAPABILITIES).not.toContain(WS_SERVER_HOSTED_BROWSER_CAPABILITY);
    expect((await negotiate()).capabilities).not.toContain(WS_SERVER_HOSTED_BROWSER_CAPABILITY);
    advertiseWsRuntimeCapability(WS_SERVER_HOSTED_BROWSER_CAPABILITY);
    expect((await negotiate()).capabilities).toContain(WS_SERVER_HOSTED_BROWSER_CAPABILITY);
  });

  it("negotiates the stable epoch/range and returns process/build capabilities", async () => {
    const result = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: WS_PROTOCOL_MIN_REVISION,
        maxRevision: WS_PROTOCOL_MAX_REVISION,
        clientBuild: "test-client",
        requiredCapabilities: [...WS_SERVER_CAPABILITIES],
      }),
    );

    expect(result).toMatchObject({
      protocolEpoch: WS_PROTOCOL_EPOCH,
      negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
    });
    expect(result.serverBuild.length).toBeGreaterThan(0);
    expect(result.serverInstanceId.length).toBeGreaterThan(0);
    expect(result.capabilities).toContain("orchestration.cursor-safe-streams");
    expect(result.capabilities).toContain("orchestration.thread-detail-snapshot");
    expect(result.capabilities).toContain("projects.github-provisioning");
    expect(result.capabilities).toContain(WS_PROJECT_FILE_WATCH_CAPABILITY);
    expect(result.capabilities).toContain(WS_THREAD_GOAL_VISIBLE_START_CAPABILITY);
    expect(WS_CLIENT_REQUIRED_CAPABILITIES).not.toContain("projects.github-provisioning");
    expect(WS_CLIENT_REQUIRED_CAPABILITIES).not.toContain(WS_PROJECT_FILE_WATCH_CAPABILITY);
    expect(WS_CLIENT_REQUIRED_CAPABILITIES).not.toContain(WS_THREAD_GOAL_VISIBLE_START_CAPABILITY);
  });

  it("rejects revision-two clients after the pull request list moved to githubInbox.list", async () => {
    const error = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: 2,
        maxRevision: 2,
        clientBuild: "stale-client",
        requiredCapabilities: [],
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "WS_PROTOCOL_INCOMPATIBLE",
      action: "update-client",
    });
  });

  it("rejects revision-one clients after the commit-author wire shape change", async () => {
    const error = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: 1,
        maxRevision: 1,
        clientBuild: "stale-client",
        requiredCapabilities: [],
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "WS_PROTOCOL_INCOMPATIBLE",
      action: "update-client",
    });
  });

  it("keeps server-generation diagnostics product-neutral", () => {
    const params = makeCurrentWsFeatureCompatibilitySearchParams("test-client");
    params.set(WS_COMPATIBILITY_QUERY.serverInstanceId, "stale-server-instance");

    const error = validateWsFeatureCompatibility(params);

    expect(error).toMatchObject({
      code: "WS_SERVER_GENERATION_CHANGED",
      action: "reload",
    });
    expect(error?.message).toBe(
      "The server restarted during WebSocket negotiation. Reload to reconnect to the new server generation.",
    );
    expect(error?.message).not.toContain("Moss");
  });
});
