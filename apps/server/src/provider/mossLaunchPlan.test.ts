import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ThreadId } from "@synara/contracts";

import {
  buildMossLaunchPlan,
  loadMossLaunchPlanCanonicalProjection,
  makeMossRuntimePayload,
} from "./mossLaunchPlan.ts";

const canonicalConfig = {
  version: 1,
  name: "moss-launch-test",
  defaultProvider: "codex",
  providers: {
    codex: {
      model: "gpt-5.5",
      apiToken: "secret-provider-token",
    },
    claudeAgent: {
      model: "claude-sonnet-4.5",
    },
  },
  mcp: [
    {
      name: "filesystem",
      source: "local",
      enabled: true,
      metadata: {
        apiToken: "secret-mcp-token",
      },
    },
  ],
  skills: [{ name: "continuous-agent-loop", source: "/skills/loop.md", enabled: true }],
  memory: [{ name: "moss-context", source: ".moss/context/current.md", enabled: true }],
  hooks: [{ name: "Stop", source: "/hooks.json", enabled: true }],
  tools: {
    allow: ["exec_command", "apply_patch"],
    deny: ["git-reset-hard", "unredacted-secret-export"],
  },
};

describe("mossLaunchPlan", () => {
  it("builds stable redacted launch plans", () => {
    const input = {
      threadId: ThreadId.makeUnsafe("thread-launch-plan"),
      provider: "codex" as const,
      cwd: "/tmp/moss",
      modelSelection: {
        provider: "codex" as const,
        instanceId: "codex",
        model: "gpt-5.5",
      },
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
        },
        opencode: {
          serverPassword: "secret-password",
        },
      },
      runtimeMode: "full-access" as const,
    };

    const first = buildMossLaunchPlan({
      input,
      createdAt: "2026-07-01T00:00:00.000Z",
      env: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "secret-key",
        UNRELATED: "ignored",
      },
    });
    const second = buildMossLaunchPlan({
      input,
      createdAt: "2026-07-01T00:00:00.000Z",
      env: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "secret-key",
        UNRELATED: "ignored",
      },
    });

    expect(first.planHash).toBe(second.planHash);
    expect(first.environment.variables.map((entry) => entry.key)).toEqual([
      "OPENAI_API_KEY",
      "PATH",
    ]);
    expect(
      first.environment.variables.find((entry) => entry.key === "OPENAI_API_KEY")?.redacted,
    ).toBe(true);
    expect(first.providerStartOptions).toEqual({
      codex: {
        binaryPath: "/usr/local/bin/codex",
      },
      opencode: {
        serverPassword: "[redacted]",
      },
    });
  });

  it("creates runtime payload for provider session persistence", () => {
    const launchPlan = buildMossLaunchPlan({
      input: {
        threadId: ThreadId.makeUnsafe("thread-runtime-payload"),
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      },
      createdAt: "2026-07-01T00:00:00.000Z",
      env: {},
    });

    expect(makeMossRuntimePayload(launchPlan)).toMatchObject({
      mossLaunchPlanHash: launchPlan.planHash,
      mossLaunchPlan: {
        provider: "claudeAgent",
        permissions: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
        },
      },
    });
  });

  it("reports missing canonical config without blocking launch plan compilation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "moss-launch-missing-"));
    try {
      const canonicalProjection = await loadMossLaunchPlanCanonicalProjection({
        cwd,
        createdAt: "2026-07-02T00:10:00.000Z",
      });

      const launchPlan = buildMossLaunchPlan({
        input: {
          threadId: ThreadId.makeUnsafe("thread-missing-canonical-config"),
          provider: "codex",
          cwd,
          runtimeMode: "full-access",
        },
        createdAt: "2026-07-02T00:10:00.000Z",
        env: {},
        canonicalProjection,
      });

      expect(launchPlan.configSources).toEqual([
        {
          kind: "canonical",
          path: path.join(".moss", "config.json"),
          required: false,
        },
        {
          kind: "environment",
          path: "process.env",
          required: false,
        },
      ]);
      expect(launchPlan.projectionWarnings).toEqual([
        `canonical-config-missing: ${path.join(".moss", "config.json")} not found; launch will use provider start input only`,
      ]);
      expect(launchPlan.mcp).toEqual([]);
      expect(launchPlan.tools).toEqual({ allow: [], deny: [] });
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });

  it("reports invalid canonical config without leaking raw config values", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "moss-launch-invalid-"));
    try {
      await mkdir(path.join(cwd, ".moss"), { recursive: true });
      await writeFile(
        path.join(cwd, ".moss", "config.json"),
        JSON.stringify({
          version: "invalid",
          metadata: {
            apiToken: "secret-invalid-config-token",
          },
        }),
      );

      const canonicalProjection = await loadMossLaunchPlanCanonicalProjection({
        cwd,
        createdAt: "2026-07-02T00:10:00.000Z",
      });

      expect(canonicalProjection.projectionWarnings).toEqual([
        `canonical-config-invalid: ${path.join(".moss", "config.json")} failed validation; launch will use provider start input only`,
      ]);
      expect(JSON.stringify(canonicalProjection)).not.toContain("secret-invalid-config-token");
      expect(canonicalProjection.configSources).toEqual([
        {
          kind: "canonical",
          path: path.join(".moss", "config.json"),
          required: false,
        },
      ]);
      expect(canonicalProjection.tools).toEqual({ allow: [], deny: [] });
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });

  it("wires valid canonical projection into redacted launch plan sources and warnings", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "moss-launch-valid-"));
    try {
      await mkdir(path.join(cwd, ".moss"), { recursive: true });
      await writeFile(
        path.join(cwd, ".moss", "config.json"),
        JSON.stringify(canonicalConfig, null, 2),
      );

      const canonicalProjection = await loadMossLaunchPlanCanonicalProjection({
        cwd,
        createdAt: "2026-07-02T00:10:00.000Z",
      });
      const first = buildMossLaunchPlan({
        input: {
          threadId: ThreadId.makeUnsafe("thread-valid-canonical-config"),
          provider: "codex",
          cwd,
          modelSelection: {
            provider: "codex",
            instanceId: "codex",
            model: "gpt-5.5",
          },
          runtimeMode: "full-access",
        },
        createdAt: "2026-07-02T00:10:00.000Z",
        env: {},
        canonicalProjection,
      });
      const second = buildMossLaunchPlan({
        input: {
          threadId: ThreadId.makeUnsafe("thread-valid-canonical-config"),
          provider: "codex",
          cwd,
          modelSelection: {
            provider: "codex",
            instanceId: "codex",
            model: "gpt-5.5",
          },
          runtimeMode: "full-access",
        },
        createdAt: "2026-07-02T00:10:00.000Z",
        env: {},
        canonicalProjection,
      });

      expect(first.planHash).toBe(second.planHash);
      expect(first.configSources[0]).toMatchObject({
        kind: "canonical",
        path: path.join(".moss", "config.json"),
        required: false,
      });
      expect(first.configSources[0]?.hash?.startsWith("sha256:")).toBe(true);
      expect(
        first.configSources
          .filter((source) => source.kind === "generated")
          .map((source) => ({
            path: source.path,
            hasHash: source.hash?.startsWith("sha256:") === true,
          })),
      ).toEqual([
        { path: ".moss/projections/moss/config.json", hasHash: true },
        { path: ".moss/projections/codex/config.toml", hasHash: true },
        { path: ".moss/projections/claude/settings.json", hasHash: true },
        { path: ".moss/projections/hermes/config.json", hasHash: true },
        { path: ".moss/projections/acp/config.json", hasHash: true },
        { path: ".moss/projections/custom-cli/config.json", hasHash: true },
      ]);
      expect(first.mcp).toEqual([
        {
          name: "filesystem",
          source: "local",
          enabled: true,
          metadata: {
            apiToken: "[redacted]",
          },
        },
      ]);
      expect(first.skills.map((entry) => entry.name)).toEqual(["continuous-agent-loop"]);
      expect(first.memory.map((entry) => entry.name)).toEqual(["moss-context"]);
      expect(first.hooks.map((entry) => entry.name)).toEqual(["Stop"]);
      expect(first.tools).toEqual(canonicalConfig.tools);
      expect(first.projectionWarnings).toContain(
        "codex:lossy-skills: codex projection keeps skills as references; native installation is target-specific. (skills)",
      );
      expect(first.projectionWarnings).toContain(
        "hermes:adapter-required: Hermes projection is a Moss-side adapter contract until a native Hermes config writer is wired.",
      );
      expect(first.projectionWarnings).not.toContain(
        "canonical .moss projection service is not wired into launch yet",
      );
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });
});
