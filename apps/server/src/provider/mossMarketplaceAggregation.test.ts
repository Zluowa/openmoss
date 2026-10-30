import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";

import {
  MossMarketplaceAggregation,
  createMossMarketplaceInMemoryRevisionChainStore,
  type MossMarketplaceAggregationOptions,
} from "./mossMarketplaceAggregation.ts";
import * as MarketplaceSources from "./mossMarketplaceAggregationSources.ts";
import {
  createMossMarketplacePinnedHttpsFetch,
  createMossMarketplaceResolvedFetch,
  createMossMarketplaceSources,
  type MossMarketplaceCandidate,
  type MossMarketplacePinnedRequestOptions,
  type MossMarketplaceResolvedFetch,
  type MossMarketplaceGitRevision,
  type MossMarketplaceSourceOptions,
  type MossMarketplaceSourceAdapter,
} from "./mossMarketplaceAggregationSources.ts";

const NOW = new Date("2026-08-06T00:00:00.000Z");

// Ephemeral local HTTPS fixture. The resolver below returns a public test
// address while the branded transport maps that verified address to this
// loopback listener; loopback itself remains rejected by production DNS
// policy. The request still performs real TLS, SNI, Host, and redirect work.
const LOCAL_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3cmVabinfLweG
KYbcguFQXt2Euk7zEPI8BqV+iFa+wPwIw8i0JI8iLZijMhenttRG4Y61ojeNS4O0
nMLoRqugz+svIWYJzGBuDuHoqq+i4A/XNaoEgKNM0ToXZmwOuKAMOp26StFRaSU0
SoITXod80IawBZLPvlaIB7lsgsu9o6Uxlc/2vkESP9dH1D0KD3iR78yyshgH/itB
XiN/092RJmphb/RCXvXk2iFppgbSEW8f4Q0AcjqqAL7FplXSb0pdWy1FauRbuIJG
LinK+f4bCSYWbADdcw67yRWVQiIvKV5kc0EZTpAfHPSzKHplvUTI+lgb5eQ5Ce1z
LjGkJc3JAgMBAAECggEAVL8gW3pxFY3gZ/ZfOxerhzmMFHkNZ/T4MwrPAXlyuYTl
6haobbBF/4AY96t4ih5ISsaA6yAZkcjE+3dAA5ZCS3RCLe+79+LW2YE+lAHmSdRA
/SbpeFMFHcO6lnzWhqZ8Kaoam6lcscNlUJbrKI+O//ZFgqPQgvBngUgwPRTfkqdx
xlv4aP/7gHvD4Em0dZPdOT+tzQ1WEBLrJJ2UuPZ0dVqXIdpd6XaDP3AAVhxvhV4Q
28eoo4H1KmXIUFidNdHI6aH+6rQJh0qAtixgQD54YzK+4rYDZ15js/tOOA8lsnzn
puS1OKjpMTg3d9B9XhtRl59sPQ7xNB8W3vKmIwhzEQKBgQDu8Vs4D06BQPshoB1H
Taw3xOwam1/Zps0dhQXa+JSGs2zmgVB6TpM3NxUYGXIbISbLmswctSpYsVs3PQux
alyfL64MOhufvcYduUNMRDTHeh+4jZPzyT6sfXW6Oxd31A8SINpc+ok6HTMHErTg
QIyeOmnDeUCS6t7qOQuc/UczwwKBgQDEitwSIRDxBldxrBB7Gk8jmldYjsEwGENB
sMWEgeBsG6k+GLqE6YKmLM/lLGDslsrcZKRXUs0aP5ShFc3Epv2bsVrvwmXb+hQD
EbpYBm0RRlfoQ0xHrlnVL1nMW4IMDeYGSaX6s6v8zOcMKvzPBWzbS2tPS7rPMwpI
ARBxXHBbgwKBgQCebDAKzztBv4/CD6LZ78nLgCj6yyGV8V31wIjNUhtH5BbEDeEJ
9qbs6Px3ageZrTVHsW67afKVs6HC0hq6msamVLqVKMG/+9crRfY0ztQfnf0CI/yA
mmGPg+9Wdm9s55DGeDnPg90QRuPaQLDkLmgNULVnATGrN0ZtDT2B7PwUeQKBgBmQ
JgeFnXp75Ku4QXyBc4Gh9XJjPuVOgpDsuQP/EH1/K4gUF05qQL/0XCXmm8Sp6EC6
JlXlQyAC3QYGm/jT73BspPNCSZVO9YNgruf8DfuNNqnS9vzrxGth+UAHNubyd9Sh
h6EP9XKwA+0lOjSC9CGhsZditi106gVrfgQAjeyZAoGBANhoGQEVoanwCxJk5eUF
5+xqfXrjWJgNv4O+C0SSMUYNEBQGLxXvaJeVIIOobYrqbfwVBd3A0R+xrWOHi1Bs
18PueoJ8R6lVt52/m/Xc7K4ok7zQ/2pj7tB3VB1B/i+hAj4xTH64E7JTF5cUvNu/
TKBe2h5A6V4TMDQsZqkvf9jB
-----END PRIVATE KEY-----`;
const LOCAL_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDDjCCAfagAwIBAgIJAPQhOb85Phf0MA0GCSqGSIb3DQEBCwUAMCsxKTAnBgNV
BAMMIHJlZ2lzdHJ5Lm1vZGVsY29udGV4dHByb3RvY29sLmlvMB4XDTI2MDgwNjIx
NTEyMVoXDTM2MDgwMzIxNTEyMVowKzEpMCcGA1UEAwwgcmVnaXN0cnkubW9kZWxj
b250ZXh0cHJvdG9jb2wuaW8wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIB
AQC3cmVabinfLweGKYbcguFQXt2Euk7zEPI8BqV+iFa+wPwIw8i0JI8iLZijMhen
ttRG4Y61ojeNS4O0nMLoRqugz+svIWYJzGBuDuHoqq+i4A/XNaoEgKNM0ToXZmwO
uKAMOp26StFRaSU0SoITXod80IawBZLPvlaIB7lsgsu9o6Uxlc/2vkESP9dH1D0K
D3iR78yyshgH/itBXiN/092RJmphb/RCXvXk2iFppgbSEW8f4Q0AcjqqAL7FplXS
b0pdWy1FauRbuIJGLinK+f4bCSYWbADdcw67yRWVQiIvKV5kc0EZTpAfHPSzKHpl
vUTI+lgb5eQ5Ce1zLjGkJc3JAgMBAAGjNTAzMDEGA1UdEQQqMCiCIHJlZ2lzdHJ5
Lm1vZGVsY29udGV4dHByb3RvY29sLmlvhwR/AAABMA0GCSqGSIb3DQEBCwUAA4IB
AQBWh+0wa+FBhxDs5f745AyE/WJdPycADGRqEhxFdIdcNLnD+S8oGC5fQymFsJa7
zm7K+aQeT5d8EvsdsWPKvfjIdPdEw/4WZx0xWIs6eBqKIsdh/7hIkcSyFeepHADG
c4x3uaPTkSAc8Np6lpPVXd3uhIbAYjyCXXzbSzhZ5LOwaARaDe3nOHdgIzU5Ot4h
vdyXXGR6uVniZiRA/ZV6yDmvJGwWwTR9mBWxPeeo0kVZoAbJVAOXSFhNkml4DmiA
pIyx90tFlRUsuqnV17QE3YrBnvlJPqrRuzBlntCqEJIp3ELGUsglSBdYW+jWBFj8
YFbP75i0tvXS+1avyFfhS0gs
-----END CERTIFICATE-----`;

function candidate(
  identity: string,
  overrides: Partial<MossMarketplaceCandidate> = {},
): MossMarketplaceCandidate {
  return {
    identity,
    kind: "mcp",
    name: identity.split(":").pop() ?? identity,
    description: "A catalog entry with enough metadata to be searchable.",
    compatibility: ["mcp"],
    ...overrides,
  };
}

function source(
  input: Pick<MossMarketplaceSourceAdapter, "id" | "label" | "tier" | "supportedKinds"> &
    Partial<Pick<MossMarketplaceSourceAdapter, "enabled" | "disabledReason">>,
  fetchPage: MossMarketplaceSourceAdapter["fetchPage"],
): MossMarketplaceSourceAdapter {
  return {
    ...input,
    enabled: input.enabled ?? true,
    fetchPage,
  };
}

function aggregation(
  options: Omit<MossMarketplaceAggregationOptions, "now">,
): MossMarketplaceAggregation {
  return new MossMarketplaceAggregation({ ...options, now: () => NOW });
}

function createTestMossMarketplaceSources(
  options: MossMarketplaceSourceOptions = {},
): readonly MossMarketplaceSourceAdapter[] {
  const fetcher = options.fetch;
  return createMossMarketplaceSources({
    ...options,
    fetchResolved:
      options.fetchResolved ??
      (fetcher
        ? createMossMarketplaceResolvedFetch(async ({ url, init }) => fetcher(url, init))
        : undefined),
  });
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), init);
}

interface TestGithubRevision {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly committedAt: string;
  readonly parents?: readonly string[];
}

interface TestRevisionRecord {
  readonly sourceId: string;
  readonly generation: number;
  readonly revision: {
    readonly commitSha: string;
    readonly treeSha: string;
    readonly parents: readonly string[];
  };
}

function githubCommitPayload(revision: TestGithubRevision): Record<string, unknown> {
  return {
    sha: revision.commitSha,
    parents: (revision.parents ?? []).map((sha) => ({
      sha,
      url: `https://api.github.com/commits/${sha}`,
    })),
    commit: {
      committer: { date: revision.committedAt },
      tree: { sha: revision.treeSha },
    },
  };
}

function revisionPageSource(input: {
  readonly id: string;
  readonly revision: MossMarketplaceGitRevision;
  readonly candidateId: string;
  readonly gate?: Promise<void> | undefined;
}): MossMarketplaceSourceAdapter {
  return source(
    {
      id: input.id,
      label: input.id,
      tier: "official",
      supportedKinds: ["mcp"],
    },
    async ({ previousRevision }) => {
      if (input.gate) await input.gate;
      return {
        candidates: [candidate(input.candidateId)],
        nextCursor: null,
        sourceVersion: input.revision.commitSha,
        snapshot: `git-commit:${input.revision.commitSha}:git-tree:${input.revision.treeSha}`,
        revision: input.revision,
        revisionProof: previousRevision
          ? {
              relation: "direct-parent" as const,
              previousCommitSha: previousRevision.commitSha,
            }
          : { relation: "initial" as const, previousCommitSha: null },
        complete: true,
        truncated: false,
        partial: false,
        fullSnapshot: true,
      };
    },
  );
}

describe("MossMarketplaceAggregation", () => {
  it("fetches remote pages on demand, deduplicates stable identities, and paginates", async () => {
    const calls: string[] = [];
    const official = source(
      {
        id: "official",
        label: "Official",
        tier: "official",
        supportedKinds: ["mcp"],
      },
      async ({ cursor }) => {
        calls.push(`official:${cursor ?? "first"}`);
        if (!cursor) {
          return {
            candidates: [
              candidate("mcp:shared", {
                name: "shared-official",
                verified: true,
                featured: true,
                license: { status: "known", spdxId: "MIT", url: null },
                activity: { status: "active", lastUpdatedAt: NOW.toISOString() },
                security: { status: "source-reviewed", signals: ["official"] },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 1,
            snapshot: "official-1",
            nextCursor: "page-2",
          };
        }
        return {
          candidates: [candidate("mcp:later", { name: "later" })],
          complete: true,
          truncated: false,
          partial: false,
          generation: 1,
          snapshot: "official-1",
          fullSnapshot: true,
          nextCursor: null,
        };
      },
    );
    const discovery = source(
      {
        id: "discovery",
        label: "Discovery",
        tier: "discovery",
        supportedKinds: ["mcp"],
      },
      async () => ({
        candidates: [
          candidate("mcp:shared", {
            name: "shared-discovery",
            security: { status: "needs-review", signals: ["discovery"] },
          }),
        ],
        nextCursor: null,
      }),
    );

    const catalog = aggregation({ sources: [official, discovery] });
    const first = await catalog.browse({
      kind: "mcp",
      query: { limit: 1, sort: "quality" },
    });

    expect(calls).toEqual(["official:first", "official:page-2"]);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      id: "mcp:shared",
      sourceIds: ["discovery", "official"],
      sourceTiers: ["official", "discovery"],
      verified: true,
      featured: true,
      installPolicy: "manual-review-only",
      security: { status: "needs-review", executionPolicy: "never" },
    });
    expect(first.nextCursor).toBeTruthy();

    const second = await catalog.browse({
      kind: "mcp",
      query: { limit: 1, sort: "quality", cursor: first.nextCursor ?? undefined },
    });

    expect(calls).toEqual(["official:first", "official:page-2"]);
    expect(second.entries[0]?.id).toBe("mcp:later");
  });

  it("serves cached pages and isolates one source failure from healthy sources", async () => {
    let goodCalls = 0;
    const good = source(
      {
        id: "good",
        label: "Good",
        tier: "curated",
        supportedKinds: ["skill"],
      },
      async () => {
        goodCalls += 1;
        return {
          candidates: [
            candidate("skill:good", {
              kind: "skill",
              name: "good-skill",
              compatibility: ["codex", "agent-skill"],
            }),
          ],
          nextCursor: null,
        };
      },
    );
    const broken = source(
      {
        id: "broken",
        label: "Broken",
        tier: "aggregator",
        supportedKinds: ["skill"],
      },
      async () => {
        throw new Error("upstream unavailable");
      },
    );
    const catalog = aggregation({ sources: [good, broken] });

    const first = await catalog.browse({ kind: "skill", query: { limit: 10 } });
    const second = await catalog.browse({ kind: "skill", query: { limit: 10 } });

    expect(first.entries.map((entry) => entry.id)).toEqual(["skill:good"]);
    expect(first.sources.find((status) => status.id === "broken")?.error).toBe(
      "SOURCE_FETCH_FAILED",
    );
    expect(goodCalls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.sources.find((status) => status.id === "good")?.cached).toBe(true);
  });

  it("filters license, verification, compatibility, and stale entries without weakening safety", async () => {
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "curated",
            label: "Curated",
            tier: "curated",
            supportedKinds: ["plugin"],
          },
          async () => ({
            candidates: [
              candidate("plugin:verified", {
                kind: "plugin",
                name: "verified-plugin",
                verified: true,
                license: { status: "known", spdxId: "Apache-2.0" },
                compatibility: ["claude-code", "plugin"],
              }),
              candidate("plugin:unknown", {
                kind: "plugin",
                name: "unknown-plugin",
                verified: false,
                license: { status: "unknown" },
                activity: { status: "stale", lastUpdatedAt: "2024-01-01T00:00:00.000Z" },
              }),
            ],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({
      kind: "plugin",
      query: {
        compatibility: "claude-code",
        licenseSpdxIds: ["Apache-2.0"],
        verifiedOnly: true,
        includeStale: false,
      },
    });

    expect(result.entries.map((entry) => entry.name)).toEqual(["verified-plugin"]);
    expect(result.entries[0]?.security.executionPolicy).toBe("never");
    expect(result.entries[0]?.security.permissions).toEqual(["unknown"]);
    expect(result.entries[0]?.installPolicy).toBe("manual-review-only");
  });

  it("keeps an authoritative tombstone from being resurrected by discovery", async () => {
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:shared", {
                withdrawal: {
                  status: "deleted",
                  sourceVersion: "registry-v7",
                  observedAt: NOW.toISOString(),
                  generation: 7,
                  snapshot: "official-snapshot-7",
                },
              }),
            ],
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate("mcp:shared", { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(result.entries).toEqual([]);
    expect(result.totalKnown).toBe(0);
  });

  it("applies loaded authoritative tombstones even when a view scopes sources", async () => {
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:scoped", {
                withdrawal: {
                  status: "deleted",
                  sourceVersion: "registry-v10",
                  observedAt: NOW.toISOString(),
                  generation: 10,
                  snapshot: "official-scoped-10",
                },
              }),
            ],
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate("mcp:scoped", { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    const scoped = await catalog.browse({
      kind: "mcp",
      query: { sourceIds: ["discovery"], limit: 10 },
    });
    expect(scoped.entries).toEqual([]);
  });

  it("loads the authoritative negative ledger before the first source-scoped view", async () => {
    let officialCalls = 0;
    let discoveryCalls = 0;
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => {
            officialCalls += 1;
            return {
              candidates: [
                candidate("mcp:first-discovery", {
                  withdrawal: {
                    status: "deleted",
                    generation: 11,
                    snapshot: "official-first-discovery-11",
                  },
                }),
              ],
              generation: 11,
              snapshot: "official-first-discovery-11",
              nextCursor: null,
            };
          },
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => {
            discoveryCalls += 1;
            return {
              candidates: [
                candidate("mcp:first-discovery", {
                  activity: { status: "active" },
                }),
              ],
              nextCursor: null,
            };
          },
        ),
      ],
    });

    const first = await catalog.browse({
      kind: "mcp",
      query: { sourceIds: ["discovery"], limit: 10 },
    });

    expect(first.entries).toEqual([]);
    expect(officialCalls).toBe(1);
    expect(discoveryCalls).toBe(1);
  });

  it("quarantines only the overflowing source and releases it only after a full authoritative snapshot", async () => {
    let now = NOW;
    let badCalls = 0;
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      maxTombstones: 1,
      now: () => now,
      sources: [
        source(
          {
            id: "bad-authority",
            label: "Bad authority",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => {
            badCalls += 1;
            return badCalls === 1
              ? {
                  candidates: [
                    candidate("mcp:bad-a", {
                      withdrawal: { status: "deleted", generation: 1, snapshot: "bad-a" },
                    }),
                    candidate("mcp:bad-b", {
                      withdrawal: { status: "deleted", generation: 1, snapshot: "bad-b" },
                    }),
                  ],
                  complete: true,
                  truncated: false,
                  partial: false,
                  generation: 1,
                  snapshot: "bad-full-1",
                  fullSnapshot: true,
                  nextCursor: null,
                }
              : {
                  candidates: [
                    candidate("mcp:bad-a", { activity: { status: "active" } }),
                    candidate("mcp:bad-b", { activity: { status: "active" } }),
                  ],
                  sourceVersion: "v2",
                  generation: 2,
                  snapshot: "bad-full-2",
                  complete: true,
                  truncated: false,
                  partial: false,
                  fullSnapshot: true,
                  nextCursor: null,
                };
          },
        ),
        source(
          {
            id: "healthy",
            label: "Healthy",
            tier: "curated",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate("mcp:healthy", { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    const first = await catalog.browse({ kind: "mcp", query: { limit: 10 } });
    expect(first.entries).toEqual([]);
    expect(first.sources.find((status) => status.id === "bad-authority")?.error).toBe(
      "SOURCE_TOMBSTONE_CAPACITY",
    );
    expect(catalog.getCacheStats().tombstones).toBe(1);

    now = new Date(NOW.valueOf() + 1_001);
    const released = await catalog.browse({ kind: "mcp", query: { limit: 10 } });
    expect(released.entries.map((entry) => entry.id)).toEqual([
      "mcp:bad-a",
      "mcp:bad-b",
      "mcp:healthy",
    ]);
    expect(released.sources.find((status) => status.id === "bad-authority")?.error).toBeNull();
    expect(badCalls).toBe(2);
  });

  it("preserves existing negative evidence when the tombstone byte budget overflows", async () => {
    const catalog = new MossMarketplaceAggregation({
      maxTombstones: 10,
      maxCacheTombstoneBytes: 1_000,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:small-negative", {
                withdrawal: { status: "deleted", generation: 1, snapshot: "small" },
              }),
              candidate("mcp:large-negative", {
                description: "x".repeat(4_000),
                withdrawal: { status: "deleted", generation: 1, snapshot: "large" },
              }),
            ],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({
      kind: "mcp",
      query: { limit: 10, includeStale: true },
    });

    expect(result.entries.map((entry) => entry.id)).toContain("mcp:small-negative");
    expect(result.entries.map((entry) => entry.id)).not.toContain("mcp:large-negative");
    expect(result.sources[0]?.error).toBe("SOURCE_TOMBSTONE_CAPACITY");
    expect(catalog.getCacheStats().tombstones).toBe(1);
  });

  it("recomputes authoritative availability after tombstone absorption", async () => {
    const target = "mcp:capacity-discovery-target";
    const catalog = new MossMarketplaceAggregation({
      maxTombstones: 1,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:deleted-a", {
                withdrawal: {
                  status: "deleted",
                  generation: 4,
                  snapshot: "official-4",
                },
              }),
              candidate("mcp:deleted-b", {
                withdrawal: {
                  status: "deleted",
                  generation: 4,
                  snapshot: "official-4",
                },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 4,
            snapshot: "official-4",
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate(target, { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({
      kind: "mcp",
      query: { query: "capacity-discovery-target", limit: 10 },
    });

    expect(result.entries.map((entry) => entry.id)).not.toContain(target);
    expect(result.sources.find((status) => status.id === "official")?.error).toBe(
      "SOURCE_TOMBSTONE_CAPACITY",
    );
    expect(catalog.getCacheStats().tombstones).toBe(1);
  });

  it("fails closed for authoritative tombstone count overflow on a colliding identity", async () => {
    const collision = "mcp:collision-count";
    const catalog = new MossMarketplaceAggregation({
      maxTombstones: 1,
      sources: [
        source(
          {
            id: "official-count",
            label: "Official count",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:deleted-a", {
                withdrawal: { status: "deleted", generation: 1, snapshot: "official-1" },
              }),
              candidate(collision, {
                withdrawal: { status: "deleted", generation: 1, snapshot: "official-1" },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 1,
            snapshot: "official-1",
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery-count",
            label: "Discovery count",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate(collision, { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(result.entries.map((entry) => entry.id)).not.toContain(collision);
    expect(result.sources.find((status) => status.id === "official-count")?.error).toBe(
      "SOURCE_TOMBSTONE_CAPACITY",
    );
    expect(catalog.getCacheStats().tombstones).toBe(1);
  });

  it("fails closed for authoritative tombstone byte overflow on a colliding identity", async () => {
    const collision = "mcp:collision-bytes";
    const healthy = "mcp:healthy-unrelated-bytes";
    const catalog = new MossMarketplaceAggregation({
      maxTombstones: 10,
      maxCacheTombstoneBytes: 1_000,
      sources: [
        source(
          {
            id: "official-bytes",
            label: "Official bytes",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:deleted-small", {
                withdrawal: { status: "deleted", generation: 1, snapshot: "official-bytes-1" },
              }),
              candidate(collision, {
                description: "x".repeat(4_000),
                withdrawal: { status: "deleted", generation: 1, snapshot: "official-bytes-1" },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 1,
            snapshot: "official-bytes-1",
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery-bytes",
            label: "Discovery bytes",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate(collision, { activity: { status: "active" } }),
              candidate(healthy, { activity: { status: "active" } }),
            ],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(result.entries.map((entry) => entry.id)).not.toContain(collision);
    expect(result.entries.map((entry) => entry.id)).not.toContain(healthy);
    expect(result.sources.find((status) => status.id === "official-bytes")?.error).toBe(
      "SOURCE_TOMBSTONE_CAPACITY",
    );
    expect(catalog.getCacheStats().tombstones).toBe(1);
  });

  it("fails closed across all positives when the authoritative tombstone ledger overflows", async () => {
    const catalog = new MossMarketplaceAggregation({
      maxCacheEntries: 2,
      maxTombstones: 1,
      sources: [
        source(
          {
            id: "official-overflow",
            label: "Official overflow",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:overflow-a", {
                withdrawal: { status: "deleted", generation: 7, snapshot: "official-7" },
              }),
              candidate("mcp:overflow-b", {
                withdrawal: { status: "deleted", generation: 7, snapshot: "official-7" },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 7,
            snapshot: "official-7",
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "healthy-account",
            label: "Healthy account",
            tier: "aggregator",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:healthy-visible", { activity: { status: "active" } }),
              candidate("mcp:healthy-withdrawn", {
                withdrawal: { status: "deleted", generation: 1, snapshot: "healthy-1" },
              }),
            ],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(result.entries).toEqual([]);
    expect(result.sources.find((status) => status.id === "official-overflow")?.error).toBe(
      "SOURCE_TOMBSTONE_CAPACITY",
    );
    expect(result.sources.find((status) => status.id === "healthy-account")?.error).toBe(
      "AUTHORITATIVE_LEDGER_UNAVAILABLE",
    );
    expect(result.sources.find((status) => status.id === "healthy-account")?.itemCount).toBe(2);
  });

  it("keeps global cache limits hard across two sources without evicting a tombstone", async () => {
    const negative = "mcp:global-negative";
    const positive = "mcp:global-positive";
    const catalog = new MossMarketplaceAggregation({
      maxCacheEntries: 1,
      maxCacheBytes: 1_024,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate(negative, {
                withdrawal: {
                  status: "deleted",
                  generation: 5,
                  snapshot: "official-5",
                },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 5,
            snapshot: "official-5",
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate(positive, {
                description: "界".repeat(2_000),
                activity: { status: "active" },
              }),
            ],
            nextCursor: null,
          }),
        ),
      ],
    });

    await catalog.browse({
      kind: "mcp",
      query: { sourceIds: ["official"], limit: 10 },
    });
    const result = await catalog.browse({
      kind: "mcp",
      query: { sourceIds: ["discovery"], limit: 10 },
    });

    expect(result.entries.map((entry) => entry.id)).not.toContain(positive);
    expect(catalog.getCacheStats().tombstones).toBe(1);
    expect(catalog.getCacheStats().entries).toBeLessThanOrEqual(1);
  });

  it("refreshes an exhausted cache before an authoritative withdrawal can be hidden", async () => {
    let now = NOW;
    let calls = 0;
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => {
            calls += 1;
            return {
              candidates:
                calls === 1
                  ? [candidate("mcp:shared", { activity: { status: "active" } })]
                  : calls === 2
                    ? [
                        candidate("mcp:shared", {
                          withdrawal: {
                            status: "withdrawn",
                            sourceVersion: "registry-v8",
                            observedAt: now.toISOString(),
                            generation: 8,
                            snapshot: "official-snapshot-8",
                          },
                        }),
                      ]
                    : [candidate("mcp:shared", { activity: { status: "active" } })],
              ...(calls < 3
                ? {
                    complete: true,
                    truncated: false,
                    partial: false,
                    generation: calls === 2 ? 8 : 1,
                    snapshot: calls === 2 ? "official-snapshot-8" : "official-snapshot-1",
                    fullSnapshot: true,
                  }
                : {}),
              nextCursor: null,
            };
          },
        ),
      ],
    });

    const first = await catalog.browse({ kind: "mcp", query: { limit: 10 } });
    now = new Date(NOW.valueOf() + 1_001);
    const second = await catalog.browse({ kind: "mcp", query: { limit: 10 } });
    now = new Date(NOW.valueOf() + 2_002);
    const third = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(first.entries.map((entry) => entry.id)).toEqual(["mcp:shared"]);
    expect(second.entries).toEqual([]);
    expect(third.entries).toEqual([]);
    expect(calls).toBe(3);
  });

  it("requires a newer same-tier reinstatement before clearing a tombstone", async () => {
    let now = NOW;
    let calls = 0;
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => {
            calls += 1;
            return {
              candidates:
                calls === 1
                  ? [
                      candidate("mcp:reinstated", {
                        withdrawal: {
                          status: "withdrawn",
                          sourceVersion: "registry-v1",
                          observedAt: now.toISOString(),
                          generation: 1,
                          snapshot: "withdrawn-1",
                          expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
                        },
                      }),
                    ]
                  : [
                      candidate("mcp:reinstated", {
                        activity: { status: "active" },
                      }),
                    ],
              sourceVersion: "registry-v2",
              generation: 2,
              snapshot: "active-2",
              complete: true,
              truncated: false,
              partial: false,
              fullSnapshot: true,
              nextCursor: null,
            };
          },
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    now = new Date(NOW.valueOf() + 1_001);
    expect(
      (await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual(["mcp:reinstated"]);
  });

  it("does not accept candidate-supplied reinstatement from a partial page", async () => {
    let now = NOW;
    let calls = 0;
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => {
            calls += 1;
            return calls === 1
              ? {
                  candidates: [
                    candidate("mcp:partial-reinstatement", {
                      withdrawal: {
                        status: "withdrawn",
                        generation: 1,
                        snapshot: "withdrawn-1",
                        expiresAt: new Date(now.valueOf() + 60_000).toISOString(),
                      },
                    }),
                  ],
                  generation: 1,
                  snapshot: "withdrawn-1",
                  nextCursor: null,
                }
              : {
                  candidates: [
                    candidate("mcp:partial-reinstatement", {
                      reinstatement: {
                        sourceId: "official",
                        sourceTier: "official",
                        sourceVersion: "forged-v2",
                        generation: 999,
                        snapshot: "forged-full-999",
                        reason: "forged complete snapshot",
                      },
                      activity: { status: "active" },
                    }),
                  ],
                  generation: 2,
                  snapshot: "partial-page-2",
                  complete: true,
                  truncated: false,
                  fullSnapshot: true,
                  partial: true,
                  nextCursor: "page-2",
                };
          },
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    now = new Date(NOW.valueOf() + 1_001);
    const partial = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(partial.entries).toEqual([]);
    expect(calls).toBe(2);
  });

  it("does not reinstate from an authoritative state that later exceeds entry capacity", async () => {
    let now = NOW;
    let calls = 0;
    const target = "mcp:capacity-reinstatement";
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async ({ cursor }) => {
            calls += 1;
            if (calls === 1) {
              return {
                candidates: [
                  candidate(target, {
                    withdrawal: {
                      status: "withdrawn",
                      generation: 1,
                      snapshot: "withdrawn-1",
                    },
                  }),
                ],
                complete: true,
                truncated: false,
                partial: false,
                generation: 1,
                snapshot: "withdrawn-1",
                fullSnapshot: true,
                nextCursor: null,
              };
            }
            if (cursor === null) {
              return {
                candidates: [
                  candidate(target, { activity: { status: "active" } }),
                  ...Array.from({ length: 9_999 }, (_, index) =>
                    candidate(`mcp:capacity-filler-${index}`),
                  ),
                ],
                complete: true,
                truncated: false,
                partial: false,
                generation: 2,
                snapshot: "capacity-2",
                nextCursor: "page-2",
              };
            }
            return {
              candidates: [
                candidate(target, { activity: { status: "active" } }),
                candidate("mcp:capacity-overflow", {
                  withdrawal: {
                    status: "deleted",
                    generation: 2,
                    snapshot: "capacity-2",
                  },
                }),
              ],
              complete: true,
              truncated: false,
              partial: false,
              generation: 2,
              snapshot: "capacity-2",
              fullSnapshot: true,
              nextCursor: null,
            };
          },
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    now = new Date(NOW.valueOf() + 1_001);
    const overflowed = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(overflowed.entries).toEqual([]);
    expect(overflowed.sources[0]?.error).toBe("SOURCE_ENTRY_CAPACITY");
    expect(catalog.getCacheStats().tombstones).toBe(2);
    expect(calls).toBe(3);
  });

  it("does not let an ordinary query state reinstate an authoritative tombstone", async () => {
    const target = "mcp:ordinary-query-reinstatement";
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async ({ query }) =>
            query === ""
              ? {
                  candidates: [
                    candidate(target, {
                      withdrawal: {
                        status: "withdrawn",
                        generation: 1,
                        snapshot: "ordinary-withdrawn-1",
                      },
                    }),
                  ],
                  complete: true,
                  truncated: false,
                  partial: false,
                  generation: 1,
                  snapshot: "ordinary-withdrawn-1",
                  fullSnapshot: true,
                  nextCursor: null,
                }
              : {
                  candidates: [candidate(target, { activity: { status: "active" } })],
                  complete: true,
                  truncated: false,
                  partial: false,
                  generation: 2,
                  snapshot: "ordinary-active-2",
                  fullSnapshot: true,
                  nextCursor: null,
                },
        ),
      ],
    });

    const result = await catalog.browse({
      kind: "mcp",
      query: { query: "ordinary-query-reinstatement", limit: 10 },
    });

    expect(result.entries).toEqual([]);
    expect(catalog.getCacheStats().tombstones).toBe(1);
  });

  it("does not reinstate when an authoritative page chain changes generation or snapshot", async () => {
    let now = NOW;
    let calls = 0;
    const target = "mcp:mismatched-chain";
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async ({ cursor }) => {
            calls += 1;
            if (calls === 1) {
              return {
                candidates: [
                  candidate(target, {
                    withdrawal: {
                      status: "withdrawn",
                      generation: 1,
                      snapshot: "withdrawn-1",
                    },
                  }),
                ],
                complete: true,
                truncated: false,
                partial: false,
                generation: 1,
                snapshot: "withdrawn-1",
                fullSnapshot: true,
                nextCursor: null,
              };
            }
            if (cursor === null) {
              return {
                candidates: [candidate(target, { activity: { status: "active" } })],
                complete: true,
                truncated: false,
                partial: false,
                generation: 2,
                snapshot: "chain-page-1",
                nextCursor: "page-2",
              };
            }
            return {
              candidates: [candidate(target, { activity: { status: "active" } })],
              complete: true,
              truncated: false,
              partial: false,
              generation: 2,
              snapshot: "chain-page-2",
              fullSnapshot: true,
              nextCursor: null,
            };
          },
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    now = new Date(NOW.valueOf() + 1_001);
    const mismatched = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(mismatched.entries).toEqual([]);
    expect(mismatched.sources[0]?.error).toBe("AUTHORITATIVE_LEDGER_UNAVAILABLE");
    expect(catalog.getCacheStats().tombstones).toBe(1);
    expect(calls).toBe(3);
  });

  it("does not let the ordinary cache TTL revive a tombstone without explicit reinstatement", async () => {
    let now = NOW;
    let calls = 0;
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      tombstoneTtlMs: 1_000,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => {
            calls += 1;
            if (calls === 1) {
              return {
                candidates: [
                  candidate("mcp:ttl", {
                    withdrawal: {
                      status: "withdrawn",
                      sourceVersion: "v1",
                      observedAt: now.toISOString(),
                      generation: 1,
                      snapshot: "withdrawn-1",
                      expiresAt: new Date(now.valueOf() + 1_000).toISOString(),
                    },
                  }),
                ],
                nextCursor: null,
              };
            }
            return {
              candidates: [candidate("mcp:ttl", { activity: { status: "active" } })],
              nextCursor: null,
            };
          },
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    now = new Date(NOW.valueOf() + 1_001);
    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    expect(calls).toBe(2);
  });

  it("bounds page entries and UTF-8 cache bytes, including disabled/error query state", async () => {
    let calls = 0;
    const large = source(
      {
        id: "large",
        label: "Large",
        tier: "curated",
        supportedKinds: ["mcp"],
      },
      async () => {
        calls += 1;
        return {
          candidates: Array.from({ length: 10_005 }, (_, index) =>
            candidate(`mcp:large-${index}`, { description: "界".repeat(600) }),
          ),
          nextCursor: null,
        };
      },
    );
    const disabled = source(
      {
        id: "disabled",
        label: "Disabled",
        tier: "discovery",
        supportedKinds: ["mcp"],
        enabled: false,
        disabledReason: "fixture disabled",
      },
      async () => ({ candidates: [], nextCursor: null }),
    );
    const negative = source(
      {
        id: "negative",
        label: "Negative",
        tier: "official",
        supportedKinds: ["mcp"],
      },
      async () => ({
        candidates: [
          candidate("mcp:negative-a", {
            withdrawal: { status: "deleted", generation: 1, snapshot: "negative-a" },
          }),
          candidate("mcp:negative-b", {
            withdrawal: { status: "deleted", generation: 1, snapshot: "negative-b" },
          }),
        ],
        complete: true,
        truncated: false,
        partial: false,
        generation: 1,
        snapshot: "negative-1",
        fullSnapshot: true,
        nextCursor: null,
      }),
    );
    const catalog = new MossMarketplaceAggregation({
      maxCacheBytes: 1_500,
      maxCachePages: 1,
      maxQueryStates: 2,
      maxTombstones: 10,
      sources: [large, disabled, negative],
    });

    const first = await catalog.browse({ kind: "mcp", query: { limit: 10 } });
    await catalog.browse({ kind: "mcp", query: { limit: 10 } });
    await catalog.browse({ kind: "mcp", query: { query: "disabled", limit: 10 } });

    expect(first.sources.find((status) => status.id === "large")?.itemCount).toBeLessThanOrEqual(
      10_000,
    );
    expect(first.sources.find((status) => status.id === "negative")?.error).toBe(
      "SOURCE_CACHE_CAPACITY",
    );
    expect(calls).toBe(3);
    expect(catalog.getCacheStats()).toMatchObject({
      queryStates: expect.any(Number),
      pages: expect.any(Number),
      tombstones: expect.any(Number),
      bytes: expect.any(Number),
    });
    expect(catalog.getCacheStats().tombstones).toBe(0);
    expect(catalog.getCacheStats().queryStates).toBeLessThanOrEqual(2);
  });

  it("quarantines the source responsible for global tombstone budget pressure only", async () => {
    const catalog = new MossMarketplaceAggregation({
      maxCacheEntries: 2,
      sources: [
        source(
          {
            id: "overflow-account",
            label: "Overflow account",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:overflow-a", {
                description: "x".repeat(2_000),
                withdrawal: { status: "deleted", generation: 1, snapshot: "overflow-a" },
              }),
              candidate("mcp:overflow-b", {
                description: "x".repeat(2_000),
                withdrawal: { status: "deleted", generation: 1, snapshot: "overflow-b" },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 1,
            snapshot: "overflow-1",
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "healthy-account",
            label: "Healthy account",
            tier: "curated",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:healthy-visible", { activity: { status: "active" } }),
              candidate("mcp:healthy-withdrawn", {
                withdrawal: { status: "deleted", generation: 1, snapshot: "healthy-withdrawn" },
              }),
            ],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({ kind: "mcp", query: { limit: 10 } });

    expect(result.entries.map((entry) => entry.id)).toContain("mcp:healthy-visible");
    expect(result.sources.find((status) => status.id === "overflow-account")?.error).toBe(
      "SOURCE_CACHE_CAPACITY",
    );
    expect(result.sources.find((status) => status.id === "healthy-account")?.error).toBeNull();
  });

  it("fails closed when the 10001st candidate is authoritative negative evidence", async () => {
    const overflowIdentity = "mcp:overflow-negative";
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async ({ cursor }) =>
            cursor === null
              ? {
                  candidates: Array.from({ length: 10_000 }, (_, index) =>
                    candidate(`mcp:overflow-filler-${index}`),
                  ),
                  generation: 20,
                  snapshot: "official-overflow-20",
                  complete: true,
                  truncated: false,
                  partial: false,
                  nextCursor: "page-2",
                }
              : {
                  candidates: [
                    candidate(overflowIdentity, {
                      withdrawal: {
                        status: "deleted",
                        generation: 20,
                        snapshot: "official-overflow-20",
                      },
                    }),
                  ],
                  generation: 20,
                  snapshot: "official-overflow-20",
                  complete: true,
                  truncated: false,
                  partial: false,
                  fullSnapshot: true,
                  nextCursor: null,
                },
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate(overflowIdentity, { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({
      kind: "mcp",
      query: { query: "overflow-negative", includeStale: true, limit: 10 },
    });

    expect(result.entries.find((entry) => entry.id === overflowIdentity)?.withdrawal?.status).toBe(
      "deleted",
    );
    expect(result.sources.find((status) => status.id === "official")?.error).toBe(
      "SOURCE_ENTRY_CAPACITY",
    );
    expect(result.partial).toBe(true);
  });

  it("keeps a tombstone-capacity quarantine across refreshes", async () => {
    let now = NOW;
    let officialCalls = 0;
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      maxTombstones: 1,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates:
              officialCalls++ === 0
                ? [
                    candidate("mcp:overflow-a", {
                      withdrawal: { status: "deleted", generation: 1, snapshot: "a" },
                    }),
                    candidate("mcp:overflow-b", {
                      withdrawal: { status: "deleted", generation: 1, snapshot: "b" },
                    }),
                  ]
                : [],
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate("mcp:overflow-a", { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    now = new Date(NOW.valueOf() + 1_001);
    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    expect(officialCalls).toBe(2);
  });

  it("uses tier-bound field provenance instead of OR-merging claims", async () => {
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:shared", {
                verified: false,
                featured: false,
                license: { status: "unknown" },
                activity: { status: "stale", lastUpdatedAt: "2020-01-01T00:00:00.000Z" },
                security: { status: "unreviewed" },
              }),
            ],
            complete: true,
            truncated: false,
            partial: false,
            generation: 1,
            snapshot: "official-provenance-1",
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:shared", {
                verified: true,
                featured: true,
                license: { status: "known", spdxId: "MIT" },
                activity: { status: "active", lastUpdatedAt: NOW.toISOString() },
                security: { status: "source-reviewed" },
              }),
            ],
            nextCursor: null,
          }),
        ),
      ],
    });

    const result = await catalog.browse({
      kind: "mcp",
      query: { limit: 10, includeStale: true },
    });
    const entry = result.entries[0];

    expect(entry).toMatchObject({
      verified: false,
      featured: false,
      license: { status: "unknown", spdxId: null },
      activity: { status: "stale" },
      security: { status: "unreviewed" },
    });
    expect(entry?.provenance.verified).toMatchObject({
      sourceIds: ["official"],
      sourceTiers: ["official"],
    });
    expect(entry?.provenance.license).toMatchObject({
      sourceIds: ["official"],
      sourceTiers: ["official"],
    });
    expect(entry?.provenance.security).toMatchObject({
      sourceIds: ["official"],
      sourceTiers: ["official"],
    });
  });

  it("bounds query state and rejects cursors crossing kind, expiry, or generation", async () => {
    let now = NOW;
    let calls = 0;
    const sourceForCursor = source(
      {
        id: "cursor-source",
        label: "Cursor source",
        tier: "curated",
        supportedKinds: ["mcp", "skill"],
      },
      async ({ kind, query }) => {
        calls += 1;
        return {
          candidates: [candidate(`${kind}:${query || "all"}:${calls}`, { kind })],
          nextCursor: "remote-next",
        };
      },
    );
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      now: () => now,
      sources: [sourceForCursor],
      maxQueryStates: 2,
    });

    const first = await catalog.browse({ kind: "mcp", query: { limit: 1 } });
    expect(first.nextCursor).toBeTruthy();
    await expect(
      catalog.browse({
        kind: "skill",
        query: { limit: 1, cursor: first.nextCursor ?? undefined },
      }),
    ).rejects.toMatchObject({ code: "CURSOR_KIND_MISMATCH" });

    now = new Date(NOW.valueOf() + 1_001);
    await expect(
      catalog.browse({ kind: "mcp", query: { limit: 1, cursor: first.nextCursor ?? undefined } }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });

    now = NOW;
    const fresh = await catalog.browse({ kind: "mcp", query: { limit: 1 } });
    await expect(
      catalog.browse({
        kind: "mcp",
        forceReload: true,
        query: { limit: 1, cursor: fresh.nextCursor ?? undefined },
      }),
    ).rejects.toMatchObject({ code: "CURSOR_GENERATION_MISMATCH" });

    await catalog.browse({ kind: "mcp", query: { query: "a", limit: 1 } });
    await catalog.browse({ kind: "mcp", query: { query: "b", limit: 1 } });
    await catalog.browse({ kind: "mcp", query: { query: "c", limit: 1 } });
    await catalog.browse({ kind: "mcp", query: { query: "a", limit: 1 } });
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it("projects the authoritative tombstone ledger before refreshed candidates", async () => {
    let now = NOW;
    let officialCalls = 0;
    const catalog = new MossMarketplaceAggregation({
      cacheTtlMs: 1_000,
      now: () => now,
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => {
            officialCalls += 1;
            return {
              candidates:
                officialCalls === 1
                  ? [
                      candidate("mcp:hostile", {
                        withdrawal: {
                          status: "deleted",
                          sourceVersion: "registry-v9",
                          observedAt: NOW.toISOString(),
                          generation: 9,
                          snapshot: "official-deleted-9",
                        },
                      }),
                    ]
                  : [],
              sourceVersion: officialCalls === 1 ? "registry-v9" : "registry-v10",
              generation: officialCalls,
              snapshot: `official-refresh-${officialCalls}`,
              nextCursor: null,
            };
          },
        ),
        source(
          {
            id: "discovery",
            label: "Discovery",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate("mcp:hostile", { activity: { status: "active" } })],
            nextCursor: null,
          }),
        ),
      ],
    });

    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    now = new Date(NOW.valueOf() + 1_001);
    expect((await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries).toEqual([]);
    expect(officialCalls).toBe(2);
  });

  it("uses an opaque single-use cursor and exposes bounded cache accounting", async () => {
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "cursor-source",
            label: "Cursor source",
            tier: "curated",
            supportedKinds: ["mcp"],
          },
          async ({ cursor }) => ({
            candidates: [candidate(cursor ? "mcp:second" : "mcp:first")],
            nextCursor: cursor ? null : "remote-next",
          }),
        ),
      ],
    });

    const first = await catalog.browse({ kind: "mcp", query: { limit: 1 } });
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toMatch(/^eyJ/);
    const clientForgedCursor = Buffer.from(
      JSON.stringify({ kind: "mcp", offset: 0, expiresAt: Date.now() + 86_400_000 }),
      "utf8",
    ).toString("base64url");
    await expect(
      catalog.browse({ kind: "mcp", query: { limit: 1, cursor: clientForgedCursor } }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    expect(catalog.getCacheStats()).toMatchObject({
      queryStates: 1,
      pages: 1,
      cursors: 1,
    });

    await catalog.browse({
      kind: "mcp",
      query: { limit: 1, cursor: first.nextCursor ?? undefined },
    });
    await expect(
      catalog.browse({
        kind: "mcp",
        query: { limit: 1, cursor: first.nextCursor ?? undefined },
      }),
    ).rejects.toMatchObject({ code: "CURSOR_REPLAY" });
  });

  it("reserves a cursor before the first await so concurrent consumers cannot double-spend it", async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "concurrent-cursor",
            label: "Concurrent cursor",
            tier: "curated",
            supportedKinds: ["mcp"],
          },
          async ({ cursor }) => {
            if (cursor) await gate;
            return {
              candidates: [candidate(cursor ? "mcp:second" : "mcp:first")],
              nextCursor: cursor ? null : "remote-next",
            };
          },
        ),
      ],
    });
    const first = await catalog.browse({ kind: "mcp", query: { limit: 1 } });
    const firstConsumer = catalog.browse({
      kind: "mcp",
      query: { limit: 1, cursor: first.nextCursor ?? undefined },
    });
    const secondConsumer = catalog.browse({
      kind: "mcp",
      query: { limit: 1, cursor: first.nextCursor ?? undefined },
    });
    releaseGate();
    await firstConsumer;
    await expect(secondConsumer).rejects.toMatchObject({ code: "CURSOR_REPLAY" });
  });
});

describe("Moss marketplace source defaults", () => {
  it("keeps official MCP Registry enabled and discovery-only awesome source disabled", () => {
    const sources = createTestMossMarketplaceSources({
      fetch: async () => {
        throw new Error("not called");
      },
    });
    const official = sources.find((source) => source.id === "official-mcp-registry");
    const awesome = sources.find((source) => source.id === "awesome-mcp-servers");
    const smithery = sources.find((source) => source.id === "smithery");

    expect(official?.enabled).toBe(true);
    expect(official?.tier).toBe("official");
    expect(awesome).toMatchObject({ enabled: false, tier: "discovery" });
    expect(smithery).toMatchObject({ enabled: false, tier: "aggregator" });
  });

  it("honors explicit source allow/deny configuration", () => {
    const sources = createTestMossMarketplaceSources({
      enabledSourceIds: ["official-mcp-registry", "awesome-mcp-servers"],
      disabledSourceIds: ["official-mcp-registry"],
      enableDiscoverySources: true,
      fetch: async () => {
        throw new Error("not called");
      },
    });

    expect(sources.find((source) => source.id === "official-mcp-registry")).toMatchObject({
      enabled: false,
    });
    expect(sources.find((source) => source.id === "awesome-mcp-servers")).toMatchObject({
      enabled: true,
    });
    expect(sources.find((source) => source.id === "anthropic-plugins-official")).toMatchObject({
      enabled: false,
    });
  });

  it("parses official Registry pages and drops deleted servers", async () => {
    const sources = createTestMossMarketplaceSources({
      fetch: async (url) => {
        expect(url).toContain("registry.modelcontextprotocol.io/v0.1/servers");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: new Blob([
            JSON.stringify({
              servers: [
                {
                  server: {
                    name: "io.github.example/active",
                    title: "Active",
                    description: "Active server",
                    packages: [{ registryType: "npm", transport: { type: "stdio" } }],
                  },
                },
                {
                  server: {
                    name: "io.github.example/deprecated",
                    status: "deprecated",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                },
                { server: { name: "io.github.example/deleted", status: "deleted" } },
              ],
              metadata: { nextCursor: "next" },
            }),
          ]).stream(),
        } as Response;
      },
    });
    const official = sources.find((source) => source.id === "official-mcp-registry");
    const page = await official?.fetchPage({
      kind: "mcp",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });

    expect(page?.candidates).toHaveLength(3);
    expect(page?.candidates[0]).toMatchObject({
      identity: "mcp:github:example/active",
      compatibility: ["mcp", "npm", "stdio"],
      security: {
        executionPolicy: "never",
        permissions: ["process"],
      },
    });
    expect(page?.candidates[1]).toMatchObject({
      identity: "mcp:github:example/deprecated",
      activity: { status: "stale" },
      security: { signals: expect.arrayContaining(["official-registry-deprecated"]) },
    });
    expect(page?.candidates[2]).toMatchObject({
      identity: "mcp:github:example/deleted",
      withdrawal: { status: "deleted" },
    });
    expect(page?.nextCursor).toBe("next");
  });

  it("requires explicit complete metadata before treating an official page as a full snapshot", async () => {
    const sources = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: new Blob([
            JSON.stringify({
              servers: [{ server: { name: "io.github.example/truncated" } }],
              metadata: {
                nextCursor: null,
                complete: true,
                truncated: true,
              },
            }),
          ]).stream(),
        }) as Response,
    });
    const official = sources.find((source) => source.id === "official-mcp-registry");
    const page = await official?.fetchPage({
      kind: "mcp",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });

    expect(page?.nextCursor).toBeNull();
    expect(page?.fullSnapshot).toBe(false);
  });

  it("hides deprecated registry entries by default while allowing explicit stale review", async () => {
    const sources = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: new Blob([
            JSON.stringify({
              servers: [{ server: { name: "io.github.example/deprecated", status: "deprecated" } }],
              metadata: { nextCursor: null },
            }),
          ]).stream(),
        }) as Response,
    });
    const catalog = new MossMarketplaceAggregation({ sources, now: () => NOW });

    const defaultResult = await catalog.browse({ kind: "mcp", query: { limit: 10 } });
    const reviewResult = await catalog.browse({
      kind: "mcp",
      query: { limit: 10, includeStale: true },
    });

    expect(defaultResult.entries).toEqual([]);
    expect(reviewResult.entries.map((entry) => entry.id)).toEqual([
      "mcp:github:example/deprecated",
    ]);
  });

  it("indexes OpenAI Skills by SKILL.md paths instead of treating namespace directories as skills", async () => {
    const revision: TestGithubRevision = {
      commitSha: "3".repeat(40),
      treeSha: "4".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
    };
    const sources = createTestMossMarketplaceSources({
      fetch: async (url) => {
        if (url.endsWith("/repos/openai/skills/commits/main")) {
          return jsonResponse(githubCommitPayload(revision));
        }
        expect(url).toContain(`api.github.com/repos/openai/skills/git/trees/${revision.commitSha}`);
        return jsonResponse({
          sha: revision.treeSha,
          truncated: true,
          tree: [
            { path: "skills/.system", type: "tree" },
            { path: "skills/.system/apply-patch/SKILL.md", type: "blob" },
            { path: "skills/.experimental/create-plan/SKILL.md", type: "blob" },
          ],
        });
      },
    });
    const openai = sources.find((source) => source.id === "openai-skills");
    const page = await openai?.fetchPage({
      kind: "skill",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });

    expect(page?.candidates.map((entry) => entry.name)).toEqual([
      ".system/apply-patch",
      ".experimental/create-plan",
    ]);
    expect(page?.complete).toBe(false);
    expect(page?.truncated).toBe(true);
    expect(page?.fullSnapshot).toBe(false);
  });

  it("derives official Anthropic and OpenAI snapshots from stable upstream revisions", async () => {
    const anthropicRevisionOne: TestGithubRevision = {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
    };
    const anthropicRevisionTwo: TestGithubRevision = {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      committedAt: "2026-08-07T00:00:00.000Z",
    };
    let anthropicRevision = anthropicRevisionOne;
    const anthropic = createTestMossMarketplaceSources({
      fetch: async (url) => {
        if (url.includes("/repos/anthropics/claude-plugins-official/commits")) {
          return jsonResponse([githubCommitPayload(anthropicRevision)]);
        }
        expect(url).toContain(anthropicRevision.commitSha);
        return jsonResponse({
          plugins: [{ name: "revision-plugin", source: "plugins/revision-plugin" }],
        });
      },
    }).find((source) => source.id === "anthropic-plugins-official");

    const anthropicFirst = await anthropic?.fetchPage({
      kind: "plugin",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });
    const anthropicStable = await anthropic?.fetchPage({
      kind: "plugin",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });
    anthropicRevision = anthropicRevisionTwo;
    const anthropicChanged = await anthropic?.fetchPage({
      kind: "plugin",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });

    expect(anthropicFirst?.candidates).toHaveLength(1);
    expect(anthropicFirst).toMatchObject({
      sourceVersion: anthropicRevisionOne.commitSha,
      fullSnapshot: true,
    });
    expect(anthropicFirst?.snapshot).toContain(anthropicRevisionOne.treeSha);
    expect(anthropicFirst?.generation).toBeUndefined();
    expect(anthropicStable?.generation).toBeUndefined();
    expect(anthropicStable?.snapshot).toBe(anthropicFirst?.snapshot);
    expect(anthropicChanged?.sourceVersion).toBe(anthropicRevisionTwo.commitSha);
    expect(anthropicChanged?.snapshot).not.toBe(anthropicFirst?.snapshot);
    expect(anthropicChanged?.generation).toBeUndefined();

    const openAiRevisionOne: TestGithubRevision = {
      commitSha: "e".repeat(40),
      treeSha: "f".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
    };
    let openAiRevision = openAiRevisionOne;
    const openAi = createTestMossMarketplaceSources({
      fetch: async (url) => {
        if (url.endsWith("/repos/openai/skills/commits/main")) {
          return jsonResponse(githubCommitPayload(openAiRevision));
        }
        expect(url).toContain(`/repos/openai/skills/git/trees/${openAiRevision.commitSha}`);
        return jsonResponse({
          sha: openAiRevision.treeSha,
          truncated: false,
          tree: [{ path: "skills/revision/SKILL.md", type: "blob" }],
        });
      },
    }).find((source) => source.id === "openai-skills");

    const openAiFirst = await openAi?.fetchPage({
      kind: "skill",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });
    const openAiStable = await openAi?.fetchPage({
      kind: "skill",
      cursor: null,
      limit: 25,
      query: "",
      now: NOW,
    });

    expect(openAiFirst?.candidates).toHaveLength(1);
    expect(openAiFirst).toMatchObject({
      sourceVersion: openAiRevisionOne.commitSha,
      fullSnapshot: true,
    });
    expect(openAiFirst?.snapshot).toContain(openAiRevisionOne.treeSha);
    expect(openAiFirst?.generation).toBeUndefined();
    expect(openAiStable?.generation).toBeUndefined();
    expect(openAiStable?.snapshot).toBe(openAiFirst?.snapshot);
  });

  it("assigns strict monotonic generations from ancestry across same-second and restart refreshes", async () => {
    const revisionA: TestGithubRevision = {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
      parents: [],
    };
    const revisionB: TestGithubRevision = {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      committedAt: revisionA.committedAt,
      parents: [revisionA.commitSha],
    };
    const revisionC: TestGithubRevision = {
      commitSha: "e".repeat(40),
      treeSha: "f".repeat(40),
      committedAt: "2026-08-05T00:00:00.000Z",
      parents: ["1".repeat(40)],
    };
    let currentRevision = revisionA;
    let compareBase = revisionB.commitSha;
    const records = new Map<string, TestRevisionRecord>();
    const revisionStore = {
      get: (sourceId: string) => records.get(sourceId),
      set: (sourceId: string, record: TestRevisionRecord) => records.set(sourceId, record),
    };
    const anthropic = createTestMossMarketplaceSources({
      fetch: async (url) => {
        if (url.includes("/compare/")) {
          return jsonResponse({
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            base_commit: { sha: compareBase },
            head_commit: { sha: currentRevision.commitSha },
          });
        }
        if (url.includes("/repos/anthropics/claude-plugins-official/commits")) {
          return jsonResponse([githubCommitPayload(currentRevision)]);
        }
        return jsonResponse({
          plugins: [{ name: "revision-chain-plugin", source: "plugins/revision-chain" }],
        });
      },
    }).find((source) => source.id === "anthropic-plugins-official");
    const options = {
      now: () => NOW,
      sources: [anthropic!],
      revisionChainStore: revisionStore,
    } as MossMarketplaceAggregationOptions & { readonly revisionChainStore: typeof revisionStore };
    const catalog = new MossMarketplaceAggregation(options);
    const first = await catalog.browse({
      kind: "plugin",
      forceReload: true,
      query: { limit: 10 },
    });
    expect(first.entries[0]?.provenance.identity.upstreamGeneration).toBe(1);

    currentRevision = revisionB;
    const sameSecondDescendant = await catalog.browse({
      kind: "plugin",
      forceReload: true,
      query: { limit: 10 },
    });
    expect(sameSecondDescendant.entries[0]?.provenance.identity.upstreamGeneration).toBe(2);

    const stable = await catalog.browse({
      kind: "plugin",
      forceReload: true,
      query: { limit: 10 },
    });
    expect(stable.entries[0]?.provenance.identity.upstreamGeneration).toBe(2);

    currentRevision = revisionC;
    const backdatedDescendant = await catalog.browse({
      kind: "plugin",
      forceReload: true,
      query: { limit: 10 },
    });
    expect(backdatedDescendant.entries[0]?.provenance.identity.upstreamGeneration).toBe(3);

    const restarted = new MossMarketplaceAggregation(options);
    const afterRestart = await restarted.browse({
      kind: "plugin",
      forceReload: true,
      query: { limit: 10 },
    });
    expect(afterRestart.entries[0]?.provenance.identity.upstreamGeneration).toBe(3);
  });

  it("persists the revision chain across real aggregation instances", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "moss-marketplace-revision-restart-"));
    const revisionA: MossMarketplaceGitRevision = {
      commitSha: "1".repeat(40),
      treeSha: "2".repeat(40),
      parents: [],
    };
    const revisionB: MossMarketplaceGitRevision = {
      commitSha: "3".repeat(40),
      treeSha: "4".repeat(40),
      parents: [revisionA.commitSha],
    };
    let revision = revisionA;
    try {
      const first = new MossMarketplaceAggregation({
        stateDir,
        sources: [
          revisionPageSource({
            id: "durable-restart",
            revision: revisionA,
            candidateId: "mcp:durable-restart",
          }),
        ],
        now: () => NOW,
      } as MossMarketplaceAggregationOptions & { readonly stateDir: string });
      const firstPage = await first.browse({
        kind: "mcp",
        forceReload: true,
        query: { limit: 10 },
      });
      expect(firstPage.entries[0]?.provenance.identity.upstreamGeneration).toBe(1);

      revision = revisionB;
      const restarted = new MossMarketplaceAggregation({
        stateDir,
        sources: [
          revisionPageSource({
            id: "durable-restart",
            revision,
            candidateId: "mcp:durable-restart",
          }),
        ],
        now: () => NOW,
      } as MossMarketplaceAggregationOptions & { readonly stateDir: string });
      const restartedPage = await restarted.browse({
        kind: "mcp",
        forceReload: true,
        query: { limit: 10 },
      });
      expect(restartedPage.entries[0]?.provenance.identity.upstreamGeneration).toBe(2);

      const marketplaceDir = join(stateDir, "marketplace");
      const chainPath = join(marketplaceDir, "revision-chain.json");
      if (supportsPosixPermissions()) {
        expect(statSync(marketplaceDir).mode & 0o777).toBe(0o700);
        expect(statSync(chainPath).mode & 0o777).toBe(0o600);
      }
      writeFileSync(chainPath, "corrupt-after-primary-rename");
      const recovered = new MossMarketplaceAggregation({
        stateDir,
        sources: [
          revisionPageSource({
            id: "durable-restart",
            revision: revisionB,
            candidateId: "mcp:durable-restart-recovered",
          }),
        ],
        now: () => NOW,
      } as MossMarketplaceAggregationOptions & { readonly stateDir: string });
      const recoveredPage = await recovered.browse({
        kind: "mcp",
        forceReload: true,
        query: { limit: 10 },
      });
      expect(recoveredPage.entries[0]?.provenance.identity.upstreamGeneration).toBe(2);
      expect(JSON.parse(readFileSync(chainPath, "utf8"))).toMatchObject({
        version: 1,
        integrity: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses a same-source CAS and never reclaims an existing lock", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "moss-marketplace-revision-cas-"));
    const revisionA: MossMarketplaceGitRevision = {
      commitSha: "5".repeat(40),
      treeSha: "6".repeat(40),
      parents: [],
    };
    const revisionB: MossMarketplaceGitRevision = {
      commitSha: "7".repeat(40),
      treeSha: "8".repeat(40),
      parents: [revisionA.commitSha],
    };
    const revisionC: MossMarketplaceGitRevision = {
      commitSha: "9".repeat(40),
      treeSha: "a".repeat(40),
      parents: [revisionA.commitSha],
    };
    const seedSource = revisionPageSource({
      id: "durable-cas",
      revision: revisionA,
      candidateId: "mcp:durable-cas-a",
    });
    try {
      const seed = new MossMarketplaceAggregation({
        stateDir,
        sources: [seedSource],
        now: () => NOW,
      } as MossMarketplaceAggregationOptions & { readonly stateDir: string });
      await seed.browse({ kind: "mcp", forceReload: true, query: { limit: 10 } });

      let waiting = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const left = new MossMarketplaceAggregation({
        stateDir,
        sources: [
          revisionPageSource({
            id: "durable-cas",
            revision: revisionB,
            candidateId: "mcp:durable-cas-b",
            gate: new Promise<void>(async (resolve) => {
              waiting += 1;
              if (waiting === 2) release();
              await gate;
              resolve();
            }),
          }),
        ],
        now: () => NOW,
      } as MossMarketplaceAggregationOptions & { readonly stateDir: string });
      const right = new MossMarketplaceAggregation({
        stateDir,
        sources: [
          revisionPageSource({
            id: "durable-cas",
            revision: revisionC,
            candidateId: "mcp:durable-cas-c",
            gate: new Promise<void>(async (resolve) => {
              waiting += 1;
              if (waiting === 2) release();
              await gate;
              resolve();
            }),
          }),
        ],
        now: () => NOW,
      } as MossMarketplaceAggregationOptions & { readonly stateDir: string });
      const results = await Promise.all([
        left.browse({ kind: "mcp", forceReload: true, query: { limit: 10 } }),
        right.browse({ kind: "mcp", forceReload: true, query: { limit: 10 } }),
      ]);
      expect(results.filter((result) => result.entries.length > 0)).toHaveLength(1);
      expect(
        results.some((result) =>
          result.sources.some((status) => status.error === "REVISION_CHAIN_CAS_CONFLICT"),
        ),
      ).toBe(true);

      const lockPath = join(stateDir, "marketplace", "revision-chain.json.lock");
      writeFileSync(lockPath, "held-by-another-process", { mode: 0o600 });
      const locked = new MossMarketplaceAggregation({
        stateDir,
        sources: [
          source(
            {
              id: "durable-cas",
              label: "durable-cas",
              tier: "official",
              supportedKinds: ["mcp"],
            },
            async ({ previousRevision }) => {
              const base = previousRevision ?? revisionA;
              const lockedRevision: MossMarketplaceGitRevision = {
                commitSha: "b".repeat(40),
                treeSha: "c".repeat(40),
                parents: [base.commitSha],
              };
              return {
                candidates: [candidate("mcp:durable-cas-locked")],
                nextCursor: null,
                sourceVersion: lockedRevision.commitSha,
                snapshot: `git-commit:${lockedRevision.commitSha}:git-tree:${lockedRevision.treeSha}`,
                revision: lockedRevision,
                revisionProof: previousRevision
                  ? { relation: "direct-parent" as const, previousCommitSha: base.commitSha }
                  : { relation: "initial" as const, previousCommitSha: null },
                complete: true,
                truncated: false,
                partial: false,
                fullSnapshot: true,
              };
            },
          ),
        ],
        now: () => NOW,
      } as MossMarketplaceAggregationOptions & { readonly stateDir: string });
      const lockedResult = await locked.browse({
        kind: "mcp",
        forceReload: true,
        query: { limit: 10 },
      });
      expect(lockedResult.sources[0]?.error).toBe("REVISION_CHAIN_BUSY");
      expect(readFileSync(lockPath, "utf8")).toBe("held-by-another-process");
      rmSync(lockPath, { force: true });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the durable revision chain is corrupt", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "moss-marketplace-revision-corrupt-"));
    try {
      const marketplaceDir = join(stateDir, "marketplace");
      mkdirSync(marketplaceDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(marketplaceDir, "revision-chain.json"), "{not-json", {
        mode: 0o600,
      });
      expect(
        () =>
          new MossMarketplaceAggregation({
            stateDir,
            sources: [
              revisionPageSource({
                id: "durable-corrupt",
                revision: {
                  commitSha: "b".repeat(40),
                  treeSha: "c".repeat(40),
                  parents: [],
                },
                candidateId: "mcp:durable-corrupt",
              }),
            ],
            now: () => NOW,
          } as MossMarketplaceAggregationOptions & { readonly stateDir: string }),
      ).toThrow("REVISION_CHAIN_CORRUPT");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("parses API-shaped merge parents and rejects inherited or accessor SHA fields", async () => {
    const parse = (
      MarketplaceSources as unknown as {
        readonly parseMossMarketplaceGitRevisionPayload?: (
          value: unknown,
        ) => MossMarketplaceGitRevision;
      }
    ).parseMossMarketplaceGitRevisionPayload;
    expect(parse).toEqual(expect.any(Function));
    if (!parse) return;

    const parentA = "d".repeat(40);
    const parentB = "e".repeat(40);
    const revision: TestGithubRevision = {
      commitSha: "f".repeat(40),
      treeSha: "0".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
      parents: [parentA, parentB],
    };
    const parsed = parse(githubCommitPayload(revision));
    expect(parsed).toMatchObject({
      commitSha: revision.commitSha,
      treeSha: revision.treeSha,
      parents: [parentA, parentB],
    });

    const openAi = createTestMossMarketplaceSources({
      fetch: async (url) =>
        url.endsWith("/repos/openai/skills/commits/main")
          ? jsonResponse(githubCommitPayload(revision))
          : jsonResponse({
              sha: revision.treeSha,
              truncated: false,
              tree: [{ path: "skills/merge/SKILL.md", type: "blob" }],
            }),
    }).find((source) => source.id === "openai-skills");
    const page = await openAi?.fetchPage({
      kind: "skill",
      cursor: null,
      limit: 10,
      query: "",
      now: NOW,
    });
    expect(page?.revision?.parents).toEqual([parentA, parentB]);

    const inherited = Object.create({ sha: parentA }) as Record<string, unknown>;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "sha", {
      enumerable: true,
      get: () => parentA,
    });
    const customPrototype = Object.create(null) as Record<string, unknown>;
    customPrototype.sha = parentA;
    for (const parent of [inherited, accessor, customPrototype, [parentA]]) {
      expect(() =>
        parse({
          sha: revision.commitSha,
          parents: [parent],
          commit: { committer: { date: revision.committedAt }, tree: { sha: revision.treeSha } },
        }),
      ).toThrow("REMOTE_UPSTREAM_REVISION_UNAVAILABLE");
    }
  });

  it("suppresses an official revision when compare ancestry is diverged", async () => {
    const revisionA: TestGithubRevision = {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
      parents: [],
    };
    const diverged: TestGithubRevision = {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      committedAt: "2026-08-07T00:00:00.000Z",
      parents: ["1".repeat(40)],
    };
    let currentRevision = revisionA;
    const records = new Map<string, TestRevisionRecord>();
    const revisionStore = {
      get: (sourceId: string) => records.get(sourceId),
      set: (sourceId: string, record: TestRevisionRecord) => records.set(sourceId, record),
    };
    const anthropic = createTestMossMarketplaceSources({
      fetch: async (url) => {
        if (url.includes("/compare/")) {
          return jsonResponse({
            status: "diverged",
            ahead_by: 1,
            behind_by: 1,
            base_commit: { sha: revisionA.commitSha },
            head_commit: { sha: diverged.commitSha },
          });
        }
        if (url.includes("/repos/anthropics/claude-plugins-official/commits")) {
          return jsonResponse([githubCommitPayload(currentRevision)]);
        }
        return jsonResponse({
          plugins: [{ name: "must-not-resurface", source: "plugins/must-not-resurface" }],
        });
      },
    }).find((source) => source.id === "anthropic-plugins-official");
    const options = {
      now: () => NOW,
      sources: [anthropic!],
      revisionChainStore: revisionStore,
    } as MossMarketplaceAggregationOptions & { readonly revisionChainStore: typeof revisionStore };
    const catalog = new MossMarketplaceAggregation(options);
    await catalog.browse({ kind: "plugin", forceReload: true, query: { limit: 10 } });

    currentRevision = diverged;
    const result = await catalog.browse({
      kind: "plugin",
      forceReload: true,
      query: { limit: 10 },
    });
    expect(result.entries).toEqual([]);
    expect(result.sources[0]?.error).toBe("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
  });

  it("fails closed for malformed official Anthropic payloads", async () => {
    const revision: TestGithubRevision = {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
    };
    for (const payload of [
      null,
      { plugins: {} },
      { plugins: [{ source: "plugins/missing-name" }] },
      { plugins: [{ name: "valid" }, "not-an-entry"] },
    ]) {
      const anthropic = createTestMossMarketplaceSources({
        fetch: async (url) =>
          url.includes("/repos/anthropics/claude-plugins-official/commits")
            ? jsonResponse([githubCommitPayload(revision)])
            : jsonResponse(payload),
      }).find((source) => source.id === "anthropic-plugins-official");

      await expect(
        anthropic?.fetchPage({ kind: "plugin", cursor: null, limit: 10, query: "", now: NOW }),
      ).rejects.toMatchObject({ code: "REMOTE_UPSTREAM_SCHEMA_INVALID" });
    }
  });

  it("fails closed for malformed OpenAI tree payloads", async () => {
    const revision: TestGithubRevision = {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
    };
    for (const payload of [
      null,
      { sha: revision.treeSha, tree: {}, truncated: false },
      { sha: revision.treeSha, tree: [], truncated: "false" },
      { sha: revision.treeSha, tree: [] },
      { sha: revision.treeSha, tree: [{}], truncated: false },
    ]) {
      const openai = createTestMossMarketplaceSources({
        fetch: async (url) => {
          if (url.endsWith("/repos/openai/skills/commits/main")) {
            return jsonResponse(githubCommitPayload(revision));
          }
          return jsonResponse(payload);
        },
      }).find((source) => source.id === "openai-skills");

      await expect(
        openai?.fetchPage({ kind: "skill", cursor: null, limit: 10, query: "", now: NOW }),
      ).rejects.toMatchObject({ code: "REMOTE_UPSTREAM_SCHEMA_INVALID" });
    }
  });

  it("bounds reader cancellation before escalating to abort and destroy", async () => {
    let abortCalls = 0;
    let destroyCalls = 0;
    const official = createTestMossMarketplaceSources({
      remoteTimeoutMs: 5,
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: async () => {
                throw new Error("fixture reader failure");
              },
              cancel: () => new Promise<never>(() => undefined),
            }),
            abort: () => {
              abortCalls += 1;
              return new Promise<never>(() => undefined);
            },
            destroy: () => {
              destroyCalls += 1;
            },
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    const outcome = await Promise.race([
      official!.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }).then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"cleanup-timeout">((resolve) =>
        setTimeout(() => resolve("cleanup-timeout"), 250),
      ),
    ]);
    expect(outcome).not.toBe("cleanup-timeout");
    expect(outcome).toMatchObject({ code: "REMOTE_FETCH_FAILED" });
    expect(abortCalls).toBe(1);
    expect(destroyCalls).toBe(1);
  });

  it("bounds body cancellation and abort when getReader fails", async () => {
    let abortCalls = 0;
    let destroyCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => {
              throw new Error("fixture reader unavailable");
            },
            cancel: () => new Promise<never>(() => undefined),
            abort: () => {
              abortCalls += 1;
              return new Promise<never>(() => undefined);
            },
            destroy: () => {
              destroyCalls += 1;
            },
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    const outcome = await Promise.race([
      official!.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }).then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"cleanup-timeout">((resolve) =>
        setTimeout(() => resolve("cleanup-timeout"), 250),
      ),
    ]);
    expect(outcome).not.toBe("cleanup-timeout");
    expect(outcome).toMatchObject({ code: "REMOTE_BODY_UNAVAILABLE" });
    expect(abortCalls).toBe(1);
    expect(destroyCalls).toBe(1);
  });

  it("fails closed when an official revision is unavailable", async () => {
    const anthropic = createTestMossMarketplaceSources({
      fetch: async (url) =>
        url.includes("/repos/anthropics/claude-plugins-official/commits")
          ? jsonResponse([{ sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } }])
          : jsonResponse({
              plugins: [{ name: "unversioned-plugin", source: "plugins/unversioned" }],
            }),
    }).find((source) => source.id === "anthropic-plugins-official");

    await expect(
      anthropic?.fetchPage({
        kind: "plugin",
        cursor: null,
        limit: 25,
        query: "",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_UPSTREAM_REVISION_UNAVAILABLE" });
  });

  it("keeps an Anthropic tombstone from being resurrected by a lower-tier active source", async () => {
    const revision: TestGithubRevision = {
      commitSha: "1".repeat(40),
      treeSha: "2".repeat(40),
      committedAt: "2026-08-06T00:00:00.000Z",
    };
    const identity = "plugin:https://github.com/anthropics/claude-plugins-official/plugins/removed";
    const anthropic = createTestMossMarketplaceSources({
      fetch: async (url) =>
        url.includes("/repos/anthropics/claude-plugins-official/commits")
          ? jsonResponse([githubCommitPayload(revision)])
          : jsonResponse({
              plugins: [
                {
                  name: "removed",
                  source: "plugins/removed",
                  status: "deleted",
                },
              ],
            }),
    }).find((source) => source.id === "anthropic-plugins-official");
    const discovery = source(
      {
        id: "plugin-discovery",
        label: "Plugin discovery",
        tier: "discovery",
        supportedKinds: ["plugin"],
      },
      async () => ({
        candidates: [
          candidate(identity, {
            kind: "plugin",
            name: "removed",
            activity: { status: "active" },
          }),
        ],
        nextCursor: null,
      }),
    );
    const catalog = aggregation({
      sources: [anthropic!, discovery],
      revisionChainStore: createMossMarketplaceInMemoryRevisionChainStore(),
    });

    const first = await catalog.browse({ kind: "plugin", query: { limit: 10 } });
    const second = await catalog.browse({ kind: "plugin", query: { limit: 10 } });

    expect(first.entries.map((entry) => entry.id)).not.toContain(identity);
    expect(second.entries.map((entry) => entry.id)).not.toContain(identity);
    expect(first.sources.find((status) => status.id === anthropic?.id)?.error).toBeNull();
  });

  it("marks the awesome MCP 25-link sample as discovery partial", async () => {
    const links = Array.from(
      { length: 25 },
      (_, index) => `https://github.com/example/server-${index}`,
    );
    const sources = createTestMossMarketplaceSources({
      enableDiscoverySources: true,
      fetch: async (url) =>
        url.includes("awesome-mcp-servers/main/README.md")
          ? new Response(links.join("\n"))
          : jsonResponse({
              name: "server",
              full_name: "example/server",
              html_url: url,
            }),
    });
    const awesome = sources.find((source) => source.id === "awesome-mcp-servers");
    const page = await awesome?.fetchPage({
      kind: "mcp",
      cursor: null,
      limit: 100,
      query: "",
      now: NOW,
    });

    expect(page?.candidates).toHaveLength(25);
    expect(page).toMatchObject({
      complete: false,
      truncated: true,
      partial: true,
      fullSnapshot: false,
    });
  });

  it("uses one source-wide deadline for awesome MCP repository enrichment", async () => {
    const links = Array.from(
      { length: 25 },
      (_, index) => `https://github.com/example/slow-server-${index}`,
    );
    let metadataCalls = 0;
    const awesome = createTestMossMarketplaceSources({
      enableDiscoverySources: true,
      remoteTimeoutMs: 5,
      resolveHost: async () => ["93.184.216.34"],
      fetch: async (url) => {
        if (url.includes("awesome-mcp-servers/main/README.md")) {
          return new Response(links.join("\n"));
        }
        metadataCalls += 1;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: () => new Promise<never>(() => undefined),
              cancel: async () => undefined,
            }),
          },
        } as unknown as Response;
      },
    }).find((source) => source.id === "awesome-mcp-servers");

    const page = await awesome?.fetchPage({
      kind: "mcp",
      cursor: null,
      limit: 100,
      query: "",
      now: NOW,
    });

    expect(metadataCalls).toBe(1);
    expect(page).toMatchObject({ partial: true, fullSnapshot: false });
  });

  it("rejects redirects to loopback and cloud metadata addresses", async () => {
    const makeRedirectResponse = (location: string) =>
      ({
        ok: false,
        status: 302,
        statusText: "Found",
        headers: { get: (name: string) => (name.toLowerCase() === "location" ? location : null) },
      }) as unknown as Response;
    const redirected = createTestMossMarketplaceSources({
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => makeRedirectResponse("https://127.0.0.1:8080/internal"),
    }).find((source) => source.id === "official-mcp-registry");
    const metadata = createTestMossMarketplaceSources({
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => makeRedirectResponse("https://169.254.169.254/latest/meta-data"),
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      redirected?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_REDIRECT_HOST_NOT_ALLOWED" });
    await expect(
      metadata?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_REDIRECT_HOST_NOT_ALLOWED" });
  });

  it("rejects DNS answers resolving to private or link-local addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
      "0:0:0:0:0:0:7f00:1",
      "::ffff:7f00:1",
      "2130706433",
    ]) {
      const official = createTestMossMarketplaceSources({
        resolveHost: async () => [address],
        fetch: async () =>
          ({
            ok: true,
            status: 200,
            statusText: "OK",
            body: new Blob([JSON.stringify({ servers: [] })]).stream(),
          }) as Response,
      }).find((source) => source.id === "official-mcp-registry");

      await expect(
        official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
      ).rejects.toMatchObject({ code: "REMOTE_HOST_IP_NOT_ALLOWED" });
    }
  });

  it("limits streamed response bytes before decoding", async () => {
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: async () => ({ done: false, value: new Uint8Array(4 * 1024 * 1024 + 1) }),
              cancel: async () => undefined,
            }),
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_RESPONSE_TOO_LARGE" });
  });

  it("aborts a response body that never completes", async () => {
    const official = createTestMossMarketplaceSources({
      remoteTimeoutMs: 10,
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: () => new Promise<never>(() => undefined),
              cancel: async () => undefined,
            }),
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_TIMEOUT" });
  });

  it("rejects a null response body without calling an unbounded text fallback", async () => {
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: null,
          text: async () => JSON.stringify({ servers: [] }),
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_BODY_UNAVAILABLE" });
  });

  it("fails closed for a non-stream Response-like body without calling text", async () => {
    let textCalls = 0;
    let cancelCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            cancel: async () => {
              cancelCalls += 1;
            },
          },
          text: async () => {
            textCalls += 1;
            return JSON.stringify({ servers: [] });
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_BODY_UNAVAILABLE" });
    expect(textCalls).toBe(0);
    expect(cancelCalls).toBe(1);
  });

  it("cleans up and fails closed when getReader throws", async () => {
    let textCalls = 0;
    let abortCalls = 0;
    let destroyCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => {
              throw new Error("fixture reader unavailable");
            },
            abort: () => {
              abortCalls += 1;
            },
            destroy: () => {
              destroyCalls += 1;
            },
          },
          text: async () => {
            textCalls += 1;
            return JSON.stringify({ servers: [] });
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_BODY_UNAVAILABLE" });
    expect(textCalls).toBe(0);
    expect(abortCalls).toBe(1);
    expect(destroyCalls).toBe(0);
  });

  it("cancels an oversized response body before rejecting content-length", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-length" ? String(4 * 1024 * 1024 + 1) : null,
          },
          body: {
            getReader: () => ({
              read: async () => ({ done: true, value: undefined }),
              cancel: async () => {
                cancelCalls += 1;
              },
              releaseLock: () => {
                releaseCalls += 1;
              },
            }),
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_RESPONSE_TOO_LARGE" });
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("cancels and releases a streaming reader after a body read failure", async () => {
    let cancelCalls = 0;
    let releaseCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: async () => {
                throw new Error("fixture reader failure");
              },
              cancel: async () => {
                cancelCalls += 1;
              },
              releaseLock: () => {
                releaseCalls += 1;
              },
            }),
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_FETCH_FAILED" });
    expect(cancelCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("force-closes a streaming body when reader cancellation rejects", async () => {
    let cancelCalls = 0;
    let abortCalls = 0;
    let destroyCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: async () => {
                throw new Error("fixture reader failure");
              },
              cancel: async () => {
                cancelCalls += 1;
                throw new Error("fixture cancel failure");
              },
              releaseLock: () => undefined,
            }),
            abort: () => {
              abortCalls += 1;
            },
            destroy: () => {
              destroyCalls += 1;
            },
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_FETCH_FAILED" });
    expect(cancelCalls).toBe(1);
    expect(abortCalls).toBe(1);
    expect(destroyCalls).toBe(0);
  });

  it("registers and removes one abort listener for a streamed response", async () => {
    let addCalls = 0;
    let removeCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async (_url, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing request signal");
        const originalAdd = signal.addEventListener.bind(signal);
        const originalRemove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((type, listener, options) => {
          if (type === "abort") addCalls += 1;
          return originalAdd(type, listener, options);
        }) as AbortSignal["addEventListener"];
        signal.removeEventListener = ((type, listener, options) => {
          if (type === "abort") removeCalls += 1;
          return originalRemove(type, listener, options);
        }) as AbortSignal["removeEventListener"];
        const bytes = new TextEncoder().encode(JSON.stringify({ servers: [] }));
        const chunks = [bytes.slice(0, 1), bytes.slice(1, 2), bytes.slice(2)];
        let index = 0;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: async () =>
                index < chunks.length
                  ? { done: false, value: chunks[index++] }
                  : { done: true, value: undefined },
              cancel: async () => undefined,
            }),
          },
        } as unknown as Response;
      },
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW });

    expect(addCalls).toBe(1);
    expect(removeCalls).toBe(1);
  });

  it("registers and removes one abort listener while discarding a redirect body", async () => {
    let addCalls = 0;
    let removeCalls = 0;
    let fetchCalls = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async (_url, init) => {
        if (fetchCalls === 0) {
          const signal = init?.signal;
          if (!signal) throw new Error("missing request signal");
          const originalAdd = signal.addEventListener.bind(signal);
          const originalRemove = signal.removeEventListener.bind(signal);
          signal.addEventListener = ((type, listener, options) => {
            if (type === "abort") addCalls += 1;
            return originalAdd(type, listener, options);
          }) as AbortSignal["addEventListener"];
          signal.removeEventListener = ((type, listener, options) => {
            if (type === "abort") removeCalls += 1;
            return originalRemove(type, listener, options);
          }) as AbortSignal["removeEventListener"];
          fetchCalls += 1;
          const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
          let index = 0;
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "location"
                  ? "https://api.github.com/repos/example/server"
                  : null,
            },
            body: {
              getReader: () => ({
                read: async () =>
                  index < chunks.length
                    ? { done: false, value: chunks[index++] }
                    : { done: true, value: undefined },
                cancel: async () => undefined,
              }),
            },
          } as unknown as Response;
        }
        fetchCalls += 1;
        return new Response(JSON.stringify({ servers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW });

    expect(fetchCalls).toBe(2);
    expect(addCalls).toBe(3);
    expect(removeCalls).toBe(3);
  });

  it("rejects a response that exceeds the bounded chunk count", async () => {
    const maxChunks = 8_192;
    let index = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          body: {
            getReader: () => ({
              read: async () =>
                index++ < maxChunks + 1
                  ? { done: false, value: new Uint8Array([32]) }
                  : { done: true, value: undefined },
              cancel: async () => undefined,
            }),
          },
        }) as unknown as Response,
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_RESPONSE_TOO_MANY_CHUNKS" });
  });

  it("rejects a redirect body that exceeds the bounded discard chunk count", async () => {
    const maxChunks = 2_048;
    let fetchCalls = 0;
    let index = 0;
    const official = createTestMossMarketplaceSources({
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls > 1) return new Response(JSON.stringify({ servers: [] }));
        return {
          ok: false,
          status: 302,
          statusText: "Found",
          headers: { get: () => "https://api.github.com/repos/example/server" },
          body: {
            getReader: () => ({
              read: async () =>
                index++ < maxChunks + 1
                  ? { done: false, value: new Uint8Array([32]) }
                  : { done: true, value: undefined },
              cancel: async () => undefined,
            }),
          },
        } as unknown as Response;
      },
      resolveHost: async () => ["93.184.216.34"],
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_RESPONSE_TOO_MANY_CHUNKS" });
    expect(fetchCalls).toBe(1);
  });

  it("strips credential headers across an allowed cross-origin redirect", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const smithery = createTestMossMarketplaceSources({
      smitheryApiKey: "secret-smithery-key",
      resolveHost: async () => ["93.184.216.34"],
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        if (calls.length === 1) {
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            headers: {
              get: (name: string) =>
                name === "location" ? "https://api.github.com/repos/example/server" : null,
            },
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: new Blob([JSON.stringify({ servers: [] })]).stream(),
          headers: new Headers({ "content-type": "application/json" }),
        } as unknown as Response;
      },
    }).find((source) => source.id === "smithery");

    await smithery?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer secret-smithery-key");
    expect(calls[1]?.headers.get("authorization")).toBeNull();
    expect(calls[1]?.headers.get("cookie")).toBeNull();
  });

  it("cancels or drains every redirect body before following the next hop", async () => {
    let cancelCalls = 0;
    let calls = 0;
    const official = createTestMossMarketplaceSources({
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            headers: {
              get: (name: string) =>
                name === "location" ? "https://api.github.com/repos/example/server" : null,
            },
            body: {
              getReader: () => ({
                read: async () => ({ done: true, value: undefined }),
                cancel: async () => {
                  cancelCalls += 1;
                },
              }),
            },
          } as unknown as Response;
        }
        return new Response(JSON.stringify({ servers: [] }));
      },
    }).find((source) => source.id === "official-mcp-registry");

    await official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW });
    expect(calls).toBe(2);
    expect(cancelCalls).toBe(1);
  });

  it("destroys a redirect body when getReader throws", async () => {
    let destroyCalls = 0;
    const official = createTestMossMarketplaceSources({
      resolveHost: async () => ["93.184.216.34"],
      fetch: async (_url, init) => {
        if (init?.redirect === "manual") {
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            headers: {
              get: (name: string) =>
                name === "location" ? "https://api.github.com/repos/example/server" : null,
            },
            body: {
              getReader: () => {
                throw new Error("reader unavailable");
              },
              destroy: () => {
                destroyCalls += 1;
              },
            },
          } as unknown as Response;
        }
        return new Response(JSON.stringify({ servers: [] }));
      },
    }).find((source) => source.id === "official-mcp-registry");

    await expect(
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    ).rejects.toMatchObject({ code: "REMOTE_FETCH_FAILED" });
    expect(destroyCalls).toBe(1);
  });

  it("destroys a redirect body when reader cancellation rejects", async () => {
    let destroyCalls = 0;
    let calls = 0;
    const official = createTestMossMarketplaceSources({
      resolveHost: async () => ["93.184.216.34"],
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 302,
            statusText: "Found",
            headers: {
              get: (name: string) =>
                name === "location" ? "https://api.github.com/repos/example/server" : null,
            },
            body: {
              getReader: () => ({
                read: async () => ({ done: true, value: undefined }),
                cancel: async () => {
                  throw new Error("cancel failed");
                },
              }),
              destroy: () => {
                destroyCalls += 1;
              },
            },
          } as unknown as Response;
        }
        return new Response(JSON.stringify({ servers: [] }));
      },
    }).find((source) => source.id === "official-mcp-registry");

    await official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW });
    expect(destroyCalls).toBe(1);
  });

  it("rejects oversized pages and candidate contexts before resident admission", async () => {
    const oversizedPage = new MossMarketplaceAggregation({
      maxCacheBytes: 1_024,
      sources: [
        source(
          {
            id: "oversized-page",
            label: "Oversized page",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate("mcp:oversized-page", { description: "x".repeat(10_000) })],
            nextCursor: null,
          }),
        ),
      ],
    });
    const pageResult = await oversizedPage.browse({ kind: "mcp", query: { limit: 10 } });
    expect(pageResult.entries).toEqual([]);
    expect(pageResult.sources[0]?.error).toBe("SOURCE_CACHE_CAPACITY");
    expect(oversizedPage.getCacheStats().pages).toBe(0);

    const oversizedContext = new MossMarketplaceAggregation({
      maxCacheBytes: 1_024 * 1024,
      maxCandidateContextBytes: 128,
      sources: [
        source(
          {
            id: "oversized-context",
            label: "Oversized context",
            tier: "discovery",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [candidate("mcp:oversized-context")],
            sourceVersion: "v".repeat(1_000),
            nextCursor: null,
          }),
        ),
      ],
    });
    const contextResult = await oversizedContext.browse({ kind: "mcp", query: { limit: 10 } });
    expect(contextResult.entries).toEqual([]);
    expect(contextResult.sources[0]?.error).toBe("SOURCE_CACHE_CAPACITY");
    expect(oversizedContext.getCacheStats().candidateContexts).toBe(0);
  });

  it("fails closed when an ordinary unbranded resolved fetch is supplied", () => {
    const sources = createMossMarketplaceSources({
      fetchResolved: (async () =>
        new Response(JSON.stringify({ servers: [] }))) as unknown as MossMarketplaceResolvedFetch,
    });
    expect(sources.find((source) => source.id === "official-mcp-registry")).toMatchObject({
      enabled: false,
      disabledReason: "safe resolved-IP transport is not configured",
    });
  });

  it("passes the verified address to the transport and does not re-resolve before connect", async () => {
    let resolveCalls = 0;
    let resolvedTransportInput: { url: string; ip: string } | undefined;
    const official = createTestMossMarketplaceSources({
      resolveHost: async () => {
        resolveCalls += 1;
        return resolveCalls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
      },
      fetch: async () => new Response(JSON.stringify({ servers: [] })),
      fetchResolved: createMossMarketplaceResolvedFetch(async ({ url, ip }) => {
        resolvedTransportInput = { url, ip };
        return new Response(JSON.stringify({ servers: [] }));
      }),
    }).find((source) => source.id === "official-mcp-registry");

    await official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW });
    expect(resolveCalls).toBe(1);
    expect(resolvedTransportInput?.ip).toBe("93.184.216.34");
    expect(resolvedTransportInput?.url).toContain("registry.modelcontextprotocol.io");
  });

  it("uses a real branded HTTPS transport with verified IP, SNI/Host, and per-hop DNS checks", async () => {
    const verifiedIp = "93.184.216.34";
    const resolvedIps: string[] = [];
    const hostHeaders: string[] = [];
    const requestPaths: string[] = [];
    const server = createHttpsServer(
      {
        key: LOCAL_TLS_KEY,
        cert: LOCAL_TLS_CERT,
      },
      (request, response) => {
        hostHeaders.push(request.headers.host ?? "");
        requestPaths.push(request.url ?? "");
        if (requestPaths.length === 1) {
          response.statusCode = 302;
          response.setHeader(
            "location",
            "https://registry.modelcontextprotocol.io/v0.1/servers?redirected=1",
          );
          response.end("redirect body is drained before the next hop");
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ servers: [], metadata: { nextCursor: null } }));
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("local HTTPS fixture did not expose an address");
    }

    const requestOptions: MossMarketplacePinnedRequestOptions[] = [];
    const transport = createMossMarketplacePinnedHttpsFetch((options, callback) => {
      requestOptions.push(options);
      return httpsRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: options.path,
          method: options.method,
          headers: options.headers,
          servername: options.servername,
          ca: options.ca,
          rejectUnauthorized: options.rejectUnauthorized,
        },
        callback,
      );
    });

    try {
      const official = createTestMossMarketplaceSources({
        allowedRemoteHosts: ["registry.modelcontextprotocol.io"],
        resolveHost: async (hostname) => {
          expect(hostname).toBe("registry.modelcontextprotocol.io");
          resolvedIps.push(verifiedIp);
          return [verifiedIp];
        },
        tlsCa: LOCAL_TLS_CERT,
        fetchResolved: transport,
      }).find((source) => source.id === "official-mcp-registry");

      await official?.fetchPage({
        kind: "mcp",
        cursor: null,
        limit: 10,
        query: "",
        now: NOW,
      });
      expect(resolvedIps).toEqual([verifiedIp, verifiedIp]);
      expect(requestOptions).toHaveLength(2);
      expect(requestOptions.every((options) => options.hostname === verifiedIp)).toBe(true);
      expect(
        requestOptions.every(
          (options) => options.servername === "registry.modelcontextprotocol.io",
        ),
      ).toBe(true);
      expect(
        requestOptions.every(
          (options) => options.headers.host === "registry.modelcontextprotocol.io",
        ),
      ).toBe(true);
      expect(requestOptions.every((options) => options.rejectUnauthorized === true)).toBe(true);
      for (const options of requestOptions) {
        options.lookup("ignored-host", {}, (error, addressValue) => {
          expect(error).toBeNull();
          expect(addressValue).toBe(verifiedIp);
        });
      }
      // The Bun node:https shim does not reliably expose servername on local
      // socket events; builder options above are the narrow SNI evidence.
      expect(hostHeaders).toEqual([
        "registry.modelcontextprotocol.io",
        "registry.modelcontextprotocol.io",
      ]);
      expect(requestPaths).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("removes the pinned HTTPS abort listener on success, error, and abort", async () => {
    for (const mode of ["success", "error", "abort"] as const) {
      const controller = new AbortController();
      let addCalls = 0;
      let removeCalls = 0;
      const originalAdd = controller.signal.addEventListener.bind(controller.signal);
      const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener = ((type, listener, options) => {
        if (type === "abort") addCalls += 1;
        return originalAdd(type, listener, options);
      }) as AbortSignal["addEventListener"];
      controller.signal.removeEventListener = ((type, listener, options) => {
        if (type === "abort") removeCalls += 1;
        return originalRemove(type, listener, options);
      }) as AbortSignal["removeEventListener"];

      const transport = createMossMarketplacePinnedHttpsFetch((_options, callback) => {
        const request = new EventEmitter() as EventEmitter & {
          destroy: (error?: Error) => void;
          write: (_body: string | Uint8Array) => boolean;
          end: () => void;
        };
        request.destroy = () => undefined;
        request.write = () => true;
        request.end = () => {
          if (mode === "success") {
            const response = new PassThrough() as PassThrough & {
              statusCode: number;
              statusMessage: string;
              headers: Record<string, string>;
            };
            response.statusCode = 200;
            response.statusMessage = "OK";
            response.headers = {};
            callback(response as never);
            request.emit("close");
          } else if (mode === "error") {
            request.emit("error", new Error("fixture request failure"));
          } else {
            controller.abort();
          }
        };
        return request as never;
      });

      const pending = transport({
        url: "https://registry.modelcontextprotocol.io/v0.1/servers",
        ip: "93.184.216.34",
        init: { signal: controller.signal },
      });
      if (mode === "success") {
        await pending;
      } else {
        await expect(pending).rejects.toBeDefined();
      }
      expect(addCalls).toBe(1);
      expect(removeCalls).toBe(1);
    }
  });

  it("bounds non-cancellable DNS resolutions while request signals time out", async () => {
    let resolveCalls = 0;
    const pendingResolvers: Array<(addresses: readonly string[]) => void> = [];
    const official = createTestMossMarketplaceSources({
      remoteTimeoutMs: 5,
      resolveHost: async () => {
        resolveCalls += 1;
        return new Promise<readonly string[]>((resolve) => {
          pendingResolvers.push(resolve);
        });
      },
      fetch: async () => new Response(JSON.stringify({ servers: [] })),
    }).find((source) => source.id === "official-mcp-registry");

    const requests = Array.from({ length: 40 }, () =>
      official?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW }),
    );
    await Promise.allSettled(requests);
    expect(resolveCalls).toBeLessThanOrEqual(32);
    for (const resolve of pendingResolvers) resolve(["93.184.216.34"]);
  });

  it("rejects userinfo and non-default TLS ports on redirects", async () => {
    const redirect = (location: string) =>
      createTestMossMarketplaceSources({
        resolveHost: async () => ["93.184.216.34"],
        fetch: async () =>
          ({
            ok: false,
            status: 302,
            statusText: "Found",
            headers: { get: (name: string) => (name === "location" ? location : null) },
          }) as unknown as Response,
      })
        .find((source) => source.id === "official-mcp-registry")
        ?.fetchPage({ kind: "mcp", cursor: null, limit: 10, query: "", now: NOW });

    await expect(
      redirect("https://user:pass@registry.modelcontextprotocol.io/docs"),
    ).rejects.toMatchObject({
      code: "REMOTE_REDIRECT_HOST_NOT_ALLOWED",
    });
    await expect(
      redirect("https://registry.modelcontextprotocol.io:8443/docs"),
    ).rejects.toMatchObject({
      code: "REMOTE_REDIRECT_HOST_NOT_ALLOWED",
    });
  });

  it("keeps invalid license identifiers unknown and preserves upstream/local provenance", async () => {
    const catalog = aggregation({
      sources: [
        source(
          {
            id: "official",
            label: "Official",
            tier: "official",
            supportedKinds: ["mcp"],
          },
          async () => ({
            candidates: [
              candidate("mcp:invalid-license", {
                license: { status: "known", spdxId: "not-a-license" },
              }),
            ],
            sourceVersion: "registry-v11",
            generation: 11,
            snapshot: "upstream-11",
            complete: true,
            truncated: false,
            partial: false,
            fullSnapshot: true,
            nextCursor: null,
          }),
        ),
      ],
    });
    const entry = (await catalog.browse({ kind: "mcp", query: { limit: 10 } })).entries[0];

    expect(entry?.license).toMatchObject({ status: "unknown", spdxId: null });
    expect(entry?.provenance.license).toMatchObject({
      upstreamGeneration: 11,
      upstreamSnapshot: "upstream-11",
    });
    expect(entry?.provenance.identity).toMatchObject({
      localGeneration: expect.any(Number),
      localSnapshot: expect.any(String),
    });
  });
});
