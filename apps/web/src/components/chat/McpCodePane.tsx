import type { ComponentProps, ReactNode } from "react";
import { HighlightedCodeText } from "../HighlightedCodeText";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTranslation } from "../../localization";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

// app-initial Dra/Ara/jra, the MCP CodeSnippet path before highlighting.
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

// Observed wsi/Dei code-light-20, unchanged path data and 20px canvas.
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
        d="M4.46951 6.27289C4.68734 5.97727 5.10354 5.91356 5.3992 6.13129C5.69464 6.34921 5.75762 6.76637 5.53982 7.06195L3.32791 10.0639L5.5369 13.0131C5.75668 13.3071 5.69695 13.7237 5.40311 13.9438C5.10923 14.1637 4.69261 14.1037 4.47244 13.81L2.04178 10.5639C1.82214 10.2704 1.8206 9.86789 2.03787 9.57269L4.46951 6.27289Z"
        fill="currentColor"
      />{" "}
      <path
        d="M14.6053 6.13129C14.9009 5.9136 15.3171 5.97728 15.5349 6.27289L17.9666 9.57269C18.1837 9.86787 18.1823 10.2705 17.9627 10.5639L15.532 13.81C15.312 14.1038 14.8953 14.1635 14.6013 13.9438C14.3074 13.7237 14.2476 13.3071 14.4676 13.0131L16.6765 10.0639L14.4646 7.06195C14.2468 6.76628 14.3096 6.34915 14.6053 6.13129Z"
        fill="currentColor"
      />{" "}
      <path
        d="M11.0584 6.37347C11.2205 6.04395 11.6194 5.90772 11.949 6.06976C12.2782 6.23191 12.4135 6.63003 12.2517 6.95941L8.94119 13.6928C8.77923 14.0222 8.381 14.1581 8.05154 13.9965C7.72196 13.8345 7.58577 13.4355 7.74783 13.1059L11.0584 6.37347Z"
        fill="currentColor"
      />
    </svg>
  );
}
