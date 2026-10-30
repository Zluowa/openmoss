// Bind build-only native signing to the pre-sign ASAR, then publish its final
// unpacked size/hash/block metadata before the outer application is sealed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { normalizeSignatureStrippedMachO } from "./mac-macho-canonical.mjs";

const MAX_HEADER = 16 * 1024 * 1024;
const MAX_ARCHIVE = 8 * 1024 * 1024 * 1024;
const MAX_NATIVE = 256 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const ASAR_KEY = "Resources/app.asar";
const require = createRequire(new URL("../package.json", import.meta.url));

function fail(message) {
  throw new Error(`Packaged ASAR integrity: ${message}.`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs];
}

function makeContext(appPath) {
  const requested = path.resolve(appPath);
  const stat = fs.lstatSync(requested, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("application must be a plain directory");
  const app = fs.realpathSync(requested);
  const directories = new Map([[app, [stat.dev, stat.ino, stat.mode]]]);
  function checkDirectories() {
    for (const [directory, expected] of directories) {
      const current = fs.lstatSync(directory, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory ||
        !isDeepStrictEqual([current.dev, current.ino, current.mode], expected)
      )
        fail("directory identity changed");
    }
  }
  function containedFile(relative) {
    const components = relative.split("/");
    if (components.some((part) => !part || part === "." || part === ".." || /[\\\0]/u.test(part))) {
      fail("unsafe relative path");
    }
    let directory = app;
    for (const part of components.slice(0, -1)) {
      directory = path.join(directory, part);
      const current = fs.lstatSync(directory, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        fs.realpathSync(directory) !== directory
      ) {
        fail("symlink or non-directory ancestor");
      }
      const identity = [current.dev, current.ino, current.mode];
      if (directories.has(directory) && !isDeepStrictEqual(directories.get(directory), identity)) {
        fail("directory replacement");
      }
      directories.set(directory, identity);
    }
    checkDirectories();
    return path.join(app, ...components);
  }
  return { app, containedFile, checkDirectories };
}

function openSnapshot(context, relative, maxBytes, hooks) {
  const filePath = context.containedFile(relative);
  hooks?.beforeOpen?.(filePath);
  context.checkDirectories();
  const before = fs.lstatSync(filePath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes)
  ) {
    fail("file must be bounded, regular, and singly linked");
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const expected = fileIdentity(before);
  let closed = false;
  function close() {
    if (!closed) {
      fs.closeSync(fd);
      closed = true;
    }
  }
  function assertCurrent() {
    context.checkDirectories();
    if (
      fs.realpathSync(filePath) !== filePath ||
      !isDeepStrictEqual(fileIdentity(fs.lstatSync(filePath, { bigint: true })), expected) ||
      (!closed && !isDeepStrictEqual(fileIdentity(fs.fstatSync(fd, { bigint: true })), expected))
    )
      fail("file identity changed during read");
  }
  try {
    assertCurrent();
    return {
      fd,
      filePath,
      relative,
      expected,
      size: Number(before.size),
      mode: Number(before.mode & 0o777n),
      assertCurrent,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

function readRange(snapshot, start, size) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    size < 0 ||
    start + size > snapshot.size
  ) {
    fail("out-of-bounds read");
  }
  const bytes = Buffer.alloc(size);
  let consumed = 0;
  while (consumed < size) {
    const count = fs.readSync(snapshot.fd, bytes, consumed, size - consumed, start + consumed);
    if (count === 0) fail("truncated file");
    consumed += count;
  }
  return bytes;
}

function hashRange(snapshot, start, size) {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += CHUNK) {
    hash.update(readRange(snapshot, start + offset, Math.min(CHUNK, size - offset)));
  }
  return hash.digest("hex");
}

function validIntegrity(integrity, size) {
  if (
    !plainObject(integrity) ||
    integrity.algorithm !== "SHA256" ||
    !SHA256.test(integrity.hash) ||
    !Number.isSafeInteger(integrity.blockSize) ||
    integrity.blockSize < 1 ||
    integrity.blockSize > MAX_HEADER ||
    !Array.isArray(integrity.blocks) ||
    integrity.blocks.length > 100_000 ||
    integrity.blocks.length !== Math.floor(size / integrity.blockSize) + 1 ||
    !integrity.blocks.every((hash) => typeof hash === "string" && SHA256.test(hash))
  )
    fail("invalid file integrity metadata");
}

function computeIntegrity(snapshot, start, size, blockSize) {
  if (Math.floor(size / blockSize) + 1 > 100_000) fail("unbounded integrity block inventory");
  const full = createHash("sha256");
  const blocks = [];
  // @electron/asar 3.4.1 flushes a final block, including an empty final block
  // for zero-length files and exact block multiples.
  for (let offset = 0; offset <= size; offset += blockSize) {
    const bytes = readRange(snapshot, start + offset, Math.min(blockSize, size - offset));
    full.update(bytes);
    blocks.push(digest(bytes));
  }
  return { algorithm: "SHA256", hash: full.digest("hex"), blockSize, blocks };
}

export function parseAsarHeader(prefix, archiveSize) {
  if (
    prefix.length < 16 ||
    prefix.readUInt32LE(0) !== 4 ||
    !Number.isSafeInteger(archiveSize) ||
    archiveSize < prefix.length ||
    archiveSize > MAX_ARCHIVE
  )
    fail("invalid ASAR size pickle");
  const headerSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  if (
    headerSize < 8 ||
    headerSize > MAX_HEADER ||
    headerSize % 4 !== 0 ||
    prefix.length !== 8 + headerSize ||
    prefix.readUInt32LE(8) !== headerSize - 4 ||
    headerSize !== 8 + Math.ceil(jsonSize / 4) * 4 ||
    jsonSize === 0 ||
    prefix.subarray(16 + jsonSize).some((byte) => byte !== 0)
  )
    fail("invalid ASAR header pickle bounds");
  const jsonBytes = prefix.subarray(16, 16 + jsonSize);
  let header;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
    header = JSON.parse(json);
    // The pinned writer emits JSON.stringify output. This also rejects duplicate
    // keys, ambiguous numeric spellings, and invalid UTF-8 without accepting a
    // different inventory from the one that was hashed.
    if (JSON.stringify(header) !== json) fail("non-canonical ASAR JSON");
  } catch (cause) {
    throw new Error("Packaged ASAR integrity: invalid ASAR header JSON.", { cause });
  }
  const entries = [];
  const portablePaths = new Set();
  let visited = 0;
  function visit(directory, parent, depth, inheritedUnpacked) {
    if (!plainObject(directory) || !plainObject(directory.files) || depth > 64)
      fail("invalid ASAR directory");
    for (const [name, node] of Object.entries(directory.files)) {
      const relative = parent ? `${parent}/${name}` : name;
      const portable = relative.normalize("NFD").toLowerCase();
      if (
        !name ||
        name === "." ||
        name === ".." ||
        /[\\/\u0000-\u001f\u007f]/u.test(name) ||
        Buffer.byteLength(relative) > 4096 ||
        portablePaths.has(portable) ||
        ++visited > 100_000 ||
        !plainObject(node)
      )
        fail("unsafe or colliding ASAR entry");
      portablePaths.add(portable);
      const unpacked = inheritedUnpacked || node.unpacked === true;
      if (Object.hasOwn(node, "files")) {
        if (
          Object.hasOwn(node, "size") ||
          Object.hasOwn(node, "link") ||
          Object.hasOwn(node, "offset")
        )
          fail("ambiguous ASAR directory");
        visit(node, relative, depth + 1, unpacked);
      } else if (Object.hasOwn(node, "link")) {
        if (
          unpacked ||
          typeof node.link !== "string" ||
          !node.link ||
          node.link.startsWith("/") ||
          /[\\\u0000-\u001f\u007f]/u.test(node.link) ||
          node.link.split("/").some((part) => !part || part === "." || part === "..") ||
          Object.hasOwn(node, "size") ||
          Object.hasOwn(node, "offset")
        )
          fail("unsafe ASAR link");
      } else {
        if (!Number.isSafeInteger(node.size) || node.size < 0 || node.size > MAX_ARCHIVE)
          fail("invalid ASAR file size");
        validIntegrity(node.integrity, node.size);
        let offset = null;
        if (unpacked) {
          if (Object.hasOwn(node, "offset") || node.size > MAX_NATIVE)
            fail("invalid unpacked file");
        } else {
          if (typeof node.offset !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(node.offset))
            fail("invalid packed offset");
          offset = Number(node.offset);
          if (!Number.isSafeInteger(offset) || offset + node.size > archiveSize - prefix.length)
            fail("out-of-bounds packed file");
        }
        entries.push({ path: relative, node, unpacked, offset });
      }
    }
  }
  visit(header, "", 0, false);
  let end = 0;
  for (const entry of entries
    .filter((entry) => !entry.unpacked && entry.node.size > 0)
    .sort((a, b) => a.offset - b.offset)) {
    if (entry.offset < end) fail("overlapping packed files");
    end = entry.offset + entry.node.size;
  }
  return { header, entries, payloadOffset: prefix.length, headerSha256: digest(jsonBytes) };
}

export function encodeAsarHeader(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const headerSize = 8 + Math.ceil(json.length / 4) * 4;
  if (headerSize > MAX_HEADER) fail("ASAR header exceeds limit");
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  return prefix;
}

function readHeader(snapshot) {
  const size = readRange(snapshot, 0, 8).readUInt32LE(4);
  if (size < 8 || size > MAX_HEADER || size + 8 > snapshot.size) fail("unbounded ASAR header");
  return parseAsarHeader(readRange(snapshot, 0, 8 + size), snapshot.size);
}

function plistCodec() {
  const fromBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const fromPlist = createRequire(fromBuilder.resolve("plist"));
  return { ...fromBuilder("plist"), DOMParser: fromPlist("@xmldom/xmldom").DOMParser };
}

function readPlist(snapshot, headerSha256) {
  const bytes = readRange(snapshot, 0, snapshot.size);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // App-builder emits XML. Refuse duplicate keys and doctypes with an internal
  // subset before the library parser can silently collapse or expand them.
  if (!text.startsWith("<?xml") || /<!ENTITY|<!DOCTYPE[^>]*\[/iu.test(text))
    fail("unsupported Info.plist encoding");
  const codec = plistCodec();
  const errors = [];
  const document = new codec.DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(text, "application/xml");
  if (errors.length > 0) fail("malformed Info.plist XML");
  for (const dictionary of Array.from(document.getElementsByTagName("dict"))) {
    const children = Array.from(dictionary.childNodes).filter((node) => node.nodeType === 1);
    const keys = new Set();
    if (children.length % 2 !== 0) fail("malformed Info.plist dictionary");
    for (let index = 0; index < children.length; index += 2) {
      const key = children[index];
      if (key.nodeName !== "key" || keys.has(key.textContent))
        fail("duplicate or invalid Info.plist key");
      keys.add(key.textContent);
    }
  }
  const parsed = codec.parse(text);
  const integrity = parsed?.ElectronAsarIntegrity;
  if (
    !plainObject(integrity) ||
    !plainObject(integrity[ASAR_KEY]) ||
    integrity[ASAR_KEY].algorithm !== "SHA256" ||
    integrity[ASAR_KEY].hash !== headerSha256
  )
    fail("ElectronAsarIntegrity does not match the ASAR header");
  return { value: parsed, bytes, sha256: digest(bytes) };
}

function readArchive(context) {
  const archive = openSnapshot(context, "Contents/Resources/app.asar", MAX_ARCHIVE);
  let plist;
  try {
    const parsed = readHeader(archive);
    plist = openSnapshot(context, "Contents/Info.plist", MAX_HEADER);
    const info = readPlist(plist, parsed.headerSha256);
    for (const entry of parsed.entries.filter((entry) => !entry.unpacked)) {
      const actual = computeIntegrity(
        archive,
        parsed.payloadOffset + entry.offset,
        entry.node.size,
        entry.node.integrity.blockSize,
      );
      if (!isDeepStrictEqual(actual, entry.node.integrity))
        fail(`packed file hash mismatch for ${entry.path}`);
    }
    const archiveSha256 = hashRange(archive, 0, archive.size);
    const payloadSha256 = hashRange(
      archive,
      parsed.payloadOffset,
      archive.size - parsed.payloadOffset,
    );
    archive.assertCurrent();
    plist.assertCurrent();
    return { archive, plist, info, ...parsed, archiveSha256, payloadSha256 };
  } catch (error) {
    archive.close();
    if (plist) plist.close();
    throw error;
  }
}

function closeArchive(binding) {
  try {
    binding.archive.close();
  } finally {
    binding.plist.close();
  }
}

function readUnpacked(context, entry, hooks) {
  const snapshot = openSnapshot(
    context,
    `Contents/Resources/app.asar.unpacked/${entry.path}`,
    MAX_NATIVE,
    hooks,
  );
  try {
    const bytes = readRange(snapshot, 0, snapshot.size);
    const integrity = computeIntegrity(snapshot, 0, snapshot.size, entry.node.integrity.blockSize);
    snapshot.assertCurrent();
    return {
      bytes,
      integrity,
      size: snapshot.size,
      mode: snapshot.mode,
      identity: snapshot.expected,
      relative: snapshot.relative,
    };
  } finally {
    snapshot.close();
  }
}

function assertFileRecord(context, record) {
  const filePath = context.containedFile(record.relative);
  if (!isDeepStrictEqual(fileIdentity(fs.lstatSync(filePath, { bigint: true })), record.identity))
    fail("unpacked file changed after validation");
}

function assertPathIdentity(context, filePath, expected) {
  context.checkDirectories();
  if (
    fs.realpathSync(filePath) !== filePath ||
    !isDeepStrictEqual(fileIdentity(fs.lstatSync(filePath, { bigint: true })), expected)
  )
    fail("metadata file identity changed");
}

function publishedIdentity(context, filePath, pendingIdentity) {
  context.checkDirectories();
  const identity = fileIdentity(fs.lstatSync(filePath, { bigint: true }));
  // A rename may update ctime. All other attributes, including inode, mode and
  // modification time, must still be those of the validated pending file.
  if (!isDeepStrictEqual(identity.slice(0, -1), pendingIdentity.slice(0, -1)))
    fail("metadata file changed during publication");
  assertPathIdentity(context, filePath, identity);
  return identity;
}

function runCodesign(args, runCommand) {
  const result = (
    runCommand ??
    ((command, argv) =>
      spawnSync(command, argv, {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: CHUNK,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      }))
  )("/usr/bin/codesign", args);
  if (result.error || result.status !== 0) fail("native signature command failed");
}

function canonicalDigest(bytes, label, runCommand) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moss-asar-signature-"));
  fs.chmodSync(root, 0o700);
  const owned = path.join(root, "payload");
  try {
    fs.writeFileSync(owned, bytes, { flag: "wx", mode: 0o600 });
    runCodesign(["--remove-signature", owned], runCommand);
    const stripped = normalizeSignatureStrippedMachO(fs.readFileSync(owned), label);
    return { sha256: digest(stripped), size: stripped.length };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function pendingFile(target, mode, write, stagingDirectories) {
  // A pathname cannot be unlinked conditionally on its inode. Keep failed
  // staging files in a private directory instead of risking deletion of a
  // concurrent replacement during cleanup. Only empty directories are removed.
  const directory = fs.mkdtempSync(`${target}.staging-`);
  stagingDirectories.add(directory);
  fs.chmodSync(directory, 0o700);
  const pending = path.join(directory, "payload");
  const fd = fs.openSync(
    pending,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    fs.fchmodSync(fd, mode);
    write(fd);
    fs.fsyncSync(fd);
    return pending;
  } finally {
    fs.closeSync(fd);
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) fail("short write");
    offset += written;
  }
}

function copyRange(snapshot, fd, start, size) {
  for (let offset = 0; offset < size; offset += CHUNK) {
    writeAll(fd, readRange(snapshot, start + offset, Math.min(CHUNK, size - offset)));
  }
}

function syncParent(filePath) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function verifyPackagedAsarIntegrity(appPath) {
  const context = makeContext(appPath);
  const binding = readArchive(context);
  try {
    const records = [];
    for (const entry of binding.entries.filter((entry) => entry.unpacked)) {
      const record = readUnpacked(context, entry);
      if (
        record.size !== entry.node.size ||
        !isDeepStrictEqual(record.integrity, entry.node.integrity)
      )
        fail(`unpacked file hash mismatch for ${entry.path}`);
      assertFileRecord(context, record);
      records.push({ ...record, bytes: undefined });
    }
    for (const record of records) assertFileRecord(context, record);
    binding.archive.assertCurrent();
    binding.plist.assertCurrent();
    return {
      archiveSha256: binding.archiveSha256,
      headerSha256: binding.headerSha256,
      payloadSha256: binding.payloadSha256,
      plistSha256: binding.info.sha256,
      packedFiles: binding.entries.filter((entry) => !entry.unpacked).length,
      unpackedFiles: binding.entries.filter((entry) => entry.unpacked).length,
    };
  } finally {
    closeArchive(binding);
  }
}

export function bindMacBuildOnlyAsarSigning(appPath, hooks = {}) {
  const context = makeContext(appPath);
  const source = readArchive(context);
  const originals = new Map();
  const ignoredSigningFiles = new Map();
  let expected = { archive: source.archiveSha256, plist: source.info.sha256 };
  const originalPayload = source.payloadSha256;
  let refreshCount = 0;
  let failed = false;
  let validatedRecords = [];
  try {
    for (const entry of source.entries.filter((entry) => entry.unpacked)) {
      const record = readUnpacked(context, entry, hooks);
      if (
        record.size !== entry.node.size ||
        !isDeepStrictEqual(record.integrity, entry.node.integrity)
      )
        fail(`pre-sign file hash mismatch for ${entry.path}`);
      const native = record.bytes.length >= 4 && record.bytes.readUInt32LE(0) === 0xfeedfacf;
      const original = {
        ...record,
        bytes: undefined,
        canonical: native ? canonicalDigest(record.bytes, entry.path, hooks.runCommand) : null,
      };
      originals.set(entry.path, original);
      if (!native) {
        ignoredSigningFiles.set(path.join(context.app, record.relative), original);
        ignoredSigningFiles.set(path.resolve(appPath, record.relative), original);
      }
      assertFileRecord(context, record);
    }
    source.archive.assertCurrent();
    source.plist.assertCurrent();
  } finally {
    closeArchive(source);
  }
  return {
    shouldIgnoreFile(filePath) {
      if (failed) fail("an aborted signing transaction cannot be retried");
      const original = ignoredSigningFiles.get(path.resolve(filePath));
      if (!original) return false;
      try {
        // osx-sign selects arbitrary binary data, including ELF/PE payloads.
        // codesign adds signature xattrs to those files and changes ctime even
        // when their bytes stay identical. Only bound Mach-O inputs may change.
        assertFileRecord(context, original);
        return true;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    refresh() {
      if (failed) fail("an aborted signing transaction cannot be retried");
      let current;
      let previousPrefix;
      const records = [];
      let pendingArchive;
      let pendingPlist;
      let pendingArchiveIdentity;
      let pendingPlistIdentity;
      let committedArchiveIdentity;
      let committedPlist = false;
      const stagingDirectories = new Set();
      try {
        current = readArchive(context);
        previousPrefix = readRange(current.archive, 0, current.payloadOffset);
        if (
          current.archiveSha256 !== expected.archive ||
          current.info.sha256 !== expected.plist ||
          current.payloadSha256 !== originalPayload
        )
          fail("pre-sign archive or plist changed");
        let changedNativeFiles = 0;
        for (const entry of current.entries.filter((entry) => entry.unpacked)) {
          const original = originals.get(entry.path);
          const record = readUnpacked(context, entry, hooks);
          records.push({ ...record, bytes: undefined });
          if (!original || record.mode !== original.mode)
            fail("unpacked input identity or mode changed");
          if (original.canonical) {
            const canonical = canonicalDigest(record.bytes, entry.path, hooks.runCommand);
            if (!isDeepStrictEqual(canonical, original.canonical))
              fail(`native content changed for ${entry.path}`);
            runCodesign(
              ["--verify", "--strict", "--verbose=4", context.containedFile(record.relative)],
              hooks.runCommand,
            );
          } else if (
            record.integrity.hash !== original.integrity.hash ||
            !isDeepStrictEqual(record.identity, original.identity)
          ) {
            fail(`non-native input changed for ${entry.path}`);
          }
          if (
            record.size !== entry.node.size ||
            !isDeepStrictEqual(record.integrity, entry.node.integrity)
          ) {
            if (!original.canonical) fail("only a bound native signature may change metadata");
            entry.node.size = record.size;
            entry.node.integrity = record.integrity;
            changedNativeFiles += 1;
          }
        }
        function assertInputsCurrent() {
          current.archive.assertCurrent();
          current.plist.assertCurrent();
          for (const record of records) assertFileRecord(context, record);
        }
        assertInputsCurrent();
        if (changedNativeFiles > 0) {
          const prefix = encodeAsarHeader(current.header);
          const parsed = parseAsarHeader(
            prefix,
            prefix.length + current.archive.size - current.payloadOffset,
          );
          current.info.value.ElectronAsarIntegrity[ASAR_KEY] = {
            algorithm: "SHA256",
            hash: parsed.headerSha256,
          };
          const plistBytes = Buffer.from(plistCodec().build(current.info.value), "utf8");
          pendingArchive = pendingFile(
            current.archive.filePath,
            current.archive.mode,
            (fd) => {
              writeAll(fd, prefix);
              copyRange(
                current.archive,
                fd,
                current.payloadOffset,
                current.archive.size - current.payloadOffset,
              );
            },
            stagingDirectories,
          );
          pendingPlist = pendingFile(
            current.plist.filePath,
            current.plist.mode,
            (fd) => writeAll(fd, plistBytes),
            stagingDirectories,
          );
          pendingArchiveIdentity = fileIdentity(fs.lstatSync(pendingArchive, { bigint: true }));
          pendingPlistIdentity = fileIdentity(fs.lstatSync(pendingPlist, { bigint: true }));
          hooks.beforeCommit?.({ pendingArchive, pendingPlist });
          assertInputsCurrent();
          assertPathIdentity(context, pendingArchive, pendingArchiveIdentity);
          assertPathIdentity(context, pendingPlist, pendingPlistIdentity);
          // Windows cannot replace the destination while its read handles are
          // open. Reading and staging are complete; retain the verified path
          // identities, old header and immutable payload binding for rollback.
          if (process.platform === "win32") closeArchive(current);
          fs.renameSync(pendingArchive, current.archive.filePath);
          pendingArchive = undefined;
          committedArchiveIdentity = publishedIdentity(
            context,
            current.archive.filePath,
            pendingArchiveIdentity,
          );
          hooks.afterArchiveCommit?.();
          // Recheck the original plist and both files we still own after the
          // first rename. Never publish over a concurrent plist replacement.
          current.plist.assertCurrent();
          assertPathIdentity(context, current.archive.filePath, committedArchiveIdentity);
          assertPathIdentity(context, pendingPlist, pendingPlistIdentity);
          for (const record of records) assertFileRecord(context, record);
          fs.renameSync(pendingPlist, current.plist.filePath);
          pendingPlist = undefined;
          committedPlist = true;
          publishedIdentity(context, current.plist.filePath, pendingPlistIdentity);
          // Once both renames complete, a sync failure leaves the new coherent
          // pair in place and aborts the transaction. Rolling back only the ASAR
          // at that point would introduce a mismatched plist.
          const sync = hooks.syncParent ?? syncParent;
          sync(current.archive.filePath);
          sync(current.plist.filePath);
          expected = { archive: null, plist: digest(plistBytes) };
        }
        const verified = verifyPackagedAsarIntegrity(context.app);
        if (verified.payloadSha256 !== originalPayload) fail("packed payload changed");
        for (const record of records) assertFileRecord(context, record);
        expected.archive = verified.archiveSha256;
        validatedRecords = records;
        refreshCount += 1;
        return { ...verified, refreshCount, changedNativeFiles };
      } catch (error) {
        failed = true;
        if (committedArchiveIdentity && !committedPlist) {
          // An error between the two renames cannot leave an accepted half pair.
          // Restore the old header with the bound packed payload from the
          // archive we published. This also works after Windows read handles
          // are closed, without rewriting a caller's concurrently changed plist.
          let rollback;
          try {
            assertPathIdentity(context, current.archive.filePath, committedArchiveIdentity);
            const published = openSnapshot(context, "Contents/Resources/app.asar", MAX_ARCHIVE);
            try {
              if (!isDeepStrictEqual(published.expected, committedArchiveIdentity))
                fail("rollback archive identity changed");
              const header = readHeader(published);
              const payloadSize = published.size - header.payloadOffset;
              if (hashRange(published, header.payloadOffset, payloadSize) !== originalPayload)
                fail("rollback packed payload changed");
              rollback = pendingFile(
                current.archive.filePath,
                current.archive.mode,
                (fd) => {
                  writeAll(fd, previousPrefix);
                  copyRange(published, fd, header.payloadOffset, payloadSize);
                },
                stagingDirectories,
              );
              published.assertCurrent();
            } finally {
              published.close();
            }
            assertPathIdentity(context, current.archive.filePath, committedArchiveIdentity);
            fs.renameSync(rollback, current.archive.filePath);
            rollback = undefined;
            syncParent(current.archive.filePath);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Packaged ASAR integrity: rollback refused or failed.",
            );
          }
        }
        throw error;
      } finally {
        try {
          for (const directory of stagingDirectories) {
            try {
              // rmdir is atomic and cannot remove a file placed in this directory.
              // Normalize the file-replacement failure: Windows reports ENOENT
              // for rmdir(file), whereas POSIX reports ENOTDIR.
              const stat = fs.lstatSync(directory);
              if (!stat.isDirectory() || stat.isSymbolicLink())
                fail("ENOTDIR: staging directory replaced");
              fs.rmdirSync(directory);
            } catch (error) {
              if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST" && error.code !== "ENOENT")
                throw error;
            }
          }
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          try {
            if (current) closeArchive(current);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }
    },
    finish() {
      if (failed || refreshCount < 1) fail("outer signing callback did not complete");
      try {
        for (const record of validatedRecords) assertFileRecord(context, record);
        const verified = verifyPackagedAsarIntegrity(context.app);
        if (
          verified.archiveSha256 !== expected.archive ||
          verified.plistSha256 !== expected.plist ||
          verified.payloadSha256 !== originalPayload
        )
          fail("archive or plist changed after outer sealing");
        for (const record of validatedRecords) assertFileRecord(context, record);
        return { ...verified, refreshCount };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  };
}
