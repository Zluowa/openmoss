import { CHAT_BACKGROUND_CLASS_NAME } from "./composerPickerStyles";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";

export function ChatMountLoader() {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 items-center justify-center text-foreground [contain:layout_style_paint]",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      {/* Inline @keyframes so the delayed fade needs no global stylesheet; the
          delay keeps the common fast mount (a couple of frames) from flashing a
          spinner — short waits show only the plain chat background. */}
      <style>{`@keyframes chat-mount-loader-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div className="opacity-0 [animation:chat-mount-loader-in_200ms_ease-out_150ms_forwards] motion-reduce:animate-none motion-reduce:opacity-100">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    </div>
  );
}
