import { describe, expect, it, vi } from "vitest";
import { readCodexThreadHistory } from "./codexThreadHistory";

describe("canonical Codex replay history", () => {
  it("keeps legacy includeTurns snapshots intact without another request", async () => {
    const response = { thread: { id: "thread", turns: [{ id: "legacy", items: [] }] } };
    const request = vi.fn();
    expect(await readCodexThreadHistory(response, request)).toBe(response);
    expect(request).not.toHaveBeenCalled();
  });

  it("loads paginated turns in source order and preserves replay timing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "first",
            status: "completed",
            startedAt: 100,
            durationMs: 7_321,
            itemsView: "full",
            items: [{ id: "user", type: "userMessage" }],
          },
        ],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        data: [
          { id: "second", itemsView: "full", items: [{ id: "shell", type: "commandExecution" }] },
        ],
        nextCursor: null,
      });
    const result = await readCodexThreadHistory(
      { thread: { id: "thread", historyMode: "paginated", turns: [] } },
      request,
    );
    expect(result).toMatchObject({
      thread: { turns: [{ id: "first", durationMs: 7_321 }, { id: "second" }] },
    });
    expect(request.mock.calls.map((call) => call[1].cursor)).toEqual([null, "next"]);
    expect(request).toHaveBeenCalledWith(
      "thread/turns/list",
      expect.objectContaining({ sortDirection: "asc", itemsView: "full" }),
    );
  });

  it("hydrates summary items and deduplicates overlaps without reordering", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "turn", itemsView: "summary", items: [{ id: "final" }] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ turnId: "turn", item: { id: "user", type: "userMessage" } }],
        nextCursor: "items-2",
      })
      .mockResolvedValueOnce({
        data: [
          { turnId: "turn", item: { id: "user", type: "userMessage" } },
          { turnId: "turn", item: { id: "final", type: "agentMessage" } },
        ],
        nextCursor: null,
      });
    expect(
      await readCodexThreadHistory({ thread: { id: "thread", historyMode: "paginated" } }, request),
    ).toMatchObject({
      thread: { turns: [{ itemsView: "full", items: [{ id: "user" }, { id: "final" }] }] },
    });
  });

  it("fails repeated cursors instead of returning incomplete history", async () => {
    const request = vi.fn().mockResolvedValue({ data: [], nextCursor: "same" });
    await expect(
      readCodexThreadHistory({ thread: { id: "thread", historyMode: "paginated" } }, request),
    ).rejects.toThrow("repeated cursor");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects an item from another turn", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "turn", itemsView: "notLoaded" }], nextCursor: null })
      .mockResolvedValueOnce({
        data: [{ turnId: "other", item: { id: "wrong" } }],
        nextCursor: null,
      });
    await expect(
      readCodexThreadHistory({ thread: { id: "thread", historyMode: "paginated" } }, request),
    ).rejects.toThrow("unrelated item");
  });

  it("propagates interrupted reads without publishing a partial snapshot", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "turn", itemsView: "full", items: [] }],
        nextCursor: "next",
      })
      .mockRejectedValueOnce(new Error("disconnected"));
    await expect(
      readCodexThreadHistory({ thread: { id: "thread", historyMode: "paginated" } }, request),
    ).rejects.toThrow("disconnected");
  });
});
