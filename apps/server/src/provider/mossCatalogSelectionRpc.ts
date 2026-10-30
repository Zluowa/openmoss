import { randomUUID } from "node:crypto";

import type {
  MossCatalogSelectionInput,
  ProviderCatalogArtifactLocator,
  ProviderCatalogResourceKind,
  ProviderCatalogSelectionContext,
  ProviderCatalogSelectionTicket,
} from "@synara/contracts";

export class MossCatalogSelectionRpcError extends Error {
  readonly code: "ticket-invalid" | "authorization-required";

  constructor(code: "ticket-invalid" | "authorization-required", message: string) {
    super(message);
    this.name = "MossCatalogSelectionRpcError";
    this.code = code;
  }
}

export interface MossCatalogSelectionConnection {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly actionId?: string;
}

export interface MossCatalogSelectionResolvedCandidate {
  /** Null means metadata-only; it never authorizes a remote import. */
  readonly artifact?: ProviderCatalogArtifactLocator | null;
  readonly snapshotSha256: string;
  readonly resourceIds: readonly string[];
}

export interface MossCatalogSelectionRpcOptions {
  readonly now?: () => Date;
  readonly resolveCandidate: (input: {
    readonly kind: ProviderCatalogResourceKind;
    readonly candidateId: string;
    readonly actorId: string;
    readonly workspaceId: string;
    readonly workspaceRoot: string;
  }) => Promise<MossCatalogSelectionResolvedCandidate>;
  readonly issueTicket: (input: {
    readonly kind: ProviderCatalogResourceKind;
    readonly candidateId: string;
    readonly authenticatedActorId: string;
    readonly selectionContext: ProviderCatalogSelectionContext;
    readonly artifact: ProviderCatalogArtifactLocator | null;
    readonly selectionSnapshotSha256: string;
    readonly resourceIds: readonly string[];
  }) => Promise<ProviderCatalogSelectionTicket>;
  readonly verifyTicket?: (input: {
    readonly token: string;
    readonly kind: ProviderCatalogResourceKind;
    readonly candidateId: string;
    readonly authenticatedActorId: string;
    readonly selectionContext: ProviderCatalogSelectionContext;
    readonly artifact: ProviderCatalogArtifactLocator | null;
    readonly consume: boolean;
  }) => Promise<unknown>;
}

export interface MossCatalogSelectionVerificationInput {
  readonly ticket: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly selectionSnapshotSha256: string;
  readonly resourceIds: readonly string[];
  readonly consume?: boolean;
}

function assertArtifact(artifact: ProviderCatalogArtifactLocator | null): void {
  if (artifact === null) return;
  let parsed: URL;
  try {
    parsed = new URL(artifact.url);
  } catch {
    throw new MossCatalogSelectionRpcError("ticket-invalid", "Catalog artifact URL is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    Boolean(parsed.username) ||
    Boolean(parsed.password) ||
    (parsed.port !== "" && parsed.port !== "443") ||
    !/^[a-f0-9]{64}$/iu.test(artifact.sha256)
  ) {
    throw new MossCatalogSelectionRpcError(
      "ticket-invalid",
      "Catalog artifact must be a complete HTTPS URL and a 64-hex SHA-256 digest.",
    );
  }
}

export function makeMossCatalogSelectionRpc(options: MossCatalogSelectionRpcOptions) {
  const now = options.now ?? (() => new Date());
  const issued = new Map<
    string,
    {
      readonly kind: ProviderCatalogResourceKind;
      readonly candidateId: string;
      readonly actorId: string;
      readonly workspaceId: string;
      readonly workspaceRoot: string;
      readonly selectionContext: ProviderCatalogSelectionContext;
      readonly artifact: ProviderCatalogArtifactLocator | null;
      readonly selectionSnapshotSha256: string;
      readonly resourceIds: readonly string[];
      readonly expiresAt: string;
    }
  >();
  return {
    select: async (
      input: MossCatalogSelectionInput,
      connection: MossCatalogSelectionConnection,
    ): Promise<ProviderCatalogSelectionTicket> => {
      const actorId = connection.actorId.trim();
      const candidateId = input.candidateId.trim();
      if (
        !actorId ||
        !candidateId ||
        !connection.workspaceId.trim() ||
        !connection.workspaceRoot.trim()
      ) {
        throw new MossCatalogSelectionRpcError(
          "authorization-required",
          "A connection-bound actor and workspace are required for catalog selection.",
        );
      }
      const resolved = await options.resolveCandidate({
        kind: input.kind,
        candidateId,
        actorId,
        workspaceId: connection.workspaceId,
        workspaceRoot: connection.workspaceRoot,
      });
      if (!/^[a-f0-9]{64}$/iu.test(resolved.snapshotSha256)) {
        throw new MossCatalogSelectionRpcError(
          "ticket-invalid",
          "Catalog selection must resolve a bounded immutable snapshot digest.",
        );
      }
      const artifact = resolved.artifact ?? null;
      assertArtifact(artifact);
      const selectionContext: ProviderCatalogSelectionContext = {
        actionId: connection.actionId?.trim() || `catalog-selection-${randomUUID()}`,
        actorId,
        selectedAt: now().toISOString(),
      };
      const ticket = await options.issueTicket({
        kind: input.kind,
        candidateId,
        authenticatedActorId: actorId,
        selectionContext,
        artifact,
        selectionSnapshotSha256: resolved.snapshotSha256,
        resourceIds: [...resolved.resourceIds],
      });
      issued.set(ticket.token, {
        kind: input.kind,
        candidateId,
        actorId,
        workspaceId: connection.workspaceId,
        workspaceRoot: connection.workspaceRoot,
        selectionContext,
        artifact,
        selectionSnapshotSha256: resolved.snapshotSha256,
        resourceIds: [...resolved.resourceIds],
        expiresAt: ticket.expiresAt,
      });
      return ticket;
    },
    verify: async (input: MossCatalogSelectionVerificationInput): Promise<unknown> => {
      const token = input.ticket.trim();
      const binding = issued.get(token);
      if (!binding) {
        throw new MossCatalogSelectionRpcError(
          "ticket-invalid",
          "Catalog selection ticket is unknown to this server session.",
        );
      }
      if (new Date(binding.expiresAt).valueOf() <= now().valueOf()) {
        issued.delete(token);
        throw new MossCatalogSelectionRpcError(
          "ticket-invalid",
          "Catalog selection ticket expired.",
        );
      }
      const expectedResourceIds = [...binding.resourceIds].toSorted();
      const actualResourceIds = [...input.resourceIds].toSorted();
      const sameResourceIds =
        expectedResourceIds.length === actualResourceIds.length &&
        expectedResourceIds.every((resourceId, index) => resourceId === actualResourceIds[index]);
      if (
        binding.actorId !== input.ownerId ||
        binding.workspaceId !== input.workspaceId ||
        binding.workspaceRoot !== input.workspaceRoot ||
        binding.selectionSnapshotSha256 !== input.selectionSnapshotSha256 ||
        !sameResourceIds
      ) {
        throw new MossCatalogSelectionRpcError(
          "ticket-invalid",
          "Catalog selection ticket authority or immutable selection does not match.",
        );
      }
      if (!options.verifyTicket) {
        throw new MossCatalogSelectionRpcError(
          "ticket-invalid",
          "Catalog selection ticket verification is unavailable on this server.",
        );
      }
      const result = await options.verifyTicket({
        token,
        kind: binding.kind,
        candidateId: binding.candidateId,
        authenticatedActorId: binding.actorId,
        selectionContext: binding.selectionContext,
        artifact: binding.artifact,
        consume: input.consume !== false,
      });
      if (input.consume !== false) issued.delete(token);
      return result;
    },
  };
}
