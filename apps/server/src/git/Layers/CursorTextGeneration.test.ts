import * as os from "node:os";
import * as path from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect, test } from "vitest";

import { TextGenerationError } from "../Errors.ts";
import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { CursorTextGenerationLive, resolveCursorSettings } from "./CursorTextGeneration.ts";
import {
  writeNativeNodeCliFixture,
  writeObservedNativeNodeCliFixture,
  runWithNativeNodeCliObservation,
  observeNativeNodeCliSpawns,
  type NativeNodeCliObservation,
} from "../../testing/nativeNodeCliFixtures.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const CursorTextGenerationTestLayer = CursorTextGenerationLive.pipe(
  Layer.provideMerge(
    Layer.effectServices(
      Effect.gen(function* () {
        const services = yield* Layer.build(NodeServices.layer);
        const spawner = ServiceMap.getUnsafe(services, ChildProcessSpawner.ChildProcessSpawner);
        return ServiceMap.add(
          services,
          ChildProcessSpawner.ChildProcessSpawner,
          observeNativeNodeCliSpawns(spawner),
        );
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerConfig, {
      homeDir: os.homedir(),
      stateDir: path.join(os.tmpdir(), "moss-cursor-text-state"),
    } as any),
  ),
);

test("routes an empty-config nondefault Cursor text-generation account", () => {
  expect(
    resolveCursorSettings(undefined, { homeDir: "/home/user", stateDir: "/state" }, "cursor_work"),
  ).toEqual({
    homeDir: "/home/user",
    isolationRootDir: "/state",
    instanceId: "cursor_work",
  });
});

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeAcpAgentWrapper(
  dir: string,
  env: Record<string, string>,
): string | NativeNodeCliObservation {
  const binDir = path.join(dir, "bin");
  const agentPath = path.join(binDir, "agent");
  mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const fixture = {
      directory: binDir,
      name: "agent",
      modulePath: mockAgentPath,
      environment: env,
      expectedFirstArg: "acp",
    };
    return env.MOSS_ACP_EXIT_LOG_PATH
      ? writeObservedNativeNodeCliFixture({ ...fixture, diagnostics: true })
      : writeNativeNodeCliFixture(fixture);
  }
  writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effect: (
    agentPath: string,
    nativeObservation?: NativeNodeCliObservation,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "moss-cursor-text-acp-"));
      const fixture = makeAcpAgentWrapper(tempDir, env);
      return {
        tempDir,
        agentPath: typeof fixture === "string" ? fixture : fixture.binaryPath,
        nativeObservation: typeof fixture === "string" ? undefined : fixture,
        retainFailure: false,
      };
    }),
    (resource) =>
      effect(resource.agentPath, resource.nativeObservation).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (resource.nativeObservation?.failureEvidence) {
              resource.retainFailure = true;
              reportNativeFixtureFailure(resource.tempDir, resource.nativeObservation);
            }
          }),
        ),
      ),
    ({ tempDir, retainFailure }) =>
      Effect.sync(() => {
        if (!retainFailure) rmSync(tempDir, { recursive: true, force: true });
      }),
  );
}

function reportNativeFixtureFailure(directory: string, fixture: NativeNodeCliObservation): void {
  try {
    console.info("Owned Cursor native fixture failure evidence", fixture.failureEvidence?.());
  } catch {
    console.info("Owned Cursor native fixture failure evidence", {
      root: directory,
      evidence: "collection_failed",
    });
  }
}

function waitForFileContent(filePath: string, containing?: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const content = readFileSync(filePath, "utf8");
        if (containing === undefined || content.includes(containing)) {
          return content;
        }
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file content: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGenerationLive", (it) => {
  it.effect.runIf(process.platform === "win32")(
    "preserves literal fixture argv and environment through native ACP stdin and proven child exit",
    () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "moss-cursor-native-literal-"));
      const probePath = path.join(directory, "probe.json");
      const requestLogPath = path.join(directory, "requests.jsonl");
      const exitLogPath = path.join(directory, "exit.log");
      const modulePath = path.join(directory, "probe-and-agent.mjs");
      const literal = 'Owned %PATH% !literal! & | ^ < > "quotes"\nsecond line';
      writeFileSync(
        modulePath,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({`,
          "  argv: process.argv.slice(1),",
          "  literal: process.env.MOSS_NATIVE_FIXTURE_LITERAL,",
          '  hasMossAccessToken: Object.hasOwn(process.env, "MOSS_ACCESS_TOKEN"),',
          '}), { flag: "wx" });',
          `await import(${JSON.stringify(pathToFileURL(mockAgentPath).href)});`,
        ].join("\n"),
        { encoding: "utf8", flag: "wx" },
      );
      const nativeObservation = writeObservedNativeNodeCliFixture({
        directory,
        name: "agent",
        modulePath,
        expectedFirstArg: "acp",
        diagnostics: true,
        environment: {
          MOSS_NATIVE_FIXTURE_LITERAL: literal,
          MOSS_ACP_REQUEST_LOG_PATH: requestLogPath,
          MOSS_ACP_EXIT_LOG_PATH: exitLogPath,
          MOSS_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            summary: "## Summary\n- Native fixture.",
          }),
        },
      });
      const agentPath = nativeObservation.binaryPath;
      let retainFailure = false;
      return Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* runWithNativeNodeCliObservation(
          nativeObservation,
          textGeneration.generateDiffSummary({
            cwd: process.cwd(),
            patch: "diff --git a/owned.txt b/owned.txt",
            modelSelection: { provider: "cursor", model: "composer-2" },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
                environment: { MOSS_ACCESS_TOKEN: "synthetic-token-must-not-reach-cursor" },
              },
            },
          }),
          { observeAfterSpawn: true },
        );
        expect(generated.summary).toBe("## Summary\n- Native fixture.");
        expect(JSON.parse(readFileSync(probePath, "utf8"))).toEqual({
          argv: ["acp"],
          literal,
          hasMossAccessToken: false,
        });
        const requests = (yield* waitForFileContent(requestLogPath, "session/prompt"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string });
        expect(requests.map((request) => request.method)).toEqual(
          expect.arrayContaining(["initialize", "session/new", "session/prompt"]),
        );
        // Native tree termination need not run Node exit hooks. A natural EOF
        // that did produce the hook must still retain the original clean code.
        if (existsSync(exitLogPath)) expect(readFileSync(exitLogPath, "utf8")).toContain("exit:0");
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            retainFailure = true;
            reportNativeFixtureFailure(directory, nativeObservation);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (!retainFailure) rmSync(directory, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("uses ACP model config options instead of raw CLI model ids", () => {
    const requestLogDir = mkdtempSync(path.join(os.tmpdir(), "moss-cursor-text-log-"));
    const requestLogPath = path.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        MOSS_ACP_REQUEST_LOG_PATH: requestLogPath,
        MOSS_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify cursor acp model config path",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-text-generation",
            stagedSummary: "M apps/server/src/git/Layers/CursorTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/git/Layers/CursorTextGeneration.ts b/apps/server/src/git/Layers/CursorTextGeneration.ts",
            modelSelection: {
              provider: "cursor",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "xhigh",
                fastMode: true,
                contextWindow: "1m",
              },
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify cursor acp model config path");

          const requests = readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toHaveProperty("_meta.parameterizedModelPicker");
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "gpt-5.4",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "reasoning" &&
                request.params?.value === "extra-high",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "context" &&
                request.params?.value === "1m",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "fast" &&
                request.params?.value === "true",
            ),
          ).toBe(true);

          rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("accepts json objects with extra assistant text around them", () =>
    withFakeAcpAgent(
      {
        MOSS_ACP_PROMPT_RESPONSE_TEXT:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-noisy-json",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.subject).toBe("Update README dummy comment with attribution and date");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("generates diff summaries through Cursor ACP text generation", () =>
    withFakeAcpAgent(
      {
        MOSS_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          summary: "## Summary\n- Route git summaries through Cursor.",
        }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateDiffSummary({
            cwd: process.cwd(),
            patch: "diff --git a/file.ts b/file.ts",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.summary).toBe("## Summary\n- Route git summaries through Cursor.");
        }),
    ),
  );

  it.effect("passes provider-instance environment to Cursor ACP text generation", () =>
    withFakeAcpAgent({}, (agentPath) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateDiffSummary({
          cwd: process.cwd(),
          patch: "diff --git a/file.ts b/file.ts",
          modelSelection: {
            provider: "cursor",
            instanceId: "cursor_work",
            model: "composer-2",
          },
          providerOptions: {
            cursor: {
              binaryPath: agentPath,
              environment: {
                ACP_MOCK_PROMPT_RESPONSE_TEXT: JSON.stringify({
                  summary: "## Summary\n- Used the provider instance env.",
                }),
              },
            },
          },
        });

        expect(generated.summary).toBe("## Summary\n- Used the provider instance env.");
      }),
    ),
  );

  it.effect("falls back to raw text when Cursor replies without JSON for a thread title", () =>
    withFakeAcpAgent(
      {
        MOSS_ACP_PROMPT_RESPONSE_TEXT: "Sidebar Thread Row Spacing",
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Improve sidebar thread row spacing and hover states.",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Sidebar Thread Row Spacing");
        }),
    ),
  );

  it.effect("recovers a thread title from a wrong-key JSON payload", () =>
    withFakeAcpAgent(
      {
        MOSS_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ name: "Reconnect Backoff Fix" }),
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the websocket reconnect backoff.",
            modelSelection: {
              provider: "cursor",
              model: "composer-2",
            },
            providerOptions: {
              cursor: {
                binaryPath: agentPath,
              },
            },
          });

          expect(generated.title).toBe("Reconnect Backoff Fix");
        }),
    ),
  );

  it.effect("rejects sentence-length prose instead of using it as a title", () =>
    withFakeAcpAgent(
      {
        MOSS_ACP_PROMPT_RESPONSE_TEXT:
          "I'm sorry, but I cannot generate a concise title for this particular request right now.",
      },
      (agentPath) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix the websocket reconnect backoff.",
              modelSelection: {
                provider: "cursor",
                model: "composer-2",
              },
              providerOptions: {
                cursor: {
                  binaryPath: agentPath,
                },
              },
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "Left" as const, left: error }),
                onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
              }),
            );

          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(TextGenerationError);
            expect(result.left.message).toContain(
              "Cursor Agent returned invalid structured output",
            );
          }
        }),
    ),
  );

  it.effect("closes the ACP child process after text generation completes", () => {
    const exitLogDir = mkdtempSync(path.join(os.tmpdir(), "moss-cursor-text-exit-log-"));
    const exitLogPath = path.join(exitLogDir, "exit.log");

    return withFakeAcpAgent(
      {
        MOSS_ACP_EXIT_LOG_PATH: exitLogPath,
        MOSS_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: '"Trim reconnect spinner status after resume."',
        }),
      },
      (agentPath, nativeObservation) =>
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* runWithNativeNodeCliObservation(
            nativeObservation,
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix the reconnect spinner after a resumed session.",
              modelSelection: {
                provider: "cursor",
                model: "composer-2",
              },
              providerOptions: {
                cursor: {
                  binaryPath: agentPath,
                },
              },
            }),
            { observeAfterSpawn: process.platform === "win32" },
          );

          expect(generated.title).toBe("Trim reconnect spinner status after resume");

          if (nativeObservation) {
            // Identity disappearance was asserted immediately after the actual
            // service returned; TerminateProcess does not promise an exit hook.
            if (existsSync(exitLogPath))
              expect(readFileSync(exitLogPath, "utf8")).toContain("exit:0");
          } else {
            const exitLog = yield* waitForFileContent(exitLogPath, "exit:0");
            expect(exitLog).toContain("exit:0");
          }
        }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(exitLogDir, { recursive: true, force: true }))),
    );
  });
});
