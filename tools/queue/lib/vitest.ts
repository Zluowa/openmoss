// FILE: tools/queue/lib/vitest.ts
// Purpose: Reads a Vitest run's console output: the summary counts and the FAIL lines.
// Layer: tool library
// Exports: stripAnsi, parseVitest, VitestReport, VitestFailure, Counts

export interface Counts {
  readonly failed: number;
  readonly passed: number;
  readonly skipped: number;
  readonly total: number;
}

export interface VitestFailure {
  /** Path as Vitest prints it, relative to the run's root. */
  readonly file: string;
  /** `describe > … > test`; undefined when the whole file failed to load (a failed suite). */
  readonly name: string | undefined;
}

export interface VitestReport {
  /** A "Test Files" summary line was printed. */
  readonly summary: boolean;
  readonly files: Counts | undefined;
  readonly tests: Counts | undefined;
  /** Errors outside any test ("Errors  1 error", "Unhandled Errors"). */
  readonly errors: number;
  readonly failures: readonly VitestFailure[];
  readonly durationSeconds: number | undefined;
}

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  String.raw`${ESC}\[[0-9;?]*[ -/]*[@-~]|${ESC}\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\)`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function counts(rest: string): Counts {
  const pick = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(rest)?.[1] ?? 0);
  const total = Number(/\((\d+)\)\s*$/.exec(rest)?.[1] ?? 0);
  return { failed: pick("failed"), passed: pick("passed"), skipped: pick("skipped"), total };
}

/** ` FAIL  [|project|] <file> > <name…>` or ` FAIL  [|project|] <file> [ <file> ]`. */
export function parseFailLine(line: string): VitestFailure | undefined {
  const m = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S.*)$/.exec(line);
  if (!m) return undefined;
  const body = m[1]!.trim();
  const suite = /^(\S+)\s+\[\s*\S+\s*\]$/.exec(body);
  if (suite) return { file: suite[1]!, name: undefined };
  const at = body.indexOf(" > ");
  if (at < 0) return /\.[cm]?[jt]sx?$/.test(body) ? { file: body, name: undefined } : undefined;
  const file = body.slice(0, at).trim();
  if (!/\.[cm]?[jt]sx?$/.test(file)) return undefined;
  return { file, name: body.slice(at + 3).trim() };
}

export function parseVitest(raw: string): VitestReport {
  const text = stripAnsi(raw);
  let files: Counts | undefined;
  let tests: Counts | undefined;
  let errors = 0;
  let durationSeconds: number | undefined;
  const failures = new Map<string, VitestFailure>();
  for (const line of text.split("\n")) {
    const fail = parseFailLine(line);
    if (fail) {
      failures.set(`${fail.file}\u0000${fail.name ?? ""}`, fail);
      continue;
    }
    const summary = /^\s*(Test Files|Tests|Errors|Duration)\s{2,}(.*)$/.exec(line);
    if (!summary) {
      if (/Unhandled Errors? /.test(line) || /^\s*Vitest caught \d+ unhandled error/.test(line))
        errors = Math.max(errors, Number(/caught (\d+)/.exec(line)?.[1] ?? 1));
      continue;
    }
    const [, key, rest] = summary;
    if (key === "Test Files") files = counts(rest!);
    else if (key === "Tests") tests = counts(rest!);
    else if (key === "Errors") errors = Math.max(errors, Number(/(\d+)/.exec(rest!)?.[1] ?? 1));
    else if (key === "Duration") {
      const s = /^([\d.]+)(ms|s|m)\b/.exec(rest!.trim());
      if (s) durationSeconds = Number(s[1]) / (s[2] === "ms" ? 1000 : s[2] === "m" ? 1 / 60 : 1);
    }
  }
  return {
    summary: files !== undefined,
    files,
    tests,
    errors,
    failures: [...failures.values()],
    durationSeconds,
  };
}

/** A regular expression for `vitest -t` that matches these test names (by their last title). */
export function namePattern(names: readonly string[]): string {
  const titles = new Set<string>();
  for (const name of names) {
    let title = name.split(" > ").at(-1)!.trim();
    // Vitest shortens long interpolated titles with "…"; match the part it kept.
    const cut = title.indexOf("…");
    if (cut >= 0) title = title.slice(0, cut);
    if (title) titles.add(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  return [...titles].toSorted().join("|");
}
