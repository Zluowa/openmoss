// FILE: scripts/windows-upgrade/owned.test.mjs
// Purpose: Verify deadline and identity cleanup using exclusively fake child handles.
// Layer: release validation tests
// Exports: none
import { EventEmitter } from "node:events";
import { test } from "vitest";
import assert from "node:assert/strict";
import { OwnedProcesses } from "./owned.mjs";
import { runCapabilities } from "./cli.mjs";

function fixture() {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.pid = 100 + children.length;
    child.kills = 0;
    child.kill = () => {
      child.kills++;
      queueMicrotask(() => child.emit("close", null));
    };
    children.push(child);
    return child;
  };
  const owner = new OwnedProcesses(spawn, {}, { timeoutMs: 10 });
  const record = owner.start("C:\\fixture.exe", []);
  const identity = { pid: record.pid, createdAt: "native-ticks", executable: record.executable };
  return { owner, record, identity, child: children[0] };
}

test("timeout does not immediately kill; cleanup closes then freshly rechecks before individual kill", async () => {
  const { owner, record, identity, child } = fixture();
  owner.enroll(record, identity);
  await assert.rejects(owner.wait(record), /timeout/);
  assert.equal(child.kills, 0);
  const events = [];
  await owner.cleanup(
    async () => {
      events.push("inspect");
      return identity;
    },
    async () => events.push("close"),
  );
  assert.deepEqual(events, ["inspect", "close", "inspect"]);
  assert.equal(child.kills, 1);
  assert.equal(record.exited, true);
});

test("creation/executable mismatch, identity change and unenrolled children refuse termination", async () => {
  for (const reason of ["creation", "exe", "changed", "unknown"]) {
    const { owner, record, identity, child } = fixture();
    if (reason !== "unknown") owner.enroll(record, identity);
    let calls = 0;
    await assert.rejects(
      owner.cleanup(
        async () => {
          calls++;
          if (reason === "creation" || (reason === "changed" && calls === 2))
            return { ...identity, createdAt: "reused" };
          if (reason === "exe") return { ...identity, executable: "C:\\different.exe" };
          return identity;
        },
        async () => {},
      ),
      /Cleanup incomplete/,
    );
    assert.equal(child.kills, 0);
    child.emit("close", 0);
  }
});

test("cooperative close is awaited without forced kill", async () => {
  const { owner, record, identity, child } = fixture();
  owner.enroll(record, identity);
  await owner.cleanup(
    async () => identity,
    async () => child.emit("close", 0),
  );
  assert.equal(child.kills, 0);
});

test("asynchronous normal close gets a bounded grace period before any fresh kill decision", async () => {
  const { owner, record, identity, child } = fixture();
  owner.enroll(record, identity);
  owner.closeGraceMs = 50;
  let inspections = 0;
  await owner.cleanup(
    async () => {
      inspections++;
      return identity;
    },
    async () => {
      setTimeout(() => child.emit("close", 0), 5);
    },
  );
  assert.equal(child.kills, 0);
  assert.equal(inspections, 1);
});

test("kill without close acknowledgement and failed native inspection remain incomplete", async () => {
  for (const mode of ["no-close", "inspection-failed"]) {
    const { owner, record, identity, child } = fixture();
    owner.enroll(record, identity);
    child.kill = () => {
      child.kills++;
    };
    await assert.rejects(
      owner.cleanup(async () => {
        if (mode === "inspection-failed") throw new Error("Probe timeout");
        return identity;
      }),
      /Cleanup incomplete/,
    );
    assert.equal(child.kills, mode === "no-close" ? 1 : 0);
    assert.equal(record.exited, false);
    child.emit("close", 0);
  }
});

test("abort waits for cleanup and does not terminate an unverified process", async () => {
  const { owner, record, identity, child } = fixture();
  owner.enroll(record, identity);
  const controller = new AbortController();
  const pending = owner.wait(record, 100, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(child.kills, 0);
  await owner.cleanup(async () => identity);
  assert.equal(child.kills, 1);
});

test("local CLI library invocation rejects before any injected spawn or filesystem mutation", async () => {
  let calls = 0;
  await assert.rejects(
    runCapabilities({
      mode: "fixtures",
      root: "D:\\a\\_temp\\moss-upgrade-fake",
      env: {},
      platform: "win32",
      launch: () => {
        calls++;
        throw new Error("unexpected");
      },
    }),
  );
  assert.equal(calls, 0);
});

test("host-only CLI collects evidence with fake native children and never launches a fixture", async () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "Zluowa/openmoss",
    RUNNER_ENVIRONMENT: "github-hosted",
    ImageOS: "win22",
    SystemRoot: "C:\\Windows",
  };
  let calls = 0;
  const launch = (exe, args) => {
    calls++;
    assert.equal(args[args.indexOf("-Mode") + 1], "host");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.pid = 123;
    child.kill = () => {
      throw new Error("No termination expected");
    };
    queueMicrotask(() => {
      for (const message of [
        { event: "hello", identity: { pid: 123, createdAt: "ticks", executable: exe } },
        {
          event: "result",
          status: "observed",
          scope: "read-only-host-evidence",
          host: { osBuild: "unverified" },
        },
      ])
        child.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
      child.emit("close", 0);
    });
    return child;
  };
  const result = await runCapabilities({
    mode: "host",
    root: "D:\\a\\_temp\\moss-upgrade-fake",
    env,
    platform: "win32",
    launch,
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "observed");
  assert.equal(result.cleanup, "complete");
  assert.deepEqual(result.results, []);
  await assert.rejects(
    runCapabilities({
      mode: "fixtures",
      root: "D:\\a\\_temp\\moss-upgrade-fake",
      optIn: "allow-ephemeral-fixtures",
      env,
      platform: "win32",
      launch,
    }),
    /Capability stage failed/,
  );
  assert.equal(calls, 2);
});
