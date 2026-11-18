import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import { McpConnectors } from "./mcpConnectors/Services/McpConnectors";
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

describe("Moss Apps in the production graph", () => {
  // 2026-11-18, the owner's build: signed in with the phone account, the 插件 page still said
  // 「登录 Moss 后即可连接你的应用。」. The Apps layer was built with the phone account only, so it
  // never saw the Google or enterprise account services and answered "sign in" to everyone.
  it("asks every Moss account service which account is in use", async () => {
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "moss-server-layers-apps-test-",
    }).pipe(Layer.provide(NodeServices.layer));
    const productionLayer = Layer.empty.pipe(
      Layer.provideMerge(makeServerRuntimeServicesLayer()),
      Layer.provideMerge(makeServerProviderLayer()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
    );

    const asked = await Effect.runPromise(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        yield* serverSettings.start;
        const phone = yield* MossPhoneAccountService;
        const cloud = yield* MossCloudAccountService;
        const enterprise = yield* MossEnterpriseKeyAccount;
        const seen = new Set<string>();
        // The same instances the rest of the server uses; record that Apps reads them.
        const record = <T extends object>(name: string, service: T, method: keyof T) => {
          const original = service[method] as (...args: unknown[]) => unknown;
          (service as Record<keyof T, unknown>)[method] = (...args: unknown[]) => {
            seen.add(name);
            return original.apply(service, args);
          };
        };
        record("phone", phone, "getSession");
        record("cloud", cloud, "getState");
        record("enterprise", enterprise, "getState");

        const connectors = yield* McpConnectors;
        yield* connectors.mossApps.status();
        return [...seen].toSorted();
      }).pipe(Effect.provide(productionLayer)),
    );

    expect(asked).toEqual(["cloud", "enterprise", "phone"]);
  });
});
