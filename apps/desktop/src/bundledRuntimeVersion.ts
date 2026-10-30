import { execFile } from "node:child_process";

export type BundledRuntimeVersionProbeResult =
  | { readonly ok: true; readonly output: string }
  | {
      readonly ok: false;
      readonly message: string;
      readonly reason: "timeout" | "access-denied" | "missing" | "spawn-failed" | "nonzero-exit";
    };

/** Cold native binaries may need an initial security scan. Keep Electron responsive. */
export function probeBundledRuntimeVersion(
  binaryPath: string,
  versionArgs: readonly string[] = ["--version"],
): Promise<BundledRuntimeVersionProbeResult> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      [...versionArgs],
      { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const reason =
            error.code === "ETIMEDOUT" || (error.killed && error.code == null)
              ? "timeout"
              : error.code === "EACCES" || error.code === "EPERM"
                ? "access-denied"
                : error.code === "ENOENT"
                  ? "missing"
                  : typeof error.code === "number"
                    ? "nonzero-exit"
                    : "spawn-failed";
          resolve({
            ok: false,
            reason,
            message: `Bundled runtime version check failed (${reason}).`,
          });
          return;
        }
        resolve({ ok: true, output: [stdout, stderr].filter(Boolean).join("\n") });
      },
    );
  });
}
