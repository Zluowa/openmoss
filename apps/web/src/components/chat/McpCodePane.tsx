import type { ComponentProps, ReactNode } from "react";
import { HighlightedCodeText } from "../HighlightedCodeText";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTranslation } from "../../localization";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

// The MCP code snippet shown before highlighting.
// WebMCP/inline structured results have no sticky actions. Raw output does.
export function McpCodePane({
  title,
  children,
  showCopyButton = false,
  asPre = false,
  codeContainerClassName,
  ...props
}: Omit<ComponentProps<"code">, "ref"> & {
  title: string;
  children: ReactNode;
  showCopyButton?: boolean;
  asPre?: boolean;
  codeContainerClassName?: string;
}) {
  const { t } = useTranslation();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const code = typeof children === "string" ? children : null;
  const useSyntaxHighlight = code !== null;
  return (
    <div className="relative w-full min-w-0 overflow-clip contain-inline-size rounded-(--radius-3xl-base) border border-subtle bg-secondary-soft-alpha [corner-shape:superellipse(1.1)]">
      <div className="flex min-h-12 items-center gap-2 py-1.5 ps-4 pe-1.5 font-sans text-ui-lg font-medium text-default select-none md:ps-5">
        <McpCodeIcon />
        <div className="min-w-0 flex-1 truncate">{title}</div>
        <div className="ms-auto flex shrink-0 items-center">
          {showCopyButton && code !== null ? (
            <button
              type="button"
              className="inline-flex size-8 cursor-interaction items-center justify-center rounded-lg text-codex-secondary hover:bg-surface-secondary hover:text-default focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t(isCopied ? "chat.markdown.code.copied" : "chat.markdown.code.copy")}
              data-mcp-copy-code="true"
              onClick={() => copyToClipboard(code, undefined)}
            >
              {isCopied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            </button>
          ) : null}
        </div>
      </div>
      <div
        dir="ltr"
        className={cn(
          "overflow-auto px-4 pt-0 pb-3 text-size-chat outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5",
          codeContainerClassName ?? "max-h-48",
        )}
        style={codeContainerClassName ? undefined : { maxHeight: "12rem" }}
      >
        {(() => {
          const CodeElement = asPre ? "pre" : "code";
          return (
            <CodeElement
              {...props}
              style={
                asPre
                  ? { ...props.style, maxHeight: "32rem", overflowY: "auto" }
                  : codeContainerClassName
                    ? props.style
                    : { ...props.style, maxHeight: "12rem", overflowY: "auto" }
              }
              className={cn(
                "block font-vscode-editor text-size-code leading-[max(1.5em,calc(var(--spacing)*5))]",
                codeContainerClassName ? "whitespace-pre!" : "whitespace-pre-wrap break-words",
                asPre && codeContainerClassName,
                asPre && "overflow-auto",
              )}
              onCopy={(event) => {
                props.onCopy?.(event);
                if (event.defaultPrevented) return;
                const selection = window.getSelection()?.toString();
                if (!selection) return;
                event.preventDefault();
                event.stopPropagation();
                event.clipboardData.setData("text/plain", selection);
              }}
            >
              {useSyntaxHighlight ? (
                <HighlightedCodeText code={code!} language="json" />
              ) : (
                (children ?? code)
              )}
            </CodeElement>
          );
        })()}
      </div>
    </div>
  );
}

// Code mark on a 20px canvas.
function McpCodeIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      className="inline-block shrink-0 align-middle"
    >
      <path
        d="M5.25 6.5 2.5 10l2.75 3.5M14.75 6.5 17.5 10l-2.75 3.5M11.5 6.25l-3 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.33"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
