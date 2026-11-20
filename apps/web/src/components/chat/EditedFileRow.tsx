// FILE: EditedFileRow.tsx
// Purpose: Render one changed-file row; the row itself opens the review, and a
// compact always-visible action opens the file in the preferred editor.
// Layer: Chat changed-files UI

import type { EditorId, ResolvedKeybindingsConfig } from "@moss/contracts";
import type { CSSProperties } from "react";

import { useCopyPathToClipboard } from "~/hooks/useCopyToClipboard";
import { CopyIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { MenuItem } from "../ui/menu";
import { DiffStatLabel } from "./DiffStatLabel";
import { FileEntryIcon } from "./FileEntryIcon";
import { OpenInPicker } from "./OpenInPicker";
import { formatEditedFileDisplay, resolveEditedFilePathTargets } from "./editedFilePathActions";

interface EditedFileRowProps {
  filePath: string;
  fileKind: string;
  additions: number;
  deletions: number;
  workspaceRoot: string | undefined;
  keybindings?: ResolvedKeybindingsConfig;
  availableEditors?: ReadonlyArray<EditorId>;
  resolvedTheme: "light" | "dark";
  fontSize?: CSSProperties["fontSize"];
  withFirstReset: boolean;
  onReview: () => void;
}

const MENU_ICON_CLASS_NAME = "size-4 shrink-0 text-muted-foreground";
const EDITED_FILE_EDITOR_ORDER: ReadonlyArray<EditorId> = [
  "file-manager",
  "vscode",
  "cursor",
  "webstorm",
  "terminal",
  "iterm",
];

export function EditedFileRow(props: EditedFileRowProps) {
  const copyPathToClipboard = useCopyPathToClipboard();
  const { absolutePath, relativePath } = resolveEditedFilePathTargets(
    props.filePath,
    props.workspaceRoot,
  );
  const { fileName, directory } = formatEditedFileDisplay(props.filePath, props.workspaceRoot);
  const isDeleted = props.fileKind === "deleted";
  const launcherTarget = isDeleted ? null : absolutePath;
  const hasDiffStat = props.additions + props.deletions > 0;

  return (
    <div
      data-edited-file-row="true"
      className={cn(
        "flex min-h-9 w-full min-w-0 items-center gap-1.5 overflow-hidden border-t border-[color:var(--color-border)] bg-transparent pr-2 transition-colors hover:bg-[var(--color-background-button-secondary-hover)]",
        props.withFirstReset && "first:border-t-0",
      )}
    >
      <button
        type="button"
        aria-label={`Review changes to ${props.filePath}`}
        title={props.filePath}
        className="group/file-row flex min-w-0 flex-1 items-center gap-2 self-stretch bg-transparent py-1.5 pl-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 focus-visible:ring-inset"
        onClick={props.onReview}
      >
        <FileEntryIcon
          pathValue={props.filePath}
          kind="file"
          theme={props.resolvedTheme}
          colorMode="inherit"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden font-system-ui">
          <span
            data-edited-file-name=""
            className="max-w-full shrink-0 truncate text-ui-sm font-normal text-foreground underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
          >
            {fileName}
          </span>
          {directory ? (
            <span
              data-edited-file-dir=""
              className="min-w-0 flex-1 truncate text-ui-xs font-normal text-muted-foreground"
            >
              {directory}
            </span>
          ) : null}
        </span>
        {hasDiffStat ? (
          <span className="ml-auto shrink-0 font-system-ui text-ui-xs tabular-nums">
            <DiffStatLabel additions={props.additions} deletions={props.deletions} />
          </span>
        ) : null}
      </button>

      {/* Calm Central icon actions: open outside Moss and options menu (editors + copy path).
          The whole row already opens the in-app diff review. */}
      <OpenInPicker
        variant="compact"
        {...(props.keybindings ? { keybindings: props.keybindings } : {})}
        {...(props.availableEditors ? { availableEditors: props.availableEditors } : {})}
        openInTarget={launcherTarget}
        menuEditorOrder={EDITED_FILE_EDITOR_ORDER}
        preferFileEditor
        groupLabel={`Open ${props.filePath}`}
        menuLabel={`Open ${props.filePath} options`}
        additionalMenuItems={
          <>
            <MenuItem
              disabled={absolutePath === null}
              onClick={() => {
                if (absolutePath) copyPathToClipboard(absolutePath);
              }}
            >
              <CopyIcon className={MENU_ICON_CLASS_NAME} />
              <span>Copy absolute path</span>
            </MenuItem>
            <MenuItem
              disabled={relativePath === null}
              onClick={() => {
                if (relativePath) copyPathToClipboard(relativePath);
              }}
            >
              <CopyIcon className={MENU_ICON_CLASS_NAME} />
              <span>Copy relative path</span>
            </MenuItem>
          </>
        }
      />
    </div>
  );
}
