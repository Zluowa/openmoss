// FILE: sshRemoteRuntime.test.ts
// Purpose: Verify private runtime transfer, fixed Node trust pins and POSIX bootstrap syntax.
// Layer: SSH runtime tests
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  makeSshRemoteRuntimeScript,
  sshRemoteRuntimeIdentity,
  SSH_NODE_TARGETS,
  SSH_NODE_VERSION,
  SSH_CODEX_VERSION,
  SSH_CLAUDE_SDK_VERSION,
} from "./sshRemoteRuntime";

describe("SSH private runtime preparation", () => {
  it("transports only the app's public release configuration with safe shell quoting", () => {
    const base = { payload: Buffer.from("owned-test-payload"), token: "a".repeat(64), port: 41001 };
    const script = makeSshRemoteRuntimeScript({
      ...base,
      publicEnvironment: { MOSS_MEMFIRE_PHONE_URL: "https://public.example.test/a'b" },
    });
    expect(script).toContain(
      "export MOSS_MEMFIRE_PHONE_URL='https://public.example.test/a'\"'\"'b'",
    );
    expect(() =>
      makeSshRemoteRuntimeScript({
        ...base,
        publicEnvironment: { MOSS_AUTH_TOKEN: "not-a-public-key" },
      }),
    ).toThrow("invalid-public-runtime-environment");
    expect(() =>
      makeSshRemoteRuntimeScript({
        ...base,
        publicEnvironment: { MOSS_MEMFIRE_PHONE_URL: "bad\ncommand" },
      }),
    ).toThrow("invalid-public-runtime-environment");
  });
  it("transfers the current private archive with its hash and installs only inside its private root", () => {
    const payload = Buffer.from("owned-test-payload");
    const script = makeSshRemoteRuntimeScript({ payload, token: "a".repeat(64), port: 41001 });
    expect(script).toContain(createHash("sha256").update(payload).digest("hex"));
    expect(script).not.toContain(payload.toString("base64"));
    expect(script).toContain(`export MOSS_SSH_ARCHIVE_BYTES='${payload.length}'`);
    expect(script).toContain("MOSS_SSH_PAYLOAD_READY:");
    expect(script).toContain('runtime_root="$HOME/.moss/ssh-runtime"');
    // Locked install: the archive's npm-shrinkwrap.json decides every release.
    expect(script).toContain("npm ci --omit=dev --no-audit --no-fund");
    expect(script).toContain(
      "[ -f npm-shrinkwrap.json ] || { echo MOSS_REMOTE_RUNTIME_INSTALL_FAILED",
    );
    expect(script).not.toContain("npm install --omit=dev");
    // A fallback agent install must keep the lock, not re-resolve the whole tree.
    expect(script).not.toContain("--no-package-lock");
    expect(script).toContain('run_owned node "$prepare/runtime-pruner.cjs"');
    expect(script).toContain("MOSS_RUNTIME_PRUNER_EOF");
    expect(script).toContain("node dist/runtimeDependencySmoke.mjs");
    expect(script).toContain("exec node dist/index.mjs --host 127.0.0.1 --port 41001 --no-browser");
    expect(script).toContain(
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
    );
    expect(script).toContain("exec 3>&2");
    expect(script).toContain('run_owned node "$prepare/process-runner.cjs" npm ci');
    expect(script).toContain('run_owned node "$prepare/process-runner.cjs" npm install --no-save');
    const continuation = script
      .split("MOSS_INSTALL_CONTINUATION_EOF'\n")[1]!
      .split("\nMOSS_INSTALL_CONTINUATION_EOF")[0]!;
    expect(continuation).not.toContain("export MOSS_AUTH_TOKEN=");
    expect(script).toContain("MOSS_SSH_BOOTSTRAP_HEADER_END");
    const largerHeader = makeSshRemoteRuntimeScript({
      payload: Buffer.alloc(1024 * 1024, 17),
      token: "a".repeat(64),
      port: 41001,
    });
    expect(largerHeader.length).toBeLessThan(script.length + 20);
    expect(script).not.toContain("npx");
    expect(script).not.toContain("npm install -g");
    expect(script).not.toContain("@moss/cli@");
    expect(script).toContain(`@openai/codex@${SSH_CODEX_VERSION}`);
    expect(script).toContain(
      `@anthropic-ai/claude-agent-sdk-$claude_target@${SSH_CLAUDE_SDK_VERSION}`,
    );
    expect(script).toContain("--omit=optional");
    expect(script).not.toContain("--ignore-scripts");
    expect(script).toContain('existing_codex="$(command -v codex || true)"');
    expect(script).toContain('existing_claude="$(command -v claude || true)"');
    expect(script).toContain('if [ "$need_codex" = 1 ]; then');
    expect(script).toContain('if [ "$need_claude" = 1 ]; then');
    expect(script).toContain('"${2:-}"');
    expect(script).toContain("MOSS_SSH_PROGRESS_AGENTS");
    expect(script).toContain(
      'export MOSS_BUNDLED_CODEX_PATH="$payload_dir/node_modules/.bin/codex"',
    );
    expect(script).toContain(sshRemoteRuntimeIdentity(payload));
    expect(script).not.toContain("latest");
  });
  it("uses independently verified fixed Node targets on Linux and macOS", () => {
    expect(SSH_NODE_VERSION).toBe("24.19.0");
    expect(Object.keys(SSH_NODE_TARGETS).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
    for (const hash of Object.values(SSH_NODE_TARGETS)) expect(hash).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("isolates remote data by connection UUID while sharing only runtime code", () => {
    const base = { payload: Buffer.from("fixture"), token: "a".repeat(64), port: 41001 };
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(makeSshRemoteRuntimeScript({ ...base, uploadId: first })).toContain(
      `MOSS_HOME="$HOME/.moss/ssh-workspaces/${first}"`,
    );
    expect(makeSshRemoteRuntimeScript({ ...base, uploadId: second })).toContain(
      `MOSS_HOME="$HOME/.moss/ssh-workspaces/${second}"`,
    );
    expect(() => makeSshRemoteRuntimeScript({ ...base, uploadId: "../shared" })).toThrow(
      "invalid-runtime-input",
    );
  });
  const shell = process.platform === "win32" ? "sh" : "/bin/sh";
  it("passes the actual POSIX shell syntax check", () => {
    const script = makeSshRemoteRuntimeScript({
      payload: Buffer.from("fixture"),
      token: "a".repeat(64),
      port: 41001,
    });
    const result = spawnSync(shell, ["-n"], {
      input: script,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
  it("rejects malformed private input before creating a script", () => {
    expect(() =>
      makeSshRemoteRuntimeScript({ payload: Buffer.alloc(0), token: "a".repeat(64), port: 41001 }),
    ).toThrow("runtime-payload");
    expect(() =>
      makeSshRemoteRuntimeScript({ payload: Buffer.from("x"), token: "injected'", port: 41001 }),
    ).toThrow("invalid-runtime-input");
  });
});
