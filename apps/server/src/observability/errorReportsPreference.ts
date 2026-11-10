// FILE: errorReportsPreference.ts
// Purpose: Applies the user's error-report setting to the server's Sentry gate, including live changes.
// Layer: Server runtime observability
// Depends on: ServerSettingsService.

import { Effect, Layer, Stream } from "effect";

import { ServerSettingsService } from "../serverSettings";
import { setServerErrorReportsEnabled } from "./sentry";

export const ErrorReportsPreferenceLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    setServerErrorReportsEnabled(settings.errorReportsEnabled);
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((next) =>
        Effect.sync(() => setServerErrorReportsEnabled(next.errorReportsEnabled)),
      ),
      Effect.forkScoped,
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("error report preference could not be read", {
        detail: error.detail,
      }),
    ),
  ),
);
