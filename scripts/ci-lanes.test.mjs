import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ALL_LANES,
  ALL_UNIT_LANES,
  chatCovers,
  lanesFor,
  lanesLine,
  quickCovers,
} from "./ci-lanes.mjs";

const NOTHING = { unit: [], browser: false, windows: false };
const WEB_SUITE = { unit: ["web-1", "web-2", "web-3"], browser: true, windows: false };

describe("lanesFor", () => {
  it("leaves a web source change, translation tables included, to the Quick Check", () => {
    expect(
      lanesFor(["apps/web/src/components/chat/ChatView.tsx", "apps/web/src/localization/zhCN.ts"]),
    ).toEqual(NOTHING);
  });

  it("runs the whole web suite for the shared parts and the web package's configuration", () => {
    for (const path of [
      "apps/web/src/components/ui/button.tsx",
      "apps/web/src/index.css",
      "apps/web/src/theme/tokens.ts",
      // The translate code every screen runs lives beside its keyed table.
      "apps/web/src/localization.tsx",
      "apps/web/vite.config.ts",
      "apps/web/package.json",
    ]) {
      expect(lanesFor([path]), path).toEqual(WEB_SUITE);
    }
  });

  it("runs server, desktop and the Windows job for a server change", () => {
    expect(lanesFor(["apps/server/src/index.ts"])).toEqual({
      unit: ["desktop", "server-1", "server-2", "server-3"],
      browser: false,
      windows: true,
    });
  });

  it("runs the shared lane for root scripts and tools, nothing for words only", () => {
    expect(lanesFor(["scripts/check-copy-ratchet.ts", "tools/ws/cli.ts"])).toEqual({
      unit: ["shared"],
      browser: false,
      windows: false,
    });
    expect(lanesFor(["docs/design/moss-design-standard.md", "README.md"])).toEqual(NOTHING);
  });

  it("runs everything for shared packages, configs, the lockfile and anything unknown", () => {
    for (const path of [
      "packages/contracts/src/index.ts",
      "package.json",
      "bun.lock",
      ".github/workflows/ci.yml",
      "test-quarantine.json",
      "apps/mobile/app.json",
      "patches/x.patch",
    ]) {
      expect(lanesFor([path]), path).toEqual(ALL_LANES);
    }
  });

  it("joins the needs of several paths", () => {
    expect(lanesFor(["apps/web/src/components/ui/a.tsx", "apps/desktop/src/main.ts"])).toEqual({
      unit: ["web-1", "web-2", "web-3", "desktop"],
      browser: true,
      windows: true,
    });
  });
});

describe("quickCovers and chatCovers", () => {
  const plan = (left = [], rootConfig = []) => ({
    selection: { rootConfig },
    steps: left.map((name) => ({ name, status: "left" })),
  });

  it("are true when the Quick Check runs every test the change reaches", () => {
    expect(quickCovers(plan())).toBe(true);
    expect(chatCovers(plan())).toBe(true);
  });

  it("split component files from ChatView, which only the chat partitions run", () => {
    expect(quickCovers(plan(["browser (chat)"]))).toBe(true);
    expect(chatCovers(plan(["browser (chat)"]))).toBe(false);
    expect(quickCovers(plan(["browser"]))).toBe(false);
    expect(chatCovers(plan(["browser"]))).toBe(true);
  });

  it("are false for a wide change and a root configuration change", () => {
    for (const report of [plan(["tests"]), plan([], ["package.json"])]) {
      expect(quickCovers(report)).toBe(false);
      expect(chatCovers(report)).toBe(false);
    }
  });
});

/** @type {{ jobs: Record<string, any> }} */
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

/**
 * Evaluates the subset of GitHub's expression language these conditions use, for one commit
 * message, matrix lane and the two Quick Check verdicts (contains() is a case-insensitive
 * substring test).
 */
function evaluate(condition, { message, lane = "", covers, chat }) {
  const quote = (text) => JSON.stringify(text.toLowerCase());
  const js = condition
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/!cancelled\(\)/g, "true")
    .replace(
      /contains\(github\.event\.head_commit\.message, format\('([^']*)', matrix\.lane\)\)/g,
      (_, pattern) => `m.includes(${quote(pattern.replace("{0}", lane))})`,
    )
    .replace(
      /contains\(github\.event\.head_commit\.message, '([^']*)'\)/g,
      (_, text) => `m.includes(${quote(text)})`,
    )
    .replace(
      /startsWith\(matrix\.lane, '([^']*)'\)/g,
      (_, text) => `lane.startsWith(${quote(text)})`,
    )
    .replace(/matrix\.lane == '([^']*)'/g, (_, text) => `lane === ${quote(text)}`)
    .replace(/needs\.static\.outputs\.quick_covers != 'true'/g, "!covers")
    .replace(/needs\.static\.outputs\.chat_covers != 'true'/g, "!chat");
  if (/[a-z_]+\.[a-z_]+/.test(js.replace(/m\.includes|lane\.startsWith/g, ""))) {
    throw new Error(`unknown expression: ${js}`);
  }
  return new Function("m", "lane", "covers", "chat", `return (${js});`)(
    message.toLowerCase(),
    lane.toLowerCase(),
    covers,
    chat,
  );
}

/** The browser shard's first step (bash), as the workflow writes it. */
function shardWorks(project, { message, covers, chat }) {
  const step = workflow.jobs.browser.steps[0];
  const all = evaluate(step.env.ALL, { message, covers, chat });
  return all || (project === "chat" ? !chat : !covers);
}

/** Which test jobs a commit starts, and which of them do work. */
function plan(message, covers, chat = true) {
  const context = { message, covers, chat };
  const unitJob = evaluate(workflow.jobs.unit_tests.if, context);
  const test = workflow.jobs.unit_tests.steps.find((step) => step.name === "Test").if;
  const browserJob = evaluate(workflow.jobs.browser.if, context);
  return {
    unit: unitJob ? ALL_UNIT_LANES.filter((lane) => evaluate(test, { ...context, lane })) : [],
    components: browserJob && shardWorks("components", context),
    chat: browserJob && shardWorks("chat", context),
    windows: evaluate(workflow.jobs.windows_process.if, context),
  };
}

const snapshot = (paths) =>
  `CI snapshot of private source abc\n\nSource-Commit: abc\n${lanesLine(lanesFor(paths))}`;
const WEB_CHANGE = ["apps/web/src/components/chat/ChatView.tsx"];

describe("the CI workflow reads the line the poller writes", () => {
  it("names every unit lane of the matrix", () => {
    const lanes = workflow.jobs.unit_tests.strategy.matrix.include.map((entry) => entry.lane);
    expect(lanes.toSorted()).toEqual([...ALL_UNIT_LANES].toSorted());
  });

  it("starts no unit worker and no browser shard for a web change the Quick Check covers", () => {
    expect(plan(snapshot(WEB_CHANGE), true, true)).toEqual({
      unit: [],
      components: false,
      chat: false,
      windows: false,
    });
  });

  it("runs only the chat partitions when the change reaches ChatView", () => {
    expect(plan(snapshot(WEB_CHANGE), true, false)).toEqual({
      unit: [],
      components: false,
      chat: true,
      windows: false,
    });
  });

  it("runs the web lanes and the component shards when the Quick Check would leave tests", () => {
    expect(plan(snapshot(WEB_CHANGE), false, true)).toEqual({
      unit: ["web-1", "web-2", "web-3"],
      components: true,
      chat: false,
      windows: false,
    });
  });

  it("runs the whole web suite for a shared part, whatever the Quick Check covers", () => {
    expect(plan(snapshot(["apps/web/src/components/ui/button.tsx"]), true, true)).toEqual({
      unit: ["web-1", "web-2", "web-3"],
      components: true,
      chat: true,
      windows: false,
    });
  });

  it("runs the server lanes and the Windows job for a server change", () => {
    expect(plan(snapshot(["apps/server/src/index.ts"]), true, true)).toEqual({
      unit: ["desktop", "server-1", "server-2", "server-3"],
      components: false,
      chat: false,
      windows: true,
    });
  });

  it("runs everything for a commit without the line (main, manual runs, the batch route)", () => {
    expect(plan("Sync from private source 825e202ed", true, true)).toEqual({
      unit: [...ALL_UNIT_LANES],
      components: true,
      chat: true,
      windows: true,
    });
  });

  it("gates every step of a unit lane that sets up or tests", () => {
    for (const name of [
      "Checkout",
      "Setup workspace",
      "Verify Linux terminal PTY native dependency",
      "Install browser test runtime",
      "Test",
    ]) {
      const step = workflow.jobs.unit_tests.steps.find((entry) => entry.name === name);
      expect(step.if, name).toContain("format(' unit:{0};', matrix.lane)");
    }
  });

  it("makes every browser step after the pick wait on it", () => {
    const [pick, ...rest] = workflow.jobs.browser.steps;
    expect(pick.id).toBe("work");
    for (const step of rest) {
      expect(step.if, step.name).toMatch(
        /^\$\{\{ steps\.work\.outputs\.run == 'true'( && |\s*\}\})/,
      );
    }
  });

  it("lets the unit check pass a deliberate skip only on a snapshot with the line", () => {
    const step = workflow.jobs.unit.steps.find((entry) => entry.run !== undefined);
    expect(step.env.LANES).toBe("${{ contains(github.event.head_commit.message, 'Moss-Lanes:') }}");
    expect(step.run).toContain('[ "$UNIT" = "skipped" ] && [ "$LANES" = "true" ]');
  });

  it("gives the Quick Check and its dry run the same limits", () => {
    const dryRun = workflow.jobs.static.steps.find((step) => step.id === "pick").run;
    const quick = workflow.jobs.quick.steps.find(
      (step) => step.name === "Check the changed files",
    ).run;
    const limits = (text) => /if \[ "\$LANES" = "true" \]; then[^\n]*/.exec(text)?.[0];
    expect(limits(dryRun)).toBeDefined();
    expect(limits(dryRun)).toBe(limits(quick));
  });
});

describe("the CI's own machinery", () => {
  it("runs every lane when a script or tool a workflow step runs changes", () => {
    const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const used = [
      ...new Set(source.match(/(?:scripts|tools)\/[\w./-]+\.(?:ts|mjs|js|sh)/g) ?? []),
    ].filter((path) => !path.startsWith("scripts/public-mirror/"));
    expect(used.length).toBeGreaterThan(5);
    for (const path of used) expect(lanesFor([path]), path).toEqual(ALL_LANES);
  });

  it("runs every lane for the quarantine loader, the Quick Check and this lane picker", () => {
    for (const path of [
      "tools/test-quarantine/vitest.ts",
      "tools/check/lib/graph.ts",
      "scripts/ci-lanes.mjs",
    ]) {
      expect(lanesFor([path]), path).toEqual(ALL_LANES);
    }
  });
});
