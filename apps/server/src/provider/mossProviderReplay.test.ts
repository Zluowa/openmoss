import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { mossProviderReplayExitCode, readMossProviderReplayReport } from "./mossProviderReplay.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("mossProviderReplay", () => {
  it("replays checked-in provider fixtures through the Moss normalized event layer", async () => {
    const report = await readMossProviderReplayReport(repoRoot, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(report.releaseGate).toMatchObject({
      status: "pass",
      issueCount: 0,
    });
    expect(mossProviderReplayExitCode(report)).toBe(0);
    expect(report.fixtures).toHaveLength(7);
    expect(report.fixtures.map((fixture) => fixture.provider)).toEqual([
      "claudeAgent",
      "codex",
      "cursor",
      "gemini",
      "grok",
      "opencode",
      "pi",
    ]);
    expect(
      report.fixtures.every(
        (fixture) =>
          fixture.normalizedEventCount > 0 &&
          fixture.normalizedEvents.every(
            (event) =>
              event.rawEventId !== undefined &&
              typeof event.payload.launchPlanHash === "string" &&
              event.payload.launchPlanHash.startsWith("sha256:"),
          ),
      ),
    ).toBe(true);
  });

  it("fails the release gate when a fixture misses an expected normalized event type", async () => {
    const root = join(repoRoot, ".tmp", "moss-provider-replay-test");
    const fixtureRoot = join(root, "fixtures");
    await rm(root, { force: true, recursive: true });
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(
      join(fixtureRoot, "codex-missing-type.json"),
      JSON.stringify(
        {
          provider: "codex",
          expectedTypes: ["text", "tool-call"],
          events: [
            {
              eventId: "raw-codex-text-only",
              provider: "codex",
              sessionId: "runtime-session-codex-missing-type",
              threadId: "thread-codex-missing-type",
              turnId: "turn-codex-missing-type",
              createdAt: "2026-07-01T00:00:00.000Z",
              launchPlanHash: "sha256:fixture",
              type: "content.delta",
              raw: {
                source: "codex.eventmsg",
                payload: {
                  type: "message_delta",
                },
              },
              payload: {
                streamKind: "assistant_text",
                delta: "only text",
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const report = await readMossProviderReplayReport(repoRoot, {
      fixtureRoot: relative(repoRoot, fixtureRoot),
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(report.releaseGate.status).toBe("fail");
    expect(report.releaseGate.issues).toEqual([
      {
        code: "missing-normalized-type",
        fixturePath: relative(repoRoot, join(fixtureRoot, "codex-missing-type.json")),
        message: "fixture did not produce normalized tool-call",
        type: "tool-call",
      },
    ]);
    expect(mossProviderReplayExitCode(report)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });

  it("fails the release gate when normalized events drop launch plan hashes", async () => {
    const root = join(repoRoot, ".tmp", "moss-provider-replay-launch-plan-test");
    const fixtureRoot = join(root, "fixtures");
    await rm(root, { force: true, recursive: true });
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(
      join(fixtureRoot, "codex-missing-launch-plan-hash.json"),
      JSON.stringify(
        {
          provider: "codex",
          expectedTypes: ["text"],
          events: [
            {
              eventId: "raw-codex-text-without-launch-plan-hash",
              provider: "codex",
              sessionId: "runtime-session-codex-missing-launch-plan-hash",
              threadId: "thread-codex-missing-launch-plan-hash",
              turnId: "turn-codex-missing-launch-plan-hash",
              createdAt: "2026-07-01T00:00:00.000Z",
              type: "content.delta",
              raw: {
                source: "codex.eventmsg",
                payload: {
                  type: "message_delta",
                },
              },
              payload: {
                streamKind: "assistant_text",
                delta: "text without launch plan hash",
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    const report = await readMossProviderReplayReport(repoRoot, {
      fixtureRoot: relative(repoRoot, fixtureRoot),
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(report.releaseGate.status).toBe("fail");
    expect(report.releaseGate.issues).toEqual([
      {
        code: "missing-launch-plan-hash",
        fixturePath: relative(repoRoot, join(fixtureRoot, "codex-missing-launch-plan-hash.json")),
        message:
          "normalized event moss-normalized-raw-codex-text-without-launch-plan-hash-text does not preserve launchPlanHash",
        eventId: "moss-normalized-raw-codex-text-without-launch-plan-hash-text",
      },
    ]);
    expect(mossProviderReplayExitCode(report)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });
});
