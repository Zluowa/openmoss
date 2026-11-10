// FILE: TurnPageCards.tsx
// Purpose: One card per HTML page a finished turn created or edited, like the desktop
//          chat's artifact card: page icon, the page's own title, whether it was
//          created or edited, and a chevron. Clicking it opens the page rendered in the
//          side panel.
// Layer: Chat timeline UI
// Exports: TurnPageCards, turnPageFiles
//
// Geometry measured from the desktop chat (compact scale): at most 318px wide, 6px
// above and below, an 8px corner drawn as a 1px inset hairline, 10px start / 4px end
// padding, 6px block padding and a 6px gap; the title at body size (13/19), the status
// at footnote size in the muted tone, and a 16px chevron. Hover fills it with the
// ghost hover tint and a press scales it to 99%.

import { PROJECT_PREVIEW_READ_FILE_MAX_BYTES } from "@moss/contracts";
import { isWorkspaceRelativePathSafe } from "@moss/shared/path";
import { useQuery } from "@tanstack/react-query";

import { basenameOfPath } from "~/file-icons";
import { ChevronRightIcon } from "~/lib/icons";
import { projectReadFileQueryOptions } from "~/lib/projectReactQuery";
import { useSharedFileOpener } from "~/lib/sharedViewer";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "~/lib/workspaceFileOpener";
import { cn } from "~/lib/utils";
import type { TurnDiffFileChange } from "~/types";

import { isChatHtmlPagePath, readHtmlDocumentTitle } from "./chatFileKind";
import { MentionChipIcon } from "./MentionChipIcon";

const MAX_PAGE_CARDS = 3;

/** HTML pages among a turn's changed files, in turn order, deleted pages left out. */
export function turnPageFiles(
  files: ReadonlyArray<TurnDiffFileChange>,
): ReadonlyArray<TurnDiffFileChange> {
  return files
    .filter((file) => file.kind !== "deleted" && isChatHtmlPagePath(file.path))
    .slice(0, MAX_PAGE_CARDS);
}

function isCreatedKind(kind: string | undefined): boolean {
  return kind === "added" || kind === "created" || kind === "new" || kind === "untracked";
}

function TurnPageCard(props: {
  file: TurnDiffFileChange;
  workspaceRoot: string | undefined;
  theme: "light" | "dark";
}) {
  const opener = useWorkspaceFileOpener();
  // A shared conversation's guest opens the page in its viewer pane, through the share.
  const openSharedFile = useSharedFileOpener();
  const { path } = props.file;
  // Same query key the side panel's HTML preview reads with, so reading the title
  // also warms the panel for the click that usually follows.
  const readable = props.workspaceRoot !== undefined && isWorkspaceRelativePathSafe(path);
  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.workspaceRoot ?? null,
      relativePath: readable ? path : null,
      maxBytes: PROJECT_PREVIEW_READ_FILE_MAX_BYTES,
      enabled: readable,
    }),
  );
  const title =
    (fileQuery.data?.contents ? readHtmlDocumentTitle(fileQuery.data.contents) : null) ??
    (basenameOfPath(path) || path);
  const status = isCreatedKind(props.file.kind) ? "Created" : "Edited";
  const canOpen = opener !== null || openSharedFile !== null;
  return (
    <div className="my-1.5 flex w-full flex-col">
      <button
        type="button"
        className={cn(
          "group/page-card relative isolate flex max-w-[min(100%,318px)] min-w-[min(100%,318px)] items-center gap-1.5 self-start rounded-md py-1.5 ps-2.5 pe-1 text-start outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
          canOpen ? "cursor-pointer" : "cursor-default",
        )}
        disabled={!canOpen}
        aria-label={`Open page ${title}`}
        title={openSharedFile ? title : path}
        data-turn-page-card={path}
        onClick={() =>
          openSharedFile
            ? openSharedFile({ path, name: basenameOfPath(path) || path })
            : openWorkspaceFileReference(opener, path)
        }
      >
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 -z-1 rounded-[inherit] shadow-[inset_0_0_0_1px_var(--border)] transition-[background-color,scale] duration-100 ease-out motion-reduce:transition-none",
            canOpen &&
              "group-hover/page-card:bg-[var(--color-background-button-secondary-hover)] group-active/page-card:scale-99",
          )}
        />
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <MentionChipIcon path={path} theme={props.theme} className="size-4 shrink-0" />
        </span>
        <span
          className="min-w-0 flex-1 truncate text-ui text-foreground"
          data-translation-skip="true"
        >
          {title}
        </span>
        <span className="shrink-0 text-ui-sm text-muted-foreground">{status}</span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );
}

export function TurnPageCards(props: {
  files: ReadonlyArray<TurnDiffFileChange>;
  workspaceRoot: string | undefined;
  theme: "light" | "dark";
}) {
  const pages = turnPageFiles(props.files);
  if (pages.length === 0) return null;
  return (
    <div className="flex flex-col" data-turn-page-cards>
      {pages.map((file) => (
        <TurnPageCard
          key={file.path}
          file={file}
          workspaceRoot={props.workspaceRoot}
          theme={props.theme}
        />
      ))}
    </div>
  );
}
