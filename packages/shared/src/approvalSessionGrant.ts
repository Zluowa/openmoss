import type { ProviderRequestKind } from "@synara/contracts";

/**
 * Whether "Always allow this session" (`acceptForSession`) on a request of this
 * kind widens the whole session, so later command and file prompts are
 * auto-approved. Server adapters enforce it and the web client mirrors it in
 * the thread's runtime mode, so both must use this one definition.
 *
 * Tool and permission-profile grants never widen the session: the provider
 * remembers that exact tool or permission set on its own channel, and widening
 * them would un-supervise commands and file changes the user never saw.
 *
 * The switch is exhaustive so a new request kind must state its blast radius.
 */
export function approvalSessionGrantWidensSessionPolicy(
  requestKind: ProviderRequestKind | undefined,
): boolean {
  switch (requestKind) {
    case "command":
    case "file-read":
    case "file-change":
      return true;
    case "permissions":
    case "tool":
    case "computer-foreground":
      return false;
    // Approvals recorded before request kinds existed were command or file
    // prompts.
    case undefined:
      return true;
  }
}

/**
 * `proposedExecpolicyAmendment` is a single-line argv. Newlines mean there is
 * no prefix rule, so the card must not offer `acceptWithExecpolicyAmendment`.
 */
export function readProposedExecpolicyAmendment(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const tokens: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return undefined;
    tokens.push(entry);
  }
  const joined = tokens.join(" ");
  if (joined.includes("\n") || joined.includes("\r")) return undefined;
  return tokens;
}
