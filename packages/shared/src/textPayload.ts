/**
 * Decode a complete Python bytes repr used as a text result. This is a parser,
 * never an evaluator: expressions, malformed literals, binary data and invalid
 * UTF-8 remain unchanged at the call site.
 */
export function decodePythonBytesLiteral(value: string): string | null {
  const literal = value.trim();
  if (!/^b['"]/i.test(literal)) return null;
  const quote = literal[1];
  if (literal.length < 3 || literal.at(-1) !== quote) return null;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, r: 13, t: 9, "\\": 92, "'": 39, '"': 34 };
  for (let index = 2; index < literal.length - 1; index += 1) {
    const char = literal[index]!;
    if (char === "\\") {
      index += 1;
      const escape = literal[index];
      if (!escape || index >= literal.length - 1) return null;
      if (escape === "x") {
        const hex = literal.slice(index + 1, index + 3);
        if (!/^[\da-f]{2}$/i.test(hex)) return null;
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
      } else if (/[0-7]/.test(escape)) {
        const octal = /^[0-7]{1,3}/.exec(literal.slice(index))![0];
        const byte = Number.parseInt(octal, 8);
        if (byte > 255) return null;
        bytes.push(byte);
        index += octal.length - 1;
      } else {
        const byte = escapes[escape];
        if (byte === undefined) return null;
        bytes.push(byte);
      }
    } else {
      const byte = char.charCodeAt(0);
      if (char === quote || byte < 32 || byte > 126) return null;
      bytes.push(byte);
    }
  }
  // Preserve binary/control payloads as repr rather than hiding their bytes or
  // introducing terminal controls into the visible transcript.
  if (
    bytes.some((byte) => (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)
  ) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export function normalizeTextPayload(value: string): string {
  return decodePythonBytesLiteral(value) ?? value;
}
