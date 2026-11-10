import { randomBytes } from "node:crypto";

/** Short-lived comparison tokens for a local owner menu. They never grant a
 * login or provisioning capability, and are not stored on disk. */
export class SpaceSyncObservations {
  private readonly tokens = new Map<
    string,
    { key: string; version: string; revision: number; binding: string | null; expires: number }
  >();
  issue(key: string, version: string, revision: number, binding: string | null) {
    const now = Date.now();
    for (const [token, entry] of this.tokens) if (entry.expires <= now) this.tokens.delete(token);
    if (this.tokens.size >= 128) this.tokens.delete(this.tokens.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { key, version, revision, binding, expires: now + 60_000 });
    return token;
  }
  claim(token: string | undefined, key: string, version: string, revision: number | null) {
    const entry = token && this.tokens.get(token);
    if (
      !entry ||
      entry.expires <= Date.now() ||
      entry.key !== key ||
      entry.version !== version ||
      entry.revision !== revision
    )
      return null;
    this.invalidate(key);
    return entry;
  }
  invalidate(key?: string) {
    if (key === undefined) {
      this.tokens.clear();
      return;
    }
    for (const [token, entry] of this.tokens) if (entry.key === key) this.tokens.delete(token);
  }
}
