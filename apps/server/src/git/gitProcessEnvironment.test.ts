import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runProcess } from "../processRunner.ts";
import {
  describeGitAuthenticationFailure,
  gitCommandEnvironment,
  isGitNetworkCommand,
} from "./gitProcessEnvironment.ts";

describe("git process environment", () => {
  it("never prompts for background work, even if the caller asked for a terminal prompt", () => {
    const env = gitCommandEnvironment({
      args: ["-c", "core.quotepath=false", "status", "--porcelain"],
      env: { GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "always", MARKER: "kept" },
    });
    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      MARKER: "kept",
    });
  });

  it("guards network transfers against stalls and leaves the guard to the caller if set", () => {
    expect(gitCommandEnvironment({ args: ["fetch", "--quiet", "origin"] })).toMatchObject({
      GIT_HTTP_LOW_SPEED_LIMIT: "1000",
      GIT_HTTP_LOW_SPEED_TIME: "60",
      GCM_INTERACTIVE: "never",
    });
    expect(
      gitCommandEnvironment({ args: ["push"], env: { GIT_HTTP_LOW_SPEED_TIME: "300" } }),
    ).toMatchObject({ GIT_HTTP_LOW_SPEED_TIME: "300" });
    expect(isGitNetworkCommand(["-C", "repo", "ls-remote", "origin"])).toBe(true);
    expect(isGitNetworkCommand(["worktree", "add", "x"])).toBe(false);
  });

  it("lets only a push or pull the person started reach Credential Manager", () => {
    const env = gitCommandEnvironment({ args: ["push", "origin"], allowCredentialPrompt: true });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env).not.toHaveProperty("GCM_INTERACTIVE");
    expect(env).not.toHaveProperty("GIT_ASKPASS");
  });

  it("explains sign-in failures and leaves other errors alone", () => {
    for (const stderr of [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "fatal: Cannot prompt because user interactivity has been disabled.",
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'",
      "git@github.com: Permission denied (publickey).",
    ]) {
      expect(describeGitAuthenticationFailure(stderr)).toMatch(/sign in/i);
    }
    expect(describeGitAuthenticationFailure("fatal: not a git repository")).toBeNull();
  });

  it("makes a real git ls-remote fail fast instead of asking when the remote wants a password", async () => {
    // A remote that always answers 401, and a credential helper that records what git
    // passed it. Git Credential Manager reads GCM_INTERACTIVE from this same environment.
    const server = createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="moss-test"' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const root = mkdtempSync(join(tmpdir(), "moss-git-env-"));
    try {
      const record = join(root, "helper-env.txt").replaceAll("\\", "/");
      const helper = join(root, "helper.cjs");
      writeFileSync(
        helper,
        `require("fs").appendFileSync(${JSON.stringify(record)}, "GCM_INTERACTIVE=" + process.env.GCM_INTERACTIVE + "\\n");`,
      );
      const args = [
        "-c",
        `credential.helper=`,
        "-c",
        `credential.helper=!"${process.execPath.replaceAll("\\", "/")}" "${helper.replaceAll("\\", "/")}"`,
        "ls-remote",
        `http://127.0.0.1:${port}/moss/repo.git`,
      ];
      const startedAt = Date.now();
      const result = await runProcess("git", args, {
        cwd: root,
        env: { ...process.env, ...gitCommandEnvironment({ args }) },
        allowNonZeroExit: true,
        timeoutMs: 20_000,
      });
      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(readFileSync(record, "utf8")).toContain("GCM_INTERACTIVE=never");
      expect(describeGitAuthenticationFailure(result.stderr)).not.toBeNull();
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
