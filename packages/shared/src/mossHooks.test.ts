import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { computeHookTrustHash, trustHook } from "./mossHookTrust";
import {
  MOSS_SESSION_START_EVENT,
  discoverMossHooks,
  redactHookOutput,
  runMossHooks,
} from "./mossHooks";
import { getMossSourceLayout } from "./mossSourceLayout";

const HEX_64 = /^[a-f0-9]{64}$/;
const tempDirs: string[] = [];

async function makeHookProject(): Promise<string> {
  const projectPath = await mkdtemp(join(OS.tmpdir(), "t3-moss-hooks-"));
  tempDirs.push(projectPath);
  await mkdir(getMossSourceLayout(projectPath).hooksRoot, { recursive: true });
  return projectPath;
}

async function writeHook(
  projectPath: string,
  fileName: string,
  frontmatter: Record<string, string | boolean | undefined>,
  body = "Hook body.\n",
): Promise<void> {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${String(value)}`);
  }
  lines.push("---", body);
  await writeFile(
    join(getMossSourceLayout(projectPath).hooksRoot, fileName),
    lines.join("\n"),
    "utf8",
  );
}

/** Trust `name` at its currently discovered hash (models the moss:hooks CLI). */
async function trustDiscoveredHook(projectPath: string, name: string): Promise<void> {
  const resource = (await discoverMossHooks(projectPath)).find((hook) => hook.name === name);
  expect(resource).toBeDefined();
  await trustHook({ projectPath, hookName: name, trustedHash: resource?.trustHash ?? "" });
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("discoverMossHooks", () => {
  it("returns [] without a hooks root and resolves trust state fail-closed", async () => {
    const projectPath = await mkdtemp(join(OS.tmpdir(), "t3-moss-hooks-empty-"));
    tempDirs.push(projectPath);
    expect(await discoverMossHooks(projectPath)).toEqual([]);

    await mkdir(getMossSourceLayout(projectPath).hooksRoot, { recursive: true });
    await writeHook(projectPath, "fresh.md", {
      name: "fresh",
      event: MOSS_SESSION_START_EVENT,
      command: "echo fresh",
      enabled: true,
    });

    const [resource] = await discoverMossHooks(projectPath);
    expect(resource).toMatchObject({
      id: "moss:hook:fresh",
      name: "fresh",
      event: MOSS_SESSION_START_EVENT,
      command: "echo fresh",
      enabled: true,
      // No trust store entry => untrusted, never an implicit "trusted".
      trustState: "untrusted",
    });
    expect(resource?.trustHash).toMatch(HEX_64);
    expect(resource?.trustHash).toBe(
      computeHookTrustHash({ command: "echo fresh", event: MOSS_SESSION_START_EVENT }),
    );
  });

  it("falls back to the file name and the Stop event, and skips directories", async () => {
    const projectPath = await makeHookProject();
    const hooksRoot = getMossSourceLayout(projectPath).hooksRoot;
    await mkdir(join(hooksRoot, "nested-dir.md"), { recursive: true });
    await writeHook(projectPath, "bare.md", { command: "echo bare" });

    const resources = await discoverMossHooks(projectPath);
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ name: "bare", event: "Stop", enabled: true });
    // The trust hash covers the RAW (absent) event, not the Stop fallback.
    expect(resources[0]?.trustHash).toBe(computeHookTrustHash({ command: "echo bare" }));
  });

  it("normalizes YAML block-scalar command markers to 'no command' (fail-closed)", async () => {
    const projectPath = await makeHookProject();
    await writeFile(
      join(getMossSourceLayout(projectPath).hooksRoot, "multiline.md"),
      `---\nname: multiline\nevent: ${MOSS_SESSION_START_EVENT}\ncommand: |\n  echo one\n  echo two\n---\nBody.\n`,
      "utf8",
    );

    const [resource] = await discoverMossHooks(projectPath);
    expect(resource?.command).toBeUndefined();
  });
});

describe("runMossHooks", () => {
  it("runs an enabled trusted hook with captured stdout and 64-hex hashes (A1)", async () => {
    const projectPath = await makeHookProject();
    const proofPath = join(projectPath, "hook-proof.json");
    await writeFile(
      join(projectPath, "write-proof.cjs"),
      [
        "const fs = require('fs')",
        "const payload = JSON.parse(process.env.MOSS_HOOK_PAYLOAD_JSON || '{}')",
        "fs.writeFileSync(process.env.MOSS_HOOK_PROOF_PATH, JSON.stringify({",
        "  event: process.env.MOSS_HOOK_EVENT,",
        "  engine: process.env.MOSS_HOOK_ENGINE,",
        "  name: process.env.MOSS_HOOK_NAME,",
        "  resourceId: process.env.MOSS_HOOK_RESOURCE_ID,",
        "  projectPath: process.env.MOSS_HOOK_PROJECT_PATH,",
        "  cwd: process.env.MOSS_HOOK_CWD,",
        "  payloadSha256: process.env.MOSS_HOOK_PAYLOAD_SHA256,",
        "  payload,",
        "}, null, 2))",
        "console.log('proof-written')",
      ].join("\n"),
      "utf8",
    );
    await writeHook(projectPath, "session-start.md", {
      name: "session-start",
      event: MOSS_SESSION_START_EVENT,
      command: "node write-proof.cjs",
      enabled: true,
    });
    await writeHook(projectPath, "disabled.md", {
      name: "disabled",
      event: MOSS_SESSION_START_EVENT,
      command: "node missing.cjs",
      enabled: false,
    });
    await trustDiscoveredHook(projectPath, "session-start");

    const summary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
      payload: { threadId: "thread-1", mossLaunchPlanHash: "abc123" },
      env: { MOSS_HOOK_PROOF_PATH: proofPath },
    });

    expect(summary.status).toBe("passed");
    expect(summary.provider).toBe("codex");
    expect(summary.matchedCount).toBe(2);
    expect(summary.executedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
    expect(summary.payloadHash).toMatch(HEX_64);

    const passed = summary.results.find(
      (result) => result.resourceId === "moss:hook:session-start",
    );
    expect(passed).toMatchObject({ status: "passed", exitCode: 0 });
    expect(passed?.stdout).toBe("proof-written");
    expect(passed?.commandHash).toMatch(HEX_64);
    expect(summary.results).toContainEqual(
      expect.objectContaining({
        resourceId: "moss:hook:disabled",
        status: "skipped",
        error: "Hook is disabled.",
      }),
    );

    const proof = JSON.parse(await readFile(proofPath, "utf8")) as Record<string, unknown>;
    expect(proof).toMatchObject({
      event: MOSS_SESSION_START_EVENT,
      engine: "codex",
      name: "session-start",
      resourceId: "moss:hook:session-start",
      projectPath,
      cwd: projectPath,
      payloadSha256: summary.payloadHash,
      payload: { threadId: "thread-1", mossLaunchPlanHash: "abc123" },
    });
  });

  it("skips cleanly when no hook matches the event", async () => {
    const projectPath = await makeHookProject();
    await writeHook(projectPath, "session-start.md", {
      name: "session-start",
      event: MOSS_SESSION_START_EVENT,
      command: "echo hi",
    });

    const summary = await runMossHooks({
      projectPath,
      provider: "gemini",
      event: "MossMessageFinish",
    });

    expect(summary.status).toBe("skipped");
    expect(summary.matchedCount).toBe(0);
    expect(summary.results).toEqual([]);
  });

  it("matches the canonical MossSessionStart event case-insensitively", async () => {
    const projectPath = await makeHookProject();
    await writeHook(projectPath, "session-start.md", {
      name: "session-start",
      event: MOSS_SESSION_START_EVENT,
      command: "echo moss-session-start-ran",
      enabled: true,
    });
    await trustDiscoveredHook(projectPath, "session-start");

    const summary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "claudeAgent",
      event: "  mosssessionstart ",
    });

    expect(summary.matchedCount).toBe(1);
    expect(summary.executedCount).toBe(1);
    expect(summary.status).toBe("passed");
    expect(summary.results[0]?.stdout).toBe("moss-session-start-ran");
    expect(summary.payloadHash).toMatch(HEX_64);
    expect(summary.results[0]?.commandHash).toMatch(HEX_64);
  });

  it("redacts sk-/Bearer/token= secrets in stdout and command (A1)", async () => {
    const projectPath = await makeHookProject();
    const secret = "sk-abcdef0123456789abcdef";
    await writeHook(projectPath, "leaky.md", {
      name: "leaky",
      event: MOSS_SESSION_START_EVENT,
      command: `echo "leaking ${secret} and Bearer topsecrettoken123 and token=plainhunter2"`,
      enabled: true,
    });
    await trustDiscoveredHook(projectPath, "leaky");

    const summary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
    });

    const result = summary.results[0];
    expect(result?.status).toBe("passed");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("topsecrettoken123");
    expect(serialized).not.toContain("plainhunter2");
    expect(result?.stdout).toContain("sk-REDACTED");
    expect(result?.stdout).toContain("Bearer REDACTED");
    expect(result?.stdout).toContain("token=REDACTED");
    expect(result?.command).toContain("sk-REDACTED");
  });

  it("skips an untrusted hook without spawning (A3 trust gate)", async () => {
    const projectPath = await makeHookProject();
    const proofPath = join(projectPath, "spawned.txt");
    await writeHook(projectPath, "unreviewed.md", {
      name: "unreviewed",
      event: MOSS_SESSION_START_EVENT,
      command: `node -e "require('fs').writeFileSync(process.env.MOSS_HOOK_PROOF_PATH,'ran')"`,
      enabled: true,
    });
    // Deliberately NOT trusted.

    const summary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
      env: { MOSS_HOOK_PROOF_PATH: proofPath },
    });

    expect(summary.matchedCount).toBe(1);
    expect(summary.executedCount).toBe(0);
    expect(summary.results[0]).toMatchObject({
      status: "skipped",
      error: "Hook is not trusted.",
    });
    expect(existsSync(proofPath)).toBe(false);
  });

  it("executes after trust, then re-skips as changed when the command is edited (A3)", async () => {
    const projectPath = await makeHookProject();
    const proofPath = join(projectPath, "changed-proof.txt");
    await writeHook(projectPath, "cycle.md", {
      name: "cycle",
      event: MOSS_SESSION_START_EVENT,
      command: "echo trusted-run",
      enabled: true,
    });

    await trustDiscoveredHook(projectPath, "cycle");
    const trustedSummary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
    });
    expect(trustedSummary.results[0]?.status).toBe("passed");
    expect(trustedSummary.results[0]?.stdout).toBe("trusted-run");

    await writeHook(projectPath, "cycle.md", {
      name: "cycle",
      event: MOSS_SESSION_START_EVENT,
      command: `node -e "require('fs').writeFileSync(process.env.MOSS_HOOK_PROOF_PATH,'ran')"`,
      enabled: true,
    });
    const changedSummary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
      env: { MOSS_HOOK_PROOF_PATH: proofPath },
    });
    expect(changedSummary.results[0]).toMatchObject({
      status: "skipped",
      error: "Hook changed since last trusted.",
    });
    expect(changedSummary.executedCount).toBe(0);
    expect(existsSync(proofPath)).toBe(false);
  });

  it("marks a long-running hook timed-out without rejecting (A2)", async () => {
    const projectPath = await makeHookProject();
    const pidPath = join(projectPath, "sleepy.pid");
    await writeHook(projectPath, "sleepy.md", {
      name: "sleepy",
      event: MOSS_SESSION_START_EVENT,
      command:
        "node -e \"require('fs').writeFileSync(process.env.MOSS_HOOK_PID_PATH,String(process.pid));setTimeout(()=>{},30000)\"",
      enabled: true,
    });
    await trustDiscoveredHook(projectPath, "sleepy");

    const startedAt = Date.now();
    const summary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "grok",
      event: MOSS_SESSION_START_EVENT,
      timeoutMs: 250,
      env: { MOSS_HOOK_PID_PATH: pidPath },
    });

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(summary.status).toBe("failed");
    expect(summary.timedOutCount).toBe(1);
    expect(summary.results[0]).toMatchObject({ status: "timed-out", timedOut: true });
    const hookPid = Number(await readFile(pidPath, "utf8"));
    expect(Number.isSafeInteger(hookPid) && hookPid > 1 && hookPid !== process.pid).toBe(true);
    if (process.platform === "win32") {
      expect(() => process.kill(hookPid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    }
  });

  it("marks a non-zero exit as failed while the run still resolves (A2)", async () => {
    const projectPath = await makeHookProject();
    await writeHook(projectPath, "broken.md", {
      name: "broken",
      event: MOSS_SESSION_START_EVENT,
      command: "exit 3",
      enabled: true,
    });
    await trustDiscoveredHook(projectPath, "broken");

    const summary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "pi",
      event: MOSS_SESSION_START_EVENT,
    });

    expect(summary.status).toBe("failed");
    expect(summary.failedCount).toBe(1);
    expect(summary.results[0]).toMatchObject({ status: "failed", exitCode: 3 });
  });

  it("skips a matching hook without a runnable command", async () => {
    const projectPath = await makeHookProject();
    await writeHook(projectPath, "no-command.md", {
      name: "no-command",
      event: MOSS_SESSION_START_EVENT,
      enabled: true,
    });
    await trustDiscoveredHook(projectPath, "no-command");

    const summary = await runMossHooks({
      projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
    });

    expect(summary.results[0]).toMatchObject({
      status: "skipped",
      error: "Hook has no command.",
    });
  });

  it("caps the run at maxHooks and records a warning", async () => {
    const projectPath = await makeHookProject();
    for (const name of ["one", "two", "three"]) {
      await writeHook(projectPath, `${name}.md`, {
        name,
        event: MOSS_SESSION_START_EVENT,
        command: `echo ${name}`,
        enabled: true,
      });
      await trustDiscoveredHook(projectPath, name);
    }

    const summary = await runMossHooks({
      projectPath,
      cwd: projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
      maxHooks: 2,
    });

    expect(summary.matchedCount).toBe(2);
    expect(summary.executedCount).toBe(2);
    expect(summary.warnings).toEqual(["Moss hook run limited to 2 of 3 matching hooks."]);
  });

  it("returns a moss:hooks failed pseudo-result when discovery itself fails", async () => {
    const projectPath = await mkdtemp(join(OS.tmpdir(), "t3-moss-hooks-discovery-"));
    tempDirs.push(projectPath);
    const layout = getMossSourceLayout(projectPath);
    await mkdir(layout.root, { recursive: true });
    // hooksRoot exists as a FILE => readdir fails with ENOTDIR (not ENOENT).
    await writeFile(layout.hooksRoot, "not a directory", "utf8");

    const summary = await runMossHooks({
      projectPath,
      provider: "codex",
      event: MOSS_SESSION_START_EVENT,
    });

    expect(summary.status).toBe("failed");
    expect(summary.failedCount).toBe(1);
    expect(summary.results[0]).toMatchObject({
      resourceId: "moss:hooks",
      name: "Moss hook discovery",
      status: "failed",
    });
    expect(summary.payloadHash).toMatch(HEX_64);
  });
});

describe("redactHookOutput", () => {
  it("redacts key/value credential assignments and truncates to 4000 chars", () => {
    expect(redactHookOutput("api_key: hunter2, password=letmein")).toBe(
      "api_key: REDACTED, password=REDACTED",
    );
    expect(redactHookOutput("x".repeat(5000))).toHaveLength(4000);
  });
});
