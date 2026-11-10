// Adapted from OpenMausBot (Apache-2.0), commit 58378e85449ca49f3370d72e6c70cece4fee413f.
// Moss changes: module placement and immutable sorting. See third_party/openmaus/LICENSE.
// Keep mention recognition identical in the renderer and server routing.
// Deliberately allow only opening punctuation/Markdown markers here: `/@bot`
// remains a URL path, while `(@bot)`, `【@bot】`, and `**@bot**` are tags.
const OPENING_MENTION_BOUNDARY = /[(*_~[{<'"\u2018\u201c\u3008\u300a\u300c\u300e\u3010\uff08]/u;

/** Return whether an at-sign starts a standalone mention at this offset. */
export function isMentionBoundary(text: string, at: number): boolean {
  if (at === 0) return true;
  const before = text[at - 1] ?? "";
  return /\s/u.test(before) || OPENING_MENTION_BOUNDARY.test(before);
}

/** A matched name must not be the prefix of a longer Unicode word. */
export function isMentionNameContinuation(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}\p{M}_]/u.test(value);
}
