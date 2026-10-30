import { describe, expect, it } from "vitest";

import { makeMossCatalogSelectionRpc } from "./mossCatalogSelectionRpc.ts";

describe("Moss catalog selection RPC", () => {
  it("sends only kind and candidateId from the client and derives actor/context server-side", async () => {
    const lookups: unknown[] = [];
    const issues: unknown[] = [];
    const rpc = makeMossCatalogSelectionRpc({
      now: () => new Date("2026-08-08T00:00:00.000Z"),
      resolveCandidate: async (input) => {
        lookups.push(input);
        return {
          artifact: { url: "https://catalog.example/plugin.tgz", sha256: "a".repeat(64) },
          snapshotSha256: "b".repeat(64),
          resourceIds: ["resource-1"],
        };
      },
      issueTicket: async (input) => {
        issues.push(input);
        return { token: "ticket-1", expiresAt: "2026-08-08T00:01:00.000Z" };
      },
    });

    const result = await rpc.select(
      { kind: "plugin", candidateId: "candidate-1" },
      {
        actorId: "actor-1",
        workspaceId: "workspace-1",
        workspaceRoot: "/workspace/project",
      },
    );

    expect(result).toEqual({ token: "ticket-1", expiresAt: "2026-08-08T00:01:00.000Z" });
    expect(lookups[0]).toEqual({
      kind: "plugin",
      candidateId: "candidate-1",
      actorId: "actor-1",
      workspaceId: "workspace-1",
      workspaceRoot: "/workspace/project",
    });
    expect(issues[0]).toMatchObject({
      kind: "plugin",
      candidateId: "candidate-1",
      authenticatedActorId: "actor-1",
      artifact: { url: "https://catalog.example/plugin.tgz", sha256: "a".repeat(64) },
      selectionContext: {
        actorId: "actor-1",
        actionId: expect.any(String),
        selectedAt: "2026-08-08T00:00:00.000Z",
      },
    });
    expect(issues[0]).not.toHaveProperty("root");
  });

  it("keeps missing artifact metadata-only and rejects malformed server artifact data", async () => {
    const metadataOnly = makeMossCatalogSelectionRpc({
      resolveCandidate: async () => ({
        artifact: null,
        snapshotSha256: "b".repeat(64),
        resourceIds: [],
      }),
      issueTicket: async () => ({
        token: "metadata-ticket",
        expiresAt: "2026-08-08T00:01:00.000Z",
      }),
    });
    await expect(
      metadataOnly.select(
        { kind: "skill", candidateId: "metadata-only" },
        { actorId: "actor-1", workspaceId: "workspace-1", workspaceRoot: "/workspace/project" },
      ),
    ).resolves.toMatchObject({ token: "metadata-ticket" });

    const malformed = makeMossCatalogSelectionRpc({
      resolveCandidate: async () => ({
        artifact: { url: "http://not-https.example/a.tgz", sha256: "not-a-sha" },
        snapshotSha256: "b".repeat(64),
        resourceIds: [],
      }),
      issueTicket: async () => ({ token: "never", expiresAt: "never" }),
    });
    await expect(
      malformed.select(
        { kind: "plugin", candidateId: "bad-artifact" },
        { actorId: "actor-1", workspaceId: "workspace-1", workspaceRoot: "/workspace/project" },
      ),
    ).rejects.toMatchObject({ code: "ticket-invalid" });
  });

  it("revalidates the issued ticket against the same connection and immutable selection", async () => {
    const verified: unknown[] = [];
    const rpc = makeMossCatalogSelectionRpc({
      resolveCandidate: async () => ({
        artifact: null,
        snapshotSha256: "b".repeat(64),
        resourceIds: ["resource-1"],
      }),
      issueTicket: async () => ({ token: "ticket-1", expiresAt: "2099-08-08T00:01:00.000Z" }),
      verifyTicket: async (input) => {
        verified.push(input);
        return { valid: true };
      },
    });
    await rpc.select(
      { kind: "plugin", candidateId: "candidate-1" },
      { actorId: "actor-1", workspaceId: "workspace-1", workspaceRoot: "/workspace/project" },
    );

    await expect(
      rpc.verify({
        ticket: "ticket-1",
        ownerId: "actor-1",
        workspaceId: "workspace-1",
        workspaceRoot: "/workspace/project",
        selectionSnapshotSha256: "b".repeat(64),
        resourceIds: ["resource-1"],
        consume: false,
      }),
    ).resolves.toEqual({ valid: true });
    expect(verified[0]).toMatchObject({ consume: false, candidateId: "candidate-1" });
    await expect(
      rpc.verify({
        ticket: "ticket-1",
        ownerId: "other-actor",
        workspaceId: "workspace-1",
        workspaceRoot: "/workspace/project",
        selectionSnapshotSha256: "b".repeat(64),
        resourceIds: ["resource-1"],
      }),
    ).rejects.toMatchObject({ code: "ticket-invalid" });
  });
});
