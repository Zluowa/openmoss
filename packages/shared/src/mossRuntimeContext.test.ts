import { access, chmod, constants, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { supportsPosixPermissions } from "./filesystemPlatform";

import {
  MOSS_CONTEXT_TRUNCATION_MARKER,
  buildMossRuntimeContext,
  redactSensitiveText,
  truncateContent,
} from "./mossRuntimeContext";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const tempDir = await mkdtemp(join(OS.tmpdir(), "t3-moss-runtime-context-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeFixtureWorkspace(): Promise<string> {
  const workspace = await makeTempWorkspace();
  await mkdir(join(workspace, ".moss", "source"), { recursive: true });
  await mkdir(join(workspace, ".moss", "memory"), { recursive: true });
  await writeFile(
    join(workspace, ".moss", "source", "moss.md"),
    "# Moss rules\nUse the Moss Unified Source.\n",
    "utf8",
  );
  await writeFile(
    join(workspace, ".moss", "memory", "alpha.md"),
    "---\nname: alpha\ndescription: First memory entry.\n---\nAlpha body sentinel: MOSS_SY6_ALPHA_OK\n",
    "utf8",
  );
  await writeFile(
    join(workspace, ".moss", "memory", "beta.md"),
    "---\nname: beta\n---\nBeta body sentinel: MOSS_SY6_BETA_OK\n",
    "utf8",
  );
  return workspace;
}

/**
 * Whether `chmod 000` actually revokes read access here. It does not on Windows (a read-only
 * attribute) nor for a privileged process such as root, which reads any file regardless.
 */
async function chmodRevokesReadAccess(): Promise<boolean> {
  if (!supportsPosixPermissions()) return false;
  const directory = await mkdtemp(join(OS.tmpdir(), "moss-chmod-probe-"));
  const probe = join(directory, "probe.md");
  try {
    await writeFile(probe, "probe\n", "utf8");
    await chmod(probe, 0o000);
    return await access(probe, constants.R_OK).then(
      () => false,
      () => true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const CHMOD_REVOKES_READ_ACCESS = await chmodRevokesReadAccess();

describe("buildMossRuntimeContext", () => {
  it("hydrates instruction and memory entries into per-resource sections", async () => {
    const workspace = await makeFixtureWorkspace();
    const context = await buildMossRuntimeContext({
      projectPath: workspace,
      provider: "codex",
    });

    expect(context.status).toBe("ready");
    expect(context.provider).toBe("codex");
    expect(context.text).toContain("Moss Unified Source Context");
    expect(context.text).toContain("## instruction: moss.md");
    expect(context.text).toContain("Resource: moss:instruction:source");
    expect(context.text).toContain("Use the Moss Unified Source.");
    // Each memory entry gets its own section carrying name and body.
    expect(context.text).toContain("## memory: alpha");
    expect(context.text).toContain("Resource: moss:memory:alpha");
    expect(context.text).toContain("Path: .moss/memory/alpha.md");
    expect(context.text).toContain("Alpha body sentinel: MOSS_SY6_ALPHA_OK");
    expect(context.text).toContain("## memory: beta");
    expect(context.text).toContain("Beta body sentinel: MOSS_SY6_BETA_OK");
    expect(context.resourceCount).toBe(3);
    expect(context.includedResourceCount).toBe(3);
    expect(context.resources).toContainEqual(
      expect.objectContaining({
        resourceId: "moss:memory:alpha",
        kind: "memory",
        name: "alpha",
        description: "First memory entry.",
        included: true,
        truncated: false,
      }),
    );
    expect(/^[a-f0-9]{64}$/.test(context.fingerprint)).toBe(true);
  });

  it("is deterministic for identical input and sensitive to single-char edits", async () => {
    const workspace = await makeFixtureWorkspace();
    const first = await buildMossRuntimeContext({ projectPath: workspace, provider: "codex" });
    const second = await buildMossRuntimeContext({ projectPath: workspace, provider: "codex" });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.text).toBe(first.text);

    // Flip exactly one character in one memory entry: fingerprint must change.
    await writeFile(
      join(workspace, ".moss", "memory", "beta.md"),
      "---\nname: beta\n---\nBeta body sentinel: MOSS_SY6_BETA_OL\n",
      "utf8",
    );
    const third = await buildMossRuntimeContext({ projectPath: workspace, provider: "codex" });
    expect(third.fingerprint).not.toBe(first.fingerprint);

    // Provider participates in the fingerprint input.
    const claude = await buildMossRuntimeContext({
      projectPath: workspace,
      provider: "claudeAgent",
    });
    expect(claude.fingerprint).not.toBe(third.fingerprint);
  });

  it("reports missing when the workspace has no .moss source", async () => {
    const workspace = await makeTempWorkspace();
    const context = await buildMossRuntimeContext({ projectPath: workspace, provider: "codex" });

    expect(context.status).toBe("missing");
    expect(context.text).toBe("");
    expect(context.resourceCount).toBe(0);
    expect(context.includedResourceCount).toBe(0);
    expect(context.warnings).toContain("No .moss Unified Source was found for this project.");
    expect(/^[a-f0-9]{64}$/.test(context.fingerprint)).toBe(true);
  });

  it("falls back to the file name when frontmatter has no name", async () => {
    const workspace = await makeTempWorkspace();
    await mkdir(join(workspace, ".moss", "memory"), { recursive: true });
    await writeFile(
      join(workspace, ".moss", "memory", "no-frontmatter.md"),
      "Plain memory body without frontmatter.\n",
      "utf8",
    );

    const context = await buildMossRuntimeContext({ projectPath: workspace, provider: "codex" });
    expect(context.status).toBe("ready");
    expect(context.resources).toContainEqual(
      expect.objectContaining({
        resourceId: "moss:memory:no-frontmatter",
        name: "no-frontmatter",
        included: true,
      }),
    );
    expect(context.text).toContain("Plain memory body without frontmatter.");
  });

  it("skips non-markdown files, directories, and unsafe entry names", async () => {
    const workspace = await makeTempWorkspace();
    await mkdir(join(workspace, ".moss", "memory", "nested-dir"), { recursive: true });
    await writeFile(join(workspace, ".moss", "memory", "kept.md"), "Kept entry.\n", "utf8");
    await writeFile(join(workspace, ".moss", "memory", "notes.txt"), "Not markdown.\n", "utf8");
    await writeFile(join(workspace, ".moss", "memory", "evil..md"), "Unsafe entry name.\n", "utf8");
    await writeFile(
      join(workspace, ".moss", "memory", "nested-dir", "inner.md"),
      "Nested entries are out of scope.\n",
      "utf8",
    );

    const context = await buildMossRuntimeContext({ projectPath: workspace, provider: "codex" });
    expect(context.status).toBe("ready");
    expect(context.resourceCount).toBe(1);
    expect(context.resources[0]).toMatchObject({ resourceId: "moss:memory:kept" });
    expect(context.text).toContain("Kept entry.");
    expect(context.text).not.toContain("Not markdown.");
    expect(context.text).not.toContain("Unsafe entry name.");
    expect(context.text).not.toContain("Nested entries are out of scope.");
  });

  it.runIf(CHMOD_REVOKES_READ_ACCESS)(
    "keeps building when a memory entry is unreadable (ported registry semantics: skip)",
    async () => {
      const workspace = await makeTempWorkspace();
      await mkdir(join(workspace, ".moss", "memory"), { recursive: true });
      await writeFile(
        join(workspace, ".moss", "memory", "readable.md"),
        "Readable body.\n",
        "utf8",
      );
      const lockedPath = join(workspace, ".moss", "memory", "locked.md");
      await writeFile(lockedPath, "Locked body.\n", "utf8");
      await chmod(lockedPath, 0o000);

      try {
        const context = await buildMossRuntimeContext({
          projectPath: workspace,
          provider: "codex",
        });
        // 1code registry.ts skips entries whose frontmatter read fails; the
        // build itself must not fail and readable entries still hydrate.
        expect(context.status).toBe("ready");
        expect(context.text).toContain("Readable body.");
        expect(context.text).not.toContain("Locked body.");
        expect(context.resources.some((resource) => resource.name === "locked")).toBe(false);
        expect(context.includedResourceCount).toBe(1);
      } finally {
        await chmod(lockedPath, 0o644);
      }
    },
  );

  it.runIf(!CHMOD_REVOKES_READ_ACCESS)(
    "keeps readable memory entries when chmod cannot revoke read access (Windows, root)",
    async () => {
      const workspace = await makeTempWorkspace();
      const memoryRoot = join(workspace, ".moss", "memory");
      await mkdir(memoryRoot, { recursive: true });
      await writeFile(join(memoryRoot, "readable.md"), "Readable body.\n", "utf8");
      const lockedPath = join(memoryRoot, "locked.md");
      await writeFile(lockedPath, "Locked body.\n", "utf8");
      await chmod(lockedPath, 0o000);

      try {
        const context = await buildMossRuntimeContext({
          projectPath: workspace,
          provider: "codex",
        });
        // Windows chmod controls the read-only attribute, and root reads regardless of mode.
        expect(context.status).toBe("ready");
        expect(context.text).toContain("Readable body.");
        expect(context.text).toContain("Locked body.");
        expect(context.resources.some((resource) => resource.name === "locked")).toBe(true);
        expect(context.includedResourceCount).toBe(2);
      } finally {
        await chmod(lockedPath, 0o644);
      }
    },
  );

  it("redacts key/value secrets, bearer tokens, and sk- keys from injected text", async () => {
    const workspace = await makeTempWorkspace();
    await mkdir(join(workspace, ".moss", "memory"), { recursive: true });
    await writeFile(
      join(workspace, ".moss", "memory", "secrets.md"),
      [
        "---",
        "name: secrets",
        "---",
        'api_key: "super-secret-value-1"',
        "token = super-secret-value-2",
        "Authorization: Bearer abc.DEF-123_token",
        "inline key sk-abcdefghijklmnop1234 stays hidden",
      ].join("\n"),
      "utf8",
    );

    const context = await buildMossRuntimeContext({ projectPath: workspace, provider: "codex" });
    expect(context.status).toBe("ready");
    expect(context.text).not.toContain("super-secret-value-1");
    expect(context.text).not.toContain("super-secret-value-2");
    expect(context.text).not.toContain("abc.DEF-123_token");
    expect(context.text).not.toContain("sk-abcdefghijklmnop1234");
    expect(context.text).toContain("[redacted]");
    expect(context.text).toContain("[redacted-api-key]");
  });

  it("truncates oversized resources with an explicit per-resource marker", async () => {
    const workspace = await makeTempWorkspace();
    await mkdir(join(workspace, ".moss", "memory"), { recursive: true });
    await writeFile(
      join(workspace, ".moss", "memory", "big.md"),
      `---\nname: big\n---\n${"x".repeat(600)}`,
      "utf8",
    );

    const context = await buildMossRuntimeContext({
      projectPath: workspace,
      provider: "codex",
      maxResourceChars: 100,
    });
    expect(context.status).toBe("ready");
    expect(context.text).toMatch(/\[truncated \d+ chars\]/);
    const big = context.resources.find((resource) => resource.name === "big");
    expect(big?.truncated).toBe(true);
    expect(big?.included).toBe(true);
  });

  it("truncates the whole context at maxContextChars with a trailing marker", async () => {
    const workspace = await makeFixtureWorkspace();
    const maxContextChars = 220;
    const context = await buildMossRuntimeContext({
      projectPath: workspace,
      provider: "codex",
      maxContextChars,
    });

    expect(context.status).toBe("ready");
    expect(context.text.endsWith(MOSS_CONTEXT_TRUNCATION_MARKER)).toBe(true);
    expect(context.text.length).toBeLessThanOrEqual(
      maxContextChars + MOSS_CONTEXT_TRUNCATION_MARKER.length,
    );
    expect(context.warnings.some((warning) => warning.includes("was truncated"))).toBe(true);
  });
});

describe("redactSensitiveText", () => {
  it("covers the three redaction shapes", () => {
    expect(redactSensitiveText('password: "hunter2"')).toContain("[redacted]");
    expect(redactSensitiveText("Bearer abcDEF123.token-value")).toBe("Bearer [redacted]");
    expect(redactSensitiveText("sk-ABCdefGHIjklMNO123")).toBe("[redacted-api-key]");
    expect(redactSensitiveText("plain text stays put")).toBe("plain text stays put");
  });
});

describe("truncateContent", () => {
  it("returns the original content when under the limit", () => {
    expect(truncateContent("short", 10)).toEqual({ content: "short", truncated: false });
  });

  it("appends the truncated-chars marker when over the limit", () => {
    const result = truncateContent("abcdefghij", 4);
    expect(result.truncated).toBe(true);
    expect(result.content).toBe("abcd\n[truncated 6 chars]");
  });
});
