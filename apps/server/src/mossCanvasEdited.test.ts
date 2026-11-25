import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canvasSnapshotHasShapes,
  isCanvasContentWrite,
  recordMossCanvasEdited,
  resetMossCanvasEditedForTests,
} from "./mossCanvasEdited";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";

const shape = { id: "shape:a", typeName: "shape", type: "text" };
const page = { id: "page:page", typeName: "page" };

describe("which 画布 saves count as content", () => {
  it("counts a save holding at least one shape, in either snapshot form", () => {
    expect(canvasSnapshotHasShapes({ document: { store: { "shape:a": shape } } })).toBe(true);
    expect(canvasSnapshotHasShapes({ store: { "shape:a": shape }, schema: {} })).toBe(true);
    expect(canvasSnapshotHasShapes({ document: { store: { "page:page": page } } })).toBe(false);
    expect(canvasSnapshotHasShapes(null)).toBe(false);
  });

  it("counts project writes and creates only", () => {
    const snapshot = { document: { store: { "shape:a": shape } } };
    expect(isCanvasContentWrite("projects.write", { snapshot })).toBe(true);
    expect(isCanvasContentWrite("projects.create", { snapshot })).toBe(true);
    expect(isCanvasContentWrite("projects.read", { snapshot })).toBe(false);
  });
});

describe("recording it", () => {
  afterEach(() => resetMossCanvasEditedForTests());

  const run = (input: { recorded: string | null; dispatch: (command: unknown) => void }) =>
    Effect.runPromise(
      recordMossCanvasEdited("thread-new-chat").pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getThreadShellById: () => Effect.succeed(Option.some({ canvasEditedAt: input.recorded })),
        } as never),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (command: unknown) => Effect.sync(() => input.dispatch(command)),
        } as never),
      ),
    );

  it("dispatches the server-only command once per conversation", async () => {
    const dispatch = vi.fn();
    await run({ recorded: null, dispatch });
    await run({ recorded: null, dispatch });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      type: "thread.canvas-edited.record",
      commandId: "canvas-edited:thread-new-chat",
      threadId: "thread-new-chat",
    });
  });

  it("dispatches nothing for a conversation already recorded", async () => {
    const dispatch = vi.fn();
    await run({ recorded: "2026-11-24T10:01:00.000Z", dispatch });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never fails the save that triggered it", async () => {
    const dispatch = vi.fn(() => {
      throw new Error("engine down");
    });
    await expect(run({ recorded: null, dispatch })).resolves.toBeUndefined();
  });
});
