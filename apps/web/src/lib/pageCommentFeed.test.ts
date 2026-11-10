// FILE: pageCommentFeed.test.ts
// Purpose: Preserve both comment sources and their identities in one chronological view.
// Layer: Web page presentation tests

import { PageId, type PageComment, type PageGuestComment } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { mergePageComments } from "./pageCommentFeed";

const pageId = PageId.makeUnsafe("page-1");
const local: PageComment = {
  id: "same-id",
  pageId,
  revision: 2,
  content: "Owner's local comment",
  author: "local-user",
  authorThreadId: null,
  createdAt: "2026-11-06T00:02:00.000Z",
};
const guest: PageGuestComment = {
  id: "same-id",
  pageId,
  authorKind: "guest",
  authorName: "Lin",
  content: "Guest feedback",
  createdAt: "2026-11-06T00:01:00.000Z",
};

describe("mergePageComments", () => {
  it("keeps colliding IDs from different stores and sorts by time", () => {
    const comments = mergePageComments([local], [guest]);
    expect(comments.map((comment) => comment.key)).toEqual(["share:same-id", "page:same-id"]);
    expect(comments[0]).toMatchObject({ source: "share", authorKind: "guest", authorName: "Lin" });
    expect(comments[1]).toMatchObject({ source: "page", authorKind: "owner", authorName: null });
  });

  it("keeps available data when one source has not loaded", () => {
    expect(mergePageComments(undefined, [guest])).toHaveLength(1);
    expect(mergePageComments([local], undefined)).toHaveLength(1);
    expect(mergePageComments()).toEqual([]);
  });

  it("deduplicates repeated IDs only within their own store without editing records", () => {
    const original = structuredClone({ local, guest });
    expect(mergePageComments([local, local], [guest, guest])).toHaveLength(2);
    expect({ local, guest }).toEqual(original);
  });

  it("preserves agent and invited member identities", () => {
    const comments = mergePageComments(
      [{ ...local, author: "agent" }],
      [{ ...guest, authorKind: "member" }],
    );
    expect(comments.map((comment) => comment.authorKind)).toEqual(["member", "agent"]);
  });
});
