import type { PageAppDbRule } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  isPageAppCollectionPath,
  isPageAppDocumentPath,
  pageAppDbAllows,
  pageAppDbRulesFromConfig,
  splitPageAppDbPath,
  validatePageAppDbRules,
} from "./pageAppDbRules";

const owner = { id: "owner", level: "owner" } as const;
const editor = { id: "ed", level: "admin" } as const;
const member = { id: "m1", level: "interact" } as const;
const other = { id: "m2", level: "interact" } as const;
const viewer = { id: "v1", level: "view" } as const;

const can = (
  rules: PageAppDbRule[],
  who: { id: string; level: "view" | "interact" | "admin" | "owner" },
  path: string,
) => ({
  read: pageAppDbAllows(rules, who, path, "read"),
  write: pageAppDbAllows(rules, who, path, "write"),
});

describe("path grammar", () => {
  it("accepts alternating collection/document paths and rejects traversal", () => {
    expect(isPageAppDocumentPath("tasks/t1")).toBe(true);
    expect(isPageAppCollectionPath("tasks")).toBe(true);
    expect(isPageAppDocumentPath("tasks")).toBe(false);
    expect(isPageAppCollectionPath("boards/b1/cards")).toBe(true);
    expect(splitPageAppDbPath("a/../b")).toBeNull();
    expect(splitPageAppDbPath("a/b c")).toBeNull();
    expect(splitPageAppDbPath("")).toBeNull();
    expect(splitPageAppDbPath("/tasks//t1/")).toEqual(["tasks", "t1"]);
  });
});

describe("default rules", () => {
  it("lets everyone read shared data and interact+ write it", () => {
    expect(can([], viewer, "tasks/t1")).toEqual({ read: true, write: false });
    expect(can([], member, "tasks/t1")).toEqual({ read: true, write: true });
    expect(can([], owner, "tasks/t1")).toEqual({ read: true, write: true });
  });

  it("keeps each viewer's data/users subtree private, the owner included", () => {
    expect(can([], member, "data/users/m1/notes/n1")).toEqual({ read: true, write: true });
    expect(can([], other, "data/users/m1/notes/n1")).toEqual({ read: false, write: false });
    expect(can([], owner, "data/users/m1/notes/n1")).toEqual({ read: false, write: false });
  });

  it("opens data/users subtrees only through a rule at data/users", () => {
    const rules: PageAppDbRule[] = [{ path: "data/users", read: "admin", write: "owner" }];
    expect(can(rules, editor, "data/users/m1/notes/n1").read).toBe(true);
    expect(can(rules, member, "data/users/m2/notes/n1").read).toBe(false);
    expect(can(rules, member, "data/users/m1/notes/n1")).toEqual({ read: true, write: true });
  });
});

describe("declared rules", () => {
  it("the deepest rule wins and levels inherit", () => {
    const rules: PageAppDbRule[] = [
      { path: "", read: "interact", write: "admin" },
      { path: "public", read: "view" },
    ];
    expect(can(rules, viewer, "notes/n1").read).toBe(false);
    expect(can(rules, viewer, "public/p1").read).toBe(true);
    expect(can(rules, member, "public/p1").write).toBe(false);
    expect(can(rules, editor, "public/p1").write).toBe(true);
  });

  it("locking the root also stops members writing their own subtree", () => {
    const rules: PageAppDbRule[] = [{ path: "", write: "admin" }];
    expect(can(rules, member, "data/users/m1/notes/n1").write).toBe(false);
    const withSelf: PageAppDbRule[] = [...rules, { path: "data/users/{self}", write: "interact" }];
    expect(can(withSelf, member, "data/users/m1/notes/n1").write).toBe(true);
  });

  it("votes: everyone reads, each writes only their own, owner moderates", () => {
    const rules: PageAppDbRule[] = [
      { path: "votes", read: "view", write: "owner" },
      { path: "votes/{self}", write: "interact" },
    ];
    expect(can(rules, member, "votes/m1")).toEqual({ read: true, write: true });
    expect(can(rules, member, "votes/m2")).toEqual({ read: true, write: false });
    expect(can(rules, owner, "votes/m2").write).toBe(true);
    expect(can(rules, viewer, "votes/m1").read).toBe(true);
  });

  it("sign-offs under write: self cannot be changed by anyone else, the owner included", () => {
    const rules: PageAppDbRule[] = [
      { path: "signoffs", read: "view", write: "self" },
      { path: "signoffs/{self}", read: "view", write: "interact" },
    ];
    expect(can(rules, member, "signoffs/m1").write).toBe(true);
    expect(can(rules, owner, "signoffs/m1")).toEqual({ read: true, write: false });
  });

  it("a private notebook is invisible to everyone else", () => {
    const rules: PageAppDbRule[] = [
      { path: "notebook", read: "self", write: "self" },
      { path: "notebook/{self}", read: "interact", write: "interact" },
    ];
    expect(can(rules, member, "notebook/m1/pages/p1")).toEqual({ read: true, write: true });
    expect(can(rules, owner, "notebook/m1/pages/p1")).toEqual({ read: false, write: false });
  });
});

describe("validation", () => {
  it("accepts well-formed rules", () => {
    expect(
      validatePageAppDbRules([
        { path: "", read: "view", write: "interact" },
        { path: "votes", read: "view", write: "owner" },
        { path: "votes/{self}", write: "interact" },
      ]),
    ).toEqual([]);
  });

  it("rejects write below read, misplaced {self}, self off a prefix, half prefix rules, duplicates", () => {
    expect(validatePageAppDbRules([{ path: "a", read: "admin", write: "interact" }])).toHaveLength(
      1,
    );
    expect(validatePageAppDbRules([{ path: "a/{self}/b" }])).toHaveLength(1);
    expect(validatePageAppDbRules([{ path: "a", write: "self" }])).toHaveLength(1);
    expect(
      validatePageAppDbRules([
        { path: "votes", read: "view" },
        { path: "votes/{self}", write: "interact" },
      ]),
    ).toHaveLength(1);
    expect(validatePageAppDbRules([{ path: "a" }, { path: "a/" }])).toHaveLength(1);
    expect(
      validatePageAppDbRules([{ path: "a", read: "self", write: "admin" }]).length,
    ).toBeGreaterThan(0);
  });

  it("parses config leniently, dropping unknown levels", () => {
    expect(
      pageAppDbRulesFromConfig({ rules: [{ path: "x", read: "everyone", write: "admin" }, 3] }),
    ).toEqual([{ path: "x", write: "admin" }]);
    expect(pageAppDbRulesFromConfig(null)).toEqual([]);
  });
});
