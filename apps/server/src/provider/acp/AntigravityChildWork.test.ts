import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  EMPTY_ANTIGRAVITY_CHILD_ACTIVITY,
  readAntigravityChildActivity,
} from "./AntigravityChildWork.ts";

const SESSION_ID = "d40d9532-81e5-42ec-8c48-2cc45d4e44de";
const WORKER_A = "465da484-e070-4c6e-8d55-b3bfaf26242a";
const WORKER_B = "0b080580-e935-46e8-9bfc-91d9a96ceccc";
const SUBAGENT_A = "1a58845a-7d30-4dd8-8a14-8fa9802945a7";

async function withProfile(
  run: (profileDir: string, sessionRoot: string) => Promise<void>,
): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "moss-agy-child-"));
  const sessionRoot = join(profileDir, "antigravity-cli", "brain", SESSION_ID, ".system_generated");
  await mkdir(sessionRoot, { recursive: true });
  try {
    await run(profileDir, sessionRoot);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

describe("readAntigravityChildActivity", () => {
  it("detects actively working /swarm workers and ignores parked or killed ones", async () => {
    await withProfile(async (profileDir, sessionRoot) => {
      await mkdir(join(sessionRoot, "swarm"), { recursive: true });
      await mkdir(join(sessionRoot, "subagents"), { recursive: true });
      await mkdir(join(sessionRoot, "messages"), { recursive: true });

      // Swarm workers remain SUBAGENT_STATE_ALIVE in subagents/*.json even when parked;
      // members.json is authoritative for their active vs parked state.
      await writeFile(
        join(sessionRoot, "subagents", `${WORKER_A}.json`),
        JSON.stringify({ conversationId: WORKER_A, state: "SUBAGENT_STATE_ALIVE" }),
      );
      await writeFile(
        join(sessionRoot, "subagents", `${WORKER_B}.json`),
        JSON.stringify({ conversationId: WORKER_B, state: "SUBAGENT_STATE_ALIVE" }),
      );
      // Even if WORKER_A previously sent a message in an earlier round, wake_mode "working"
      // means it is actively executing another round right now.
      await writeFile(
        join(sessionRoot, "messages", "msg-1.json"),
        JSON.stringify({ id: "msg-1", sender: WORKER_A, priority: "MESSAGE_PRIORITY_LOW" }),
      );
      await writeFile(
        join(sessionRoot, "swarm", "members.json"),
        JSON.stringify({
          members: {
            coordinator: {
              conversation_id: SESSION_ID,
              role: "coordinator",
              phase: "RUNNING",
              wake_mode: "working",
              killed: false,
            },
            "room-collab": {
              conversation_id: WORKER_A,
              role: "worker",
              desired_state: "RUNNING",
              phase: "RUNNING",
              wake_mode: "working",
              killed: false,
            },
            "canvas-ux": {
              conversation_id: WORKER_B,
              role: "worker",
              desired_state: "RUNNING",
              phase: "RUNNING",
              wake_mode: "mentions",
              killed: false,
            },
          },
        }),
      );

      const active = await Effect.runPromise(
        readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
      );
      expect(active).toEqual({
        activeSwarmWorkers: 1,
        activeSubagents: 0,
        hasPendingWake: false,
        hasActiveWork: true,
      });

      // Once room-collab parks (wake_mode: "mentions"), no swarm workers are active.
      await writeFile(
        join(sessionRoot, "swarm", "members.json"),
        JSON.stringify({
          members: {
            "room-collab": {
              conversation_id: WORKER_A,
              role: "worker",
              desired_state: "RUNNING",
              phase: "RUNNING",
              wake_mode: "mentions",
              killed: false,
            },
            "canvas-ux": {
              conversation_id: WORKER_B,
              role: "worker",
              desired_state: "KILLED",
              phase: "KILLED",
              wake_mode: "working",
              killed: true,
            },
          },
        }),
      );

      const parked = await Effect.runPromise(
        readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
      );
      expect(parked).toEqual(EMPTY_ANTIGRAVITY_CHILD_ACTIVITY);
    });
  });

  it("tracks unreported detached subagents and unread high-priority wakes", async () => {
    await withProfile(async (profileDir, sessionRoot) => {
      await mkdir(join(sessionRoot, "subagents"), { recursive: true });
      await mkdir(join(sessionRoot, "messages"), { recursive: true });

      await writeFile(
        join(sessionRoot, "subagents", `${SUBAGENT_A}.json`),
        JSON.stringify({ conversationId: SUBAGENT_A, state: "SUBAGENT_STATE_ALIVE" }),
      );

      const running = await Effect.runPromise(
        readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
      );
      expect(running).toEqual({
        activeSwarmWorkers: 0,
        activeSubagents: 1,
        hasPendingWake: false,
        hasActiveWork: true,
      });

      // Subagent reports with a high-priority wake message not yet marked read.
      await writeFile(
        join(sessionRoot, "messages", "wake-1.json"),
        JSON.stringify({
          id: "wake-1",
          sender: SUBAGENT_A,
          priority: "MESSAGE_PRIORITY_HIGH",
        }),
      );
      const waking = await Effect.runPromise(
        readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
      );
      expect(waking).toEqual({
        activeSwarmWorkers: 0,
        activeSubagents: 0,
        hasPendingWake: true,
        hasActiveWork: true,
      });

      // Once read.json acknowledges the wake, no child work remains.
      await writeFile(
        join(sessionRoot, "messages", "read.json"),
        JSON.stringify({ "wake-1": true }),
      );
      const settled = await Effect.runPromise(
        readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
      );
      expect(settled).toEqual(EMPTY_ANTIGRAVITY_CHILD_ACTIVITY);
    });
  });

  it("detects a dequeued high-priority SYSTEM_MESSAGE at the tail of transcript.jsonl", async () => {
    await withProfile(async (profileDir, sessionRoot) => {
      await mkdir(join(sessionRoot, "logs"), { recursive: true });
      await writeFile(
        join(sessionRoot, "logs", "transcript.jsonl"),
        [
          JSON.stringify({ type: "PLANNER_RESPONSE", content: "Waiting on workers." }),
          JSON.stringify({
            type: "SYSTEM_MESSAGE",
            content: "[Message] priority=MESSAGE_PRIORITY_HIGH content=Worker finished",
          }),
        ].join("\n") + "\n",
      );

      const pending = await Effect.runPromise(
        readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
      );
      expect(pending.hasPendingWake).toBe(true);
      expect(pending.hasActiveWork).toBe(true);

      await writeFile(
        join(sessionRoot, "logs", "transcript.jsonl"),
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          content: "[Message] priority=MESSAGE_PRIORITY_LOW content=FYI",
        }) + "\n",
      );
      const lowPriority = await Effect.runPromise(
        readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
      );
      expect(lowPriority).toEqual(EMPTY_ANTIGRAVITY_CHILD_ACTIVITY);
    });
  });

  it("fails closed on invalid session ids, missing directories, and symlinked metadata", async () => {
    const invalid = await Effect.runPromise(
      readAntigravityChildActivity({ profileDir: tmpdir(), sessionId: "../escape" }),
    );
    expect(invalid).toEqual(EMPTY_ANTIGRAVITY_CHILD_ACTIVITY);

    await withProfile(async (profileDir, sessionRoot) => {
      const outside = await mkdtemp(join(tmpdir(), "moss-agy-outside-"));
      try {
        await writeFile(
          join(outside, "members.json"),
          JSON.stringify({
            members: {
              worker: { conversation_id: WORKER_A, role: "worker", wake_mode: "working" },
            },
          }),
        );
        await mkdir(join(sessionRoot, "swarm"), { recursive: true });
        try {
          await symlink(join(outside, "members.json"), join(sessionRoot, "swarm", "members.json"));
        } catch {
          // Windows without developer mode cannot create file symlinks; skip symlink assertion there.
          return;
        }
        const linked = await Effect.runPromise(
          readAntigravityChildActivity({ profileDir, sessionId: SESSION_ID }),
        );
        expect(linked).toEqual(EMPTY_ANTIGRAVITY_CHILD_ACTIVITY);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
