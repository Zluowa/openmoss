/**
 * Seeds a Moss home with a realistic heavy-user history for the 3G thread-load
 * benchmark (`apps/web/scripts/thread-load-3g-benchmark.mjs`).
 *
 * Every row goes through the real orchestration engine, decider and projection
 * pipeline against the same `userdata/state.sqlite` the production server opens,
 * so the server serves exactly what it would serve a real user. Message and tool
 * text is sampled deterministically from this repository's own source and docs,
 * which keeps compression ratios close to real coding-agent transcripts.
 *
 *   bun apps/server/scripts/seed-thread-load-benchmark.ts --home=/path/to/moss-home
 *
 * Big threads grow turn by turn until their complete history (every message,
 * activity and checkpoint summary, serialized as JSON) reaches the target size,
 * matching the three thread sizes in T3 Code's published 3G benchmark
 * (5.4 / 5.2 / 3.6 MB). The server's own detail snapshot is capped well below
 * a thread's full history, so it cannot be the yardstick.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ThreadHistoryImportEntry,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive as SnapshotQueryBase } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const home = argument("home");
if (!home) throw new Error("--home=<MOSS_HOME> is required");
const fillerThreadCount = Number(argument("filler-threads") ?? 200);
const projectCount = Number(argument("projects") ?? 8);
const repoRoot = join(import.meta.dirname, "..", "..", "..");

// Same targets as T3 Code's benchmark: thread A (biggest), B, C, measured as the
// thread's complete history JSON.
const BIG_THREADS = [
  { key: "A", title: "Thread A: orchestration rewrite", targetBytes: 5_400_000 },
  { key: "B", title: "Thread B: provider runtime migration", targetBytes: 5_200_000 },
  { key: "C", title: "Thread C: sidebar performance pass", targetBytes: 3_600_000 },
] as const;

// Deterministic PRNG so every run seeds byte-identical history.
let prngState = 0x9e3779b9;
function random(): number {
  prngState ^= prngState << 13;
  prngState ^= prngState >>> 17;
  prngState ^= prngState << 5;
  return (prngState >>> 0) / 0x1_0000_0000;
}
const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(random() * values.length)]!;
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

function collectFiles(dir: string, extensions: ReadonlyArray<string>, limit: number): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).toSorted()) {
      if (found.length >= limit) return;
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (extensions.some((extension) => name.endsWith(extension)) && !name.includes(".test."))
        found.push(path);
    }
  };
  walk(dir);
  return found;
}

const codeFiles = collectFiles(join(repoRoot, "packages", "shared", "src"), [".ts"], 400);
const proseFiles = collectFiles(join(repoRoot, "docs"), [".md"], 200);
const codeCorpus = codeFiles.map((path) => ({
  path: relative(repoRoot, path),
  lines: readFileSync(path, "utf8").split("\n"),
}));
const proseLines = proseFiles
  .flatMap((path) => readFileSync(path, "utf8").split("\n"))
  .map((line) => line.trim())
  .filter((line) => line.length > 40 && !line.startsWith("|") && !line.startsWith("```"));

function proseParagraph(sentences: number): string {
  return Array.from({ length: sentences }, () => pick(proseLines)).join(" ");
}

function codeExcerpt(maxChars: number): { path: string; text: string } {
  const file = pick(codeCorpus);
  const start = between(0, Math.max(0, file.lines.length - 40));
  let text = "";
  for (let index = start; index < file.lines.length && text.length < maxChars; index += 1) {
    text += `${file.lines[index]}\n`;
  }
  return { path: file.path, text: text.slice(0, maxChars) };
}

function unifiedDiff(maxChars: number): {
  path: string;
  diff: string;
  additions: number;
  deletions: number;
} {
  const { path, text } = codeExcerpt(maxChars);
  let additions = 0;
  let deletions = 0;
  const lines = text.split("\n").map((line) => {
    const roll = random();
    if (roll < 0.18) {
      additions += 1;
      return `+${line}`;
    }
    if (roll < 0.3) {
      deletions += 1;
      return `-${line}`;
    }
    return ` ${line}`;
  });
  return {
    path,
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.join("\n")}`.slice(
      0,
      maxChars,
    ),
    additions,
    deletions,
  };
}

function assistantAnswer(): string {
  const blocks: string[] = [proseParagraph(between(2, 4))];
  for (let section = 0; section < between(1, 3); section += 1) {
    blocks.push(`### ${pick(proseLines).slice(0, 60)}`);
    blocks.push(Array.from({ length: between(2, 5) }, () => `- ${pick(proseLines)}`).join("\n"));
    if (random() < 0.6) {
      const { path, text } = codeExcerpt(between(300, 1_400));
      blocks.push(`\`${path}\`\n\n\`\`\`ts\n${text}\`\`\``);
    }
  }
  blocks.push(proseParagraph(between(1, 3)));
  return blocks.join("\n\n");
}

const COMMANDS = [
  "bun run test",
  "bun typecheck",
  "bun lint",
  "rg -n",
  "git diff --stat",
  "git status --short",
  "sed -n 1,200p",
  "ls -la",
] as const;

// History ends roughly two days ago: the server archives threads unused for a
// week, so an older history would be swept out of the sidebar mid-benchmark.
const baseTime = Date.now() - 6 * 24 * 60 * 60 * 1000;
let clock = 0;
const nextTimestamp = () => new Date(baseTime + (clock += between(2, 30)) * 1_000).toISOString();

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(idCounter += 1).toString(36)}`;

function buildTurn(threadId: string, turnIndex: number, toolCalls: number) {
  const turnId = TurnId.makeUnsafe(`${threadId}-turn-${turnIndex}`);
  const entries: ThreadHistoryImportEntry[] = [];
  const userAt = nextTimestamp();
  entries.push({
    kind: "message",
    message: {
      messageId: MessageId.makeUnsafe(nextId("user")),
      role: "user",
      text: proseParagraph(between(1, 6)),
      turnId,
      createdAt: userAt,
      updatedAt: userAt,
    },
  });
  const files: Array<{ path: string; kind: string; additions: number; deletions: number }> = [];
  for (let call = 0; call < toolCalls; call += 1) {
    const startedAt = nextTimestamp();
    const isEdit = random() < 0.35;
    const itemId = nextId("item");
    const title = isEdit ? "Edited file" : "Ran command";
    if (isEdit) {
      const change = unifiedDiff(between(600, 1_990));
      files.push({
        path: change.path,
        kind: "modified",
        additions: change.additions,
        deletions: change.deletions,
      });
      const item = {
        type: "fileChange",
        id: itemId,
        status: "completed",
        changes: [{ path: change.path, kind: "update", diff: change.diff }],
      };
      entries.push(
        activity(
          turnId,
          "tool.started",
          `${title} started`,
          {
            itemType: "file_change",
            status: "inProgress",
            title,
            detail: change.path,
            data: { item: { ...item, status: "inProgress" } },
          },
          startedAt,
        ),
        activity(
          turnId,
          "tool.completed",
          title,
          {
            itemType: "file_change",
            status: "completed",
            title,
            detail: change.path,
            data: { item },
          },
          nextTimestamp(),
        ),
      );
    } else {
      const command = `${pick(COMMANDS)} ${pick(codeCorpus).path}`;
      const output = codeExcerpt(between(200, 1_990)).text;
      const item = {
        type: "commandExecution",
        id: itemId,
        command,
        cwd: "/workspace",
        status: "completed",
        exitCode: 0,
        durationMs: between(40, 9_000),
        aggregatedOutput: output,
      };
      entries.push(
        activity(
          turnId,
          "tool.started",
          `${title} started`,
          {
            itemType: "command_execution",
            status: "inProgress",
            title,
            detail: command,
            data: {
              item: { ...item, status: "inProgress", aggregatedOutput: null, exitCode: null },
            },
          },
          startedAt,
        ),
        activity(
          turnId,
          "tool.completed",
          title,
          {
            itemType: "command_execution",
            status: "completed",
            title,
            detail: command,
            data: { item },
          },
          nextTimestamp(),
        ),
      );
    }
    if (random() < 0.15) {
      const at = nextTimestamp();
      entries.push({
        kind: "message",
        message: {
          messageId: MessageId.makeUnsafe(nextId("commentary")),
          role: "assistant",
          text: proseParagraph(between(1, 3)),
          turnId,
          createdAt: at,
          updatedAt: at,
        },
      });
    }
  }
  const answerAt = nextTimestamp();
  const assistantMessageId = MessageId.makeUnsafe(nextId("assistant"));
  entries.push({
    kind: "message",
    message: {
      messageId: assistantMessageId,
      role: "assistant",
      text: assistantAnswer(),
      turnId,
      createdAt: answerAt,
      updatedAt: answerAt,
    },
  });
  return { turnId, entries, files, assistantMessageId, completedAt: nextTimestamp() };
}

function activity(
  turnId: TurnId,
  kind: "tool.started" | "tool.completed",
  summary: string,
  payload: OrchestrationThreadActivity["payload"],
  createdAt: string,
): ThreadHistoryImportEntry {
  return {
    kind: "activity",
    activity: {
      id: EventId.makeUnsafe(nextId("activity")),
      tone: "tool",
      kind,
      summary,
      payload,
      turnId,
      createdAt,
    },
  };
}

const stateDir = join(home, "userdata");
mkdirSync(stateDir, { recursive: true });
const runtime = ManagedRuntime.make(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(SnapshotQueryBase.pipe(Layer.provide(ServerSettingsService.layerTest()))),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(join(stateDir, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(repoRoot, home)),
    Layer.provideMerge(NodeServices.layer),
  ),
);

try {
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    runtime.runPromise(engine.dispatch(command));
  const command = (type: string) => CommandId.makeUnsafe(nextId(`seed-${type}`));

  const projectIds: ProjectId[] = [];
  for (let index = 0; index < projectCount; index += 1) {
    const workspaceRoot = join(home, "workspaces", `project-${index}`);
    mkdirSync(workspaceRoot, { recursive: true });
    const projectId = ProjectId.makeUnsafe(`bench-project-${index}`);
    projectIds.push(projectId);
    await dispatch({
      type: "project.create",
      commandId: command("project"),
      projectId,
      title: `Project ${index}`,
      workspaceRoot,
      defaultModelSelection: null,
      createdAt: nextTimestamp(),
    });
  }

  const createThread = async (threadId: ThreadId, projectId: ProjectId, title: string) =>
    dispatch({
      type: "thread.create",
      commandId: command("thread"),
      threadId,
      projectId,
      title,
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: nextTimestamp(),
    });

  /** Returns the JSON bytes this turn adds to the thread's complete history. */
  const appendTurn = async (threadId: ThreadId, turnIndex: number, toolCalls: number) => {
    const turn = buildTurn(threadId, turnIndex, toolCalls);
    await dispatch({
      type: "thread.history.import",
      commandId: command("history"),
      threadId,
      entries: turn.entries,
      createdAt: turn.completedAt,
    });
    const checkpoint = {
      turnId: turn.turnId,
      completedAt: turn.completedAt,
      checkpointRef: CheckpointRef.makeUnsafe(`refs/moss/checkpoints/${threadId}/${turnIndex + 1}`),
      status: "ready" as const,
      files: turn.files,
      assistantMessageId: turn.assistantMessageId,
      checkpointTurnCount: turnIndex + 1,
    };
    await dispatch({
      type: "thread.turn.diff.complete",
      commandId: command("diff"),
      threadId,
      ...checkpoint,
      createdAt: turn.completedAt,
    });
    return (
      Buffer.byteLength(JSON.stringify(turn.entries)) +
      Buffer.byteLength(JSON.stringify(checkpoint))
    );
  };

  // Filler first so the big threads are the most recently updated (top of the sidebar).
  for (let index = 0; index < fillerThreadCount; index += 1) {
    const threadId = ThreadId.makeUnsafe(`bench-filler-${index}`);
    await createThread(
      threadId,
      projectIds[index % projectIds.length]!,
      proseParagraph(1).slice(0, 70),
    );
    const turns = between(1, 4);
    for (let turn = 0; turn < turns; turn += 1) await appendTurn(threadId, turn, between(2, 8));
  }

  const manifest: Record<string, unknown> = {
    home,
    fillerThreadCount,
    projectCount,
    bigThreads: [],
  };
  for (const big of BIG_THREADS) {
    const threadId = ThreadId.makeUnsafe(`bench-thread-${big.key.toLowerCase()}`);
    await createThread(threadId, projectIds[0]!, big.title);
    let turns = 0;
    let bytes = 0;
    while (bytes < big.targetBytes) bytes += await appendTurn(threadId, turns++, between(6, 16));
    const detail = await runtime.runPromise(snapshots.getThreadDetailSnapshotById(threadId));
    const thread = Option.getOrThrow(detail).thread;
    const history = Option.getOrThrow(detail).history;
    (manifest.bigThreads as unknown[]).push({
      key: big.key,
      threadId,
      title: big.title,
      turns,
      messages: history?.totalMessageCount ?? thread.messages.length,
      activities: history?.totalActivityCount ?? thread.activities.length,
      lastMessageId: thread.messages.at(-1)?.id,
      historyJsonBytes: bytes,
      unwindowedSnapshotJsonBytes: Buffer.byteLength(JSON.stringify(Option.getOrThrow(detail))),
    });
    console.log(`thread ${big.key}: ${turns} turns, ${(bytes / 1e6).toFixed(2)} MB history`);
  }
  // The open-thread scenarios start from a small, fully loaded thread.
  const startThreadId = ThreadId.makeUnsafe(`bench-filler-${fillerThreadCount - 1}`);
  const startThread = Option.getOrThrow(
    await runtime.runPromise(snapshots.getThreadDetailSnapshotById(startThreadId)),
  ).thread;
  manifest.startThread = {
    threadId: startThreadId,
    lastMessageId: startThread.messages.at(-1)?.id,
  };
  const shell = await runtime.runPromise(snapshots.getShellSnapshot());
  manifest.historyEndsAt = new Date(baseTime + clock * 1_000).toISOString();
  if (baseTime + clock * 1_000 > Date.now()) throw new Error("Seeded history runs into the future");
  manifest.shellJsonBytes = Buffer.byteLength(JSON.stringify(shell));
  manifest.shellThreads = shell.threads.length;
  writeFileSync(join(home, "benchmark-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await runtime.dispose();
}
