// FILE: webMcpApprovalDisplay.ts
// Purpose: The rows an approval card shows for one page-declared WebMCP call, and the one
//          rule for what counts as a site origin Moss may show in its own words.
// Layer: Agent gateway
// Why: the person decides with the site, the page's tool and its arguments in view. The
//      card reads `toolParamsDisplay` as `{ name, value }` rows. The tool name and
//      arguments come from the page and the agent: shown as data, bounded, with
//      secret-looking fields hidden.

import type { WebMcpCallApprovalRequest } from "./browserTools.ts";

const MAX_ARGUMENTS_CHARS = 1_500;
const SECRET_KEY = /pass(word)?|secret|token|cookie|authori[sz]ation|api[-_]?key|credential/iu;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > 300 ? `${value.slice(0, 299)}…` : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, child]) => [key, SECRET_KEY.test(key) ? "(hidden)" : redact(child, depth + 1)]),
  );
}

/**
 * An http(s) origin exactly as `URL` writes it, or null. Anything else (a sentence after
 * the host, a path, another scheme) is not a site Moss names in its own text.
 */
export function strictWebOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A type alias, not an interface, so it stays assignable to an activity's JSON payload. */
export type WebMcpApprovalRow = {
  readonly name: "site" | "pageTool" | "arguments";
  readonly value: string;
};

/** The card's rows, in the order a person reads them: site, the page's tool, its arguments. */
export function webMcpApprovalDisplay(
  request: WebMcpCallApprovalRequest,
): ReadonlyArray<WebMcpApprovalRow> {
  const serialized = JSON.stringify(redact(request.arguments)) ?? "{}";
  return [
    { name: "site", value: request.origin },
    { name: "pageTool", value: request.toolName ?? "(not from this chat's last discovery)" },
    {
      name: "arguments",
      value:
        serialized.length <= MAX_ARGUMENTS_CHARS
          ? serialized
          : `${serialized.slice(0, MAX_ARGUMENTS_CHARS - 1)}…`,
    },
  ];
}
