// FILE: usage-pricing-snapshot.ts
// Purpose: Rewrites src/usagePricingSnapshot.json, the API price list Moss ships
// for Usage → Analytics estimates, from a LiteLLM price file you downloaded.
// It keeps only the Codex and Claude models Moss offers (plus older names their
// session files still carry) and only the fields usagePricing.ts reads.
// Usage: bun apps/server/scripts/usage-pricing-snapshot.ts <model_prices_and_context_window.json> [YYYY-MM-DD]
// The date is the day the file was downloaded (today by default).

import fs from "node:fs";
import nodePath from "node:path";

import { MODEL_OPTIONS_BY_PROVIDER } from "@moss/contracts";

import { LITELLM_PRICES_URL } from "../src/usagePricing";

// Names older Codex and Claude Code sessions recorded that Moss no longer lists.
const OLDER_MODELS = [
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "claude-sonnet-4-5",
];
// First-party entries, tried when LiteLLM has no bare name for a model.
const QUALIFIERS = ["openai/", "anthropic/", "deepseek/", "moonshot/"];
const FIELD =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost|cache_creation_input_token_cost_above_1hr)(_above_\d+k_tokens)?$/u;

const [source, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
if (!source || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
  console.error("usage: usage-pricing-snapshot.ts <litellm-prices.json> [YYYY-MM-DD]");
  process.exit(1);
}
const document = JSON.parse(fs.readFileSync(source, "utf8")) as Record<string, unknown>;
const byLowerName = new Map(
  Object.entries(document).map(([key, value]) => [key.toLowerCase(), value]),
);

const slugs = new Set<string>(OLDER_MODELS);
for (const provider of ["codex", "claudeAgent"] as const) {
  for (const option of MODEL_OPTIONS_BY_PROVIDER[provider]) slugs.add(option.slug.toLowerCase());
}

const models: Record<string, Record<string, unknown>> = {};
const missing: string[] = [];
for (const slug of [...slugs].toSorted()) {
  const entry = [slug, ...QUALIFIERS.map((prefix) => `${prefix}${slug}`)]
    .map((name) => byLowerName.get(name))
    .find((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
  if (!entry) {
    missing.push(slug);
    continue;
  }
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entry)) {
    if (FIELD.test(name) && typeof value === "number") kept[name] = value;
  }
  const fast = (entry.provider_specific_entry as Record<string, unknown> | undefined)?.fast;
  if (typeof fast === "number") kept.provider_specific_entry = { fast };
  if ("input_cost_per_token" in kept && "output_cost_per_token" in kept) models[slug] = kept;
  else missing.push(slug);
}

const target = nodePath.join(import.meta.dirname, "..", "src", "usagePricingSnapshot.json");
fs.writeFileSync(
  target,
  `${JSON.stringify({ source: LITELLM_PRICES_URL, date, models }, null, 2)}\n`,
);
console.log(`${Object.keys(models).length} models written to ${target}`);
if (missing.length > 0) console.log(`no list price: ${missing.join(", ")}`);
