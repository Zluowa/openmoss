// FILE: pluginImportAdapter.test.ts
// Purpose: Locks clean-room import parsing, canonical destinations, and conflict safety.
// Layer: Web lib test

import { describe, expect, it, vi } from "vitest";
import * as nativeApi from "~/nativeApi";

import {
  inspectPluginImportConflict,
  createPluginImportAdapter,
  parsePluginImportSource,
  sha256Text,
  type PluginImportFileAdapter,
} from "./pluginImportAdapter";

function missingFileError(): Error {
  return new Error("ENOENT: no such file or directory");
}

describe("plugin import adapter", () => {
  it("parses a plugin manifest into a canonical Moss destination", () => {
    const result = parsePluginImportSource({
      kind: "plugin",
      sourceName: "/tmp/GitHub/plugin.json",
      contents: JSON.stringify({
        name: "GitHub",
        description: "Work with GitHub",
        interface: { shortDescription: "GitHub tools" },
      }),
    });

    expect(result).toEqual({
      ok: true,
      candidate: expect.objectContaining({
        kind: "plugin",
        sourceName: "plugin.json",
        name: "GitHub",
        targetRelativePath: ".moss/plugins/github/plugin.json",
        metadataLabelKey: "plugins.import.metadata.plugin",
      }),
    });
  });

  it("reads skill frontmatter and preserves the source text", () => {
    const contents = [
      "---",
      "name: review-checklist",
      "description: Review changed files",
      "---",
      "",
      "# Review",
    ].join("\n");
    const result = parsePluginImportSource({
      kind: "skill",
      sourceName: "SKILL.md",
      contents,
    });

    expect(result).toEqual({
      ok: true,
      candidate: expect.objectContaining({
        kind: "skill",
        name: "review-checklist",
        description: "Review changed files",
        targetRelativePath: ".moss/skills/review-checklist/SKILL.md",
        contents,
      }),
    });
  });

  it("previews a stable #116 MCP config as a merge into the canonical Moss config", () => {
    const result = parsePluginImportSource({
      kind: "mcp",
      sourceName: "mcp.json",
      contents: JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "github-mcp"] },
        },
      }),
    });

    expect(result).toEqual({
      ok: true,
      candidate: expect.objectContaining({
        kind: "mcp",
        name: "github",
        targetRelativePath: ".moss/mcp/config.json",
        sourceSelector: "mcpServers::github",
        metadataLabelKey: "plugins.import.metadata.mcp",
        operation: "merge",
      }),
    });
    if (!result.ok) throw new Error(result.errorKey);
    expect(result.candidate.previewText).toBeNull();
    expect(result.candidate.previewKey).toBe("plugins.import.preview.mcp");
    expect(result.candidate.previewValues).toEqual({ table: "mcpServers", name: "github" });
  });

  it("accepts bounded MCP TOML preview without pretending to implement server apply", () => {
    const result = parsePluginImportSource({
      kind: "mcp",
      sourceName: "mcp.toml",
      contents: ["[mcpServers.linear]", 'command = "npx"', "args = []"].join("\n"),
    });

    expect(result).toEqual({
      ok: true,
      candidate: expect.objectContaining({
        kind: "mcp",
        name: "linear",
        targetRelativePath: ".moss/mcp/config.json",
        operation: "merge",
      }),
    });
  });

  it("rejects malformed or mismatched sources before any native call", () => {
    expect(
      parsePluginImportSource({ kind: "plugin", sourceName: "SKILL.md", contents: "# nope" }),
    ).toEqual({ ok: false, errorKey: "plugins.import.error.pluginExtension" });
    expect(
      parsePluginImportSource({ kind: "plugin", sourceName: "plugin.json", contents: "{}" }),
    ).toEqual({
      ok: true,
      candidate: expect.objectContaining({ name: "plugin" }),
    });
    expect(
      parsePluginImportSource({
        kind: "plugin",
        sourceName: "plugin.json",
        contents: "{not json}",
      }),
    ).toEqual({ ok: false, errorKey: "plugins.import.error.pluginJson" });
    expect(
      parsePluginImportSource({ kind: "mcp", sourceName: "mcp.json", contents: "{}" }),
    ).toEqual({ ok: false, errorKey: "plugins.import.error.mcpName" });
  });

  it("distinguishes an absent destination from an existing destination", async () => {
    const readFile = vi
      .fn<PluginImportFileAdapter["readFile"]>()
      .mockRejectedValueOnce(missingFileError())
      .mockResolvedValueOnce({ contents: "old", truncated: false });
    const adapter = {
      readFile,
      apply: vi.fn<PluginImportFileAdapter["apply"]>(),
      rollback: vi.fn<NonNullable<PluginImportFileAdapter["rollback"]>>(),
    } satisfies PluginImportFileAdapter;
    const candidate = parsePluginImportSource({
      kind: "skill",
      sourceName: "review.md",
      contents: "# Review",
    });
    if (!candidate.ok) throw new Error(candidate.errorKey);

    await expect(inspectPluginImportConflict(adapter, candidate.candidate)).resolves.toEqual({
      status: "missing",
      expected: { kind: "absent" },
    });
    await expect(inspectPluginImportConflict(adapter, candidate.candidate)).resolves.toEqual({
      status: "existing",
      expected: { kind: "sha256", sha256: await sha256Text("old") },
    });
  });

  it("treats an existing MCP config without the selected server as a merge", async () => {
    const adapter = {
      readFile: async () => ({
        contents: JSON.stringify({ mcpServers: { linear: { command: "npx" } } }),
        truncated: false,
      }),
      apply: vi.fn<PluginImportFileAdapter["apply"]>(),
    } satisfies PluginImportFileAdapter;
    const candidate = parsePluginImportSource({
      kind: "mcp",
      sourceName: "mcp.json",
      contents: JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    });
    if (!candidate.ok) throw new Error(candidate.errorKey);

    await expect(inspectPluginImportConflict(adapter, candidate.candidate)).resolves.toMatchObject({
      status: "merge",
      expected: { kind: "sha256" },
    });
  });

  it("fails closed when the existing canonical MCP config is invalid JSON", async () => {
    const adapter = {
      readFile: async () => ({ contents: "{not json}", truncated: false }),
      apply: vi.fn<PluginImportFileAdapter["apply"]>(),
    } satisfies PluginImportFileAdapter;
    const candidate = parsePluginImportSource({
      kind: "mcp",
      sourceName: "mcp.json",
      contents: JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    });
    if (!candidate.ok) throw new Error(candidate.errorKey);

    await expect(inspectPluginImportConflict(adapter, candidate.candidate)).rejects.toMatchObject({
      key: "plugins.import.error.invalidCanonicalMcp",
    });
  });

  it("rejects unsafe MCP names after NFKC normalization", () => {
    for (const name of [
      "__proto__",
      "prototype",
      "constructor",
      "github/tools",
      "github\\tools",
      "github\u0000tools",
      "github\u200Btools",
      "ｃｏｎｓｔｒｕｃｔｏｒ",
    ]) {
      expect(
        parsePluginImportSource({
          kind: "mcp",
          sourceName: "mcp.json",
          contents: JSON.stringify({ mcpServers: { [name]: { command: "npx" } } }),
        }),
      ).toEqual({ ok: false, errorKey: "plugins.import.error.invalidMcpName" });
    }
  });

  it("rejects an unsafe MCP selector before reading the canonical destination", async () => {
    const adapter = {
      readFile: vi.fn<PluginImportFileAdapter["readFile"]>(),
      apply: vi.fn<PluginImportFileAdapter["apply"]>(),
    } satisfies PluginImportFileAdapter;
    const candidate = parsePluginImportSource({
      kind: "mcp",
      sourceName: "mcp.json",
      contents: JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    });
    if (!candidate.ok) throw new Error(candidate.errorKey);

    const unsafeCandidate = {
      ...candidate.candidate,
      sourceSelector: "mcpServers::../github",
    };
    await expect(inspectPluginImportConflict(adapter, unsafeCandidate)).rejects.toMatchObject({
      key: "plugins.import.error.invalidMcpName",
    });
    expect(adapter.readFile).not.toHaveBeenCalled();
  });

  it("fails closed for invalid canonical MCP JSON shapes before merge", async () => {
    const candidate = parsePluginImportSource({
      kind: "mcp",
      sourceName: "mcp.json",
      contents: JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
    });
    if (!candidate.ok) throw new Error(candidate.errorKey);

    const invalidCanonicalShapes = [
      "[]",
      "null",
      "42",
      JSON.stringify({ mcpServers: null }),
      JSON.stringify({ mcpServers: [] }),
      JSON.stringify({ mcpServers: "not-an-object" }),
      JSON.stringify({ mcpServers: { github: [] } }),
      '{"mcpServers":{"__proto__":{"command":"bad"}}}',
      '{"mcpServers":{"constructor":{"command":"bad"}}}',
      '{"__proto__":{"mcpServers":{}}}',
    ];

    for (const contents of invalidCanonicalShapes) {
      const adapter = {
        readFile: async () => ({ contents, truncated: false }),
        apply: vi.fn<PluginImportFileAdapter["apply"]>(),
      } satisfies PluginImportFileAdapter;
      await expect(inspectPluginImportConflict(adapter, candidate.candidate)).rejects.toMatchObject(
        { key: "plugins.import.error.invalidCanonicalMcp" },
      );
    }
  });

  it("uses production resource-import plan/apply/rollback RPCs and accepts only a durable receipt", async () => {
    const resourceImportPlan = vi.fn().mockResolvedValue({
      plan: { operations: [{ action: "replace" }] },
    });
    const receipt = {
      transactionId: "transaction-local-import",
      operationId: "operation-local-import",
      planHash: "a".repeat(64),
      afterState: [
        {
          operationId: "operation-local-import",
          targetPath: "/workspace/.moss/skills/review/SKILL.md",
          state: "present" as const,
          afterHash: "b".repeat(64),
          durable: true as const,
        },
      ],
    };
    const resourceImportApply = vi.fn().mockResolvedValue({
      transactionId: receipt.transactionId,
      planId: "plan-local-import",
      status: "committed",
      operations: [],
      issues: [],
      receipt,
    });
    const resourceImportRollback = vi.fn().mockResolvedValue({
      transactionId: receipt.transactionId,
      status: "rolled-back",
      restored: [],
      issues: [],
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: {
        readFile: vi.fn(),
      },
      provider: {
        resourceImportPlan,
        resourceImportApply,
        resourceImportRollback,
      },
    } as never);

    const adapter = createPluginImportAdapter("/workspace");
    await expect(
      adapter.apply({
        kind: "skill",
        sourceName: "review.md",
        contents: "---\nname: review\n---\nReview.\n",
        replaceExisting: true,
      }),
    ).resolves.toEqual(receipt);
    expect(resourceImportPlan).toHaveBeenCalledWith({
      cwd: "/workspace",
      selectionOrigin: "local",
      localSource: {
        kind: "skill",
        sourceName: "review.md",
        contents: "---\nname: review\n---\nReview.\n",
        replaceExisting: true,
      },
    });
    expect(resourceImportApply).toHaveBeenCalledWith({
      cwd: "/workspace",
      plan: { operations: [{ action: "replace" }] },
    });
    await expect(adapter.rollback?.({ receipt })).resolves.toEqual({ rolledBack: true });
    expect(resourceImportRollback).toHaveBeenCalledWith({
      cwd: "/workspace",
      transactionId: receipt.transactionId,
    });
  });
});
