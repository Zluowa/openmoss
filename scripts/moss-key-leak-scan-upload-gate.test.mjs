import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRejectedFileAlias } from "./fixtures/filesystem-links.ts";
import { describe, expect, it } from "vitest";

import { canUploadScannedDiagnostic } from "./moss-key-leak-scan-upload-gate.mjs";

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "moss-key-upload-gate-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeMarker(markerPath, marker) {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
}

function diagnosticBinding(path, contents) {
  return {
    path,
    length: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

describe("Windows exact-Key diagnostic upload gate", () => {
  it("blocks an early smoke failure that never produced a clean marker", async () => {
    await withTemporaryDirectory(async (root) => {
      const diagnosticPath = join(root, "diagnostic.json");
      await writeFile(diagnosticPath, '{"stage":"early-failure"}\n');

      await expect(
        canUploadScannedDiagnostic({
          markerPath: join(root, "missing-marker.json"),
          diagnosticPath,
        }),
      ).resolves.toBe(false);
    });
  });

  it("blocks an exact-match result even if a diagnostic remains", async () => {
    await withTemporaryDirectory(async (root) => {
      const diagnosticPath = join(root, "diagnostic.json");
      const markerPath = join(root, "scan-marker.json");
      await writeFile(diagnosticPath, '{"result":"must-not-upload"}\n');
      await writeMarker(markerPath, {
        schemaVersion: 1,
        status: "blocked",
        reason: "scan-not-clean",
      });

      await expect(canUploadScannedDiagnostic({ markerPath, diagnosticPath })).resolves.toBe(false);
    });
  });

  it("blocks a scanner failure marker", async () => {
    await withTemporaryDirectory(async (root) => {
      const diagnosticPath = join(root, "diagnostic.json");
      const markerPath = join(root, "scan-marker.json");
      await writeFile(diagnosticPath, '{"result":"scanner-error"}\n');
      await writeMarker(markerPath, {
        schemaVersion: 1,
        status: "blocked",
        reason: "scan-not-clean",
      });

      await expect(canUploadScannedDiagnostic({ markerPath, diagnosticPath })).resolves.toBe(false);
    });
  });

  it("allows only the clean diagnostic bound by path, length, and digest", async () => {
    await withTemporaryDirectory(async (root) => {
      const diagnosticPath = join(root, "diagnostic.json");
      const markerPath = join(root, "scan-marker.json");
      const contents = '{"result":"redacted-safe-diagnostic"}\n';
      await writeFile(diagnosticPath, contents);
      await writeMarker(markerPath, {
        schemaVersion: 1,
        status: "clean",
        diagnostic: diagnosticBinding(diagnosticPath, contents),
      });

      await expect(canUploadScannedDiagnostic({ markerPath, diagnosticPath })).resolves.toBe(true);

      await writeFile(diagnosticPath, '{"result":"changed-after-scan"}\n');
      await expect(canUploadScannedDiagnostic({ markerPath, diagnosticPath })).resolves.toBe(false);
    });
  });

  it("rejects symlinked marker and diagnostic inputs", async () => {
    await withTemporaryDirectory(async (root) => {
      const realDiagnosticPath = join(root, "real-diagnostic.json");
      const diagnosticPath = join(root, "diagnostic-link.json");
      const realMarkerPath = join(root, "real-marker.json");
      const markerPath = join(root, "marker-link.json");
      const contents = '{"result":"clean"}\n';
      await writeFile(realDiagnosticPath, contents);
      await writeMarker(realMarkerPath, {
        schemaVersion: 1,
        status: "clean",
        diagnostic: diagnosticBinding(diagnosticPath, contents),
      });
      createRejectedFileAlias(realDiagnosticPath, diagnosticPath);
      createRejectedFileAlias(realMarkerPath, markerPath);

      await expect(
        canUploadScannedDiagnostic({ markerPath: realMarkerPath, diagnosticPath }),
      ).resolves.toBe(false);
      await expect(
        canUploadScannedDiagnostic({ markerPath, diagnosticPath: realDiagnosticPath }),
      ).resolves.toBe(false);
    });
  });
});
