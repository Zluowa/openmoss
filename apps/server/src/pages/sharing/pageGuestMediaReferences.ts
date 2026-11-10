import { libraryImageIdFromPath } from "@moss/shared/localPreviewFiles";
import { parsePageRichContent, type PageRichNode } from "@moss/shared/pageRichContent";

/** Both the reader and writer inspect the same image elements in a bounded, parsed page. */
export function pageGuestLibraryImageIds(nodes: readonly PageRichNode[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (children: readonly PageRichNode[]) => {
    for (const node of children) {
      // A text leaf can retain arbitrary attributes, but the renderer displays only its text.
      if (typeof node.text === "string") continue;
      if ((node.type === "img" || node.type === "image") && typeof node.url === "string") {
        const id = libraryImageIdFromPath(node.url);
        if (id !== null) ids.add(id);
      }
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return ids;
}

/** A guest can keep, rearrange or remove existing resources. Editing a page cannot
 * grant access to an owner's new library resource. Caller supplies the authorized
 * page body from the same write transaction, never a client-provided baseline. */
export function guestEditPreservesMediaAccess(
  previous: string | null,
  next: readonly PageRichNode[],
): boolean {
  const requested = pageGuestLibraryImageIds(next);
  if (!requested.size) return true;
  const permitted = pageGuestLibraryImageIds(parsePageRichContent(previous ?? "[]").nodes);
  for (const id of requested) if (!permitted.has(id)) return false;
  return true;
}
