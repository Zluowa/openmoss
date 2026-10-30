import { describe, expect, it } from "vitest";

import type {
  ProviderCatalogArtifactLocator,
  ProviderCatalogEntry,
  ProviderCatalogFieldProvenance,
  ProviderCatalogSelectionContext,
} from "@synara/contracts";

import { MossMarketplaceSelectionTicketService } from "./mossMarketplaceSelectionTicket.ts";

const NOW = new Date("2026-08-06T00:00:00.000Z");

function provenance(): ProviderCatalogFieldProvenance {
  return {
    sourceIds: ["official"],
    sourceTiers: ["official"],
    sourceVersion: "registry-v1",
    observedAt: NOW.toISOString(),
    generation: 1,
    snapshot: "snapshot-1",
    upstreamGeneration: 1,
    upstreamSnapshot: "upstream-1",
    localGeneration: 1,
    localSnapshot: "local-1",
  };
}

function entry(): ProviderCatalogEntry {
  return {
    id: "mcp:github:example/server",
    kind: "mcp",
    name: "example/server",
    displayName: "Example Server",
    description: "Metadata only",
    tags: ["mcp"],
    sourceIds: ["official"],
    sourceTiers: ["official"],
    sourceUrl: "https://github.com/example/server",
    homepageUrl: "https://github.com/example/server",
    version: "1.0.0",
    featured: false,
    verified: false,
    compatibility: ["mcp"],
    qualityScore: 50,
    license: {
      status: "known",
      spdxId: "MIT",
      url: null,
      checkedAt: NOW.toISOString(),
    },
    activity: {
      status: "active",
      lastUpdatedAt: NOW.toISOString(),
      checkedAt: NOW.toISOString(),
    },
    security: {
      status: "needs-review",
      riskLevel: "unknown",
      permissions: ["network"],
      permissionSource: "inferred",
      signals: ["catalog-metadata-only"],
      checkedAt: NOW.toISOString(),
      executionPolicy: "never",
    },
    withdrawal: null,
    provenance: {
      identity: provenance(),
      verified: provenance(),
      featured: provenance(),
      license: provenance(),
      activity: provenance(),
      security: provenance(),
      withdrawal: null,
    },
    installPolicy: "manual-review-only",
    metadata: { source: "official" },
  };
}

const context: ProviderCatalogSelectionContext = {
  actionId: "user-select-1",
  actorId: "user-1",
  selectedAt: NOW.toISOString(),
};

describe("MossMarketplaceSelectionTicketService", () => {
  it("issues an opaque single-use ticket and verifies the unchanged catalog state", () => {
    const service = new MossMarketplaceSelectionTicketService({
      now: () => NOW,
      ttlMs: 60_000,
    });
    const issued = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
      artifact: {
        url: "https://github.com/example/server",
        sha256: "a".repeat(64),
      },
    });

    expect(issued.token).not.toContain("example/server");
    expect(issued.token).not.toContain("network");
    expect(
      service.verify({
        token: issued.token,
        currentEntry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: "https://github.com/example/server",
          sha256: "a".repeat(64),
        },
      }),
    ).toMatchObject({
      identity: "mcp:github:example/server",
      authoritativeSourceId: "official",
      authoritativeSourceTier: "official",
    });
    expect(() =>
      service.verify({
        token: issued.token,
        currentEntry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: "https://github.com/example/server",
          sha256: "a".repeat(64),
        },
      }),
    ).toThrow("SELECTION_TICKET_USED");
  });

  it("clones and freezes the explicit selection context inside ticket claims", () => {
    const service = new MossMarketplaceSelectionTicketService({
      now: () => NOW,
      ttlMs: 60_000,
    });
    const callerContext = { ...context };
    const issued = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: callerContext,
    });

    callerContext.actionId = "caller-mutated-after-issue";
    const claims = service.verify({
      token: issued.token,
      currentEntry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
    });

    expect(claims.selectionContext).toEqual(context);
    expect(Object.isFrozen(claims.selectionContext)).toBe(true);
  });

  it("allows a plan-time read without consuming the ticket before apply", () => {
    const service = new MossMarketplaceSelectionTicketService({
      now: () => NOW,
      ttlMs: 60_000,
    });
    const issued = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
    });

    expect(
      service.verify(
        {
          token: issued.token,
          currentEntry: entry(),
          authenticatedActorId: "user-1",
          selectionContext: context,
        },
        { consume: false },
      ).identity,
    ).toBe(entry().id);
    expect(
      service.verify({
        token: issued.token,
        currentEntry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
      }).identity,
    ).toBe(entry().id);
  });

  it("fails closed when the entry is withdrawn, changed, revoked, or expired", () => {
    let now = NOW;
    const service = new MossMarketplaceSelectionTicketService({
      now: () => now,
      ttlMs: 1_000,
    });
    const issued = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
    });
    const withdrawn = { entry: entry(), selectionContext: context };
    withdrawn.entry = {
      ...withdrawn.entry,
      withdrawal: {
        status: "withdrawn",
        sourceId: "official",
        sourceTier: "official",
        sourceVersion: "registry-v2",
        observedAt: NOW.toISOString(),
        generation: 2,
        snapshot: "snapshot-2",
        expiresAt: null,
      },
    };
    expect(() =>
      service.verify({
        token: issued.token,
        currentEntry: withdrawn.entry,
        authenticatedActorId: "user-1",
        selectionContext: context,
      }),
    ).toThrow("SELECTION_TICKET_STATE_CHANGED");

    const changed = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
    });
    service.revoke(changed.token);
    expect(() =>
      service.verify({
        token: changed.token,
        currentEntry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
      }),
    ).toThrow("SELECTION_TICKET_REVOKED");

    const expired = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
    });
    now = new Date(NOW.valueOf() + 1_001);
    expect(() =>
      service.verify({
        token: expired.token,
        currentEntry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
      }),
    ).toThrow("SELECTION_TICKET_EXPIRED");
  });

  it("requires the authenticated actor and consumes concurrent verification only once", async () => {
    const service = new MossMarketplaceSelectionTicketService({
      now: () => NOW,
      ttlMs: 60_000,
    });
    const issued = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
    });

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        service.verify({
          token: issued.token,
          currentEntry: entry(),
          authenticatedActorId: "user-1",
          selectionContext: context,
        }),
      ),
      Promise.resolve().then(() =>
        service.verify({
          token: issued.token,
          currentEntry: entry(),
          authenticatedActorId: "user-1",
          selectionContext: context,
        }),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "SELECTION_TICKET_USED" }),
    });
  });

  it("rejects unallowlisted artifacts, malformed hashes, and actor substitution", () => {
    const service = new MossMarketplaceSelectionTicketService({
      now: () => NOW,
      ttlMs: 60_000,
    });
    expect(() =>
      service.issue({
        entry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: "https://evil.example/payload.zip",
          sha256: "a".repeat(64),
        },
      }),
    ).toThrow("SELECTION_TICKET_ARTIFACT_INVALID");
    expect(() =>
      service.issue({
        entry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: "https://github.com/example/server",
          sha256: "not-a-sha256",
        },
      }),
    ).toThrow("SELECTION_TICKET_ARTIFACT_INVALID");
    expect(() =>
      service.issue({
        entry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: "",
          sha256: "a".repeat(64),
        },
      }),
    ).toThrow("SELECTION_TICKET_ARTIFACT_INVALID");
    expect(() =>
      service.issue({
        entry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: "https://github.com/example/server",
          sha256: "",
        },
      }),
    ).toThrow("SELECTION_TICKET_ARTIFACT_INVALID");

    const issued = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
    });
    expect(() =>
      service.verify({
        token: issued.token,
        currentEntry: entry(),
        authenticatedActorId: "attacker",
        selectionContext: context,
      }),
    ).toThrow("SELECTION_TICKET_AUTH_REQUIRED");
  });

  it("requires null or a complete artifact and fingerprints every downstream mutable field", () => {
    const service = new MossMarketplaceSelectionTicketService({
      now: () => NOW,
      ttlMs: 60_000,
    });
    const completeArtifact = {
      url: "https://github.com/example/server",
      sha256: "a".repeat(64),
    };

    expect(() =>
      service.issue({
        entry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: null,
          sha256: completeArtifact.sha256,
        } as unknown as ProviderCatalogArtifactLocator,
      }),
    ).toThrow("SELECTION_TICKET_ARTIFACT_INVALID");
    expect(() =>
      service.issue({
        entry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: {
          url: completeArtifact.url,
          sha256: null,
        } as unknown as ProviderCatalogArtifactLocator,
      }),
    ).toThrow("SELECTION_TICKET_ARTIFACT_INVALID");

    const nullArtifact = service.issue({
      entry: entry(),
      authenticatedActorId: "user-1",
      selectionContext: context,
      artifact: null,
    });
    expect(
      service.verify({
        token: nullArtifact.token,
        currentEntry: entry(),
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: null,
      }).artifact,
    ).toBeNull();

    const original = entry();
    const mutations: readonly ProviderCatalogEntry[] = [
      { ...original, name: "changed-name" },
      { ...original, sourceUrl: "https://github.com/other/server" },
      { ...original, version: "2.0.0" },
      { ...original, compatibility: ["mcp", "stdio"] },
      { ...original, metadata: { source: "changed" } },
      { ...original, security: { ...original.security, status: "source-reviewed" } },
      { ...original, license: { ...original.license, status: "unknown", spdxId: null } },
      {
        ...original,
        provenance: {
          ...original.provenance,
          identity: { ...original.provenance.identity, snapshot: "changed-snapshot" },
        },
      },
    ];

    for (const mutated of mutations) {
      const issued = service.issue({
        entry: original,
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: completeArtifact,
      });
      expect(() =>
        service.verify({
          token: issued.token,
          currentEntry: mutated,
          authenticatedActorId: "user-1",
          selectionContext: context,
          artifact: completeArtifact,
        }),
      ).toThrow("SELECTION_TICKET_STATE_CHANGED");
    }

    const artifactMutation = service.issue({
      entry: original,
      authenticatedActorId: "user-1",
      selectionContext: context,
      artifact: completeArtifact,
    });
    expect(() =>
      service.verify({
        token: artifactMutation.token,
        currentEntry: original,
        authenticatedActorId: "user-1",
        selectionContext: context,
        artifact: { ...completeArtifact, sha256: "b".repeat(64) },
      }),
    ).toThrow("SELECTION_TICKET_STATE_CHANGED");
  });
});
