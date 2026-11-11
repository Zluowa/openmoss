// Minimal argument parser: positionals, `--flag`, `--key value`, `--key=value`, and `--` rest.
export interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
  readonly rest: string[];
}

export function parseArgs(argv: readonly string[], valueFlags: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) flags.set(key, a.slice(eq + 1));
      else if (valueFlags.includes(key)) {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith("--")) throw new Error(`--${key} needs a value`);
        flags.set(key, v);
        i += 1;
      } else flags.set(key, true);
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags, rest };
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : undefined;
}
