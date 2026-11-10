// FILE: jsonlRecords.ts
// Purpose: Stream object records from an agent's append-only JSONL transcript with bounded memory.
// Layer: Provider local-history parsing
// Exports: readJsonlRecords

import { createReadStream } from "node:fs";

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface JsonlReadOptions {
  /** Stop reading after this many bytes of the file. */
  readonly maxBytes?: number;
  /** Skip (do not parse) any single line longer than this. */
  readonly maxLineBytes?: number;
}

function parseRecord(line: string, maxLineBytes: number): Record<string, unknown> | undefined {
  if (line.trim().length === 0 || Buffer.byteLength(line) > maxLineBytes) return undefined;
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
  const stream = createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
    ...(options.maxBytes ? { end: options.maxBytes - 1 } : {}),
  });
  let pending = "";
  let skippingLine = false;
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (skippingLine) {
          skippingLine = false;
          continue;
        }
        const record = parseRecord(line, maxLineBytes);
        if (record) yield record;
      }
      if (Buffer.byteLength(pending) > maxLineBytes) {
        pending = "";
        skippingLine = true;
      }
    }
    if (!skippingLine) {
      const record = parseRecord(pending, maxLineBytes);
      if (record) yield record;
    }
  } catch (error) {
    // A source can disappear while the user is choosing what to import.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    stream.destroy();
  }
}
