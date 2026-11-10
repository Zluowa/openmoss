// FILE: svgRemoteReferences.ts
// Purpose: Tells whether an SVG attribute value (an inline style or a presentation
//   attribute such as fill or marker-end) could make the browser fetch something.
// Layer: Web lib (pure)
// Exports: attributeMayFetch

// A url() is safe only when it points inside the same SVG (#marker, #gradient). CSS
// escapes could spell a url() the pattern does not see, so any backslash counts, and so
// do @import and image-set(), which take a bare string as an image.
const REMOTE_REFERENCE = /\\|@import|image-set\s*\(|url\s*\((?!\s*["']?\s*#)/iu;

/** Whether a sanitized diagram must drop this attribute so it cannot load a remote resource. */
export function attributeMayFetch(value: string): boolean {
  return REMOTE_REFERENCE.test(value);
}
