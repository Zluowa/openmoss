import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_MARKER_BYTES = 4096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function pathIdentity(path) {
  const resolvedPath = resolve(path);
  return process.platform === "win32" ? resolvedPath.toLocaleLowerCase("en-US") : resolvedPath;
}

function sameFile(before, after) {
  const hasStableIdentity =
    before.dev !== 0 || before.ino !== 0 || after.dev !== 0 || after.ino !== 0;
  return (
    before.isFile() &&
    after.isFile() &&
    (!hasStableIdentity || (before.dev === after.dev && before.ino === after.ino)) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectStream);
    stream.once("end", resolveStream);
  });
  return hash.digest("hex");
}

/**
 * Verify that the exact ordinary diagnostic file is bound to a clean scanner
 * marker. Any missing, malformed, stale, symlinked, or changed input blocks the
 * upload without echoing marker or diagnostic contents.
 */
export async function canUploadScannedDiagnostic({ markerPath, diagnosticPath }) {
  try {
    if (
      typeof markerPath !== "string" ||
      markerPath.length === 0 ||
      typeof diagnosticPath !== "string" ||
      diagnosticPath.length === 0
    ) {
      return false;
    }

    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > MAX_MARKER_BYTES) {
      return false;
    }

    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (
      !marker ||
      typeof marker !== "object" ||
      marker.schemaVersion !== 1 ||
      marker.status !== "clean" ||
      !marker.diagnostic ||
      typeof marker.diagnostic !== "object" ||
      typeof marker.diagnostic.path !== "string" ||
      !Number.isSafeInteger(marker.diagnostic.length) ||
      marker.diagnostic.length < 0 ||
      typeof marker.diagnostic.sha256 !== "string" ||
      !SHA256_PATTERN.test(marker.diagnostic.sha256) ||
      pathIdentity(marker.diagnostic.path) !== pathIdentity(diagnosticPath)
    ) {
      return false;
    }

    const before = await lstat(diagnosticPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== marker.diagnostic.length) {
      return false;
    }

    const digest = await sha256File(diagnosticPath);
    const after = await lstat(diagnosticPath);
    return sameFile(before, after) && digest === marker.diagnostic.sha256;
  } catch {
    return false;
  }
}

async function runCli() {
  const canUpload = await canUploadScannedDiagnostic({
    markerPath: process.env.MOSS_KEY_LEAK_SCAN_MARKER_PATH ?? "",
    diagnosticPath: process.env.MOSS_KEY_E2E_DIAGNOSTIC_PATH ?? "",
  });
  process.stdout.write(canUpload ? "true\n" : "false\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runCli();
}
