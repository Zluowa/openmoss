// FILE: profileAvatarPresets.ts
// Purpose: Catalog of Moss's 20 original Notion-style cute minimal preset avatars
//          served from `apps/web/public/avatars/*.svg`.
// Layer: Web profile feature (pure catalog, no I/O)

import { MOSS_PROFILE_PRESET_AVATAR_ID_PATTERN, type MossProfileAvatar } from "@moss/contracts";
import type { MossLocaleCode } from "~/appSettings";

export type ProfileAvatarPresetCategory = "moss" | "people" | "friends";

export interface ProfileAvatarPreset {
  readonly id: string;
  readonly category: ProfileAvatarPresetCategory;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly src: string;
}

function definePreset(
  id: string,
  category: ProfileAvatarPresetCategory,
  labelZh: string,
  labelEn: string,
): ProfileAvatarPreset {
  return {
    id,
    category,
    labelZh,
    labelEn,
    src: `/avatars/${id}.svg`,
  };
}

export const PROFILE_AVATAR_PRESETS: readonly ProfileAvatarPreset[] = [
  // Moss brand & nature
  definePreset("moss-pinwheel", "moss", "纸风车", "Moss pinwheel"),
  definePreset("leaf-sprout", "moss", "小嫩芽", "Moss sprout"),
  definePreset("moss-cloud", "moss", "轻云朵", "Paper cloud"),
  definePreset("moss-mug", "moss", "热茶杯", "Warm mug"),
  definePreset("moss-star", "moss", "小星光", "Paper star"),
  // Minimal Notion-style faces
  definePreset("smiling-glasses", "people", "眼镜同学", "Round glasses"),
  definePreset("bob-smile", "people", "微笑短发", "Bob smile"),
  definePreset("beanie-coder", "people", "毛线帽", "Cozy beanie"),
  definePreset("curly-happy", "people", "卷毛开心", "Curly happy"),
  definePreset("headphones-chill", "people", "耳机听歌", "Headphones"),
  definePreset("beret-artist", "people", "贝雷帽", "Coral beret"),
  definePreset("buns-wink", "people", "双丸子头", "Twin buns"),
  definePreset("cap-explorer", "people", "棒球帽", "Explorer cap"),
  // Cute minimal animal companions
  definePreset("moss-cat", "friends", "软萌小猫", "Moss kitty"),
  definePreset("moss-shiba", "friends", "柴犬团子", "Shiba pup"),
  definePreset("moss-bunny", "friends", "长耳小兔", "Little bunny"),
  definePreset("moss-bear", "friends", "暖心小熊", "Scarf bear"),
  definePreset("moss-frog", "friends", "苔藓小蛙", "Moss frog"),
  definePreset("moss-fox", "friends", "珊瑚小狐", "Coral fox"),
  definePreset("moss-owl", "friends", "夜猫头鹰", "Studio owl"),
] as const;

export const DEFAULT_PROFILE_AVATAR_PRESET_ID = "moss-pinwheel";

const PRESET_BY_ID = new Map<string, ProfileAvatarPreset>(
  PROFILE_AVATAR_PRESETS.map((preset) => [preset.id, preset]),
);

export function getProfileAvatarPreset(id: string | null | undefined): ProfileAvatarPreset | null {
  if (!id || !MOSS_PROFILE_PRESET_AVATAR_ID_PATTERN.test(id)) {
    return null;
  }
  return PRESET_BY_ID.get(id) ?? null;
}

export function resolveProfileAvatarPresetSrc(id: string | null | undefined): string | null {
  return getProfileAvatarPreset(id)?.src ?? null;
}

export function resolveProfileAvatarSrc(
  avatar: MossProfileAvatar | null | undefined,
  legacyImage?: string | null,
): string | null {
  if (!avatar) {
    return legacyImage?.trim() || null;
  }
  if (avatar.kind === "preset") {
    return resolveProfileAvatarPresetSrc(avatar.id);
  }
  if (avatar.kind === "upload") {
    return avatar.url.trim() || null;
  }
  return null;
}

export function getProfileAvatarPresetLabel(
  preset: ProfileAvatarPreset,
  locale: MossLocaleCode,
): string {
  return locale === "zh-CN" ? preset.labelZh : preset.labelEn;
}
