import type { RemoteComputerConnection, RemoteComputerState } from "@moss/contracts";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { VaultKeyStore } from "./browserAutomation/vaultKeyProtection";

type RecordEntry = { connection: RemoteComputerConnection; encryptedToken: string };
type Operation = { controller: AbortController; generation: number };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export function remoteComputerOrigin(value: unknown): string {
  if (!text(value, 2048)) throw new Error("invalid-address");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid-address");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("invalid-address");
  return url.origin;
}
function idValue(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("invalid-connection");
  return id;
}
function expires(value: unknown): value is string {
  return text(value, 64) && Number.isFinite(Date.parse(value));
}
function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "connection-failed";
  return new Set([
    "invalid-address",
    "invalid-connection",
    "secure-storage-unavailable",
    "needs-pairing",
    "cancelled",
    "connection-limit",
    "connection-exists",
    "connection-busy",
    "invalid-response",
    "storage-failed",
  ]).has(code)
    ? code
    : "connection-failed";
}
export interface RemoteComputersOptions {
  readonly rootDir: string;
  readonly keyStore: VaultKeyStore;
  readonly fetch?: typeof fetch;
  readonly sessionCheckIntervalMs?: number;
  readonly openWorkspace: (input: {
    id: string;
    name: string;
    origin: string;
    token: string;
    signal: AbortSignal;
    onClosed: () => void;
  }) => Promise<() => void>;
}

/** Pairing consumes a one-use server credential. The resulting bearer is OS-encrypted at rest,
 * and is never returned through IPC, placed in a URL, or written to a log. */
export class RemoteComputersManager {
  private records = new Map<string, RecordEntry>();
  private states = new Map<string, RemoteComputerState>();
  private operations = new Map<string, Operation>();
  private generations = new Map<string, number>();
  private windows = new Map<string, () => void>();
  private removing = new Map<string, AbortController>();
  private monitors = new Map<
    string,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >();
  private loadPromise?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;
  constructor(private readonly options: RemoteComputersOptions) {}
  private get file() {
    return join(this.options.rootDir, "connections.json");
  }
  private load(): Promise<void> {
    return (this.loadPromise ??= (async () => {
      try {
        const file = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let value: unknown;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 1_048_576) throw new Error("storage-failed");
          const buffer = Buffer.alloc(1_048_577);
          const result = await file.read(buffer, 0, buffer.length, 0);
          if (result.bytesRead > 1_048_576) throw new Error("storage-failed");
          value = JSON.parse(buffer.subarray(0, result.bytesRead).toString("utf8"));
        } finally {
          await file.close();
        }
        if (!Array.isArray(value) || value.length > 100) throw new Error("storage-failed");
        const entries = new Map<string, RecordEntry>();
        for (const item of value) {
          const c = item?.connection;
          if (
            !c ||
            !UUID.test(c.id) ||
            !text(c.displayName, 100) ||
            !expires(c.expiresAt) ||
            !text(item.encryptedToken, 32768) ||
            !/^[A-Za-z0-9+/]+={0,2}$/u.test(item.encryptedToken) ||
            entries.has(c.id)
          )
            throw new Error("storage-failed");
          const connection = {
            id: c.id,
            displayName: c.displayName,
            expiresAt: c.expiresAt,
            origin: remoteComputerOrigin(c.origin),
          };
          entries.set(c.id, { connection, encryptedToken: item.encryptedToken });
        }
        this.records = entries;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("storage-failed");
      }
    })());
  }
  private mutate(fn: (next: Map<string, RecordEntry>) => void): Promise<void> {
    const result = this.writes.then(async () => {
      const next = new Map(this.records);
      fn(next);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        await writeFile(temp, JSON.stringify([...next.values()]), { flag: "wx", mode: 0o600 });
        await rename(temp, this.file);
        this.records = next;
      } catch {
        throw new Error("storage-failed");
      } finally {
        await unlink(temp).catch(() => undefined);
      }
    });
    this.writes = result.catch(() => undefined);
    return result;
  }
  private begin(id: string): Operation {
    this.cancelPairing(id);
    if (this.disposed) throw new Error("cancelled");
    const op = { controller: new AbortController(), generation: this.generations.get(id) ?? 0 };
    this.operations.set(id, op);
    return op;
  }
  private assertCurrent(id: string, op: Operation) {
    if (
      this.disposed ||
      op.controller.signal.aborted ||
      this.operations.get(id) !== op ||
      (this.generations.get(id) ?? 0) !== op.generation
    )
      throw new Error("cancelled");
  }
  private async request(
    origin: string,
    path: string,
    op: Operation,
    body?: unknown,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(15_000);
    const response = await (this.options.fetch ?? fetch)(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.any([op.controller.signal, timeout]),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new Error("needs-pairing");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("connection-failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw new Error("invalid-response");
        chunks.push(value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result === null || Array.isArray(result) || typeof result !== "object")
        throw new Error("invalid-response");
      return result as Record<string, unknown>;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async list(): Promise<ReadonlyArray<RemoteComputerState>> {
    await this.load();
    return [...this.records.values()].map<RemoteComputerState>(
      ({ connection }) =>
        this.states.get(connection.id) ?? {
          connection,
          status: Date.parse(connection.expiresAt) <= Date.now() ? "needs-pairing" : "disconnected",
        },
    );
  }
  async pair(input: {
    id: string;
    displayName: string;
    origin: string;
    credential: string;
  }): Promise<RemoteComputerState> {
    const id = idValue(input?.id);
    const origin = remoteComputerOrigin(input.origin);
    if (!text(input.displayName, 100) || !input.displayName.trim() || !text(input.credential, 4096))
      throw new Error("invalid-connection");
    const op = this.begin(id);
    let token: string | undefined;
    let pairedEntry: RecordEntry | undefined;
    try {
      await this.load();
      this.assertCurrent(id, op);
      if (this.records.has(id)) throw new Error("connection-exists");
      if (this.records.size >= 100) throw new Error("connection-limit");
      if (!(await this.options.keyStore.available())) throw new Error("secure-storage-unavailable");
      this.assertCurrent(id, op);
      const result = await this.request(origin, "/api/auth/bootstrap/bearer", op, {
        credential: input.credential,
      });
      if (text(result.sessionToken, 8192)) token = result.sessionToken;
      if (
        result.authenticated !== true ||
        result.sessionMethod !== "bearer-session-token" ||
        result.role !== "client" ||
        !text(result.sessionToken, 8192) ||
        !expires(result.expiresAt) ||
        Date.parse(result.expiresAt) <= Date.now()
      )
        throw new Error("invalid-response");
      this.assertCurrent(id, op);
      const entry: RecordEntry = {
        connection: {
          id,
          displayName: input.displayName.trim(),
          origin,
          expiresAt: result.expiresAt,
        },
        encryptedToken: this.options.keyStore.encrypt(result.sessionToken).toString("base64"),
      };
      pairedEntry = entry;
      await this.mutate((next) => {
        this.assertCurrent(id, op);
        if (next.size >= 100 || next.has(id)) throw new Error("connection-limit");
        next.set(id, entry);
      });
      this.assertCurrent(id, op);
      const state: RemoteComputerState = { connection: entry.connection, status: "disconnected" };
      this.states.set(id, state);
      return state;
    } catch (error) {
      // A late reply may have consumed the pairing code. Revoke the newly issued
      // session without retaining it when the local operation was cancelled.
      const cancelled = op.controller.signal.aborted || this.disposed;
      if (cancelled && pairedEntry && this.records.get(id) === pairedEntry) {
        await this.mutate((next) => {
          if (next.get(id) === pairedEntry) next.delete(id);
        });
        if (!this.records.has(id)) this.states.delete(id);
      }
      if (token && (!pairedEntry || this.records.get(id) !== pairedEntry)) {
        const cleanup = { controller: new AbortController(), generation: 0 };
        await this.request(origin, "/api/auth/logout", cleanup, {}, token).catch(() => undefined);
      }
      throw new Error(cancelled ? "cancelled" : errorCode(error));
    } finally {
      if (this.operations.get(id) === op) this.operations.delete(id);
    }
  }
  cancelPairing(id: string): void {
    idValue(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.operations.get(id)?.controller.abort();
    this.operations.delete(id);
  }
  private stopMonitor(id: string): void {
    const monitor = this.monitors.get(id);
    this.monitors.delete(id);
    if (monitor) {
      clearTimeout(monitor.timer);
      monitor.controller.abort();
    }
  }
  private monitorSession(id: string, entry: RecordEntry, token: string, close: () => void): void {
    this.stopMonitor(id);
    const controller = new AbortController();
    const interval = Math.max(25, this.options.sessionCheckIntervalMs ?? 30_000);
    const current = () =>
      !this.disposed &&
      this.windows.get(id) === close &&
      this.monitors.get(id)?.controller === controller;
    const schedule = () => {
      if (!current()) return;
      const timer = setTimeout(() => {
        void check();
      }, interval);
      timer.unref();
      this.monitors.set(id, { controller, timer });
    };
    const check = async () => {
      if (!current()) return;
      try {
        const session = await this.request(
          entry.connection.origin,
          "/api/auth/session",
          { controller, generation: 0 },
          undefined,
          token,
        );
        if (session.authenticated !== true || session.role !== "client")
          throw new Error("needs-pairing");
        schedule();
      } catch (error) {
        if (!current()) return;
        const code = errorCode(error);
        // Only the remote computer's own answer revokes access. A timeout or a
        // brief network drop keeps the window and checks again next interval.
        if (code !== "needs-pairing") return schedule();
        this.disconnect(id);
        this.states.set(id, {
          connection: entry.connection,
          status: "needs-pairing",
          errorCode: code,
        });
      }
    };
    const timer = setTimeout(() => {
      void check();
    }, interval);
    timer.unref();
    this.monitors.set(id, { controller, timer });
  }
  disconnect(id: string): void {
    this.cancelPairing(id);
    this.stopMonitor(id);
    const close = this.windows.get(id);
    this.windows.delete(id);
    close?.();
    const entry = this.records.get(id);
    if (entry) this.states.set(id, { connection: entry.connection, status: "disconnected" });
  }
  async connect(id: string): Promise<RemoteComputerState> {
    idValue(id);
    if (this.removing.has(id)) throw new Error("connection-busy");
    const initialGeneration = this.generations.get(id) ?? 0;
    await this.load();
    if (this.removing.has(id)) throw new Error("connection-busy");
    if ((this.generations.get(id) ?? 0) !== initialGeneration) throw new Error("cancelled");
    const entry = this.records.get(id);
    if (!entry) throw new Error("invalid-connection");
    if (this.windows.has(id)) return this.states.get(id)!;
    const op = this.begin(id);
    const set = (status: RemoteComputerState["status"], code?: string) => {
      const state: RemoteComputerState = {
        connection: entry.connection,
        status,
        ...(code ? { errorCode: code } : {}),
      };
      this.states.set(id, state);
      return state;
    };
    set("connecting");
    try {
      if (Date.parse(entry.connection.expiresAt) <= Date.now()) throw new Error("needs-pairing");
      if (!(await this.options.keyStore.available())) throw new Error("secure-storage-unavailable");
      this.assertCurrent(id, op);
      const token = this.options.keyStore.decrypt(Buffer.from(entry.encryptedToken, "base64"));
      if (!text(token, 8192)) throw new Error("needs-pairing");
      const session = await this.request(
        entry.connection.origin,
        "/api/auth/session",
        op,
        undefined,
        token,
      );
      if (session.authenticated !== true || session.role !== "client")
        throw new Error("needs-pairing");
      this.assertCurrent(id, op);
      let openedClose: (() => void) | undefined;
      const close = await this.options.openWorkspace({
        id,
        name: entry.connection.displayName,
        origin: entry.connection.origin,
        token,
        signal: op.controller.signal,
        onClosed: () => {
          if (openedClose && this.windows.get(id) === openedClose) {
            this.windows.delete(id);
            this.stopMonitor(id);
            this.cancelPairing(id);
            set("disconnected");
          }
        },
      });
      openedClose = close;
      try {
        this.assertCurrent(id, op);
      } catch (error) {
        close();
        throw error;
      }
      this.windows.set(id, close);
      this.monitorSession(id, entry, token, close);
      return set("connected");
    } catch (error) {
      this.assertCurrent(id, op);
      const code = errorCode(error);
      return set(code === "needs-pairing" ? "needs-pairing" : "failed", code);
    } finally {
      if (this.operations.get(id) === op) this.operations.delete(id);
    }
  }
  async remove(id: string): Promise<{ revoked: boolean }> {
    idValue(id);
    if (this.removing.has(id)) throw new Error("connection-busy");
    const controller = new AbortController();
    this.removing.set(id, controller);
    try {
      await this.load();
      const entry = this.records.get(id);
      if (!entry) throw new Error("invalid-connection");
      this.disconnect(id);
      let revoked = false;
      try {
        if (await this.options.keyStore.available()) {
          const token = this.options.keyStore.decrypt(Buffer.from(entry.encryptedToken, "base64"));
          const result = await this.request(
            entry.connection.origin,
            "/api/auth/logout",
            { controller, generation: 0 },
            {},
            token,
          );
          revoked = result.revoked === true;
        }
      } catch {
        /* Offline removal remains local; the caller reports that distinction. */
      }
      await this.mutate((next) => {
        if (next.get(id) === entry) next.delete(id);
      });
      this.states.delete(id);
      return { revoked };
    } finally {
      if (this.removing.get(id) === controller) this.removing.delete(id);
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.removing.values()) controller.abort();
    for (const id of new Set([...this.operations.keys(), ...this.windows.keys()]))
      this.disconnect(id);
  }
}
