// FILE: tools/queue/test/parse.test.ts
// Purpose: Reading Vitest output (excerpts of real lane logs) and the lane table's commands.
// Layer: test

import { describe, expect, it } from "vitest";
import { classifyOutput, matchFailures } from "../lib/executor.ts";
import { LANES, laneByName, laneCommand, quarantineId, selectLanes } from "../lib/lanes.ts";
import { namePattern, parseFailLine, parseVitest, stripAnsi } from "../lib/vitest.ts";
import { fixture } from "./helpers.ts";

describe("parseVitest", () => {
  it("reads the summary and FAIL lines of a failing unit lane", () => {
    const r = parseVitest(fixture("batch5/lane-desktop.txt"));
    expect(r.summary).toBe(true);
    expect(r.files).toEqual({ failed: 2, passed: 181, skipped: 5, total: 188 });
    expect(r.tests).toEqual({ failed: 3, passed: 2281, skipped: 25, total: 2309 });
    expect(r.failures.toSorted((a, b) => (a.name! < b.name! ? -1 : 1))).toEqual([
      {
        file: "src/appSnapManager.test.ts",
        name: "AppSnap permission guide > writes close and SIGTERMs the guide when hidden",
      },
      {
        file: "src/appSnapManager.test.ts",
        name: "AppSnap window picker requests > removes a capture whose request times out while durable persistence is in flight",
      },
      {
        file: "src/cuaDriverHost.test.ts",
        name: "physical Escape interrupt > keeps Escape browser recovery separate from native reads and rejects an interrupted browser snapshot",
      },
    ]);
    expect(r.durationSeconds).toBeGreaterThan(0);
  });

  it("strips the browser project tag and keeps shortened titles", () => {
    const r = parseVitest(fixture("batch5/lane-compiler.txt"));
    expect(r.failures.map((f) => f.file)).toEqual([
      "src/components/chat/MessagesTimeline.renderScope.browser.tsx",
      "src/components/chat/MessagesTimeline.renderScope.browser.tsx",
      "src/components/chat/MessagesTimeline.renderScope.browser.tsx",
    ]);
    expect(r.failures[1]!.name).toContain("generated-image hi…");
    const c = parseVitest(fixture("misc/components-fail.txt"));
    expect(c.failures[0]!.file).toBe("src/components/settings/ImportSettingsPanel.browser.tsx");
  });

  it("reads a failed suite as a whole-file failure", () => {
    const r = parseVitest(fixture("misc/components-suite.txt"));
    expect(r.failures).toContainEqual({
      file: "src/components/SidebarGroupsSurface.browser.tsx",
      name: undefined,
    });
    expect(r.tests?.failed).toBe(10);
  });

  it("keeps the scripts lane's repository-relative paths", () => {
    const r = parseVitest(fixture("misc/scripts-fail.txt"));
    expect(r.tests).toMatchObject({ failed: 89, passed: 2327 });
    expect(new Set(r.failures.map((x) => x.file))).toEqual(
      new Set([
        "scripts/moss-managed-plugin-smoke-cleanup.test.ts",
        "scripts/moss-plugin-formal-visual-capture.test.ts",
      ]),
    );
    expect(quarantineId(laneByName("scripts")!, r.failures[0]!.file, undefined)).toBe(
      "scripts:scripts/moss-managed-plugin-smoke-cleanup.test.ts",
    );
  });

  it("counts errors outside tests, and ignores vite's console '[Unhandled error]' lines", () => {
    expect(parseVitest(fixture("misc/components-unhandled.txt")).errors).toBe(1);
    const chat = parseVitest(fixture("batch5/lane-chat.txt"));
    expect(chat.errors).toBe(0);
    expect(chat.failures).toHaveLength(1);
  });

  it("strips colour codes (as Vitest prints on a terminal)", () => {
    const colored =
      "\u001b[31m\u001b[1m FAIL \u001b[22m\u001b[39m src/a.test.ts\u001b[2m > \u001b[22mgroup\u001b[2m > \u001b[22mdoes it\r\n" +
      "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m3 passed\u001b[39m\u001b[22m\u001b[90m (4)\u001b[39m\n";
    expect(stripAnsi(colored).includes(String.fromCharCode(27))).toBe(false);
    const r = parseVitest(colored);
    expect(r.failures).toEqual([{ file: "src/a.test.ts", name: "group > does it" }]);
    expect(r.files).toEqual({ failed: 1, passed: 3, skipped: 0, total: 4 });
  });

  it("does not take a FAIL word in other output for a test", () => {
    expect(parseFailLine(" FAIL  something went wrong")).toBeUndefined();
    expect(parseFailLine("FAIL  scripts/x.test.ts > a")).toEqual({
      file: "scripts/x.test.ts",
      name: "a",
    });
  });

  it("builds a -t pattern from test names, cut at Vitest's ellipsis", () => {
    expect(namePattern(["A > b (c)", "A > d 'x hi…'"])).toBe("b \\(c\\)|d 'x hi");
  });
});

describe("classifyOutput", () => {
  const server = laneByName("server")!;
  it("green on exit 0, failed with tests, broken without them", () => {
    expect(classifyOutput(server, 0, fixture("batch5/lane-contracts.txt")).status).toBe("green");
    const failed = classifyOutput(server, 1, fixture("batch5/lane-server.txt"));
    expect(failed.status).toBe("failed");
    expect(failed.failures.length).toBeGreaterThanOrEqual(7);
    const broken = classifyOutput(server, 1, "Error: listen EADDRINUSE\n");
    expect(broken).toMatchObject({ status: "broken", failures: [{ file: "" }] });
    expect(broken.reason).toContain("no Vitest summary");
    expect(
      classifyOutput(laneByName("components")!, 1, fixture("misc/components-unhandled.txt")).status,
    ).toBe("failed");
  });
  it("a static check fails as a whole lane", () => {
    expect(classifyOutput(laneByName("fmt")!, 1, "x.ts (not formatted)")).toMatchObject({
      status: "failed",
      failures: [{ file: "", name: undefined }],
    });
  });
  it("matches failures across runs by file and name", () => {
    const first = classifyOutput(server, 1, fixture("batch5/lane-server.txt"));
    const again = classifyOutput(server, 0, fixture("batch5/rerun-server.txt"));
    expect(matchFailures(first.failures, { ...again }, "all").repeated).toEqual([]);
    const self = matchFailures(
      first.failures,
      { status: "failed", failures: first.failures },
      "none",
    );
    expect(self.repeated).toHaveLength(first.failures.length);
    expect(
      matchFailures(first.failures, { status: "broken", failures: [] }, "none").repeated,
    ).toEqual([]);
  });
});

describe("lanes", () => {
  const ctx = {
    bun: "bun.exe",
    node: "node",
    portBase: 53660,
    bin: (cwd: string, n: string) => `${cwd}/node_modules/.bin/${n}`,
  };
  const line = (name: string, selection = {}) => {
    const c = laneCommand(laneByName(name)!, ctx, selection);
    return [...Object.entries(c.env).map(([k, v]) => `${k}=${v}`), c.cmd, ...c.args].join(" ");
  };

  it("runs in the order and with the commands of verify-full-nocomp.sh", () => {
    expect(LANES.filter((l) => l.where === "local").map((l) => l.name)).toEqual([
      "fmt",
      "lint",
      "winruntime",
      "migrations",
      "typecheck",
      "contracts",
      "shared",
      "desktop",
      "web",
      "chat",
      "compiler",
      "server",
      "scripts",
      "releasesmoke",
    ]);
    expect(line("fmt")).toBe("bun.exe run fmt:check");
    expect(line("typecheck")).toBe(
      "./node_modules/.bin/turbo run typecheck --continue --filter=!@moss/marketing",
    );
    expect(line("web")).toBe(
      "apps/web/node_modules/.bin/vitest run --passWithNoTests --maxWorkers=3",
    );
    expect(line("chat")).toBe(
      "VITEST_BROWSER_API_PORT=53660 MOSS_BROWSER_CASE_PARTITION=1/1 apps/web/node_modules/.bin/vitest run --config vitest.browser.ci.config.ts --project=chat --browser.api.port=53661 --browser.api.strictPort --browser.connectTimeout=300000",
    );
    expect(line("compiler")).toBe(
      "VITEST_BROWSER_API_PORT=53662 apps/web/node_modules/.bin/vitest run --config vitest.browser.compiler.config.ts --browser.api.port=53662 --browser.api.strictPort --browser.connectTimeout=300000",
    );
    expect(line("components")).toBe(
      "VITEST_BROWSER_API_PORT=53660 apps/web/node_modules/.bin/vitest run --config vitest.browser.ci.config.ts --project=components --browser.api.port=53660 --browser.api.strictPort --browser.connectTimeout=300000",
    );
    expect(line("scripts")).toBe(
      "./node_modules/.bin/vitest run --passWithNoTests --maxWorkers=4 --dir scripts",
    );
    expect(line("releasesmoke")).toBe("node scripts/release-smoke.ts");
  });

  it("reruns files alone, or tests by name, never in parallel", () => {
    expect(line("server", { files: ["src/a.test.ts", "src/b.test.ts"] })).toMatch(
      /--maxWorkers=4 --no-file-parallelism src\/a\.test\.ts src\/b\.test\.ts$/,
    );
    expect(line("chat", { names: ["ChatView > covers B2.2a reduced-motion coachmark"] })).toContain(
      String.raw`--no-file-parallelism -t covers B2\.2a reduced-motion coachmark`,
    );
    expect(line("components", { shard: "2/3" })).toMatch(/--shard=2\/3$/);
  });

  it("names quarantine ids as the list expects", () => {
    expect(quarantineId(laneByName("server")!, "src/http.test.ts", "routes > a")).toBe(
      "server:apps/server/src/http.test.ts > routes > a",
    );
    expect(quarantineId(laneByName("scripts")!, "scripts/x.test.ts", undefined)).toBe(
      "scripts:scripts/x.test.ts",
    );
    expect(quarantineId(laneByName("compiler")!, "src/x.browser.tsx", "a")).toBeUndefined();
  });

  it("refuses unknown lanes", () => {
    expect(selectLanes(["fmt", "lint"]).map((l) => l.name)).toEqual(["fmt", "lint"]);
    expect(() => selectLanes(["nope"])).toThrow(/unknown lane nope/);
  });
});
