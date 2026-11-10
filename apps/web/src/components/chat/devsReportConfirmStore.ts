// FILE: devsReportConfirmStore.ts
// Purpose: Holds the developer report waiting for the user's confirmation, so the send path
//          can await the answer and the dialog mounted in the chat can show it.
// Layer: Web UI state

import type { DevsReportPreview } from "@moss/contracts";
import { create } from "zustand";
import type { PreparedDevsAttachments } from "./devsReportAttachments";

/** What the app itself knows about the attachments: image thumbnails and what stays behind. */
export interface DevsReportLocalAttachments {
  readonly imagePreviews: PreparedDevsAttachments["imagePreviews"];
  readonly skipped: PreparedDevsAttachments["skipped"];
}
interface PendingConfirmation {
  readonly preview: DevsReportPreview;
  readonly local: DevsReportLocalAttachments;
  readonly resolve: (confirmed: boolean) => void;
}

export const useDevsReportConfirmStore = create<{ pending: PendingConfirmation | null }>(() => ({
  pending: null,
}));

/** Shows the exact report and resolves with the user's answer. A newer request cancels this one. */
export function requestDevsReportConfirmation(
  preview: DevsReportPreview,
  local: DevsReportLocalAttachments = { imagePreviews: [], skipped: [] },
): Promise<boolean> {
  return new Promise((resolve) => {
    useDevsReportConfirmStore.getState().pending?.resolve(false);
    useDevsReportConfirmStore.setState({ pending: { preview, local, resolve } });
  });
}

export function settleDevsReportConfirmation(confirmed: boolean) {
  const pending = useDevsReportConfirmStore.getState().pending;
  useDevsReportConfirmStore.setState({ pending: null });
  pending?.resolve(confirmed);
}
