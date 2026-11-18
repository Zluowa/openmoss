import { describe, expect, it } from "vitest";

import {
  classifyCodeUpdateChanges,
  MIGRATIONS_SOURCE,
  readMigrationLevels,
} from "./code-update-policy.ts";

const migrations = (ids: number[], additive: number[] = []) => `
export const migrationEntries = [
${ids.map((id) => `  [${id}, "M${id}", Migration${id}],`).join("\n")}
] as const;
export const MIGRATIONS_OLDER_READERS_MAY_IGNORE: ReadonlyArray<readonly [number, string]> = [
${additive.map((id) => `  [${id}, "M${id}"],`).join("\n")}
];
`;

const none = () => ({ before: null, after: null });

describe("classifyCodeUpdateChanges", () => {
  it("carries app code changes", () => {
    expect(
      classifyCodeUpdateChanges(
        [
          "apps/web/src/components/ChatView.tsx",
          "apps/server/src/http.ts",
          "apps/desktop/src/main.ts",
        ],
        none,
      ),
    ).toEqual([]);
  });

  it("refuses a change to the shell's boot entry, but not to its test", () => {
    expect(classifyCodeUpdateChanges(["apps/desktop/src/codeUpdateBoot.ts"], none)).toEqual([
      expect.objectContaining({ path: "apps/desktop/src/codeUpdateBoot.ts" }),
    ]);
    expect(classifyCodeUpdateChanges(["apps/desktop/src/codeUpdateBoot.test.ts"], none)).toEqual(
      [],
    );
  });

  it("keeps the fast-refresh refusals (packaged resources)", () => {
    expect(
      classifyCodeUpdateChanges(
        ["apps/desktop/resources/moss-production-public-config.json"],
        none,
      ),
    ).toHaveLength(1);
  });

  it("carries an additive migration and refuses one that raises the reader floor", () => {
    const read = (after: string) => (path: string) =>
      path === MIGRATIONS_SOURCE
        ? { before: migrations([168, 169]), after }
        : { before: null, after: null };
    expect(
      classifyCodeUpdateChanges([MIGRATIONS_SOURCE], read(migrations([168, 169, 170], [170]))),
    ).toEqual([]);
    expect(
      classifyCodeUpdateChanges([MIGRATIONS_SOURCE], read(migrations([168, 169, 170]))),
    ).toEqual([
      expect.objectContaining({ reason: expect.stringContaining("reader floor to 170") }),
    ]);
  });
});

describe("readMigrationLevels", () => {
  it("reads the latest id and the floor; an older source without the additive list has none", () => {
    expect(readMigrationLevels(migrations([1, 2, 3], [3]))).toEqual({ latest: 3, readerFloor: 2 });
    expect(
      readMigrationLevels(
        `export const migrationEntries = [\n  [1, "A", M1],\n  [2, "B", M2],\n] as const;`,
      ),
    ).toEqual({ latest: 2, readerFloor: 2 });
    expect(readMigrationLevels("nothing here")).toBeNull();
  });
});
