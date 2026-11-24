import { useRef, type RefObject } from "react";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTranslation } from "../../localization";
import { anchoredToastManager } from "../ui/toast";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";

// How long the check mark and the 「已复制」 tooltip stay after a copy.
const COPIED_MS = 1000;

function showCopyFailedToast(ref: RefObject<HTMLButtonElement | null>, title: string): void {
  if (!ref.current) return;

  anchoredToastManager.add({
    data: {
      tooltipStyle: true,
    },
    positionerProps: {
      anchor: ref.current,
    },
    timeout: COPIED_MS,
    title,
  });
}

/**
 * Copies a message. The confirmation is the button's own: a check mark, and its shared
 * tooltip reads 「已复制」 (like a code block's copy), so nothing floats over the transcript
 * (walk N6-2: an English 「Copied!」 bubble covered the edited-files card).
 */
export function MessageCopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: () => showCopyFailedToast(ref, t("chat.message.copyFailed")),
    timeout: COPIED_MS,
  });

  return (
    <MessageActionButton
      ref={ref}
      label="Copy message"
      tooltip={isCopied ? t("chat.markdown.code.copied") : "Copy to clipboard"}
      tooltipCloseOnClick={false}
      className={className}
      onClick={() => copyToClipboard(text)}
    >
      {isCopied ? (
        <CheckIcon className={`${MESSAGE_ACTION_ICON_CLASS_NAME} text-success`} />
      ) : (
        <CopyIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      )}
    </MessageActionButton>
  );
}
