// FILE: localLibraryHtml.ts
// Purpose: Reuse the shared inert-markup mask for app resource transformations.
// Layer: Server pages/apps

export const APP_SCRIPT =
  /<script(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/giu;
export const APP_STYLE = /<style(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*?>([\s\S]*?)<\/style\s*>/giu;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;

export function pageAppScriptAttributes(source: string) {
  const attributes = new Map<string, { value: string; start: number; end: number }>();
  let duplicateSource = false;
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (attributes.has(name) && name === "src") duplicateSource = true;
    if (!attributes.has(name))
      attributes.set(name, {
        value: match[2] ?? match[3] ?? match[4] ?? "",
        start: match.index,
        end: match.index + match[0].length,
      });
  }
  return { attributes, duplicateSource };
}
