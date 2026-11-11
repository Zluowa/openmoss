import { describe, expect, it, vi } from "vitest";

import { devCuaDriverStatus, ensureDevCuaDriver } from "./ensure-dev-cua-driver.mjs";

const files = (entries) => ({
  exists: (path) => Object.keys(entries).some((name) => path.endsWith(name)),
  readText: (path) => {
    const name = Object.keys(entries).find((candidate) => path.endsWith(candidate));
    if (name === undefined) throw new Error("ENOENT");
    return entries[name];
  },
});

describe("devCuaDriverStatus", () => {
  it("leaves platforms that build from source alone", () => {
    expect(devCuaDriverStatus({ platform: "darwin", releaseVersion: "1" })).toBe("unsupported");
    expect(devCuaDriverStatus({ platform: "linux", releaseVersion: "1" })).toBe("unsupported");
  });

  it("reads the staged Windows driver against the pinned release", () => {
    const base = { platform: "win32", driverDir: "D:/x/cua-driver", releaseVersion: "0.28.2" };
    expect(devCuaDriverStatus({ ...base, ...files({}) })).toBe("missing");
    expect(
      devCuaDriverStatus({
        ...base,
        ...files({ "cua-driver.exe": "", "provenance.json": '{"version":"0.28.2"}' }),
      }),
    ).toBe("ready");
    expect(
      devCuaDriverStatus({
        ...base,
        ...files({ "cua-driver.exe": "", "provenance.json": '{"version":"0.27.0"}' }),
      }),
    ).toBe("stale");
    expect(devCuaDriverStatus({ ...base, ...files({ "cua-driver.exe": "" }) })).toBe("stale");
  });
});

describe("ensureDevCuaDriver", () => {
  it("does nothing when the driver is ready, on other platforms, or when opted out", () => {
    const run = vi.fn();
    expect(ensureDevCuaDriver({ env: {}, run, log: () => {}, status: () => "ready" })).toBe(
      "ready",
    );
    expect(ensureDevCuaDriver({ env: {}, run, log: () => {}, status: () => "unsupported" })).toBe(
      "unsupported",
    );
    expect(
      ensureDevCuaDriver({
        env: { MOSS_SKIP_CUA_DRIVER_PROVISION: "1" },
        run,
        log: () => {},
        status: () => "missing",
      }),
    ).toBe("skipped");
    expect(run).not.toHaveBeenCalled();
  });

  it("stages a missing driver with the repo's provisioning script", () => {
    const states = ["missing", "ready"];
    const run = vi.fn(() => ({ status: 0 }));
    expect(ensureDevCuaDriver({ env: {}, run, log: () => {}, status: () => states.shift() })).toBe(
      "staged",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1][0]).toMatch(/provision-cua-driver\.mjs$/u);
  });

  it("never fails the dev launch when staging fails", () => {
    const log = vi.fn();
    expect(
      ensureDevCuaDriver({
        env: {},
        run: () => ({ status: 1 }),
        log,
        status: () => "missing",
      }),
    ).toBe("failed");
    expect(log.mock.calls.at(-1)[0]).toMatch(/window still opens/u);
  });
});
