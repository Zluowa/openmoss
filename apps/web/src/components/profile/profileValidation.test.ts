// FILE: profileValidation.test.ts
// Purpose: Unit tests for Moss profile validation, handle rules, duration/streak
//          formatting, initials derivation, and the 20 Notion-style SVG preset catalog.
// Layer: Web profile unit tests (runs on Windows and Linux CI)

import fs from "node:fs";
import path from "node:path";

import {
  MOSS_PROFILE_ERROR_CODES,
  MOSS_PROFILE_PRESET_AVATAR_ID_PATTERN,
  MOSS_PROFILE_RESERVED_HANDLES,
} from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_AVATAR_PRESET_ID,
  getProfileAvatarPreset,
  PROFILE_AVATAR_PRESETS,
  resolveProfileAvatarPresetSrc,
  resolveProfileAvatarSrc,
} from "./profileAvatarPresets";
import {
  deriveProfileInitials,
  formatCompact,
  formatDays,
  formatDuration,
  formatMonthLabel,
} from "./profileFormatting";
import {
  classifyProfileError,
  formatDisplayHandle,
  normalizeProfileHandleDraft,
  validateProfileDisplayName,
  validateProfileHandleLocal,
} from "./profileValidation";

const PUBLIC_AVATARS_DIR = path.resolve(import.meta.dirname, "../../../public/avatars");

describe("profileValidation", () => {
  it("normalizes handle drafts by stripping leading @, trimming, and lowercasing", () => {
    expect(normalizeProfileHandleDraft("  @@Milo_Dev  ")).toBe("milo_dev");
    expect(normalizeProfileHandleDraft("@MOSS_123")).toBe("moss_123");
    expect(normalizeProfileHandleDraft("   ")).toBe("");
  });

  it("enforces 3–20 lowercase alphanumeric/underscore handle rules and reserved words", () => {
    expect(validateProfileHandleLocal("ab")).toBe("too_short");
    expect(validateProfileHandleLocal("a".repeat(21))).toBe("too_long");
    expect(validateProfileHandleLocal("bad-dash")).toBe("invalid_characters");
    expect(validateProfileHandleLocal("bad space")).toBe("invalid_characters");
    expect(validateProfileHandleLocal("中文id")).toBe("invalid_characters");
    for (const reserved of ["moss", "admin", "root", "profile", "settings"]) {
      expect(MOSS_PROFILE_RESERVED_HANDLES).toContain(reserved);
      expect(validateProfileHandleLocal(reserved)).toBe("reserved");
    }
    expect(validateProfileHandleLocal("abc")).toBeNull();
    expect(validateProfileHandleLocal("milo_charis_99")).toBeNull();
    expect(validateProfileHandleLocal("a".repeat(20))).toBeNull();
  });

  it("validates display names by Unicode code point count and rejects control chars", () => {
    expect(validateProfileDisplayName("")).toBe("empty");
    expect(validateProfileDisplayName("   ")).toBe("empty");
    expect(validateProfileDisplayName("林".repeat(32))).toBeNull();
    expect(validateProfileDisplayName("林".repeat(33))).toBe("too_long");
    expect(validateProfileDisplayName("Line\nBreak")).toBe("invalid_characters");
    expect(validateProfileDisplayName("Null\u0000Char")).toBe("invalid_characters");
    expect(validateProfileDisplayName("小林同学")).toBeNull();
    expect(validateProfileDisplayName("Milo charis")).toBeNull();
  });

  it("formats handles and classifies server profile error codes", () => {
    expect(formatDisplayHandle("milo_dev")).toBe("@milo_dev");
    expect(formatDisplayHandle("@@Milo_Dev")).toBe("@milo_dev");
    expect(formatDisplayHandle(null)).toBeNull();
    expect(formatDisplayHandle("  ")).toBeNull();

    expect(classifyProfileError({ code: MOSS_PROFILE_ERROR_CODES.offline })).toBe("offline");
    expect(classifyProfileError({ code: MOSS_PROFILE_ERROR_CODES.handleTaken })).toBe(
      "handleTaken",
    );
    expect(classifyProfileError({ code: MOSS_PROFILE_ERROR_CODES.invalid })).toBe("invalid");
    expect(classifyProfileError({ code: MOSS_PROFILE_ERROR_CODES.avatarInvalid })).toBe(
      "avatarInvalid",
    );
    expect(classifyProfileError(new Error("boom"))).toBe("unknown");
  });
});

describe("profileFormatting extensions", () => {
  it("formats longest task durations in Simplified Chinese and English", () => {
    expect(formatDuration(null, "zh-CN")).toBe("—");
    expect(formatDuration(0, "zh-CN")).toBe("—");
    expect(formatDuration(45_000, "zh-CN")).toBe("45 秒");
    expect(formatDuration(45_000, "en")).toBe("45s");
    expect(formatDuration(42 * 60_000, "zh-CN")).toBe("42 分钟");
    expect(formatDuration(42 * 60_000, "en")).toBe("42m");
    expect(formatDuration((17 * 60 + 42) * 60_000, "zh-CN")).toBe("17 小时 42 分");
    expect(formatDuration((17 * 60 + 42) * 60_000, "en")).toBe("17h 42m");
    expect(formatDuration(2 * 3_600_000, "zh-CN")).toBe("2 小时");
    expect(formatDuration(2 * 3_600_000, "en")).toBe("2h");
  });

  it("formats streaks, compact tokens, months, and initials across zh-CN and en", () => {
    expect(formatDays(14, "zh-CN")).toBe("14 天");
    expect(formatDays(0, "zh-CN")).toBe("0 天");
    expect(formatDays(1, "en")).toBe("1 day");
    expect(formatDays(14, "en")).toBe("14 days");

    expect(formatCompact(11_230_000_000, "zh-CN")).toBe("112.3亿");
    expect(formatCompact(1_320_000_000, "zh-CN")).toBe("13.2亿");
    expect(formatMonthLabel(0, "zh-CN")).toBe("1月");
    expect(formatMonthLabel(11, "zh-CN")).toBe("12月");
    expect(formatMonthLabel(0, "en")).toBe("Jan");
    expect(formatMonthLabel(12, "en")).toBeNull();

    expect(deriveProfileInitials("Milo charis")).toBe("MC");
    expect(deriveProfileInitials("小林同学")).toBe("小林");
    expect(deriveProfileInitials("   ", "M")).toBe("M");
  });
});

describe("Notion-style Moss avatar preset catalog", () => {
  it("ships 20 valid, unique SVG preset avatars backed by real public SVG files", () => {
    expect(PROFILE_AVATAR_PRESETS.length).toBeGreaterThanOrEqual(16);
    expect(PROFILE_AVATAR_PRESETS.length).toBeLessThanOrEqual(24);
    expect(PROFILE_AVATAR_PRESETS.length).toBe(20);
    expect(getProfileAvatarPreset(DEFAULT_PROFILE_AVATAR_PRESET_ID)).not.toBeNull();

    const ids = new Set<string>();
    for (const preset of PROFILE_AVATAR_PRESETS) {
      expect(MOSS_PROFILE_PRESET_AVATAR_ID_PATTERN.test(preset.id)).toBe(true);
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(preset.src).toBe(`/avatars/${preset.id}.svg`);
      expect(preset.labelZh.length).toBeGreaterThan(0);
      expect(preset.labelEn.length).toBeGreaterThan(0);

      const svgPath = path.join(PUBLIC_AVATARS_DIR, `${preset.id}.svg`);
      expect(fs.existsSync(svgPath), `Missing SVG asset: ${preset.id}.svg`).toBe(true);
      const svg = fs.readFileSync(svgPath, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain('viewBox="0 0 128 128"');
      expect(svg).not.toMatch(/<script|javascript:|onerror=/iu);
    }
  });

  it("resolves preset, uploaded, initials, and unknown avatar variants safely", () => {
    expect(resolveProfileAvatarPresetSrc("moss-cat")).toBe("/avatars/moss-cat.svg");
    expect(resolveProfileAvatarPresetSrc("../bad")).toBeNull();
    expect(resolveProfileAvatarPresetSrc("does-not-exist")).toBeNull();

    expect(resolveProfileAvatarSrc({ kind: "preset", id: "leaf-sprout" })).toBe(
      "/avatars/leaf-sprout.svg",
    );
    expect(resolveProfileAvatarSrc({ kind: "upload", url: "https://example.invalid/a.webp" })).toBe(
      "https://example.invalid/a.webp",
    );
    expect(resolveProfileAvatarSrc({ kind: "initials" }, "data:image/png;base64,abc")).toBeNull();
    expect(resolveProfileAvatarSrc(null, "data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
  });
});
