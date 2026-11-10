import { describe, expect, it } from "vitest";

import { ThreadId } from "@moss/contracts";

import {
  coordinatorWelcomeMessageId,
  coordinatorWelcomeText,
  isGroupCoordinatorHostProject,
} from "./groupCoordinatorHost.ts";

describe("isGroupCoordinatorHostProject", () => {
  const roots = {
    groupsWorkspaceRoot: "/Users/tester/Documents/Moss/Groups",
    studioWorkspaceRoot: "/Users/tester/Documents/Moss/Studio",
  };

  it("accepts a hub under the Hubs root", () => {
    expect(
      isGroupCoordinatorHostProject({
        kind: "group",
        workspaceRoot: "/Users/tester/Documents/Moss/Groups/alpha",
        ...roots,
      }),
    ).toBe(true);
  });

  it("accepts a legacy studio container under the Studio root", () => {
    expect(
      isGroupCoordinatorHostProject({
        kind: "studio",
        workspaceRoot: "/Users/tester/Documents/Moss/Studio",
        ...roots,
      }),
    ).toBe(true);
  });

  it("rejects an ordinary project", () => {
    expect(
      isGroupCoordinatorHostProject({
        kind: "project",
        workspaceRoot: "/Users/tester/Developer/app",
        ...roots,
      }),
    ).toBe(false);
  });

  it("rejects a hub row outside the Hubs root", () => {
    expect(
      isGroupCoordinatorHostProject({
        kind: "group",
        workspaceRoot: "/tmp/not-groups/alpha",
        ...roots,
      }),
    ).toBe(false);
  });
});

describe("coordinator welcome copy", () => {
  it("keeps the English greeting exactly as it was", () => {
    expect(coordinatorWelcomeText("Dilip")).toBe(
      "Hi Dilip, welcome to your new hub. I coordinate the work here: ask for whatever you need, and I'll either answer you directly or start threads to work on things in parallel.\n\nThreads do the work on their own. The Hub panel on the right shows which ones are working, which are done, and which need you. I'll keep an eye on what's running and post updates when something finishes or needs you. You can also ask me to change my instructions, add repositories, or send you scheduled updates.",
    );
    expect(coordinatorWelcomeText("Dilip", "en")).toBe(coordinatorWelcomeText("Dilip"));
  });

  it("says Hi there when there is no name", () => {
    expect(coordinatorWelcomeText(undefined)).toContain("Hi there, welcome to your new hub.");
  });

  it("writes the greeting in Simplified Chinese for zh-CN", () => {
    const greeting = coordinatorWelcomeText("Dilip", "zh-CN");
    expect(greeting.startsWith("你好，Dilip！欢迎来到你的新 Hub。")).toBe(true);
    expect(greeting).toContain("Hub 面板");
    // Moss's own terms stay Latin; every other Latin word would be leftover English.
    expect(greeting.match(/[A-Za-z]+/g)).toEqual(["Dilip", "Hub", "Hub"]);
    expect(greeting.split("\n\n")).toHaveLength(2);
  });

  it("greets without a name in zh-CN instead of borrowing the English one", () => {
    const greeting = coordinatorWelcomeText(undefined, "zh-CN");
    expect(greeting.startsWith("你好！欢迎来到你的新 Hub。")).toBe(true);
    expect(greeting).not.toContain("there");
  });

  it("derives a stable welcome message id from the coordinator thread", () => {
    const threadId = ThreadId.makeUnsafe("11111111-1111-4111-8111-111111111111");
    expect(coordinatorWelcomeMessageId(threadId)).toBe(coordinatorWelcomeMessageId(threadId));
    expect(coordinatorWelcomeMessageId(threadId)).not.toBe(
      coordinatorWelcomeMessageId(ThreadId.makeUnsafe("22222222-2222-4222-8222-222222222222")),
    );
  });
});
