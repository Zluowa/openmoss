// FILE: nativeConfirmMessages.ts
// Purpose: Build locale-aware renderer messages that are displayed by native confirmation dialogs.
// Layer: Web UI presentation

import type { MossLocaleCode } from "../appSettings";

function englishPlural(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function automationDeleteConfirmation(
  locale: MossLocaleCode,
  automationName: string,
): string {
  return locale === "zh-CN" ? `删除“${automationName}”？` : `Delete "${automationName}"?`;
}

export function orphanedWorktreeDeleteConfirmation(
  locale: MossLocaleCode,
  worktreePath: string,
): string {
  return locale === "zh-CN"
    ? ["此对话是唯一关联到该工作树的对话：", worktreePath, "", "是否也删除该工作树？"].join("\n")
    : [
        "This thread is the only one linked to this worktree:",
        worktreePath,
        "",
        "Delete the worktree too?",
      ].join("\n");
}

export function threadArchiveConfirmation(locale: MossLocaleCode, threadTitle: string): string {
  return locale === "zh-CN"
    ? [`归档对话“${threadTitle}”？`, "归档的对话会从侧边栏隐藏，但之后仍可恢复。"].join("\n")
    : [
        `Archive thread "${threadTitle}"?`,
        "Archived threads are hidden from the sidebar but can be restored later.",
      ].join("\n");
}

export function threadDeleteConfirmation(locale: MossLocaleCode, threadTitle: string): string {
  return locale === "zh-CN"
    ? [`删除对话“${threadTitle}”？`, "这会永久清除此对话的对话记录。"].join("\n")
    : [
        `Delete thread "${threadTitle}"?`,
        "This permanently clears conversation history for this thread.",
      ].join("\n");
}

export function draftDeleteConfirmation(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "删除此草稿？未发送的提示词也会被移除。"
    : "Delete this draft? This removes its unsent prompt.";
}

export function checkpointRevertConfirmation(locale: MossLocaleCode, turnCount: number): string {
  return locale === "zh-CN"
    ? [
        `将此对话还原到检查点 ${turnCount}？`,
        "这将丢弃此对话中之后的消息和轮次差异。",
        "此操作无法撤销。",
      ].join("\n")
    : [
        `Revert this thread to checkpoint ${turnCount}?`,
        "This will discard newer messages and turn diffs in this thread.",
        "This action cannot be undone.",
      ].join("\n");
}

export function latestFileChangesUndoConfirmation(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? [
        "撤销此卡片中显示的最新文件更改？",
        "更早的文件更改仍可继续撤销。",
        "消息和服务商会话历史将会保留。",
        "此操作无法撤销。",
      ].join("\n")
    : [
        "Undo the latest file changes shown in this card?",
        "Earlier file changes will remain available to undo.",
        "Messages and provider conversation history will be kept.",
        "This action cannot be undone.",
      ].join("\n");
}

export function projectThreadsArchiveConfirmation(
  locale: MossLocaleCode,
  input: {
    readonly count: number;
    readonly projectName: string;
    readonly runningCount: number;
  },
): string {
  if (locale === "zh-CN") {
    const lines = [
      `归档“${input.projectName}”中的 ${input.count} 个对话？`,
      "归档的对话会从侧边栏隐藏，但之后仍可恢复。",
    ];
    if (input.runningCount > 0) {
      lines.push("", `${input.runningCount} 个对话正在运行，将被跳过。`);
    }
    return lines.join("\n");
  }

  const lines = [
    `Archive ${input.count} ${englishPlural(input.count, "thread")} in "${input.projectName}"?`,
    "Archived threads are hidden from the sidebar but can be restored later.",
  ];
  if (input.runningCount > 0) {
    lines.push(
      "",
      `${input.runningCount} running ${englishPlural(input.runningCount, "thread is", "threads are")} currently active and will be skipped.`,
    );
  }
  return lines.join("\n");
}

export function sidebarSectionArchiveConfirmation(
  locale: MossLocaleCode,
  input: {
    readonly count: number;
    readonly sectionName: string;
    readonly runningCount: number;
    readonly externalCount: number;
  },
): string {
  if (locale === "zh-CN") {
    const lines = [
      `归档“${input.sectionName}”中的 ${input.count} 个对话？`,
      "归档的对话会从侧边栏隐藏，但之后仍可恢复。",
    ];
    if (input.runningCount > 0) {
      lines.push("", `${input.runningCount} 个对话正在运行，将被跳过。`);
    }
    if (input.externalCount > 0) {
      lines.push("", `${input.externalCount} 个关联对话位于本分区外，将被跳过。`);
    }
    return lines.join("\n");
  }

  const lines = [
    `Archive ${input.count} ${englishPlural(input.count, "chat")} in "${input.sectionName}"?`,
    "Archived chats are hidden from the sidebar but can be restored later.",
  ];
  if (input.runningCount > 0) {
    lines.push(
      "",
      `${input.runningCount} running ${englishPlural(input.runningCount, "chat", "chats")} will be skipped.`,
    );
  }
  if (input.externalCount > 0) {
    lines.push(
      "",
      `${input.externalCount} linked ${englishPlural(input.externalCount, "chat", "chats")} outside this section will be skipped.`,
    );
  }
  return lines.join("\n");
}

export function projectThreadsDeleteConfirmation(
  locale: MossLocaleCode,
  count: number,
  projectName: string,
): string {
  return locale === "zh-CN"
    ? [`删除“${projectName}”中的 ${count} 个对话？`, "这会永久清除这些对话的对话记录。"].join("\n")
    : [
        `Delete ${count} ${englishPlural(count, "thread")} in "${projectName}"?`,
        "This permanently clears conversation history for these threads.",
      ].join("\n");
}

export function selectedThreadsArchiveConfirmation(locale: MossLocaleCode, count: number): string {
  return locale === "zh-CN"
    ? [`归档 ${count} 个对话？`, "归档的对话会从侧边栏隐藏，但之后仍可恢复。"].join("\n")
    : [
        `Archive ${count} ${englishPlural(count, "thread")}?`,
        "Archived threads are hidden from the sidebar but can be restored later.",
      ].join("\n");
}

export function selectedThreadsDeleteConfirmation(locale: MossLocaleCode, count: number): string {
  return locale === "zh-CN"
    ? [`删除 ${count} 个对话？`, "这会永久清除这些对话的对话记录。"].join("\n")
    : [
        `Delete ${count} ${englishPlural(count, "thread")}?`,
        "This permanently clears conversation history for these threads.",
      ].join("\n");
}

export function projectRemoveConfirmation(
  locale: MossLocaleCode,
  projectName: string,
  threadCount: number,
): string {
  if (locale === "zh-CN") {
    return threadCount > 0
      ? [
          `移除项目“${projectName}”？`,
          `这会删除此文件夹中的 ${threadCount} 个对话并移除项目。`,
        ].join("\n")
      : `移除项目“${projectName}”？`;
  }
  return threadCount > 0
    ? [
        `Remove project "${projectName}"?`,
        `This will delete ${threadCount} ${englishPlural(threadCount, "thread")} in this folder and remove the project.`,
      ].join("\n")
    : `Remove project "${projectName}"?`;
}
