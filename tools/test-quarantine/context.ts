// What the Vitest plugin hands the setup file, through Vitest's provide/inject.

/** `on` skips quarantined tests; `off` ignores the list; `only` runs quarantined tests alone. */
export type QuarantineMode = "on" | "off" | "only";

export interface QuarantineContext {
  readonly mode: QuarantineMode;
  /** Normalised absolute paths (forward slashes, lower case on Windows). */
  readonly wholeFiles: readonly string[];
  readonly tests: ReadonlyArray<{
    readonly file: string;
    readonly name: string;
    readonly id: string;
  }>;
  readonly lowerCasePaths: boolean;
}

export const PROVIDE_KEY = "mossTestQuarantine";

declare module "vitest" {
  export interface ProvidedContext {
    mossTestQuarantine: QuarantineContext;
  }
}

export function normalisePath(file: string, lowerCase: boolean): string {
  const slashed = file.replace(/\\/g, "/");
  return lowerCase ? slashed.toLowerCase() : slashed;
}

export function parseMode(value: string | undefined): QuarantineMode {
  if (value === undefined || value === "" || value === "on") return "on";
  if (value === "off" || value === "only") return value;
  throw new Error(`MOSS_TEST_QUARANTINE must be on, off or only (got "${value}")`);
}
