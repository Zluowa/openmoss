#!/usr/bin/env node
// FILE: build-windows-job-launcher.mjs
// Purpose: Builds apps/server/native/moss-job-launch (Windows) with the pinned LLVM and refuses
//          any result whose bytes differ from moss-job-launch.pin.json.
//
// The launcher links no C runtime and takes its kernel32 imports from kernel32.def (turned into
// an import library by llvm-dlltool), so its bytes depend only on the LLVM version: clang and
// lld-link with -Brepro produce the same file on every machine with that version. A different
// LLVM version is refused before compiling; a different result is refused after. Nothing
// unpinned is ever written to the output path.
//
//   node apps/server/scripts/build-windows-job-launcher.mjs [--out <file>] [--update-pin]
//
// The toolchain is LLVM_BIN (MOSS_WINDOWS_LLVM_BIN, default C:\Program Files\LLVM\bin) with
// clang.exe, lld-link.exe and llvm-dlltool.exe. Headers come from the Windows SDK and Visual
// Studio's include folders that clang finds itself; they declare only, so they do not change
// the bytes. --update-pin records a new sha256 after a deliberate source change (review it).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_JOB_LAUNCHER_NAME = "moss-job-launch.exe";

const scriptPath = fileURLToPath(import.meta.url);
const serverDirectory = resolve(dirname(scriptPath), "..");
export const windowsJobLauncherSourceDirectory = join(serverDirectory, "native", "moss-job-launch");
export const windowsJobLauncherPinPath = join(
  windowsJobLauncherSourceDirectory,
  "moss-job-launch.pin.json",
);
export const defaultWindowsJobLauncherPath = join(
  windowsJobLauncherSourceDirectory,
  "build",
  WINDOWS_JOB_LAUNCHER_NAME,
);
const DEFAULT_LLVM_BIN = "C:\\Program Files\\LLVM\\bin";
const MAX_BINARY_BYTES = 1024 * 1024;

/** Compiler and linker flags. Changing any of them changes the bytes: update the pin with it. */
export const WINDOWS_JOB_LAUNCHER_CLANG_ARGUMENTS = Object.freeze([
  "--target=x86_64-pc-windows-msvc",
  "-O2",
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-ffreestanding",
  "-fno-builtin",
  "-fno-stack-protector",
  "-nostdlib",
  "-fuse-ld=lld",
  "-Wl,-entry:mossJobLaunchEntry",
  "-Wl,-subsystem:console",
  "-Wl,-nodefaultlib",
  // Replaces the link timestamp with a hash of the output, so two builds are identical.
  "-Wl,-Brepro",
]);

export function readWindowsJobLauncherPin(path = windowsJobLauncherPinPath) {
  const pin = JSON.parse(readFileSync(path, "utf8"));
  if (pin?.schemaVersion !== 1 || typeof pin.llvm?.version !== "string") {
    throw new Error(`${path} is not a moss-job-launch pin (schemaVersion 1 with llvm.version).`);
  }
  if (typeof pin.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pin.sha256)) {
    throw new Error(`${path} has no valid sha256.`);
  }
  return pin;
}

/** "clang version 23.1.2 (...)" -> "23.1.2"; null when the first line names no version. */
export function parseLlvmVersion(versionOutput) {
  const match =
    /\b(?:clang|LLD) version (\d+\.\d+\.\d+)\b/u.exec(versionOutput) ??
    /\bLLD (\d+\.\d+\.\d+)\b/u.exec(versionOutput);
  return match ? match[1] : null;
}

/** Throws a message that says what to install when the toolchain is not the pinned one. */
export function assertPinnedLlvm({ tool, found, pinned, llvmBin }) {
  if (found === pinned) return;
  throw new Error(
    [
      `moss-job-launch must be built with LLVM ${pinned}; ${tool} in ${llvmBin} is ${found ?? "of an unknown version"}.`,
      `The pinned bytes come only from that version. Install LLVM ${pinned} (https://github.com/llvm/llvm-project/releases/tag/llvmorg-${pinned})`,
      "and point MOSS_WINDOWS_LLVM_BIN at its bin folder. Never ship bytes built with another version.",
    ].join("\n"),
  );
}

export function assertPinnedBytes({ sha256, pinned }) {
  if (sha256 === pinned) return;
  throw new Error(
    [
      `moss-job-launch.exe built with the pinned LLVM has sha256 ${sha256}, but the pin is ${pinned}.`,
      "Either the source, kernel32.def or the flags changed (rebuild with --update-pin and review the change),",
      "or the toolchain is not the release it claims to be. The result was not written.",
    ].join("\n"),
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? windowsJobLauncherSourceDirectory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status === 0) return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  throw new Error(
    `${command} ${args.join(" ")} failed with exit code ${result.status}:\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  );
}

export function buildWindowsJobLauncher({
  outputPath = defaultWindowsJobLauncherPath,
  updatePin = false,
  llvmBin = process.env.MOSS_WINDOWS_LLVM_BIN?.trim() || DEFAULT_LLVM_BIN,
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("moss-job-launch is built on Windows (it needs the Windows SDK headers).");
  }
  const pin = readWindowsJobLauncherPin();
  const clang = join(llvmBin, "clang.exe");
  const lld = join(llvmBin, "lld-link.exe");
  const dlltool = join(llvmBin, "llvm-dlltool.exe");
  assertPinnedLlvm({
    tool: "clang.exe",
    found: parseLlvmVersion(run(clang, ["--version"])),
    pinned: pin.llvm.version,
    llvmBin,
  });
  assertPinnedLlvm({
    tool: "lld-link.exe",
    found: parseLlvmVersion(run(lld, ["--version"])),
    pinned: pin.llvm.version,
    llvmBin,
  });

  const temporary = mkdtempSync(join(tmpdir(), "moss-job-launch-"));
  try {
    const importLibrary = join(temporary, "kernel32.lib");
    run(dlltool, ["-m", "i386:x86-64", "-d", "kernel32.def", "-l", importLibrary]);
    const built = join(temporary, WINDOWS_JOB_LAUNCHER_NAME);
    run(clang, [
      ...WINDOWS_JOB_LAUNCHER_CLANG_ARGUMENTS,
      // clang finds lld-link.exe beside itself; -fuse-ld=lld picks it.
      importLibrary,
      "moss-job-launch.c",
      "-o",
      built,
    ]);
    const bytes = readFileSync(built);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BINARY_BYTES) {
      throw new Error(`moss-job-launch.exe has an unexpected size (${bytes.byteLength} bytes).`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (updatePin) {
      writeFileSync(
        windowsJobLauncherPinPath,
        `${JSON.stringify({ ...pin, sha256, size: bytes.byteLength }, null, 2)}\n`,
      );
    } else {
      assertPinnedBytes({ sha256, pinned: pin.sha256 });
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    const staged = `${outputPath}.${process.pid}.tmp`;
    copyFileSync(built, staged);
    renameSync(staged, outputPath);
    return { outputPath, sha256, size: bytes.byteLength, llvmVersion: pin.llvm.version };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  try {
    const result = buildWindowsJobLauncher({
      ...(outIndex >= 0 && args[outIndex + 1] ? { outputPath: resolve(args[outIndex + 1]) } : {}),
      updatePin: args.includes("--update-pin"),
    });
    console.log(
      `[moss-job-launch] ${result.outputPath} (${result.size} bytes, sha256 ${result.sha256}, LLVM ${result.llvmVersion})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
