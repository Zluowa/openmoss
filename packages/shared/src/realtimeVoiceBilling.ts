// FILE: realtimeVoiceBilling.ts
// Purpose: Parse trusted Realtime response usage and calculate deterministic billing units.

export interface RealtimeVoiceRateCard {
  readonly id: string;
  readonly model: string;
  readonly inputTextNanoUsdPerToken: number;
  readonly inputCachedTextNanoUsdPerToken: number;
  readonly inputAudioNanoUsdPerToken: number;
  readonly inputCachedAudioNanoUsdPerToken: number;
  readonly inputImageNanoUsdPerToken: number;
  readonly inputCachedImageNanoUsdPerToken: number;
  readonly outputTextNanoUsdPerToken: number;
  readonly outputAudioNanoUsdPerToken: number;
}

export interface RealtimeVoiceTokenUsage {
  readonly inputTextTokens: number;
  readonly inputCachedTextTokens: number;
  readonly inputAudioTokens: number;
  readonly inputCachedAudioTokens: number;
  readonly inputImageTokens: number;
  readonly inputCachedImageTokens: number;
  readonly outputTextTokens: number;
  readonly outputAudioTokens: number;
}

export interface PricedRealtimeVoiceUsage extends RealtimeVoiceTokenUsage {
  readonly costNanoUsd: number;
}

/** Cumulative duration reported by GPT-Live usage.updated/closed events. */
export interface GptLiveUsageSnapshot {
  readonly totalSeconds: number;
}

export interface GptLiveRateCard {
  readonly id: string;
  readonly model: "gpt-live-1";
  /** Price is held in nano-USD per minute; duration is never treated as tokens. */
  readonly nanoUsdPerMinute: number;
}

// Prices captured from the official model catalog on 2026-07-26. One nano-USD
// makes every published per-million-token price an integer per token.
export const GPT_REALTIME_2_1_RATE_CARD = {
  id: "openai-gpt-realtime-2.1-2026-07-26",
  model: "gpt-realtime-2.1",
  inputTextNanoUsdPerToken: 4_000,
  inputCachedTextNanoUsdPerToken: 400,
  inputAudioNanoUsdPerToken: 32_000,
  inputCachedAudioNanoUsdPerToken: 400,
  inputImageNanoUsdPerToken: 5_000,
  inputCachedImageNanoUsdPerToken: 500,
  outputTextNanoUsdPerToken: 24_000,
  outputAudioNanoUsdPerToken: 64_000,
} as const satisfies RealtimeVoiceRateCard;

export const GPT_REALTIME_2_1_MINI_RATE_CARD = {
  id: "openai-gpt-realtime-2.1-mini-2026-07-26",
  model: "gpt-realtime-2.1-mini",
  inputTextNanoUsdPerToken: 600,
  inputCachedTextNanoUsdPerToken: 60,
  inputAudioNanoUsdPerToken: 10_000,
  inputCachedAudioNanoUsdPerToken: 300,
  inputImageNanoUsdPerToken: 800,
  inputCachedImageNanoUsdPerToken: 80,
  outputTextNanoUsdPerToken: 2_400,
  outputAudioNanoUsdPerToken: 20_000,
} as const satisfies RealtimeVoiceRateCard;

export const GPT_4O_MINI_TRANSCRIBE_RATE_CARD = {
  id: "openai-gpt-4o-mini-transcribe-2026-07-26",
  model: "gpt-4o-mini-transcribe",
  inputTextNanoUsdPerToken: 1_250,
  inputCachedTextNanoUsdPerToken: 0,
  inputAudioNanoUsdPerToken: 1_250,
  inputCachedAudioNanoUsdPerToken: 0,
  inputImageNanoUsdPerToken: 0,
  inputCachedImageNanoUsdPerToken: 0,
  outputTextNanoUsdPerToken: 5_000,
  outputAudioNanoUsdPerToken: 0,
} as const satisfies RealtimeVoiceRateCard;

export const GPT_LIVE_1_RATE_CARD = {
  id: "openai-gpt-live-1-2026-09-11",
  model: "gpt-live-1",
  nanoUsdPerMinute: 50_000_000,
} as const satisfies GptLiveRateCard;

export const REALTIME_VOICE_RATE_CARDS = [
  GPT_REALTIME_2_1_RATE_CARD,
  GPT_REALTIME_2_1_MINI_RATE_CARD,
  GPT_4O_MINI_TRANSCRIBE_RATE_CARD,
] as const;

export const GPT_LIVE_RATE_CARDS = [GPT_LIVE_1_RATE_CARD] as const;

export function findGptLiveRateCard(
  model: string,
  cards: readonly GptLiveRateCard[] = GPT_LIVE_RATE_CARDS,
): GptLiveRateCard | null {
  return cards.find((card) => card.model === model) ?? null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function asRequiredTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function asDurationSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value > 1_000_000_000) return null;
  return value;
}

/**
 * Reads a cumulative duration snapshot from a trusted GPT-Live event. Both
 * usage.updated and closed carry the same cumulative usage.seconds shape.
 */
export function parseGptLiveUsageSeconds(event: unknown): GptLiveUsageSnapshot | null {
  const root = asRecord(event);
  if (
    !root ||
    (root.type !== "usage.updated" &&
      root.type !== "session.usage.updated" &&
      root.type !== "closed")
  )
    return null;
  const usage = asRecord(root.usage);
  const seconds = asDurationSeconds(usage?.seconds);
  return seconds === null ? null : { totalSeconds: seconds };
}

/** Charges the cumulative duration delta at $0.05/minute with integer rounding. */
export function priceGptLiveUsageSeconds(
  totalSeconds: number,
  rateCard: GptLiveRateCard = GPT_LIVE_1_RATE_CARD,
): number {
  const seconds = asDurationSeconds(totalSeconds);
  if (seconds === null) throw new RangeError("Invalid GPT-Live usage duration.");
  // Ceil to the nearest nano-USD so every non-zero duration is billable and
  // repeated snapshots remain deterministic across runtimes.
  const micros = BigInt(Math.round(seconds * 1_000_000));
  const cost = (micros * BigInt(rateCard.nanoUsdPerMinute) + 60_000_000n - 1n) / 60_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("GPT-Live duration cost exceeds the safe integer range.");
  }
  return Number(cost);
}

function uncached(total: number, cached: number): number {
  return Math.max(0, total - Math.min(total, cached));
}

export function findRealtimeVoiceRateCard(
  model: string,
  cards: readonly RealtimeVoiceRateCard[] = REALTIME_VOICE_RATE_CARDS,
): RealtimeVoiceRateCard | null {
  return cards.find((card) => card.model === model) ?? null;
}

/**
 * Reads the usage object from a trusted OpenAI `response.done` event. Input
 * modality totals include cached tokens, so the returned non-cached counters
 * subtract their corresponding cached detail before pricing.
 */
export function parseRealtimeVoiceResponseUsage(event: unknown): RealtimeVoiceTokenUsage | null {
  const root = asRecord(event);
  if (!root || root.type !== "response.done") return null;
  const response = asRecord(root.response);
  const usage = asRecord(response?.usage);
  if (!response || !usage) return null;

  const input = asRecord(usage.input_token_details);
  const cached = asRecord(input?.cached_tokens_details);
  const output = asRecord(usage.output_token_details);

  const totalTokens = asRequiredTokenCount(usage.total_tokens);
  const inputTokens = asRequiredTokenCount(usage.input_tokens);
  const outputTokens = asRequiredTokenCount(usage.output_tokens);
  const inputTextTotal = asRequiredTokenCount(input?.text_tokens);
  const inputAudioTotal = asRequiredTokenCount(input?.audio_tokens);
  const inputImageTotal = asRequiredTokenCount(input?.image_tokens);
  const cachedTotal = asRequiredTokenCount(input?.cached_tokens);
  const cachedText = asRequiredTokenCount(cached?.text_tokens);
  const cachedAudio = asRequiredTokenCount(cached?.audio_tokens);
  const cachedImage = asRequiredTokenCount(cached?.image_tokens);
  const outputText = asRequiredTokenCount(output?.text_tokens);
  const outputAudio = asRequiredTokenCount(output?.audio_tokens);
  if (
    totalTokens === null ||
    inputTokens === null ||
    outputTokens === null ||
    inputTextTotal === null ||
    inputAudioTotal === null ||
    inputImageTotal === null ||
    cachedTotal === null ||
    cachedText === null ||
    cachedAudio === null ||
    cachedImage === null ||
    outputText === null ||
    outputAudio === null ||
    totalTokens !== inputTokens + outputTokens ||
    inputTokens !== inputTextTotal + inputAudioTotal + inputImageTotal ||
    outputTokens !== outputText + outputAudio ||
    cachedTotal !== cachedText + cachedAudio + cachedImage ||
    cachedTotal > inputTokens ||
    cachedText > inputTextTotal ||
    cachedAudio > inputAudioTotal ||
    cachedImage > inputImageTotal
  ) {
    return null;
  }

  return {
    inputTextTokens: uncached(inputTextTotal, cachedText),
    inputCachedTextTokens: cachedText,
    inputAudioTokens: uncached(inputAudioTotal, cachedAudio),
    inputCachedAudioTokens: cachedAudio,
    inputImageTokens: uncached(inputImageTotal, cachedImage),
    inputCachedImageTokens: cachedImage,
    outputTextTokens: outputText,
    outputAudioTokens: outputAudio,
  };
}

/** Reads separately billed ASR usage from a completed conversation transcript event. */
export function parseRealtimeVoiceTranscriptionUsage(
  event: unknown,
): RealtimeVoiceTokenUsage | null {
  const root = asRecord(event);
  if (!root || root.type !== "conversation.item.input_audio_transcription.completed") return null;
  const usage = asRecord(root.usage);
  if (!usage || usage.type !== "tokens") return null;
  const inputDetails = asRecord(usage.input_token_details);
  const totalTokens = asRequiredTokenCount(usage.total_tokens);
  const inputTokens = asRequiredTokenCount(usage.input_tokens);
  const inputTextTokens = asRequiredTokenCount(inputDetails?.text_tokens);
  const detailedAudioTokens = asRequiredTokenCount(inputDetails?.audio_tokens);
  const outputTextTokens = asRequiredTokenCount(usage.output_tokens);
  if (
    totalTokens === null ||
    inputTokens === null ||
    inputTextTokens === null ||
    detailedAudioTokens === null ||
    outputTextTokens === null ||
    inputTextTokens > inputTokens ||
    detailedAudioTokens > inputTokens ||
    detailedAudioTokens > inputTokens - inputTextTokens ||
    totalTokens !== inputTokens + outputTextTokens
  ) {
    return null;
  }
  // Price any unclassified input as audio so a provider schema extension can
  // never silently undercharge the separate transcription request. The
  // detailed audio count is an integrity bound, not an additional billable
  // bucket, so every input token is priced exactly once.
  const inputAudioTokens = inputTokens - inputTextTokens;
  return {
    inputTextTokens,
    inputCachedTextTokens: 0,
    inputAudioTokens,
    inputCachedAudioTokens: 0,
    inputImageTokens: 0,
    inputCachedImageTokens: 0,
    outputTextTokens,
    outputAudioTokens: 0,
  };
}

export function priceRealtimeVoiceUsage(
  usage: RealtimeVoiceTokenUsage,
  rateCard: RealtimeVoiceRateCard,
): PricedRealtimeVoiceUsage {
  const cost =
    BigInt(usage.inputTextTokens) * BigInt(rateCard.inputTextNanoUsdPerToken) +
    BigInt(usage.inputCachedTextTokens) * BigInt(rateCard.inputCachedTextNanoUsdPerToken) +
    BigInt(usage.inputAudioTokens) * BigInt(rateCard.inputAudioNanoUsdPerToken) +
    BigInt(usage.inputCachedAudioTokens) * BigInt(rateCard.inputCachedAudioNanoUsdPerToken) +
    BigInt(usage.inputImageTokens) * BigInt(rateCard.inputImageNanoUsdPerToken) +
    BigInt(usage.inputCachedImageTokens) * BigInt(rateCard.inputCachedImageNanoUsdPerToken) +
    BigInt(usage.outputTextTokens) * BigInt(rateCard.outputTextNanoUsdPerToken) +
    BigInt(usage.outputAudioTokens) * BigInt(rateCard.outputAudioNanoUsdPerToken);

  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Realtime voice cost exceeds the safe integer range.");
  }

  return { ...usage, costNanoUsd: Number(cost) };
}

export function priceRealtimeVoiceResponse(
  event: unknown,
  rateCard: RealtimeVoiceRateCard,
): PricedRealtimeVoiceUsage | null {
  const usage = parseRealtimeVoiceResponseUsage(event);
  return usage ? priceRealtimeVoiceUsage(usage, rateCard) : null;
}

export function realtimeVoiceTurnHoldNanoUsd(input: {
  readonly rateCard: RealtimeVoiceRateCard;
  readonly maxInputTextTokens: number;
  readonly maxInputAudioTokens: number;
  readonly maxInputImageTokens: number;
  readonly maxOutputTextTokens: number;
  readonly maxOutputAudioTokens: number;
}): number {
  return priceRealtimeVoiceUsage(
    {
      inputTextTokens: Math.max(0, Math.trunc(input.maxInputTextTokens)),
      inputCachedTextTokens: 0,
      inputAudioTokens: Math.max(0, Math.trunc(input.maxInputAudioTokens)),
      inputCachedAudioTokens: 0,
      inputImageTokens: Math.max(0, Math.trunc(input.maxInputImageTokens)),
      inputCachedImageTokens: 0,
      outputTextTokens: Math.max(0, Math.trunc(input.maxOutputTextTokens)),
      outputAudioTokens: Math.max(0, Math.trunc(input.maxOutputAudioTokens)),
    },
    input.rateCard,
  ).costNanoUsd;
}
