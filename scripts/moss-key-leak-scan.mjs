import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS_ENVIRONMENT_VARIABLE = "MOSS_KEY_LEAK_SCAN_ROOTS";
const READ_CHUNK_BYTES = 1024 * 1024;
const CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const defaultFileSystem = {
  lstat,
  open,
  readdir,
  realpath,
};

function errorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : "UNKNOWN";
}

function normalizeSecret(secret) {
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      throw new Error("secret bytes must be canonical UTF-8");
    }
  } catch {
    throw new Error("secret bytes must be valid UTF-8");
  }

  // Match the installed-app driver's credential contract before traversing
  // large trees. A one-character placeholder (for example a mistakenly
  // supplied CLI stdin sentinel) would otherwise match common bytes in nearly
  // every packaged file and obscure the real configuration failure.
  if (decoded.length < 8 || decoded.length > 4_096 || /[\u0000\r\n]/u.test(decoded)) {
    throw new Error("secret bytes do not satisfy the Moss Key contract");
  }

  return bytes;
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error("at least one scan root is required");
  }

  return roots.map((root) => {
    if (
      !root ||
      typeof root !== "object" ||
      typeof root.category !== "string" ||
      !CATEGORY_PATTERN.test(root.category) ||
      typeof root.path !== "string" ||
      root.path.length === 0 ||
      !isAbsolute(root.path)
    ) {
      throw new Error("scan roots require a safe category and absolute path");
    }
    return {
      category: root.category,
      path: resolve(root.path),
    };
  });
}

function pathIdentity(path) {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function isWithinRoot(rootPath, candidatePath) {
  const rootIdentity = pathIdentity(rootPath);
  const candidateIdentity = pathIdentity(candidatePath);
  const fromRoot = relative(rootIdentity, candidateIdentity);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function sameOpenedFile(before, after) {
  if (!after.isFile()) return false;
  const hasStableIdentity =
    before.dev !== 0 || before.ino !== 0 || after.dev !== 0 || after.ino !== 0;
  if (hasStableIdentity) {
    return before.dev === after.dev && before.ino === after.ino;
  }
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.birthtimeMs === after.birthtimeMs
  );
}

function fileStayedStable(before, after) {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function fileContainsBytes(fileHandle, needle, result) {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const overlapLength = Math.max(0, needle.length - 1);
  let overlap = Buffer.alloc(0);
  let position = 0;
  let matched = false;

  while (true) {
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;

    result.bytesScanned += bytesRead;
    const bytes =
      overlap.length === 0
        ? buffer.subarray(0, bytesRead)
        : Buffer.concat([overlap, buffer.subarray(0, bytesRead)]);
    if (bytes.indexOf(needle) !== -1) matched = true;
    overlap =
      overlapLength === 0
        ? Buffer.alloc(0)
        : Buffer.from(bytes.subarray(Math.max(0, bytes.length - overlapLength)));
    position += bytesRead;
  }

  return matched;
}

/**
 * Scan every ordinary file below the explicitly supplied roots. There are no
 * filename, extension, size, or encoding filters: snapshots, configuration,
 * logs, SQLite databases, IndexedDB data, and binary files are all byte-scanned.
 */
export async function scanExactSecret({ secret, roots }, dependencies = {}) {
  const needle = normalizeSecret(secret);
  const normalizedRoots = normalizeRoots(roots);
  const fileSystem = { ...defaultFileSystem, ...dependencies.fileSystem };
  const result = {
    outcome: "clean",
    rootsScanned: 0,
    filesScanned: 0,
    bytesScanned: 0,
    symlinksSkipped: 0,
    matches: [],
    errors: [],
  };
  const visitedDirectories = new Set();
  const visitedFiles = new Set();

  const recordError = (root, path, operation, error) => {
    result.errors.push({
      category: root.category,
      root: root.path,
      path,
      operation,
      code: errorCode(error),
    });
  };

  const scanFile = async (root, filePath, rootRealPath, beforeStat) => {
    let canonicalPath;
    try {
      canonicalPath = await fileSystem.realpath(filePath);
    } catch (error) {
      recordError(root, filePath, "realpath", error);
      return;
    }
    if (!isWithinRoot(rootRealPath, canonicalPath)) {
      recordError(root, filePath, "containment", { code: "OUTSIDE_ROOT" });
      return;
    }

    const identity = pathIdentity(canonicalPath);
    if (visitedFiles.has(identity)) return;
    visitedFiles.add(identity);

    let fileHandle;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      fileHandle = await fileSystem.open(filePath, constants.O_RDONLY | noFollow);
    } catch (error) {
      recordError(root, filePath, "open", error);
      return;
    }

    try {
      let openedStat;
      try {
        openedStat = await fileHandle.stat();
      } catch (error) {
        recordError(root, filePath, "opened-stat", error);
        return;
      }
      if (!sameOpenedFile(beforeStat, openedStat)) {
        recordError(root, filePath, "identity", { code: "FILE_CHANGED" });
        return;
      }

      result.filesScanned += 1;
      let matched;
      try {
        matched = await fileContainsBytes(fileHandle, needle, result);
      } catch (error) {
        recordError(root, filePath, "read", error);
        return;
      }

      let finalStat;
      try {
        finalStat = await fileHandle.stat();
      } catch (error) {
        recordError(root, filePath, "final-stat", error);
        return;
      }
      if (!fileStayedStable(openedStat, finalStat)) {
        recordError(root, filePath, "stability", { code: "FILE_CHANGED" });
        return;
      }
      if (matched) {
        result.matches.push({
          category: root.category,
          root: root.path,
          path: filePath,
        });
      }
    } finally {
      try {
        await fileHandle.close();
      } catch (error) {
        recordError(root, filePath, "close", error);
      }
    }
  };

  const scanNode = async (root, path, rootRealPath, knownStat) => {
    let stat = knownStat;
    if (!stat) {
      try {
        stat = await fileSystem.lstat(path);
      } catch (error) {
        recordError(root, path, "lstat", error);
        return;
      }
    }

    if (stat.isSymbolicLink()) {
      result.symlinksSkipped += 1;
      return;
    }
    if (stat.isFile()) {
      await scanFile(root, path, rootRealPath, stat);
      return;
    }
    if (!stat.isDirectory()) return;

    let canonicalDirectory;
    try {
      canonicalDirectory = await fileSystem.realpath(path);
    } catch (error) {
      recordError(root, path, "realpath", error);
      return;
    }
    if (!isWithinRoot(rootRealPath, canonicalDirectory)) {
      recordError(root, path, "containment", { code: "OUTSIDE_ROOT" });
      return;
    }
    const identity = pathIdentity(canonicalDirectory);
    if (visitedDirectories.has(identity)) return;
    visitedDirectories.add(identity);

    let entries;
    try {
      entries = await fileSystem.readdir(path, { withFileTypes: true });
    } catch (error) {
      recordError(root, path, "readdir", error);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      await scanNode(root, resolve(path, entry.name), rootRealPath);
    }
  };

  for (const root of normalizedRoots) {
    let rootStat;
    try {
      rootStat = await fileSystem.lstat(root.path);
    } catch (error) {
      recordError(root, root.path, "root-lstat", error);
      continue;
    }
    if (rootStat.isSymbolicLink()) {
      recordError(root, root.path, "root-symlink", { code: "SYMLINK_ROOT" });
      continue;
    }

    let rootRealPath;
    try {
      rootRealPath = await fileSystem.realpath(root.path);
    } catch (error) {
      recordError(root, root.path, "root-realpath", error);
      continue;
    }
    result.rootsScanned += 1;
    await scanNode(root, root.path, rootRealPath, rootStat);
  }

  result.outcome =
    result.errors.length > 0 ? "error" : result.matches.length > 0 ? "match" : "clean";
  return result;
}

function sanitizeForOutput(value, secretText) {
  return value.includes(secretText) ? value.split(secretText).join("[REDACTED_KEY]") : value;
}

function safeLocation(location, secretText) {
  return {
    category: sanitizeForOutput(location.category, secretText),
    root: sanitizeForOutput(location.root, secretText),
    path: sanitizeForOutput(location.path, secretText),
  };
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function runCli() {
  let secret;
  try {
    secret = await readStandardInput();
    const roots = JSON.parse(process.env[ROOTS_ENVIRONMENT_VARIABLE] ?? "");
    delete process.env[ROOTS_ENVIRONMENT_VARIABLE];
    const result = await scanExactSecret({ secret, roots });
    const secretText = new TextDecoder("utf-8", { fatal: true }).decode(secret);

    if (result.outcome === "clean") {
      process.stdout.write(
        `${JSON.stringify({
          status: "clean",
          rootsScanned: result.rootsScanned,
          filesScanned: result.filesScanned,
          symlinksSkipped: result.symlinksSkipped,
        })}\n`,
      );
      return 0;
    }

    for (const match of result.matches) {
      // A match intentionally reports location only: never bytes, snippets,
      // offsets, file contents, or the plaintext Key.
      process.stderr.write(`${JSON.stringify(safeLocation(match, secretText))}\n`);
    }
    for (const error of result.errors) {
      process.stderr.write(
        `${JSON.stringify({
          status: "scan-error",
          ...safeLocation(error, secretText),
          operation: error.operation,
          code: error.code,
        })}\n`,
      );
    }
    return result.outcome === "error" ? 2 : 1;
  } catch {
    // Do not print caught input, parser, filesystem, or runtime errors. Any
    // scanner failure is fail-closed and the caller receives only a fixed code.
    process.stderr.write('{"status":"scan-error","code":"UNEXPECTED"}\n');
    return 2;
  } finally {
    secret?.fill(0);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
