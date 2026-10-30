import type { RightDockImagePreviewImage } from "~/rightDockStore.logic";

export function conversationImageIdentity(groupId: string, imageId: string): string {
  return `${encodeURIComponent(groupId)}:${encodeURIComponent(imageId)}`;
}

export function mergeConversationImages(
  current: readonly RightDockImagePreviewImage[],
  incoming: readonly RightDockImagePreviewImage[],
): RightDockImagePreviewImage[] {
  const merged = new Map(current.map((image) => [image.id, image]));
  for (const image of incoming) merged.set(image.id, image);
  return [...merged.values()];
}
