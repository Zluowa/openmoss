import { dialog, clipboard, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import type { BetaDiagnostics } from "./betaDiagnostics";

/** Preserve every recovery choice while letting Beta users copy the queued report ID. */
export async function showDiagnosticStartupDialog(
  options: MessageBoxOptions,
  id: string | null,
  diagnostics: Pick<BetaDiagnostics, "getReportStatus"> | null,
  text: (english: string, chinese: string) => string = (english) => english,
): Promise<MessageBoxReturnValue> {
  if (!id || !options.buttons) return dialog.showMessageBox(options);
  while (true) {
    const status = diagnostics?.getReportStatus(id);
    const result = await dialog.showMessageBox({
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
    });
    if (result.response !== options.buttons.length) return result;
    try {
      clipboard.writeText(id);
    } catch {
      /* Copy failure must not prevent recovery choices. */
    }
  }
}
