import {
  dialog,
  clipboard,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from "electron";
import type { BetaDiagnostics } from "./betaDiagnostics";

/**
 * A parentless message box can open behind the main window and leave the
 * window looking like it loads for ever (2026-11-17). With a visible parent the
 * box is modal on top of it.
 */
function showMessageBox(
  options: MessageBoxOptions,
  parent: BrowserWindow | null,
): Promise<MessageBoxReturnValue> {
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

/** Preserve every recovery choice while letting Beta users copy the queued report ID. */
export async function showDiagnosticStartupDialog(
  options: MessageBoxOptions,
  id: string | null,
  diagnostics: Pick<BetaDiagnostics, "getReportStatus"> | null,
  text: (english: string, chinese: string) => string = (english) => english,
  parent: BrowserWindow | null = null,
): Promise<MessageBoxReturnValue> {
  if (!id || !options.buttons) return showMessageBox(options, parent);
  while (true) {
    const status = diagnostics?.getReportStatus(id);
    const result = await showMessageBox(
      {
        ...options,
        detail: `${options.detail ?? ""}\n\n${text("Diagnostic ID:", "诊断 ID：")} ${id} (${
          status === "sent"
            ? text("report sent", "报告已发送")
            : status === "queued"
              ? text("queued locally", "已在本地排队")
              : text("upload not confirmed", "未确认上传")
        })`,
        buttons: [...options.buttons, text("Copy diagnostic ID", "复制诊断 ID")],
        cancelId: options.cancelId ?? options.buttons.length - 1,
      },
      parent,
    );
    if (result.response !== options.buttons.length) return result;
    // A closed (aborted) box must not reopen just to offer the copy button again.
    if (options.signal?.aborted) return result;
    try {
      clipboard.writeText(id);
    } catch {
      /* Copy failure must not prevent recovery choices. */
    }
  }
}
