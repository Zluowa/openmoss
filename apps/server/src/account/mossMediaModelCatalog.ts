// The image and video models Moss Canvas and the media tools can use, with the
// reference cost of each in Moss credits (积分). Costs are derived from the
// reviewed gateway cost cards (see mossMediaReferencePrices.ts); the gateway
// still bills the actual supplier cost of each job at that day's exchange rate.
import {
  MOSS_DEFAULT_IMAGE_MODEL_ID,
  MOSS_DEFAULT_VIDEO_MODEL_ID,
} from "@moss/shared/mossMediaPlugins";
import {
  MOSS_MEDIA_REFERENCE_COSTS,
  type MossMediaReferenceCost,
} from "./mossMediaReferencePrices";

export type MossMediaKind = "image" | "video";

export interface MossMediaModelSpec {
  readonly id: string;
  readonly kind: MossMediaKind;
  /** One factual line about what the model takes or makes. */
  readonly note: string;
}

/** Media credits: the gateway's media wallet counts 100 credits per CNY. */
export const MOSS_MEDIA_CREDITS_PER_CNY = 100;
/**
 * Reference USD→CNY rate for showing USD-priced models in credits. Billing
 * never uses it: the gateway converts each job at its current FX snapshot.
 */
export const MOSS_MEDIA_REFERENCE_USD_CNY = 7.1;

export { MOSS_DEFAULT_IMAGE_MODEL_ID, MOSS_DEFAULT_VIDEO_MODEL_ID };

/** Every model the gateway catalog offers, in the order Moss presents them. */
export const MOSS_MEDIA_MODELS: readonly MossMediaModelSpec[] = [
  {
    id: "gpt-image-2.5-flare",
    kind: "image",
    note: "默认生图模型。支持参考图编辑、蒙版局部修改和透明背景。",
  },
  {
    id: "gpt-image-2.5-sunburst",
    kind: "image",
    note: "GPT Image 2.5 的另一个版本，能力与 Flare 相同。",
  },
  {
    id: "seedream-5-0",
    kind: "image",
    note: "1K、1.5K、2K 输出，支持参考图。",
  },
  {
    id: "nano-banana-pro",
    kind: "image",
    note: "1K、2K、4K 输出，支持参考图。",
  },
  {
    id: "gemini-flash-image",
    kind: "image",
    note: "1K、2K、4K 输出，支持参考图，价格更低。",
  },
  {
    id: "grok-imagine-image-2.0",
    kind: "image",
    note: "1K、2K 输出，支持参考图。",
  },
  {
    id: "wan2.7-image-pro",
    kind: "image",
    note: "1K、2K、4K 输出，参考图不另收费。",
  },
  {
    id: "doubao-seedance-2.0-fast",
    kind: "video",
    note: "默认生视频模型。480P、720P，出片快。",
  },
  {
    id: "doubao-seedance-2.0",
    kind: "video",
    note: "480P 到 4K。",
  },
  {
    id: "doubao-seedance-2.5",
    kind: "video",
    note: "支持首尾帧，或最多 30 张参考图与参考视频、音频。",
  },
  {
    id: "wan3.0-video",
    kind: "video",
    note: "支持首尾帧，或最多 10 张参考图。",
  },
  {
    id: "wan3.0-video-prime",
    kind: "video",
    note: "万相 3.0 的高速版，参考方式相同。",
  },
  {
    id: "happyhorse",
    kind: "video",
    note: "支持首帧，或最多 9 张参考图。",
  },
  {
    id: "happyhorse-video-edit",
    kind: "video",
    note: "改写一段已有视频（MP4/MOV），可附最多 5 张参考图。",
  },
  {
    id: "kling-v3-omni",
    kind: "video",
    note: "720P、1080P、4K，可选有声。",
  },
  {
    id: "MiniMax-H3",
    kind: "video",
    note: "768P、2K，支持首尾帧或最多 9 张参考图。",
  },
  {
    id: "MiniMax-H3-Max",
    kind: "video",
    note: "480P、768P，支持首尾帧或最多 9 张参考图。",
  },
];

const MODEL_BY_ID = new Map(MOSS_MEDIA_MODELS.map((model) => [model.id, model]));

export function mossMediaModel(id: string): MossMediaModelSpec | undefined {
  return MODEL_BY_ID.get(id);
}

const REVIEWED_COSTS = new Map<string, MossMediaReferenceCost>(
  MOSS_MEDIA_REFERENCE_COSTS.map((cost) => [cost.modelId, cost]),
);

// Ark bills Seedance completion tokens = seconds × width × height × 24 / 1024.
// The largest frame of each tier, as the gateway holds it (mediaPricing.ts).
const SEEDANCE_TIER_PIXELS: Readonly<Record<string, number>> = {
  "480P": 864 * 480,
  "720P": 1280 * 720,
  "1080P": 1920 * 1088,
  "4K": 3840 * 2160,
};

function creditsFromNano(nano: number, currency: "USD" | "CNY"): number {
  const cny = (nano / 1_000_000_000) * (currency === "USD" ? MOSS_MEDIA_REFERENCE_USD_CNY : 1);
  return cny * MOSS_MEDIA_CREDITS_PER_CNY;
}

function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString("en-US");
}

/** "约 95 积分" or, for a fraction of a credit, "不足 1 积分". */
function aboutCredits(credits: number): string {
  return credits > 0 && credits < 0.5 ? "不足 1 积分" : `约 ${formatCredits(credits)} 积分`;
}

/** Joins tiers that cost the same: "1K/2K 约 95 积分". */
function tierPrices(tiers: ReadonlyArray<readonly [string, number]>, unit: string): string {
  const groups: { labels: string[]; credits: string }[] = [];
  for (const [label, credits] of tiers) {
    const formatted = formatCredits(credits);
    const last = groups.at(-1);
    if (last && last.credits === formatted) last.labels.push(label);
    else groups.push({ labels: [label], credits: formatted });
  }
  return groups
    .map((group) => `${group.labels.join("/")} 约 ${group.credits} 积分/${unit}`)
    .join("，");
}

const IMAGE_TIERS = ["1K", "1.5K", "2K", "4K"] as const;
const VIDEO_TIERS = ["480P", "720P", "768P", "1080P", "2K", "4K"] as const;

/**
 * A person-readable reference price, in credits, for one model. Returns null
 * when the repository has no reviewed cost for it.
 */
export function mossMediaModelPrice(modelId: string): string | null {
  const cost = REVIEWED_COSTS.get(modelId);
  if (!cost) return null;
  const rate = (key: string) => {
    const value = cost.rates[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const parts: string[] = [];
  switch (cost.kind) {
    case "image": {
      const tiers = IMAGE_TIERS.flatMap((tier) => {
        const value = rate(tier);
        return value === undefined ? [] : [[tier, creditsFromNano(value, cost.currency)] as const];
      });
      parts.push(tierPrices(tiers, "张"));
      const input = rate("inputImage");
      const free = rate("freeInputImages");
      if (input === 0) parts.push("参考图免费");
      else if (input !== undefined)
        parts.push(
          `${free ? `前 ${free} 张参考图免费，之后` : ""}每张参考图${aboutCredits(
            creditsFromNano(input, cost.currency),
          )}`,
        );
      break;
    }
    case "tokens": {
      const output = rate("output");
      if (output !== undefined)
        parts.push(
          `按实际用量计费，图像输出每百万 token 约 ${formatCredits(
            creditsFromNano(output * 1_000_000, cost.currency),
          )} 积分`,
        );
      parts.push(
        `每张最多预留约 ${formatCredits(creditsFromNano(cost.reservationNano, cost.currency))} 积分，按实际用量扣除`,
      );
      break;
    }
    case "video_second": {
      const audio = VIDEO_TIERS.some((tier) => rate(`${tier}:audio`) !== undefined);
      if (audio) {
        for (const tier of VIDEO_TIERS) {
          const silent = rate(`${tier}:silent`);
          const sound = rate(`${tier}:audio`);
          if (silent === undefined || sound === undefined) continue;
          parts.push(
            `${tier} 无声约 ${formatCredits(creditsFromNano(silent, cost.currency))} 积分/秒、有声约 ${formatCredits(
              creditsFromNano(sound, cost.currency),
            )} 积分/秒`,
          );
        }
      } else {
        const tiers = VIDEO_TIERS.flatMap((tier) => {
          const value = rate(tier);
          return value === undefined
            ? []
            : [[tier, creditsFromNano(value, cost.currency)] as const];
        });
        parts.push(tierPrices(tiers, "秒"));
        const free = rate("freeInputImages");
        const input = rate("inputImage");
        if (free !== undefined && input !== undefined)
          parts.push(
            `参考图前 ${free} 张免费，之后每张约 ${formatCredits(creditsFromNano(input, cost.currency))} 积分`,
          );
      }
      break;
    }
    case "completion_tokens": {
      const tiers = Object.keys(SEEDANCE_TIER_PIXELS).flatMap((tier) => {
        const perToken = rate(tier);
        if (perToken === undefined) return [];
        const tokensPerSecond = (SEEDANCE_TIER_PIXELS[tier]! * 24) / 1024;
        return [[tier, creditsFromNano(perToken * tokensPerSecond, cost.currency)] as const];
      });
      parts.push(tierPrices(tiers, "秒"));
      parts.push("按实际生成的 token 计费，画面更小时更便宜");
      break;
    }
  }
  return parts.filter(Boolean).join("；");
}

/** A typical job, so a person can compare models at a glance. */
export function mossMediaModelExample(modelId: string): string | null {
  const cost = REVIEWED_COSTS.get(modelId);
  const model = mossMediaModel(modelId);
  if (!cost || !model || model.kind !== "video") return null;
  const seconds = 5;
  let perSecond: number | undefined;
  let tier: string | undefined;
  if (cost.kind === "video_second") {
    for (const candidate of VIDEO_TIERS) {
      const value = cost.rates[`${candidate}:silent`] ?? cost.rates[candidate];
      if (typeof value === "number") {
        perSecond = creditsFromNano(value, cost.currency);
        tier = candidate;
        break;
      }
    }
  } else if (cost.kind === "completion_tokens") {
    for (const candidate of Object.keys(SEEDANCE_TIER_PIXELS)) {
      const value = cost.rates[candidate];
      if (typeof value === "number") {
        perSecond = creditsFromNano(
          (value * SEEDANCE_TIER_PIXELS[candidate]! * 24) / 1024,
          cost.currency,
        );
        tier = candidate;
        break;
      }
    }
  }
  if (perSecond === undefined || !tier) return null;
  return `${seconds} 秒 ${tier} 约 ${formatCredits(perSecond * seconds)} 积分`;
}
