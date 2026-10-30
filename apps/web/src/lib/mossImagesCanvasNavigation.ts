import type { MossCanvasImageFocus } from "./mossCanvasBridge";

/** Reopen an existing conversation; never promote a draft or dispatch a turn. */
export async function openMossImagesOriginCanvas(input: {
  readonly threadId: string;
  readonly image: MossCanvasImageFocus;
  readonly isCurrent: () => boolean;
  readonly beforeLeave: () => Promise<boolean>;
  readonly flushCurrent: () => Promise<boolean>;
  readonly beginNavigation?: () => void;
  readonly navigate: (threadId: string) => Promise<boolean>;
  readonly openChat: (threadId: string) => void;
  readonly openCanvas: (threadId: string, image: MossCanvasImageFocus) => void;
  readonly onOpened: () => void;
}): Promise<void> {
  if (!input.isCurrent() || !(await input.beforeLeave()) || !input.isCurrent()) return;
  if (!(await input.flushCurrent()) || !input.isCurrent()) return;
  input.beginNavigation?.();
  if (!(await input.navigate(input.threadId)) || !input.isCurrent()) return;
  input.openChat(input.threadId);
  input.openCanvas(input.threadId, input.image);
  input.onOpened();
}
