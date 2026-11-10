// FILE: pageAppContentPolicy.ts
// Purpose: One application document CSP for runtime and readonly AppItem frames.
// Layer: Shared, dependency-free policy

/**
 * Script and style hosts a page may load libraries from. Everything else,
 * including any fetch, WebSocket or beacon, is refused (`connect-src 'none'`):
 * the page reaches Moss only through the shell's postMessage broker.
 */
export const PAGE_APP_LIBRARY_HOSTS = [
  "https://cdn.jsdelivr.net",
  "https://cdnjs.cloudflare.com",
  "https://unpkg.com",
] as const;
const FONT_STYLE_HOSTS = ["https://fonts.googleapis.com"] as const;
const FONT_HOSTS = ["https://fonts.gstatic.com"] as const;

function frameAncestor(parentOrigin: string): string {
  // CSP host sources take http(s) origins and registered schemes as `scheme:`.
  if (/^https?:\/\/[^\s/;,'"]+$/iu.test(parentOrigin)) return parentOrigin;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(parentOrigin)?.[1];
  return scheme ? `${scheme.toLowerCase()}:` : "'none'";
}

export function pageAppContentSecurityPolicy(input: {
  readonly parentOrigin: string;
  readonly opaque: boolean;
}): string {
  const libs = PAGE_APP_LIBRARY_HOSTS.join(" ");
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${libs}`,
    `style-src 'unsafe-inline' ${libs} ${FONT_STYLE_HOSTS.join(" ")}`,
    `font-src 'self' data: ${libs} ${FONT_HOSTS.join(" ")}`,
    // 'self' is the page's own origin: its assets (opaque pages match nothing).
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestor(input.parentOrigin)}`,
  ];
  if (input.opaque) directives.push("sandbox allow-scripts allow-forms allow-modals allow-popups");
  return directives.join("; ");
}

/** CSP directives supported by a meta element; sandbox comes from the iframe. */
export function pageAppMetaContentSecurityPolicy(): string {
  return pageAppContentSecurityPolicy({ parentOrigin: "https://unused.invalid", opaque: true })
    .split("; ")
    .filter(
      (directive) => !directive.startsWith("sandbox ") && !directive.startsWith("frame-ancestors "),
    )
    .join("; ");
}

/** Guest previews inherit resource restrictions and only the minimal readonly sandbox. */
export function pageAppReadonlyContentSecurityPolicy(parentOrigin: string): string {
  if (!isPageAppHttpOrigin(parentOrigin))
    throw new Error("Readonly preview parent must be an exact HTTP origin");
  return pageAppContentSecurityPolicy({ parentOrigin, opaque: true })
    .split("; ")
    .filter((directive) => !directive.startsWith("sandbox "))
    .concat("sandbox allow-scripts allow-forms")
    .join("; ");
}

/** A normalized origin that is also safe as one CSP host source and HTML attribute value. */
export function isPageAppHttpOrigin(value: string): boolean {
  if (!/^https?:\/\/(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])(?::\d+)?$/u.test(value)) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

export const PAGE_APP_PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=()";
