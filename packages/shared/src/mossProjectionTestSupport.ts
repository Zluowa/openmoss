import type {
  MossProjectionFrozenTarget,
  MossProjectionOwnershipMutationResult,
} from "./mossProjectionMaterializer";

export const WINDOWS_FILE_SYMLINK_UNSUPPORTED_REASON =
  "Test authority does not support Windows file symlink publication.";

/** Keep unsupported file links distinct from successful directory junctions. */
export function unsupportedTestProjectionTarget(
  target: MossProjectionFrozenTarget,
): MossProjectionOwnershipMutationResult | undefined {
  if (process.platform === "win32" && target.kind === "symlink" && target.linkType === "file") {
    return { status: "unsupported", reason: WINDOWS_FILE_SYMLINK_UNSUPPORTED_REASON };
  }
  return undefined;
}
