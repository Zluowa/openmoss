// FILE: mossSurfaceState.ts
// Purpose: Typed URL state for shell-owned Images and Library destinations.
// Layer: Web shell navigation utility

export type MossSurface = "images" | "library";

export interface MossSurfaceSearch {
  readonly mossSurface?: MossSurface;
}

/** Read the shell destination without trusting router search values at runtime. */
export function parseMossSurface(search: unknown): MossSurface | null {
  if (!search || typeof search !== "object") return null;
  const value = (search as { readonly mossSurface?: unknown }).mossSurface;
  return value === "images" || value === "library" ? value : null;
}

/** Preserve unrelated route search keys while changing the shell destination. */
export function withMossSurface<T extends object>(
  search: T,
  surface: MossSurface | null,
): T & MossSurfaceSearch {
  const next = { ...search } as T & MossSurfaceSearch;
  const writable = next as { -readonly [K in keyof MossSurfaceSearch]?: MossSurface };
  if (surface) writable.mossSurface = surface;
  else delete writable.mossSurface;
  return next;
}
