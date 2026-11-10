// FILE: platformEncoding.ts
// Purpose: Resolves native command output encoding through the shared process boundary, and
//          decodes child-process output that Windows tools write in the system code page.
// Layer: Shared platform runtime

import path from "node:path";
import { TextDecoder } from "node:util";

import { resolveWindowsSystemRoot } from "./platformEnvironment";
import { execProcessFile, spawnProcessSync } from "./processRuntime";

const WINDOWS_CODE_PAGE_ENCODINGS: Readonly<Record<string, string>> = {
  "874": "windows-874",
  "932": "shift_jis",
  "936": "gbk",
  "949": "euc-kr",
  "950": "big5",
  "65001": "utf-8",
};

const ANSI_CODE_PAGE_ARGS = [
  "query",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
  "/v",
  "ACP",
] as const;

function windowsRegExecutable(): string {
  return path.win32.join(resolveWindowsSystemRoot(), "System32", "reg.exe");
}

/** The TextDecoder label for the ANSI code page in `reg query ... /v ACP` output. */
export function parseWindowsAnsiEncoding(regOutput: string): string | undefined {
  const codePage = /\bACP\s+REG_SZ\s+(\d+)/i.exec(regOutput)?.[1];
  const encoding = codePage
    ? (WINDOWS_CODE_PAGE_ENCODINGS[codePage] ?? `windows-${codePage}`)
    : undefined;
  if (!encoding) return undefined;
  try {
    return new TextDecoder(encoding).encoding;
  } catch {
    return undefined;
  }
}

let windowsAnsiEncoding: Promise<string | undefined> | undefined;
let windowsAnsiEncodingSync: { readonly value: string | undefined } | undefined;

export function readWindowsAnsiEncoding(): Promise<string | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  if (windowsAnsiEncodingSync) return Promise.resolve(windowsAnsiEncodingSync.value);
  return (windowsAnsiEncoding ??= new Promise((resolve) => {
    execProcessFile(
      windowsRegExecutable(),
      [...ANSI_CODE_PAGE_ARGS],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 4096 },
      (error, stdout) => {
        resolve(error ? undefined : parseWindowsAnsiEncoding(stdout));
      },
    );
  }));
}

/**
 * Synchronous form for callers that decode on the spot (log capture, stream decoders). It runs
 * `reg.exe` at most once per process, and only once some output turns out not to be UTF-8.
 */
export function readWindowsAnsiEncodingSync(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (windowsAnsiEncodingSync) return windowsAnsiEncodingSync.value;
  let value: string | undefined;
  try {
    const result = spawnProcessSync(windowsRegExecutable(), [...ANSI_CODE_PAGE_ARGS], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "pipe"],
    });
    value = result.status === 0 ? parseWindowsAnsiEncoding(result.stdout) : undefined;
  } catch {
    value = undefined;
  }
  windowsAnsiEncodingSync = { value };
  return value;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

function fallbackDecoder(encoding: string | undefined): TextDecoder {
  try {
    return new TextDecoder(encoding ?? "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

// CR and LF never occur inside a multibyte character of the Windows ANSI code pages
// (their trail bytes are 0x40 or higher), so lines can be decoded one by one.
function isLineBreak(byte: number | undefined): boolean {
  return byte === 0x0a || byte === 0x0d;
}

/**
 * Decodes child-process output as UTF-8 and, for any line that is not valid UTF-8, with the
 * fallback encoding (by default the Windows ANSI code page). One pipe can carry both: a Node
 * CLI writes UTF-8 while `cmd.exe` or `reg.exe` in the same pipe write their messages in GBK.
 */
export function decodeNativeOutput(bytes: Uint8Array, fallbackEncoding?: string): string {
  if (bytes.length === 0) return "";
  const whole = tryDecodeUtf8(bytes);
  if (whole !== null) return whole;
  const fallback = fallbackDecoder(fallbackEncoding ?? readWindowsAnsiEncodingSync());
  let text = "";
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && !isLineBreak(bytes[index])) continue;
    const end = index < bytes.length ? index + 1 : index;
    if (end > start) {
      const line = bytes.subarray(start, end);
      text += tryDecodeUtf8(line) ?? fallback.decode(line);
    }
    start = end;
  }
  return text;
}

/** Length of an unfinished UTF-8 sequence at the end of `bytes` (0 when it ends cleanly). */
function incompleteUtf8TailLength(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? back : 0;
  }
  return 0;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

export interface NativeOutputDecoder {
  /** Text that is complete so far; an unfinished line in a non-UTF-8 encoding is held back. */
  readonly write: (chunk: Uint8Array) => string;
  /** Flushes whatever is held back. */
  readonly end: () => string;
}

// A tail longer than this without a line break is decoded as is rather than held forever.
const MAX_HELD_TAIL_BYTES = 64 * 1024;

/**
 * Streaming form of {@link decodeNativeOutput} for piped stderr. UTF-8 passes through as soon
 * as it arrives (only a split character waits); a line in another encoding waits for its line
 * break so that a double-byte character split across chunks is not garbled.
 */
export function createNativeOutputDecoder(fallbackEncoding?: string): NativeOutputDecoder {
  let held: Uint8Array = new Uint8Array(0);
  return {
    write(chunk) {
      let bytes = concatBytes(held, chunk);
      held = new Uint8Array(0);
      let text = "";
      let lastBreak = bytes.length - 1;
      while (lastBreak >= 0 && !isLineBreak(bytes[lastBreak])) lastBreak--;
      if (lastBreak >= 0) {
        text += decodeNativeOutput(bytes.subarray(0, lastBreak + 1), fallbackEncoding);
        bytes = bytes.subarray(lastBreak + 1);
      }
      if (bytes.length === 0) return text;
      const head = bytes.subarray(0, bytes.length - incompleteUtf8TailLength(bytes));
      const headText = tryDecodeUtf8(head);
      if (headText !== null) {
        text += headText;
        held = bytes.slice(head.length);
      } else if (bytes.length > MAX_HELD_TAIL_BYTES) {
        text += decodeNativeOutput(bytes, fallbackEncoding);
      } else {
        held = bytes.slice();
      }
      return text;
    },
    end() {
      const text = decodeNativeOutput(held, fallbackEncoding);
      held = new Uint8Array(0);
      return text;
    },
  };
}
