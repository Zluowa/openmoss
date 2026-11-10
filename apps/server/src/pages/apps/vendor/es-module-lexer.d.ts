// Only the API used by Moss; upstream es-module-lexer 3.0.3 minimal build.
export interface ImportSpecifier {
  readonly n: string | undefined;
  readonly t: number;
  readonly s: number;
  readonly e: number;
  readonly d: number;
  readonly a: number;
}
export function parse(source: string): readonly [ReadonlyArray<ImportSpecifier>, ReadonlyArray<unknown>];
export const init: () => Promise<void>;
