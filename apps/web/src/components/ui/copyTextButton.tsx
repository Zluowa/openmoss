import { CheckIcon, CopyIcon } from "~/lib/icons";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "./button";

/** Shared by toast copy actions and inline diagnostic reports. */
export function CopyTextButton({
  text,
  label,
  className,
  copyLabel,
  copiedLabel,
  copiedText,
}: {
  text: string;
  label: string;
  className?: string;
  /** Translated name and text before copying; defaults to "Copy {label}". */
  copyLabel?: string;
  /** Translated name after copying; defaults to "Copied {label}". */
  copiedLabel?: string;
  /** Translated visible text after copying; defaults to "Copied". */
  copiedText?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const idleText = copyLabel ?? `Copy ${label}`;
  const title = isCopied ? (copiedLabel ?? `Copied ${label}`) : idleText;
  return (
    <Button
      aria-label={title}
      title={title}
      className={className}
      size="xs"
      variant="ghost"
      onClick={() => copyToClipboard(text, undefined)}
    >
      {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      <span>{isCopied ? (copiedText ?? "Copied") : idleText}</span>
    </Button>
  );
}
