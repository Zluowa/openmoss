// The spreadsheet engine's formula parser ships without type declarations.
declare module "@fortune-sheet/formula-parser" {
  export class Parser {
    on(event: string, listener: (...args: never[]) => void): void;
    parse(expression: string): { result: unknown; error: string | null };
  }
}
