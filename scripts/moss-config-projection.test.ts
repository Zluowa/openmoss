import { describe, expect, it } from "vitest";

import {
  MOSS_PROJECTION_TARGETS,
  parseMossCanonicalConfig,
  projectAllMossConfig,
  projectMossConfig,
} from "./moss-config-projection.ts";

const canonicalConfig = {
  version: 1,
  name: "moss-shell",
  defaultProvider: "codex",
  providers: {
    codex: {
      model: "gpt-5.5",
    },
    claudeAgent: {
      model: "claude-sonnet-4.5",
    },
  },
  mcp: [{ name: "filesystem", source: "local", enabled: true }],
  skills: [{ name: "continuous-agent-loop", source: "/skills/loop.md", enabled: true }],
  memory: [{ name: "moss-context", source: ".moss/context/current.md", enabled: true }],
  hooks: [{ name: "Stop", source: "/hooks.json", enabled: true }],
  tools: {
    allow: ["exec_command"],
    deny: ["git-reset-hard"],
  },
};

describe("moss-config-projection", () => {
  it("parses canonical config and projects all targets in dry-run mode", () => {
    const config = parseMossCanonicalConfig(JSON.stringify(canonicalConfig), ".moss/config.json");
    const projections = projectAllMossConfig(config, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(projections.map((projection) => projection.target)).toEqual(MOSS_PROJECTION_TARGETS);
    expect(projections.every((projection) => projection.dryRun)).toBe(true);
    expect(projections.every((projection) => projection.writes[0]?.action === "would-update")).toBe(
      true,
    );
  });

  it("renders codex projection with explicit lossy warnings", () => {
    const config = parseMossCanonicalConfig(JSON.stringify(canonicalConfig), ".moss/config.json");
    const projection = projectMossConfig(config, {
      target: "codex",
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(projection.rendered).toMatchObject({
      configToml: {
        model: "gpt-5.5",
      },
    });
    expect(projection.warnings.map((entry) => entry.code)).toContain("lossy-skills");
    expect(projection.warnings.map((entry) => entry.code)).toContain("manual-memory-wire");
  });

  it("rejects invalid canonical config", () => {
    expect(() =>
      parseMossCanonicalConfig(
        JSON.stringify({
          ...canonicalConfig,
          defaultProvider: "unknown-provider",
        }),
        ".moss/config.json",
      ),
    ).toThrow("invalid Moss canonical config");
  });
});
