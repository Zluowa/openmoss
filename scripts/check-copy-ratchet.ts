// FILE: check-copy-ratchet.ts
// Purpose: Holds "no explanatory UI" as a machine rule. Counts the user-visible sentence-like
//          Chinese strings in apps/web (the definition of the 2026-11-24 copy sweep,
//          rounds/20261124-takeover/ONE-COMPONENT.md section 4) and fails when the count is above
//          its number in scripts/copy-ratchet-baseline.json. The numbers may only go down.
// Layer: Repository check (`bun run copy:check`, part of `bun lint`, so Gate A runs it)
// Exports: countCopy, isCandidate, grownFiles, nextBaseline (for tests). CLI:
//   node scripts/check-copy-ratchet.ts [--update] [--list]
//   --update records the current per-file counts, refusing a higher total.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const repoRoot = join(import.meta.dirname, "..");
const defaultRoot = join(repoRoot, "apps/web/src");
const baselinePath = join(repoRoot, "scripts/copy-ratchet-baseline.json");

const CJK = /[\u3400-\u9fff]/;
const CHINESE_PUNCTUATION = /[，。！？；：、…（）“”]/;
/** Keys whose value is helper text by its name. */
const HELPER_KEY =
  /(description|desc$|hint|help|subtitle|empty|tip$|tips|tooltip|tour|notice|caption|explain|intro|coach|onboarding|guide)/i;
const EMPTY_OPENER = /^(暂无|还没有|尚未|没有任何|目前没有)/;

export interface CopyString {
  readonly text: string;
  /** The property, attribute or variable the string is assigned to, when it has one. */
  readonly key?: string;
}

/**
 * A sentence (14 or more characters with Chinese punctuation), a value of a helper-named key,
 * a placeholder longer than 10 characters, or an empty-state opener. Only Chinese strings count:
 * the Chinese text is what a person sees in the default language.
 */
export function isCandidate({ text, key }: CopyString): boolean {
  const value = text.trim();
  if (!CJK.test(value)) return false;
  const length = [...value].length;
  if (length >= 14 && CHINESE_PUNCTUATION.test(value)) return true;
  if (key && /placeholder/i.test(key)) return length > 10;
  if (key && HELPER_KEY.test(key)) return true;
  return EMPTY_OPENER.test(value);
}

function isScanned(path: string): boolean {
  if (!/\.(tsx|ts)$/.test(path) || /\.d\.ts$/.test(path)) return false;
  if (/\.(test|browser|stories)\.tsx?$/.test(path)) return false;
  if (/[\\/](test|tests|__tests__|__screenshots__|fixtures)[\\/]/.test(path)) return false;
  // Release notes and agent prompts are not interface copy (section 4, "Limits").
  if (/zhCNWhatsNew\.ts$/.test(path) || /prompt/i.test(path.split(/[\\/]/).pop() ?? "")) {
    return false;
  }
  return true;
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...listFiles(path));
    } else if (isScanned(path)) {
      files.push(path);
    }
  }
  return files;
}

function nameOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

/** The key a string literal is assigned to: property, JSX attribute or variable name. */
function keyOf(node: ts.Node): string | undefined {
  let current: ts.Node = node;
  let parent = node.parent;
  // Look through wrappers: `{"…"}`, `("…")`, `"…" as const`, ternaries and `??` fallbacks.
  while (
    parent &&
    (ts.isJsxExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isConditionalExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)))
  ) {
    current = parent;
    parent = parent.parent;
  }
  if (!parent) return undefined;
  if (ts.isPropertyAssignment(parent) && parent.initializer === current) return nameOf(parent.name);
  if (ts.isJsxAttribute(parent)) return nameOf(parent.name as ts.Node);
  if (ts.isVariableDeclaration(parent) && parent.initializer === current)
    return nameOf(parent.name);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = parent.left;
    if (ts.isPropertyAccessExpression(left)) return left.name.text;
    return nameOf(left);
  }
  return undefined;
}

/** Every Chinese string a person can see in one source file, with its key. */
export function stringsIn(fileName: string, source: string): CopyString[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: CopyString[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // A Chinese property name is a lookup key (zhCN tables), not shown text.
      const isPropertyName =
        node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
      if (!isPropertyName && !ts.isImportDeclaration(node.parent) && CJK.test(node.text)) {
        const key = keyOf(node);
        found.push(key === undefined ? { text: node.text } : { text: node.text, key });
      }
    } else if (ts.isTemplateExpression(node)) {
      const text = [
        node.head.text,
        ...node.templateSpans.map((span) => `X${span.literal.text}`),
      ].join("");
      if (CJK.test(text)) {
        const key = keyOf(node);
        found.push(key === undefined ? { text } : { text, key });
      }
    } else if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (CJK.test(text)) found.push({ text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export interface CopyCount {
  readonly total: number;
  readonly byFile: ReadonlyMap<string, readonly string[]>;
}

export function countCopy(root: string): CopyCount {
  const byFile = new Map<string, string[]>();
  let total = 0;
  for (const path of listFiles(root)) {
    const hits = stringsIn(path, readFileSync(path, "utf8"))
      .filter(isCandidate)
      .map((s) => s.text);
    if (hits.length === 0) continue;
    byFile.set(relative(root, path).split("\\").join("/"), hits);
    total += hits.length;
  }
  return { total, byFile };
}

/**
 * Per file, as design:check: one file's count may not exceed what the baseline records for it (a
 * file the baseline does not list may have none). The baseline is read from the tree being
 * checked, so a pull request is held to its own base, whatever main did meanwhile.
 */
export interface Baseline {
  readonly note: string;
  readonly total: number;
  readonly files: Readonly<Record<string, number>>;
}

/** Files above their baseline, each with the strings it may have gained. */
export function grownFiles(count: CopyCount, baseline: Baseline): string[] {
  const lines: string[] = [];
  for (const [file, hits] of count.byFile) {
    const allowed = baseline.files[file] ?? 0;
    if (hits.length <= allowed) continue;
    lines.push(`  ${file}: ${allowed} -> ${hits.length}`);
    for (const text of hits.slice(-Math.min(5, hits.length - allowed))) {
      lines.push(`    + ${text.slice(0, 80)}`);
    }
  }
  return lines;
}

/**
 * The baseline `--update` writes: the current counts, so moving a string from one file to another
 * is recorded, but never a higher total. Undefined when the total went up.
 */
export function nextBaseline(
  count: CopyCount,
  previous: Baseline | undefined,
): Baseline | undefined {
  if (previous && count.total > previous.total) return undefined;
  return {
    note: "Sentence-like Chinese strings in apps/web/src per file (scripts/check-copy-ratchet.ts). No file may go above its number; `bun run copy:check --update` records lower counts and never a higher total.",
    total: count.total,
    files: Object.fromEntries(
      [...count.byFile].map(([file, hits]) => [file, hits.length]).toSorted(),
    ),
  };
}

function readBaseline(): Baseline | undefined {
  return existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline)
    : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const count = countCopy(defaultRoot);
  const baseline = readBaseline();
  if (args.includes("--list")) {
    for (const [file, hits] of count.byFile)
      for (const text of hits) console.log(`${file}\t${text}`);
  }
  if (args.includes("--update")) {
    const next = nextBaseline(count, baseline);
    if (!next) {
      console.error(
        `copy ratchet: ${count.total} is above the baseline total ${baseline?.total}; the baseline is never raised.`,
      );
      process.exit(1);
    }
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`copy ratchet: baseline set to ${next.total}.`);
    process.exit(0);
  }
  if (!baseline) {
    console.error("copy ratchet: scripts/copy-ratchet-baseline.json is missing.");
    process.exit(1);
  }
  const grown = grownFiles(count, baseline);
  if (grown.length > 0) {
    console.error(
      "copy ratchet: sentence-like strings in apps/web went up. Explanatory or decorative text is not added (agents/RULES.md); a string a person needs in order to act is said so in the pull request, and another one goes.",
    );
    for (const line of grown) console.error(line);
    process.exit(1);
  }
  console.log(
    `copy ratchet: ${count.total} sentence-like strings in apps/web (baseline ${baseline.total})${count.total < baseline.total ? "; record the lower count with `bun run copy:check --update`" : ""}.`,
  );
}
