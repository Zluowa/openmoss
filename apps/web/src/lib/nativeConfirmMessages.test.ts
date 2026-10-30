import { describe, expect, it } from "vitest";

import {
  automationDeleteConfirmation,
  checkpointRevertConfirmation,
  draftDeleteConfirmation,
  latestFileChangesUndoConfirmation,
  orphanedWorktreeDeleteConfirmation,
  projectRemoveConfirmation,
  projectThreadsArchiveConfirmation,
  projectThreadsDeleteConfirmation,
  sidebarSectionArchiveConfirmation,
  selectedThreadsArchiveConfirmation,
  selectedThreadsDeleteConfirmation,
  threadArchiveConfirmation,
  threadDeleteConfirmation,
} from "./nativeConfirmMessages";

describe("native confirmation messages", () => {
  it("preserves the existing English wording", () => {
    expect(automationDeleteConfirmation("en", "Nightly sync")).toBe('Delete "Nightly sync"?');
    expect(orphanedWorktreeDeleteConfirmation("en", "/tmp/feature tree")).toBe(
      [
        "This thread is the only one linked to this worktree:",
        "/tmp/feature tree",
        "",
        "Delete the worktree too?",
      ].join("\n"),
    );
    expect(threadArchiveConfirmation("en", "Release")).toBe(
      [
        'Archive thread "Release"?',
        "Archived threads are hidden from the sidebar but can be restored later.",
      ].join("\n"),
    );
    expect(threadDeleteConfirmation("en", "Release")).toBe(
      [
        'Delete thread "Release"?',
        "This permanently clears conversation history for this thread.",
      ].join("\n"),
    );
    expect(draftDeleteConfirmation("en")).toBe(
      "Delete this draft? This removes its unsent prompt.",
    );
    expect(checkpointRevertConfirmation("en", 7)).toBe(
      [
        "Revert this thread to checkpoint 7?",
        "This will discard newer messages and turn diffs in this thread.",
        "This action cannot be undone.",
      ].join("\n"),
    );
    expect(latestFileChangesUndoConfirmation("en")).toBe(
      [
        "Undo the latest file changes shown in this card?",
        "Earlier file changes will remain available to undo.",
        "Messages and provider conversation history will be kept.",
        "This action cannot be undone.",
      ].join("\n"),
    );
  });

  it("preserves English singular and plural behavior", () => {
    expect(
      projectThreadsArchiveConfirmation("en", { count: 1, projectName: "Moss", runningCount: 1 }),
    ).toBe(
      [
        'Archive 1 thread in "Moss"?',
        "Archived threads are hidden from the sidebar but can be restored later.",
        "",
        "1 running thread is currently active and will be skipped.",
      ].join("\n"),
    );
    expect(
      projectThreadsArchiveConfirmation("en", { count: 2, projectName: "Moss", runningCount: 3 }),
    ).toBe(
      [
        'Archive 2 threads in "Moss"?',
        "Archived threads are hidden from the sidebar but can be restored later.",
        "",
        "3 running threads are currently active and will be skipped.",
      ].join("\n"),
    );
    expect(
      sidebarSectionArchiveConfirmation("en", {
        count: 2,
        sectionName: "Research",
        runningCount: 1,
        externalCount: 1,
      }),
    ).toBe(
      [
        'Archive 2 chats in "Research"?',
        "Archived chats are hidden from the sidebar but can be restored later.",
        "",
        "1 running chat will be skipped.",
        "",
        "1 linked chat outside this section will be skipped.",
      ].join("\n"),
    );
    expect(projectThreadsDeleteConfirmation("en", 1, "Moss")).toBe(
      [
        'Delete 1 thread in "Moss"?',
        "This permanently clears conversation history for these threads.",
      ].join("\n"),
    );
    expect(selectedThreadsArchiveConfirmation("en", 2)).toContain("Archive 2 threads?");
    expect(selectedThreadsDeleteConfirmation("en", 1)).toContain("Delete 1 thread?");
    expect(projectRemoveConfirmation("en", "Moss", 2)).toBe(
      [
        'Remove project "Moss"?',
        "This will delete 2 threads in this folder and remove the project.",
      ].join("\n"),
    );
  });

  it("builds complete Chinese messages while preserving dynamic values", () => {
    expect(automationDeleteConfirmation("zh-CN", "Nightly / 同步")).toBe("删除“Nightly / 同步”？");
    expect(orphanedWorktreeDeleteConfirmation("zh-CN", "/用户/Moss/feature-a")).toContain(
      "/用户/Moss/feature-a",
    );
    expect(threadArchiveConfirmation("zh-CN", "Release/v2")).toContain("Release/v2");
    expect(threadDeleteConfirmation("zh-CN", "Release/v2")).toContain("Release/v2");
    expect(checkpointRevertConfirmation("zh-CN", 17)).toContain("17");
    expect(
      projectThreadsArchiveConfirmation("zh-CN", {
        count: 2,
        projectName: "Moss Core",
        runningCount: 1,
      }),
    ).toBe(
      [
        "归档“Moss Core”中的 2 个对话？",
        "归档的对话会从侧边栏隐藏，但之后仍可恢复。",
        "",
        "1 个对话正在运行，将被跳过。",
      ].join("\n"),
    );
    expect(
      sidebarSectionArchiveConfirmation("zh-CN", {
        count: 2,
        sectionName: "Research",
        runningCount: 1,
        externalCount: 2,
      }),
    ).toBe(
      [
        "归档“Research”中的 2 个对话？",
        "归档的对话会从侧边栏隐藏，但之后仍可恢复。",
        "",
        "1 个对话正在运行，将被跳过。",
        "",
        "2 个关联对话位于本分区外，将被跳过。",
      ].join("\n"),
    );
    expect(projectThreadsDeleteConfirmation("zh-CN", 3, "Moss Core")).toContain("Moss Core");
    expect(selectedThreadsArchiveConfirmation("zh-CN", 4)).toContain("4");
    expect(selectedThreadsDeleteConfirmation("zh-CN", 5)).toContain("5");
    expect(projectRemoveConfirmation("zh-CN", "Moss Core", 6)).toContain("Moss Core");
  });
});
