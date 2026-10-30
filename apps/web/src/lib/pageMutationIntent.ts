import { PagesMutateInput } from "@synara/contracts";
import { Schema } from "effect";

export function pageOperationKey(input: Readonly<Record<string, unknown>>): string {
  const {
    requestId: _requestId,
    scopeSpaceId: _scope,
    pageId: _pageId,
    expectedRevision: _revision,
    ...operation
  } = input;
  return JSON.stringify(Object.entries(operation).sort(([a], [b]) => a.localeCompare(b)));
}

/** A durable intent survives a lost reply, page changes and renderer reloads.
 * A new action cannot replace an unresolved action under the same key. */
export class PageMutationIntent {
  pending: PagesMutateInput | null = null;
  error: string | null = null;
  constructor(
    private readonly key: string,
    private readonly accepts: (input: PagesMutateInput) => boolean,
  ) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const value = Schema.decodeUnknownSync(PagesMutateInput)(JSON.parse(raw));
      if (!accepts(value)) throw new Error("Saved Page action belongs to a different scope");
      this.pending = value;
    } catch {
      this.error = "待确认操作的本机记录无法读取，请保留此窗口后重试。";
    }
  }
  remember(input: PagesMutateInput): PagesMutateInput {
    if (this.error) throw new Error(this.error);
    if (!this.accepts(input)) throw new Error("页面操作的工作区已变化。");
    const raw = localStorage.getItem(this.key);
    if (raw) {
      const saved = Schema.decodeUnknownSync(PagesMutateInput)(JSON.parse(raw));
      if (!this.accepts(saved)) throw new Error("已有待确认操作属于另一工作区。");
      this.pending = saved;
    }
    if (this.pending) {
      if (pageOperationKey(this.pending) !== pageOperationKey(input))
        throw new Error("上次操作的结果尚未确认，请先核对同一次操作。");
      return this.pending;
    }
    // Refuse the write if its reconciliation identity cannot be retained.
    localStorage.setItem(this.key, JSON.stringify(input));
    this.pending = input;
    return input;
  }
  async submit<A>(
    input: PagesMutateInput,
    write: (pending: PagesMutateInput) => Promise<A>,
  ): Promise<A> {
    const run = () => write(this.remember(input));
    // A second renderer cannot replace an unresolved request between the
    // journal check and the server write. The server still owns CAS/dedup.
    if (typeof navigator !== "undefined" && navigator.locks)
      return navigator.locks.request(`moss:pages:${this.key}`, run);
    return run();
  }
  clear() {
    const raw = localStorage.getItem(this.key);
    if (raw && this.pending) {
      const current = Schema.decodeUnknownSync(PagesMutateInput)(JSON.parse(raw));
      if (current.requestId === this.pending.requestId) localStorage.removeItem(this.key);
    }
    this.pending = null;
  }
}

/** Only a typed server verdict confirms rejection. Transport errors remain unknown. */
export function isPageMutationRejected(error: unknown): boolean {
  const seen = new Set<unknown>();
  let value = error;
  while (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      record._tag === "PagesRpcError" &&
      ["invalid", "forbidden", "not-found", "conflict", "cycle"].includes(String(record.code))
    )
      return true;
    value = record.cause;
  }
  return false;
}
