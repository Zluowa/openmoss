import { Effect, FileSystem, Layer, Path, Semaphore } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite";
import { ServerConfig } from "../../config";
import { getOrCreateSecretFile } from "../secretFileCreation";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore";

const secretFileName = (name: string): string => `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.bin`;

export const makeServerSecretStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreError({
          message: `Failed to create secrets directory ${serverConfig.secretsDir}.`,
          cause,
        }),
    ),
  );
  if (process.platform !== "win32") {
    yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to secure secrets directory ${serverConfig.secretsDir}.`,
            cause,
          }),
      ),
    );
  }

  // Callers asking for the same secret at once share one creation (see secretFileCreation.ts for
  // creators in other store instances or processes).
  const creationLocks = yield* Semaphore.makePartitioned<string>({ permits: 1 });

  const resolveSecretPath = (name: string) =>
    path.join(serverConfig.secretsDir, secretFileName(name));

  const get: ServerSecretStoreShape["get"] = (name) =>
    Effect.gen(function* () {
      const secretPath = resolveSecretPath(name);
      const exists = yield* fileSystem.exists(secretPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return null;
      return yield* fileSystem
        .readFile(secretPath)
        .pipe(Effect.map((bytes) => Uint8Array.from(bytes)));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to read secret ${name}.`,
            cause,
          }),
      ),
    );

  const set: ServerSecretStoreShape["set"] = (name, value) =>
    writeFileStringAtomically({
      filePath: resolveSecretPath(name),
      contents: value,
      mode: 0o600,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to persist secret ${name}.`,
            cause,
          }),
      ),
    );

  const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
    creationLocks.withPermits(
      name,
      1,
    )(
      Effect.tryPromise({
        try: () => getOrCreateSecretFile(resolveSecretPath(name), bytes),
        catch: (cause) =>
          new SecretStoreError({
            message: `Failed to create secret ${name}.`,
            cause,
          }),
      }),
    );

  const remove: ServerSecretStoreShape["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name), { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to remove secret ${name}.`,
            cause,
          }),
      ),
    );

  return { get, set, getOrCreateRandom, remove } satisfies ServerSecretStoreShape;
});

export const ServerSecretStoreLive = Layer.effect(ServerSecretStore, makeServerSecretStore);
