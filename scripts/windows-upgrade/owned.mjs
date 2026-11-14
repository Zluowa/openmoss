// FILE: scripts/windows-upgrade/owned.mjs
// Purpose: Own every direct native child and refuse cleanup without fresh identity proof.
// Layer: release validation tooling
// Exports: OwnedProcesses
import { bounded, sameProcess, windowsPath } from "./core.mjs";

export class OwnedProcesses {
  constructor(spawn, env, { timeoutMs = 15_000, closeGraceMs = 750 } = {}) {
    this.spawn = spawn;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.closeGraceMs = closeGraceMs;
    this.records = [];
  }

  start(executable, args, { protocol = false } = {}) {
    windowsPath(executable);
    const child = this.spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: this.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const record = {
      child,
      pid: child.pid,
      executable,
      createdAt: null,
      exited: false,
      messages: [],
      failure: null,
    };
    this.records.push(record);
    let buffer = "";
    let bytes = 0;
    child.stdout?.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 65_536) {
        record.failure = new Error("Native output limit exceeded");
        return;
      }
      if (!protocol) return;
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === "hello") {
            if (
              message.identity?.pid !== record.pid ||
              windowsPath(message.identity.executable) !== windowsPath(executable) ||
              !message.identity.createdAt
            )
              throw new Error("Native hello identity mismatch");
            record.createdAt = message.identity.createdAt;
          } else if (message.event === "result") record.messages.push(message);
          else throw new Error("Unknown native protocol event");
        } catch {
          record.failure = new Error("Invalid native protocol");
        }
      }
    });
    record.closed = new Promise((resolve) => {
      child.once("error", () => {
        record.failure = new Error("Native launch failed");
      });
      child.once("close", (code) => {
        record.exited = true;
        record.exitCode = code;
        resolve();
      });
    });
    return record;
  }

  async wait(record, timeoutMs = this.timeoutMs, signal) {
    let abort;
    try {
      await bounded("native-process-close", timeoutMs, () =>
        Promise.race([
          record.closed,
          new Promise((_, reject) => {
            abort = () => reject(new Error("Native operation aborted"));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          }),
        ]),
      );
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
    }
    if (record.failure) throw record.failure;
    if (record.exitCode !== 0) throw new Error("Native process failed");
    return record.messages.at(-1);
  }

  enroll(record, identity) {
    if (record.exited) return;
    if (
      identity?.pid !== record.pid ||
      windowsPath(identity.executable) !== windowsPath(record.executable) ||
      !identity.createdAt
    )
      throw new Error("Enrollment identity mismatch");
    record.createdAt = identity.createdAt;
  }

  async cleanup(inspect, requestClose) {
    const failures = [];
    // New inspection helpers are themselves direct children and must finish;
    // never recursively spawn cleanup probes for an unresponsive inspection helper.
    const snapshot = [...this.records];
    for (const record of snapshot) {
      if (record.exited) continue;
      try {
        if (!record.createdAt) throw new Error("Unenrolled child: termination refused");
        let observed = await inspect(record.pid);
        if (record.exited) continue;
        if (!sameProcess(record, observed))
          throw new Error("Cleanup identity mismatch: termination refused");
        if (requestClose) {
          try {
            await requestClose(record);
          } catch {
            /* Recheck before forced termination. */
          }
          // Allow a normal asynchronous window shutdown before considering force.
          try {
            await bounded("owned-close-grace", this.closeGraceMs, () => record.closed);
          } catch {
            /* A grace timeout only permits a fresh identity check. */
          }
        }
        if (record.exited) continue;
        observed = await inspect(record.pid);
        if (record.exited) continue;
        if (!sameProcess(record, observed))
          throw new Error("Cleanup identity changed: termination refused");
        record.child.kill();
        await bounded("owned-child-cleanup-close", this.timeoutMs, () => record.closed);
      } catch (error) {
        failures.push(error.message);
      }
    }
    const live = this.records.filter((record) => !record.exited);
    if (failures.length || live.length)
      throw new Error(
        `Cleanup incomplete: ${failures.join("; ")}; live recorded children=${live.length}`,
      );
  }
}
