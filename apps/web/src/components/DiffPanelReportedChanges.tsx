// FILE: DiffPanelReportedChanges.tsx
// Purpose: Turn-diff fallback when Moss has no before-turn snapshot to compare
//          (the baseline is missing, or the folder is not a Git repository): list
//          the files the agent reported and show the selected file's content
//          through the server file read, instead of an endless skeleton.
// Layer: Diff panel UI

import { lazy, Suspense } from "react";

import { resolveDockFileOpenTarget } from "~/lib/workspaceFileOpener";
import { cn } from "~/lib/utils";
import type { TurnDiffFileChange } from "../types";
import { DiffPanelLoadingState } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { FileEntryIcon } from "./chat/FileEntryIcon";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { formatEditedFileDisplay } from "./chat/editedFilePathActions";
import { Button } from "./ui/button";

const LazyWorkspaceFilePreview = lazy(() =>
  import("./WorkspaceFilePreview").then((module) => ({ default: module.WorkspaceFilePreview })),
);

export type DiffPanelReportedChangesReason = "not-git" | "no-snapshot";

/** Files of the summaries in scope, first report of a path wins, counts summed. */
export function collectReportedTurnFiles(
  summaries: ReadonlyArray<{ files: ReadonlyArray<TurnDiffFileChange> }>,
): TurnDiffFileChange[] {
  const byPath = new Map<string, TurnDiffFileChange>();
  for (const summary of summaries) {
    for (const file of summary.files) {
      const path = file.path.trim();
      if (!path) continue;
      const previous = byPath.get(path);
      byPath.set(
        path,
        previous
          ? {
              ...previous,
              additions: (previous.additions ?? 0) + (file.additions ?? 0),
              deletions: (previous.deletions ?? 0) + (file.deletions ?? 0),
            }
          : { ...file, path },
      );
    }
  }
  return [...byPath.values()];
}

/** The clicked file when it was reported, else the first file that still exists. */
export function resolveReportedPreviewPath(
  files: ReadonlyArray<TurnDiffFileChange>,
  selectedFilePath: string | null,
): string | null {
  if (selectedFilePath && files.some((file) => file.path === selectedFilePath)) {
    return selectedFilePath;
  }
  return (files.find((file) => file.kind !== "deleted") ?? files[0])?.path ?? null;
}

export function DiffPanelReportedChanges(props: {
  reason: DiffPanelReportedChangesReason;
  files: ReadonlyArray<TurnDiffFileChange>;
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  resolvedTheme: "light" | "dark";
  retrying: boolean;
  onSelectFile: (filePath: string) => void;
  onRetry: () => void;
}) {
  const previewPath = resolveReportedPreviewPath(props.files, props.selectedFilePath);
  const previewFile = props.files.find((file) => file.path === previewPath) ?? null;
  const previewTarget =
    previewFile && previewFile.kind !== "deleted"
      ? resolveDockFileOpenTarget(previewFile.path, props.workspaceRoot)
      : null;
  const workspaceRoot = props.workspaceRoot ?? undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b border-border/60 px-3 py-2.5">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-ui-sm text-foreground">
            Line-by-line changes are unavailable for this turn.
          </p>
          <p className="text-ui-xs text-muted-foreground">
            {props.reason === "not-git"
              ? "This folder is not a Git repository, so Moss keeps no snapshot to compare with. These are the files the agent reported changing."
              : "Moss has no snapshot from before this turn to compare with. These are the files the agent reported changing."}
          </p>
        </div>
        {props.reason === "no-snapshot" ? (
          <Button
            variant="outline"
            size="xs"
            className="shrink-0 font-normal"
            disabled={props.retrying}
            onClick={props.onRetry}
          >
            Retry
          </Button>
        ) : null}
      </div>
      <ul
        aria-label="Reported changes"
        className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border/60 py-1"
      >
        {props.files.map((file) => {
          const { fileName, directory } = formatEditedFileDisplay(file.path, workspaceRoot);
          const selected = file.path === previewPath;
          return (
            <li key={file.path}>
              <Button
                variant="ghost"
                title={file.path}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "h-auto min-h-8 w-full min-w-0 justify-start gap-2 rounded-none border-transparent px-3 py-1 text-left font-normal",
                  selected && "bg-[var(--color-background-button-secondary-hover)]",
                )}
                onClick={() => props.onSelectFile(file.path)}
              >
                <FileEntryIcon
                  pathValue={file.path}
                  kind="file"
                  theme={props.resolvedTheme}
                  colorMode="inherit"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                  <span className="shrink-0 truncate text-ui-sm text-foreground">{fileName}</span>
                  {directory ? (
                    <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
                      {directory}
                    </span>
                  ) : null}
                </span>
                <span className="ml-auto shrink-0 text-ui-xs">
                  <DiffStatLabel additions={file.additions ?? 0} deletions={file.deletions ?? 0} />
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {previewTarget ? (
          <Suspense fallback={<DiffPanelLoadingState label="Loading file..." />}>
            <LazyWorkspaceFilePreview
              workspaceRoot={props.workspaceRoot}
              filePath={previewTarget}
              markdownPreviewDefault
            />
          </Suspense>
        ) : (
          <PanelStateMessage density="compact" fill="flex">
            <p>
              {previewFile?.kind === "deleted"
                ? "The agent deleted this file."
                : "This file can't be shown here."}
            </p>
          </PanelStateMessage>
        )}
      </div>
    </div>
  );
}
