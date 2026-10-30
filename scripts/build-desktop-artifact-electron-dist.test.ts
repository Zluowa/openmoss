import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendElectronDistReceiptProvenance,
  assertElectronDistProvenanceUnchanged,
  BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES,
  BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES,
  BUILD_COMMAND_FAILURE_SANITIZER_INPUT_CAP_BYTES,
  BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES,
  BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
  BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES,
  BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
  BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES,
  BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES,
  BUILD_COMMAND_FAILURE_MAX_SENSITIVE_TOTAL_UTF8_BYTES,
  computeElectronDistTreeFingerprint,
  copyAndFinalizeDesktopRelease,
  createBuildCommandFailureCapturePolicy,
  createBuildCommandFailureSanitizerState,
  electronDistBuildConfig,
  electronDistReceiptProvenance,
  isSensitiveAssignmentKey,
  runCommand,
  resolveElectronDistProvenance,
  inspectBuildCommandFailureSanitization,
  inspectBuildCommandFailureTail,
  normalizeBuildCommandFailureDiagnostics,
  sanitizeBuildCommandFailureTail,
  sanitizeBuildCommandFailureText,
  stageElectronDist,
  type BuildCommandFailureCapturePolicy,
  type ElectronDistInspectionCommandInput,
  type BuildCommandFailureReceipt,
} from "./build-desktop-artifact.ts";

const EXPECTED_ELECTRON_VERSION = "43.1.1";
const temporaryRoots: string[] = [];

type FakeCommandInput = {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly verbose?: boolean;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdoutChunks?: ReadonlyArray<Uint8Array>;
  readonly stderrChunks?: ReadonlyArray<Uint8Array>;
  readonly spawnFailure?: unknown;
  readonly processFailure?: unknown;
  readonly events?: string[];
  readonly lifecycle?: CaptureLifecycleEvent[];
};

type CaptureLifecycleEvent = {
  readonly stream: "stdout" | "stderr";
  readonly phase: "before-finish" | "after-dispose";
  readonly retainedBytes: number;
  readonly localSensitiveValueCount: number;
  readonly hasSuppressionCallback: boolean;
  readonly listenerCount: number;
  readonly repeatFinalResultEqual: boolean;
  readonly snapshotMode: "normal" | "suppressed";
  readonly snapshotAcceptedSensitiveValueCount: number;
  readonly snapshotAcceptedSensitiveValueUtf8Bytes: number;
  readonly accountingMode: "normal" | "suppressed";
  readonly accountingAcceptedSensitiveValueCount: number;
  readonly accountingAcceptedSensitiveValueUtf8Bytes: number;
};

type BuildCommandFailure = {
  readonly failureReceipt: BuildCommandFailureReceipt;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moss-electron-dist-p1-"));
  temporaryRoots.push(root);
  return root;
}

function splitEncodedText(text: string): ReadonlyArray<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let firstNonAscii = 0;
  while (firstNonAscii < text.length && text.charCodeAt(firstNonAscii) < 0x80) {
    firstNonAscii += 1;
  }
  const firstSplit = Math.min(
    bytes.length - 1,
    encoder.encode(text.slice(0, firstNonAscii)).length + 1,
  );
  const secondSplit = Math.max(firstSplit + 1, Math.floor(bytes.length / 2));
  return [
    bytes.subarray(0, firstSplit),
    bytes.subarray(firstSplit, secondSplit),
    bytes.subarray(secondSplit),
  ];
}

function splitIntoUtf16Chunks(text: string): ReadonlyArray<string> {
  return text.split("");
}

function runFakeCommand(input: FakeCommandInput): Promise<void> {
  const encoder = new TextEncoder();
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(4242),
    exitCode:
      input.processFailure !== undefined
        ? Effect.fail(input.processFailure as never)
        : input.signal === undefined
          ? Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 1))
          : Effect.fail(
              new Error(`Process interrupted due to receipt of signal: '${input.signal}'`) as never,
            ),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.fromIterable(input.stdoutChunks ?? [encoder.encode(input.stdout ?? "")]),
    stderr: Stream.fromIterable(input.stderrChunks ?? [encoder.encode(input.stderr ?? "")]),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  const spawner = ChildProcessSpawner.make(() => {
    input.events?.push("spawn");
    return input.spawnFailure === undefined
      ? Effect.succeed(handle)
      : Effect.fail(input.spawnFailure as never);
  });
  const command = ChildProcess.make(
    "/usr/bin/fake-builder",
    input.args ?? ["--projectDir", "/tmp/stage"],
    { env: input.env, stdout: "pipe", stderr: "pipe" },
  );
  const program = runCommand(command, {
    captureOutput: true,
    verbose: input.verbose ?? false,
    onCaptureLifecycleForTest: (event: CaptureLifecycleEvent) => {
      input.lifecycle?.push(event);
    },
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  return Effect.runPromise(Effect.scoped(program));
}

async function expectBuildCommandFailure(input: FakeCommandInput): Promise<BuildCommandFailure> {
  try {
    await runFakeCommand(input);
  } catch (cause) {
    return cause as BuildCommandFailure;
  }
  throw new Error("Expected the fake builder command to fail");
}

function createElectronDistFixture(
  root: string,
  mainBinaryContents: string | Buffer = "fixture electron main binary\n",
): {
  readonly sourceDist: string;
  readonly sourceMainBinary: string;
  readonly sourceResource: string;
} {
  const sourceDist = join(root, "source-dist");
  const contents = join(sourceDist, "Electron.app", "Contents");
  const macOs = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  mkdirSync(macOs, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), "fixture plist\n");
  const sourceMainBinary = join(macOs, "Electron");
  writeFileSync(sourceMainBinary, mainBinaryContents);
  const sourceResource = join(resources, "resource.txt");
  writeFileSync(sourceResource, "fixture resource\n");
  if (process.platform !== "win32") {
    symlinkSync("resource.txt", join(resources, "resource-link.txt"));
  }
  return { sourceDist, sourceMainBinary, sourceResource };
}

function createInspectionCommand(
  observedEnvironments: NodeJS.ProcessEnv[],
  failureCommand?: string,
) {
  return (input: ElectronDistInspectionCommandInput): string => {
    observedEnvironments.push(input.env);
    const commandName = input.command.split("/").at(-1);
    if (commandName === failureCommand) {
      throw new Error(`${commandName} failed in fixture inspector`);
    }
    if (commandName === "plutil") return EXPECTED_ELECTRON_VERSION;
    if (commandName === "file") return "fixture: Mach-O 64-bit executable arm64";
    if (commandName === "lipo") return "arm64";
    throw new Error(`unexpected inspection command ${input.command}`);
  };
}

function stageFixture(mainBinaryContents?: string | Buffer) {
  const root = createTemporaryRoot();
  const fixture = createElectronDistFixture(root, mainBinaryContents);
  const stageRoot = join(root, "private-stage");
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  chmodSync(stageRoot, 0o700);
  const staged = stageElectronDist({
    rawPath: fixture.sourceDist,
    stageRoot,
    platform: "mac",
    arch: "arm64",
  });
  if (!staged) throw new Error("expected a staged Electron dist");
  return { fixture, staged };
}

function resolveStagedProvenance(
  stagedPath: string,
  observedEnvironments: NodeJS.ProcessEnv[] = [],
  failureCommand?: string,
  sourceRealpath = stagedPath,
) {
  return resolveElectronDistProvenance({
    distPath: stagedPath,
    sourceRealpath,
    platform: "mac",
    arch: "arm64",
    expectedVersion: EXPECTED_ELECTRON_VERSION,
    inspectionEnv: { MOSS_DESKTOP_ELECTRON_DIST: "must-not-leak" },
    runInspectionCommand: createInspectionCommand(observedEnvironments, failureCommand),
  });
}

describe("offline Electron dist seam", () => {
  it("keeps the unset env behavior unchanged", () => {
    expect(
      stageElectronDist({
        rawPath: undefined,
        stageRoot: createTemporaryRoot(),
        platform: "mac",
        arch: "arm64",
      }),
    ).toBeUndefined();
    expect(electronDistBuildConfig(undefined)).toEqual({});
    expect(electronDistReceiptProvenance(undefined)).toBeUndefined();
  });

  it("fails closed for relative, missing, non-directory, and non-target inputs", () => {
    const root = createTemporaryRoot();
    const nonDirectory = join(root, "not-a-directory");
    writeFileSync(nonDirectory, "fixture\n");

    expect(() =>
      stageElectronDist({
        rawPath: "relative/electron-dist",
        stageRoot: root,
        platform: "mac",
        arch: "arm64",
      }),
    ).toThrow(/absolute/u);
    expect(() =>
      stageElectronDist({
        rawPath: join(root, "does-not-exist"),
        stageRoot: root,
        platform: "mac",
        arch: "arm64",
      }),
    ).toThrow();
    expect(() =>
      stageElectronDist({
        rawPath: nonDirectory,
        stageRoot: root,
        platform: "mac",
        arch: "arm64",
      }),
    ).toThrow(/directory/u);
    expect(() =>
      stageElectronDist({
        rawPath: nonDirectory,
        stageRoot: root,
        platform: "linux",
        arch: "x64",
      }),
    ).toThrow(/mac\/arm64/u);
  });

  it("fails closed when the staged Electron.app is missing or has the wrong version", () => {
    const root = createTemporaryRoot();
    const sourceWithoutApp = join(root, "source-without-app");
    mkdirSync(sourceWithoutApp, { recursive: true });
    const stageRoot = join(root, "private-stage");
    mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    const stagedWithoutApp = stageElectronDist({
      rawPath: sourceWithoutApp,
      stageRoot,
      platform: "mac",
      arch: "arm64",
    });
    if (!stagedWithoutApp) throw new Error("expected staged fixture");
    expect(() => resolveStagedProvenance(stagedWithoutApp.realpath)).toThrow(/Electron\.app/u);

    const { staged } = stageFixture();
    expect(() =>
      resolveElectronDistProvenance({
        distPath: staged.realpath,
        sourceRealpath: staged.realpath,
        platform: "mac",
        arch: "arm64",
        expectedVersion: EXPECTED_ELECTRON_VERSION,
        runInspectionCommand: (input) => {
          if (input.command.endsWith("plutil")) return "43.1.0";
          return createInspectionCommand([])(input);
        },
      }),
    ).toThrow(/43\.1\.1/u);
  });

  it("copies the source into a private stage before validation and never gives the builder the source path", () => {
    const { fixture, staged } = stageFixture(Buffer.alloc(1024 * 1024 + 123, 0x5a));
    const environments: NodeJS.ProcessEnv[] = [];
    const provenance = resolveStagedProvenance(
      staged.realpath,
      environments,
      undefined,
      staged.sourceRealpath,
    );

    expect(staged.realpath).not.toBe(fixture.sourceDist);
    if (process.platform !== "win32") {
      expect(statSync(dirname(staged.realpath)).mode & 0o777).toBe(0o700);
    }
    expect(provenance.realpath).toBe(staged.realpath);
    expect(electronDistBuildConfig(provenance)).toEqual({
      electronDist: staged.realpath,
    });
    expect(provenance.treeFingerprint).toBe(computeElectronDistTreeFingerprint(staged.realpath));
    expect(electronDistReceiptProvenance(provenance)).toMatchObject({
      source: "MOSS_DESKTOP_ELECTRON_DIST",
      sourceRealpath: staged.sourceRealpath,
      stagedDuringBuild: true,
      realpath: staged.realpath,
      version: EXPECTED_ELECTRON_VERSION,
      arch: "arm64",
      mainBinarySha256: createHash("sha256")
        .update(readFileSync(join(staged.realpath, "Electron.app/Contents/MacOS/Electron")))
        .digest("hex"),
      treeFingerprint: provenance.treeFingerprint,
      hashMeaning: "SHA-256 of Electron.app/Contents/MacOS/Electron; not a signature",
    });
    expect(environments).not.toHaveLength(0);
    for (const environment of environments) {
      expect(environment).not.toHaveProperty("MOSS_DESKTOP_ELECTRON_DIST");
    }
  });

  it("fails closed for plutil, file, and lipo inspection failures", () => {
    for (const command of ["plutil", "file", "lipo"]) {
      const { staged } = stageFixture();
      expect(() => resolveStagedProvenance(staged.realpath, [], command)).toThrow(command);
    }
  });

  it("keeps the staged copy independent when the source changes after copying", () => {
    const { fixture, staged } = stageFixture();
    writeFileSync(fixture.sourceMainBinary, "source changed after copy\n");
    writeFileSync(fixture.sourceResource, "source resource changed after copy\n");

    expect(
      readFileSync(join(staged.realpath, "Electron.app/Contents/MacOS/Electron"), "utf8"),
    ).toBe("fixture electron main binary\n");
    expect(
      readFileSync(join(staged.realpath, "Electron.app/Contents/Resources/resource.txt"), "utf8"),
    ).toBe("fixture resource\n");
  });

  it("blocks publication when the private stage changes during the builder", () => {
    const { staged } = stageFixture();
    const provenance = resolveStagedProvenance(staged.realpath);
    writeFileSync(
      join(staged.realpath, "Electron.app/Contents/Resources/resource.txt"),
      "builder mutation\n",
    );

    expect(() => assertElectronDistProvenanceUnchanged(provenance)).toThrow(/fingerprint/u);
  });

  it.runIf(process.platform !== "win32")(
    "updates the receipt atomically and revalidates the persisted electronDist fields",
    () => {
      const { staged } = stageFixture();
      const provenance = resolveStagedProvenance(staged.realpath);
      const receiptPath = join(dirname(staged.realpath), "receipt.json");
      const originalReceipt = {
        schemaVersion: 1,
        kind: "fixture-receipt",
        artifacts: [],
      };
      writeFileSync(receiptPath, `${JSON.stringify(originalReceipt)}\n`);
      let verified = false;

      appendElectronDistReceiptProvenance({
        receiptPath,
        provenance,
        verifyUpdatedReceipt: () => {
          verified = true;
          expect(JSON.parse(readFileSync(receiptPath, "utf8")).electronDist).toMatchObject({
            realpath: staged.realpath,
            treeFingerprint: provenance.treeFingerprint,
          });
        },
      });

      expect(verified).toBe(true);
      expect(JSON.parse(readFileSync(receiptPath, "utf8")).electronDist).toMatchObject({
        realpath: staged.realpath,
        version: EXPECTED_ELECTRON_VERSION,
        arch: "arm64",
        treeFingerprint: provenance.treeFingerprint,
      });
      expect(readdirSync(dirname(receiptPath))).toEqual(expect.arrayContaining(["receipt.json"]));
      expect(readdirSync(dirname(receiptPath)).filter((name) => name.includes(".tmp"))).toEqual([]);
    },
  );

  it("keeps the old receipt and cleans the unique temp file when atomic writing fails", () => {
    const { staged } = stageFixture();
    const provenance = resolveStagedProvenance(staged.realpath);
    const receiptPath = join(dirname(staged.realpath), "receipt.json");
    const originalBytes = Buffer.from('{"old":true}\n');
    writeFileSync(receiptPath, originalBytes);
    let tempPath: string | undefined;

    expect(() =>
      appendElectronDistReceiptProvenance({
        receiptPath,
        provenance,
        beforeRename: (candidatePath) => {
          tempPath = candidatePath;
          if (process.platform !== "win32") {
            expect(statSync(candidatePath).mode & 0o777).toBe(0o600);
          }
          throw new Error("simulated atomic write failure");
        },
      }),
    ).toThrow(
      process.platform === "win32"
        ? "Receipt update failed and the previous receipt could not be restored."
        : "simulated atomic write failure",
    );

    expect(readFileSync(receiptPath)).toEqual(originalBytes);
    expect(tempPath).toBeDefined();
    expect(existsSync(tempPath!)).toBe(false);
  });

  it("cleans only this copy's files after post-copy finalization failure and permits retry", () => {
    const root = createTemporaryRoot();
    const outputDir = join(root, "output");
    mkdirSync(outputDir, { recursive: true });
    const artifactNames = ["first-artifact.zip", "second-artifact.json"];
    const receiptPath = join(outputDir, "receipt.json");
    const sentinelPath = join(outputDir, "preexisting-sentinel.txt");
    writeFileSync(sentinelPath, "keep me\n");
    writeFileSync(join(outputDir, "unrelated.txt"), "do not scan me\n");

    const copy = () => {
      const receipt = { artifacts: artifactNames.map((fileName) => ({ fileName })) };
      for (const fileName of artifactNames) writeFileSync(join(outputDir, fileName), "artifact\n");
      writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
      return { receiptPath, receipt };
    };

    expect(() =>
      copyAndFinalizeDesktopRelease({
        outputDir,
        copy,
        finalize: () => {
          throw new Error("append/verify failure");
        },
      }),
    ).toThrow(
      process.platform === "win32"
        ? "Post-copy release finalization failed and cleanup also failed."
        : "append/verify failure",
    );
    for (const fileName of artifactNames) expect(existsSync(join(outputDir, fileName))).toBe(false);
    expect(existsSync(receiptPath)).toBe(false);
    expect(readFileSync(sentinelPath, "utf8")).toBe("keep me\n");
    expect(readFileSync(join(outputDir, "unrelated.txt"), "utf8")).toBe("do not scan me\n");

    const retried = copyAndFinalizeDesktopRelease({
      outputDir,
      copy,
      finalize: () => undefined,
    });
    expect(retried.receiptPath).toBe(receiptPath);
    for (const fileName of artifactNames) expect(existsSync(join(outputDir, fileName))).toBe(true);
    expect(existsSync(receiptPath)).toBe(true);

    expect(() =>
      copyAndFinalizeDesktopRelease({
        outputDir: join(root, "cleanup-failure-output"),
        copy: () => {
          const cleanupOutputDir = join(root, "cleanup-failure-output");
          mkdirSync(cleanupOutputDir, { recursive: true });
          const cleanupReceiptPath = join(cleanupOutputDir, "receipt.json");
          const cleanupReceipt = { artifacts: [{ fileName: "cleanup-artifact.zip" }] };
          writeFileSync(join(cleanupOutputDir, "cleanup-artifact.zip"), "artifact\n");
          writeFileSync(cleanupReceiptPath, `${JSON.stringify(cleanupReceipt)}\n`);
          return { receiptPath: cleanupReceiptPath, receipt: cleanupReceipt };
        },
        finalize: () => {
          throw new Error("finalization failure");
        },
        removeFile: (filePath: string) => {
          if (filePath.endsWith("cleanup-artifact.zip")) throw new Error("unlink failure");
          unlinkSync(filePath);
        },
      }),
    ).toThrow(/cleanup/u);
  });
});

describe("builder command failure receipts", () => {
  it("keeps the successful exit behavior unchanged", async () => {
    await expect(runFakeCommand({ exitCode: 0 })).resolves.toBeUndefined();
  });

  it("reports a non-zero exit code with the bounded structured receipt", async () => {
    const failure = await expectBuildCommandFailure({ exitCode: 1 });

    expect(failure.failureReceipt).toMatchObject({
      command: "/usr/bin/fake-builder --projectDir /tmp/stage",
      pid: 4242,
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "",
    });
    expect(failure.failureReceipt.cause).toBe("exit-code:1");
    expect(Date.parse(failure.failureReceipt.startedAt)).not.toBeNaN();
    expect(Date.parse(failure.failureReceipt.endedAt)).not.toBeNaN();
    expect(failure.failureReceipt.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a signal termination separately from an exit code", async () => {
    const failure = await expectBuildCommandFailure({ signal: "SIGTERM" });

    expect(failure.failureReceipt).toMatchObject({
      pid: 4242,
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(failure.failureReceipt.cause).toContain("SIGTERM");
  });

  it("builds a bounded sensitive-value policy and fails closed at every limit", () => {
    const exactSingleValue = "a".repeat(8 * 1024);
    const exactSingle = createBuildCommandFailureCapturePolicy(
      { sensitiveValues: [exactSingleValue] },
      {},
    );
    const oversizedSingle = createBuildCommandFailureCapturePolicy(
      { sensitiveValues: ["b".repeat(8 * 1024 + 1)] },
      {},
    );
    const exactAggregate = createBuildCommandFailureCapturePolicy(
      {
        sensitiveValues: Array.from(
          { length: 8 },
          (_, index) => "c".repeat(8 * 1024 - 1) + String.fromCharCode(65 + index),
        ),
      },
      {},
    );
    const oversizedAggregate = createBuildCommandFailureCapturePolicy(
      {
        sensitiveValues: Array.from(
          { length: 8 },
          (_, index) => "d".repeat(8 * 1024 - 1) + String.fromCharCode(65 + index),
        ).concat("e"),
      },
      {},
    );
    const exactCount = createBuildCommandFailureCapturePolicy(
      { sensitiveValues: Array.from({ length: 32 }, (_, index) => `count-${index}`) },
      {},
    );
    const oversizedCount = createBuildCommandFailureCapturePolicy(
      { sensitiveValues: Array.from({ length: 33 }, (_, index) => `overflow-${index}`) },
      {},
    );
    const allowlisted = createBuildCommandFailureCapturePolicy(
      {
        additionalEnvironment: {
          CSC_LINK: "synthetic-csc-link",
          APPLE_API_KEY_ID: "synthetic-apple-key-id",
          NORMAL_VALUE: "ordinary-value",
        },
      },
      {},
    );

    expect(exactSingle.mode).toBe("normal");
    expect(exactSingle.values).toHaveLength(1);
    expect(oversizedSingle.mode).toBe("suppressed");
    expect(oversizedSingle.values).toHaveLength(0);
    expect(exactAggregate.mode).toBe("normal");
    expect(exactAggregate.values).toHaveLength(8);
    expect(oversizedAggregate.mode).toBe("suppressed");
    expect(oversizedAggregate.values).toHaveLength(0);
    expect(exactCount.mode).toBe("normal");
    expect(exactCount.values).toHaveLength(BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES);
    expect(oversizedCount.mode).toBe("suppressed");
    expect(oversizedCount.values).toHaveLength(0);
    expect(allowlisted.mode).toBe("normal");
    expect(allowlisted.values).toHaveLength(2);
    expect(BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES).toBe(8 * 1024);
    expect(BUILD_COMMAND_FAILURE_MAX_SENSITIVE_TOTAL_UTF8_BYTES).toBe(64 * 1024);
  });

  it("fails closed for forged sanitizer policies before retaining any sensitive refs", () => {
    const sentinel = "synthetic-forged-policy-secret";
    const forgedPolicies: ReadonlyArray<unknown> = [
      {
        mode: "normal",
        reason: "within-bounds",
        values: Array.from(
          { length: BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES + 1 },
          () => "count",
        ),
        acceptedValueUtf8Bytes: 5 * (BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUES + 1),
      },
      {
        mode: "normal",
        reason: "within-bounds",
        values: ["s".repeat(BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES + 1)],
        acceptedValueUtf8Bytes: BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES + 1,
      },
      {
        mode: "normal",
        reason: "within-bounds",
        values: Array.from({ length: 9 }, () => "a".repeat(8 * 1024)),
        acceptedValueUtf8Bytes: 9 * 8 * 1024,
      },
      {
        mode: "forged",
        reason: sentinel,
        values: [sentinel],
        acceptedValueUtf8Bytes: Number.NaN,
      },
      {
        mode: "normal",
        reason: sentinel,
        values: [sentinel, 42],
        acceptedValueUtf8Bytes: "not-a-number",
      },
      {
        mode: "normal",
        reason: "within-bounds",
        values: [],
        acceptedValueUtf8Bytes: sentinel.length,
      },
    ];

    for (const forgedPolicy of forgedPolicies) {
      const suppressionReasons: string[] = [];
      const output: string[] = [];
      const state = createBuildCommandFailureSanitizerState(
        forgedPolicy as BuildCommandFailureCapturePolicy,
        {
          onOutputText: (text) => output.push(text),
          onSuppressed: (reason) => suppressionReasons.push(reason),
        },
      );

      state.consumeSanitizedChunk(`prefix ${sentinel}`);
      const result = state.finishSanitizedCapture();

      expect(state.mode()).toBe("suppressed");
      expect(state.retainedBytes).toBe(0);
      expect(result.sanitizedText).toBe(BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED);
      expect(suppressionReasons).toHaveLength(1);
      expect(suppressionReasons.some((reason) => reason.includes(sentinel))).toBe(false);
      expect(output.join("").includes(sentinel)).toBe(false);
      expect(JSON.stringify(result).includes(sentinel)).toBe(false);
    }

    const validPolicy: BuildCommandFailureCapturePolicy = {
      mode: "normal",
      reason: "within-bounds",
      values: [sentinel, "synthetic-forged-policy-second-secret"],
      acceptedValueUtf8Bytes: sentinel.length + "synthetic-forged-policy-second-secret".length,
    };
    const releasedOutput: string[] = [];
    const validState = createBuildCommandFailureSanitizerState(validPolicy, {
      onOutputText: (text) => releasedOutput.push(text),
      onSuppressed: () => undefined,
    });
    validState.consumeSanitizedChunk("ordinary text");
    expect(validState.localSensitiveValueCount).toBe(2);
    expect(validState.retainedBytes).toBeGreaterThan(0);
    expect(validState.listenerCount).toBe(1);
    expect(validState.hasSuppressionCallback).toBe(true);
    validState.dispose();
    validState.dispose();
    validState.consumeSanitizedChunk(`TOKEN=${sentinel}`);
    expect(validState.localSensitiveValueCount).toBe(0);
    expect(validState.retainedBytes).toBe(0);
    expect(validState.listenerCount).toBe(0);
    expect(validState.hasSuppressionCallback).toBe(false);
    const disposedResult = validState.finishSanitizedCapture();
    expect(disposedResult.sanitizedText).toBe("");
    expect(releasedOutput.join("").includes(sentinel)).toBe(false);
    expect(JSON.stringify({ disposedResult, releasedOutput }).includes(sentinel)).toBe(false);
  });

  it("covers signing and session secret key shapes without classifying ordinary keys", () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ["CSC_LINK", true],
      ["WIN_CSC_LINK", true],
      ["MAC_CSC_LINK", true],
      ["CUSTOM_CSC_LINK", true],
      ["SESSION", true],
      ["USER_SESSION", true],
      ["SESSION_TOKEN", true],
      ["SESSION_KEY", true],
      ["CSC_LINKED", false],
      ["SESSION_NAME", false],
      ["USER_SESSION_NAME", false],
      ["PROJECT_KEYBOARD", false],
    ];

    for (const [key, expected] of cases) {
      expect(isSensitiveAssignmentKey(key)).toBe(expected);
    }
  });

  it("does not leak an exact-cap sensitive value across a capture boundary", () => {
    const secret = "s".repeat(BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES);
    const tail = sanitizeBuildCommandFailureTail(
      [`prefix-${secret.slice(0, -1)}`, `${secret.slice(-1)}-suffix`],
      { sensitiveValues: [secret] },
    );

    expect(tail.includes(secret)).toBe(false);
    expect(tail).toContain("prefix-");
    expect(tail).toContain("-suffix");
  });

  it("suppresses all capture text while still allowing a normal child exit", async () => {
    const oversizedEnvironmentValue = "oversized-environment-value".repeat(400);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let failure: BuildCommandFailure;
    try {
      failure = await expectBuildCommandFailure({
        env: { CSC_LINK: oversizedEnvironmentValue },
        exitCode: 17,
        stdout: "synthetic-suppressed-stdout",
        stderr: "synthetic-suppressed-stderr",
      });
    } finally {
      stderrWrite.mockRestore();
    }

    expect(failure.failureReceipt).toMatchObject({
      command: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      cause: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      stdout: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      stderr: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      pid: 4242,
      exitCode: 17,
      signal: null,
    });
    expect(JSON.stringify(failure)).not.toContain("synthetic-suppressed-stdout");
    expect(JSON.stringify(failure)).not.toContain("synthetic-suppressed-stderr");
  });

  it("writes one suppression placeholder instead of raw verbose output", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let forwardedStdout = "";
    let forwardedStderr = "";
    const decodeOutputChunk = (chunk: string | Uint8Array): string =>
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    stdoutWrite.mockImplementation((chunk) => {
      forwardedStdout += decodeOutputChunk(chunk as string | Uint8Array);
      return true;
    });
    stderrWrite.mockImplementation((chunk) => {
      forwardedStderr += decodeOutputChunk(chunk as string | Uint8Array);
      return true;
    });

    try {
      await expectBuildCommandFailure({
        env: { CSC_KEY_PASSWORD: "z".repeat(8 * 1024 + 1) },
        exitCode: 19,
        stdout: "synthetic-verbose-suppressed-stdout",
        stderr: "synthetic-verbose-suppressed-stderr",
        verbose: true,
      });
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }

    const forwarded = `${forwardedStdout}${forwardedStderr}`;
    expect(forwarded.includes("synthetic-verbose-suppressed-stdout")).toBe(false);
    expect(forwarded.includes("synthetic-verbose-suppressed-stderr")).toBe(false);
    expect(forwarded.split(BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED).length - 1).toBe(1);
  });

  it("writes a pre-spawn suppression placeholder before a verbose child starts", async () => {
    const events: string[] = [];
    let forwarded = "";
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      events.push("output");
      forwarded += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await expectBuildCommandFailure({
        env: { CSC_LINK: "x".repeat(8 * 1024 + 1) },
        exitCode: 21,
        verbose: true,
        events,
      });
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }

    expect(events.indexOf("output")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("output")).toBeLessThan(events.indexOf("spawn"));
    expect(forwarded).toBe(BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED);
  });

  it("suppresses both streams and clears tails after a dynamic parser bound", async () => {
    const secret = "synthetic-dynamic-after-suppression-secret";
    const encoder = new TextEncoder();
    let forwarded = "";
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      forwarded += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      forwarded += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    });

    let failure: BuildCommandFailure;
    try {
      failure = await expectBuildCommandFailure({
        exitCode: 23,
        verbose: true,
        stdoutChunks: [
          encoder.encode("stdout-safe-marker "),
          encoder.encode(`https://${"a".repeat(9 * 1024)}${secret}`),
        ],
        stderrChunks: [encoder.encode(`stderr-after-suppression ${secret}`)],
      });
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }

    const serialized = JSON.stringify(failure!);
    expect(forwarded).toContain("stdout-safe-marker");
    expect(forwarded.includes(secret)).toBe(false);
    expect(serialized.includes(secret)).toBe(false);
    expect(failure!.failureReceipt).toMatchObject({
      command: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      cause: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      stdout: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      stderr: BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED,
      exitCode: 23,
    });
    expect(forwarded.split(BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED).length - 1).toBe(1);
  });

  it("reports zero retained capture bytes after a dynamic suppression", () => {
    const inspection = inspectBuildCommandFailureTail(
      [new TextEncoder().encode(`https://${"b".repeat(9 * 1024)}`)],
      { sensitiveValues: [] },
    );

    expect(inspection.tail).toBe(BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED);
    expect(inspection.retainedBytes).toBe(0);
    expect(inspection.accounting.mode).toBe("suppressed");
  });

  it("sanitizes credentials across every chunk boundary without regex-stage raw buffering", () => {
    const secret = "synthetic-stream-parser-secret";
    const text = [
      `Authorization: "Bearer ${secret}"`,
      `TOKEN = 'escaped\\'${secret}\\,still-secret'`,
      `--password ${secret}`,
      `https://user%40name:"${secret}"@middle@final.example.test/path?token=${secret}%26still-value`,
      "ordinary /tmp/build-artifact hash=0123456789abcdef 😀",
    ].join("\n");
    const sanitized = sanitizeBuildCommandFailureTail(splitIntoUtf16Chunks(text), {
      sensitiveValues: [],
    });
    const unterminated = sanitizeBuildCommandFailureTail(
      splitIntoUtf16Chunks(`TOKEN="${secret}\nordinary-path`),
      { sensitiveValues: [] },
    );

    expect(sanitized.includes(secret)).toBe(false);
    expect(unterminated.includes(secret)).toBe(false);
    expect(sanitized).toContain("https://<redacted>@final.example.test/path");
    expect(sanitized).toContain("/tmp/build-artifact");
    expect(sanitized).toContain("hash=0123456789abcdef");
    expect(sanitized).not.toContain("\uFFFD");
    expect(unterminated).toBe("TOKEN=<redacted>");
  });

  it("redacts unlisted credential assignments at the final tail boundary", () => {
    const secret = "synthetic-regex-tail-secret";
    const tail = sanitizeBuildCommandFailureTail(
      [
        "/tmp/build-artifact hash=0123456789abcdef",
        `TOKEN=${secret} password : '${secret}' Api-Key = "${secret}" Authorization: Bearer ${secret}`,
      ],
      { sensitiveValues: [] },
    );

    expect(tail.includes(secret)).toBe(false);
    expect(tail).toContain("hash=0123456789abcdef");
  });

  it("redacts complete quoted and newline-delimited authorization values", () => {
    const secret = "synthetic-quoted-authorization-secret";
    const text = [
      `Authorization: "Bearer ${secret}"`,
      `authorization = 'Basic ${secret}'`,
      `AUTHORIZATION  :  "${secret}"`,
      `authorization:\n  Bearer ${secret}`,
    ].join("\n");

    const sanitized = sanitizeBuildCommandFailureText(text, { sensitiveValues: [] });

    expect(sanitized.includes(secret)).toBe(false);
    expect(sanitized).toContain("Authorization: <redacted>");
    expect(sanitized).toContain("authorization = <redacted>");
    expect(sanitized).toContain("AUTHORIZATION  :  <redacted>");
  });

  it("removes complex URL userinfo through the last at-sign while retaining query redaction", () => {
    const secret = "synthetic-url-userinfo-secret";
    const text = [
      `https://user%40name:"${secret}"@middle@final.example.test/path`,
      `https://quoted-user:'${secret}'@next@final.example.test/other`,
      `https://final.example.test/path?token=${secret}`,
    ].join(" ");

    const sanitized = sanitizeBuildCommandFailureText(text, { sensitiveValues: [] });

    expect(sanitized.includes(secret)).toBe(false);
    expect(sanitized).not.toContain("middle@");
    expect(sanitized).not.toContain("next@");
    expect(sanitized).toContain("https://<redacted>@final.example.test/path");
    expect(sanitized).toContain("?token=<redacted>");
  });

  it("sanitizes userinfo and query credentials for generic RFC URL schemes", () => {
    const secret = "synthetic-generic-url-secret";
    const text = [
      `npm://user:${secret}@registry.example/path?token=${secret}`,
      `CuStOm+SsH://user:${secret}@host.example/path?auth=${secret}`,
      "npm://registry.example/plain/path",
    ].join(" ");

    const sanitized = sanitizeBuildCommandFailureText(text, { sensitiveValues: [] });

    expect(sanitized.includes(secret)).toBe(false);
    expect(sanitized).toContain("npm://<redacted>@registry.example/path?token=<redacted>");
    expect(sanitized).toContain("CuStOm+SsH://<redacted>@host.example/path?auth=<redacted>");
    expect(sanitized).toContain("npm://registry.example/plain/path");
  });

  it("redacts percent-encoded query separators for sensitive keys", () => {
    const secret = "synthetic-encoded-query-secret";
    const text = "https://host.example/path?token%3D" + secret + "&AUTH%3d" + secret;
    const sanitized = sanitizeBuildCommandFailureText(text, { sensitiveValues: [] });

    expect(sanitized.includes(secret)).toBe(false);
    expect(sanitized).toContain("?token%3D<redacted>&AUTH%3d<redacted>");
  });

  it("fails closed for an unterminated quoted URL authority", () => {
    const secret = "synthetic-unterminated-url-secret";
    const sanitized = sanitizeBuildCommandFailureText(`https://user:"${secret}@host.example/path`, {
      sensitiveValues: [],
    });

    expect(sanitized.includes(secret)).toBe(false);
    expect(sanitized).toBe(BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED);
  });

  it("redacts standalone Authorization Bearer and Basic tokens across chunks", () => {
    const bearer = "synthetic-standalone-bearer-secret";
    const basic = "synthetic-standalone-basic-secret";
    const sanitized = sanitizeBuildCommandFailureTail(
      ["Authorization Be", `arer ${bearer}\nBasic ${basic}`],
      { sensitiveValues: [] },
    );

    expect(sanitized).not.toContain(bearer);
    expect(sanitized).not.toContain(basic);
    expect(sanitized).toContain("Authorization Bearer <redacted>");
    expect(sanitized).toContain("Basic <redacted>");
  });

  it("bounds command and diagnostic metadata independently from failure text", async () => {
    const failure = await expectBuildCommandFailure({
      args: ["--ordinary", "x".repeat(10 * 1024)],
      processFailure: Object.assign(new Error("synthetic-diagnostic-message"), {
        code: `E${"A".repeat(2 * 1024)}`,
        errno: -32,
        syscall: "s".repeat(2 * 1024),
      }),
    });

    expect(Buffer.byteLength(failure.failureReceipt.command)).toBeLessThanOrEqual(2 * 1024);
    expect(Buffer.byteLength(failure.failureReceipt.cause)).toBeLessThanOrEqual(4 * 1024);
    expect(failure.failureReceipt.diagnostics.category).toBe("process");
    expect(
      failure.failureReceipt.diagnostics.code === null ||
        Buffer.byteLength(failure.failureReceipt.diagnostics.code) <= 128,
    ).toBe(true);
    expect(
      failure.failureReceipt.diagnostics.syscall === null ||
        Buffer.byteLength(failure.failureReceipt.diagnostics.syscall) <= 128,
    ).toBe(true);
  });

  it("suppresses the aggregate pending fields instead of exceeding the per-stream cap", () => {
    const secret = "v".repeat(BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES);
    const tail = sanitizeBuildCommandFailureTail([`SESSION=${secret}`], {
      sensitiveValues: [secret],
    });

    expect(tail).toBe(BUILD_COMMAND_FAILURE_CAPTURE_SUPPRESSED);
  });

  it("sanitizes credential forms without redacting ordinary paths or hashes", () => {
    const secrets = [
      "synthetic-env-secret",
      "synthetic-api-key",
      "synthetic-token",
      "synthetic-password",
      "synthetic-bearer",
      "synthetic-user",
      "synthetic-query-secret",
    ];
    const text = [
      `MOSS_TEST_TOKEN=${secrets[0]}`,
      `--api-key=${secrets[1]}`,
      `--token ${secrets[2]}`,
      `password=${secrets[3]}`,
      `Authorization: Bearer ${secrets[4]}`,
      `https://${secrets[5]}:password@example.test/build?token=${secrets[6]}`,
      "/tmp/build-artifact-abc123",
      "hash=0123456789abcdef",
    ].join(" ");

    const sanitized = sanitizeBuildCommandFailureText(text, {
      sensitiveValues: secrets,
      // Only the listed secrets: the ambient environment's sensitive values are redacted too.
      processEnvironment: {},
    });

    expect(secrets.some((secret) => sanitized.includes(secret))).toBe(false);
    expect(sanitized).toContain("/tmp/build-artifact-abc123");
    expect(sanitized).toContain("hash=0123456789abcdef");
    expect(sanitized).toContain("<redacted>");
  });

  it("fails closed for spawn failures without retaining the raw cause or a fake pid", async () => {
    const causeSecret = "synthetic-spawn-cause-secret";
    const spawnCause = Object.assign(
      new Error(`spawn failed Authorization: Bearer ${causeSecret} https://user:pass@example.test`),
      { code: "ENOENT", errno: -2, syscall: "spawn" },
    );
    const failure = await expectBuildCommandFailure({
      args: ["--token", "synthetic-command-secret"],
      spawnFailure: spawnCause,
    });

    expect(failure.failureReceipt).toMatchObject({
      pid: null,
      exitCode: null,
      signal: null,
      cause: "spawn-failed",
      diagnostics: { category: "spawn", code: "ENOENT", errno: -2, syscall: "spawn" },
    });
    expect(JSON.stringify(failure).includes(causeSecret)).toBe(false);
    expect(JSON.stringify(failure).includes("synthetic-command-secret")).toBe(false);
  });

  it("keeps only typed process diagnostics when the child failure has safe fields", async () => {
    const causeSecret = "synthetic-process-cause-secret";
    const processCause = Object.assign(new Error(`read failed with secret ${causeSecret}`), {
      code: "EPIPE",
      errno: -32,
      syscall: "read",
    });
    const failure = await expectBuildCommandFailure({ processFailure: processCause });

    expect(failure.failureReceipt).toMatchObject({
      exitCode: null,
      signal: null,
      cause: "process-failed",
      diagnostics: { category: "process", code: "EPIPE", errno: -32, syscall: "read" },
    });
    expect(JSON.stringify(failure).includes(causeSecret)).toBe(false);
  });

  it("keeps policy snapshots suppressed and accounting numeric after capture release", async () => {
    const lifecycle: CaptureLifecycleEvent[] = [];
    await expectBuildCommandFailure({
      exitCode: 31,
      stdout: "snapshot stdout",
      stderr: "snapshot stderr",
      env: { MOSS_SNAPSHOT_TOKEN: "synthetic-snapshot-token" },
      lifecycle,
    });

    expect(lifecycle.length).toBe(4);
    for (const event of lifecycle) {
      expect(event.snapshotMode).toBe("suppressed");
      expect(event.snapshotAcceptedSensitiveValueCount).toBe(0);
      expect(event.snapshotAcceptedSensitiveValueUtf8Bytes).toBe(0);
      expect(event.accountingMode).toBe("normal");
      expect(event.accountingAcceptedSensitiveValueCount).toBeGreaterThan(0);
      expect(event.accountingAcceptedSensitiveValueUtf8Bytes).toBeGreaterThan(0);
      expect(
        event.accountingAcceptedSensitiveValueCount === 0
          ? event.accountingAcceptedSensitiveValueUtf8Bytes
          : 0,
      ).toBe(0);
    }

    const emptyAccounting = inspectBuildCommandFailureSanitization("ordinary output", {
      processEnvironment: {},
    }).accounting;
    expect(emptyAccounting.mode).toBe("normal");
    expect(emptyAccounting.acceptedSensitiveValueCount).toBe(0);
    expect(emptyAccounting.acceptedSensitiveValueUtf8Bytes).toBe(0);
  });

  it("keeps allowlisted diagnostics independent of sanitizer disposal", async () => {
    const cases = [
      {
        category: "spawn" as const,
        code: "ENOENT",
        errno: -2,
        syscall: "spawn",
        failure: "spawnFailure" as const,
      },
      {
        category: "process" as const,
        code: "EPIPE",
        errno: -32,
        syscall: "read",
        failure: "processFailure" as const,
      },
    ];

    for (const testCase of cases) {
      const secret = `synthetic-diagnostic-${testCase.category}-secret`;
      const cause = Object.assign(new Error(`raw diagnostic ${secret}`), {
        code: testCase.code,
        errno: testCase.errno,
        syscall: testCase.syscall,
      });
      const direct = normalizeBuildCommandFailureDiagnostics({
        category: testCase.category,
        cause,
      });
      expect(direct).toEqual({
        category: testCase.category,
        code: testCase.code,
        errno: testCase.errno,
        syscall: testCase.syscall,
      });

      const normalFailure = await expectBuildCommandFailure({
        [testCase.failure]: cause,
      });
      const suppressedFailure = await expectBuildCommandFailure({
        env: { CSC_LINK: "s".repeat(BUILD_COMMAND_FAILURE_MAX_SENSITIVE_VALUE_UTF8_BYTES + 1) },
        [testCase.failure]: cause,
      });
      for (const failure of [normalFailure, suppressedFailure]) {
        expect(failure.failureReceipt.diagnostics).toEqual(direct);
        expect(JSON.stringify(failure).includes(secret)).toBe(false);
      }
    }
  });

  it("fails closed for forged diagnostic categories at the runtime boundary", () => {
    const sentinel = "synthetic-forged-diagnostic-category-secret";
    const cause = { code: "EPIPE", errno: -32, syscall: "read" };

    for (const category of ["spawn", "process"] as const) {
      expect(normalizeBuildCommandFailureDiagnostics({ category, cause }).category).toBe(category);
    }

    const forgedCategory = `process-${sentinel}-${"x".repeat(2_048)}`;
    const normalized = normalizeBuildCommandFailureDiagnostics({
      category: forgedCategory as never,
      cause,
    });

    expect(normalized.category).toBe("unknown");
    expect(JSON.stringify(normalized).includes(sentinel)).toBe(false);
  });

  it("sanitizes command, cause, and multi-chunk output before finalizing the receipt", async () => {
    const secrets = [
      "synthetic-env-secret",
      "synthetic-command-secret",
      "synthetic-output-secret",
      "synthetic-query-secret",
    ];
    vi.stubEnv("MOSS_TEST_TOKEN", secrets[0]);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutText = `stdout Authorization: Bearer ${secrets[2]!} ${"😀".repeat(9_000)}-尾`;
    const stderrText = `stderr token=${secrets[2]!} ${"🧪".repeat(9_000)}-尾`;
    let failure: BuildCommandFailure;
    try {
      failure = await expectBuildCommandFailure({
        args: ["--token", secrets[1]!, `https://user:pass@example.test/build?token=${secrets[3]!}`],
        exitCode: 9,
        stdoutChunks: splitEncodedText(stdoutText),
        stderrChunks: splitEncodedText(stderrText),
      });
    } finally {
      stderrWrite.mockRestore();
    }
    const serialized = JSON.stringify(failure!);

    expect(secrets.some((secret) => serialized.includes(secret))).toBe(false);
    expect(failure!.failureReceipt.cause).toBe("exit-code:9");
    expect(Buffer.byteLength(failure!.failureReceipt.stdout)).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    );
    expect(Buffer.byteLength(failure!.failureReceipt.stderr)).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    );
    expect(failure!.failureReceipt.stdout).toContain("尾");
    expect(failure!.failureReceipt.stderr).toContain("尾");
    expect(failure!.failureReceipt.stdout).not.toContain("\uFFFD");
    expect(failure!.failureReceipt.stderr).not.toContain("\uFFFD");
  });

  it("finishes and releases stdout before starting stderr finalization", async () => {
    const lifecycle: CaptureLifecycleEvent[] = [];
    await expectBuildCommandFailure({
      exitCode: 29,
      stdout: "stdout-lifecycle-marker",
      stderr: "stderr-lifecycle-marker",
      env: {
        MOSS_LIFECYCLE_TOKEN: "synthetic-lifecycle-token",
        MOSS_LIFECYCLE_SECRET: "synthetic-lifecycle-secret",
      },
      lifecycle,
    });

    expect(lifecycle.map(({ stream, phase }) => `${stream}:${phase}`)).toEqual([
      "stdout:before-finish",
      "stdout:after-dispose",
      "stderr:before-finish",
      "stderr:after-dispose",
    ]);
    expect(lifecycle[0]?.retainedBytes).toBeGreaterThan(0);
    expect(lifecycle[1]?.retainedBytes).toBe(0);
    expect(lifecycle[2]?.retainedBytes).toBeGreaterThan(0);
    expect(lifecycle[3]?.retainedBytes).toBe(0);
    expect(lifecycle[0]?.localSensitiveValueCount).toBeGreaterThan(0);
    expect(lifecycle[1]?.localSensitiveValueCount).toBe(0);
    expect(lifecycle[2]?.localSensitiveValueCount).toBeGreaterThan(0);
    expect(lifecycle[3]?.localSensitiveValueCount).toBe(0);
    expect(lifecycle.map(({ hasSuppressionCallback }) => hasSuppressionCallback)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(lifecycle.map(({ listenerCount }) => listenerCount)).toEqual([2, 1, 1, 0]);
    expect(lifecycle.map(({ repeatFinalResultEqual }) => repeatFinalResultEqual)).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it("sanitizes quoted credentials in a real single 8MiB child chunk", async () => {
    const secret = "synthetic-single-chunk-secret";
    const encoder = new TextEncoder();
    const stdoutChunk = new Uint8Array(8 * 1024 * 1024);
    stdoutChunk.fill(0x78);
    const stdoutMarker = encoder.encode(
      ` Authorization: "Bearer ${secret}" https://user%40name:"${secret}"@middle@final.example.test/path`,
    );
    stdoutChunk.set(stdoutMarker, stdoutChunk.byteLength - stdoutMarker.byteLength);
    const stderrChunks = [
      encoder.encode(
        `stderr authorization = 'Basic ${secret}' https://final.example.test/path?token=${secret}`,
      ),
    ];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let failure: BuildCommandFailure;
    try {
      failure = await expectBuildCommandFailure({
        exitCode: 13,
        stdoutChunks: [stdoutChunk],
        stderrChunks,
      });
    } finally {
      stderrWrite.mockRestore();
    }

    const serialized = JSON.stringify(failure!);
    expect(serialized.includes(secret)).toBe(false);
    expect(failure!.failureReceipt.stdout).toContain("https://<redacted>@final.example.test/path");
    expect(failure!.failureReceipt.stderr).toContain("authorization = <redacted>");
    expect(failure!.failureReceipt.stderr).toContain("?token=<redacted>");
    expect(failure!.failureReceipt.stdout).not.toContain("middle@");
    expect(failure!.failureReceipt.stdout).not.toContain("\uFFFD");
    expect(failure!.failureReceipt.stderr).not.toContain("\uFFFD");
    expect(Buffer.byteLength(failure!.failureReceipt.stdout)).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    );
  });

  it("redacts sensitive values supplied only through the child environment", async () => {
    const childEnvironmentSecret = "synthetic-child-environment-secret";
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let failure: BuildCommandFailure;
    try {
      failure = await expectBuildCommandFailure({
        env: { MOSS_TEST_TOKEN: childEnvironmentSecret },
        exitCode: 11,
        stdout: `plain child output ${childEnvironmentSecret}`,
        stderr: `plain child error ${childEnvironmentSecret}`,
      });
    } finally {
      stderrWrite.mockRestore();
    }

    expect(JSON.stringify(failure!).includes(childEnvironmentSecret)).toBe(false);
    expect(failure!.failureReceipt.stdout.includes(childEnvironmentSecret)).toBe(false);
    expect(failure!.failureReceipt.stderr.includes(childEnvironmentSecret)).toBe(false);
  });

  it("keeps the final sanitized tail within the byte cap across Unicode chunks", () => {
    const tail = sanitizeBuildCommandFailureTail(["prefix-", "😀".repeat(9_000), "-tail-尾"], {
      sensitiveValues: ["synthetic-tail-secret"],
    });
    const splitSurrogateTail = sanitizeBuildCommandFailureTail(
      ["prefix-", "\ud83d", "\ude00", "-tail"],
      {
        sensitiveValues: [],
      },
    );

    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    );
    expect(tail).toContain("-tail-尾");
    expect(splitSurrogateTail).toContain("😀");
    expect(splitSurrogateTail).not.toContain("\uFFFD");
  });

  it("bounds retained state for an 8MiB single Uint8Array chunk", () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    chunk.fill(0x78);
    const marker = new TextEncoder().encode("-single-chunk-tail-尾");
    chunk.set(marker, chunk.byteLength - marker.byteLength);

    const inspection = inspectBuildCommandFailureTail([chunk], { sensitiveValues: [] });

    expect(inspection.tail).toContain("-single-chunk-tail-尾");
    expect(Buffer.byteLength(inspection.tail)).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    );
    expect(inspection.retainedBytes).toBe(0);
    expect(inspection.retainedBytes).toBeLessThanOrEqual(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES);
    expect(inspection.scratchBytes).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES,
    );
    expect(inspection.temporaryBudgetBytes).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES,
    );
    expect(BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES).toBeGreaterThanOrEqual(
      BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES * 4 +
        BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES * 4 +
        BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES * 2,
    );
  });

  it("accounts for an 8MiB-plus-17-byte wrapped raw ring and preserves the final bytes", () => {
    const chunk = new Uint8Array(8 * 1024 * 1024 + 17);
    chunk.fill(0x61);
    const marker = new TextEncoder().encode("last-17-bytes-尾");
    chunk.set(marker, chunk.byteLength - marker.byteLength);

    const inspection = inspectBuildCommandFailureTail([chunk], {
      sensitiveValues: [],
      processEnvironment: {},
    });

    expect(inspection.tail).toContain("last-17-bytes-尾");
    expect(inspection.accounting.rawRingLengthBytes).toBe(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES);
    expect(inspection.accounting.rawRingStartBytes).toBe(17);
    expect(inspection.accounting.rawRingWrapped).toBe(true);
    expect(inspection.accounting.rawRingCapBytes).toBe(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES);
    expect(inspection.accounting.fixedScratchCapBytes).toBe(
      BUILD_COMMAND_FAILURE_FIXED_SCRATCH_CAP_BYTES,
    );
  });

  it("handles empty, under-cap, exact-cap, and cap-plus-one raw rings", () => {
    const makeChunk = (length: number): Uint8Array => {
      const chunk = new Uint8Array(length);
      chunk.fill(0x62);
      return chunk;
    };
    const empty = inspectBuildCommandFailureTail([], { sensitiveValues: [] });
    const under = inspectBuildCommandFailureTail(
      [makeChunk(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES - 1)],
      { sensitiveValues: [] },
    );
    const exact = inspectBuildCommandFailureTail(
      [makeChunk(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES)],
      { sensitiveValues: [] },
    );
    const over = inspectBuildCommandFailureTail(
      [makeChunk(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES + 1)],
      { sensitiveValues: [] },
    );

    expect(empty.tail).toBe("");
    expect(empty.accounting.rawRingLengthBytes).toBe(0);
    expect(empty.accounting.rawRingStartBytes).toBe(0);
    expect(under.accounting.rawRingLengthBytes).toBe(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES - 1);
    expect(under.accounting.rawRingStartBytes).toBe(0);
    expect(exact.accounting.rawRingLengthBytes).toBe(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES);
    expect(exact.accounting.rawRingStartBytes).toBe(0);
    expect(over.accounting.rawRingLengthBytes).toBe(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES);
    expect(over.accounting.rawRingStartBytes).toBe(1);
    expect(over.accounting.rawRingWrapped).toBe(true);
  });

  it("keeps wrapped multi-chunk surrogate output and every sanitizer stage bounded", () => {
    const first = new Uint8Array(BUILD_COMMAND_FAILURE_RAW_RING_CAP_BYTES - 3);
    first.fill(0x63);
    const second = new TextEncoder().encode("😀-wrapped-surrogate-tail-尾");
    const inspection = inspectBuildCommandFailureTail([first, second], {
      sensitiveValues: [],
    });
    const shortestCredentialInput = "token=s ".repeat(
      Math.ceil(BUILD_COMMAND_FAILURE_SANITIZER_INPUT_CAP_BYTES / 8),
    );
    const sanitized = inspectBuildCommandFailureSanitization(shortestCredentialInput, {
      sensitiveValues: ["s"],
    });

    expect(inspection.tail).toContain("-wrapped-surrogate-tail-尾");
    expect(inspection.tail).not.toContain("\uFFFD");
    expect(inspection.accounting.rawRingWrapped).toBe(true);
    expect(inspection.accounting.receiptStreamCapBytes).toBe(
      BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    );
    expect(Buffer.byteLength(sanitized.sanitized)).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES,
    );
    expect(Buffer.byteLength(sanitized.receiptTail)).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
    );
    expect(sanitized.stages.length).toBeGreaterThan(1);
    for (const stage of sanitized.stages) {
      expect(stage.inputBytes).toBeLessThanOrEqual(BUILD_COMMAND_FAILURE_SANITIZER_INPUT_CAP_BYTES);
      expect(stage.outputBytes).toBeLessThanOrEqual(
        BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES,
      );
      expect(stage.outputCapBytes).toBe(BUILD_COMMAND_FAILURE_SANITIZER_OUTPUT_CAP_BYTES);
    }
    expect(sanitized.accounting.sanitizerStageCount).toBe(sanitized.stages.length);
    expect(sanitized.accounting.sanitizerStageCount).toBeLessThanOrEqual(
      sanitized.accounting.sanitizerStageMaxCount,
    );
    expect(sanitized.accounting.transientUpperBoundBytes).toBeLessThanOrEqual(
      BUILD_COMMAND_FAILURE_CAPTURE_TRANSIENT_BUDGET_BYTES,
    );
    expect(sanitized.accounting.transientUpperBoundBytes).toBeLessThanOrEqual(1 * 1024 * 1024);
    expect(sanitized.accounting.transientUpperBoundBytes).toBe(
      2 * (64 * 1024) +
        64 * 1024 +
        2 * 64 * 1024 +
        2 * 2 * 64 * 1024 +
        2 * 64 * 1024 +
        2 * 2 * 16 * 1024 +
        2 * 64 * 1024 +
        2 * 2 * 8 * 1024 +
        4 * 4 * 1024 +
        4 * (64 + 32 * 8) +
        48 * 1024,
    );
  });

  it("keeps only bounded output tails while verbose mode forwards both streams", async () => {
    const stdoutTail = "stdout-tail-marker";
    const stderrTail = "stderr-tail-marker";
    const stdout = `stdout-head-marker-${"x".repeat(BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES)}-${stdoutTail}`;
    const stderr = `stderr-head-marker-${"y".repeat(BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES)}-${stderrTail}`;
    let forwardedStdout = "";
    let forwardedStderr = "";
    const decodeOutputChunk = (chunk: string | Uint8Array): string =>
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      forwardedStdout += decodeOutputChunk(chunk as string | Uint8Array);
      return true;
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      forwardedStderr += decodeOutputChunk(chunk as string | Uint8Array);
      return true;
    });

    try {
      const failure = await expectBuildCommandFailure({
        exitCode: 7,
        stdout,
        stderr,
        verbose: true,
      });

      expect(Buffer.byteLength(failure.failureReceipt.stdout)).toBeLessThanOrEqual(
        BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
      );
      expect(Buffer.byteLength(failure.failureReceipt.stderr)).toBeLessThanOrEqual(
        BUILD_COMMAND_FAILURE_RECEIPT_STREAM_CAP_BYTES,
      );
      expect(failure.failureReceipt.stdout).toContain(stdoutTail);
      expect(failure.failureReceipt.stderr).toContain(stderrTail);
      expect(failure.failureReceipt.stdout).not.toContain("stdout-head-marker");
      expect(failure.failureReceipt.stderr).not.toContain("stderr-head-marker");
      expect(forwardedStdout).toContain(stdoutTail);
      expect(forwardedStderr).toContain(stderrTail);
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});
