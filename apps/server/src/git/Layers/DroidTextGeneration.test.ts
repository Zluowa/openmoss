import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, ServiceMap, type Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";

import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { DroidTextGenerationLive } from "./DroidTextGeneration.ts";
import {
  writeNativeNodeCliFixture,
  writeObservedNativeNodeCliFixture,
  runWithNativeNodeCliObservation,
  observeNativeNodeCliSpawns,
  type NativeNodeCliObservation,
} from "../../testing/nativeNodeCliFixtures.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const DroidTextGenerationTestLayer = DroidTextGenerationLive.pipe(
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
);
const droidModel = { provider: "droid" as const, model: "composer-2" };

function droidOptions(agentPath: string) {
  return { droid: { binaryPath: agentPath } };
}

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
    };
    return env.MOSS_ACP_EXIT_LOG_PATH
      ? writeObservedNativeNodeCliFixture(fixture, {
          spawnArguments: ["exec", "--output-format", "acp"],
        })
      : writeNativeNodeCliFixture(fixture);
  }
  writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: (tempDir: string) => Record<string, string>,
  effect: (
    agentPath: string,
    tempDir: string,
    nativeObservation?: NativeNodeCliObservation,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "moss-droid-text-acp-"));
      const fixture = makeAcpAgentWrapper(tempDir, env(tempDir));
      return {
        tempDir,
        agentPath: typeof fixture === "string" ? fixture : fixture.binaryPath,
        nativeObservation: typeof fixture === "string" ? undefined : fixture,
      };
    }),
    ({ agentPath, tempDir, nativeObservation }) => effect(agentPath, tempDir, nativeObservation),
    ({ tempDir }) =>
      Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }),
  );
}

function waitForFileContent(filePath: string, containing: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const content = readFileSync(filePath, "utf8");
        if (content.includes(containing)) {
          return content;
        }
      } catch {
        // The child process may not have flushed the file yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file content: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

function expectConfigOption(
  requests: Array<{ method?: string; params?: Record<string, unknown> }>,
  configId: string,
  value: unknown,
): void {
  expect(
    requests.some(
      (request) =>
        request.method === "session/set_config_option" &&
        request.params?.configId === configId &&
        request.params?.value === value,
    ),
  ).toBe(true);
}

type TestCase = {
  readonly name: string;
  readonly env: (tempDir: string) => Record<string, string>;
  readonly run: (
    agentPath: string,
    tempDir: string,
    nativeObservation?: NativeNodeCliObservation,
  ) => Effect.Effect<void, TextGenerationError, TextGeneration | Scope.Scope>;
};

const cases: TestCase[] = [
  {
    name: "uses ACP model config options instead of raw CLI model ids",
    env: (tempDir) => ({
      MOSS_ACP_REQUEST_LOG_PATH: path.join(tempDir, "requests.ndjson"),
      MOSS_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
        subject: "Add generated Droid commit message",
        body: "- verify droid acp model config path",
      }),
    }),
    run: (agentPath, tempDir) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/droid-text-generation",
          stagedSummary: "M apps/server/src/git/Layers/DroidTextGeneration.ts",
          stagedPatch: "diff --git a/a b/a",
          modelSelection: {
            ...droidModel,
            options: { reasoningEffort: "high" },
          },
          providerOptions: droidOptions(agentPath),
        });

        expect(generated.subject).toBe("Add generated Droid commit message");
        expect(generated.body).toBe("- verify droid acp model config path");

        const requests = readFileSync(path.join(tempDir, "requests.ndjson"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
        expectConfigOption(requests, "model", "composer-2");
        expectConfigOption(requests, "reasoning_effort", "high");
        expectConfigOption(requests, "mode", "normal");
      }),
  },
  {
    name: "closes the ACP child process after text generation completes",
    env: (tempDir) => ({
      MOSS_ACP_EXIT_LOG_PATH: path.join(tempDir, "exit.log"),
      MOSS_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
        title: '"Trim reconnect spinner status after resume."',
      }),
    }),
    run: (agentPath, tempDir, nativeObservation) =>
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* runWithNativeNodeCliObservation(
          nativeObservation,
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: droidModel,
            providerOptions: droidOptions(agentPath),
          }),
          { observeAfterSpawn: process.platform === "win32" },
        );

        expect(generated.title).toBe("Trim reconnect spinner status after resume");
        if (nativeObservation) {
          // Native identity disappearance is required even when forced tree
          // termination bypasses Node's hook. Natural EOF retains exit:0.
          const exitLogPath = path.join(tempDir, "exit.log");
          if (existsSync(exitLogPath))
            expect(readFileSync(exitLogPath, "utf8")).toContain("exit:0");
        } else {
          const exitLog = yield* waitForFileContent(path.join(tempDir, "exit.log"), "exit:0");
          expect(exitLog).toContain("exit:0");
        }
      }),
  },
];

it.layer(DroidTextGenerationTestLayer)("DroidTextGenerationLive", (it) => {
  it.effect.each(cases)("$name", (test) => withFakeAcpAgent(test.env, test.run));
});
