// FILE: openLink.ts
// Purpose: Decide what a widget's `ui/open-link` may do (SPEC §8, SPEC-protocol §3.6): Moss
//          app routes open in place, http(s)/mailto/tel/sms ask first, everything else is refused.
//          Also parses mailto/sms/tel targets and flags look-alike or credential-carrying links.
// Layer: Web MCP App host policy
// Exports: classifyMcpAppLink, McpAppLinkPlan

export type McpAppLinkKind = "web" | "mail" | "text" | "call";

export interface McpAppLinkDetails {
  readonly to?: string;
  readonly cc?: string;
  readonly bcc?: string;
  readonly subject?: string;
  readonly body?: string;
}

export type McpAppLinkPlan =
  | { readonly action: "in_app"; readonly path: string }
  | {
      readonly action: "confirm";
      readonly kind: McpAppLinkKind;
      readonly url: string;
      /** Host for web links, the scheme for the others: the "don't ask again" key. */
      readonly trustKey: string;
      readonly displayDomain: string;
      readonly punycode: boolean;
      readonly credentials: boolean;
      readonly details: McpAppLinkDetails;
    }
  | { readonly action: "refuse" };

const MAX_URL_CHARS = 8_192;

function decode(value: string | null): string | undefined {
  if (value === null || value.length === 0) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasPunycode(hostname: string): boolean {
  return hostname.split(".").some((label) => label.toLowerCase().startsWith("xn--"));
}

function text(value: string | null): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function parseAddressLike(url: URL): McpAppLinkDetails {
  // searchParams already decodes query values; only the address path needs decoding.
  const query = url.searchParams;
  const to = decode(url.pathname) ?? text(query.get("to"));
  const cc = text(query.get("cc"));
  const bcc = text(query.get("bcc"));
  const subject = text(query.get("subject"));
  const body = text(query.get("body"));
  return {
    ...(to ? { to } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(subject ? { subject } : {}),
    ...(body ? { body } : {}),
  };
}

/**
 * `appOrigin` is the Moss renderer origin; links to it are Moss's own routes and open in place.
 */
export function classifyMcpAppLink(rawUrl: unknown, appOrigin: string | null): McpAppLinkPlan {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_CHARS) {
    return { action: "refuse" };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { action: "refuse" };
  }
  if (appOrigin && appOrigin !== "null" && url.origin === appOrigin) {
    return { action: "in_app", path: `${url.pathname}${url.search}${url.hash}` };
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:") {
    const hostname = url.hostname.toLowerCase();
    if (!hostname) return { action: "refuse" };
    return {
      action: "confirm",
      kind: "web",
      url: url.toString(),
      trustKey: hostname,
      displayDomain: hostname,
      punycode: hasPunycode(hostname),
      credentials: url.username.length > 0 || url.password.length > 0,
      details: {},
    };
  }
  const kind: McpAppLinkKind | null =
    protocol === "mailto:"
      ? "mail"
      : protocol === "sms:"
        ? "text"
        : protocol === "tel:"
          ? "call"
          : null;
  if (!kind) return { action: "refuse" };
  const scheme = protocol.slice(0, -1);
  return {
    action: "confirm",
    kind,
    url: url.toString(),
    trustKey: `${scheme}:`,
    displayDomain: scheme,
    punycode: false,
    credentials: false,
    details: parseAddressLike(url),
  };
}
