import { AutomationCreateInput } from "@synara/contracts";
import { Schema } from "effect";

function safeInput(input: AutomationCreateInput): AutomationCreateInput {
  // Instance launch options come from the server's registry. Never put their
  // possible credentials in a renderer's durable creation journal.
  const { providerOptions: _providerOptions, ...safe } = input;
  return Schema.decodeUnknownSync(AutomationCreateInput)(safe);
}

function operationKey(input: AutomationCreateInput): string {
  const { requestId: _requestId, ...operation } = safeInput(input);
  return JSON.stringify(
    Object.entries(operation).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** One unresolved creation per account/context, retained across close and reload. */
export class AutomationCreateIntent {
  pending: AutomationCreateInput | null = null;
  error: string | null = null;
  constructor(private readonly key: string) {
    try {
      this.pending = this.read();
    } catch {
      this.error = "The saved creation cannot be read. Preserve this window and retry.";
    }
  }
  private read(): AutomationCreateInput | null {
    const raw = localStorage.getItem(this.key);
    if (!raw) return null;
    const input = safeInput(JSON.parse(raw));
    if (!input.requestId) throw new Error("Saved creation is missing its request identity.");
    return input;
  }
  remember(input: AutomationCreateInput): AutomationCreateInput {
    if (this.error) throw new Error(this.error);
    const saved = this.read();
    if (saved) this.pending = saved;
    if (this.pending) {
      if (operationKey(this.pending) !== operationKey(input))
        throw new Error(
          "A previous creation is still awaiting confirmation. Confirm it before creating another automation.",
        );
      return this.pending;
    }
    const next = safeInput(input);
    if (!next.requestId) throw new Error("An automation creation requires a request identity.");
    localStorage.setItem(this.key, JSON.stringify(next));
    this.pending = next;
    return next;
  }
  async submit<T>(
    input: AutomationCreateInput,
    create: (input: AutomationCreateInput) => Promise<T>,
  ) {
    const run = () => create(this.remember(input));
    if (typeof navigator !== "undefined" && navigator.locks)
      return navigator.locks.request(`moss:automation-create:${this.key}`, run);
    return run();
  }
  clear() {
    const saved = this.read();
    if (saved?.requestId === this.pending?.requestId) localStorage.removeItem(this.key);
    this.pending = null;
  }
}

/** Only the server's committed rejection receipt permits a different request. */
export function isAutomationCreateRejected(error: unknown): boolean {
  const seen = new Set<unknown>();
  let value = error;
  while (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record._tag === "WsRpcError" && record.code === "AUTOMATION_CREATE_REJECTED") return true;
    value = record.cause;
  }
  return false;
}
