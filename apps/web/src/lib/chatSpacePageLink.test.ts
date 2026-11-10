import type { PagesReadResult } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";

import { openSpacePageFromChat, type OpenSpacePageFromChatDeps } from "./chatSpacePageLink";

function deps(
  pages: Record<string, { kind?: string; title: string; scopeSpaceId: string | null }>,
) {
  const calls: Array<{ scopeSpaceId: string | null; pageId: string }> = [];
  const value = {
    readPage: vi.fn(async (input: { scopeSpaceId: string | null; pageId: string }) => {
      calls.push(input);
      const page = pages[`${input.scopeSpaceId ?? "local"}:${input.pageId}`];
      if (!page) throw new Error("not found");
      return { page } as unknown as Pick<PagesReadResult, "page">;
    }),
    scopes: [null, "space-1"],
    openDeck: vi.fn(),
    openSpacePage: vi.fn(),
  };
  return { value: value as unknown as OpenSpacePageFromChatDeps, mocks: value, calls };
}

describe("openSpacePageFromChat", () => {
  it("opens a slides link in a chat as the right-panel deck tab", async () => {
    const d = deps({ "local:deck-1": { kind: "slides", title: "季度回顾", scopeSpaceId: null } });
    await openSpacePageFromChat("deck-1", "thread-1", d.value);
    expect(d.mocks.openDeck).toHaveBeenCalledExactlyOnceWith({
      pageId: "deck-1",
      scopeSpaceId: null,
      title: "季度回顾",
    });
    expect(d.mocks.openSpacePage).not.toHaveBeenCalled();
  });

  it("finds a deck in the active space when it is not in the local default", async () => {
    const d = deps({
      "space-1:deck-2": { kind: "slides", title: "周报", scopeSpaceId: "space-1" },
    });
    await openSpacePageFromChat("deck-2", "thread-1", d.value);
    expect(d.calls.map((call) => call.scopeSpaceId)).toEqual([null, "space-1"]);
    expect(d.mocks.openDeck).toHaveBeenCalledExactlyOnceWith({
      pageId: "deck-2",
      scopeSpaceId: "space-1",
      title: "周报",
    });
  });

  it("keeps 资料空间 for other page types, links outside a chat and unknown pages", async () => {
    const page = deps({ "local:doc-1": { kind: "page", title: "笔记", scopeSpaceId: null } });
    await openSpacePageFromChat("doc-1", "thread-1", page.value);
    expect(page.mocks.openSpacePage).toHaveBeenCalledExactlyOnceWith("doc-1");
    expect(page.mocks.openDeck).not.toHaveBeenCalled();

    const outside = deps({
      "local:deck-1": { kind: "slides", title: "季度回顾", scopeSpaceId: null },
    });
    await openSpacePageFromChat("deck-1", undefined, outside.value);
    expect(outside.mocks.readPage).not.toHaveBeenCalled();
    expect(outside.mocks.openSpacePage).toHaveBeenCalledExactlyOnceWith("deck-1");

    const missing = deps({});
    await openSpacePageFromChat("gone", "thread-1", missing.value);
    expect(missing.mocks.openSpacePage).toHaveBeenCalledExactlyOnceWith("gone");
    expect(missing.mocks.openDeck).not.toHaveBeenCalled();
  });
});
