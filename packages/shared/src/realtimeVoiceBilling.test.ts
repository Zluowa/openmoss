import { describe, expect, it } from "vitest";

import {
  findRealtimeVoiceRateCard,
  findGptLiveRateCard,
  GPT_4O_MINI_TRANSCRIBE_RATE_CARD,
  GPT_LIVE_1_RATE_CARD,
  GPT_REALTIME_2_1_RATE_CARD,
  parseRealtimeVoiceResponseUsage,
  parseRealtimeVoiceTranscriptionUsage,
  parseGptLiveUsageSeconds,
  priceRealtimeVoiceUsage,
  priceRealtimeVoiceResponse,
  priceGptLiveUsageSeconds,
  realtimeVoiceTurnHoldNanoUsd,
} from "./realtimeVoiceBilling";

const responseDone = {
  type: "response.done",
  response: {
    id: "resp-1",
    usage: {
      total_tokens: 253,
      input_tokens: 132,
      output_tokens: 121,
      input_token_details: {
        text_tokens: 119,
        audio_tokens: 13,
        image_tokens: 0,
        cached_tokens: 64,
        cached_tokens_details: {
          text_tokens: 64,
          audio_tokens: 0,
          image_tokens: 0,
        },
      },
      output_token_details: {
        text_tokens: 30,
        audio_tokens: 91,
      },
    },
  },
};

const transcriptionCompleted = {
  type: "conversation.item.input_audio_transcription.completed",
  event_id: "event-asr-1",
  item_id: "item-1",
  content_index: 0,
  transcript: "Can you inspect the screen?",
  usage: {
    type: "tokens",
    total_tokens: 22,
    input_tokens: 13,
    input_token_details: { text_tokens: 0, audio_tokens: 13 },
    output_tokens: 9,
  },
};

function transcriptionEventWithUsage(
  usage: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { ...transcriptionCompleted, usage };
}

describe("Realtime Voice billing", () => {
  it("separates cached and uncached modality totals", () => {
    expect(parseRealtimeVoiceResponseUsage(responseDone)).toEqual({
      inputTextTokens: 55,
      inputCachedTextTokens: 64,
      inputAudioTokens: 13,
      inputCachedAudioTokens: 0,
      inputImageTokens: 0,
      inputCachedImageTokens: 0,
      outputTextTokens: 30,
      outputAudioTokens: 91,
    });
  });

  it("accepts cached-token counts at their modality and total-input boundaries", () => {
    expect(
      parseRealtimeVoiceResponseUsage({
        ...responseDone,
        response: {
          ...responseDone.response,
          usage: {
            ...responseDone.response.usage,
            input_token_details: {
              ...responseDone.response.usage.input_token_details,
              cached_tokens: 132,
              cached_tokens_details: {
                text_tokens: 119,
                audio_tokens: 13,
                image_tokens: 0,
              },
            },
          },
        },
      }),
    ).toMatchObject({
      inputTextTokens: 0,
      inputCachedTextTokens: 119,
      inputAudioTokens: 0,
      inputCachedAudioTokens: 13,
      inputImageTokens: 0,
      inputCachedImageTokens: 0,
    });
  });

  it("rejects cached-token counts above their modality or total-input bounds", () => {
    for (const cachedDetails of [
      { cached_tokens: 120, text_tokens: 120, audio_tokens: 0, image_tokens: 0 },
      { cached_tokens: 14, text_tokens: 0, audio_tokens: 14, image_tokens: 0 },
      { cached_tokens: 1, text_tokens: 0, audio_tokens: 0, image_tokens: 1 },
      { cached_tokens: 133, text_tokens: 119, audio_tokens: 13, image_tokens: 1 },
    ]) {
      expect(
        parseRealtimeVoiceResponseUsage({
          ...responseDone,
          response: {
            ...responseDone.response,
            usage: {
              ...responseDone.response.usage,
              input_token_details: {
                ...responseDone.response.usage.input_token_details,
                cached_tokens: cachedDetails.cached_tokens,
                cached_tokens_details: {
                  text_tokens: cachedDetails.text_tokens,
                  audio_tokens: cachedDetails.audio_tokens,
                  image_tokens: cachedDetails.image_tokens,
                },
              },
            },
          },
        }),
      ).toBeNull();
    }
  });

  it("prices the official response.done example deterministically", () => {
    const priced = priceRealtimeVoiceResponse(responseDone, GPT_REALTIME_2_1_RATE_CARD);
    expect(priced?.costNanoUsd).toBe(7_205_600);
  });

  it("rejects non-response events and unknown models", () => {
    expect(parseRealtimeVoiceResponseUsage({ type: "response.created" })).toBeNull();
    expect(
      parseRealtimeVoiceResponseUsage({
        ...responseDone,
        response: {
          ...responseDone.response,
          usage: {
            ...responseDone.response.usage,
            input_token_details: {
              ...responseDone.response.usage.input_token_details,
              image_tokens: undefined,
            },
          },
        },
      }),
    ).toBeNull();
    expect(
      parseRealtimeVoiceResponseUsage({
        ...responseDone,
        response: {
          ...responseDone.response,
          usage: {
            ...responseDone.response.usage,
            input_token_details: {
              ...responseDone.response.usage.input_token_details,
              cached_tokens: 65,
            },
          },
        },
      }),
    ).toBeNull();
    expect(findRealtimeVoiceRateCard("gpt-live-1-codex")).toBeNull();
    expect(findGptLiveRateCard("gpt-live-1")?.nanoUsdPerMinute).toBe(50_000_000);
    expect(findGptLiveRateCard("gpt-realtime-2.1")).toBeNull();
  });

  it("parses cumulative GPT-Live duration snapshots without treating seconds as tokens", () => {
    expect(parseGptLiveUsageSeconds({ type: "usage.updated", usage: { seconds: 30 } })).toEqual({
      totalSeconds: 30,
    });
    expect(parseGptLiveUsageSeconds({ type: "closed", usage: { seconds: 60 } })).toEqual({
      totalSeconds: 60,
    });
    expect(parseGptLiveUsageSeconds({ type: "response.done", usage: { seconds: 60 } })).toBeNull();
    expect(parseGptLiveUsageSeconds({ type: "closed", usage: { seconds: -1 } })).toBeNull();
  });

  it("prices GPT-Live duration at five cents per minute with deterministic rounding", () => {
    expect(GPT_LIVE_1_RATE_CARD.model).toBe("gpt-live-1");
    expect(priceGptLiveUsageSeconds(0)).toBe(0);
    expect(priceGptLiveUsageSeconds(30)).toBe(25_000_000);
    expect(priceGptLiveUsageSeconds(60)).toBe(50_000_000);
    expect(priceGptLiveUsageSeconds(60.000001)).toBe(50_000_001);
  });

  it("computes a conservative turn hold from server-owned ceilings", () => {
    expect(
      realtimeVoiceTurnHoldNanoUsd({
        rateCard: GPT_REALTIME_2_1_RATE_CARD,
        maxInputTextTokens: 8_000,
        maxInputAudioTokens: 0,
        maxInputImageTokens: 0,
        maxOutputTextTokens: 0,
        maxOutputAudioTokens: 1_024,
      }),
    ).toBe(97_536_000);
  });

  it("parses and prices the separately billed conversation transcription usage", () => {
    const usage = parseRealtimeVoiceTranscriptionUsage(transcriptionCompleted);
    expect(usage).toEqual({
      inputTextTokens: 0,
      inputCachedTextTokens: 0,
      inputAudioTokens: 13,
      inputCachedAudioTokens: 0,
      inputImageTokens: 0,
      inputCachedImageTokens: 0,
      outputTextTokens: 9,
      outputAudioTokens: 0,
    });
    expect(
      usage && priceRealtimeVoiceUsage(usage, GPT_4O_MINI_TRANSCRIBE_RATE_CARD).costNanoUsd,
    ).toBe(61_250);
  });

  it("prices unknown transcription input categories as audio without double counting", () => {
    expect(
      parseRealtimeVoiceTranscriptionUsage(
        transcriptionEventWithUsage({
          type: "tokens",
          total_tokens: 22,
          input_tokens: 13,
          input_token_details: { text_tokens: 2, audio_tokens: 7 },
          output_tokens: 9,
        }),
      ),
    ).toMatchObject({
      inputTextTokens: 2,
      inputAudioTokens: 11,
      outputTextTokens: 9,
    });
  });

  it("accepts exact transcription modality boundaries", () => {
    for (const input of [
      { input: 13, text: 4, audio: 9, output: 9, expectedAudio: 9 },
      { input: 13, text: 13, audio: 0, output: 9, expectedAudio: 0 },
      { input: 0, text: 0, audio: 0, output: 0, expectedAudio: 0 },
    ]) {
      expect(
        parseRealtimeVoiceTranscriptionUsage(
          transcriptionEventWithUsage({
            type: "tokens",
            total_tokens: input.input + input.output,
            input_tokens: input.input,
            input_token_details: { text_tokens: input.text, audio_tokens: input.audio },
            output_tokens: input.output,
          }),
        ),
      ).toMatchObject({
        inputTextTokens: input.text,
        inputAudioTokens: input.expectedAudio,
        outputTextTokens: input.output,
      });
    }
  });

  it("rejects overlapping or malformed transcription token usage", () => {
    for (const usage of [
      {
        type: "tokens",
        total_tokens: 22,
        input_tokens: 13,
        input_token_details: { text_tokens: 7, audio_tokens: 7 },
        output_tokens: 9,
      },
      {
        type: "tokens",
        total_tokens: 22,
        input_tokens: 13,
        input_token_details: { text_tokens: -1, audio_tokens: 13 },
        output_tokens: 9,
      },
      {
        type: "tokens",
        total_tokens: 22,
        input_tokens: 13,
        input_token_details: { text_tokens: 0, audio_tokens: 12.5 },
        output_tokens: 9,
      },
      {
        type: "tokens",
        total_tokens: 21,
        input_tokens: 13,
        input_token_details: { text_tokens: 0, audio_tokens: 13 },
        output_tokens: 9,
      },
      {
        type: "tokens",
        total_tokens: 22,
        input_tokens: 13,
        input_token_details: { text_tokens: 0 },
        output_tokens: 9,
      },
      {
        type: "seconds",
        total_tokens: 22,
        input_tokens: 13,
        input_token_details: { text_tokens: 0, audio_tokens: 13 },
        output_tokens: 9,
      },
    ]) {
      expect(parseRealtimeVoiceTranscriptionUsage(transcriptionEventWithUsage(usage))).toBeNull();
    }
  });
});
