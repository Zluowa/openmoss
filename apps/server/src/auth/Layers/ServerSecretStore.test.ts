import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerSecretStore, type SecretStoreError } from "../Services/ServerSecretStore";
import { ServerSecretStoreLive } from "./ServerSecretStore";

const makeConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), {
    prefix: "moss-secret-store-test-",
  });

const makeLayer = () =>
  ServerSecretStoreLive.pipe(Layer.provide(makeConfigLayer()), Layer.provide(NodeServices.layer));

const runWithSecretStore = (effect: Effect.Effect<void, SecretStoreError, ServerSecretStore>) =>
  effect.pipe(Effect.provide(makeLayer()), Effect.scoped, Effect.runPromise);

describe("ServerSecretStoreLive", () => {
  it("persists and reads named secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("session-signing", new Uint8Array([1, 2, 3]));

        expect(Array.from((yield* store.get("session-signing")) ?? [])).toEqual([1, 2, 3]);
      }),
    );
  });

  it("reuses generated random secrets", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        const first = yield* store.getOrCreateRandom("websocket", 32);
        const second = yield* store.getOrCreateRandom("websocket", 32);

        expect(first.byteLength).toBe(32);
        expect(Array.from(second)).toEqual(Array.from(first));
      }),
    );
  });

  it("hands one key to every caller that creates the same secret at once", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        const keys = yield* Effect.all(
          Array.from({ length: 8 }, () => store.getOrCreateRandom("guest-share-signing-key", 32)),
          { concurrency: "unbounded" },
        );
        const first = Array.from(keys[0]!);
        for (const key of keys) expect(Array.from(key)).toEqual(first);
        expect(Array.from((yield* store.get("guest-share-signing-key")) ?? [])).toEqual(first);
      }),
    );
  });

  it("agrees on one key across two store instances over the same folder", async () => {
    const config = makeConfigLayer().pipe(Layer.provideMerge(NodeServices.layer));
    const storeOver = () => Layer.fresh(ServerSecretStoreLive);
    const createIn = (layer: ReturnType<typeof storeOver>) =>
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        return yield* store.getOrCreateRandom("shared-key", 32);
      }).pipe(Effect.provide(layer), Effect.scoped);
    const [left, right] = await Effect.runPromise(
      Effect.all([createIn(storeOver()), createIn(storeOver())], { concurrency: "unbounded" }).pipe(
        Effect.provide(config),
        Effect.scoped,
      ),
    );
    expect(Array.from(left)).toEqual(Array.from(right));
  });

  it("removes secrets idempotently", async () => {
    await runWithSecretStore(
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("remove-me", new Uint8Array([9]));
        yield* store.remove("remove-me");
        yield* store.remove("remove-me");

        expect(yield* store.get("remove-me")).toBeNull();
      }),
    );
  });
});
