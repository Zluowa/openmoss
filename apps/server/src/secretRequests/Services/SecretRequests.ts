import type {
  SecretRequestAnswerInput,
  SecretRequestErrorCode,
  SecretRequestOutcome,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

/** `queue_full` and `publish_failed` reach the asking agent; the rest answer the card. */
export type SecretRequestFailureCode = SecretRequestErrorCode | "queue_full" | "publish_failed";

export class SecretRequestError extends Schema.TaggedErrorClass<SecretRequestError>()(
  "SecretRequestError",
  {
    code: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface SecretRequestInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly label: string;
  readonly reason: string;
  readonly placeholder?: string | undefined;
  readonly waitMs: number;
}

export type SecretRequestResult =
  | {
      readonly outcome: "saved";
      /** Owner-only file holding the value; deleted once `expiresAt` passes. */
      readonly file: string;
      readonly expiresAt: string;
    }
  | { readonly outcome: Exclude<SecretRequestOutcome, "saved"> };

export interface SecretRequestsShape {
  /**
   * Shows the private card in the thread and waits for the user. Interrupting
   * the caller (Stop, a finished turn, a cancelled MCP call) closes the card
   * as cancelled, so a card never outlives the call that can deliver it.
   */
  readonly request: (
    input: SecretRequestInput,
  ) => Effect.Effect<SecretRequestResult, SecretRequestError>;
  /** The card's answer. The value goes straight to the file, never to orchestration. */
  readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
}

export class SecretRequests extends ServiceMap.Service<SecretRequests, SecretRequestsShape>()(
  "moss/secretRequests/Services/SecretRequests",
) {}
