// Word boundaries used by Codex's streaming Markdown fade. Keep punctuation and
// whitespace with the previous word; the joined segments must preserve every byte.
let wordSegmenter: Intl.Segmenter | undefined;

export function streamingTextSegments(text: string): string[] {
  if (/^[\x00-\x7f]*$/u.test(text)) {
    const segments: string[] = [];
    for (const part of text.match(/[a-zA-Z0-9]+|[^a-zA-Z0-9]+/gu) ?? []) {
      if (/^[a-zA-Z0-9]/u.test(part)) segments.push(part);
      else if (segments.length > 0) segments[segments.length - 1] += part;
      else segments.push(part);
    }
    return segments;
  }

  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  const segments: string[] = [];
  for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
    if (isWordLike) segments.push(segment);
    else if (segments.length > 0) segments[segments.length - 1] += segment;
    else segments.push(segment);
  }
  return segments;
}
