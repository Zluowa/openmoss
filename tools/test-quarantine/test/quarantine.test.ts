import { describe, expect, it } from "vitest";

import {
  MAX_ENTRIES,
  entriesFor,
  nameCovers,
  parseQuarantineId,
  validateQuarantine,
  type QuarantineEntry,
} from "../quarantine.ts";

const TODAY = "2026-11-11";

function entry(
  overrides: Partial<Record<keyof QuarantineEntry, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "server:apps/server/src/http.test.ts > production Effect HTTP routes > serves a link",
    platform: "win32",
    reason: "Machine-only: needs symlink rights.",
    owner: "server",
    added: "2026-11-11",
    expires: "2026-11-25",
    evidence: "verify-full 459a2e649",
    ...overrides,
  };
}

const validate = (entries: unknown, today = TODAY) => validateQuarantine(entries, { today });

describe("validateQuarantine", () => {
  it("accepts a complete entry", () => {
    expect(validate([entry()])).toEqual([]);
  });

  it("fails an expired entry, and accepts it on its last day", () => {
    expect(validate([entry()], "2026-11-25")).toEqual([]);
    expect(validate([entry()], "2026-11-26")).toEqual([
      expect.stringMatching(/expired on 2026-11-25/),
    ]);
  });

  it("fails an entry without an owner, or with an owner that is not an area", () => {
    const { owner: _owner, ...withoutOwner } = entry();
    expect(validate([withoutOwner])).toEqual([
      expect.stringMatching(/"owner" is missing or empty/),
    ]);
    expect(validate([entry({ owner: "  " })])).toEqual([
      expect.stringMatching(/"owner" is missing or empty/),
    ]);
    expect(validate([entry({ owner: "Somebody Else" })])).toEqual([
      expect.stringMatching(/owner must be an area/),
    ]);
    expect(validate([entry({ owner: "web/transcript" })])).toEqual([]);
  });

  it(`fails more than ${MAX_ENTRIES} entries`, () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        entry({ id: `server:apps/server/src/t${index}.test.ts` }),
      );
    expect(validate(many(MAX_ENTRIES))).toEqual([]);
    expect(validate(many(MAX_ENTRIES + 1))).toEqual([
      expect.stringMatching(new RegExp(`^${MAX_ENTRIES + 1} entries; the limit is ${MAX_ENTRIES}`)),
    ]);
  });

  it("fails an unknown platform", () => {
    expect(validate([entry({ platform: "windows" })])).toEqual([
      expect.stringMatching(/platform must be one of win32, linux, darwin, all/),
    ]);
  });

  it("fails an expiry more than 14 days after the entry was added, or before it", () => {
    expect(validate([entry({ expires: "2026-11-26" })])).toEqual([
      expect.stringMatching(/expires 15 days after it was added; the limit is 14/),
    ]);
    expect(validate([entry({ expires: "2026-11-10" })])).toEqual(
      expect.arrayContaining([expect.stringMatching(/expires before it was added/)]),
    );
    expect(validate([entry({ added: "2026-11-20", expires: "2026-11-30" })])).toEqual([
      expect.stringMatching(/added 2026-11-20 is in the future/),
    ]);
    expect(validate([entry({ added: "2026-02-30" })])).toEqual([
      expect.stringMatching(/added must be a date/),
    ]);
  });

  it("fails ids whose lane, folder or file kind do not agree", () => {
    expect(validate([entry({ id: "unit:apps/server/src/http.test.ts" })])).toEqual([
      expect.stringMatching(/id must be "<lane>:<repo-relative file>/),
    ]);
    expect(validate([entry({ id: "web:apps/server/src/http.test.ts" })])).toEqual([
      expect.stringMatching(/lane "web" runs files under apps\/web\//),
    ]);
    expect(validate([entry({ id: "web:apps/web/src/components/ChatView.browser.tsx" })])).toEqual([
      expect.stringMatching(/unit lanes do not run \*\.browser\.\* files/),
    ]);
    expect(validate([entry({ id: "chat:apps/web/src/components/ChatView.test.ts" })])).toEqual([
      expect.stringMatching(/browser lanes run \*\.browser\.\* files/),
    ]);
  });

  it("fails duplicates, unknown fields, missing files and tests that are never quarantined", () => {
    expect(validate([entry(), entry()])).toEqual([expect.stringMatching(/duplicate id/)]);
    expect(validate([{ ...entry(), note: "x" }])).toEqual([
      expect.stringMatching(/unknown field "note"/),
    ]);
    expect(validateQuarantine([entry()], { today: TODAY, fileExists: () => false })).toEqual([
      expect.stringMatching(/apps\/server\/src\/http.test.ts does not exist/),
    ]);
    expect(
      validate([
        entry({ id: "desktop:apps/desktop/src/backendShutdown.windows.integration.test.ts" }),
      ]),
    ).toEqual([
      expect.stringMatching(/never quarantined, because it finds real shutdown regressions/),
    ]);
  });

  it("rejects a list that is not an array", () => {
    expect(validate({ entries: [] })).toEqual([
      "test-quarantine.json must hold a JSON array of entries",
    ]);
  });
});

describe("parseQuarantineId", () => {
  it("splits lane, file and test name at the first ' > '", () => {
    expect(parseQuarantineId("shared:packages/shared/src/a.test.ts")).toEqual({
      lane: "shared",
      file: "packages/shared/src/a.test.ts",
    });
    expect(
      parseQuarantineId("shared:packages/shared/src/a.test.ts > suite > case > with > arrows"),
    ).toEqual({
      lane: "shared",
      file: "packages/shared/src/a.test.ts",
      name: "suite > case > with > arrows",
    });
    expect(parseQuarantineId("shared:packages\\shared\\a.test.ts")).toBeNull();
    expect(parseQuarantineId("shared:packages/shared/src/a.test.ts > ")).toBeNull();
  });
});

describe("entriesFor", () => {
  it("keeps only the entries for this platform and those for every platform", () => {
    const list = [
      entry({ id: "server:apps/server/src/a.test.ts", platform: "win32" }),
      entry({ id: "server:apps/server/src/b.test.ts", platform: "linux" }),
      entry({ id: "server:apps/server/src/c.test.ts", platform: "all" }),
    ] as unknown as QuarantineEntry[];
    expect(entriesFor(list, "win32").map(({ file }) => file)).toEqual([
      "apps/server/src/a.test.ts",
      "apps/server/src/c.test.ts",
    ]);
    expect(entriesFor(list, "linux").map(({ file }) => file)).toEqual([
      "apps/server/src/b.test.ts",
      "apps/server/src/c.test.ts",
    ]);
    expect(entriesFor(list, "darwin").map(({ file }) => file)).toEqual([
      "apps/server/src/c.test.ts",
    ]);
  });
});

describe("nameCovers", () => {
  it("covers the named test, a describe block, and each() cases, but not a longer word", () => {
    expect(nameCovers("suite > case", "suite > case")).toBe(true);
    expect(nameCovers("suite", "suite > case")).toBe(true);
    expect(nameCovers("fits the bar", "fits the bar (light)")).toBe(true);
    expect(nameCovers("suite > case", "suite > case two")).toBe(true);
    expect(nameCovers("suite > case", "suite > cases")).toBe(false);
    expect(nameCovers("suite > case", "other > suite > case")).toBe(false);
  });

  it("treats title placeholders as wildcards and everything else literally", () => {
    expect(
      nameCovers(
        "geometry > clamps at the $name viewport",
        "geometry > clamps at the narrow viewport",
      ),
    ).toBe(true);
    expect(nameCovers("forks with %s tier", "forks with Standard tier")).toBe(true);
    expect(nameCovers("logo content: $kind symlink", "logo content: app symlink")).toBe(true);
    expect(nameCovers("logo content: $kind symlink", "logo content: html declaration")).toBe(false);
    expect(nameCovers("routes (a+b)", "routes (a+b)")).toBe(true);
    expect(nameCovers("routes (a+b)", "routes (aab)")).toBe(false);
    expect(nameCovers("suite > [geometry:linux]", "suite > [geometry:linux] clamps")).toBe(true);
  });
});
