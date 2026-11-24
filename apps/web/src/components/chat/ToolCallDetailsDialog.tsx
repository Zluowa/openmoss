// FILE: ToolCallDetailsDialog.tsx
// Purpose: Inline details content for command and file-change transcript rows: what the tool
//          touched and returned, quietly, on the shared card, list row and badge parts. No section
//          labels: a file list, a diff, an edit and an output read as what they are.
// Layer: Chat presentation component
// Exports: ToolCallDetailsContent
// Depends on: WorkLogEntry.toolDetails

import { createMarkdownCodeFence } from "~/lib/toolCallDetailsFormatting";
import { FileIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import type { TimestampFormat } from "../../appSettings";
import {
  pathInside,
  splitToolDiffByFile,
  type ToolDiffFile,
  type WorkLogToolDetails,
  type WorkLogToolOutputDetails,
} from "../../lib/toolCallDetails";
import type { WorkLogLiveActivity, WorkLogMcpToolResult } from "../../workLog";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { ListRow } from "../ui/list-row";
import { CommandShellDetails } from "./CommandShellDetails";
import { McpToolResultDetails } from "./McpToolResultDetails";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

/** The code type role (13/19), scrolling inside its card when long. */
const DETAIL_CODE_CLASS_NAME =
  "max-h-[min(46vh,30rem)] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-chat-code text-chat-code";
/** Diff line tints from the theme's own added and removed colours (8% under same-colour text). */
const ADDED_LINE_CLASS_NAME =
  "bg-[color-mix(in_srgb,var(--color-decoration-added,var(--success))_8%,transparent)] text-[var(--color-decoration-added,var(--success))]";
const REMOVED_LINE_CLASS_NAME =
  "bg-[color-mix(in_srgb,var(--color-decoration-deleted,var(--destructive))_8%,transparent)] text-[var(--color-decoration-deleted,var(--destructive))]";

export function ToolCallDetailsContent({
  details,
  mcpToolResult,
  activity,
  variant = "default",
  onImageExpand,
  cwd,
}: {
  details: WorkLogToolDetails | undefined;
  mcpToolResult?: WorkLogMcpToolResult | undefined;
  activity?: WorkLogLiveActivity | undefined;
  /** Kept for callers; the row above already shows when the call ran. */
  timestampFormat?: TimestampFormat;
  variant?: "default" | "embedded";
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
  /** The project folder: agents report absolute paths, files are named inside it. */
  cwd?: string | undefined;
}) {
  if (mcpToolResult) {
    return (
      <McpToolResultDetails result={mcpToolResult} {...(onImageExpand ? { onImageExpand } : {})} />
    );
  }
  // Nothing came back but the row itself: the disclosure shows nothing more.
  if (!details && !activity?.detail) return null;
  const diffFiles = details?.diff ? splitToolDiffByFile(details.diff) : [];
  // A file the diff below names is not listed again above it.
  const namedInDiff = new Set(
    diffFiles.flatMap((file) => (file.path ? [samePathKey(pathInside(file.path, cwd))] : [])),
  );
  const listedFiles = details?.files?.filter(
    (file) => !namedInDiff.has(samePathKey(pathInside(file, cwd))),
  );

  return (
    <div className="flex min-w-0 flex-col gap-ui-gap-xs" data-tool-call-details="true">
      {activity?.detail && !details?.command ? (
        // State, start and elapsed time are on the row; only what it is doing is added here.
        <p className="text-ui-sm break-words text-muted-foreground" data-tool-activity-detail="">
          {activity.detail}
        </p>
      ) : null}

      {details?.command ? (
        <CommandShellDetails
          command={details.command}
          cwd={details.cwd}
          output={details.output}
          activity={activity}
          variant={variant}
        />
      ) : null}

      {listedFiles?.length ? (
        <Card className="divide-y divide-[color:var(--color-border)]" data-tool-files="">
          {listedFiles.map((file) => (
            <ListRow
              key={file}
              className="rounded-none"
              leading={<FileIcon aria-hidden className="size-ui-icon-sm text-muted-foreground" />}
              // A path is read in full: it wraps instead of losing its end (the file name).
              title={
                <span className="whitespace-normal break-all" data-translation-skip="true">
                  {pathInside(file, cwd)}
                </span>
              }
            />
          ))}
        </Card>
      ) : null}

      {diffFiles.length > 0 ? <DiffCodeBlock files={diffFiles} cwd={cwd} /> : null}

      {details?.edits?.map((edit, index) => (
        <Card key={`${edit.path ?? "edit"}:${index}`} data-tool-edit="">
          {edit.path ? <ToolFilePathHeader path={pathInside(edit.path, cwd)} /> : null}
          {edit.oldText !== undefined ? (
            <pre className={cn(DETAIL_CODE_CLASS_NAME, REMOVED_LINE_CLASS_NAME)}>
              {edit.oldText}
            </pre>
          ) : null}
          {edit.newText !== undefined ? (
            <pre className={cn(DETAIL_CODE_CLASS_NAME, ADDED_LINE_CLASS_NAME)}>{edit.newText}</pre>
          ) : null}
        </Card>
      ))}

      {details?.content ? (
        <MarkdownToolCodeBlock language="text">{details.content}</MarkdownToolCodeBlock>
      ) : null}

      {details?.output && !details.command ? <ToolOutput output={details.output} /> : null}
    </div>
  );
}

function MarkdownToolCodeBlock(props: { language: string; children: string }) {
  return (
    <ChatMarkdown
      text={createMarkdownCodeFence(props.language, props.children)}
      cwd={undefined}
      className="text-ui"
    />
  );
}

function ToolOutput({ output }: { output: WorkLogToolOutputDetails }) {
  const { t, format } = useTranslation();
  const failed = output.exitCode !== undefined && output.exitCode !== 0;
  return (
    <>
      {output.output ? (
        <MarkdownToolCodeBlock language="text">{output.output}</MarkdownToolCodeBlock>
      ) : null}
      {output.stdout || output.stderr ? (
        <Card data-tool-output="">
          {output.stdout ? (
            <pre className={cn(DETAIL_CODE_CLASS_NAME, "text-foreground")}>{output.stdout}</pre>
          ) : null}
          {output.stderr ? (
            <pre className={cn(DETAIL_CODE_CLASS_NAME, "text-destructive")} data-tool-stderr="">
              {output.stderr}
            </pre>
          ) : null}
        </Card>
      ) : null}
      {failed || output.truncated ? (
        <div className="flex flex-wrap items-center gap-ui-gap-xs">
          {failed ? (
            <Badge variant="error" data-tool-exit-code="">
              {format("chat.shell.exitCode", { code: output.exitCode! })}
            </Badge>
          ) : null}
          {output.truncated ? (
            <span className="text-ui-sm text-muted-foreground">
              {t("chat.mcpResult.truncatedShort")}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The same path, whichever slash and case the agent wrote it with. */
function samePathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

/** A file's name on top of what the agent did to it, inside its card. */
function ToolFilePathHeader({ path }: { path: string }) {
  return (
    <div
      className="border-b border-[color:var(--color-border)] px-3 py-2 text-ui-sm break-all text-muted-foreground"
      data-tool-file-path=""
      data-translation-skip="true"
    >
      {path}
    </div>
  );
}

/** Each changed file by its name inside the project, then the lines of its hunks. */
function DiffCodeBlock({ files, cwd }: { files: ToolDiffFile[]; cwd: string | undefined }) {
  return (
    <Card data-tool-diff="">
      {files.map((file, fileIndex) => (
        <div
          key={`${fileIndex}:${file.path ?? ""}`}
          className={cn(fileIndex > 0 && "border-t border-[color:var(--color-border)]")}
        >
          {file.path ? <ToolFilePathHeader path={pathInside(file.path, cwd)} /> : null}
          <pre className="max-h-[min(52vh,34rem)] overflow-auto py-2 font-chat-code text-chat-code">
            {file.hunks.map((hunk, hunkIndex) =>
              hunk.map((line, index) => (
                <span
                  key={`${hunkIndex}:${index}:${line.slice(0, 24)}`}
                  className={cn(
                    "block min-w-max whitespace-pre-wrap break-words px-3",
                    // Lines of the next hunk are not next to the last one: a rule between them.
                    hunkIndex > 0 &&
                      index === 0 &&
                      "mt-2 border-t border-[color:var(--color-border)] pt-2",
                    line.startsWith("+") ? ADDED_LINE_CLASS_NAME : null,
                    line.startsWith("-") ? REMOVED_LINE_CLASS_NAME : null,
                  )}
                >
                  {line.length > 0 ? line : " "}
                </span>
              )),
            )}
          </pre>
        </div>
      ))}
    </Card>
  );
}
