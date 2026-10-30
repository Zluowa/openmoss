import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mossMemoryPacketExitCode, readMossMemoryPacket } from "./moss-memory-packet.ts";

function event(input: {
  readonly eventId: string;
  readonly type: string;
  readonly role: string;
  readonly correlationId: string;
  readonly payload?: Record<string, unknown>;
  readonly evidence?: ReadonlyArray<string>;
}) {
  return {
    eventId: input.eventId,
    type: input.type,
    createdAt: "2026-07-01T00:00:00.000Z",
    actor: {
      role: input.role,
    },
    correlationId: input.correlationId,
    payload: input.payload ?? {},
    evidence: input.evidence ?? [],
  };
}

async function writeMossRepo(
  root: string,
  input: {
    readonly context: string;
    readonly evidenceIndex: string;
    readonly events: ReadonlyArray<unknown>;
    readonly tasks: ReadonlyArray<unknown>;
  },
): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await mkdir(join(root, ".moss", "ledger", "evidence"), { recursive: true });
  await mkdir(join(root, ".moss", "roles"), { recursive: true });
  await mkdir(join(root, ".moss", "context"), { recursive: true });
  await writeFile(
    join(root, ".moss", "mission.md"),
    "# Moss Shell Mission\n\nBuild the control plane.\n",
  );
  await writeFile(
    join(root, ".moss", "ledger", "events.jsonl"),
    `${[
      {
        eventId: "moss-event-goal",
        type: "moss.goal.defined",
        createdAt: "2026-07-01T00:00:00.000Z",
        payload: {
          goal: "Build a Codex-like shell.",
          branch: "moss/control-plane-v1",
        },
      },
      ...input.events,
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await writeFile(
    join(root, ".moss", "ledger", "tasks.jsonl"),
    `${input.tasks.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await writeFile(join(root, ".moss", "roles", "memory-curator.md"), "# Memory Curator\n");
  await writeFile(join(root, ".moss", "roles", "qa-gatekeeper.md"), "# QA Gatekeeper\n");
  await writeFile(join(root, ".moss", "roles", "reviewer.md"), "# Reviewer\n");
  await writeFile(join(root, ".moss", "context", "current.md"), input.context);
  await writeFile(join(root, ".moss", "ledger", "evidence", "README.md"), input.evidenceIndex);
}

describe("moss-memory-packet", () => {
  it("generates a packet from context, ledger, evidence index, and decisions", async () => {
    const root = join(process.cwd(), ".tmp", "moss-memory-packet-test");
    await writeMossRepo(root, {
      context:
        "# Moss Context Snapshot\n\n## Status\n\nReview packet generation is complete.\n\n## Next Tasks\n\n- Add memory packet generation for Moss loop automation from context,\n  ledger events, tasks, evidence index, and decisions.\n",
      evidenceIndex:
        "# Evidence Index\n\n- `review-packet-2026-07-01.md`\n- `iteration-packet-2026-07-01.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
        event({
          eventId: "moss-event-review",
          type: "moss.review.completed",
          role: "Reviewer",
          correlationId: "iteration-1",
          payload: {
            decision: "accepted",
            notes: "review packet works",
          },
          evidence: [".moss/ledger/evidence/review-packet-2026-07-01.md"],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Add review packet generation for Moss loop automation",
          evidence: [
            ".moss/ledger/evidence/review-packet-2026-07-01.md",
            "bun run moss:review-packet -- --created-at 2026-07-01T00:00:00.000Z",
          ],
        },
        {
          taskId: "moss-task-2",
          status: "active",
          owner: "Memory Curator",
          title: "Add memory packet generation for Moss loop automation",
          evidence: [],
        },
      ],
    });

    const packet = await readMossMemoryPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet).toMatchObject({
      version: 1,
      generatedAt: "2026-07-01T00:00:00.000Z",
      statusSummary: "Review packet generation is complete.",
      ledger: {
        releaseGateStatus: "pass",
        activeTaskIds: ["moss-task-2"],
      },
      readiness: {
        status: "ready",
      },
    });
    expect(packet.activeTasks.map((task) => task.taskId)).toEqual(["moss-task-2"]);
    expect(packet.nextTasks).toEqual([
      "Add memory packet generation for Moss loop automation from context, ledger events, tasks, evidence index, and decisions.",
    ]);
    expect(packet.durableFacts).toContain("Current goal: Build a Codex-like shell.");
    expect(packet.recentDecisions).toEqual([
      expect.objectContaining({
        eventId: "moss-event-review",
        taskId: "moss-task-1",
        decision: "accepted",
      }),
    ]);
    expect(packet.evidenceRefs.commandRefs).toEqual([
      "bun run moss:review-packet -- --created-at 2026-07-01T00:00:00.000Z",
    ]);
    expect(packet.contextSignals).toEqual([]);
    expect(mossMemoryPacketExitCode(packet)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("reports stale context and missing evidence index entries", async () => {
    const root = join(process.cwd(), ".tmp", "moss-memory-packet-stale-test");
    await writeMossRepo(root, {
      context:
        "# Moss Context Snapshot\n\n## Status\n\nOld status.\n\n## Next Tasks\n\n- Continue.\n",
      evidenceIndex: "# Evidence Index\n\n- `other.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Memory Curator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Memory Curator",
          title: "Add memory packet generation for Moss loop automation",
          evidence: [],
        },
        {
          taskId: "moss-task-2",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Add review packet generation for Moss loop automation",
          evidence: [".moss/ledger/evidence/review-packet-2026-07-01.md"],
        },
      ],
    });

    const packet = await readMossMemoryPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.contextSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "active-task-missing-from-context",
          severity: "warning",
        }),
        expect.objectContaining({
          code: "evidence-index-missing",
          severity: "warning",
        }),
      ]),
    );
    expect(packet.readiness.status).toBe("ready");
    expect(mossMemoryPacketExitCode(packet)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("blocks when the ledger release gate is failing", async () => {
    const root = join(process.cwd(), ".tmp", "moss-memory-packet-blocked-test");
    await writeMossRepo(root, {
      context:
        "# Moss Context Snapshot\n\n## Status\n\nMemory packet generation.\n\n## Next Tasks\n\n- Add memory packet generation for Moss loop automation.\n",
      evidenceIndex: "# Evidence Index\n",
      events: [],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Done without evidence",
          evidence: [],
        },
        {
          taskId: "moss-task-2",
          status: "active",
          owner: "Memory Curator",
          title: "Add memory packet generation for Moss loop automation",
          evidence: [],
        },
      ],
    });

    const packet = await readMossMemoryPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.contextSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "release-gate-failed",
          severity: "error",
        }),
        expect.objectContaining({
          code: "completed-task-missing-evidence",
          severity: "error",
        }),
      ]),
    );
    expect(packet.readiness.status).toBe("blocked");
    expect(mossMemoryPacketExitCode(packet)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });
});
