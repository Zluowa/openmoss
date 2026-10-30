import { ServiceMap } from "effect";

export type ManagedAttachmentPrincipal =
  | { readonly ownerKind: "session"; readonly ownerId: string }
  | { readonly ownerKind: "local-loopback"; readonly ownerId: "local-loopback" }
  | { readonly ownerKind: "provider-runtime"; readonly ownerId: "codex" }
  /** A guest share's own files (ownerId is the share id), so each share has its own staging quota. */
  | { readonly ownerKind: "guest-share"; readonly ownerId: string };

export const LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL: ManagedAttachmentPrincipal = {
  ownerKind: "local-loopback",
  ownerId: "local-loopback",
};

export const CODEX_PROVIDER_RUNTIME_ATTACHMENT_PRINCIPAL: ManagedAttachmentPrincipal = {
  ownerKind: "provider-runtime",
  ownerId: "codex",
};

/**
 * Request-scoped identity used for managed binary staging and claim, and for
 * reconnectable Git action ownership.
 * It is inherited by RPC handler fibers and never enters public commands or
 * persisted orchestration events.
 */
export const CurrentManagedAttachmentPrincipal = ServiceMap.Reference<ManagedAttachmentPrincipal>(
  "moss/attachments/CurrentManagedAttachmentPrincipal",
  { defaultValue: () => LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL },
);

export function attachmentPrincipalForSession(sessionId: string): ManagedAttachmentPrincipal {
  return { ownerKind: "session", ownerId: sessionId };
}

export function attachmentPrincipalForProviderRuntime(): ManagedAttachmentPrincipal {
  return CODEX_PROVIDER_RUNTIME_ATTACHMENT_PRINCIPAL;
}

export const GUEST_SHARE_ATTACHMENT_OWNER_KIND = "guest-share";

export function attachmentPrincipalForGuestShare(shareId: string): ManagedAttachmentPrincipal {
  return { ownerKind: GUEST_SHARE_ATTACHMENT_OWNER_KIND, ownerId: shareId };
}
