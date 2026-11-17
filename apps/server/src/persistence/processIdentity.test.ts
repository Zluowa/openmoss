import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parsePosixProbeOutput,
  parseWindowsProbeOutput,
  probeProcessIdentity,
} from "./processIdentity.ts";

const children: ChildProcess[] = [];

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

describe("parseWindowsProbeOutput", () => {
  it("reads name and start time, adding .exe", () => {
    const name = Buffer.from("conhost", "utf8").toString("base64");
    expect(parseWindowsProbeOutput(`noise\r\n@live ${name} 1795432384000\r\n`)).toEqual({
      state: "live",
      executable: "conhost.exe",
      startedAtMs: 1_795_432_384_000,
    });
  });

  it("keeps the name when the start time is denied", () => {
    const name = Buffer.from("Moss", "utf8").toString("base64");
    expect(parseWindowsProbeOutput(`@live ${name} \n`)).toEqual({
      state: "live",
      executable: "Moss.exe",
    });
  });

  it("reads a gone process and refuses garbage", () => {
    expect(parseWindowsProbeOutput("@dead\r\n")).toEqual({ state: "dead" });
    expect(parseWindowsProbeOutput("")).toEqual({ state: "unknown" });
    expect(parseWindowsProbeOutput("@live !!! x")).toEqual({ state: "unknown" });
  });
});

describe("parsePosixProbeOutput", () => {
  it("reads lstart, treats empty output as gone and garbage as unknown", () => {
    expect(parsePosixProbeOutput("Mon Nov 17 19:13:04 2026\n")).toEqual({
      state: "live",
      startedAtMs: new Date(2026, 10, 17, 19, 13, 4).getTime(),
    });
    expect(parsePosixProbeOutput("\n")).toEqual({ state: "dead" });
    expect(parsePosixProbeOutput("not a date")).toEqual({ state: "unknown" });
  });
});

describe("probeProcessIdentity on this machine", () => {
  it("reads the start time of a real process", async () => {
    const child = spawnSleeper();
    const spawnedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const observed = await probeProcessIdentity(child.pid!);
    expect(observed.state).toBe("live");
    if (observed.state !== "live") return;
    expect(observed.startedAtMs).toBeDefined();
    // POSIX lstart has second resolution.
    expect(Math.abs(observed.startedAtMs! - spawnedAt)).toBeLessThan(2_500);
    if (process.platform === "win32") {
      expect(observed.executable?.toLowerCase()).toBe(
        path.basename(process.execPath).toLowerCase(),
      );
    }
  }, 30_000);

  it("reports a pid nobody has as dead", async () => {
    await expect(probeProcessIdentity(2_147_483_000)).resolves.toEqual({ state: "dead" });
  }, 30_000);

  it("never claims identity for an invalid pid", async () => {
    await expect(probeProcessIdentity(0)).resolves.toEqual({ state: "unknown" });
    await expect(probeProcessIdentity(-1)).resolves.toEqual({ state: "unknown" });
  });
});
