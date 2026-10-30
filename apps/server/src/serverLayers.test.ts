import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ServerSettingsService } from "./serverSettings";

describe("makeServerRuntimeServicesLayer", () => {
  it("boots the production runtime composition with Moss account services available to snapshots", async () => {
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "moss-server-layers-test-",
    }).pipe(Layer.provide(NodeServices.layer));
    const productionLayer = Layer.empty.pipe(
      Layer.provideMerge(makeServerRuntimeServicesLayer()),
      Layer.provideMerge(makeServerProviderLayer()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
    );

    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        // This must resolve from the real production graph. A missing account
        // layer otherwise only surfaces after the HTTP entrypoint has started.
        yield* MossPhoneAccountService;
        yield* MossCloudAccountService;

        const serverSettings = yield* ServerSettingsService;
        yield* serverSettings.start;

        const snapshotQuery = yield* ProjectionSnapshotQuery;
        return yield* snapshotQuery.getCounts();
      }).pipe(Effect.provide(productionLayer)),
    );

    expect(counts).toEqual({ projectCount: 0, threadCount: 0 });
  });
});
