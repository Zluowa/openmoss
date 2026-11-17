import { summarizeComputerAuditArgs } from "../computer/computerAuditLog.ts";

const HIDDEN_KEYS = new Set([
  "text",
  "value",
  "prompt_text",
  "headers",
  "authorization",
  "cookie",
  "password",
  "token",
  "secret",
]);
const MAX_VALUE_CHARS = 300;

/**
 * One row of an approval card. A type alias (not an interface) so it stays assignable
 * to an activity's JSON payload.
 */
export type ComputerApprovalRow = { readonly name: string; readonly value: string };

/**
 * Show an action's shape on a durable approval card without persisting input payloads.
 * The pending card reads `toolParamsDisplay` only as `{ name, value }` rows, one compact
 * line each; the work log reads the same rows.
 */
export function computerApprovalDisplayArgs(
  args: Record<string, unknown>,
): ReadonlyArray<ComputerApprovalRow> {
  const summary = summarizeComputerAuditArgs(args);
  return Object.entries(summary).flatMap(([name, value]) => {
    if (value === undefined || HIDDEN_KEYS.has(name.toLowerCase())) return [];
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    return [
      {
        name,
        value: text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text,
      },
    ];
  });
}
