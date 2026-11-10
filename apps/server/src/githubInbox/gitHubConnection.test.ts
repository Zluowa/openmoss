import { describe, expect, it, vi } from "vitest";
import { createGitHubConnection, type InstallGitHubCli } from "./gitHubConnection";
import type { ProcessRunOptions, ProcessRunResult } from "../processRunner";
import type {
  SystemToolInstallOutcome,
  SystemToolInstallPhase,
} from "../provider/systemToolInstall";

const one = "00000000-0000-4000-8000-000000000001";
const two = "00000000-0000-4000-8000-000000000002";
const ok = (stdout = "", stderr = "", code = 0): ProcessRunResult => ({
  stdout,
  stderr,
  code,
  timedOut: false,
  signal: null,
});
function harness() {
  let login = "";
  let finish!: (result: ProcessRunResult) => void;
  const execute = vi.fn(async (args: readonly string[], options: ProcessRunOptions) => {
    if (args[0] === "api") return login ? ok(login) : ok("", "run gh auth login", 1);
    if (args.includes("--help")) return ok("  --clipboard");
    expect(args).toEqual([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--web",
      "--clipboard=false",
    ]);
    options.onStderrChunk?.("not-for-display\n! First copy your one-");
    options.onStderrChunk?.("time code: ABCD-1234\nmore private output");
    return new Promise<ProcessRunResult>((resolve) => {
      finish = resolve;
    });
  });
  const reset = vi.fn(async () => {});
  const service = createGitHubConnection(execute, reset);
  return {
    service,
    execute,
    reset,
    setLogin: (id: string) => {
      login = id;
    },
    finish: () => finish(ok()),
  };
}
describe("host GitHub connection", () => {
  it("probes without starting login, discovers existing authorization and invalidates only changed identities", async () => {
    const h = harness();
    expect(await h.service.handle("a", { op: "status" })).toEqual({ state: "disconnected" });
    h.setLogin("already-connected");
    expect(await h.service.handle("a", { op: "status" })).toEqual({
      state: "connected",
      login: "already-connected",
    });
    await h.service.handle("a", { op: "status" });
    expect(h.execute.mock.calls.every(([args]) => args[0] === "api")).toBe(true);
    expect(h.reset).toHaveBeenCalledTimes(2);
  });
  it("uses the requesting owner and ticket, reattaches on lost start, reveals only the code and verifies the viewer", async () => {
    const h = harness();
    expect(await h.service.handle("a", { op: "start", requestId: one })).toEqual({
      state: "pending",
      code: null,
    });
    await vi.waitFor(async () =>
      expect(await h.service.handle("a", { op: "poll", requestId: one })).toEqual({
        state: "pending",
        code: "ABCD-1234",
      }),
    );
    expect(await h.service.handle("a", { op: "start", requestId: one })).toEqual({
      state: "pending",
      code: "ABCD-1234",
    });
    expect(await h.service.handle("b", { op: "poll", requestId: one })).toEqual({
      state: "expired",
    });
    expect(await h.service.handle("b", { op: "cancel", requestId: one })).toEqual({
      state: "expired",
    });
    expect(await h.service.handle("a", { op: "start", requestId: two })).toEqual({ state: "busy" });
    h.setLogin("verified-user");
    h.finish();
    await vi.waitFor(async () =>
      expect(await h.service.handle("a", { op: "poll", requestId: one })).toEqual({
        state: "connected",
        login: "verified-user",
      }),
    );
    expect(h.execute.mock.calls.filter(([args]) => args.includes("--web"))).toHaveLength(1);
  });
  it("keeps the command owned until cancel settles and refuses late completion", async () => {
    const h = harness();
    await h.service.handle("a", { op: "start", requestId: one });
    await vi.waitFor(async () =>
      expect(await h.service.handle("a", { op: "poll", requestId: one })).toEqual({
        state: "pending",
        code: "ABCD-1234",
      }),
    );
    expect(await h.service.handle("a", { op: "cancel", requestId: one })).toEqual({
      state: "cancelled",
    });
    expect(await h.service.handle("a", { op: "start", requestId: two })).toEqual({ state: "busy" });
    h.setLogin("stale");
    h.finish();
    await h.service.close();
    expect(await h.service.handle("a", { op: "poll", requestId: one })).toEqual({
      state: "cancelled",
    });
  });
  it("requires a verified login even when the command exits zero", async () => {
    const h = harness();
    await h.service.handle("a", { op: "start", requestId: one });
    await vi.waitFor(async () =>
      expect(await h.service.handle("a", { op: "poll", requestId: one })).toEqual({
        state: "pending",
        code: "ABCD-1234",
      }),
    );
    h.finish();
    await vi.waitFor(async () =>
      expect(await h.service.handle("a", { op: "poll", requestId: one })).toEqual({
        state: "failed",
      }),
    );
  });
  it("distinguishes missing CLI and a network failure without returning raw output", async () => {
    const missing = createGitHubConnection(async () => {
      throw new Error("Command not found: gh");
    });
    expect(await missing.handle("a", { op: "status" })).toEqual({ state: "missing" });
    const offline = createGitHubConnection(async () =>
      ok("", "connection timed out: private diagnostic", 1),
    );
    expect(await offline.handle("a", { op: "status" })).toEqual({ state: "unavailable" });
  });
});

describe("one-click GitHub CLI install", () => {
  function installHarness() {
    let installed = false;
    const execute = vi.fn(async (args: readonly string[]) => {
      if (!installed) throw new Error("Command not found: gh");
      if (args[0] === "api") return ok("", "run gh auth login", 1);
      return ok();
    });
    let finish!: (outcome: SystemToolInstallOutcome) => void;
    let progress!: (phase: SystemToolInstallPhase) => void;
    let signal!: AbortSignal;
    const installGh = vi.fn<InstallGitHubCli>(
      (options) =>
        new Promise((resolve) => {
          progress = options.onProgress;
          signal = options.signal;
          finish = resolve;
        }),
    );
    const service = createGitHubConnection(execute, async () => {}, installGh);
    return {
      service,
      installGh,
      progress: (phase: SystemToolInstallPhase) => progress(phase),
      signal: () => signal,
      succeed: () => {
        installed = true;
        finish({ ok: true, version: "2.83.1", binDirectory: "C:\\gh", method: "winget" });
      },
      fail: () =>
        finish({ ok: false, reason: "download-failed", detail: "private diagnostic text" }),
    };
  }

  it("installs once, reports progress through status, then shows the sign-in step", async () => {
    const h = installHarness();
    expect(await h.service.handle("a", { op: "status" })).toEqual({ state: "missing" });
    expect(await h.service.handle("a", { op: "install" })).toEqual({
      state: "installing",
      phase: "installing",
    });
    await vi.waitFor(() => expect(h.installGh).toHaveBeenCalledTimes(1));
    h.progress("downloading");
    expect(await h.service.handle("a", { op: "status" })).toEqual({
      state: "installing",
      phase: "downloading",
    });
    // A second click joins the running install; sign-in waits for it.
    expect(await h.service.handle("a", { op: "install" })).toEqual({
      state: "installing",
      phase: "downloading",
    });
    expect(await h.service.handle("a", { op: "start", requestId: one })).toEqual({
      state: "busy",
    });
    h.succeed();
    await vi.waitFor(async () =>
      expect(await h.service.handle("a", { op: "status" })).toEqual({ state: "disconnected" }),
    );
    expect(h.installGh).toHaveBeenCalledTimes(1);
  });

  it("reports a failure once, without the installer's own text, and lets the person retry", async () => {
    const h = installHarness();
    await h.service.handle("a", { op: "install" });
    await vi.waitFor(() => expect(h.installGh).toHaveBeenCalledTimes(1));
    h.fail();
    await vi.waitFor(async () =>
      expect(await h.service.handle("a", { op: "status" })).toEqual({
        state: "installFailed",
        reason: "download-failed",
      }),
    );
    expect(await h.service.handle("a", { op: "status" })).toEqual({ state: "missing" });
    await h.service.handle("a", { op: "install" });
    await vi.waitFor(() => expect(h.installGh).toHaveBeenCalledTimes(2));
  });

  it("does not install when GitHub CLI is already there", async () => {
    const installGh = vi.fn<InstallGitHubCli>();
    const service = createGitHubConnection(
      async () => ok("", "run gh auth login", 1),
      async () => {},
      installGh,
    );
    await service.handle("a", { op: "install" });
    await vi.waitFor(async () =>
      expect(await service.handle("a", { op: "status" })).toEqual({ state: "disconnected" }),
    );
    expect(installGh).not.toHaveBeenCalled();
  });

  it("stops the install when the server shuts down", async () => {
    const h = installHarness();
    await h.service.handle("a", { op: "install" });
    await vi.waitFor(() => expect(h.installGh).toHaveBeenCalledTimes(1));
    const closing = h.service.close();
    expect(h.signal().aborted).toBe(true);
    h.fail();
    await closing;
  });
});
