import { type BrowserWindow, dialog } from "electron";
import type { NativeMenuLocale } from "./nativeMenuLocalization";

const CONFIRM_BUTTON_INDEX = 1;

export async function showDesktopConfirmDialog(
  message: string,
  ownerWindow: BrowserWindow | null,
  locale: NativeMenuLocale = "en",
): Promise<boolean> {
  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  const options = {
    type: "question" as const,
    buttons: locale === "zh-CN" ? ["否", "是"] : ["No", "Yes"],
    defaultId: CONFIRM_BUTTON_INDEX,
    cancelId: 0,
    noLink: true,
    message: normalizedMessage,
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === CONFIRM_BUTTON_INDEX;
}
