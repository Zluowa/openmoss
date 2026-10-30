import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { afterEach, expect } from "vitest";

import { assertPackagedMacDeviceHelper } from "./build-desktop-artifact.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createDistFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "moss-mac-device-helper-"));
  temporaryRoots.push(root);
  return root;
}

function createHelperApp(stageDistDir: string, directoryName: string, valid = true): string {
  const appPath = join(stageDistDir, directoryName, "Moss.app");
  const helperRoot = join(appPath, "Contents", "Resources", "device-helper");
  mkdirSync(helperRoot, { recursive: true });
  if (valid) {
    mkdirSync(join(helperRoot, "Sources"), { recursive: true });
    writeFileSync(join(helperRoot, "build.sh"), "#!/bin/sh\n");
    writeFileSync(join(helperRoot, "Sources", "main.swift"), "import Foundation\n");
  }
  return appPath;
}

async function nodeServices(): Promise<{
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return {
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
      };
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

function runAssertion(stageDistDir: string) {
  return Effect.runPromise(
    assertPackagedMacDeviceHelper(stageDistDir, "Moss").pipe(Effect.provide(NodeServices.layer)),
  );
}

describe("packaged macOS device helper validation", () => {
  it("skips a DMG file before selecting the unpacked app directory", async () => {
    const stageDistDir = createDistFixture();
    writeFileSync(join(stageDistDir, "Moss-0.7.1-arm64.dmg"), "not a directory\n");
    createHelperApp(stageDistDir, "mac-arm64");

    await runAssertion(stageDistDir);
  });

  it("fails closed when no unpacked app contains the helper sources", async () => {
    const stageDistDir = createDistFixture();
    writeFileSync(join(stageDistDir, "Moss-0.7.1-arm64.dmg"), "not a directory\n");
    createHelperApp(stageDistDir, "mac-arm64", false);

    await expect(runAssertion(stageDistDir)).rejects.toThrow(
      "Packaged macOS app is missing physical device helper sources",
    );
  });

  it("skips wrong app candidates across multiple directories and finds the valid app", async () => {
    const stageDistDir = createDistFixture();
    createHelperApp(stageDistDir, "mac-x64", false);
    createHelperApp(stageDistDir, "mac-arm64");

    await runAssertion(stageDistDir);
  });

  it("does not turn a real entry stat error into a missing-helper result", async () => {
    const stageDistDir = createDistFixture();
    const brokenEntry = join(stageDistDir, "mac-arm64");
    mkdirSync(brokenEntry);
    const services = await nodeServices();
    const permissionDenied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "stat",
      pathOrDescriptor: brokenEntry,
    });
    const fileSystem: FileSystem.FileSystem = {
      ...services.fileSystem,
      stat: (candidatePath) =>
        candidatePath === brokenEntry
          ? Effect.fail(permissionDenied)
          : services.fileSystem.stat(candidatePath),
    };

    await expect(
      Effect.runPromise(
        assertPackagedMacDeviceHelper(stageDistDir, "Moss").pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, services.path),
        ),
      ),
    ).rejects.toMatchObject({ reason: { _tag: "PermissionDenied" } });
  });
});
