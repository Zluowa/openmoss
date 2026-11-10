// FILE: spdx.ts
// Purpose: Picks one permissive branch of a crate's SPDX license expression, or reports that none exists.
// Layer: Release/build helper (agent runtime bumps)

/**
 * Licenses Moss may redistribute inside a closed desktop binary without source obligations.
 * Order is the preference used when an expression offers a choice (`MIT OR Apache-2.0` -> MIT).
 */
export const APPROVED_CRATE_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-3-Clause",
  "BSD-2-Clause",
  "ISC",
  "Zlib",
  "0BSD",
  "MIT-0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "BSL-1.0",
  "CC0-1.0",
  "Unlicense",
  "CDLA-Permissive-2.0",
  "WTFPL",
  // BSD-style: keep the notice, mark altered versions (libbz2-rs-sys, new in Codex 0.166).
  "bzip2-1.0.6",
  // File-level copyleft only: the bundled binaries do not modify MPL-covered files.
  "MPL-2.0",
] as const;

export const APPROVED_LICENSE_EXCEPTIONS = ["LLVM-exception"] as const;

const RANK = new Map<string, number>(APPROVED_CRATE_LICENSES.map((id, index) => [id, index]));

type Node =
  | { readonly kind: "id"; readonly id: string; readonly exception?: string }
  | { readonly kind: "and" | "or"; readonly items: readonly Node[] };

function tokenize(expression: string): string[] {
  // Cargo still accepts the legacy `MIT/Apache-2.0` form, which means OR.
  return expression
    .replace(/\s*\/\s*/gu, " OR ")
    .replace(/\(/gu, " ( ")
    .replace(/\)/gu, " ) ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

export function parseSpdxExpression(expression: string): Node {
  const tokens = tokenize(expression);
  let position = 0;
  const peek = () => tokens[position];
  const parsePrimary = (): Node => {
    const token = tokens[position++];
    if (token === undefined) throw new Error(`Incomplete SPDX expression: ${expression}`);
    if (token === "(") {
      const inner = parseOr();
      if (tokens[position++] !== ")") throw new Error(`Unbalanced SPDX expression: ${expression}`);
      return inner;
    }
    if (/^(?:AND|OR|WITH|\))$/iu.test(token)) {
      throw new Error(`Unexpected ${token} in SPDX expression: ${expression}`);
    }
    if (peek()?.toUpperCase() === "WITH") {
      position += 1;
      const exception = tokens[position++];
      if (!exception) throw new Error(`Missing exception in SPDX expression: ${expression}`);
      return { kind: "id", id: token, exception };
    }
    return { kind: "id", id: token };
  };
  const parseAnd = (): Node => {
    const items = [parsePrimary()];
    while (peek()?.toUpperCase() === "AND") {
      position += 1;
      items.push(parsePrimary());
    }
    return items.length === 1 ? items[0]! : { kind: "and", items };
  };
  const parseOr = (): Node => {
    const items = [parseAnd()];
    while (peek()?.toUpperCase() === "OR") {
      position += 1;
      items.push(parseAnd());
    }
    return items.length === 1 ? items[0]! : { kind: "or", items };
  };
  const result = parseOr();
  if (position !== tokens.length)
    throw new Error(`Trailing tokens in SPDX expression: ${expression}`);
  return result;
}

interface Selection {
  readonly atoms: readonly string[];
  readonly cost: number;
}

function select(node: Node): Selection | null {
  if (node.kind === "id") {
    // `Apache-2.0+` style suffixes still name the same license family.
    const id = node.id.replace(/\+$/u, "");
    const rank = RANK.get(id);
    if (rank === undefined) return null;
    if (node.exception !== undefined) {
      if (!(APPROVED_LICENSE_EXCEPTIONS as readonly string[]).includes(node.exception)) return null;
      return { atoms: [`${id} WITH ${node.exception}`], cost: rank };
    }
    return { atoms: [id], cost: rank };
  }
  if (node.kind === "and") {
    const parts = node.items.map(select);
    if (parts.some((part) => part === null)) return null;
    const atoms: string[] = [];
    for (const part of parts as Selection[]) {
      for (const atom of part.atoms) if (!atoms.includes(atom)) atoms.push(atom);
    }
    return { atoms, cost: Math.max(...(parts as Selection[]).map((part) => part.cost)) };
  }
  let best: Selection | null = null;
  for (const item of node.items) {
    const candidate = select(item);
    if (!candidate) continue;
    if (!best || candidate.cost < best.cost) best = candidate;
  }
  return best;
}

/**
 * Returns the selected expression (only AND/WITH, every id approved), or null when every branch
 * needs an unapproved license.
 */
export function selectPermissiveLicense(expression: string): string | null {
  const selection = select(parseSpdxExpression(expression));
  return selection ? selection.atoms.join(" AND ") : null;
}

/** The gate's check on an already selected expression. */
export function isApprovedSelection(selected: string): boolean {
  if (!selected || /\bOR\b|\//u.test(selected)) return false;
  return selected.split(" AND ").every((atom) => {
    const [id, exception, ...rest] = atom.split(" WITH ");
    if (rest.length > 0 || !RANK.has(id ?? "")) return false;
    return (
      exception === undefined ||
      (APPROVED_LICENSE_EXCEPTIONS as readonly string[]).includes(exception)
    );
  });
}
