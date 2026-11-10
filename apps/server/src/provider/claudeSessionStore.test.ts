// Native SDK filesystem fixtures: never login, start a model turn or use an account.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import { ThreadId } from "@moss/contracts";
import { ServerConfig } from "../config.ts";
import { ClaudeAdapter } from "./Services/ClaudeAdapter.ts";
import { makeClaudeAdapterLive } from "./Layers/ClaudeAdapter.ts";
import {
  forkClaudeSessionInEnvironment,
  readClaudeSessionMessagesInEnvironment,
} from "./claudeAgentSdk.ts";
import { makeAgentProgramOwnership } from "./agentProgramOwnership.ts";
import { findClaudeSessionTranscriptPath } from "./claudeProjectImport.ts";
import { restoreClaudeImportedCopyDates } from "./claudeImportedCopyDates.ts";

const directories: string[] = [];
const sessionId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-09-01T10:00:02.000Z";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "moss-claude-sdk-roots-"));
  directories.push(root);
  const roots = ["ambient", "selected-a", "selected-b"].map((name) => path.join(root, name));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const files: string[] = [];
  for (const [index, configDir] of roots.entries()) {
    const projectDir = path.join(configDir, "projects", "fixture-project");
    await mkdir(projectDir, { recursive: true });
    const userUuid = randomUUID();
    const assistantUuid = randomUUID();
    const entries = [
      {
        type: "user",
        uuid: userUuid,
        parentUuid: null,
        sessionId,
        cwd: workspace,
        timestamp,
        isSidechain: false,
        message: { role: "user", content: `root-${index}-user` },
      },
      {
        type: "assistant",
        uuid: assistantUuid,
        parentUuid: userUuid,
        sessionId,
        cwd: workspace,
        timestamp,
        isSidechain: false,
        message: {
          id: `msg-${index}`,
          role: "assistant",
          content: [{ type: "text", text: `root-${index}-assistant` }],
          stop_reason: "end_turn",
          model: "fixture",
        },
      },
    ];
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    files.push(file);
  }
  const originals = await Promise.all(files.map((file) => readFile(file, "utf8")));
  vi.stubEnv("CLAUDE_CONFIG_DIR", roots[0]!);
  return { root, roots, workspace, files, originals };
}

function fixtureEnvironment(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "NODE_OPTIONS",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: configDir,
    USERPROFILE: configDir,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
      throw new Error("Unexpected fixture cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Claude native SDK selected store", () => {
  it("reads and forks the selected root when ambient and another root have the same session UUID", async () => {
    const f = await fixture();
    for (const selected of [1, 2]) {
      const configDir = f.roots[selected]!;
      const environment = fixtureEnvironment(configDir);
      const messages = await readClaudeSessionMessagesInEnvironment({
        sessionId,
        dir: undefined,
        environment,
      });
      assert.lengthOf(messages, 2);
      assert.include(JSON.stringify(messages), `root-${selected}-assistant`);
      assert.notInclude(JSON.stringify(messages), "root-0-");
      const copied = await forkClaudeSessionInEnvironment({
        sessionId,
        dir: undefined,
        environment,
        upToMessageId: messages.at(-1)!.uuid,
        runtimeProgram: {
          programs: makeAgentProgramOwnership("claudeAgent"),
          binaryPath: process.execPath,
        },
      });
      await restoreClaudeImportedCopyDates({
        sourceSessionId: sessionId,
        copiedSessionId: copied.sessionId,
        sourceMessages: messages,
        configDir,
      });
      const file = await findClaudeSessionTranscriptPath({
        sessionId: copied.sessionId,
        configDir,
      });
      assert.ok(file);
      const copy = await readFile(file, "utf8");
      assert.include(copy, `root-${selected}-assistant`);
      assert.include(copy, timestamp);
      assert.equal(
        await findClaudeSessionTranscriptPath({
          sessionId: copied.sessionId,
          configDir: f.roots[0]!,
        }),
        undefined,
      );
    }
    assert.deepEqual(await Promise.all(f.files.map((file) => readFile(file, "utf8"))), f.originals);
    assert.deepEqual(await readdir(path.join(f.roots[0]!, "projects", "fixture-project")), [
      `${sessionId}.jsonl`,
    ]);
  });

  it.effect(
    "the stopped account adapter reads, forks and restores dates in its explicit root",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.promise(fixture);
        const configDir = f.roots[1]!;
        yield* Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const result = yield* adapter.forkThread!({
            sourceThreadId: ThreadId.makeUnsafe("fixture-source"),
            threadId: ThreadId.makeUnsafe("fixture-copy"),
            runtimeMode: "full-access",
            modelSelection: {
              provider: "claudeAgent",
              instanceId: "fixture-account",
              model: "fixture",
            },
            providerOptions: {
              claudeAgent: { homePath: configDir, environment: { CLAUDE_CONFIG_DIR: configDir } },
            },
            sourceResumeCursor: { resume: sessionId },
            requireCompletedSource: true,
          });
          const copiedSession = (result.resumeCursor as { resume: string }).resume;
          const copied = yield* Effect.promise(() =>
            findClaudeSessionTranscriptPath({ sessionId: copiedSession, configDir }),
          );
          assert.ok(copied);
          const text = yield* Effect.promise(() => readFile(copied, "utf8"));
          assert.include(text, "root-1-assistant");
          assert.include(text, timestamp);
          assert.deepEqual(
            yield* Effect.promise(() => Promise.all(f.files.map((file) => readFile(file, "utf8")))),
            f.originals,
          );
          assert.equal(
            yield* Effect.promise(() =>
              findClaudeSessionTranscriptPath({ sessionId: copiedSession, configDir: f.roots[0]! }),
            ),
            undefined,
          );
        }).pipe(
          Effect.provide(
            makeClaudeAdapterLive().pipe(
              Layer.provideMerge(ServerConfig.layerTest(f.workspace, path.join(f.root, "server"))),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
