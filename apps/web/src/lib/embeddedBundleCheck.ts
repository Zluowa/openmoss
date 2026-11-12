// FILE: embeddedBundleCheck.ts
// Purpose: Remember that a bundle the backend serves for an embedded surface (the Canvas, its
//          slide and page editors) is there, so reopening one starts its frame at once instead of
//          after a probe round trip.
// Layer: Web runtime utility
// Exports: isEmbeddedBundleVerified, verifyEmbeddedBundle, resetEmbeddedBundleChecks
//
// The side panel refuses to show a frame for a missing bundle (a visible release failure rather
// than an empty editor), so it probes the bundle. That probe used to run before every open, in
// series before the frame. Now the last answer is remembered for the bundle's URL (every
// conversation shares it; only the query differs): when it was served, the frame starts on the
// first commit and the probe runs alongside it. A failed probe forgets the answer and the panel
// shows the failure, so a bundle that disappears is still reported.

const verified = new Set<string>();

function bundleKey(src: string): string {
  const url = new URL(src, globalThis.location?.href);
  return `${url.origin}${url.pathname}`;
}

/** Whether this session already saw the bundle behind `src` served. */
export function isEmbeddedBundleVerified(src: string): boolean {
  return verified.has(bundleKey(src));
}

/** Probe the bundle behind `src`: true when it is served. Remembers the answer; never rejects. */
export async function verifyEmbeddedBundle(src: string): Promise<boolean> {
  const key = bundleKey(src);
  const ok = await fetch(src, { method: "GET", credentials: "omit" }).then(
    (response) => response.ok,
    () => false,
  );
  if (ok) verified.add(key);
  else verified.delete(key);
  return ok;
}

/** Forget every check (tests only). */
export function resetEmbeddedBundleChecks(): void {
  verified.clear();
}
