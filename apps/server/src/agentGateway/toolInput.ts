import {
  MossCreateThreadsInput,
  MossWaitForThreadsInput,
  ModelSelection,
  SUPPORTED_PROVIDER_KINDS,
  type ProviderKind,
} from "@synara/contracts";
import { Schema } from "effect";

import { getDefaultModel } from "@synara/shared/model";

import { AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION } from "./targetResolver.ts";

export const PROVIDER_KINDS: ReadonlyArray<ProviderKind> = SUPPORTED_PROVIDER_KINDS;

export const MODEL_SELECTION_INPUT_SCHEMA = {
  type: "object",
  description: AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  properties: {
    provider: { type: "string", enum: [...PROVIDER_KINDS] },
    instanceId: {
      type: "string",
      description:
        "Exact provider instance ID from moss_capabilities providers[].instances[].instanceId. Omit to use the provider's default account.",
    },
    model: {
      type: "string",
      description: "Exact model slug from moss_capabilities providers[].models[].slug.",
    },
    options: {
      type: "object",
      description: AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
    },
  },
  required: ["provider", "model"],
  additionalProperties: false,
} as const;

export class ToolInputError extends Error {}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function readStringArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean },
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (options?.required) throw new ToolInputError(`Missing required argument "${name}".`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`Argument "${name}" must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * A string argument taken exactly as written, with no trimming.
 *
 * `readStringArg` trims, which is right for an identifier and wrong for an
 * accessibility label: the desktop targeters match labels verbatim on purpose
 * (`uiTreeTargeting.ts` — "labels keep their surrounding space because nothing
 * trims a label arriving over MCP"), so trimming here silently retargeted a
 * caller that named `"Save "` at a different control called `"Save"`.
 *
 * Still refuses a blank string: a label made only of spaces names nothing, and
 * passing it on would match everything in scope.
 */
export function readVerbatimStringArg(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`Argument "${name}" must be a non-empty string.`);
  }
  return value;
}

export function readNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`Argument "${name}" must be a number.`);
  }
  return value;
}

export function readBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolInputError(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

export function readIsoTimestampArg(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = readStringArg(args, name);
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ToolInputError(`Argument "${name}" must be a valid ISO timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

export function readRecordArg(
  args: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function readStringArrayArg(
  args: Record<string, unknown>,
  name: string,
): ReadonlyArray<string> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new ToolInputError(`Argument "${name}" must be an array of non-empty strings.`);
  }
  return value.map((entry) => (entry as string).trim());
}

export function parseProviderKind(raw: string): ProviderKind {
  if ((PROVIDER_KINDS as ReadonlyArray<string>).includes(raw)) {
    return raw as ProviderKind;
  }
  throw new ToolInputError(
    `Unknown provider "${raw}". Supported providers: ${PROVIDER_KINDS.join(", ")}.`,
  );
}

/**
 * Read a model-selection target argument through the canonical contract
 * decoder. Legacy `{ provider, ... }` records are normalized to the
 * instance-routed selection at the wire boundary.
 */
export function readModelSelectionArg(
  args: Record<string, unknown>,
  name: string,
): ModelSelection | undefined {
  const raw = readRecordArg(args, name);
  if (raw === undefined) return undefined;
  try {
    // This is a new work target, not a persisted-history decoder. Do not
    // normalize a retired explicit driver into another provider silently.
    if (typeof raw.provider === "string") parseProviderKind(raw.provider);
    const decoded = Schema.decodeUnknownSync(ModelSelection)(raw);
    parseProviderKind(decoded.provider);
    // The per-provider option structs strip unknown keys during decode; merge
    // the raw record back so resolveAgentGatewayTarget rejects typos with its
    // coded error instead of the keys being silently dropped.
    if (raw.options !== null && typeof raw.options === "object" && !Array.isArray(raw.options)) {
      const decodedOptions = (decoded as { readonly options?: unknown }).options;
      const mergedOptions = {
        ...(raw.options as Record<string, unknown>),
        ...(decodedOptions !== null &&
        typeof decodedOptions === "object" &&
        !Array.isArray(decodedOptions)
          ? (decodedOptions as Record<string, unknown>)
          : {}),
      };
      if (Object.keys(mergedOptions).length > 0) {
        return { ...decoded, options: mergedOptions } as ModelSelection;
      }
    }
    return decoded;
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    throw new ToolInputError(`Invalid model selection "${name}": ${errorText(error)}`);
  }
}

export function buildModelSelection(
  provider: ProviderKind,
  model: string | undefined,
  fallbackSelection?: ModelSelection,
): ModelSelection {
  // Explicit argument wins, then the caller's own thread model, and only then
  // the provider default — an agent on a non-default model must not silently
  // spawn work on that provider's default model.
  const inherited = fallbackSelection?.provider === provider ? fallbackSelection : undefined;
  const effectiveModel = model ?? inherited?.model ?? getDefaultModel(provider) ?? undefined;
  if (!effectiveModel) {
    throw new ToolInputError(
      `Provider "${provider}" has no default model; pass an explicit "model" argument.`,
    );
  }
  return {
    ...inherited,
    provider,
    model: effectiveModel,
    ...(model !== undefined && model !== inherited?.model ? { options: undefined } : {}),
  } as ModelSelection;
}

export function decodeCreateThreadsInput(value: unknown) {
  try {
    return Schema.decodeUnknownSync(MossCreateThreadsInput)(value);
  } catch (error) {
    throw new ToolInputError(`Invalid Moss creation plan: ${errorText(error)}`);
  }
}

export function decodeWaitForThreadsInput(value: unknown) {
  try {
    return Schema.decodeUnknownSync(MossWaitForThreadsInput)(value);
  } catch (error) {
    throw new ToolInputError(`Invalid Moss wait request: ${errorText(error)}`);
  }
}
