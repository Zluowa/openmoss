import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildWindowsBatchCommandArgs, resolveWindowsComSpec } from "@synara/shared/windowsProcess";
import { Cause, Deferred, Effect, Fiber, Option, ServiceMap } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createWindowsProcessSnapshotObserver } from "../platform/windowsProcessSnapshot.ts";

/** Windows counterpart for test-owned POSIX CLI wrappers; never a provider executable. */
export function writeNativeNodeCliFixture(input: {
  readonly directory: string;
  readonly name: string;
  readonly modulePath: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly expectedFirstArg?: string;
  readonly diagnostics?: boolean;
}): string {
  if (process.platform !== "win32") throw new Error("Native Windows fixture required");
  if (!/^[a-zA-Z0-9_-]{1,60}$/u.test(input.name)) throw new Error("Fixture basename required");
  if (!path.isAbsolute(input.directory)) throw new Error("Absolute owned fixture parent required");
  const parent = lstatSync(input.directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("Real owned fixture parent required");
  }
  if (!path.isAbsolute(input.modulePath) || !path.isAbsolute(process.execPath)) {
    throw new Error("Absolute fixture module and Node executable required");
  }
  const moduleEntry = lstatSync(input.modulePath);
  if (!moduleEntry.isFile() || moduleEntry.isSymbolicLink()) {
    throw new Error("Plain fixture module required");
  }
  const environment: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input.environment ?? {})) {
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw new Error("Literal fixture environment required");
    }
    environment[key] = value;
  }
  if (input.expectedFirstArg !== undefined && input.expectedFirstArg.includes("\0")) {
    throw new Error("Literal fixture argument required");
  }
  const literal = {
    environment,
    moduleUrl: pathToFileURL(input.modulePath).href,
    expectedFirstArg: input.expectedFirstArg,
  };
  const encodedData = Buffer.from(JSON.stringify(literal), "utf8").toString("base64");
  const diagnosticPrelude = input.diagnostics
    ? [
        "const bootstrapEnteredAt = Date.now();",
        `const diagnostic = (phase, details = {}) => { try { require('node:fs').appendFileSync(${JSON.stringify(path.join(input.directory, "bootstrap.jsonl"))}, JSON.stringify({ at: Date.now(), phase, ...details }) + '\\n'); } catch {} };`,
        "diagnostic('bootstrap-entered', { enteredAt: bootstrapEnteredAt });",
      ]
    : [];
  const bootstrap = [
    ...diagnosticPrelude,
    `const fixture = JSON.parse(Buffer.from('${encodedData}', 'base64').toString('utf8'));`,
    ...(input.diagnostics
      ? [
          "diagnostic('bootstrap-decoded', { nodeVersion: process.versions.node, bunVersion: process.versions.bun ?? null, argc: process.argv.length - 1, expectedFirstArgMatched: fixture.expectedFirstArg === undefined || process.argv[1] === fixture.expectedFirstArg });",
        ]
      : []),
    "for (const [key, value] of Object.entries(fixture.environment)) process.env[key] = value;",
    "if (fixture.expectedFirstArg !== undefined && process.argv[1] !== fixture.expectedFirstArg) {",
    "  process.stderr.write('Unexpected initial ACP fixture argument.\\n');",
    "  process.exit(11);",
    "}",
    ...(input.diagnostics ? ["diagnostic('module-import-started');"] : []),
    input.diagnostics
      ? "void import(fixture.moduleUrl).catch((cause) => { diagnostic('module-import-failed', { errorName: ['Error', 'SyntaxError', 'TypeError', 'RangeError'].includes(cause?.name) ? cause.name : 'other', errorCode: ['ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING', 'ERR_INVALID_MODULE_SPECIFIER', 'ERR_UNKNOWN_MODULE_FORMAT', 'ENOENT', 'EACCES', 'EPERM'].includes(cause?.code) ? cause.code : 'other' }); console.error(cause); process.exitCode = 1; });"
      : "void import(fixture.moduleUrl).catch((cause) => { console.error(cause); process.exitCode = 1; });",
  ].join("\n");
  const encodedBootstrap = Buffer.from(bootstrap, "utf8").toString("base64");
  const executable = `"${process.execPath.replaceAll("%", "%%")}"`;
  const diagnosticPath = (name: string) => {
    const target = path.join(input.directory, name);
    if (/[\r\n"&|<>^%!]/u.test(target)) throw new Error("Plain owned diagnostic path required");
    return `"${target}"`;
  };
  const wrapper = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    ...(input.diagnostics ? [`> ${diagnosticPath("wrapper-entered")} echo entered`] : []),
    `${executable} -e "eval(Buffer.from('${encodedBootstrap}', 'base64').toString('utf8'))" -- %*${input.diagnostics ? ` 2> ${diagnosticPath("node-stderr.txt")}` : ""}`,
    ...(input.diagnostics
      ? [
          'set "MOSS_TEST_OWNED_NATIVE_EXIT=%errorlevel%"',
          `> ${diagnosticPath("wrapper-exit-code.txt")} echo %MOSS_TEST_OWNED_NATIVE_EXIT%`,
          "exit /b %MOSS_TEST_OWNED_NATIVE_EXIT%",
        ]
      : ["exit /b %errorlevel%"]),
    "",
  ].join("\r\n");
  // This new subdirectory is created by this call beneath the caller's fresh
  // test root. The caller removes it on success and may preserve failure evidence.
  const directory = mkdtempSync(path.join(realpathSync(input.directory), "moss-native-cli-"));
  const binaryPath = path.join(directory, `${input.name}.cmd`);
  writeFileSync(binaryPath, wrapper, { encoding: "utf8", flag: "wx" });
  return binaryPath;
}

export type NativeNodeCliObservation = {
  readonly binaryPath: string;
  readonly observeAndStart: (signal?: AbortSignal) => Promise<void>;
  readonly assertExited: () => void;
  readonly failureEvidence?: () => {
    readonly root: string;
    readonly manifest: string;
    readonly manifestSha256: string;
    readonly stderrCategories: readonly string[];
  };
};

interface NativeFixtureSpawnBoundary {
  readonly matches: (command: ChildProcess.Command) => boolean;
  readonly spawned: Effect.Effect<void>;
  readonly confirmSpawn: (pid: number) => Effect.Effect<void>;
  readonly recordChildExit: (exitCode: number | null) => void;
  readonly recordServiceExit: (outcome: {
    readonly success: boolean;
    readonly interruptedOnly: boolean;
    readonly reasonKinds: readonly string[];
  }) => void;
}

const NativeFixtureSpawn =
  ServiceMap.Service<NativeFixtureSpawnBoundary>("test/NativeFixtureSpawn");
const nativeFixtureSpawnBoundaries = new WeakMap<
  NativeNodeCliObservation,
  NativeFixtureSpawnBoundary
>();

/** Install while constructing a test service layer; every launch stays real. */
export function observeNativeNodeCliSpawns(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return {
    ...spawner,
    spawn: (command) =>
      Effect.gen(function* () {
        const boundary = yield* Effect.serviceOption(NativeFixtureSpawn);
        const child = yield* spawner.spawn(command);
        if (Option.isSome(boundary) && boundary.value.matches(command)) {
          yield* boundary.value.confirmSpawn(child.pid);
          yield* child.exitCode.pipe(
            Effect.match({
              onSuccess: (code) => boundary.value.recordChildExit(code),
              onFailure: () => boundary.value.recordChildExit(null),
            }),
            Effect.forkScoped,
          );
        }
        return child;
      }),
  };
}

/** Hold this owned test module until its real Windows creation identity is recorded. */
export function writeObservedNativeNodeCliFixture(
  input: Parameters<typeof writeNativeNodeCliFixture>[0],
  options: { readonly spawnArguments?: readonly string[] } = {},
): NativeNodeCliObservation {
  if (process.platform !== "win32" || !path.isAbsolute(input.directory)) {
    throw new Error("Native owned Windows observation required");
  }
  const parent = lstatSync(input.directory);
  const target = lstatSync(input.modulePath);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !target.isFile() ||
    target.isSymbolicLink()
  ) {
    throw new Error("Plain native fixture parent and module required");
  }
  const directory = mkdtempSync(path.join(realpathSync(input.directory), "moss-observed-cli-"));
  const recordPath = path.join(directory, "process.json");
  const releasePath = path.join(directory, "start");
  const modulePath = path.join(directory, "observed.mjs");
  const moduleUrl = pathToFileURL(input.modulePath).href;
  let diagnosticWriteFailed = false;
  const diagnosticEvent = (phase: string, details: Record<string, unknown> = {}) => {
    if (input.diagnostics) {
      try {
        appendFileSync(
          path.join(directory, "owner.jsonl"),
          JSON.stringify({ at: Date.now(), phase, ...details }) + "\n",
        );
      } catch {
        diagnosticWriteFailed = true;
      }
    }
  };
  writeFileSync(
    modulePath,
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      ...(input.diagnostics
        ? [
            `try { writeFileSync(${JSON.stringify(path.join(directory, "module-entered"))}, 'entered', { flag: 'wx' }); } catch {}`,
          ]
        : []),
      `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), moduleUrl: ${JSON.stringify(moduleUrl)} }), { flag: "wx" });`,
      "const deadline = Date.now() + 5000;",
      `while (!existsSync(${JSON.stringify(releasePath)})) {`,
      "  if (Date.now() >= deadline) throw new Error('Owned fixture observation gate expired');",
      "  await new Promise((resolve) => setTimeout(resolve, 10));",
      "}",
      `await import(${JSON.stringify(moduleUrl)});`,
    ].join("\n"),
    { encoding: "utf8", flag: "wx" },
  );
  const binaryPath = writeNativeNodeCliFixture({ ...input, directory, modulePath });
  let identity: { readonly pid: number; readonly startedAt: string } | undefined;
  let observing = false;
  let spawnedAt: number | undefined;
  const spawnArguments =
    options.spawnArguments?.slice() ??
    (input.expectedFirstArg === undefined ? [] : [input.expectedFirstArg]);
  const spawned = Deferred.makeUnsafe<void>();
  const observation: NativeNodeCliObservation = {
    binaryPath,
    observeAndStart: async (signal) => {
      if (observing) throw new Error("One observation per owned invocation required");
      observing = true;
      const deadline = (spawnedAt ?? Date.now()) + 5000;
      diagnosticEvent("observation-started", { deadline });
      try {
        signal?.throwIfAborted();
        while (!existsSync(recordPath)) {
          signal?.throwIfAborted();
          if (Date.now() >= deadline) {
            diagnosticEvent("record-deadline-expired");
            throw new Error("Owned fixture PID record was not written");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
          pid: number;
          moduleUrl: string;
        };
        if (
          !Number.isSafeInteger(record.pid) ||
          record.pid <= 1 ||
          record.pid === process.pid ||
          record.moduleUrl !== moduleUrl
        ) {
          throw new Error("Owned fixture PID provenance mismatch");
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error("Owned fixture observation deadline expired");
        diagnosticEvent("native-snapshot-started", { pid: record.pid, remainingMs });
        const observer = createWindowsProcessSnapshotObserver({ probeTimeoutMs: remainingMs });
        const abort = () => observer.dispose();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          signal?.throwIfAborted();
          const snapshot = await observer.capture([record.pid]);
          signal?.throwIfAborted();
          if (!snapshot)
            throw new Error(
              "Native creation identity could not be observed: " +
                JSON.stringify(observer.lastFailure?.()),
            );
          const observed = Array.from(snapshot.values())
            .flat()
            .find((entry) => entry.pid === record.pid);
          if (observed?.identityKind !== "windows-start-time" || !observed.startedAt) {
            throw new Error("Native creation identity is missing");
          }
          identity = { pid: record.pid, startedAt: observed.startedAt };
          diagnosticEvent("native-identity-confirmed", { pid: identity.pid });
        } finally {
          signal?.removeEventListener("abort", abort);
          observer.dispose();
        }
      } finally {
        // This releases only this newly created fixture's module. A failure still
        // fails the test, and the caller interrupts/awaits its real service fiber.
        writeFileSync(releasePath, "start", { flag: "wx" });
      }
    },
    assertExited: () => {
      if (!identity) throw new Error("An actual native creation identity is required");
      try {
        process.kill(identity.pid, 0);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") return;
        throw cause;
      }
      throw new Error(
        `Owned native fixture ${identity.pid} (${identity.startedAt}) still exists after service return`,
      );
    },
    ...(input.diagnostics
      ? {
          failureEvidence: () => {
            const stderr = path.join(directory, "node-stderr.txt");
            const stderrText = existsSync(stderr) ? readFileSync(stderr, "utf8") : "";
            const stderrChecks: ReadonlyArray<readonly [string, RegExp]> = [
              ["node_syntax_error", /SyntaxError/u],
              ["node_dynamic_import_callback", /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/u],
              ["node_module_not_found", /ERR_MODULE_NOT_FOUND|Cannot find module/u],
              ["node_module_extension", /ERR_UNKNOWN_FILE_EXTENSION/u],
              ["file_not_found", /ENOENT|cannot find the (?:file|path)/iu],
              ["file_permission", /EACCES|EPERM/u],
              ["unexpected_initial_argument", /Unexpected initial ACP fixture argument/u],
              ["command_not_found", /not recognized as an internal or external command/iu],
            ];
            const stderrCategories = stderrChecks.flatMap(([category, pattern]) =>
              pattern.test(stderrText) ? [category] : [],
            );
            if (stderrText && stderrCategories.length === 0) {
              stderrCategories.push("unclassified_nonempty");
            }
            const files = [
              binaryPath,
              modulePath,
              input.modulePath,
              recordPath,
              releasePath,
              ...[
                "owner.jsonl",
                "bootstrap.jsonl",
                "wrapper-entered",
                "wrapper-exit-code.txt",
                "module-entered",
                "node-stderr.txt",
              ].map((name) => path.join(directory, name)),
            ].map((target) => {
              if (!existsSync(target)) return { path: target, exists: false };
              const entry = lstatSync(target);
              if (!entry.isFile() || entry.isSymbolicLink()) {
                throw new Error("Plain owned diagnostic evidence required");
              }
              const raw = readFileSync(target);
              return {
                path: target,
                exists: true,
                bytes: raw.length,
                sha256: createHash("sha256").update(raw).digest("hex"),
                modifiedAt: entry.mtime.toISOString(),
              };
            });
            const manifest = path.join(directory, "failure-evidence.json");
            writeFileSync(
              manifest,
              JSON.stringify(
                {
                  files,
                  stderrCategories,
                  diagnosticWriteFailed,
                  launcher: {
                    executable: process.execPath,
                    nodeVersion: process.versions.node,
                    bunVersion: process.versions.bun ?? null,
                    nodeOptionsPresent: process.env.NODE_OPTIONS !== undefined,
                    nodeOptionsHasPreload:
                      /(?:^|\s)(?:--require|--import|--loader|-r)(?:\s|=)/u.test(
                        process.env.NODE_OPTIONS ?? "",
                      ),
                  },
                },
                null,
                2,
              ) + "\n",
              { flag: "wx" },
            );
            return {
              root: input.directory,
              manifest,
              stderrCategories,
              manifestSha256: createHash("sha256").update(readFileSync(manifest)).digest("hex"),
            };
          },
        }
      : {}),
  };
  nativeFixtureSpawnBoundaries.set(observation, {
    matches: (command) => {
      if (!ChildProcess.isStandardCommand(command)) return false;
      const expectedArgs = buildWindowsBatchCommandArgs(binaryPath, spawnArguments);
      return (
        command.command === resolveWindowsComSpec(command.options.env) &&
        command.options.shell === false &&
        command.args.length === expectedArgs.length &&
        command.args.every((argument, index) => argument === expectedArgs[index])
      );
    },
    spawned: Deferred.await(spawned),
    confirmSpawn: (pid) =>
      Effect.sync(() => {
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
          throw new Error("An actual owned child PID is required before fixture observation");
        }
        if (spawnedAt !== undefined) throw new Error("One owned fixture spawn required");
        spawnedAt = Date.now();
        diagnosticEvent("owned-spawn-returned", { pid, spawnedAt });
        Deferred.doneUnsafe(spawned, Effect.void);
      }),
    recordChildExit: (exitCode) => diagnosticEvent("owned-child-exit", { exitCode }),
    recordServiceExit: (outcome) => diagnosticEvent("service-exit", outcome),
  });
  return observation;
}

function observeNativeFixture(fixture: NativeNodeCliObservation) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      return { controller, completed: fixture.observeAndStart(controller.signal) };
    }),
    ({ completed }) => Effect.promise(() => completed),
    ({ controller, completed }) =>
      Effect.promise(async () => {
        controller.abort();
        // Await cancellation before the caller removes this fixture's owned root.
        await completed.catch(() => undefined);
      }),
  );
}

export function runWithNativeNodeCliObservation<A, E, R>(
  fixture: NativeNodeCliObservation | undefined,
  effect: Effect.Effect<A, E, R>,
  options: { readonly observeAfterSpawn?: boolean } = {},
) {
  if (!fixture) return effect;
  const boundary = options.observeAfterSpawn
    ? nativeFixtureSpawnBoundaries.get(fixture)
    : undefined;
  if (options.observeAfterSpawn && !boundary) {
    return Effect.die(new Error("An owned native fixture spawn boundary is required"));
  }
  return Effect.acquireUseRelease(
    Effect.forkScoped(
      (boundary ? Effect.provideService(effect, NativeFixtureSpawn, boundary) : effect).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            boundary?.recordServiceExit({
              success: exit._tag === "Success",
              interruptedOnly: exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause),
              reasonKinds:
                exit._tag === "Failure" ? exit.cause.reasons.map((reason) => reason._tag) : [],
            }),
          ),
        ),
      ),
    ),
    (fiber) =>
      Effect.gen(function* () {
        yield* Effect.raceFirst(
          Effect.gen(function* () {
            if (boundary) yield* boundary.spawned;
            yield* observeNativeFixture(fixture);
          }),
          // A failed real service must retain its cause rather than wait for a
          // missing PID record. Success still requires observation and exit proof.
          Fiber.join(fiber).pipe(Effect.flatMap(() => Effect.never)),
        );
        const value = yield* Fiber.join(fiber);
        yield* Effect.sync(fixture.assertExited);
        return value;
      }),
    (fiber) => Fiber.interrupt(fiber),
  );
}
