import { createProjectionStore } from "./guestProjectionStore";

/** Produced solely by the service's configured proof resolver. ownerState stays private. */
export interface ProjectionPage {
  readonly mode: "share" | "site";
  readonly role: "edit" | "view" | "comment";
  readonly kind: string;
  readonly pageId: string;
  readonly scope: string | null;
  readonly actorRef: string;
  readonly grantEpoch: string;
  readonly generation: string;
  readonly revision: number;
  readonly publishedRich: string;
  readonly ownerState: Uint8Array;
}
export interface ProjectionTicket {
  readonly sessionKey: string;
  readonly epoch: string;
}
export interface ProjectionReceipt {
  readonly revision: number;
  readonly applied: boolean;
}
export type ProjectionIdentity = Omit<ProjectionPage, "publishedRich" | "ownerState">;
export interface ProjectionObservation {
  readonly revision: number;
  readonly expires: number;
  readonly check: (signal: AbortSignal) => Promise<"ready" | "refresh" | "ended" | "wait">;
  readonly listen: (wake: () => void) => () => void;
}
export interface ProjectionBackend<Proof> {
  /** Synchronous final linearization check for the real process-local mutation fence. */
  readonly currentGrantEpoch?: (page: ProjectionIdentity) => string | null;
  readonly isChanging?: () => boolean;
  readonly readIdentity?: (
    proof: Proof,
    pageId: string,
    signal: AbortSignal,
  ) => Promise<ProjectionIdentity>;
  readonly readCurrent: (
    proof: Proof,
    pageId: string,
    signal: AbortSignal,
  ) => Promise<ProjectionPage>;
  /** The adapter reauthorizes and calls map on the actual locked owner cut in the
   * transaction that commits its result. map never crosses a transport boundary. */
  readonly commitAuthorized: (
    proof: Proof,
    pageId: string,
    map: (current: ProjectionPage) => Uint8Array | null,
    signal: AbortSignal,
  ) => Promise<ProjectionReceipt>;
}
export interface GuestProjectionSessions<Proof> {
  readonly open: (
    proof: Proof,
    pageId: string,
    signal?: AbortSignal,
  ) => Promise<{ ticket: ProjectionTicket; revision: number; seed: Uint8Array }>;
  readonly read: (
    proof: Proof,
    ticket: ProjectionTicket,
  ) => Promise<{ revision: number; seed: Uint8Array }>;
  readonly submit: (
    proof: Proof,
    ticket: ProjectionTicket,
    update: Uint8Array,
    pageId?: string,
    signal?: AbortSignal,
  ) => Promise<ProjectionReceipt>;
  readonly observe: (
    proof: Proof,
    pageId: string,
    ticket: ProjectionTicket,
    signal: AbortSignal,
  ) => Promise<ProjectionObservation>;
  readonly release: (
    proof: Proof,
    pageId: string,
    ticket: ProjectionTicket,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly close: () => void;
  readonly invalidate: () => void;
}

/** Internal protocol only. Production admission and transport have separate gates. */
export function makeGuestProjectionSessions<Proof>(
  backend: ProjectionBackend<Proof>,
): GuestProjectionSessions<Proof> {
  return createProjectionStore(backend);
}
