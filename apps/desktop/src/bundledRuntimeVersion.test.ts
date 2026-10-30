import { describe, expect, it } from "vitest";
import { probeBundledRuntimeVersion } from "./bundledRuntimeVersion";

describe("cold bundled runtime version check", () => {
  it("accepts a real child taking over five seconds while the parent remains responsive", async () => {
    let settled = false;
    const pending = probeBundledRuntimeVersion(process.execPath, [
      "-e",
      "setTimeout(() => process.stdout.write('codex-cli 0.153.4'), 6000)",
    ]).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(await pending).toEqual({ ok: true, output: "codex-cli 0.153.4" });
  }, 20_000);

  it("returns a safe failure for a nonzero exit without publishing child output", async () => {
    expect(
      await probeBundledRuntimeVersion(process.execPath, [
        "-e",
        "process.stderr.write('private diagnostic'); process.exit(2)",
      ]),
    ).toEqual({
      ok: false,
      reason: "nonzero-exit",
      message: "Bundled runtime version check failed (nonzero-exit).",
    });
  });
});
