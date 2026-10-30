import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildManualPullRequestHandoff,
  buildPullRequestBody,
  buildPullRequestTitle,
  buildSyncBranchName,
  normalizeOwnerRepo,
  parseBooleanFlag,
  publishSyncBranchWithPullRequest,
  resolveSyncOptions,
  sanitizeRefSlug,
  shortSha,
} from "./moss-upstream-sync.ts";

describe("moss-upstream-sync", () => {
  it.effect("normalizes GitHub repository inputs", () =>
    Effect.sync(() => {
      assert.equal(normalizeOwnerRepo("Emanuele-web04/synara"), "Emanuele-web04/synara");
      assert.equal(
        normalizeOwnerRepo("https://github.com/Emanuele-web04/synara.git"),
        "Emanuele-web04/synara",
      );
      assert.equal(
        normalizeOwnerRepo("git@github.com:Emanuele-web04/synara.git"),
        "Emanuele-web04/synara",
      );
    }),
  );

  it.effect("rejects unsupported repository identifiers", () =>
    Effect.sync(() => {
      assert.throws(() => normalizeOwnerRepo("https://gitlab.com/example/moss.git"));
      assert.throws(() => normalizeOwnerRepo("moss"));
      assert.throws(() => normalizeOwnerRepo(""));
    }),
  );

  it.effect("sanitizes refs and branch names deterministically", () =>
    Effect.sync(() => {
      assert.equal(sanitizeRefSlug("refs/heads/moss/improve"), "moss/improve");
      assert.equal(sanitizeRefSlug(" feature branch! "), "feature-branch");
      assert.equal(shortSha("03D8B2C2F00DCAFE"), "03d8b2c2f00d");
      assert.equal(
        buildSyncBranchName({
          kind: "merge",
          upstreamRef: "refs/heads/main",
          upstreamSha: "03d8b2c2f00dcafe1234567890abcdef12345678",
        }),
        "sync/moss-upstream/merge/main-03d8b2c2f00d",
      );
    }),
  );

  it.effect("builds review copy for clean and conflict PRs", () =>
    Effect.sync(() => {
      const title = buildPullRequestTitle({
        kind: "merge",
        upstreamRef: "main",
        upstreamSha: "03d8b2c2f00dcafe1234567890abcdef12345678",
      });
      assert.equal(title, "chore(sync): merge upstream source main 03d8b2c2f00d");

      const body = buildPullRequestBody({
        kind: "conflict",
        upstreamRepo: "Emanuele-web04/synara",
        upstreamRef: "main",
        upstreamSha: "03d8b2c2f00dcafe1234567890abcdef12345678",
        baseRef: "main",
        baseSha: "1f8e297da0cb5b74ef83007580c47961ceadd59f",
        branchName: "sync/moss-upstream/conflict/main-03d8b2c2f00d",
        conflictFiles: ["apps/web/src/App.tsx", "package.json"],
      });

      assert.ok(body.includes("Emanuele-web04/synara"));
      assert.ok(body.includes("apps/web/src/App.tsx"));
      assert.ok(body.includes("manual conflict resolution"));
    }),
  );

  it.effect("builds an actionable manual Draft PR handoff for conflict branches", () =>
    Effect.sync(() => {
      const handoff = buildManualPullRequestHandoff({
        kind: "conflict",
        targetRepository: "Zluowa/Moss",
        upstreamRepo: "Emanuele-web04/synara",
        upstreamRef: "main",
        upstreamSha: "9356d91ee93c7c66e2baf8d81de1a352febf4324",
        baseRef: "main",
        baseSha: "80c672db7b39831352ac20532c714367fd59f796",
        branchName: "sync/moss-upstream/conflict/main-9356d91ee93c",
        conflictFiles: ["apps/web/src/App.tsx"],
        reportPath: ".moss/upstream-sync/report-9356d91ee93c.md",
      });

      assert.equal(handoff.status, "manual-pr-required");
      assert.equal(
        handoff.compareUrl,
        "https://github.com/Zluowa/Moss/compare/main...sync/moss-upstream/conflict/main-9356d91ee93c?expand=1",
      );
      assert.ok(handoff.summary.includes("Manual Draft PR required"));
      assert.ok(handoff.summary.includes("sync/moss-upstream/conflict/main-9356d91ee93c"));
      assert.ok(handoff.summary.includes(".moss/upstream-sync/report-9356d91ee93c.md"));
      assert.ok(handoff.summary.includes("workflow run intentionally fails"));
      assert.ok(handoff.command.includes("gh pr create"));
      assert.ok(handoff.command.includes("--draft"));
      assert.ok(handoff.command.includes("--repo 'Zluowa/Moss'"));
      assert.ok(handoff.annotation.startsWith("::error title=Manual Draft PR required::"));
      assert.ok(handoff.annotation.includes(handoff.compareUrl));
    }),
  );

  it.effect("uses the same manual failure contract for clean merge branches", () =>
    Effect.sync(() => {
      const handoff = buildManualPullRequestHandoff({
        kind: "merge",
        targetRepository: "Zluowa/Moss",
        githubServerUrl: "https://github.com/",
        upstreamRepo: "Emanuele-web04/synara",
        upstreamRef: "main",
        upstreamSha: "9356d91ee93c7c66e2baf8d81de1a352febf4324",
        baseRef: "release/0.5.6",
        baseSha: "80c672db7b39831352ac20532c714367fd59f796",
        branchName: "sync/moss-upstream/merge/main-9356d91ee93c",
        conflictFiles: [],
      });

      assert.equal(handoff.status, "manual-pr-required");
      assert.ok(handoff.compareUrl.includes("release/0.5.6...sync/moss-upstream/merge"));
      assert.ok(handoff.command.includes("--base 'release/0.5.6'"));
      assert.ok(handoff.command.includes("--head 'sync/moss-upstream/merge/main-9356d91ee93c'"));
      assert.ok(!handoff.summary.includes("Conflict report:"));
      assert.ok(handoff.summary.includes("Do not merge automatically"));
    }),
  );

  it.effect("publishes the branch before emitting a failed manual PR handoff", () =>
    Effect.sync(() => {
      const events: string[] = [];
      let output: Record<string, string> | undefined;
      let summary = "";
      let annotation = "";
      const branchName = "sync/moss-upstream/conflict/main-9356d91ee93c";

      assert.throws(
        () =>
          publishSyncBranchWithPullRequest(
            {
              kind: "conflict",
              upstreamRepo: "Emanuele-web04/synara",
              upstreamRef: "main",
              upstreamSha: "9356d91ee93c7c66e2baf8d81de1a352febf4324",
              baseRef: "main",
              baseSha: "80c672db7b39831352ac20532c714367fd59f796",
              branchName,
              conflictFiles: ["apps/web/src/App.tsx"],
            },
            {
              pushBranch: () => events.push("push"),
              upsertPullRequest: () => {
                events.push("upsert");
                throw new Error("createPullRequest denied");
              },
              resolveTargetRepository: () => "Zluowa/Moss",
              writeActionsOutput: (values) => {
                events.push("output");
                output = values;
              },
              appendStepSummary: (markdown) => {
                events.push("summary");
                summary = markdown;
              },
              annotate: (message) => {
                events.push("annotation");
                annotation = message;
              },
            },
            ".moss/upstream-sync/report-9356d91ee93c.md",
          ),
        /Manual Draft PR required/u,
      );

      assert.deepStrictEqual(events, ["push", "upsert", "output", "summary", "annotation"]);
      assert.equal(output?.status, "manual-pr-required");
      assert.equal(output?.branch, branchName);
      assert.equal(output?.report_path, ".moss/upstream-sync/report-9356d91ee93c.md");
      assert.ok(output?.compare_url?.includes(branchName));
      assert.ok(output?.manual_pr_command?.includes("--draft"));
      assert.ok(summary.includes("workflow run intentionally fails"));
      assert.ok(annotation.startsWith("::error title=Manual Draft PR required::"));
    }),
  );

  it.effect("parses environment options", () =>
    Effect.sync(() => {
      const options = resolveSyncOptions({
        SYNC_UPSTREAM_REPO: "https://github.com/Emanuele-web04/synara.git",
        SYNC_UPSTREAM_REF: "refs/heads/moss/improve",
        SYNC_BASE_REF: "main",
        SYNC_REMOTE_NAME: "upstream",
        SYNC_DRY_RUN: "yes",
        SYNC_CREATE_CONFLICT_PR: "0",
      });

      assert.deepStrictEqual(options, {
        upstreamRepo: "Emanuele-web04/synara",
        upstreamRef: "moss/improve",
        baseRef: "main",
        remoteName: "upstream",
        dryRun: true,
        createConflictPullRequest: false,
      });
      assert.equal(parseBooleanFlag(undefined, true), true);
      assert.throws(() => parseBooleanFlag("maybe", false));
    }),
  );
});
