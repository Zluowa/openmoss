import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  MossCanonicalConfig,
  MossCanonicalResourceMutationPrepareInput,
  MossCreateResourceInput,
  MossDeleteResourceInput,
  MossLaunchPlan,
  MossNormalizedSessionEvent,
  MossProjectEvent,
  MossProjectionManifest,
  MossProjectionResult,
  MossUpdateResourceInput,
} from "./moss";

const decodeLaunchPlan = Schema.decodeUnknownSync(MossLaunchPlan);
const decodeCanonicalConfig = Schema.decodeUnknownSync(MossCanonicalConfig);
const decodeProjectionResult = Schema.decodeUnknownSync(MossProjectionResult);
const decodeProjectEvent = Schema.decodeUnknownSync(MossProjectEvent);
const decodeNormalizedSessionEvent = Schema.decodeUnknownSync(MossNormalizedSessionEvent);
const decodeProjectionManifest = Schema.decodeUnknownSync(MossProjectionManifest);
const decodeCreateResource = Schema.decodeUnknownSync(MossCreateResourceInput);
const decodeDeleteResource = Schema.decodeUnknownSync(MossDeleteResourceInput);
const decodeUpdateResource = Schema.decodeUnknownSync(MossUpdateResourceInput);
const decodePrepareMutation = Schema.decodeUnknownSync(MossCanonicalResourceMutationPrepareInput);

describe("Moss contracts", () => {
  it("exposes only bounded server-issued plan and operation references on mutation RPCs", () => {
    const common = {
      cwd: "/tmp/moss",
      planId: "plan-server-issued",
      operationId: "operation-server-issued",
    };
    expect(decodeCreateResource(common)).toMatchObject(common);
    expect(decodeDeleteResource(common)).toMatchObject(common);
    expect(decodeUpdateResource(common)).toMatchObject(common);
    expect(() => decodeCreateResource({ ...common, planId: "" })).toThrow();
    expect(() =>
      decodeCreateResource({
        ...common,
        operationId: `too-long-${"x".repeat(128)}`,
      }),
    ).toThrow();
    expect(
      decodePrepareMutation({
        action: "create",
        cwd: "/tmp/moss",
        kind: "plugin",
        name: "Stable intent",
      }),
    ).toMatchObject({ action: "create", kind: "plugin" });
  });

  it("decodes a redacted launch plan", () => {
    const parsed = decodeLaunchPlan({
      version: 1,
      planId: "launch-plan-1",
      planHash: "sha256:launch-plan-1",
      createdAt: "2026-07-01T00:00:00.000Z",
      provider: "codex",
      model: "gpt-5.5",
      workspace: {
        cwd: "/Users/moss/Codex/tools/moss",
        projectId: "moss",
        threadId: "thread-1",
      },
      environment: {
        variables: [
          { key: "PATH", redacted: false, valueHash: "sha256:path" },
          { key: "OPENAI_API_KEY", redacted: true, valueHash: "sha256:openai-api-key" },
        ],
      },
      permissions: {
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      mcp: [{ name: "filesystem", enabled: true }],
      skills: [{ name: "continuous-agent-loop", enabled: true }],
      memory: [{ name: "moss-context", source: ".moss/context/current.md" }],
      hooks: [{ name: "Stop", source: "/Users/moss/.codex/hooks.json" }],
      tools: {
        allow: ["exec_command", "apply_patch"],
        deny: ["destructive-reset"],
      },
      providerStartOptions: {
        binaryPath: "/usr/local/bin/codex",
      },
      configSources: [
        {
          kind: "canonical",
          path: ".moss/config.json",
          required: true,
          hash: "sha256:config",
        },
      ],
      projectionWarnings: ["claude projection cannot represent Codex effort exactly"],
    });

    expect(parsed.planHash).toBe("sha256:launch-plan-1");
    expect(
      parsed.environment.variables.find((entry) => entry.key === "OPENAI_API_KEY")?.redacted,
    ).toBe(true);
    expect(parsed.tools.allow).toContain("exec_command");
    // The projection fingerprint is optional; a plan without it still decodes.
    expect(parsed.projectionFingerprint).toBeUndefined();
  });

  it("decodes a launch plan carrying the SY3 projection fingerprint", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const parsed = decodeLaunchPlan({
      version: 1,
      planId: "launch-plan-sy3",
      planHash: "sha256:launch-plan-sy3",
      createdAt: "2026-07-05T00:00:00.000Z",
      provider: "codex",
      model: null,
      workspace: {
        cwd: "/Users/moss/Codex/tools/moss",
        threadId: "thread-sy3",
      },
      environment: { variables: [] },
      permissions: {
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
      },
      mcp: [],
      skills: [],
      memory: [],
      hooks: [],
      tools: { allow: [], deny: [] },
      configSources: [
        {
          kind: "canonical",
          path: ".moss/config.json",
          required: false,
          hash: "sha256:canonical",
        },
        // A `kind: "generated"` source carries the materialize fingerprint so
        // the planHash covers it (SY3 A2).
        {
          kind: "generated",
          path: ".moss/projections/manifest.json",
          required: false,
          hash: fingerprint,
        },
      ],
      projectionWarnings: [],
      projectionFingerprint: fingerprint,
    });

    expect(parsed.projectionFingerprint).toBe(fingerprint);
    const generated = parsed.configSources.find((source) => source.kind === "generated");
    expect(generated?.hash).toBe(fingerprint);
  });

  it("decodes canonical config and a dry-run projection", () => {
    const config = decodeCanonicalConfig({
      version: 1,
      name: "moss-shell",
      defaultProvider: "codex",
      providers: {
        codex: { model: "gpt-5.5" },
      },
      mcp: [],
      skills: [],
      memory: [],
      hooks: [],
      tools: {
        allow: ["exec_command"],
        deny: [],
      },
    });

    const projection = decodeProjectionResult({
      target: "claude",
      dryRun: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      sourceHash: "sha256:canonical",
      rendered: {
        permissionMode: "default",
      },
      warnings: [
        {
          code: "lossy-model-options",
          message: "Claude target has no direct Codex effort field",
          path: "providers.codex.options.effort",
        },
      ],
      writes: [
        {
          action: "would-update",
          path: "/Users/moss/.claude/settings.json",
        },
      ],
    });

    expect(config.defaultProvider).toBe("codex");
    expect(projection.dryRun).toBe(true);
    expect(projection.writes[0]?.action).toBe("would-update");
  });

  it("decodes project events and normalized session events", () => {
    const projectEvent = decodeProjectEvent({
      eventId: "event-moss-goal-1",
      type: "moss.goal.defined",
      createdAt: "2026-07-01T00:00:00.000Z",
      actor: {
        role: "Product Steward",
      },
      correlationId: "iteration-1",
      payload: {
        goal: "Build a Codex-like general agent shell on Moss",
      },
    });

    const sessionEvent = decodeNormalizedSessionEvent({
      eventId: "event-normalized-text-1",
      type: "text",
      provider: "codex",
      sessionId: "runtime-session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-07-01T00:00:01.000Z",
      rawEventId: "event-raw-1",
      payload: {
        text: "Ready",
      },
    });

    expect(projectEvent.type).toBe("moss.goal.defined");
    expect(sessionEvent.type).toBe("text");
    expect(sessionEvent.rawEventId).toBe("event-raw-1");
  });

  it("rejects unknown project event types", () => {
    expect(() =>
      decodeProjectEvent({
        eventId: "event-unknown-1",
        type: "moss.unknown",
        createdAt: "2026-07-01T00:00:00.000Z",
        actor: {
          role: "Reviewer",
        },
        payload: {},
      }),
    ).toThrow();
  });
});

describe("MossProjectionManifest", () => {
  const manifestInput = {
    version: 1,
    generatedAt: "2026-07-05T00:00:00.000Z",
    entries: {
      "CLAUDE.md": {
        engineId: "claudeAgent",
        resourceId: "moss:instruction:moss.md",
        action: "symlink",
        sourcePath: ".moss/source/moss.md",
        targetPath: "CLAUDE.md",
        updatedAt: "2026-07-05T00:00:00.000Z",
      },
      ".codex/config.toml": {
        engineId: "codex",
        resourceId: "moss:mcp:config",
        action: "managed-bridge",
        sourcePath: ".moss/mcp/config.json",
        targetPath: ".codex/config.toml",
        contentHash: "9b3c0d8a5f1e2b4c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        updatedAt: "2026-07-05T00:00:00.000Z",
        contributors: [
          { resourceId: "moss:provider:providers.yaml", sourcePath: ".moss/providers.yaml" },
          { resourceId: "moss:mcp:config", sourcePath: ".moss/mcp/config.json" },
        ],
      },
    },
  };

  it("decodes a projection manifest round-trip", () => {
    const manifest = decodeProjectionManifest(manifestInput);
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.entries)).toHaveLength(2);
    expect(manifest.entries[".codex/config.toml"]?.contributors).toHaveLength(2);
    expect(manifest.entries["CLAUDE.md"]?.contentHash).toBeUndefined();
    // Encoded form re-decodes to the same value.
    expect(decodeProjectionManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it("rejects unknown actions, foreign engine ids, and wrong versions", () => {
    expect(() =>
      decodeProjectionManifest({
        ...manifestInput,
        entries: {
          "CLAUDE.md": { ...manifestInput.entries["CLAUDE.md"], action: "hardlink" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeProjectionManifest({
        ...manifestInput,
        entries: {
          "CLAUDE.md": { ...manifestInput.entries["CLAUDE.md"], engineId: "not-a-real-engine" },
        },
      }),
    ).toThrow();
    expect(() => decodeProjectionManifest({ ...manifestInput, version: 2 })).toThrow();
  });
});
