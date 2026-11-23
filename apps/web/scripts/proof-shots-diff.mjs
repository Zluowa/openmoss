// FILE: proof-shots-diff.mjs
// Purpose: How proof-shots.mjs decides what changed between two sets of screenshots: per pixel,
//          per picture, and the summary a pull request shows. Pure functions; `diffPixels` is also
//          sent into Chromium as source text (it decodes the PNGs there), so it closes over nothing.
// Layer: CI tooling (tested in proof-shots-diff.test.mjs)

/** A pixel counts as changed when a channel moved by more than this (anti-aliasing noise). */
export const CHANNEL_TOLERANCE = 24;
/** A picture counts as changed when more than this share of its pixels changed. */
export const CHANGED_SHARE = 0.001;

/**
 * Compares two RGBA buffers of the same size. Returns how many pixels changed and a diff picture:
 * changed pixels red, the rest the new picture faded to a light grey.
 */
export function diffPixels(before, after, width, height, tolerance) {
  const diff = new Uint8ClampedArray(width * height * 4);
  let changed = 0;
  for (let i = 0; i < after.length; i += 4) {
    const moved =
      Math.abs(before[i] - after[i]) > tolerance ||
      Math.abs(before[i + 1] - after[i + 1]) > tolerance ||
      Math.abs(before[i + 2] - after[i + 2]) > tolerance;
    if (moved) {
      changed++;
      diff[i] = 255;
      diff[i + 1] = 0;
      diff[i + 2] = 0;
    } else {
      const grey = (after[i] + after[i + 1] + after[i + 2]) / 3;
      const faded = 255 - (255 - grey) * 0.25;
      diff[i] = faded;
      diff[i + 1] = faded;
      diff[i + 2] = faded;
    }
    diff[i + 3] = 255;
  }
  return { changed, share: changed / (width * height), diff };
}

/**
 * One picture's verdict. `share` is null when the two sizes differ (the layout changed size:
 * counted as wholly changed).
 */
export function classify({ inBase, inHead, share }) {
  if (!inBase) return { status: "new" };
  if (!inHead) return { status: "gone" };
  if (share === null) return { status: "changed", share: 1 };
  return { status: share > CHANGED_SHARE ? "changed" : "same", share };
}

/** The step summary: how many pictures differ and, for each, by how much. */
export function summarize(rows) {
  const differing = rows.filter((row) => row.status !== "same");
  const head = `### Proof screenshots: ${differing.length} of ${rows.length} pictures differ from main`;
  if (differing.length === 0) return [head, "", "No screen changed."];
  return [
    head,
    "",
    "| picture | change |",
    "| --- | --- |",
    ...differing.map(
      (row) =>
        `| ${row.file} | ${row.status === "changed" ? `${(row.share * 100).toFixed(2)}% of pixels` : row.status} |`,
    ),
  ];
}

/**
 * Why a screen is not fit to be proof, or null. `expect.path` is the address the screen must end
 * on (a RegExp or an exact pathname); `expect.marker` names an element that must be visible
 * instead (the settings dialog has no address of its own). A dialog over a screen that does not
 * expect one hides what the picture is meant to show.
 */
export function screenProblem(expect, seen) {
  if (expect.path !== undefined) {
    const ok =
      expect.path instanceof RegExp
        ? expect.path.test(seen.pathname)
        : seen.pathname === expect.path;
    if (!ok) return `ended on ${seen.pathname}, not ${expect.path}`;
  }
  if (expect.marker !== undefined && !seen.markerVisible) return `${expect.marker} is not visible`;
  if (!expect.dialog && seen.dialogVisible) return "covered by a dialog";
  return null;
}
