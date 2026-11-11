import {
  BrowserAutomationError,
  BrowserAutomationErrorMessages,
  BrowserFixedAutomationErrorInvariants,
  BrowserTimeoutMs,
  utf8ByteLength,
  type BrowserAutomationErrorInput,
  type BrowserMcpToolErrorEnvelope,
} from "@moss/contracts";
import { Schema } from "effect";

// Classify known fields without exposing parser issues, code or credential values.
export const browserInputErrorCode = (argumentsValue: unknown) => {
  if (
    argumentsValue !== null &&
    typeof argumentsValue === "object" &&
    "timeoutMs" in argumentsValue &&
    argumentsValue.timeoutMs !== undefined &&
    !Schema.is(BrowserTimeoutMs)(argumentsValue.timeoutMs)
  ) {
    return "BrowserInvalidTimeout" as const;
  }
  return "BrowserInvalidArguments" as const;
};

type BrowserFixedAutomationErrorCode = keyof typeof BrowserFixedAutomationErrorInvariants;
type BrowserContextualAutomationErrorInput = Exclude<
  BrowserAutomationErrorInput,
  { readonly code: BrowserFixedAutomationErrorCode }
>;

const getFixedBrowserErrorInvariant = (code: BrowserAutomationErrorInput["code"]) =>
  BrowserFixedAutomationErrorInvariants[code as BrowserFixedAutomationErrorCode];

const MAX_ERROR_DETAIL_BYTES = 1_024;
// Terminal styling from runtime call logs carries no information for a model.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/gu;

/**
 * Normalizes raw runtime text for an error's `detail`: no terminal escapes,
 * whitespace collapsed per line, and clipped on a character boundary to the
 * contract's byte bound. Empty text yields no detail.
 */
export const normalizeBrowserErrorDetail = (raw: string): string | undefined => {
  const text = raw
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!text) return undefined;
  if (utf8ByteLength(text) <= MAX_ERROR_DETAIL_BYTES) return text;
  let clipped = "";
  for (const character of text) {
    if (utf8ByteLength(`${clipped}${character}…`) > MAX_ERROR_DETAIL_BYTES) break;
    clipped += character;
  }
  return `${clipped}…`;
};

export const makeBrowserAutomationError = (
  input: BrowserAutomationErrorInput,
): BrowserAutomationError => {
  const fixedInvariant = getFixedBrowserErrorInvariant(input.code);
  const detail = input.detail === undefined ? undefined : normalizeBrowserErrorDetail(input.detail);
  const contextualInput = input as BrowserContextualAutomationErrorInput;
  const invariant = fixedInvariant ?? {
    retryable: contextualInput.retryable,
    phase: contextualInput.phase,
    effectMayHaveCommitted: contextualInput.effectMayHaveCommitted,
  };

  return Schema.decodeUnknownSync(BrowserAutomationError)({
    code: input.code,
    message: BrowserAutomationErrorMessages[input.code],
    ...invariant,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
    ...(detail === undefined ? {} : { detail }),
  });
};

export const makeBrowserMcpToolErrorEnvelope = (
  input: BrowserAutomationErrorInput,
): BrowserMcpToolErrorEnvelope => ({
  type: "moss_browser_error",
  version: 1,
  error: makeBrowserAutomationError(input),
});
