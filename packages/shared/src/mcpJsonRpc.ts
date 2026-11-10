// FILE: mcpJsonRpc.ts
// Purpose: Pure JSON-RPC SSE collection shared by desktop and regional connectors.
// Exports: SseJsonRpcCollector, jsonRpcRequestIds.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const idKey = (id: unknown): string => JSON.stringify(id);

/** Keys of the request ids a POST expects answers for; notifications have none. */
export function jsonRpcRequestIds(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.flatMap((message) =>
    isRecord(message) &&
    typeof message.method === "string" &&
    "id" in message &&
    message.id !== null &&
    message.id !== undefined
      ? [idKey(message.id)]
      : [],
  );
}

/**
 * Incremental `text/event-stream` reader that keeps the JSON-RPC messages
 * and reports when every expected response has arrived, so a stream the
 * server keeps open does not stall the proxy until its deadline.
 */
export class SseJsonRpcCollector {
  private readonly decoder = new TextDecoder();
  private readonly pending: Set<string>;
  private buffer = "";
  private carriageReturn = false;
  readonly messages: unknown[] = [];

  constructor(private readonly expectedIds: ReadonlyArray<string>) {
    this.pending = new Set(expectedIds);
  }

  /** Feeds one chunk; true once all expected responses were seen. */
  push(chunk: Uint8Array): boolean {
    let text = this.decoder.decode(chunk, { stream: true });
    if (this.carriageReturn) text = `\r${text}`;
    // A CRLF split across chunks must not read as two line breaks.
    this.carriageReturn = text.endsWith("\r");
    if (this.carriageReturn) text = text.slice(0, -1);
    this.buffer += text.replace(/\r\n?/gu, "\n");
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      this.readEvent(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");
    }
    return this.isComplete();
  }

  finish(): void {
    const rest = this.buffer + this.decoder.decode() + (this.carriageReturn ? "\n" : "");
    this.buffer = "";
    this.carriageReturn = false;
    if (rest.trim()) this.readEvent(rest.replace(/\r\n?/gu, "\n"));
  }

  isComplete(): boolean {
    return this.expectedIds.length > 0 && this.pending.size === 0;
  }

  /** Responses to the expected ids, in request order. */
  responses(): unknown[] {
    const byId = new Map<string, unknown>();
    for (const message of this.messages) {
      if (isRecord(message) && "id" in message && ("result" in message || "error" in message)) {
        byId.set(idKey(message.id), message);
      }
    }
    return this.expectedIds.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
  }

  private readEvent(raw: string): void {
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n");
    if (!data.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      this.messages.push(message);
      if (isRecord(message) && "id" in message && ("result" in message || "error" in message)) {
        this.pending.delete(idKey(message.id));
      }
    }
  }
}
