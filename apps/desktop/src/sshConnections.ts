// FILE: sshConnections.ts
// Purpose: Own SSH host trust, saved connections, encrypted tunnels and remote Moss lifetimes.
// Layer: Desktop runtime
// Exports: SshConnectionManager, normalizeSshConnection, sshFailureCode
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeSshRemoteRuntimeScript } from "./sshRemoteRuntime";
import { listSshConfigHosts } from "./sshConfigHosts";
import { nativeSshProcessOwner, type SshProcessOwner } from "./sshProcessOwner";
import type { SshConnection, SshConnectionState } from "@moss/contracts";

type Draft = Omit<SshConnection, "id"> & { readonly id?: string };
type Session = {
  readonly controller: AbortController;
  readonly child: ChildProcessWithoutNullStreams;
  closeWorkspace?: () => void;
};
type PendingHostKey = {
  readonly connection: SshConnection;
  readonly generation: number;
  readonly hostLabel: string;
  readonly keys: string[];
  readonly expiresAt: number;
};
export interface SshManagerOptions {
  readonly rootDir: string;
  readonly version: string;
  readonly openWorkspace: (input: {
    readonly id: string;
    readonly name: string;
    readonly origin: string;
    readonly wsUrl: string;
    readonly onClosed: (reason?: "workspace-load") => void;
  }) => () => void;
  readonly run?: (file: string, args: readonly string[]) => Promise<string>;
  readonly spawn?: typeof spawn;
  readonly probe?: (origin: string, signal: AbortSignal) => Promise<boolean>;
  readonly reservePort?: () => Promise<number>;
  readonly startupTimeoutMs?: number;
  readonly runtimeArchive?: () => Promise<Buffer>;
  readonly publicEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly sshConfigFile?: string;
  readonly processOwner?: SshProcessOwner;
}

export function normalizeSshConnection(input: Draft): SshConnection {
  if (!input || typeof input !== "object") throw new Error("invalid-connection");
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!displayName || displayName.length > 80 || /[\r\n\0]/u.test(displayName))
    throw new Error("invalid-name");
  // user@host and SSH-config aliases are accepted. Options, commands, URLs,
  // whitespace and control characters never reach OpenSSH's argument parser.
  if (
    !/^(?:[a-zA-Z0-9_.-]+@)?(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/u.test(host) ||
    host.length > 300
  )
    throw new Error("invalid-host");
  if (
    input.port !== undefined &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
  )
    throw new Error("invalid-port");
  const identityFile = input.identityFile?.trim();
  if (identityFile && (identityFile.length > 4096 || /[\r\n\0]/u.test(identityFile)))
    throw new Error("invalid-identity");
  if (input.id !== undefined && !/^[a-f0-9-]{36}$/u.test(input.id))
    throw new Error("invalid-connection");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error("invalid-enabled");
  return {
    id: input.id ?? randomUUID(),
    displayName,
    host,
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(identityFile ? { identityFile } : {}),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };
}

export function sshFailureCode(text: string): string {
  // Health probes can produce harmless forward-channel refusal messages while
  // the remote runtime is preparing. Its explicit failure marker is decisive.
  if (/MOSS_REMOTE_RUNTIME_MISSING/u.test(text)) return "runtime-missing";
  if (/MOSS_REMOTE_PLATFORM_UNSUPPORTED/u.test(text)) return "runtime-platform";
  if (/MOSS_REMOTE_CHECKSUM_/u.test(text)) return "runtime-integrity";
  if (/MOSS_REMOTE_NATIVE_PREPARE_FAILED/u.test(text)) return "runtime-native";
  if (/MOSS_REMOTE_AGENT_PREPARE_FAILED/u.test(text)) return "runtime-agent";
  if (/MOSS_REMOTE_UPLOAD_INCOMPLETE/u.test(text)) return "runtime-upload";
  if (/MOSS_REMOTE_UPLOAD_BUSY/u.test(text)) return "runtime-busy";
  if (/MOSS_REMOTE_RUNTIME_INSTALL_FAILED/u.test(text)) return "runtime-install";
  if (/choose_kex: unsupported KEX method/iu.test(text)) return "keyscan-kex";
  if (
    /permission denied|authentication failed|no supported authentication|sign_and_send_pubkey/iu.test(
      text,
    )
  )
    return "authentication";
  if (/host key verification|remote host identification has changed/iu.test(text))
    return "host-key";
  if (/could not resolve|name or service not known|no such host/iu.test(text)) return "resolve";
  if (/connection refused/iu.test(text)) return "refused";
  if (/timed out|timeout/iu.test(text)) return "timeout";
  if (/npm ERR|E404/iu.test(text)) return "runtime-install";
  if (/ENOENT/u.test(text)) return "ssh-missing";
  return "connection";
}

export function sshKnownHostsOption(file: string): string {
  if (/[\r\n\0]/u.test(file)) throw new Error("invalid-identity");
  return `UserKnownHostsFile="${file.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: 12_000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(sshFailureCode(`${error.message}\n${stderr}`)));
        else resolve(stdout);
      },
    );
  });
}
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("connection"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
function keyLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/u);
      return fields.length === 3 &&
        /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/u.test(fields[1]!) &&
        /^[A-Za-z0-9+/]+={0,2}$/u.test(fields[2]!)
        ? [`${fields[1]} ${fields[2]}`]
        : [];
    })
    .sort();
}
function fingerprint(keys: readonly string[]): string {
  return `SHA256:${createHash("sha256")
    .update(Buffer.from(keys[0]!.split(" ")[1]!, "base64"))
    .digest("base64")
    .replace(/=+$/u, "")}`;
}

export class SshConnectionManager {
  private readonly records = new Map<string, SshConnection>();
  private readonly states = new Map<string, SshConnectionState>();
  private readonly sessions = new Map<string, Session>();
  private readonly connecting = new Map<string, Promise<SshConnectionState>>();
  private readonly generations = new Map<string, number>();
  private readonly pendingHostKeys = new Map<string, PendingHostKey>();
  private readonly preparing = new Map<string, AbortController>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly retiredChildren = new Map<string, ChildProcessWithoutNullStreams>();
  private loadPromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private closing = false;
  private disposal: Promise<void> | undefined;
  constructor(private readonly options: SshManagerOptions) {
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(options.version))
      throw new Error("invalid-version");
  }
  private async load(): Promise<void> {
    this.loadPromise ??= (async () => {
      let data: unknown;
      try {
        data = JSON.parse(await readFile(join(this.options.rootDir, "connections.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("storage");
      }
      if (!Array.isArray(data) || data.length > 100) throw new Error("storage");
      const loaded = data.map((value) => normalizeSshConnection(value));
      for (const connection of loaded) {
        this.records.set(connection.id, connection);
      }
    })().catch((error) => {
      this.loadPromise = undefined;
      throw error;
    });
    return this.loadPromise;
  }
  private async persist(): Promise<void> {
    const write = this.writeChain.then(async () => {
      await mkdir(this.options.rootDir, { recursive: true });
      const path = join(this.options.rootDir, "connections.json");
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify([...this.records.values()])}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    });
    this.writeChain = write.catch(() => undefined);
    return write;
  }
  async list(): Promise<SshConnectionState[]> {
    await this.load();
    return [...this.records.values()].map(
      (connection) => this.states.get(connection.id) ?? { connection, status: "disconnected" },
    );
  }
  async listConfigHosts() {
    return listSshConfigHosts(this.options.sshConfigFile);
  }
  async save(input: Draft): Promise<SshConnection> {
    await this.load();
    const connection = normalizeSshConnection(input);
    if (this.records.size >= 100 && !this.records.has(connection.id))
      throw new Error("connection-limit");
    await this.disconnect(connection.id);
    const previous = this.records.get(connection.id);
    this.records.set(connection.id, connection);
    this.states.delete(connection.id);
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.records.set(connection.id, previous);
      else this.records.delete(connection.id);
      throw error;
    }
    return connection;
  }
  async remove(id: string): Promise<void> {
    await this.load();
    if (!this.records.has(id)) throw new Error("missing-connection");
    const previous = this.records.get(id)!;
    await this.disconnect(id);
    this.records.delete(id);
    this.states.delete(id);
    try {
      await this.persist();
    } catch (error) {
      this.records.set(id, previous);
      throw error;
    }
    await unlink(join(this.options.rootDir, `${id}.known-hosts`)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
  disconnect(id: string): Promise<void> {
    this.pendingHostKeys.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.connecting.delete(id);
    this.preparing.get(id)?.abort();
    this.preparing.delete(id);
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    session?.controller.abort();
    session?.closeWorkspace?.();
    const connection = this.records.get(id);
    if (connection) this.states.set(id, { connection, status: "disconnected" });
    const ownedChild = session?.child ?? this.retiredChildren.get(id);
    if (!ownedChild) return this.retiring.get(id) ?? Promise.resolve();
    this.retiredChildren.set(id, ownedChild);
    let proof: Promise<void>;
    try {
      proof = (this.options.processOwner ?? nativeSshProcessOwner).stop(ownedChild);
    } catch {
      proof = Promise.reject(new Error("process-cleanup"));
    }
    const bounded = proof.catch(() => {
      throw new Error("process-cleanup");
    });
    this.retiring.set(id, bounded);
    void bounded.then(
      () => {
        if (this.retiring.get(id) === bounded) {
          this.retiring.delete(id);
          if (this.retiredChildren.get(id) === ownedChild) this.retiredChildren.delete(id);
        }
      },
      () => {
        if (
          this.retiring.get(id) === bounded &&
          connection &&
          this.records.get(id) === connection &&
          !this.sessions.has(id)
        )
          this.states.set(id, { connection, status: "failed", errorCode: "process-cleanup" });
      },
    );
    return bounded;
  }
  async connect(input: {
    readonly id: string;
    readonly trustFingerprint?: string | undefined;
  }): Promise<SshConnectionState> {
    await this.load();
    if (this.disposed || this.closing) throw new Error("missing-connection");
    let intendedGeneration = this.generations.get(input.id) ?? 0;
    const retiring = this.retiring.get(input.id);
    if (retiring) {
      try {
        await retiring;
      } catch {
        if (
          this.disposed ||
          this.closing ||
          (this.generations.get(input.id) ?? 0) !== intendedGeneration
        )
          return this.states.get(input.id)!;
        const retry = this.disconnect(input.id);
        intendedGeneration = this.generations.get(input.id) ?? 0;
        try {
          await retry;
        } catch {
          return this.states.get(input.id)!;
        }
      }
      if (
        this.disposed ||
        this.closing ||
        (this.generations.get(input.id) ?? 0) !== intendedGeneration
      )
        return this.states.get(input.id)!;
    }
    const pending = this.connecting.get(input.id);
    if (pending) return pending;
    const connection = this.records.get(input.id);
    if (!connection || this.disposed || this.closing) throw new Error("missing-connection");
    if (this.states.get(input.id)?.status === "connected") return this.states.get(input.id)!;
    const request = this.start(connection, input.trustFingerprint).finally(() => {
      if (this.connecting.get(input.id) === request) this.connecting.delete(input.id);
    });
    this.connecting.set(input.id, request);
    return request;
  }
  private async start(
    connection: SshConnection,
    trustedFingerprint?: string,
  ): Promise<SshConnectionState> {
    const generation = this.generations.get(connection.id) ?? 0;
    const current = () =>
      !this.disposed &&
      !this.closing &&
      this.records.get(connection.id) === connection &&
      (this.generations.get(connection.id) ?? 0) === generation;
    const assertCurrent = () => {
      if (!current()) throw new Error("cancelled");
    };
    const set = (state: Omit<SshConnectionState, "connection">) => {
      const result = { connection, ...state };
      this.states.set(connection.id, result);
      return result;
    };
    // Scan again after a strict host-key failure, while a new fingerprint is
    // waiting for approval, or when the person approves one. Approving after the
    // short pending-key cache expired must not fall back to the old pinned key
    // and fail the strict check a second time.
    const previousState = this.states.get(connection.id);
    const refreshHostKey =
      previousState?.errorCode === "host-key" ||
      previousState?.status === "host-key-required" ||
      trustedFingerprint !== undefined;
    set({ status: "connecting" });
    const controller = new AbortController();
    this.preparing.set(connection.id, controller);
    let stderr = "";
    try {
      const execute = this.options.run ?? run;
      const config = await execute("ssh", [
        "-G",
        ...(connection.port ? ["-p", String(connection.port)] : []),
        connection.host,
      ]);
      assertCurrent();
      if (/^(?:proxyjump|proxycommand) (?!none\s*$).+/mu.test(config))
        throw new Error("proxy-unsupported");
      const host = /^hostname (\S+)$/mu.exec(config)?.[1];
      const port = connection.port ?? Number(/^port (\d+)$/mu.exec(config)?.[1] ?? 22);
      if (!host || host.startsWith("-") || /[\s\0]/u.test(host)) throw new Error("invalid-host");
      const keyAlias = /^hostkeyalias (\S+)$/mu.exec(config)?.[1];
      const lookupHost = keyAlias && keyAlias !== "none" ? keyAlias : host;
      const hostLabel = port === 22 ? lookupHost : `[${lookupHost}]:${port}`;
      const hostFile = join(this.options.rootDir, `${connection.id}.known-hosts`);
      let previousKeys: string[] = [];
      let matchesPreviousHost = false;
      try {
        const previous = await readFile(hostFile, "utf8");
        previousKeys = keyLines(previous);
        matchesPreviousHost = previous
          .split(/\r?\n/u)
          .some((line) => line.trim().split(/\s/u)[0]?.split(",").includes(hostLabel));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const pending = this.pendingHostKeys.get(connection.id);
      const cached =
        pending !== undefined &&
        pending.connection === connection &&
        pending.generation === generation &&
        pending.hostLabel === hostLabel &&
        pending.expiresAt > Date.now()
          ? pending
          : undefined;
      let discoveredKeys: string[];
      if (cached) discoveredKeys = cached.keys;
      else if (previousKeys.length && matchesPreviousHost && !refreshHostKey) {
        // OpenSSH performs the authoritative strict check. Reconnecting to a
        // pinned host needs no unauthenticated scan or server-side penalty.
        discoveredKeys = previousKeys;
      } else
        try {
          discoveredKeys = keyLines(
            await execute("ssh-keyscan", ["-T", "5", "-p", String(port), host]),
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            (error.message !== "keyscan-kex" && sshFailureCode(error.message) !== "keyscan-kex")
          )
            throw error;
          // Some Windows keyscan builds cannot negotiate a newer server's KEX.
          // This disposable, unauthenticated transport observes a key only. It
          // never authorizes a workspace: the fingerprint gate below still does.
          await mkdir(this.options.rootDir, { recursive: true });
          const probePath = join(this.options.rootDir, `${randomUUID()}.host-key-probe`);
          await writeFile(probePath, "", { flag: "wx", mode: 0o600 });
          try {
            await execute("ssh", [
              "-F",
              "none",
              "-N",
              "-T",
              "-l",
              "moss-host-key-probe",
              "-p",
              String(port),
              "-o",
              "BatchMode=yes",
              "-o",
              "PreferredAuthentications=none",
              "-o",
              "PubkeyAuthentication=no",
              "-o",
              "PasswordAuthentication=no",
              "-o",
              "KbdInteractiveAuthentication=no",
              "-o",
              "GSSAPIAuthentication=no",
              "-o",
              "HostbasedAuthentication=no",
              "-o",
              "NumberOfPasswordPrompts=0",
              "-o",
              "IdentityAgent=none",
              "-o",
              "IdentitiesOnly=yes",
              "-o",
              "IdentityFile=none",
              "-o",
              "ControlMaster=no",
              "-o",
              "ControlPath=none",
              "-o",
              "ClearAllForwardings=yes",
              "-o",
              "ForwardAgent=no",
              "-o",
              "ForwardX11=no",
              "-o",
              "PermitLocalCommand=no",
              "-o",
              "RemoteCommand=none",
              "-o",
              "VerifyHostKeyDNS=no",
              "-o",
              "UpdateHostKeys=no",
              "-o",
              "ConnectTimeout=12",
              "-o",
              "StrictHostKeyChecking=accept-new",
              "-o",
              sshKnownHostsOption(probePath),
              "-o",
              "GlobalKnownHostsFile=none",
              "-o",
              "HostKeyAlgorithms=ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256",
              host,
            ]).catch(() => undefined); // Authentication failure is expected.
            discoveredKeys = keyLines(await readFile(probePath, "utf8"));
          } finally {
            await unlink(probePath);
          }
        }
      assertCurrent();
      const preferredKey =
        discoveredKeys.find((key) => key.startsWith("ssh-ed25519 ")) ?? discoveredKeys[0];
      const keys = preferredKey ? [preferredKey] : [];
      if (keys.length === 0) throw new Error("host-key");
      const currentFingerprint = fingerprint(keys);
      assertCurrent();
      const previousFingerprint = previousKeys.length ? fingerprint(previousKeys) : undefined;
      if (previousFingerprint !== currentFingerprint) {
        if (trustedFingerprint !== currentFingerprint) {
          this.pendingHostKeys.set(connection.id, {
            connection,
            generation,
            hostLabel,
            keys,
            expiresAt: Date.now() + 120_000,
          });
          return set({
            status: "host-key-required",
            fingerprint: currentFingerprint,
            ...(previousFingerprint ? { previousFingerprint } : {}),
          });
        }
        await mkdir(this.options.rootDir, { recursive: true });
        await writeFile(hostFile, `${keys.map((key) => `${hostLabel} ${key}`).join("\n")}\n`, {
          mode: 0o600,
        });
      }
      this.pendingHostKeys.delete(connection.id);
      const localPort = await (this.options.reservePort ?? reservePort)();
      assertCurrent();
      if (!this.options.runtimeArchive) throw new Error("runtime-payload");
      const payload = await this.options.runtimeArchive().catch(() => {
        throw new Error("runtime-payload");
      });
      assertCurrent();
      const remotePort = randomInt(30000, 55000);
      const token = randomBytes(32).toString("hex");
      const bootstrap = makeSshRemoteRuntimeScript({
        payload,
        token,
        port: remotePort,
        uploadId: connection.id,
        ...(this.options.publicEnvironment
          ? { publicEnvironment: this.options.publicEnvironment }
          : {}),
      });
      let session!: Session;
      let runtimeStarting = false;
      await (this.options.processOwner ?? nativeSshProcessOwner).spawn({
        beforeSpawn: assertCurrent,
        signal: controller.signal,
        spawn: () =>
          (this.options.spawn ?? spawn)(
            "ssh",
            [
              "-T",
              "-o",
              "BatchMode=yes",
              "-o",
              "ControlMaster=no",
              "-o",
              "ControlPath=none",
              "-o",
              "ConnectTimeout=12",
              "-o",
              "ExitOnForwardFailure=yes",
              "-o",
              "ForwardAgent=no",
              "-o",
              "ForwardX11=no",
              "-o",
              "PermitLocalCommand=no",
              "-o",
              "RemoteCommand=none",
              "-o",
              "ServerAliveInterval=15",
              "-o",
              "ServerAliveCountMax=3",
              "-o",
              "StrictHostKeyChecking=yes",
              "-o",
              sshKnownHostsOption(hostFile),
              "-o",
              "GlobalKnownHostsFile=none",
              "-o",
              `HostKeyAlgorithms=${keys[0]!.startsWith("ssh-rsa ") ? "rsa-sha2-512,rsa-sha2-256" : keys[0]!.split(" ")[0]}`,
              ...(connection.port ? ["-p", String(connection.port)] : []),
              ...(connection.identityFile
                ? ["-o", "IdentitiesOnly=yes", "-i", connection.identityFile]
                : []),
              "-L",
              `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
              connection.host,
              "sh -s",
            ],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
          ) as ChildProcessWithoutNullStreams,
        bind: (child) => {
          session = { controller, child };
          this.sessions.set(connection.id, session);
          const failed = (error?: unknown) => {
            if (this.sessions.get(connection.id) !== session) return;
            if (error instanceof Error) stderr = `${stderr}\n${error.message}`;
            void this.disconnect(connection.id).catch(() => undefined);
            set({ status: "failed", errorCode: sshFailureCode(stderr) });
          };
          child.once("error", failed);
          child.once("exit", failed);
          let payloadSent = false;
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-8192);
            if (
              this.sessions.get(connection.id) !== session ||
              !current() ||
              this.states.get(connection.id)?.status !== "connecting"
            )
              return;
            const ready = /(?:^|\n)MOSS_SSH_PAYLOAD_READY:(\d+)\r?\n/u.exec(stderr);
            if (ready && !payloadSent) {
              const offset = Number(ready[1]);
              if (!Number.isSafeInteger(offset) || offset < 0 || offset > payload.length) {
                failed(new Error("MOSS_REMOTE_CHECKSUM_FAILED"));
                return;
              }
              payloadSent = true;
              // A verified remote cache reports the full length. Sending no bytes
              // there is essential: an unconsumed duplicate would block this pipe.
              child.stdin.end(payload.subarray(offset));
            }
            const phase = [...stderr.matchAll(/MOSS_SSH_PROGRESS_(RUNTIME|AGENTS|STARTING)/gu)].at(
              -1,
            )?.[1];
            if (phase === "STARTING") runtimeStarting = true;
            if (phase)
              set({
                status: "connecting",
                phase: phase.toLowerCase() as "runtime" | "agents" | "starting",
              });
          });
          child.stdout.resume(); // Runtime output is never logged or surfaced to users.
          child.stdin.on("error", () => undefined);
          // Secrets cross stdin only. The remote helper belongs to this SSH channel:
          // no daemon, global package install, shell-profile edit or detached process.
          child.stdin.write(bootstrap);
          return child;
        },
      });

      const origin = `http://127.0.0.1:${localPort}`;
      const deadline = Date.now() + (this.options.startupTimeoutMs ?? 600_000);
      const probe =
        this.options.probe ??
        (async (url: string, signal: AbortSignal) => {
          try {
            const response = await fetch(`${url}/health`, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
              redirect: "error",
            });
            if (!response.ok) return false;
            const health = (await response.json()) as { startupReady?: boolean };
            return health.startupReady === true;
          } catch {
            return false;
          }
        });
      while (!controller.signal.aborted && Date.now() < deadline) {
        // The port cannot listen during download/upload/install. Avoid opening
        // refused forward channels throughout a slow bootstrap connection.
        if (!this.options.probe && !runtimeStarting) {
          await delay(500, undefined, { signal: controller.signal }).catch(() => undefined);
          continue;
        }
        if (await probe(origin, controller.signal)) {
          if (controller.signal.aborted || !current()) break;
          let closeWorkspace: () => void;
          try {
            closeWorkspace = this.options.openWorkspace({
              id: connection.id,
              name: connection.displayName,
              origin,
              wsUrl: `ws://127.0.0.1:${localPort}/?token=${token}`,
              onClosed: (reason) => {
                if (!current() || this.sessions.get(connection.id) !== session) return;
                void this.disconnect(connection.id).catch(() => undefined);
                if (reason === "workspace-load")
                  set({ status: "failed", errorCode: "workspace-load" });
              },
            });
          } catch {
            if (current() && this.sessions.get(connection.id) === session) {
              void this.disconnect(connection.id).catch(() => undefined);
              return set({ status: "failed", errorCode: "workspace-load" });
            }
            return this.states.get(connection.id)!;
          }
          if (!current() || this.sessions.get(connection.id) !== session) {
            closeWorkspace();
            return this.states.get(connection.id)!;
          }
          session.closeWorkspace = closeWorkspace;
          return set({ status: "connected" });
        }
        await delay(300, undefined, { signal: controller.signal });
      }
      if (controller.signal.aborted) return this.states.get(connection.id)!;
      throw new Error("timeout");
    } catch (error) {
      if (!current())
        return this.states.get(connection.id) ?? { connection, status: "disconnected" };
      const message = error instanceof Error ? error.message : "connection";
      const cancelled = this.states.get(connection.id)?.status === "disconnected";
      if (cancelled) return this.states.get(connection.id)!;
      void this.disconnect(connection.id).catch(() => undefined);
      return set({
        status: "failed",
        errorCode: /^[a-z-]+$/u.test(message) ? message : sshFailureCode(`${message}\n${stderr}`),
      });
    } finally {
      if (this.preparing.get(connection.id) === controller) this.preparing.delete(connection.id);
    }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.pendingHostKeys.clear();
    const starts = [...this.connecting.values()];
    const ids = new Set([
      ...this.sessions.keys(),
      ...this.preparing.keys(),
      ...this.retiredChildren.keys(),
    ]);
    const stops = [...ids].map((id) => this.disconnect(id));
    const disposal = (async () => {
      try {
        const results = await Promise.allSettled([...starts, ...stops, ...this.retiring.values()]);
        if (results.some((result) => result.status === "rejected"))
          throw new Error("process-cleanup");
        this.disposed = true;
      } finally {
        this.closing = false;
      }
    })();
    this.disposal = disposal;
    void disposal.catch(() => {
      if (this.disposal === disposal) this.disposal = undefined;
    });
    return disposal;
  }
}
