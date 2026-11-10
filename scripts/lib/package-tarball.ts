// FILE: package-tarball.ts
// Purpose: Packs an installed package directory into an npm-compatible .tgz (ustar, `package/` root).
// Layer: Release/build script support
// Exports: createPackageTarball, PACKAGE_TARBALL_MTIME

import * as FS from "node:fs";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

/** npm's own reproducible tarball timestamp (1985-10-26T08:15:00Z). */
export const PACKAGE_TARBALL_MTIME = 499162500;

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function header(name: string, size: number, mode: number): Buffer {
  const block = Buffer.alloc(512, 0);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    // ustar splits a long path at a "/" into a 155-byte prefix and a 100-byte name.
    const split = name.lastIndexOf("/", name.length - 1);
    for (let index = split; index > 0; index = name.lastIndexOf("/", index - 1)) {
      if (
        Buffer.byteLength(name.slice(index + 1)) <= 100 &&
        Buffer.byteLength(name.slice(0, index)) <= 155
      ) {
        prefix = name.slice(0, index);
        fileName = name.slice(index + 1);
        break;
      }
    }
    if (!prefix) throw new Error(`Path is too long for a package tarball: ${name}`);
  }
  block.write(fileName, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(size, 12), 124, 12, "ascii");
  block.write(octal(PACKAGE_TARBALL_MTIME, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write("0", 156, 1, "ascii");
  block.write("ustar\u000000", 257, 8, "ascii");
  block.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function listFiles(root: string, relative = ""): string[] {
  const result: string[] = [];
  for (const entry of FS.readdirSync(Path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    // Installed copies may carry package-manager markers and nested dependency
    // folders; neither belongs to the package itself.
    if (entry.name === "node_modules" || entry.name.startsWith(".bun-tag")) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing to pack a symbolic link: ${child}`);
    if (entry.isDirectory()) result.push(...listFiles(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

/** Deterministic file order and metadata; contents are exactly the installed files. */
export function createPackageTarball(directory: string): Buffer {
  const chunks: Buffer[] = [];
  for (const file of listFiles(directory).toSorted()) {
    const absolute = Path.join(directory, file);
    const contents = FS.readFileSync(absolute);
    const executable = (FS.statSync(absolute).mode & 0o111) !== 0;
    chunks.push(header(`package/${file}`, contents.length, executable ? 0o755 : 0o644), contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}
