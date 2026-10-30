import type {
  RealtimeVoiceAppendSpeechInput,
  RealtimeVoiceAppendTextInput,
  RealtimeVoiceClaimInput,
  RealtimeVoiceClaimResult,
  RealtimeVoiceCommandResult,
  RealtimeVoiceEvent,
  RealtimeVoiceListVoicesResult,
  RealtimeVoiceReleaseClaimInput,
  RealtimeVoiceReportClientStateInput,
  RealtimeVoiceResolveScreenContextInput,
  RealtimeVoiceStartInput,
  RealtimeVoiceStartResult,
  RealtimeVoiceState,
  RealtimeVoiceStopInput,
} from "@synara/contracts";
import type { Effect, Stream } from "effect";
import { ServiceMap } from "effect";

import type { RealtimeVoiceRuntimeError } from "../runtime";

export interface RealtimeVoiceServiceShape {
  readonly listVoices: () => Effect.Effect<RealtimeVoiceListVoicesResult>;
  readonly claim: (
    input: RealtimeVoiceClaimInput,
  ) => Effect.Effect<RealtimeVoiceClaimResult, RealtimeVoiceRuntimeError>;
  readonly releaseClaim: (
    input: RealtimeVoiceReleaseClaimInput,
  ) => Effect.Effect<RealtimeVoiceCommandResult, RealtimeVoiceRuntimeError>;
  readonly start: (
    input: RealtimeVoiceStartInput,
  ) => Effect.Effect<RealtimeVoiceStartResult, RealtimeVoiceRuntimeError>;
  readonly reportClientState: (
    input: RealtimeVoiceReportClientStateInput,
  ) => Effect.Effect<RealtimeVoiceState, RealtimeVoiceRuntimeError>;
  readonly resolveScreenContext: (
    input: RealtimeVoiceResolveScreenContextInput,
  ) => Effect.Effect<RealtimeVoiceCommandResult, RealtimeVoiceRuntimeError>;
  readonly appendText: (
    input: RealtimeVoiceAppendTextInput,
  ) => Effect.Effect<RealtimeVoiceCommandResult, RealtimeVoiceRuntimeError>;
  readonly appendSpeech: (
    input: RealtimeVoiceAppendSpeechInput,
  ) => Effect.Effect<RealtimeVoiceCommandResult, RealtimeVoiceRuntimeError>;
  readonly stop: (
    input: RealtimeVoiceStopInput,
  ) => Effect.Effect<RealtimeVoiceCommandResult, RealtimeVoiceRuntimeError>;
  readonly getState: Effect.Effect<RealtimeVoiceState>;
  readonly events: Stream.Stream<RealtimeVoiceEvent>;
}

export class RealtimeVoiceService extends ServiceMap.Service<
  RealtimeVoiceService,
  RealtimeVoiceServiceShape
>()("moss/realtimeVoice/Services/RealtimeVoiceService") {}
