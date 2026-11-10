// FILE: wsHandlers.probe.test.ts
// Purpose: Prove overlapping import probes share one run, and that the probe's
//          start, finish and failure reach the server log without the raw error
//          reaching anyone but the log.
// Layer: Server import tests

import { DEFAULT_SERVER_SETTINGS, type WorkspaceImportProbeResult } from "@moss/contracts";
import { Effect, Logger } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerConfigShape } from "../config";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery";
import type { ServerSettingsShape } from "../serverSettings";

const probeControl = vi.hoisted(() => ({
  calls: 0,
  release: null as (() => void) | null,
  fail: false,
}));

vi.mock("./probe", () => ({
  probeWorkspaceImport: async (context: {
    onSourceProbed?: (event: {
      source: string;
      durationMs: number;
      timedOutSteps: readonly string[];
      failedSteps: readonly string[];
      stepDurationsMs: Readonly<Record<string, number>>;
    }) => void;
  }): Promise<WorkspaceImportProbeResult> => {
    probeControl.calls += 1;
    await new Promise<void>((resolve) => {
      probeControl.release = resolve;
    });
    if (probeControl.fail) throw new Error("EACCES: permission denied, scandir");
    context.onSourceProbed?.({
      source: "claude",
      durationMs: 5,
      timedOutSteps: [],
      failedSteps: [],
      stepDurationsMs: {},
    });
    context.onSourceProbed?.({
      source: "codex",
      durationMs: 7,
      timedOutSteps: ["chats"],
      failedSteps: [],
      stepDurationsMs: {},
    });
    return {
      sources: [
        {
          source: "claude",
          present: true,
          skillCount: 0,
          honorAbleSettingCount: 0,
          chatCount: 3,
          olderChatCount: 0,
        },
        {
          source: "codex",
          present: true,
          incomplete: true,
          skillCount: 0,
          honorAbleSettingCount: 0,
          chatCount: 0,
          olderChatCount: 0,
        },
      ],
      requiresSourceChoice: true,
    };
  },
}));

const { makeWorkspaceImportWsHandlers } = await import("./wsHandlers");

function makeHandlers() {
  return makeWorkspaceImportWsHandlers({
    config: {
      homeDir: "/home/tester",
      cwd: "/home/tester",
      stateDir: "/home/tester/.moss-state",
    } as unknown as ServerConfigShape,
    serverSettings: {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    } as unknown as ServerSettingsShape,
    projectionReadModelQuery: {} as ProjectionSnapshotQueryShape,
    dispatchOrchestrationCommand: () => Effect.void,
  });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  probeControl.calls = 0;
  probeControl.release = null;
  probeControl.fail = false;
});

describe("workspace import probe handler", () => {
  it("shares one running probe between overlapping requests and logs it once", async () => {
    const handlers = makeHandlers();
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(JSON.stringify(message));
    });
    try {
      const both = Effect.runPromise(
        Effect.all([handlers.probe(), handlers.probe()], { concurrency: "unbounded" }).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
      await waitFor(() => probeControl.release !== null);
      probeControl.release?.();
      const [first, second] = await both;

      expect(probeControl.calls).toBe(1);
      expect(second).toBe(first);
      expect(messages.filter((line) => line.includes("probe started"))).toHaveLength(1);
      const finished = messages.filter((line) => line.includes("unfinished sources"));
      expect(finished).toHaveLength(1);
      expect(finished[0]).toContain('"codex"');
      expect(finished[0]).toContain('"chats"');
    } finally {
      handlers.dispose();
    }
  });

  it("logs a failed probe", async () => {
    const handlers = makeHandlers();
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(JSON.stringify(message));
    });
    probeControl.fail = true;
    try {
      const run = Effect.runPromise(
        Effect.exit(handlers.probe()).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
      await waitFor(() => probeControl.release !== null);
      probeControl.release?.();
      const exit = await run;

      expect(exit._tag).toBe("Failure");
      expect(messages.some((line) => line.includes("probe failed"))).toBe(true);
    } finally {
      handlers.dispose();
    }
  });
});
