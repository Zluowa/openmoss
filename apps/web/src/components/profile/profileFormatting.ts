// FILE: profileFormatting.ts
// Purpose: Pure display formatters shared by the Profile page and the shareable card.
// Layer: web profile feature (no I/O, safe to use during html-to-image render).

import type { ProviderKind } from "@moss/contracts";
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

export function formatDays(value: number, locale: MossLocaleCode = "en"): string {
  if (locale === "zh-CN") {
    return `${formatNumber(value)} 天`;
  }
  return `${formatNumber(value)} ${value === 1 ? "day" : "days"}`;
}

// Human duration for "longest task" (e.g. "17 小时 42 分" / "17h 42m").
export function formatDuration(
  ms: number | null | undefined,
  locale: MossLocaleCode = "en",
): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  const totalSeconds = Math.max(1, Math.round(ms / 1_000));
  if (totalSeconds < 60) {
    return locale === "zh-CN" ? `${totalSeconds} 秒` : `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return locale === "zh-CN" ? `${totalMinutes} 分钟` : `${totalMinutes}m`;
  }
  if (minutes === 0) {
    return locale === "zh-CN" ? `${hours} 小时` : `${hours}h`;
  }
  return locale === "zh-CN" ? `${hours} 小时 ${minutes} 分` : `${hours}h ${minutes}m`;
}

const MONTH_LABELS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function formatMonthLabel(monthIndex: number, locale: MossLocaleCode = "en"): string | null {
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  if (locale === "zh-CN") {
    return `${monthIndex + 1}月`;
  }
  return MONTH_LABELS_EN[monthIndex] ?? null;
}

export function deriveProfileInitials(displayName: string, fallback = "M"): string {
  const cleaned = displayName.trim();
  if (!cleaned) {
    return fallback;
  }
  const words = cleaned.split(/[\s._-]+/u).filter((part) => part.length > 0);
  if (words.length >= 2) {
    const first = Array.from(words[0] ?? "")[0] ?? "";
    const second = Array.from(words[1] ?? "")[0] ?? "";
    return `${first}${second}`.toLocaleUpperCase() || fallback;
  }
  const chars = Array.from(cleaned.replace(/\s+/gu, ""));
  return chars.slice(0, 2).join("").toLocaleUpperCase() || fallback;
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

// Home folders that name a machine account rather than a person.
const ACCOUNT_HOME_FOLDERS = new Set([
  "admin",
  "administrator",
  "default",
  "defaultuser0",
  "guest",
  "owner",
  "profile",
  "public",
  "root",
  "ubuntu",
  "user",
]);

// The name to greet someone by when they haven't set one: their home folder, if it reads like a
// name. Empty otherwise, so nobody is greeted as "60948" or "Administrator".
export function homeFolderGreetingName(homeDir: string | null): string {
  const basename =
    (homeDir ?? "")
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  if (!/\p{L}/u.test(basename) || ACCOUNT_HOME_FOLDERS.has(basename.toLowerCase())) {
    return "";
  }
  return toDisplayName(basename);
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
