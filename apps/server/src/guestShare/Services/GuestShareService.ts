/**
 * "Share with guest": the owner sends a one-time link; the guest watches the thread live
 * through the Moss share relay and proposes messages that wait until the owner sends or
 * dismisses each one. See `docs/guest-share.md`.
 */
import type {
  GuestMessageAttachment,
  GuestRedeemRequest,
  GuestShareCreateResult,
  GuestShareId,
  GuestShareOwnerEvent,
  GuestShareResolveMessageInput,
  GuestStreamEvent,
  GuestSubmitFields,
  ThreadId,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { GuestShareOwnerError } from "../Errors.ts";
import type { GuestUpload } from "../guestAttachments.ts";
import type { GuestRequestOperations } from "../guestRequestHandler.ts";
import type { GuestRelayRequest, GuestRelayResponse } from "../shareRelayHostClient.ts";

export interface GuestShareServiceShape extends GuestRequestOperations {
  /** Registers a share with the relay, replacing any earlier share on the thread. */
  readonly create: (
    threadId: ThreadId,
  ) => Effect.Effect<GuestShareCreateResult, GuestShareOwnerError>;
  readonly close: (threadId: ThreadId) => Effect.Effect<void, GuestShareOwnerError>;
  /** Sends a waiting guest message to the agent (at most once) or dismisses it. */
  readonly resolveMessage: (
    input: GuestShareResolveMessageInput,
  ) => Effect.Effect<void, GuestShareOwnerError>;
  /** Every share, then each change, for every thread. */
  readonly subscribe: () => Stream.Stream<GuestShareOwnerEvent, GuestShareOwnerError>;
  /** Answers one guest request the relay forwarded; never fails. */
  readonly handleGuestRequest: (request: GuestRelayRequest) => Effect.Effect<GuestRelayResponse>;
}

export class GuestShareService extends ServiceMap.Service<
  GuestShareService,
  GuestShareServiceShape
>()("moss/guestShare/Services/GuestShareService") {}

export type GuestSessionGrant = {
  readonly token: string;
  readonly shareId: GuestShareId;
};

export type GuestAttachmentFile = {
  readonly path: string;
  readonly attachment: GuestMessageAttachment;
};

export type { GuestRedeemRequest, GuestStreamEvent, GuestSubmitFields, GuestUpload };
