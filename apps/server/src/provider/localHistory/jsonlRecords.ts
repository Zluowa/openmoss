// FILE: jsonlRecords.ts
// Purpose: Stream object records from an agent's append-only JSONL transcript with bounded memory.
// Layer: Provider local-history parsing
// Exports: readJsonlRecords

import { createReadStream } from "node:fs";

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface JsonlReadOptions {
  /** Start inside a transcript, skipping any partial first record. */
  readonly startByte?: number;
  /** Stop reading after this many bytes from the start position. */
  readonly maxBytes?: number;
  /** Skip (do not parse) any single line longer than this. */
  readonly maxLineBytes?: number;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const record: unknown = JSON.parse(line);
    return record && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Yields each well-formed JSON object line. Malformed, non-object, and oversized lines are
 * skipped so one bad record never hides the rest of a conversation. A file that disappears
 * while it is being read ends the stream quietly.
 */
export async function* readJsonlRecords(
  file: string,
  options: JsonlReadOptions = {},
): AsyncGenerator<Record<string, unknown>> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const start = options.startByte ?? 0;
  const stream = createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
    start,
    ...(options.maxBytes ? { end: start + options.maxBytes - 1 } : {}),
  });
  const parts: string[] = [];
  let bytes = 0;
  let skippingLine = start > 0;
  try {
    for await (const chunk of stream) {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf("\n", offset);
        if (!skippingLine) {
          const part = chunk.slice(offset, newline < 0 ? undefined : newline);
          bytes += Buffer.byteLength(part);
          if (bytes > maxLineBytes) {
            parts.length = 0;
            skippingLine = true;
          } else {
            parts.push(part);
          }
        }
        if (newline < 0) break;
        if (!skippingLine) {
          const record = parseRecord(parts.join(""));
          if (record) yield record;
        }
        parts.length = 0;
        bytes = 0;
        skippingLine = false;
        offset = newline + 1;
      }
    }
    if (!skippingLine) {
      const record = parseRecord(parts.join(""));
      if (record) yield record;
    }
  } catch (error) {
    // A source can disappear while the user is choosing what to import.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    stream.destroy();
  }
}
