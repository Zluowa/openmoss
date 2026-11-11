// FILE: scriptErrorDiagnostic.ts
// Purpose: Turn a browser_run worker failure into a short, host-authored
// diagnostic the agent can act on, without forwarding worker text.
// Layer: Desktop browser automation host
// Exports: describeScriptFailure
//
// Raw worker errors are never forwarded: Playwright call logs can echo typed
// values or page markup, and errors bypass the vault's output redaction. The
// diagnostic is assembled from a closed vocabulary instead — which API failed
// and how — and may quote a locator only when every string literal in it
// already appears in the agent's own script, so it can only repeat what the
// agent wrote. Anything unrecognised yields no diagnostic at all.

const MAX_LOCATOR_CHARS = 160;
const MAX_IDENTIFIER_CHARS = 64;

/** Playwright API names an agent calls from browser_run. */
const API_NAME =
  /^((?:page|locator|frame|frameLocator|keyboard|mouse|elementHandle)\.[A-Za-z]+)\b/u;

const literalsIn = (expression: string): string[] =>
  [...expression.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/gu)].map(
    (match) => match[1] ?? match[2] ?? "",
  );

/** A locator expression from the call log, if it only repeats the script. */
function echoedLocator(callLog: string, code: string): string | undefined {
  const waiting = /waiting for (.+?)\s*$/mu.exec(callLog)?.[1]?.trim();
  if (!waiting || waiting.length > MAX_LOCATOR_CHARS) return undefined;
  if (!/^(?:getBy[A-Za-z]+|locator|frameLocator|internal:)/u.test(waiting)) return undefined;
  const literals = literalsIn(waiting);
  return literals.every((literal) => literal.length > 0 && code.includes(literal))
    ? waiting
    : undefined;
}

/** The identifier, when it is one the script itself spelled. */
function echoedIdentifier(name: string | undefined, code: string): string | undefined {
  if (!name || name.length > MAX_IDENTIFIER_CHARS) return undefined;
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(name)) return undefined;
  return code.includes(name) ? name : undefined;
}

/**
 * Returns a diagnostic for a recognised failure of `code`, or undefined.
 * Never returns text the worker produced except spans the script contains.
 */
export function describeScriptFailure(error: unknown, code: string): string | undefined {
  if (typeof error !== "string") return undefined;
  // Terminal styling from runtime call logs carries no information.
  // eslint-disable-next-line no-control-regex
  const text = error.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  const api = API_NAME.exec(firstLine)?.[1];
  const locator = echoedLocator(text, code);
  const where = locator ? ` waiting for ${locator}` : "";

  if (api) {
    const timeout = /: Timeout (\d+)ms exceeded/u.exec(firstLine)?.[1];
    if (timeout) {
      return `${api} timed out after ${timeout}ms${where}. If the target exists, its role, name or frame differs: read the page outline or a scoped snapshot; if it appears later, wait for it.`;
    }
    const strict = /strict mode violation: .*? resolved to (\d+) elements/u.exec(text)?.[1];
    if (strict) {
      return `${api}: the locator matched ${strict} elements${where}. Make it unique with exact:true, a container, or .nth().`;
    }
    if (/intercepts pointer events/u.test(text)) {
      return `${api}: another element covers the target${where}. Close the overlay or dialog first (overlays.dismiss()).`;
    }
    if (/element is not (?:visible|attached)/u.test(text)) {
      return `${api}: the target is not visible${where}. Open the menu, tab or section that shows it first.`;
    }
    if (/element is not enabled|element is disabled/u.test(text)) {
      return `${api}: the target is disabled${where}. Complete the fields it depends on first.`;
    }
    if (/element is not editable|not an <input>|Element is not an/u.test(text)) {
      return `${api}: the target does not accept text${where}. Target the input itself, not its label or wrapper.`;
    }
    if (/Execution context was destroyed|because of a navigation|Frame was detached/u.test(text)) {
      return `${api}: the page navigated while this ran, so the read failed. Earlier actions completed; after a navigating click, await page.waitForLoadState() before reading, or read the returned page outline.`;
    }
    if (/Target (?:page, context or browser|closed)|has been closed/u.test(text)) {
      return `${api}: the page closed or navigated during the call. Observe the current page before acting again.`;
    }
    if (/net::(ERR_[A-Z_]+)/u.test(text)) {
      return `${api}: navigation failed (${/net::(ERR_[A-Z_]+)/u.exec(text)?.[1]}).`;
    }
  }

  const notDefined = /^(?:ReferenceError: )?([^\s]+) is not defined$/u.exec(firstLine)?.[1];
  const undefinedName = echoedIdentifier(notDefined, code);
  if (undefinedName) return `ReferenceError: ${undefinedName} is not defined in the script.`;
  const notFunction = /^(?:TypeError: )?([^\s]+) is not a function$/u.exec(firstLine)?.[1];
  const notFunctionName = echoedIdentifier(notFunction, code);
  if (notFunctionName) return `TypeError: ${notFunctionName} is not a function in the sandbox.`;
  const property =
    /^(?:TypeError: )?Cannot read properties of (null|undefined) \(reading '([^']+)'\)$/u.exec(
      firstLine,
    );
  const propertyName = echoedIdentifier(property?.[2], code);
  if (property && propertyName) {
    return `TypeError: read .${propertyName} of ${property[1]}: an earlier lookup found nothing.`;
  }
  if (/^SyntaxError\b/u.test(firstLine)) return "SyntaxError: the script does not parse.";
  if (/^Execution timed out after \d+(?:\.\d+)?s/u.test(firstLine)) {
    return "The script exceeded its time budget; earlier awaited actions may have completed. Split long work or wait on a specific element.";
  }
  return undefined;
}
