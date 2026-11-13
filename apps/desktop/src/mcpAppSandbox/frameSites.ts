// FILE: frameSites.ts
// Purpose: Which declared `csp.frameDomains` a widget may actually frame.
// Layer: Electron main-process support (pure).
//
// Site rules follow the reference host: `https://host[:port]` or
// `https://*.host[:port]` with no path, a top-level label starting with a
// letter, port 443 folded away, ports with a leading 0 or above 65535 refused,
// the reference vendor's hosts, private-use suffixes and wildcards over shared
// public suffixes refused. Moss additionally refuses its own hosts.

const SITE_PATTERN = /^https:\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::([0-9]{1,5}))?$/iu;

/** Hosts (and their subdomains) a widget may never frame. */
export const MCP_APP_REFUSED_FRAME_HOSTS: readonly string[] = [
  // The reference vendor's own hosts.
  "claude.ai",
  "claude.app",
  "claude.com",
  "claude.dev",
  "claude.site",
  "claudestudio.com",
  "anthropic.com",
  "claudeusercontent.com",
  "claudemcpcontent.com",
  "claudemcpclient.com",
  "ant.dev",
  "antspace.dev",
  "palantirfedstart.com",
  "fedstart.com",
  // Moss's own hosts: model gateway, payments, share and realtime relays, devs, update feed,
  // accounts, and the company's site.
  "mossbotai.com",
  "tishilabs.com",
  "comiction.cn",
  "inkcomicai.com",
  "moss-global.supabase.co",
  "moss-cn.baseapi.memfiredb.com",
];

/** Shared public suffixes a `*.` wildcard may not sit directly on. */
const SHARED_PUBLIC_SUFFIXES = new Set(
  [
    "co.uk org.uk ac.uk gov.uk me.uk net.uk ltd.uk plc.uk",
    "com.au net.au org.au edu.au gov.au asn.au id.au",
    "co.jp ne.jp or.jp ac.jp go.jp",
    "co.nz net.nz org.nz ac.nz govt.nz",
    "co.in net.in org.in ac.in gov.in firm.in gen.in",
    "com.br net.br org.br gov.br",
    "com.cn net.cn org.cn gov.cn edu.cn",
    "com.mx com.ar com.tr com.sg com.hk com.tw com.my com.co com.pe com.ph com.vn com.eg com.sa com.pk",
    "co.za co.kr co.id co.th co.il co.ke",
    "github.io vercel.app pages.dev netlify.app herokuapp.com web.app firebaseapp.com appspot.com",
    "azurewebsites.net cloudfront.net workers.dev onrender.com fly.dev myshopify.com",
  ]
    .join(" ")
    .split(" "),
);

const PRIVATE_SUFFIX_PATTERN =
  /(?:^|\.)(?:localhost|local|internal|localdomain|lan|intranet|home\.arpa|invalid|home|corp|mail|onion)$/u;

export interface McpAppFrameSite {
  readonly host: string;
  readonly anySubdomain: boolean;
  /** "" for the default port. */
  readonly port: string;
}

function isRefusedHost(host: string): boolean {
  return MCP_APP_REFUSED_FRAME_HOSTS.some(
    (refused) => host === refused || host.endsWith(`.${refused}`),
  );
}

/** Parse one declared site, or null when it breaks a site rule. */
export function parseMcpAppFrameSite(value: string): McpAppFrameSite | null {
  const match = SITE_PATTERN.exec(value);
  const host = match?.[2]?.toLowerCase();
  if (!match || host === undefined) return null;
  const topLevel = host.slice(host.lastIndexOf(".") + 1);
  if (!/^[a-z]/u.test(topLevel)) return null;
  if (isRefusedHost(host) || PRIVATE_SUFFIX_PATTERN.test(host)) return null;
  const port = match[3] ?? "";
  if (port.startsWith("0") || Number(port) > 65_535) return null;
  const anySubdomain = match[1] !== undefined;
  if (anySubdomain && SHARED_PUBLIC_SUFFIXES.has(host)) return null;
  return { host, anySubdomain, port: port === "443" ? "" : port };
}

export function formatMcpAppFrameSite(site: McpAppFrameSite): string {
  return `https://${site.anySubdomain ? "*." : ""}${site.host}${site.port === "" ? "" : `:${site.port}`}`;
}

export interface McpAppFrameSiteDecision {
  /** Canonical sources for `frame-src`, deduplicated, in declared order. */
  readonly accepted: readonly string[];
  readonly refused: readonly string[];
}

/** Filter declared frame domains by the site rules. */
export function filterMcpAppFrameSites(declared: readonly string[]): McpAppFrameSiteDecision {
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const entry of declared) {
    for (const value of entry.split(" ")) {
      if (value === "") continue;
      const site = parseMcpAppFrameSite(value);
      if (!site) {
        refused.push(value);
        continue;
      }
      const canonical = formatMcpAppFrameSite(site);
      if (!accepted.includes(canonical)) accepted.push(canonical);
    }
  }
  return { accepted, refused };
}
