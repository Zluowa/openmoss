import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mossReviewPacketExitCode, readMossReviewPacket } from "./moss-review-packet.ts";

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
    readonly events: ReadonlyArray<unknown>;
    readonly tasks: ReadonlyArray<unknown>;
  },
): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await mkdir(join(root, ".moss", "ledger"), { recursive: true });
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
          goal: "Build a Codex-like shell",
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
  await writeFile(
    join(root, ".moss", "context", "current.md"),
    "# Moss Context Snapshot\n\n## Status\n\nCurrent implementation snapshot.\n",
  );
}

describe("moss-review-packet", () => {
  it("generates a review packet from iteration packet, changed files, ledger, and evidence", async () => {
    const root = join(process.cwd(), ".tmp", "moss-review-packet-test");
    await writeMossRepo(root, {
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
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [
            ".moss/ledger/evidence/review-packet.md",
            "bun run moss:review-packet -- --created-at 2026-07-01T00:00:00.000Z",
          ],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Add review packet generation for Moss loop automation",
          acceptance: ["Packet separates QA evidence from Reviewer decision"],
          evidence: [],
        },
      ],
    });

    const packet = await readMossReviewPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-review-packet.ts", ".moss/ledger/events.jsonl"],
    });

    expect(packet).toMatchObject({
      version: 1,
      generatedAt: "2026-07-01T00:00:00.000Z",
      task: {
        taskId: "moss-task-1",
        owner: "QA Gatekeeper",
        correlationId: "iteration-1",
      },
      ledger: {
        releaseGateStatus: "pass",
        issueCount: 0,
      },
      readiness: {
        status: "pending",
      },
    });
    expect(packet.iterationPacket.objective).toBe(
      "Complete moss-task-1: Add review packet generation for Moss loop automation",
    );
    expect(packet.changedFiles.map((file) => file.path)).toEqual([
      "scripts/moss-review-packet.ts",
      ".moss/ledger/events.jsonl",
    ]);
    expect(packet.qaEvidence.evidenceEventIds).toEqual(["moss-event-evidence"]);
    expect(packet.qaEvidence.commandRefs).toEqual([
      "bun run moss:review-packet -- --created-at 2026-07-01T00:00:00.000Z",
    ]);
    expect(packet.reviewerDecision).toBeNull();
    expect(packet.issues.map((issue) => issue.code)).toEqual(["reviewer-decision-pending"]);
    expect(mossReviewPacketExitCode(packet)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("reports failed release gates in machine-readable form", async () => {
    const root = join(process.cwd(), ".tmp", "moss-review-packet-failed-gate-test");
    await writeMossRepo(root, {
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
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Add review packet generation for Moss loop automation",
          acceptance: [],
          evidence: [],
        },
        {
          taskId: "moss-task-2",
          status: "done",
          owner: "Reviewer",
          title: "Done without evidence",
          evidence: [],
        },
      ],
    });

    const packet = await readMossReviewPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-review-packet.ts"],
    });

    expect(packet.ledger.releaseGateStatus).toBe("fail");
    expect(packet.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "release-gate-failed",
          severity: "error",
        }),
        expect.objectContaining({
          code: "qa-evidence-missing",
          severity: "warning",
        }),
      ]),
    );
    expect(packet.readiness.status).toBe("blocked");
    expect(mossReviewPacketExitCode(packet)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });

  it("blocks self-approval when Reviewer decision actor matches the task owner", async () => {
    const root = join(process.cwd(), ".tmp", "moss-review-packet-self-approval-test");
    await writeMossRepo(root, {
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
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [".moss/ledger/evidence/review-packet.md"],
        }),
        event({
          eventId: "moss-event-review",
          type: "moss.review.completed",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          payload: {
            decision: "accepted",
            notes: "self approval should fail",
          },
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Add review packet generation for Moss loop automation",
          acceptance: [],
          evidence: [],
        },
      ],
    });

    const packet = await readMossReviewPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-review-packet.ts"],
    });

    expect(packet.reviewerDecision).toMatchObject({
      eventId: "moss-event-review",
      actorRole: "QA Gatekeeper",
      decision: "accepted",
    });
    expect(packet.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "reviewer-role-invalid",
          severity: "error",
        }),
        expect.objectContaining({
          code: "reviewer-self-approval",
          severity: "error",
        }),
      ]),
    );
    expect(packet.readiness.status).toBe("blocked");
    expect(mossReviewPacketExitCode(packet)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });
});
