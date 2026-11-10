import { describe, expect, it } from "vitest";

import { translateMoss } from "~/localization";

import { buildMessageContextMenuItems } from "./messageContextMenu";

const t = (key: Parameters<typeof translateMoss>[1]) => translateMoss("en", key);
const none = { selectionText: null, code: null, linkHref: null };

describe("buildMessageContextMenuItems", () => {
  it("groups copy variants, keeping the pointer's target before the message", () => {
    const items = buildMessageContextMenuItems({
      target: {
        selectionText: "picked",
        code: { text: "bun test", block: true },
        linkHref: "https://x.dev",
      },
      canCopyMessage: true,
      canFork: true,
      pinned: false,
      t,
    });
    expect(items.map((item) => item.label)).toEqual(["Copy", "Fork from here", "Pin as chapter"]);
    expect(items[0]?.children?.map((item) => item.label)).toEqual([
      "Copy",
      "Copy code block",
      "Copy link",
      "Copy message",
      "Copy message as Markdown",
    ]);
    expect(items[0]?.children?.find((item) => item.id === "copy-message")?.separatorBefore).toBe(
      true,
    );
    expect(items.find((item) => item.id === "fork")?.separatorBefore).toBe(true);
  });

  it("offers unpin for a pinned message and inline code wording", () => {
    const items = buildMessageContextMenuItems({
      target: { ...none, code: { text: "x", block: false } },
      canCopyMessage: true,
      canFork: false,
      pinned: true,
      t,
    });
    expect(items.map((item) => item.label)).toEqual(["Copy", "Unpin chapter"]);
    expect(items[0]?.children?.map((item) => item.label)).toEqual([
      "Copy code",
      "Copy message",
      "Copy message as Markdown",
    ]);
  });

  it("leaves out pin when the message cannot be pinned", () => {
    const items = buildMessageContextMenuItems({
      target: none,
      canCopyMessage: true,
      canFork: false,
      pinned: null,
      t,
    });
    expect(items.map((item) => item.id)).toEqual(["copy"]);
    expect(items[0]?.children?.map((item) => item.id)).toEqual(["copy-message", "copy-markdown"]);
    expect(items[0]?.children?.[0]?.separatorBefore).toBe(false);
  });

  it("keeps a single copy action directly available", () => {
    const items = buildMessageContextMenuItems({
      target: { ...none, linkHref: "https://example.com" },
      canCopyMessage: false,
      canFork: false,
      pinned: null,
      t,
    });
    expect(items).toEqual([{ id: "copy-link", label: "Copy link" }]);
  });
});
