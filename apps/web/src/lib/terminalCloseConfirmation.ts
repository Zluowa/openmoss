// FILE: terminalCloseConfirmation.ts
// Purpose: Shares terminal-tab close confirmation copy and dialog plumbing across chat and workspace surfaces.
// Layer: UI logic helper
// Depends on: Native dialog contract from the app shell.

import type { NativeApi } from "@synara/contracts";

import type { MossLocaleCode } from "~/appSettings";

function formatTerminalCloseSubject(
  terminalTitle: string | null | undefined,
  locale: MossLocaleCode = "en",
): string {
  const trimmedTitle = terminalTitle?.trim();
  if (locale === "zh-CN") {
    return trimmedTitle && trimmedTitle.length > 0 ? `终端“${trimmedTitle}”` : "此终端";
  }
  return trimmedTitle && trimmedTitle.length > 0 ? `terminal "${trimmedTitle}"` : "this terminal";
}

// Prefer title overrides, then persisted labels, so confirmation copy matches visible tab names.
export function resolveTerminalCloseTitle(options: {
  terminalId: string;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): string {
  return (
    options.terminalTitleOverridesById[options.terminalId]?.trim() ||
    options.terminalLabelsById[options.terminalId]?.trim() ||
    "Terminal"
  );
}

function buildTerminalCloseConfirmationMessage(options: {
  terminalTitle: string | null | undefined;
  willDeleteThread: boolean;
  locale?: MossLocaleCode;
}): string {
  if (options.locale === "zh-CN") {
    return [
      `关闭${formatTerminalCloseSubject(options.terminalTitle, options.locale)}？`,
      options.willDeleteThread
        ? "这会永久清除此标签页的终端历史记录，并删除空白终端对话。"
        : "这会永久清除此标签页的终端历史记录。",
    ].join("\n");
  }

  return [
    `Close ${formatTerminalCloseSubject(options.terminalTitle, options.locale)}?`,
    options.willDeleteThread
      ? "This permanently clears the terminal history for this tab and deletes the empty terminal thread."
      : "This permanently clears the terminal history for this tab.",
  ].join("\n");
}

export function shouldPromptForTerminalClose(options: {
  confirmationEnabled: boolean;
  runningTerminalIds: readonly string[];
  terminalAttentionStatesById: Record<string, unknown>;
  terminalId: string;
}): boolean {
  if (!options.confirmationEnabled) {
    return false;
  }
  return (
    options.runningTerminalIds.includes(options.terminalId) ||
    options.terminalAttentionStatesById[options.terminalId] !== undefined
  );
}

export async function confirmTerminalTabClose(options: {
  api: Pick<NativeApi, "dialogs"> | null | undefined;
  enabled: boolean;
  terminalTitle: string | null | undefined;
  willDeleteThread?: boolean;
  locale: MossLocaleCode;
}): Promise<boolean> {
  if (!options.enabled || !options.api) {
    return true;
  }

  return options.api.dialogs.confirm(
    buildTerminalCloseConfirmationMessage({
      terminalTitle: options.terminalTitle,
      willDeleteThread: options.willDeleteThread ?? false,
      locale: options.locale ?? "en",
    }),
  );
}
