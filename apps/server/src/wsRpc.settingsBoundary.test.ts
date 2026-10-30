import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import type { ServerSettings, ServerSettingsPatch } from "@synara/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import {
  ServerSettingsLive,
  ServerSettingsService,
  type ServerSettingsShape,
} from "./serverSettings";
import { serverUpdateSettingsRpcEffect } from "./wsRpc";

const nodeLayer = Layer.merge(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "moss-settings-boundary-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const testLayer = Layer.merge(nodeLayer, ServerSettingsLive.pipe(Layer.provide(nodeLayer)));
const runWithSettings = <A, E>(effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testLayer)));

const nonce = "a2222222-2222-4222-8222-222222222222";
function reservation(home: string, enabled: boolean, ownershipNonce = nonce): ServerSettingsPatch {
  return {
    providers: {
      codex: {
        accounts: [{ id: "moss", label: "Moss", homePath: home, shadowHomePath: "" }],
      },
    },
    providerInstances: {
      codex_moss: {
        driver: "codex",
        displayName: "Moss",
        enabled,
        config: {
          accountId: "moss",
          homePath: home,
          managed: true,
          homeOwnershipNonce: ownershipNonce,
        },
      },
    },
  };
}

describe("WebSocket settings reservation boundary", () => {
  it("cannot reactivate a disabled reservation even with its real nonce, while ordinary edits persist", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        yield* service.start;
        const original = yield* service.updateSettings(
          reservation(join(config.stateDir, "moss-codex-home"), false),
        );
        const moss = original.providerInstances.codex_moss!;
        const view = yield* serverUpdateSettingsRpcEffect(service, {
          keepAwakeMode: "always",
          providers: {
            codex: {
              accounts: [
                {
                  ...original.providers.codex.accounts[0]!,
                  label: "forged",
                  homePath: join(config.stateDir, "foreign"),
                },
                {
                  id: "personal",
                  label: "Personal",
                  homePath: join(config.stateDir, "personal"),
                  shadowHomePath: "",
                },
              ],
            },
          },
          providerInstances: {
            codex_moss: { ...moss, enabled: true },
            codex_byok: { driver: "codex", config: { byok: true, accountId: "byok" } },
            ordinary: {
              driver: "codex",
              displayName: "Ordinary",
              config: {
                homePath: join(config.stateDir, "personal"),
                serverPassword: "test-only-password",
              },
            },
          },
        });
        return { original, view, stored: yield* service.getSettings };
      }),
    );
    expect(result.stored.providerInstances.codex_moss).toEqual(
      result.original.providerInstances.codex_moss,
    );
    expect(result.stored.providers.codex.accounts.find((entry) => entry.id === "moss")).toEqual(
      result.original.providers.codex.accounts[0],
    );
    expect(result.stored.providerInstances.codex_byok).toBeUndefined();
    expect(result.stored.keepAwakeMode).toBe("always");
    expect(
      result.stored.providers.codex.accounts.find((entry) => entry.id === "personal")?.label,
    ).toBe("Personal");
    expect(result.stored.providerInstances.ordinary?.displayName).toBe("Ordinary");
    expect(result.view.providerInstances.ordinary?.config).toMatchObject({
      serverPassword: "",
      serverPasswordRedacted: true,
    });
  });

  it("protects the latest server reservation when it changes before the client write acquires the transaction", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        yield* service.start;
        const home = join(config.stateDir, "moss-codex-home");
        const old = yield* service.updateSettings(reservation(home, true));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delayed: Pick<ServerSettingsShape, "updateSettings"> = {
          updateSettings: (patch, derivePatch) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* service.updateSettings(patch, derivePatch);
            }),
        };
        const client = yield* serverUpdateSettingsRpcEffect(delayed, {
          providerInstances: old.providerInstances,
          keepAwakeMode: "agent",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const current = yield* service.updateSettings(
          reservation(home, false, "b3333333-3333-4333-8333-333333333333"),
        );
        yield* Deferred.succeed(release, undefined);
        const view = yield* Fiber.join(client);
        return { current, view, stored: yield* service.getSettings };
      }),
    );
    expect(result.stored.providerInstances.codex_moss).toEqual(
      result.current.providerInstances.codex_moss,
    );
    expect(result.view.providerInstances.codex_moss).toEqual(
      result.current.providerInstances.codex_moss,
    );
    expect(result.stored.keepAwakeMode).toBe("agent");
  });

  it("rejects client creation of a reserved identity but preserves server-authorized provisioning", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        yield* service.start;
        const patch = reservation(join(config.stateDir, "moss-codex-home"), true);
        yield* serverUpdateSettingsRpcEffect(service, patch);
        const client: ServerSettings = yield* service.getSettings;
        const internal = yield* service.updateSettings(patch);
        return { client, internal };
      }),
    );
    expect(result.client.providerInstances.codex_moss).toBeUndefined();
    expect(result.client.providers.codex.accounts.some((entry) => entry.id === "moss")).toBe(false);
    expect(result.internal.providerInstances.codex_moss?.config).toMatchObject({
      managed: true,
      homeOwnershipNonce: nonce,
    });
  });
});
