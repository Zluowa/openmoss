// Installer compression for internal test builds only.
//
// electron-builder compresses the Windows NSIS payload (the app archive, the bundled Codex, Claude
// and Cua runtimes and Electron, over 1 GB) with its default level; on 2026-11-17 the NSIS step
// took 8.9 of the installer build's 29 minutes on the owner's PC. A test build that is installed
// once on the same PC gains nothing from a small download. MOSS_DESKTOP_TEST_COMPRESSION picks
// electron-builder's `compression` for a build-only run; a publish run refuses it, so every
// released installer keeps today's settings.
import type { DesktopReleaseMode } from "./desktop-release-build-policy.ts";

export const TEST_COMPRESSION_ENV = "MOSS_DESKTOP_TEST_COMPRESSION";
export const TEST_COMPRESSIONS = ["store", "normal", "maximum"] as const;
export type TestCompression = (typeof TEST_COMPRESSIONS)[number];

/** The compression a build should use, or undefined for electron-builder's default. */
export function testCompressionFor(
  releaseMode: DesktopReleaseMode,
  env: Readonly<Record<string, string | undefined>>,
): TestCompression | undefined {
  const raw = env[TEST_COMPRESSION_ENV]?.trim();
  if (!raw) return undefined;
  if (!(TEST_COMPRESSIONS as readonly string[]).includes(raw)) {
    throw new Error(`${TEST_COMPRESSION_ENV} must be one of ${TEST_COMPRESSIONS.join(", ")}`);
  }
  if (releaseMode !== "build-only") {
    throw new Error(
      `${TEST_COMPRESSION_ENV} is for build-only test builds; a ${releaseMode} build keeps the default compression`,
    );
  }
  return raw as TestCompression;
}
