import { describe, expect, it } from "vitest";
import { decodePythonBytesLiteral, normalizeTextPayload } from "./textPayload";

describe("text payload bytes repr", () => {
  it.each([
    [String.raw`b'parity10 live ab\n'`, "parity10 live ab\n"],
    [
      String.raw`b"two\nlines\twith \"quotes\" and \\slashes"`,
      'two\nlines\twith "quotes" and \\slashes',
    ],
    [String.raw`b'\xe4\xbd\xa0\xe5\xa5\xbd\n'`, "你好\n"],
    [String.raw`b'\150\151\012'`, "hi\n"],
    ["b''", ""],
    [" b'hello'\n", "hello"],
  ])("decodes a complete textual payload %s", (raw, expected) => {
    expect(decodePythonBytesLiteral(raw)).toBe(expected);
  });

  it.each([
    "17 hello.txt\n",
    "print(b'hello')",
    "b'one' + b'two'",
    "b'unfinished",
    "b'raw'quote'",
    String.raw`b'\xzz'`,
    String.raw`b'\xff'`,
    String.raw`b'\000'`,
    String.raw`b'\x1b[31m'`,
    String.raw`b'\777'`,
    String.raw`b'\u0041'`,
    "b'你好'",
    "b'''hello'''",
    "b'hello\nworld'",
  ])("preserves code, incomplete data and non-text bytes %s", (raw) => {
    expect(decodePythonBytesLiteral(raw)).toBeNull();
    expect(normalizeTextPayload(raw)).toBe(raw);
  });
});
