// FILE: resourceIcon.tsx
// Purpose: Faithful port of Codex Desktop's `resolveFallbackSkillIcon`
//          (decode-codex/restored/utils/get-skill-icon/fallback-skill-icons.ts):
//          pick a per-resource icon by exact-name registry, then keyword match
//          on name/description, so each skill / MCP server / plugin gets the same
//          distinct glyph Codex shows instead of one generic icon. Brand glyphs
//          come from react-icons Simple Icons (monochrome, inherit currentColor
//          like Codex's current-color-masked icons); generics from the app's one
//          outline family (~/lib/icons).
// Layer: Web lib
// Exports: resolveResourceIcon, normalizeIconKey, SKILL_FALLBACK_ICON, MCP_FALLBACK_ICON

import type { ComponentType } from "react";
import { BsOpenai, BsSlack } from "react-icons/bs";
import {
  SiBuildkite,
  SiFigma,
  SiGithub,
  SiGooglechrome,
  SiLinear,
  SiNotion,
  SiSentry,
} from "react-icons/si";

import { BlocksIcon, BoxIcon, BugIcon, PencilIcon, ServerIcon } from "./icons";

/** A monochrome icon accepting `className` — satisfied by ~/lib/icons and react-icons. */
export type ResourceIconComponent = ComponentType<{ className?: string }>;

/** Default when no keyword matches — Codex uses its SkillCreator glyph. */
export const SKILL_FALLBACK_ICON: ResourceIconComponent = BlocksIcon;
/** MCP servers with no brand match fall back to a server glyph. */
export const MCP_FALLBACK_ICON: ResourceIconComponent = ServerIcon;

// Exact-name registry, ported verbatim from Codex `fallbackIconByExactSkillName`.
const EXACT_ICON_BY_NAME: Record<string, ResourceIconComponent> = {
  "gh-address-comments": SiGithub,
  "buildkite-fix-ci": SiBuildkite,
  "sentry-observability": SiSentry,
  "linear-implement-ticket": SiLinear,
  "figma-implement-design": SiFigma,
  "skill-creator": SKILL_FALLBACK_ICON,
};

export function normalizeIconKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Resolve the icon for a resource by name/description — same precedence and
 * keyword order as Codex's `resolveFallbackSkillIcon`. `fallback` lets callers
 * pick the per-kind default (skill vs MCP) for the no-match case.
 */
export function resolveResourceIcon(
  name: string,
  description?: string | null,
  fallback: ResourceIconComponent = SKILL_FALLBACK_ICON,
): ResourceIconComponent {
  const key = normalizeIconKey(name);
  const exact = EXACT_ICON_BY_NAME[key];
  if (exact) return exact;

  const desc = description?.toLowerCase() ?? "";
  if (key.includes("codex")) return BsOpenai;
  if (key.includes("openai")) return BsOpenai;
  if (key.includes("linear")) return SiLinear;
  if (key.includes("review")) return BugIcon;
  if (key.includes("github") || key.includes("gh-") || desc.includes("github")) return SiGithub;
  if (key.includes("browser") || key.includes("chrome")) return SiGooglechrome;
  if (key.includes("plan")) return PencilIcon;
  if (key.includes("slack")) return BsSlack;
  if (key.includes("notion")) return SiNotion;
  if (key.includes("buildkite")) return SiBuildkite;
  if (key.includes("figma")) return SiFigma;
  if (key.includes("sentry")) return SiSentry;
  // Simple Icons has no Playwright/Context7 glyph; use a neutral box.
  if (key.includes("playwright") || desc.includes("playwright")) return BoxIcon;
  if (key.includes("context7") || desc.includes("context7")) return BoxIcon;
  return fallback;
}
