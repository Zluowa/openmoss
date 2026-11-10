// FILE: sshConnections.test.ts
// Purpose: Verify SSH setup, host identity, lifecycle and failure recovery without external hosts.
// Layer: Desktop runtime tests
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SshProcessOwner } from "./sshProcessOwner";
import {
  SshConnectionManager,
  normalizeSshConnection,
  sshFailureCode,
  sshKnownHostsOption,
} from "./sshConnections";

function fixture() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  const spawn = vi.fn(() => child);
  const run = vi.fn(
    async (file: string, _args: readonly string[]): Promise<string> =>
      file === "ssh"
        ? "hostname fixture.invalid\nport 22\n"
        : "fixture.invalid ssh-ed25519 AQIDBA==\n",
  );
  const close = vi.fn();
  const openWorkspace = vi.fn((_input: { wsUrl: string }) => close);
  const processOwner: SshProcessOwner = {
    spawn: async (input) => {
      input.beforeSpawn();
      return input.bind(input.spawn());
    },
    stop: async (child) => {
      child.kill();
    },
  };
  return {
    child,
    spawn,
    run,
    close,
    openWorkspace,
    runtimeArchive: async () => Buffer.from("isolated-runtime-fixture"),
    processOwner,
  };
}
describe("SSH connections", () => {
  it("allows a failed shutdown to retry cleanup without retiring the whole manager", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-quit-retry-"));
    const f = fixture();
    let attempts = 0;
    const owner: SshProcessOwner = {
      ...f.processOwner,
      stop: async (child) => {
        if (++attempts === 1) throw new Error("inspection unavailable");
        child.kill();
      },
    };
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      processOwner: owner,
      probe: async () => true,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const saved = await manager.save({ displayName: "Dev", host: "fixture" });
    const trust = await manager.connect({ id: saved.id });
    await manager.connect({ id: saved.id, trustFingerprint: trust.fingerprint });
    await expect(manager.dispose()).rejects.toThrow("process-cleanup");
    const other = await manager.save({ displayName: "Other", host: "fixture-other" });
    expect((await manager.connect({ id: other.id })).status).toBe("host-key-required");
    await manager.dispose();
    expect(attempts).toBe(2);
    expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it("cancels prepared ownership before a late native SSH spawn", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-prepare-cancel-"));
    const f = fixture();
    let release!: () => void;
    const prepared = vi.fn<SshProcessOwner["spawn"]>(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      input.beforeSpawn();
      return input.bind(input.spawn());
    });
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      processOwner: { ...f.processOwner, spawn: prepared },
      probe: async () => true,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const saved = await manager.save({ displayName: "Dev", host: "fixture" });
    const trust = await manager.connect({ id: saved.id });
    const pending = manager.connect({ id: saved.id, trustFingerprint: trust.fingerprint });
    await vi.waitFor(() => expect(prepared).toHaveBeenCalledOnce());
    await manager.disconnect(saved.id);
    release();
    expect((await pending).status).toBe("disconnected");
    expect(f.spawn).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("blocks replacement connections until owned cleanup has been proven", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-cleanup-proof-"));
    const f = fixture();
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      processOwner: {
        ...f.processOwner,
        stop: async () => {
          throw new Error("unproven");
        },
      },
      probe: async () => true,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const saved = await manager.save({ displayName: "Dev", host: "fixture" });
    const trust = await manager.connect({ id: saved.id });
    await manager.connect({ id: saved.id, trustFingerprint: trust.fingerprint });
    await expect(manager.disconnect(saved.id)).rejects.toThrow("process-cleanup");
    expect((await manager.connect({ id: saved.id })).errorCode).toBe("process-cleanup");
    expect(f.spawn).toHaveBeenCalledOnce();
    await expect(manager.dispose()).rejects.toThrow("process-cleanup");
  });
  it("keeps an old workspace close callback from disconnecting its replacement", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-old-window-"));
    const f = fixture();
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      probe: async () => true,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const saved = await manager.save({ displayName: "Dev", host: "fixture" });
    const trust = await manager.connect({ id: saved.id });
    await manager.connect({ id: saved.id, trustFingerprint: trust.fingerprint });
    const oldClosed = (
      f.openWorkspace.mock.calls[0]![0] as unknown as {
        onClosed: (reason?: "workspace-load") => void;
      }
    ).onClosed;
    manager.disconnect(saved.id);
    expect((await manager.connect({ id: saved.id })).status).toBe("connected");
    oldClosed("workspace-load");
    expect((await manager.list())[0]?.status).toBe("connected");
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it("reports an actual workspace load failure while retaining enabled intent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-window-load-"));
    const f = fixture();
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      probe: async () => true,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const saved = await manager.save({ displayName: "Dev", host: "fixture", enabled: true });
    const trust = await manager.connect({ id: saved.id });
    await manager.connect({ id: saved.id, trustFingerprint: trust.fingerprint });
    const closed = (
      f.openWorkspace.mock.calls[0]![0] as unknown as {
        onClosed: (reason?: "workspace-load") => void;
      }
    ).onClosed;
    closed("workspace-load");
    expect((await manager.list())[0]).toMatchObject({
      status: "failed",
      errorCode: "workspace-load",
      connection: { enabled: true },
    });
    expect(f.child.kill).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("does not overwrite a synchronous workspace load failure with connected", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-window-sync-"));
    const f = fixture();
    f.openWorkspace.mockImplementation((input) => {
      (input as unknown as { onClosed: (reason?: "workspace-load") => void }).onClosed(
        "workspace-load",
      );
      return f.close;
    });
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      probe: async () => true,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const saved = await manager.save({ displayName: "Dev", host: "fixture" });
    const trust = await manager.connect({ id: saved.id });
    expect(
      await manager.connect({ id: saved.id, trustFingerprint: trust.fingerprint }),
    ).toMatchObject({ status: "failed", errorCode: "workspace-load" });
    expect(f.close).toHaveBeenCalledOnce();
    manager.dispose();
  });
  it("waits for the backend starting marker before opening health forward channels", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-health-phase-"));
    const f = fixture();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ startupReady: true }) } as Response);
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      startupTimeoutMs: 2000,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    try {
      const connection = await manager.save({ displayName: "Dev", host: "fixture" });
      const trust = await manager.connect({ id: connection.id });
      const pending = manager.connect({ id: connection.id, trustFingerprint: trust.fingerprint });
      await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
      f.child.stderr.write("MOSS_SSH_PROGRESS_RUNTIME\n");
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(fetch).not.toHaveBeenCalled();
      f.child.stderr.write("MOSS_SSH_PROGRESS_STARTING\n");
      expect((await pending).status).toBe("connected");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      manager.dispose();
      fetch.mockRestore();
    }
  });
  it.each([0, 5, 24])("sends only raw payload bytes after READY offset %s", async (offset) => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-binary-"));
    const f = fixture();
    const archive = Buffer.from("0123456789abcdefghijklmn");
    const chunks: Buffer[] = [];
    f.child.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    let sent = false;
    f.child.stdin.once("finish", () => {
      sent = true;
    });
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      runtimeArchive: async () => archive,
      startupTimeoutMs: 2000,
      probe: async () => sent,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "fixture" });
    const trust = await manager.connect({ id: connection.id });
    const pending = manager.connect({ id: connection.id, trustFingerprint: trust.fingerprint! });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    const header = Buffer.concat(chunks);
    expect(header.toString()).toContain("MOSS_SSH_BOOTSTRAP_HEADER_END");
    expect(sent).toBe(false);
    f.child.stderr.write(`MOSS_SSH_PAYLOAD_READY:${offset}\n`);
    expect((await pending).status).toBe("connected");
    expect(Buffer.concat(chunks).subarray(header.length)).toEqual(archive.subarray(offset));
    manager.dispose();
  });
  it("persists enabled intent separately from status and never connects on load", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-enabled-"));
    const f = fixture();
    const options = { rootDir, version: "1.0.4", ...f } as unknown as ConstructorParameters<
      typeof SshConnectionManager
    >[0];
    const manager = new SshConnectionManager(options);
    const saved = await manager.save({ displayName: "Dev", host: "fixture", enabled: true });
    manager.disconnect(saved.id);
    expect((await manager.list())[0]).toMatchObject({
      status: "disconnected",
      connection: { enabled: true },
    });
    const restored = new SshConnectionManager(options);
    expect((await restored.list())[0]).toMatchObject({
      status: "disconnected",
      connection: { enabled: true },
    });
    expect(f.spawn).not.toHaveBeenCalled();
    await restored.save({ ...saved, enabled: false });
    expect((await restored.list())[0]?.connection.enabled).toBe(false);
    manager.dispose();
    restored.dispose();
  });
  it("uses a disposable unauthenticated probe only for the Windows keyscan KEX failure", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-kex-"));
    const f = fixture();
    f.run.mockImplementation(async (file, args: readonly string[]) => {
      if (file === "ssh-keyscan") throw Error("keyscan-kex");
      if (args.includes("-G")) return "hostname fixture.invalid\nport 22\n";
      const option = args.find((x) => x.startsWith("UserKnownHostsFile="))!;
      const path = option.slice('UserKnownHostsFile="'.length, -1);
      await writeFile(path, "fixture.invalid ssh-ed25519 AQIDBA==\n");
      throw Error("authentication");
    });
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "fixture" });
    const state = await manager.connect({ id: connection.id });
    expect(state.status).toBe("host-key-required");
    expect(f.spawn).not.toHaveBeenCalled();
    const args = f.run.mock.calls.find(([, args]) => args?.includes("-N"))![1];
    expect(args).toEqual(
      expect.arrayContaining([
        "-F",
        "none",
        "-N",
        "-T",
        "PreferredAuthentications=none",
        "IdentityAgent=none",
        "IdentityFile=none",
        "IdentitiesOnly=yes",
        "PubkeyAuthentication=no",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "GSSAPIAuthentication=no",
        "HostbasedAuthentication=no",
        "ClearAllForwardings=yes",
        "ControlMaster=no",
        "ControlPath=none",
        "StrictHostKeyChecking=accept-new",
      ]),
    );
    expect(args?.at(-1)).toBe("fixture.invalid");
    expect((await readdir(rootDir)).some((x) => x.endsWith(".host-key-probe"))).toBe(false);
  });
  it("does not use an unauthenticated probe for an ordinary keyscan network failure", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-scan-fail-"));
    const f = fixture();
    f.run.mockImplementation(async (file) => {
      if (file === "ssh-keyscan") throw Error("refused");
      return "hostname fixture.invalid\nport 22\n";
    });
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const c = await manager.save({ displayName: "Dev", host: "fixture" });
    expect((await manager.connect({ id: c.id })).errorCode).toBe("refused");
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("reports the latest preparation phase without regressing a connected session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-progress-"));
    const f = fixture();
    let ready = false;
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      reservePort: async () => 59901,
      probe: async () => ready,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "fixture" });
    const trust = await manager.connect({ id: connection.id });
    const pending = manager.connect({ id: connection.id, trustFingerprint: trust.fingerprint });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled());
    f.child.stderr.write("MOSS_SSH_PROG");
    f.child.stderr.write("RESS_RUNTIME\n");
    expect((await manager.list())[0]?.phase).toBe("runtime");
    f.child.stderr.write("MOSS_SSH_PROGRESS_AGENTS\n");
    expect((await manager.list())[0]?.phase).toBe("agents");
    f.child.stderr.write("MOSS_SSH_PROGRESS_STARTING\n");
    expect((await manager.list())[0]?.phase).toBe("starting");
    ready = true;
    expect((await pending).status).toBe("connected");
    f.child.stderr.write("A later backend diagnostic\n");
    expect((await manager.list())[0]?.status).toBe("connected");
    manager.dispose();
  });
  it("quotes Windows known-hosts paths for the SSH configuration parser", () => {
    expect(sshKnownHostsOption("E:\\Moss profile\\设备\\host.known-hosts")).toBe(
      'UserKnownHostsFile="E:/Moss profile/设备/host.known-hosts"',
    );
  });
  it("reports jump/proxy configurations before performing an incorrect direct host scan", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-proxy-"));
    const f = fixture();
    f.run.mockResolvedValueOnce("hostname private.fixture\nport 22\nproxyjump bastion.fixture\n");
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "fixture" });
    expect((await manager.connect({ id: connection.id })).errorCode).toBe("proxy-unsupported");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([
    "host;echo injected",
    "-oProxyCommand=whoami",
    "user@host\nwhoami",
    "ssh://host",
    "host space",
  ])("rejects option and shell syntax in %s", (host) => {
    expect(() => normalizeSshConnection({ displayName: "Test", host })).toThrow("invalid-host");
  });
  it("validates ports and identity and keeps user@host and aliases", () => {
    expect(normalizeSshConnection({ displayName: " Dev ", host: "user@host-name" })).toMatchObject({
      displayName: "Dev",
      host: "user@host-name",
    });
    expect(() => normalizeSshConnection({ displayName: "Dev", host: "host", port: 0 })).toThrow(
      "invalid-port",
    );
    expect(() =>
      normalizeSshConnection({ displayName: "Dev", host: "host", identityFile: "x\ny" }),
    ).toThrow("invalid-identity");
  });
  it("saves, reopens and removes connections without connecting or changing global SSH files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-store-"));
    const f = fixture();
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "test" });
    expect(f.run).not.toHaveBeenCalled();
    const reopened = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    expect(await reopened.list()).toEqual([{ connection, status: "disconnected" }]);
    await reopened.remove(connection.id);
    expect(await reopened.list()).toEqual([]);
  });
  it("requires host fingerprint approval then opens the real tunneled workspace and disconnects", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-lifecycle-"));
    const f = fixture();
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      reservePort: async () => 59901,
      probe: async () => true,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({
      displayName: "Dev",
      host: "me@fixture",
      identityFile: "C:/fake key",
    });
    const verification = await manager.connect({ id: connection.id });
    expect(verification.status).toBe("host-key-required");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(
      (await manager.connect({ id: connection.id, trustFingerprint: verification.fingerprint }))
        .status,
    ).toBe("connected");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls.filter(([file]) => file === "ssh-keyscan")).toHaveLength(1);
    const args = f.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args[1]).toContain("StrictHostKeyChecking=yes");
    expect(args[1]).toContain("IdentitiesOnly=yes");
    expect(args[1]).toContain("C:/fake key");
    expect(args[1]).toContain(
      "127.0.0.1:59901:127.0.0.1:" +
        args[1]
          .find((value) => value.startsWith("127.0.0.1:59901:"))!
          .split(":")
          .at(-1),
    );
    expect(f.openWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "http://127.0.0.1:59901", name: "Dev" }),
    );
    const wsUrl = f.openWorkspace.mock.calls[0]![0] as unknown as { wsUrl: string };
    expect(wsUrl.wsUrl.includes("token=")).toBe(true);
    expect(JSON.stringify(await manager.list())).not.toContain("token=");
    expect(await readFile(join(rootDir, "connections.json"), "utf8")).not.toContain("token");
    manager.disconnect(connection.id);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect((await manager.list())[0]?.status).toBe("disconnected");
  });
  it("refuses changed host identities until that new fingerprint is approved", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-identity-"));
    const f = fixture();
    let acceptsHealth = true;
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      reservePort: async () => 59901,
      probe: async () => acceptsHealth,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "fixture" });
    const initial = await manager.connect({ id: connection.id });
    await manager.connect({ id: connection.id, trustFingerprint: initial.fingerprint });
    manager.disconnect(connection.id);
    acceptsHealth = false;
    const strictAttempt = manager.connect({ id: connection.id });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2));
    expect(f.run.mock.calls.filter(([file]) => file === "ssh-keyscan")).toHaveLength(1);
    f.child.stderr.write("Host key verification failed\n");
    f.child.emit("exit", 255);
    expect(await strictAttempt).toMatchObject({ status: "failed", errorCode: "host-key" });
    f.run.mockImplementation(async (file) =>
      file === "ssh"
        ? "hostname fixture.invalid\nport 22\n"
        : "fixture.invalid ssh-ed25519 BQYHCA==\n",
    );
    const changed = await manager.connect({
      id: connection.id,
      trustFingerprint: initial.fingerprint,
    });
    expect(changed.status).toBe("host-key-required");
    expect(changed.previousFingerprint).toBe(initial.fingerprint);
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it("rescans and accepts an approved new fingerprint after the pending key expired", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-identity-expired-"));
    const f = fixture();
    let acceptsHealth = true;
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
      reservePort: async () => 59902,
      probe: async () => acceptsHealth,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "fixture" });
    const initial = await manager.connect({ id: connection.id });
    await manager.connect({ id: connection.id, trustFingerprint: initial.fingerprint });
    await manager.disconnect(connection.id);
    acceptsHealth = false;
    const strictAttempt = manager.connect({ id: connection.id });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2));
    f.child.stderr.write("Host key verification failed\n");
    f.child.emit("exit", 255);
    expect(await strictAttempt).toMatchObject({ status: "failed", errorCode: "host-key" });
    f.run.mockImplementation(async (file) =>
      file === "ssh"
        ? "hostname fixture.invalid\nport 22\n"
        : "fixture.invalid ssh-ed25519 BQYHCA==\n",
    );
    const changed = await manager.connect({ id: connection.id });
    expect(changed.status).toBe("host-key-required");
    const scans = () => f.run.mock.calls.filter(([file]) => file === "ssh-keyscan").length;
    const scansBeforeApproval = scans();
    // The person approves more than two minutes later.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 121_000);
    try {
      acceptsHealth = true;
      const approved = await manager.connect({
        id: connection.id,
        trustFingerprint: changed.fingerprint,
      });
      expect(scans()).toBe(scansBeforeApproval + 1);
      expect(approved.status).toBe("connected");
      expect(f.spawn).toHaveBeenCalledTimes(3);
      expect(await readFile(join(rootDir, `${connection.id}.known-hosts`), "utf8")).toContain(
        "ssh-ed25519 BQYHCA==",
      );
    } finally {
      clock.mockRestore();
      await manager.dispose();
    }
  });
  it("does not open a late workspace after cancellation during host discovery", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-ssh-cancel-"));
    const f = fixture();
    let finish!: (value: string) => void;
    f.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const manager = new SshConnectionManager({
      rootDir,
      version: "1.0.4",
      ...f,
    } as unknown as ConstructorParameters<typeof SshConnectionManager>[0]);
    const connection = await manager.save({ displayName: "Dev", host: "fixture" });
    const pending = manager.connect({ id: connection.id });
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    manager.disconnect(connection.id);
    finish("hostname fixture.invalid\nport 22\n");
    expect((await pending).status).toBe("disconnected");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([
    ["Permission denied (publickey)", "authentication"],
    ["Connection refused", "refused"],
    ["Connection timed out", "timeout"],
    ["Could not resolve hostname", "resolve"],
    ["Host key verification failed", "host-key"],
    ["MOSS_REMOTE_RUNTIME_MISSING", "runtime-missing"],
    [
      "channel 3: open failed: connect failed: Connection refused\nMOSS_REMOTE_RUNTIME_INSTALL_FAILED",
      "runtime-install",
    ],
  ])("maps %s to an actionable code", (detail, code) => expect(sshFailureCode(detail)).toBe(code));
});
