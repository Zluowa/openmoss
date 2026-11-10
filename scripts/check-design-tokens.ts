// FILE: check-design-tokens.ts
// Purpose: Holds the web app to docs/design/moss-design-standard.md. Counts, per UI file, the
//          patterns the standard forbids (hard-coded colours, size-named or arbitrary radii,
//          arbitrary font sizes and shadows, extra font weights, hand-drawn buttons) and fails
//          when any file has more than the recorded baseline. Existing drift may only go down.
// Layer: Repository check (`bun run design:check`, part of `bun lint`)
// Exports: none (CLI). `--update` rewrites the baseline to the current counts; use it after
//          cleaning a file up, never to accept new drift.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const scanRoot = join(repoRoot, "apps/web/src");
const baselinePath = join(repoRoot, "scripts/design-check-baseline.json");

/** Each rule names what the standard asks for instead, so a failure says how to fix it. */
const rules = {
  "hex-color": {
    pattern: /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g,
    fix: "use a semantic colour (text-foreground, text-muted-foreground, bg-card, border-border, …)",
  },
  "size-radius": {
    pattern: /\brounded-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)\b/g,
    fix: "use a radius role (rounded-inline, -row, -control, -card, -popover, -panel, -dialog)",
  },
  "arbitrary-radius": {
    pattern: /\brounded(?:-[trblse]{1,2})?-\[[^\]]+\]/g,
    fix: "use a radius role; a new surface needs a role in index.css first",
  },
  "arbitrary-font-size": {
    pattern: /\btext-\[\d+(?:\.\d+)?(?:px|rem)\]/g,
    fix: "use a type role (text-ui, text-ui-sm, text-ui-xs, text-ui-lg, text-chat, text-title)",
  },
  "arbitrary-shadow": {
    pattern: /\bshadow-\[[^\]]+\]/g,
    fix: "use a shadow step (shadow-xs, -sm, -xl, -2xl)",
  },
  "heavy-weight": {
    pattern: /\bfont-(?:semibold|bold|extrabold|black)\b/g,
    fix: "use font-normal or font-medium (page and dialog titles keep their shared title classes)",
  },
  "raw-button": {
    pattern: /<button\b/g,
    fix: "use Button (or buttonVariants on the element that must stay native)",
  },
} as const;

type RuleId = keyof typeof rules;
type Counts = Partial<Record<RuleId, number>>;

function isScanned(path: string): boolean {
  if (!/\.(tsx|ts)$/.test(path)) return false;
  if (/\.(test|browser|stories)\.tsx?$/.test(path)) return false;
  if (/[\\/](test|__screenshots__|fixtures)[\\/]/.test(path)) return false;
  // The theme module is where colours are defined; everything else reads them by name.
  if (/[\\/]src[\\/]theme[\\/]/.test(path)) return false;
  return true;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (isScanned(path)) yield path;
  }
}

function count(): Record<string, Counts> {
  const result: Record<string, Counts> = {};
  for (const path of walk(scanRoot)) {
    const text = readFileSync(path, "utf8");
    const counts: Counts = {};
    for (const [id, rule] of Object.entries(rules) as [RuleId, (typeof rules)[RuleId]][]) {
      const n = text.match(rule.pattern)?.length ?? 0;
      if (n > 0) counts[id] = n;
    }
    if (Object.keys(counts).length > 0) {
      result[relative(repoRoot, path).replaceAll("\\", "/")] = counts;
    }
  }
  return Object.fromEntries(Object.entries(result).toSorted(([a], [b]) => a.localeCompare(b)));
}

const current = count();
const totals = (data: Record<string, Counts>) => {
  const sum: Record<string, number> = {};
  for (const counts of Object.values(data)) {
    for (const [id, n] of Object.entries(counts)) sum[id] = (sum[id] ?? 0) + (n ?? 0);
  }
  return sum;
};

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Design baseline written: ${JSON.stringify(totals(current))}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Counts>;
const failures: string[] = [];
for (const [file, counts] of Object.entries(current)) {
  for (const [id, n] of Object.entries(counts) as [RuleId, number][]) {
    const allowed = baseline[file]?.[id] ?? 0;
    if (n > allowed) {
      failures.push(`${file}: ${id} ${allowed} → ${n}. ${rules[id].fix}.`);
    }
  }
}

if (failures.length > 0) {
  console.error("Design check failed (docs/design/moss-design-standard.md):");
  for (const line of failures) console.error(`  ${line}`);
  console.error(
    "Fix the new occurrences. Run `bun run design:check --update` only after removing drift.",
  );
  process.exit(1);
}

const now = totals(current);
const was = totals(baseline);
const shrunk = Object.keys(was).filter((id) => (now[id] ?? 0) < (was[id] ?? 0));
console.log(
  `Design check passed: ${JSON.stringify(now)}` +
    (shrunk.length > 0
      ? ` (down from baseline in ${shrunk.join(", ")}; run with --update to lock it in)`
      : ""),
);
