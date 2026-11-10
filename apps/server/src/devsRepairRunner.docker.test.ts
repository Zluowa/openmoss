import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRepairRunner, runRepairCommand, type RepairCommand } from "./devsRepairRunner";

/** Executes the real Docker boundary and Git pipeline. Model calls are explicit fixture CLIs. */
describe.skipIf(process.env.MOSS_DEVS_DOCKER_SMOKE !== "1")(
  "real developer execution containers",
  () => {
    let root: string;
    const image = `moss-devs-fixture:${randomUUID()}`;
    beforeAll(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-docker-"));
      await fs.writeFile(
        path.join(root, "agent.sh"),
        `#!/bin/sh
set -eu
if [ "\${1:-}" = install ]; then exit 0; fi
cat > /tmp/report-input
test -z "\${MOSS_DEVS_GITHUB_TOKEN:-}"
test -n "\${ANTHROPIC_API_KEY:-}\${CODEX_API_KEY:-}"
if touch /workspace/.git/unauthorized-write 2>/dev/null; then exit 21; fi
printf 'fixed\\n' > /workspace/bug.txt
printf 'Reproduced the fixture. Fixed it and passed the regression check.\\n' > /workspace/MOSS_DEVS_RESULT.md
`,
      );
      await fs.writeFile(
        path.join(root, "Dockerfile"),
        `FROM node:24-bookworm
COPY agent.sh /usr/local/bin/fixture-agent
RUN chmod 755 /usr/local/bin/fixture-agent && ln -s fixture-agent /usr/local/bin/claude && ln -s fixture-agent /usr/local/bin/codex && ln -s fixture-agent /usr/local/bin/bun
USER node
`,
      );
      await runRepairCommand("docker", ["build", "--tag", image, "."], {
        cwd: root,
        timeoutMs: 240_000,
      });
    }, 300_000);
    afterAll(async () => {
      if (root) {
        await runRepairCommand("docker", ["image", "rm", image], { cwd: root }).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 60_000);
    it.each(["claude", "codex"] as const)(
      "isolates %s, prevents Git metadata writes, verifies final bytes, and returns the PR receipt",
      async (engine) => {
        const source = path.join(root, `source-${engine}`);
        await fs.mkdir(source);
        const git = (args: string[]) => runRepairCommand("git", args, { cwd: source });
        await git(["init", "--initial-branch=main"]);
        await fs.writeFile(path.join(source, "bug.txt"), "broken\n");
        await git(["add", "."]);
        await git([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-m",
          "baseline",
        ]);
        let pushed = false;
        const run: RepairCommand = (file, args, options) => {
          if (file === "git" && args.includes("push")) {
            pushed = true;
            return Promise.resolve("");
          }
          return runRepairCommand(file, args, options);
        };
        const post = vi.fn(
          async () =>
            new Response(JSON.stringify({ html_url: "https://github.com/fixture/repo/pull/42" })),
        );
        const repair = createRepairRunner(
          {
            repository: "fixture/repo",
            mirrorDir: source,
            workDir: path.join(root, `jobs-${engine}`),
            image,
            githubToken: "github-fixture-credential",
            claudeKey: "claude-fixture-credential",
            codexKey: "codex-fixture-credential",
            verify: [
              [
                "node",
                "-e",
                "if(require('fs').readFileSync('bug.txt','utf8') !== 'fixed\\n')process.exit(1)",
              ],
            ],
          },
          run,
          post,
        );
        expect(
          await repair({
            id: randomUUID(),
            engine,
            description: "bug",
            context: "observed failure",
          }),
        ).toBe("https://github.com/fixture/repo/pull/42");
        expect(pushed).toBe(true);
        expect(post).toHaveBeenCalledOnce();
      },
      120_000,
    );
  },
);
