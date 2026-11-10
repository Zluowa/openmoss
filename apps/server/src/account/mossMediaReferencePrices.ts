// Reference media costs for the skill text, copied from the reviewed gateway
// cost cards (supabase/functions/moss-model-gateway/canvasMediaCostCards.ts:
// REVIEWED_CANVAS_MEDIA_COSTS_20261029 and REVIEWED_SEEDREAM_COST_20261011).
// The gateway module cannot be compiled into the desktop server, so the rows
// are copied here; mossMediaReferencePrices.test.ts in that folder fails when
// they drift. Billing never reads this file.

export interface MossMediaReferenceCost {
  readonly modelId: string;
  readonly currency: "USD" | "CNY";
  readonly kind: "image" | "video_second" | "tokens" | "completion_tokens";
  /** Nano-units of the currency, keyed by tier as on the gateway card. */
  readonly rates: Readonly<Record<string, number>>;
  readonly reservationNano: number;
}

export const MOSS_MEDIA_REFERENCE_COSTS: readonly MossMediaReferenceCost[] = [
  {
    modelId: "nano-banana-pro",
    currency: "USD",
    kind: "image",
    rates: { "1K": 134_000_000, "2K": 134_000_000, "4K": 240_000_000, inputImage: 2_000_000 },
    reservationNano: 350_000_000,
  },
  {
    modelId: "gemini-flash-image",
    currency: "USD",
    kind: "image",
    rates: { "1K": 67_000_000, "2K": 101_000_000, "4K": 151_000_000, inputImage: 1_000_000 },
    reservationNano: 250_000_000,
  },
  {
    modelId: "gpt-image-2.5-flare",
    currency: "USD",
    kind: "tokens",
    rates: { inputText: 5000, inputImage: 8000, output: 30_000 },
    reservationNano: 1_000_000_000,
  },
  {
    modelId: "gpt-image-2.5-sunburst",
    currency: "USD",
    kind: "tokens",
    rates: { inputText: 5000, inputImage: 8000, output: 30_000 },
    reservationNano: 1_000_000_000,
  },
  {
    modelId: "grok-imagine-image-2.0",
    currency: "USD",
    kind: "image",
    rates: { "1K": 75_000_000, "2K": 100_000_000, inputImage: 12_500_000 },
    reservationNano: 200_000_000,
  },
  {
    modelId: "wan2.7-image-pro",
    currency: "USD",
    kind: "image",
    rates: { "1K": 85_000_000, "2K": 85_000_000, "4K": 150_000_000, inputImage: 0 },
    reservationNano: 200_000_000,
  },
  {
    modelId: "kling-v3-omni",
    currency: "USD",
    kind: "video_second",
    rates: {
      "720P:silent": 126_000_000,
      "720P:audio": 168_000_000,
      "1080P:silent": 168_000_000,
      "1080P:audio": 224_000_000,
      "4K:silent": 535_700_000,
      "4K:audio": 700_000_000,
    },
    reservationNano: 12_000_000_000,
  },
  {
    modelId: "wan3.0-video",
    currency: "CNY",
    kind: "video_second",
    rates: { "480P": 300_000_000, "720P": 600_000_000, "1080P": 1_200_000_000 },
    reservationNano: 40_000_000_000,
  },
  {
    modelId: "wan3.0-video-prime",
    currency: "CNY",
    kind: "video_second",
    rates: { "480P": 450_000_000, "720P": 900_000_000, "1080P": 1_800_000_000 },
    reservationNano: 60_000_000_000,
  },
  {
    modelId: "happyhorse",
    currency: "CNY",
    kind: "video_second",
    rates: { "480P": 450_000_000, "720P": 900_000_000, "1080P": 1_200_000_000 },
    reservationNano: 40_000_000_000,
  },
  {
    modelId: "happyhorse-video-edit",
    currency: "CNY",
    kind: "video_second",
    rates: { "720P": 900_000_000, "1080P": 1_600_000_000 },
    reservationNano: 125_000_000_000,
  },
  {
    modelId: "MiniMax-H3",
    currency: "CNY",
    kind: "video_second",
    rates: {
      "768P": 500_000_000,
      "2K": 800_000_000,
      "768P:inputVideo": 500_000_000,
      "2K:inputVideo": 800_000_000,
      freeInputImages: 5,
      inputImage: 200_000_000,
    },
    reservationNano: 30_000_000_000,
  },
  {
    modelId: "MiniMax-H3-Max",
    currency: "CNY",
    kind: "video_second",
    rates: {
      "480P": 330_000_000,
      "768P": 500_000_000,
      "480P:inputVideo": 370_000_000,
      "768P:inputVideo": 970_000_000,
      freeInputImages: 2,
      inputImage: 500_000_000,
    },
    reservationNano: 25_000_000_000,
  },
  {
    modelId: "doubao-seedance-2.0",
    currency: "CNY",
    kind: "completion_tokens",
    rates: {
      "480P": 46_000,
      "720P": 46_000,
      "1080P": 46_000,
      "4K": 46_000,
      "480P:videoInput": 28_000,
      "720P:videoInput": 28_000,
      "1080P:videoInput": 28_000,
      "4K:videoInput": 28_000,
    },
    reservationNano: 175_000_000_000,
  },
  {
    modelId: "doubao-seedance-2.0-fast",
    currency: "CNY",
    kind: "completion_tokens",
    rates: { "480P": 46_000, "720P": 46_000, "480P:videoInput": 28_000, "720P:videoInput": 28_000 },
    reservationNano: 20_000_000_000,
  },
  {
    modelId: "doubao-seedance-2.5",
    currency: "CNY",
    kind: "completion_tokens",
    rates: {
      "480P": 70_000,
      "720P": 70_000,
      "1080P": 77_000,
      "480P:videoInput": 42_000,
      "720P:videoInput": 42_000,
      "1080P:videoInput": 46_000,
    },
    reservationNano: 120_000_000_000,
  },
  {
    modelId: "seedream-5-0",
    currency: "USD",
    kind: "image",
    rates: {
      "1K": 36_600_000,
      "1.5K": 36_600_000,
      "2K": 73_200_000,
      inputImage: 2_440_000,
      freeInputImages: 1,
    },
    reservationNano: 110_000_000,
  },
];
