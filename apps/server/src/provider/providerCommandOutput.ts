// Native Windows CLIs may write their ANSI code page even when the console uses UTF-8.
import { decodeNativeOutput } from "@moss/shared/platformEncoding";

export { readWindowsAnsiEncoding } from "@moss/shared/platformEncoding";

/**
 * UTF-8, with any line that is not UTF-8 decoded in `fallbackEncoding` (callers pass the
 * system code page from {@link readWindowsAnsiEncoding}; unknown stays UTF-8).
 */
export function decodeProviderCommandOutput(
  chunks: ReadonlyArray<Uint8Array>,
  fallbackEncoding?: string,
): string {
  return decodeNativeOutput(Buffer.concat(chunks), fallbackEncoding ?? "utf-8");
}
