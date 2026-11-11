import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { checkQuarantineFile } from "../check.ts";
import { utcToday, type QuarantineEntry } from "../quarantine.ts";
import { planRuns, summarise } from "../run.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "moss-quarantine-check-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function repoWith(list: unknown): string {
  const root = mkdtempSync(join(scratch, "repo-"));
  mkdirSync(join(root, "apps/server/src"), { recursive: true });
  writeFileSync(join(root, "apps/server/src/a.test.ts"), "");
  writeFileSync(
    join(root, "test-quarantine.json"),
    typeof list === "string" ? list : JSON.stringify(list),
  );
  return root;
}

const base: Omit<QuarantineEntry, "id"> = {
  platform: "win32",
  reason: "r",
  owner: "server",
  added: "2026-11-11",
  expires: "2026-11-25",
  evidence: "e",
};

describe("checkQuarantineFile", () => {
  it("passes the repository's own list today", () => {
    expect(checkQuarantineFile(repoRoot, utcToday()).problems).toEqual([]);
  });

  it("reports an expired entry, a missing owner and a missing file", () => {
    const root = repoWith([
      { ...base, id: "server:apps/server/src/a.test.ts" },
      { ...base, id: "server:apps/server/src/missing.test.ts", owner: "" },
    ]);
    expect(checkQuarantineFile(root, "2026-11-26").problems).toEqual([
      expect.stringMatching(/a\.test\.ts\): expired on 2026-11-25/),
      expect.stringMatching(/"owner" is missing or empty/),
      expect.stringMatching(/missing\.test\.ts does not exist/),
      expect.stringMatching(/missing\.test\.ts\): expired on 2026-11-25/),
    ]);
  });

  it("reports unreadable JSON instead of throwing", () => {
    expect(checkQuarantineFile(repoWith("[{"), "2026-11-11").problems).toEqual([
      expect.stringMatching(/^test-quarantine\.json: /),
    ]);
  });
});

describe("test:quarantined", () => {
  const entries: QuarantineEntry[] = [
    { ...base, id: "server:apps/server/src/a.test.ts" },
    { ...base, id: "server:apps/server/src/b.test.ts > suite > case" },
    { ...base, id: "server:apps/server/src/c.test.ts", platform: "linux" },
    { ...base, id: "components:apps/web/src/X.browser.tsx > renders", platform: "all" },
  ];

  it("plans one no-retry run per lane with this platform's files", () => {
    const runs = planRuns(entries, { platform: "win32", repoRoot: "/repo" });
    expect(runs.map((run) => [run.lane, run.entries.map((entry) => entry.id)])).toEqual([
      [
        "server",
        ["server:apps/server/src/a.test.ts", "server:apps/server/src/b.test.ts > suite > case"],
      ],
      ["components", ["components:apps/web/src/X.browser.tsx > renders"]],
    ]);
    expect(runs[0]!.args).toContain("--retry=0");
    expect(runs[0]!.args.at(-1)).toMatch(/\/repo\/apps\/server\/src\/b\.test\.ts$/);
    expect(runs[1]!.args).toEqual(
      expect.arrayContaining(["--config", "vitest.browser.ci.config.ts", "--project=components"]),
    );
    expect(
      planRuns(entries, { platform: "win32", repoRoot: "/repo", lanes: ["components"] }),
    ).toHaveLength(1);
  });

  it("reports pass, fail and not run per entry from the JSON report", () => {
    const [server] = planRuns(entries, { platform: "win32", repoRoot: "/repo" });
    const report = {
      testResults: [
        {
          name: resolve("/repo", "apps/server/src/a.test.ts"),
          status: "passed",
          assertionResults: [{ ancestorTitles: ["x"], title: "y", status: "passed" }],
        },
        {
          name: resolve("/repo", "apps/server/src/b.test.ts"),
          status: "failed",
          assertionResults: [
            { ancestorTitles: ["suite"], title: "case", status: "failed" },
            { ancestorTitles: ["suite"], title: "other", status: "skipped" },
          ],
        },
      ],
    };
    expect(
      summarise(server!.entries, report, { repoRoot: "/repo", lowerCasePaths: false }),
    ).toEqual([
      { id: "server:apps/server/src/a.test.ts", result: "pass", passed: 1, failed: 0 },
      {
        id: "server:apps/server/src/b.test.ts > suite > case",
        result: "fail",
        passed: 0,
        failed: 1,
      },
    ]);
    expect(summarise(server!.entries, null, { repoRoot: "/repo", lowerCasePaths: false })).toEqual([
      { id: "server:apps/server/src/a.test.ts", result: "not run", passed: 0, failed: 0 },
      {
        id: "server:apps/server/src/b.test.ts > suite > case",
        result: "not run",
        passed: 0,
        failed: 0,
      },
    ]);
  });
});
