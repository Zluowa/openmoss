// FILE: FileEntryIcon.tsx
// Purpose: Shared file/folder glyph primitive for composer, diff, editor, and timeline rows.
// Layer: Chat/shared UI
// Exports: FileEntryIcon

import { fileIconColor, getAttachmentIconName, getFileIconName } from "../../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { FolderIcon, FolderOpenIcon } from "~/lib/icons";

const FOLDER_ICON_COLOR_CLASS_NAME = "text-muted-foreground";

export const FileEntryIcon = function FileEntryIcon(props: {
  pathValue: string;
  kind: "file" | "directory";
  // When provided, the glyph is resolved attachment-style: the MIME type is
  // consulted whenever the filename has no recognizable extension, and the
  // fallback is a generic document rather than the source-code bracket. Left
  // undefined for source-file surfaces (diff/editor/timeline) that key purely
  // off the path.
  mimeType?: string | null | undefined;
  // Vestigial: Central icons are `currentColor` glyphs, so theme no longer
  // affects icon selection. Optional so theme-less surfaces (e.g. markdown
  // file links, code-block headers) can reuse this same primitive.
  theme?: "light" | "dark" | undefined;
  className?: string;
  // Timeline changed-file rows pass their own muted color and should not pick
  // up extension-specific colors.
  colorMode?: "file" | "inherit" | undefined;
  expanded?: boolean | undefined;
}) {
  // Match the look of the local filepath picker: directories always render the
  // shared closed/open folder glyph.
  if (props.kind === "directory") {
    const FolderGlyph = props.expanded ? FolderOpenIcon : FolderIcon;
    return (
      <FolderGlyph
        className={cn("size-4 shrink-0", props.className, FOLDER_ICON_COLOR_CLASS_NAME)}
      />
    );
  }

  const iconName =
    props.mimeType === undefined
      ? getFileIconName(props.pathValue)
      : getAttachmentIconName({ name: props.pathValue, mimeType: props.mimeType });
  // Each glyph's colour comes from the shared table the phone draws from too.
  const color = props.colorMode === "inherit" ? undefined : fileIconColor(iconName);

  return (
    <CentralIcon
      name={iconName}
      className={cn(
        "size-4 shrink-0",
        props.className,
        color === null ? "text-foreground" : undefined,
      )}
      {...(color ? { style: { color } } : {})}
    />
  );
};
