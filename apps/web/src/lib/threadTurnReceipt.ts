import type { MessageId, NativeApi, ThreadId } from "@moss/contracts";

/** A lost reply is not a rejected turn. Verify the exact message before
 * returning its draft or releasing attachments that the server now owns. */
export async function wasThreadMessageAccepted(
  api: Pick<NativeApi["orchestration"], "getThreadDetailSnapshot">,
  threadId: ThreadId,
  messageId: MessageId,
): Promise<boolean> {
  try {
    const snapshot = await api.getThreadDetailSnapshot({ threadId });
    return snapshot?.thread?.messages.some((message) => message.id === messageId) ?? false;
  } catch {
    return false;
  }
}
