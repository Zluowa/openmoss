import { describe, expect, it } from "vitest";

import {
  MOSS_RELEASED_DESCRIPTOR,
  UPSTREAM_3CEFD5A_DESCRIPTOR,
  UPSTREAM_V084_DESCRIPTOR,
  UPSTREAM_V055_DESCRIPTOR,
  classifyMigrationLineage,
  requiredUpstreamFingerprintThrough,
} from "./MigrationLineage.ts";

const trackerThrough = (
  descriptor: ReadonlyArray<readonly [number, string]>,
  highWaterMark: number,
) =>
  descriptor
    .filter(([id]) => id <= highWaterMark)
    .map(([migration_id, name]) => ({ migration_id, name }));

const upstreamFingerprintThrough = (highWaterMark: number) => ({
  effects: requiredUpstreamFingerprintThrough(highWaterMark),
});

describe("migration lineage classifier", () => {
  it("classifies an empty tracker as fresh or untracked", () => {
    expect(classifyMigrationLineage([], { effects: [] })).toMatchObject({
      kind: "fresh-or-untracked",
    });
  });

  it("preserves exact Moss prefixes through the released and every partial upgrade range", () => {
    for (const highWaterMark of [52, ...Array.from({ length: 62 }, (_, index) => index + 53)]) {
      expect(
        classifyMigrationLineage(trackerThrough(MOSS_RELEASED_DESCRIPTOR, highWaterMark), {
          effects: [],
        }),
      ).toEqual({ kind: "moss-prefix", highWaterMark });
    }
  });

  it("maps immutable upstream source migrations 70-96 to canonical Moss loader IDs 80-106", () => {
    for (let upstreamSourceId = 70; upstreamSourceId <= 96; upstreamSourceId += 1) {
      const canonicalMossId = upstreamSourceId + 10;
      expect(MOSS_RELEASED_DESCRIPTOR[canonicalMossId - 1]).toEqual([
        canonicalMossId,
        UPSTREAM_3CEFD5A_DESCRIPTOR[upstreamSourceId - 1]?.[1],
      ]);
    }
  });

  it("recognizes every exact upstream high-water mark from 69 through 99", () => {
    for (let highWaterMark = 69; highWaterMark <= 99; highWaterMark += 1) {
      expect(
        classifyMigrationLineage(
          trackerThrough(UPSTREAM_3CEFD5A_DESCRIPTOR, highWaterMark),
          upstreamFingerprintThrough(highWaterMark),
        ),
      ).toEqual({
        kind: "moss-3cefd5a-prefix",
        highWaterMark,
        firstDivergedId: 53,
      });
    }
  });

  it("recognizes the released v0.8.4 upstream suffix with its schema fingerprint", () => {
    for (let highWaterMark = 100; highWaterMark <= 103; highWaterMark += 1) {
      expect(
        classifyMigrationLineage(
          trackerThrough(UPSTREAM_V084_DESCRIPTOR, highWaterMark),
          upstreamFingerprintThrough(highWaterMark),
        ),
      ).toEqual({
        kind: "moss-3cefd5a-prefix",
        highWaterMark,
        firstDivergedId: 53,
      });
    }
  });

  it("requires every upstream schema/data fingerprint effect", () => {
    const highWaterMark = 87;
    const effects = requiredUpstreamFingerprintThrough(highWaterMark);
    expect(effects.length).toBeGreaterThan(20);
    expect(
      classifyMigrationLineage(trackerThrough(UPSTREAM_3CEFD5A_DESCRIPTOR, highWaterMark), {
        effects: effects.slice(0, -1),
      }),
    ).toMatchObject({ kind: "unknown-or-mixed" });
  });

  it("recognizes the released v0.5.5 pins-at-54 lineage only with its schema fingerprint", () => {
    const tracker = trackerThrough(UPSTREAM_V055_DESCRIPTOR, 54);
    const effects = [
      ...requiredUpstreamFingerprintThrough(53),
      "table:project_pull_request_pins",
      "trigger:trg_project_pull_request_pins_limit",
    ];
    expect(classifyMigrationLineage(tracker, { effects })).toEqual({
      kind: "moss-3cefd5a-prefix",
      highWaterMark: 54,
      firstDivergedId: 53,
    });
    expect(classifyMigrationLineage(tracker, { effects: effects.slice(0, -1) })).toMatchObject({
      kind: "unknown-or-mixed",
    });
  });

  it("rejects gaps, duplicates, mixed names, and forged upstream rows", () => {
    const upstream = trackerThrough(UPSTREAM_3CEFD5A_DESCRIPTOR, 87);
    const cases = [
      upstream.filter(({ migration_id }) => migration_id !== 42),
      [...upstream, upstream[86]!],
      upstream.map((row) =>
        row.migration_id === 75 ? { ...row, name: "DurableQueuedTurnPromotions" } : row,
      ),
    ];

    for (const tracker of cases) {
      expect(classifyMigrationLineage(tracker, upstreamFingerprintThrough(87))).toMatchObject({
        kind: "unknown-or-mixed",
      });
    }
  });

  it("classifies a canonical newer Moss tracker as too new", () => {
    const latestMossId = MOSS_RELEASED_DESCRIPTOR.at(-1)![0];
    const tracker = [
      ...trackerThrough(MOSS_RELEASED_DESCRIPTOR, latestMossId),
      { migration_id: latestMossId + 1, name: "FutureMigration" },
    ];
    expect(classifyMigrationLineage(tracker, { effects: [] })).toEqual({
      kind: "too-new",
      highWaterMark: latestMossId + 1,
      latestSupportedMigrationId: latestMossId,
    });
  });

  it("keeps the current Moss migration suffix immutable", () => {
    expect(MOSS_RELEASED_DESCRIPTOR.slice(106, 113)).toEqual([
      [107, "ProjectionSidebarSections"],
      [108, "ProjectionThreadsArchiveSidebarPlacement"],
      [109, "ProjectionSidebarThreadOrder"],
      [110, "ProjectionSidebarProjectOrder"],
      [111, "ProjectionThreadsSidechatLifecycle"],
      [112, "MigrateKiloToOpenCode"],
      [113, "ProjectionThreadMessageRealtimeHandoffId"],
    ]);
  });
});
