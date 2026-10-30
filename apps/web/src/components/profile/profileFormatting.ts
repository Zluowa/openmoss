// FILE: profileFormatting.ts
// Purpose: Pure display formatters shared by the Profile page and the shareable card.
// Layer: web profile feature (no I/O, safe to use during html-to-image render).

import type { ProviderKind } from "@synara/contracts";
import type { MossLocaleCode } from "~/appSettings";

// Compact token/count formatting: reference-card suffixes in English and native 万/亿 units
// in Simplified Chinese.
export function formatCompact(
  value: number | null | undefined,
  locale: MossLocaleCode = "en",
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (locale === "zh-CN") {
    if (abs >= 100_000_000) {
      return `${trimZero(value / 100_000_000)}亿`;
    }
    if (abs >= 10_000) {
      return `${trimZero(value / 10_000)}万`;
    }
    return `${Math.round(value)}`;
  }
  if (abs >= 1_000_000_000) {
    return `${trimZero(value / 1_000_000_000)}bn`;
  }
  if (abs >= 1_000_000) {
    return `${trimZero(value / 1_000_000)}m`;
  }
  if (abs >= 1_000) {
    return `${trimZero(value / 1_000)}k`;
  }
  return `${Math.round(value)}`;
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

// Thousands-separated integer ("4,934").
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return WHOLE_NUMBER_FORMATTER.format(value);
}

export function formatDays(value: number): string {
  return `${formatNumber(value)} ${value === 1 ? "day" : "days"}`;
}

// Title-case a home-directory basename into a friendly display name.
export function toDisplayName(basename: string): string {
  const cleaned = basename
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned) {
    return "Moss";
  }
  return cleaned
    .split(" ")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function normalizeHandle(value: string): string {
  const slug = value
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 30);
  return `@${slug || "moss"}`;
}

// Pretty short date for "peak day" tooltips ("Apr 3").
export function formatShortDate(day: string | null): string | null {
  if (!day) {
    return null;
  }
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) {
    return null;
  }
  return MONTH_DAY_FORMATTER.format(new Date(Date.UTC(year, month - 1, date)));
}

export function formatProviderLabel(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "devin":
      return "Devin";
    case "antigravity":
      return "Antigravity";
    case "grok":
      return "Grok";
    case "droid":
      return "Droid";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    case "gemini":
      return "Gemini";
    case "hermes":
      return "Hermes";
    case "kilo":
      return "Kilo";
    case "omp":
      return "Oh My Pi";
    case "kimi":
      return "Kimi Code";
    case "minimax":
      return "MiniMax Code";
    case "zcode":
      return "ZCode";
  }
}

export function formatProfileUsageBasis(metric: "tokens" | "turns"): string {
  return metric === "tokens" ? "tracked tokens" : "turns";
}

const WHOLE_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
// formatShortDate turns a day key into UTC midnight, so format in UTC or viewers
// west of UTC see the previous day.
const MONTH_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
