// FILE: htmlMarkup.ts
// Purpose: Equal-length active markup views shared by HTML bootstraps and app resources.
// Layer: Shared, dependency-free runtime utility

// Comments, raw text, and template contents are blanked to the same length.
// Callers inspecting executable resources may retain active script/style blocks;
// template contents stay blank even when they contain those requested blocks.
export function blankHtmlNonMarkup(
  html: string,
  keepRawText: ReadonlyArray<"script" | "style"> = [],
): string {
  const retained: Array<{ start: number; end: number }> = [];
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?(?:<\/\1\s*>|$)|<plaintext(?=[\s/>])[\s\S]*$|<\/?[a-z][a-z\d:-]*(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>/gi,
    (match: string, tag: string | undefined, start: number) => {
      if (!tag && !/^<!--|^<plaintext(?=[\s/>])/iu.test(match)) {
        // Consume a whole ordinary tag before looking for another tag. Angle
        // brackets inside its quoted attributes are text, never nested markup.
        return match.replace(/"[^"]*"|'[^']*'/gu, (value) => value.replace(/[<>]/gu, " "));
      }
      if (keepRawText.some((name) => name === tag?.toLowerCase())) {
        retained.push({ start, end: start + match.length });
      }
      return " ".repeat(match.length);
    },
  );
  const parts: string[] = [];
  const templates: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      templates.push({ start, end });
      parts.push(scan.slice(at, start), " ".repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    templates.push({ start, end: scan.length });
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  const blanked = parts.join("");
  const restored: string[] = [];
  let templateIndex = 0;
  at = 0;
  for (const range of retained) {
    while (templates[templateIndex] && templates[templateIndex]!.end <= range.start) {
      templateIndex += 1;
    }
    if (templates[templateIndex] && templates[templateIndex]!.start <= range.start) continue;
    restored.push(blanked.slice(at, range.start), html.slice(range.start, range.end));
    at = range.end;
  }
  restored.push(blanked.slice(at));
  return restored.join("");
}

/** Inserts trusted markup at the active document head, never inside inert text. */
export function injectHtmlHeadMarkup(html: string, markup: string): string {
  const scan = blankHtmlNonMarkup(html);
  const firstScript =
    /<script(?=[\s/>])/iu.exec(blankHtmlNonMarkup(html, ["script"]))?.index ?? Infinity;
  const head = /<head(?:\s[^>]*)?>/iu.exec(scan);
  if (head && head.index + head[0].length <= firstScript) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const root = /<html(?:\s[^>]*)?>/iu.exec(scan);
  if (root && root.index + root[0].length <= firstScript) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + markup + html.slice(at);
}
