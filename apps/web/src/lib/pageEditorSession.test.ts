import {
  PageId,
  type PagesMutateInput,
  type PagesMutateResult,
  type PagesReadResult,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageEditorSession } from "./pageEditorSession";

const initial: PagesReadResult = {
  page: {
    id: PageId.makeUnsafe("page-test"),
    scopeSpaceId: null,
    spaceId: null,
    parentPageId: null,
    rootPageId: PageId.makeUnsafe("page-test"),
    title: "Original",
    revision: 1,
    pinned: false,
    trashedAt: null,
    sourceThreadId: null,
    assetIds: [],
    automationIds: [],
    createdAt: "2026-10-25T00:00:00Z",
    updatedAt: "2026-10-25T00:00:00Z",
  },
  content: "Original body",
};
type Update = Extract<PagesMutateInput, { op: "update" }>;
const acknowledge = (input: Update): PagesMutateResult => ({
  page: {
    ...initial.page,
    revision: input.expectedRevision + 1,
    title: input.title ?? initial.page.title,
  },
  content: input.content ?? initial.content,
  affectedPageIds: [initial.page.id],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe("Page revision and draft writer", () => {
  it("drains edits made during a write against its acknowledged revision", async () => {
    const first = deferred<PagesMutateResult>();
    const write = vi
      .fn<(input: Update) => Promise<PagesMutateResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (input) => acknowledge(input));
    const session = new PageEditorSession(initial, write, vi.fn());
    session.change({ content: "First edit" });
    const pending = session.flush();
    await Promise.resolve();
    session.change({ content: "Second edit" });
    first.resolve(acknowledge(write.mock.calls[0]![0]));
    await expect(pending).resolves.toBe(true);
    expect(write.mock.calls.map(([input]) => [input.expectedRevision, input.content])).toEqual([
      [1, "First edit"],
      [2, "Second edit"],
    ]);
    expect(session.dirty).toBe(false);
    expect(session.getSnapshot().document.page.revision).toBe(3);
  });

  it("keeps a lost acknowledgement's identity and payload across a restart", async () => {
    let raw: string | null = null;
    const journal = {
      read: () => raw,
      write: (value: string | null) => {
        raw = value;
      },
    };
    const failed = vi
      .fn<(input: Update) => Promise<PagesMutateResult>>()
      .mockRejectedValue(new Error("socket closed after commit"));
    const first = new PageEditorSession(initial, failed, vi.fn(), journal);
    first.change({ content: "Saved but reply lost" });
    await expect(first.flush()).resolves.toBe(false);
    const sent = failed.mock.calls[0]![0];
    const replay = vi.fn(async (_input: Update) => acknowledge(sent));
    const recovered = new PageEditorSession(acknowledge(sent), replay, vi.fn(), journal);
    await expect(recovered.flush()).resolves.toBe(true);
    expect(replay).toHaveBeenCalledExactlyOnceWith(sent);
    expect(raw).toBeNull();
    expect(recovered.dirty).toBe(false);
  });

  it("preserves a conflicting recovered draft without rebasing or overwriting", async () => {
    const remote = {
      ...initial,
      page: { ...initial.page, revision: 2 },
      content: "Another CLI edited",
    };
    const write = vi.fn(async (input: Update) => acknowledge(input));
    const session = new PageEditorSession(remote, write, vi.fn(), {
      read: () => JSON.stringify({ revision: 1, title: "Original", content: "My unsaved text" }),
      write: vi.fn(),
    });
    await expect(session.flush()).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(session.getSnapshot().content).toBe("My unsaved text");
    expect(session.getSnapshot().document.content).toBe("Another CLI edited");
    expect(session.getSnapshot().error).toContain("草稿已保留");
  });

  it("does not reset the shared editor on identical query refreshes", () => {
    const session = new PageEditorSession(initial, vi.fn(), vi.fn());
    const before = session.getSnapshot();
    session.load({ ...initial, page: { ...initial.page } });
    expect(session.getSnapshot()).toBe(before);
    session.load({ ...initial, page: { ...initial.page, revision: 2, pinned: true } });
    expect(session.getSnapshot().document.page.pinned).toBe(true);
    expect(session.getSnapshot().version).toBe(0);
  });

  it("resumes autosave after a temporarily empty title is corrected", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (input: Update) => acknowledge(input));
    const session = new PageEditorSession(initial, write, vi.fn());
    const unsubscribe = session.subscribe(vi.fn());
    session.change({ title: "" });
    await vi.advanceTimersByTimeAsync(400);
    expect(write).not.toHaveBeenCalled();
    expect(session.getSnapshot().error).toBe("请填写页面标题。");
    session.change({ title: "Valid title" });
    await vi.advanceTimersByTimeAsync(400);
    expect(write).toHaveBeenCalledTimes(1);
    expect(session.dirty).toBe(false);
    unsubscribe();
  });

  it("pauses body writes while another durable Page operation is unresolved", async () => {
    const write = vi.fn(async (input: Update) => acknowledge(input));
    const session = new PageEditorSession(initial, write, vi.fn());
    session.pause();
    session.change({ content: "Keep this draft" });
    await expect(session.flush()).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    session.resume();
    await expect(session.flush()).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves canonical rich blocks when only the title changes", async () => {
    const richContent = JSON.stringify([
      {
        type: "table",
        children: [
          {
            type: "tr",
            children: [{ type: "td", children: [{ type: "p", children: [{ text: "Cell" }] }] }],
          },
        ],
      },
    ]);
    const rich = { ...initial, content: "Cell", richContent };
    const write = vi.fn(
      async (input: Update): Promise<PagesMutateResult> => ({
        ...acknowledge(input),
        content: "Cell",
        ...(typeof input.richContent === "string" ? { richContent: input.richContent } : {}),
      }),
    );
    const session = new PageEditorSession(rich, write, vi.fn());
    session.change({ title: "Table notes" });
    await expect(session.flush()).resolves.toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Table notes", richContent }),
    );
    expect(session.getSnapshot().richContent).toBe(richContent);
    expect(session.dirty).toBe(false);
  });

  it("adopts the server rich projection without a redundant second write", async () => {
    const richContent = JSON.stringify([{ type: "h1", children: [{ text: "Heading" }] }]);
    const normalized = JSON.stringify(JSON.parse(richContent), null, 2);
    const write = vi.fn(
      async (input: Update): Promise<PagesMutateResult> => ({
        ...acknowledge(input),
        content: "Heading",
        richContent: normalized,
      }),
    );
    const session = new PageEditorSession(initial, write, vi.fn());
    session.change({ content: "# Heading", richContent });
    await expect(session.flush()).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({ content: "Heading", richContent: normalized });
    expect(session.dirty).toBe(false);
  });

  it("drains a newer rich edit without replacing it with the previous acknowledgement", async () => {
    const first = deferred<PagesMutateResult>();
    const one = JSON.stringify([{ type: "p", children: [{ text: "First" }] }]);
    const two = JSON.stringify([{ type: "p", children: [{ text: "Second", bold: true }] }]);
    const write = vi
      .fn<(input: Update) => Promise<PagesMutateResult>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (input) => ({
        ...acknowledge(input),
        ...(typeof input.richContent === "string" ? { richContent: input.richContent } : {}),
      }));
    const session = new PageEditorSession(initial, write, vi.fn());
    session.change({ content: "First", richContent: one });
    const pending = session.flush();
    await Promise.resolve();
    session.change({ content: "Second", richContent: two });
    first.resolve({ ...acknowledge(write.mock.calls[0]![0]), richContent: one });
    await expect(pending).resolves.toBe(true);
    expect(write.mock.calls.map(([input]) => [input.expectedRevision, input.richContent])).toEqual([
      [1, one],
      [2, two],
    ]);
    expect(session.getSnapshot().richContent).toBe(two);
    expect(session.dirty).toBe(false);
  });

  it("replays the same rich request after a lost acknowledgement and a restart", async () => {
    let raw: string | null = null;
    const journal = {
      read: () => raw,
      write: (value: string | null) => {
        raw = value;
      },
    };
    const richContent = JSON.stringify([
      { type: "p", children: [{ text: "Keep format", italic: true }] },
    ]);
    const failed = vi
      .fn<(input: Update) => Promise<PagesMutateResult>>()
      .mockRejectedValue(new Error("reply lost"));
    const first = new PageEditorSession(initial, failed, vi.fn(), journal);
    first.change({ content: "Keep format", richContent });
    await expect(first.flush()).resolves.toBe(false);
    const sent = failed.mock.calls[0]![0];
    const saved: PagesMutateResult = { ...acknowledge(sent), richContent };
    const write = vi.fn(async (_input: Update) => saved);
    const recovered = new PageEditorSession(saved, write, vi.fn(), journal);
    await expect(recovered.flush()).resolves.toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith(sent);
    expect(recovered.getSnapshot().richContent).toBe(richContent);
    expect(raw).toBeNull();
  });
});
