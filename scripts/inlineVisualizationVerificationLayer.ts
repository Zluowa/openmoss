// Purpose: Isolated visual-check account stubs. This file is never included by the product CLI.

import { Effect, Layer, Stream } from "effect";

import { MossPhoneAccountService } from "../apps/server/src/account/Services/MossPhoneAccountService.ts";
import { MossCloudAccountService } from "../apps/server/src/account/Services/MossCloudAccountService.ts";
import { MossByokProvider } from "../apps/server/src/account/Services/MossByokProvider.ts";
import { MossManagedProvider } from "../apps/server/src/account/Services/MossManagedProvider.ts";
import { MossPayService } from "../apps/server/src/account/Services/MossPayService.ts";
import { MossAccountServiceError } from "../apps/server/src/account/mossAccountErrors.ts";
import { MossCloudAccountServiceError } from "../apps/server/src/account/mossCloudAccountErrors.ts";
import { RealtimeVoiceService } from "../apps/server/src/realtimeVoice/Services/RealtimeVoiceService.ts";

const unavailable = () =>
  Effect.fail(
    new MossAccountServiceError({
      code: "authentication_required",
      message: "The inline visualization visual-check harness does not configure Moss accounts.",
    }),
  );

const cloudUnavailable = () =>
  Effect.fail(
    new MossCloudAccountServiceError({
      code: "authentication_required",
      message: "Visual check only.",
    }),
  );

const unavailableService = () =>
  Effect.die("Inline visualization visual-check account service is disabled.");

export const inlineVisualizationVerificationAccountLayer = Layer.mergeAll(
  Layer.succeed(MossPhoneAccountService, {
    getSession: unavailable,
    restoreSession: () => Effect.void,
    getAccessToken: unavailable,
    getAuthorityCredential: unavailable,
    startPhoneLogin: unavailable,
    verifyPhoneLogin: unavailable,
    logout: unavailable,
  }),
  Layer.succeed(MossCloudAccountService, {
    restore: () => Effect.void,
    getState: cloudUnavailable,
    listAccounts: cloudUnavailable,
    selectAccount: cloudUnavailable,
    removeAccount: cloudUnavailable,
    signUp: cloudUnavailable,
    signIn: cloudUnavailable,
    startGoogleOAuth: cloudUnavailable,
    exchangeGoogleOAuthCode: cloudUnavailable,
    refresh: cloudUnavailable,
    requestPasswordReset: cloudUnavailable,
    exchangeCode: cloudUnavailable,
    updatePassword: cloudUnavailable,
    logout: cloudUnavailable,
    getAccessToken: cloudUnavailable,
    getAuthorityCredential: cloudUnavailable,
    getGatewayAccessToken: cloudUnavailable,
  }),
  Layer.succeed(MossByokProvider, {
    getState: unavailableService(),
    provision: unavailableService,
    use: unavailableService,
    remove: unavailableService,
  }),
  Layer.succeed(MossManagedProvider, {
    needsDisable: unavailableService,
    getProvisioningState: unavailableService,
    provision: unavailableService,
    disable: unavailableService,
  }),
  Layer.succeed(MossPayService, {
    getCatalog: unavailableService,
    getQuota: unavailableService,
    createOrder: unavailableService,
    getOrder: unavailableService,
  }),
  Layer.succeed(RealtimeVoiceService, {
    listVoices: () =>
      Effect.succeed({ defaultVoice: "arbor", preferredTransport: "webrtc", voices: [] }),
    claim: unavailableService,
    releaseClaim: unavailableService,
    start: unavailableService,
    reportClientState: unavailableService,
    resolveScreenContext: unavailableService,
    appendText: unavailableService,
    appendSpeech: unavailableService,
    stop: unavailableService,
    getState: unavailableService(),
    events: Stream.empty,
  }),
);
