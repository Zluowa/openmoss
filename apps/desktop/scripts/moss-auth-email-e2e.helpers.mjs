const AUTH_LINK_HINTS = [
  "/auth/v1/verify",
  "token=",
  "token_hash=",
  "type=signup",
  "type=recovery",
];

export function maskEmail(value) {
  const email = String(value).trim();
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return "***";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const domainSeparator = domain.indexOf(".");
  const domainName = domainSeparator === -1 ? domain : domain.slice(0, domainSeparator);
  const domainSuffix = domainSeparator === -1 ? "" : domain.slice(domainSeparator);
  return `${local.slice(0, 1)}***@${domainName.slice(0, 1)}***${domainSuffix}`;
}

export function decodeMailMarkup(value) {
  const unfolded = String(value).replace(/=\r?\n/g, "");
  const decodedQuotedPrintable = /=3d/i.test(unfolded)
    ? unfolded.replace(/=([0-9a-f]{2})/gi, (_match, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
    : unfolded;
  return decodedQuotedPrintable
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function trimLink(value) {
  return value.replace(/[),.;]+$/g, "");
}

export function extractHttpLinks(value) {
  const decoded = decodeMailMarkup(value);
  const links = [];
  const seen = new Set();
  for (const match of decoded.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const candidate = trimLink(match[0]);
    if (seen.has(candidate)) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      seen.add(candidate);
      links.push(candidate);
    } catch {
      // Ignore prose that only resembles a URL.
    }
  }
  return links;
}

export function extractAuthActionLink(value) {
  const links = extractHttpLinks(value);
  return (
    links.find((link) => {
      const normalized = link.toLowerCase();
      return AUTH_LINK_HINTS.some((hint) => normalized.includes(hint));
    }) ?? null
  );
}

export function classifyAuthMail({ subject = "", content = "" }) {
  const haystack = `${subject}\n${content}`.toLowerCase();
  if (
    haystack.includes("type=recovery") ||
    haystack.includes("reset your password") ||
    haystack.includes("password reset") ||
    haystack.includes("recover")
  ) {
    return "recovery";
  }
  if (
    haystack.includes("type=signup") ||
    haystack.includes("confirm your signup") ||
    haystack.includes("confirm your email") ||
    haystack.includes("verify your email")
  ) {
    return "signup";
  }
  return "unknown";
}

export function extractMossAuthCode(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "moss:" ||
    parsed.hostname !== "auth" ||
    parsed.pathname !== "/callback"
  ) {
    return null;
  }
  const code = parsed.searchParams.get("code")?.trim() ?? "";
  return code || null;
}

export function buildAppHashRoute(appUrl, route, search = {}) {
  if (!route.startsWith("/")) throw new Error("route must start with a slash");
  const target = new URL(appUrl);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  target.search = "";
  target.hash = `${route}${query.size > 0 ? `?${query.toString()}` : ""}`;
  return target.toString();
}

export function messageContent(value) {
  if (!value || typeof value !== "object") return "";
  const parts = [];
  const visit = (entry, key = "", depth = 0) => {
    if (depth > 5 || entry === null || entry === undefined) return;
    if (typeof entry === "string") {
      if (/subject|text|html|body|content|raw|snippet/i.test(key)) parts.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, key, depth + 1);
      return;
    }
    if (typeof entry !== "object") return;
    for (const [childKey, child] of Object.entries(entry)) {
      visit(child, childKey, depth + 1);
    }
  };
  visit(value);
  return parts.join("\n");
}

export function messageIdentity(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["ID", "id", "Id", "MessageID", "messageId", "message_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

export function messageSubject(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["Subject", "subject"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}
