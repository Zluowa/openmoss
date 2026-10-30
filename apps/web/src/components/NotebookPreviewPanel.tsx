import { ChevronRightIcon, MessageCircleIcon, PlayIcon, RotateCcwIcon } from "~/lib/icons";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import {
  notebookCellTitle,
  notebookCodeFence,
  notebookHtmlDocument,
  parseNotebook,
  type NotebookCell,
  type NotebookOutput,
} from "~/lib/preview/notebook";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";

export interface NotebookAnnotation {
  cellIndex: number;
  selectedText: string;
  body?: string;
}

export interface NotebookPreviewPanelProps {
  filePath: string;
  contents: string;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: ((error?: Error) => void) | undefined;
  onAnnotate?: ((annotation: NotebookAnnotation) => void) | undefined;
}

function Markdown({ text }: { text: string }) {
  return <ChatMarkdown cwd={undefined} text={text} className="text-ui-lg" />;
}

function RawText({ children }: { children: string }) {
  return (
    <pre className="overflow-auto rounded-md bg-muted/30 p-3 font-mono text-ui-sm whitespace-pre-wrap text-foreground">
      {children}
    </pre>
  );
}

function Disclosure({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger className="flex items-center gap-2 rounded-md py-1 text-ui-sm font-medium text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className={disclosureChevronClassName(open)} />
        {label}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-2">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function TextOutput({
  output,
}: {
  output: Extract<NotebookOutput, { type: "text" | "stream" | "json" }>;
}) {
  if (output.summaryMarkdown !== null) {
    return (
      <div className="rounded-md bg-muted/20 p-3">
        <Markdown text={output.summaryMarkdown} />
        <Disclosure label="Raw output" className="mt-2">
          <RawText>{output.text}</RawText>
        </Disclosure>
      </div>
    );
  }
  return output.type === "json" ? (
    <Markdown text={notebookCodeFence(output.text, "json")} />
  ) : (
    <RawText>{output.text}</RawText>
  );
}

function CellOutput({ output }: { output: NotebookOutput }) {
  switch (output.type) {
    case "image":
      return (
        <div className="overflow-auto rounded-md bg-background/40 p-2">
          <img
            alt={`Notebook output ${output.outputNumber}`}
            className="max-h-160 max-w-full"
            src={output.dataUrl}
            loading="lazy"
          />
        </div>
      );
    case "html":
      return (
        <div>
          <iframe
            className="h-72 w-full rounded-md border-0 bg-background"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={notebookHtmlDocument(output.html)}
            title="Notebook HTML output"
          />
          <Disclosure label="Raw output" className="mt-2">
            <RawText>{output.html}</RawText>
          </Disclosure>
        </div>
      );
    case "markdown":
      return (
        <div className="rounded-md bg-background/40 px-3 py-2">
          <Markdown text={output.markdown} />
        </div>
      );
    case "error": {
      const title = output.message ? `${output.name}: ${output.message}` : output.name;
      const raw =
        `${output.name}: ${output.message}`.trim() +
        (output.traceback.trim() ? `\n${output.traceback}` : "");
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          {output.summaryMarkdown !== null ? (
            <Markdown text={output.summaryMarkdown} />
          ) : (
            <div className="text-ui-lg font-medium text-destructive">{title}</div>
          )}
          <Disclosure label="Raw output" className="mt-2">
            <RawText>{raw}</RawText>
          </Disclosure>
        </div>
      );
    }
    case "text":
    case "stream":
    case "json":
      return <TextOutput output={output} />;
  }
}

function EmptyCell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border px-3 py-2 text-ui-lg text-muted-foreground">
      {children}
    </div>
  );
}

function CellContents({ cell }: { cell: NotebookCell }) {
  if (cell.cellType === "markdown") {
    return (
      <div className="px-4 py-3">
        {cell.source.trim() ? (
          <Markdown text={cell.source} />
        ) : (
          <EmptyCell>Empty Markdown cell</EmptyCell>
        )}
      </div>
    );
  }
  if (cell.cellType === "raw") {
    return (
      <div className="px-4 py-3">
        {cell.source.trim() ? (
          <Markdown text={notebookCodeFence(cell.source, "text")} />
        ) : (
          <EmptyCell>Empty raw cell</EmptyCell>
        )}
      </div>
    );
  }
  const description = cell.descriptionMarkdown?.trim();
  const code = cell.source.trim() ? (
    <Markdown text={notebookCodeFence(cell.source, "python")} />
  ) : (
    <EmptyCell>Empty code cell</EmptyCell>
  );
  return (
    <>
      <div className="px-4 py-3">
        {description ? (
          <>
            <Markdown text={description} />
            {cell.source.trim() ? (
              <Disclosure label="Code" className="mt-3 border-t border-border pt-2">
                {code}
              </Disclosure>
            ) : (
              code
            )}
          </>
        ) : (
          code
        )}
      </div>
      {cell.outputs.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
          {cell.outputs.map((output, index) => (
            <CellOutput key={index} output={output} />
          ))}
        </div>
      )}
    </>
  );
}

function Cell({
  cell,
  index,
  total,
  onAnnotate,
}: {
  cell: NotebookCell;
  index: number;
  total: number;
  onAnnotate: NotebookPreviewPanelProps["onAnnotate"];
}) {
  const [open, setOpen] = useState(true);
  const [selectedText, setSelectedText] = useState("");
  const element = useRef<HTMLDivElement>(null);
  const title = notebookCellTitle(cell, index);
  const captureSelection = () => {
    const selection = window.getSelection();
    const inside =
      selection?.anchorNode &&
      selection.focusNode &&
      element.current?.contains(selection.anchorNode) &&
      element.current.contains(selection.focusNode);
    setSelectedText(inside ? selection.toString().trim() : "");
  };
  return (
    <div
      ref={element}
      data-notebook-cell={index}
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
    >
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="group/notebook-cell overflow-hidden rounded-lg border border-border bg-background"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 items-center justify-between gap-3 text-start"
            aria-label={`${title}, cell ${index + 1} of ${total}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ChevronRightIcon className={disclosureChevronClassName(open)} />
              <span className="min-w-0 truncate text-ui-lg font-medium" title={title}>
                {title}
              </span>
              <span className="shrink-0 text-ui-sm text-muted-foreground">
                Cell {index + 1} of {total}
              </span>
            </span>
            {cell.cellType === "code" && (
              <span className="flex shrink-0 items-center gap-2 text-ui-sm font-medium text-muted-foreground">
                {cell.executionCount !== null && (
                  <span className="tabular-nums">Run {cell.executionCount}</span>
                )}
                <PlayIcon
                  className="size-3 opacity-0 group-hover/notebook-cell:opacity-60 group-focus-within/notebook-cell:opacity-60"
                  aria-hidden="true"
                />
              </span>
            )}
          </CollapsibleTrigger>
          {onAnnotate && selectedText && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Comment on cell ${index + 1}`}
              title="Comment on selection"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onAnnotate({ cellIndex: index, selectedText })}
            >
              <MessageCircleIcon className="size-3" />
            </Button>
          )}
        </div>
        <CollapsiblePanel>
          <CellContents cell={cell} />
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

export function NotebookPreviewPanel({
  filePath,
  contents,
  onPreviewReady,
  onPreviewError,
  onAnnotate,
}: NotebookPreviewPanelProps) {
  const result = useMemo(() => {
    try {
      return { document: parseNotebook(contents), error: null };
    } catch (cause) {
      return { document: null, error: cause instanceof Error ? cause : new Error(String(cause)) };
    }
  }, [contents]);
  useEffect(() => {
    if (result.error) onPreviewError?.(result.error);
    else onPreviewReady?.();
  }, [result, onPreviewReady, onPreviewError]);
  const notebook = result.document;
  const title =
    notebook?.title ??
    filePath
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.ipynb$/iu, "") ??
    filePath;
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-muted/20"
      data-notebook-preview={filePath}
      aria-label="Notebook preview"
    >
      <header className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-ui-lg font-medium" title={title}>
            {title}
          </span>
          <span className="shrink-0 text-ui-sm text-muted-foreground">
            IPYNB
            {notebook
              ? ` · ${notebook.cells.length} ${notebook.cells.length === 1 ? "cell" : "cells"}`
              : ""}
          </span>
        </div>
        {notebook && (
          <div className="flex shrink-0 items-center gap-1">
            <span className="inline-flex h-7 items-center rounded-full border border-border px-2 text-ui-sm font-medium text-muted-foreground">
              Read only
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled
              aria-disabled="true"
              aria-label="Run all"
              title="Running is not available in this preview"
            >
              <PlayIcon className="size-3" />
              <span className="hidden md:inline">Run all</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled
              aria-disabled="true"
              aria-label="Restart kernel"
              title="Kernels are not connected in this preview"
            >
              <RotateCcwIcon className="size-3" />
              <span className="hidden lg:inline">Restart kernel</span>
            </Button>
          </div>
        )}
      </header>
      {result.error ? (
        <div
          role="alert"
          className="flex min-h-0 flex-1 items-center justify-center p-6 text-ui-lg text-muted-foreground"
        >
          Unable to preview this notebook. {result.error.message}
        </div>
      ) : notebook?.cells.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-ui-lg text-muted-foreground">
          This notebook does not contain any cells
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6 sm:py-5">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {notebook?.cells.map((cell, index) => (
              <Cell
                key={`${filePath}:${cell.id ?? index}`}
                cell={cell}
                index={index}
                total={notebook.cells.length}
                onAnnotate={onAnnotate}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
