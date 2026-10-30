import {
  SECRET_REQUEST_DEFAULT_WAIT_MS,
  SECRET_REQUEST_LABEL_MAX_LENGTH,
  SECRET_REQUEST_MAX_WAIT_MS,
  SECRET_REQUEST_REASON_MAX_LENGTH,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect } from "effect";

import type { SecretRequestsShape } from "../secretRequests/Services/SecretRequests.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readNumberArg, readStringArg } from "./toolInput.ts";
import type { ToolEntry } from "./toolRuntime.ts";

const MIN_WAIT_MS = 1_000;

export interface SecretRequestToolsInput {
  readonly secretRequests: Pick<SecretRequestsShape, "request">;
}

function readBoundedString(
  args: Record<string, unknown>,
  name: string,
  maxLength: number,
  options?: { readonly required?: boolean },
): string | undefined {
  const value = readStringArg(args, name, options);
  if (value !== undefined && value.length > maxLength) {
    throw new ToolInputError(`Argument "${name}" must be at most ${maxLength} characters.`);
  }
  return value;
}

function readRequestFields(args: Record<string, unknown>) {
  const timeoutMs = readNumberArg(args, "timeoutMs");
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_WAIT_MS ||
      timeoutMs > SECRET_REQUEST_MAX_WAIT_MS)
  ) {
    throw new ToolInputError(
      `Argument "timeoutMs" must be an integer from ${MIN_WAIT_MS} to ${SECRET_REQUEST_MAX_WAIT_MS}.`,
    );
  }
  return {
    label: readBoundedString(args, "label", SECRET_REQUEST_LABEL_MAX_LENGTH, { required: true })!,
    reason: readBoundedString(args, "reason", SECRET_REQUEST_REASON_MAX_LENGTH, {
      required: true,
    })!,
    placeholder: readBoundedString(args, "placeholder", SECRET_REQUEST_LABEL_MAX_LENGTH),
    waitMs: timeoutMs ?? SECRET_REQUEST_DEFAULT_WAIT_MS,
  };
}

const NOT_SAVED_MESSAGES = {
  declined: "The user chose not to provide it.",
  cancelled: "The request ended with your turn.",
  timed_out: "The user did not answer in time.",
} as const;

/** `moss_request_secret`: the private "Save securely" card, ported from T3 Code's request_secret. */
export function makeAgentGatewaySecretRequestTools(
  input: SecretRequestToolsInput,
): ReadonlyArray<ToolEntry> {
  const requestSecret: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "moss_request_secret",
      description:
        'Ask the user to enter a secret (API key, token, password) in a private card in this chat, then wait for the answer. You never see the value. When saved, `file` is an owner-only file holding it: read it only inside a shell command, e.g. TOKEN="$(cat <file>)" wrangler whoami, and never print, log, or commit it. The file is deleted after 24 hours. Whenever you need a secret from the user, call this instead of asking for it in chat, and never invent one. After declined, cancelled, or timed_out, ask again only if it is still needed.',
      inputSchema: {
        type: "object",
        properties: {
          label: {
            type: "string",
            maxLength: SECRET_REQUEST_LABEL_MAX_LENGTH,
            description: "Card title, such as 'Cloudflare API token'.",
          },
          reason: {
            type: "string",
            maxLength: SECRET_REQUEST_REASON_MAX_LENGTH,
            description: "What it is for and exactly where the user can create or find it.",
          },
          placeholder: {
            type: "string",
            maxLength: SECRET_REQUEST_LABEL_MAX_LENGTH,
            description: "Optional input hint, such as 'ghp_...'.",
          },
          timeoutMs: {
            type: "integer",
            minimum: MIN_WAIT_MS,
            maximum: SECRET_REQUEST_MAX_WAIT_MS,
            description: "How long to wait for the user. Default 10 minutes, at most 1 hour.",
          },
        },
        required: ["label", "reason"],
        additionalProperties: false,
      },
      annotations: {
        title: "Request a secret from the user",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const fields = yield* Effect.try({
          try: () => readRequestFields(args),
          catch: (error) =>
            error instanceof ToolInputError
              ? error
              : new ToolInputError(`Invalid tool input: ${errorText(error)}`),
        });
        const result = yield* input.secretRequests.request({
          threadId: ThreadId.makeUnsafe(context.callerThreadId),
          turnId: context.callerTurnId === null ? null : TurnId.makeUnsafe(context.callerTurnId),
          ...fields,
        });
        return mcpToolResultJson(
          result.outcome === "saved"
            ? { status: "saved", file: result.file, expiresAt: result.expiresAt }
            : { status: result.outcome, message: NOT_SAVED_MESSAGES[result.outcome] },
        );
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };
  return [requestSecret];
}
