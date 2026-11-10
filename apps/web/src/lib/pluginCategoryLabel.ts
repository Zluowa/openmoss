// FILE: pluginCategoryLabel.ts
// Purpose: Plugin categories arrive in English from every catalog; this names
//          the known ones in the UI language for the directory and plugin page.
// Layer: Web localization helper
// Exports: localizePluginCategory

import type { TranslationKey } from "~/localization";

type Translate = (key: TranslationKey) => string;

const PLUGIN_CATEGORY_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  productivity: "plugins.category.productivity",
  "small business": "plugins.category.smallBusiness",
  coding: "plugins.category.coding",
  research: "plugins.category.research",
  design: "plugins.category.design",
  lifestyle: "plugins.category.lifestyle",
  "developer tools": "plugins.category.developerTools",
  engineering: "plugins.category.engineering",
  "education & research": "plugins.category.educationResearch",
  communication: "plugins.category.communication",
  creativity: "plugins.category.creativity",
  healthcare: "plugins.category.healthcare",
  finance: "plugins.category.finance",
  travel: "plugins.category.travel",
  entertainment: "plugins.category.entertainment",
  "business & operations": "plugins.category.businessOperations",
  "data & analytics": "plugins.category.dataAnalytics",
  "scientific research": "plugins.category.scientificResearch",
  security: "plugins.category.security",
  other: "plugins.category.other",
};

/** Marketplace categories arrive in English; known ones read in the UI language. */
export function localizePluginCategory(category: string | null, t: Translate): string {
  const key = PLUGIN_CATEGORY_LABEL_KEYS[(category ?? "other").trim().toLowerCase()];
  return key ? t(key) : (category ?? t("plugins.category.other"));
}
