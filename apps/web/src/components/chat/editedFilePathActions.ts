// FILE: editedFilePathActions.ts
// Purpose: Resolve the absolute and workspace-relative forms used by edited-file actions.
// Layer: Chat changed-files UI logic

import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  joinWorkspaceRelativePath,
  workspaceRelativePathOf,
} from "@moss/shared/path";

export interface EditedFilePathTargets {
  absolutePath: string | null;
  relativePath: string | null;
}

export interface EditedFileDisplayParts {
  fileName: string;
  directory: string | null;
}

const WINDOWS_DRIVE_SEGMENT_PATTERN = /^[A-Za-z]:$/;

/**
 * Formats an edited file path for calm scannable rows: prominent basename plus a quiet
 * workspace-relative directory (or only the immediate parent folder for external absolute
 * paths so raw OS paths like `C:\DevTemp\...` never clutter chat cards).
 */
export function formatEditedFileDisplay(
  filePath: string,
  workspaceRoot: string | undefined,
): EditedFileDisplayParts {
  const trimmedPath = filePath.trim();
  if (trimmedPath.length === 0) {
    return { fileName: "", directory: null };
  }

  const { relativePath } = resolveEditedFilePathTargets(trimmedPath, workspaceRoot);
  if (relativePath) {
    const segments = relativePath.split("/").filter(Boolean);
    const fileName = segments.at(-1) ?? relativePath;
    const directory = segments.length > 1 ? segments.slice(0, -1).join("/") : null;
    return { fileName, directory };
  }

  const normalizedSegments = trimmedPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const fileName = normalizedSegments.at(-1) ?? trimmedPath;
  const parent = normalizedSegments.length > 1 ? normalizedSegments.at(-2) : undefined;
  const directory = parent && !WINDOWS_DRIVE_SEGMENT_PATTERN.test(parent) ? parent : null;
  return { fileName, directory };
}

export function resolveEditedFilePathTargets(
  filePath: string,
  workspaceRoot: string | undefined,
): EditedFilePathTargets {
  const trimmedPath = filePath.trim();
  if (trimmedPath.length === 0) {
    return { absolutePath: null, relativePath: null };
  }

  if (isLocalAbsolutePath(trimmedPath)) {
    return {
      absolutePath: trimmedPath,
      relativePath: workspaceRoot ? workspaceRelativePathOf(trimmedPath, workspaceRoot) : null,
    };
  }

  if (!isWorkspaceRelativePathSafe(trimmedPath)) {
    return { absolutePath: null, relativePath: null };
  }

  const relativePath = trimmedPath.replace(/\\/g, "/");
  return {
    absolutePath: workspaceRoot ? joinWorkspaceRelativePath(workspaceRoot, relativePath) : null,
    relativePath,
  };
}
