import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ProviderKind, SUPPORTED_PROVIDER_KINDS } from "@synara/contracts";

import {
  MOSS_ENGINE_NATIVE_TARGETS,
  MOSS_GOVERNANCE_ENGINE_IDS,
  MOSS_PLUGIN_CAPABILITY_MATRIX,
  MOSS_PLUGIN_COMPONENT_KINDS,
  MOSS_PROJECTION_ENGINE_IDS,
  buildMossEngineProjection,
  getMossPluginCapability,
  isMossProjectionEngineId,
} from "./mossProjectionGovernance";
import type { MossSharedResource } from "./mossResourceRegistry";
import { MOSS_RELATIVE_PATHS } from "./mossSourceLayout";

function resource(
  partial: Partial<MossSharedResource> & Pick<MossSharedResource, "id" | "kind" | "name" | "path">,
): MossSharedResource {
  return {
    enabled: true,
    ...partial,
    metadata: { sourceSystem: "moss-unified-source", ...partial.metadata },
  };
}

const FIXTURE_RESOURCES: MossSharedResource[] = [
  resource({
    id: "moss:instruction:moss.md",
    kind: "instruction",
    name: "moss.md",
    path: MOSS_RELATIVE_PATHS.sourceInstruction,
    metadata: { mossRole: "source-instruction" },
  }),
  resource({
    id: "moss:instruction:config.json",
    kind: "instruction",
    name: "config.json",
    path: MOSS_RELATIVE_PATHS.workspaceConfig,
    metadata: { mossRole: "workspace-config" },
  }),
  resource({
    id: "moss:memory:Moss memory",
    kind: "memory",
    name: "Moss memory",
    path: MOSS_RELATIVE_PATHS.memoryRoot,
    metadata: { mossRole: "memory-root" },
  }),
  resource({
    id: "moss:memory:context",
    kind: "memory",
    name: "context",
    path: `${MOSS_RELATIVE_PATHS.memoryRoot}/context.md`,
    metadata: { mossRole: "memory-entry", entryName: "context.md" },
  }),
  resource({
    id: "moss:skill:review",
    kind: "skill",
    name: "review",
    path: `${MOSS_RELATIVE_PATHS.skillsRoot}/review/SKILL.md`,
    metadata: { mossRole: "skill", entryName: "review" },
  }),
  resource({
    id: "moss:subagent:cleanup",
    kind: "subagent",
    name: "cleanup",
    path: `${MOSS_RELATIVE_PATHS.subagentsRoot}/cleanup.md`,
    metadata: { mossRole: "subagent", entryName: "cleanup.md" },
  }),
  resource({
    id: "moss:mcp:browser",
    kind: "mcp",
    name: "browser",
    path: MOSS_RELATIVE_PATHS.mcpConfig,
    metadata: { mossRole: "mcp-config" },
  }),
  resource({
    id: "moss:hook:on-stop",
    kind: "hook",
    name: "on-stop",
    path: `${MOSS_RELATIVE_PATHS.hooksRoot}/on-stop.md`,
    metadata: { mossRole: "hook", entryName: "on-stop.md" },
  }),
  resource({
    id: "moss:provider:providers.yaml",
    kind: "provider",
    name: "providers.yaml",
    path: MOSS_RELATIVE_PATHS.providersConfig,
    metadata: { mossRole: "provider-config" },
  }),
];

function mappingFor(engineId: ProviderKind, resourceId: string) {
  const projection = buildMossEngineProjection(engineId, FIXTURE_RESOURCES);
  return projection.mappings.find((mapping) => mapping.resourceId === resourceId);
}

describe("buildMossEngineProjection mapping table", () => {
  it("publishes an explicit capability row for every plugin component on active providers", () => {
    expect(MOSS_GOVERNANCE_ENGINE_IDS).toHaveLength(14);
    for (const engineId of MOSS_GOVERNANCE_ENGINE_IDS) {
      for (const componentKind of MOSS_PLUGIN_COMPONENT_KINDS) {
        const capability = MOSS_PLUGIN_CAPABILITY_MATRIX[engineId][componentKind];
        expect(capability).toMatchObject({
          projection: expect.stringMatching(/^(native|adapter|display-only)$/),
          execution: expect.stringMatching(/^(native|adapter|none)$/),
        });
        expect(capability.reason.length).toBeGreaterThan(0);
        expect(getMossPluginCapability(engineId, componentKind)).toEqual(capability);
        if (capability.projection === "display-only") {
          expect(capability.execution).toBe("none");
        }
      }
    }
    expect(MOSS_PLUGIN_CAPABILITY_MATRIX.antigravity.mcp).toMatchObject({
      projection: "display-only",
      execution: "none",
    });
  });

  it("keeps plugin projection catalog-only until the dedicated runtime owns execution", () => {
    const plugin = resource({
      id: "moss:plugin:research-kit",
      kind: "plugin",
      name: "research-kit",
      path: `${MOSS_RELATIVE_PATHS.pluginsRoot}/research-kit/.codex-plugin/plugin.json`,
      metadata: {
        mossRole: "plugin",
        plugin: {
          components: [{ kind: "skill", name: "research", enabled: true }],
        },
      },
    });

    const projection = buildMossEngineProjection("codex", [plugin]);
    expect(projection.mappings).toHaveLength(1);
    expect(projection.mappings[0]).toMatchObject({
      resourceId: "moss:plugin:research-kit",
      action: "prompt-inject",
    });
    expect(projection.mappings[0]?.targetPath).toBeUndefined();
    expect(projection.warnings[0]).toContain("catalog/runtime plan only");
  });

  it.each(MOSS_PROJECTION_ENGINE_IDS)("maps every resource kind for %s", (engineId) => {
    const targets = MOSS_ENGINE_NATIVE_TARGETS[engineId];

    expect(mappingFor(engineId, "moss:instruction:moss.md")).toMatchObject({
      action: "symlink",
      targetPath: targets.instructionFile,
    });
    expect(mappingFor(engineId, "moss:memory:Moss memory")).toMatchObject({
      action: "symlink",
      targetPath: targets.memoryRoot,
    });
    expect(mappingFor(engineId, "moss:memory:context")).toMatchObject({
      action: "native",
      targetPath: join(targets.memoryRoot, "context.md"),
    });
    // Skill symlinks target the skill directory (SKILL.md parent), not the file.
    expect(mappingFor(engineId, "moss:skill:review")).toMatchObject({
      action: "symlink",
      sourcePath: `${MOSS_RELATIVE_PATHS.skillsRoot}/review`,
      targetPath: join(targets.skillsRoot, "review"),
    });
    expect(mappingFor(engineId, "moss:subagent:cleanup")).toMatchObject({
      action: "symlink",
      targetPath: join(targets.subagentsRoot, "cleanup.md"),
    });
    expect(mappingFor(engineId, "moss:mcp:browser")).toMatchObject({
      action: "managed-bridge",
      targetPath: targets.mcpBridge,
    });
    expect(mappingFor(engineId, "moss:hook:on-stop")).toMatchObject({
      action: "adapter-inject",
      targetPath: targets.hooksRoot,
    });
    expect(mappingFor(engineId, "moss:provider:providers.yaml")).toMatchObject({
      action: "managed-bridge",
      targetPath: targets.providerBridge,
    });
    // The workspace config drives the launch plan, not provider prompt/context:
    // it is not projected as a resource on any engine (no mapping, no warning).
    expect(mappingFor(engineId, "moss:instruction:config.json")).toBeUndefined();
  });

  it("routes codex mcp+provider bridges into one config.toml target", () => {
    const projection = buildMossEngineProjection("codex", FIXTURE_RESOURCES);
    const bridgeTargets = projection.mappings
      .filter((mapping) => mapping.action === "managed-bridge")
      .map((mapping) => mapping.targetPath);
    expect(bridgeTargets).toEqual([
      MOSS_ENGINE_NATIVE_TARGETS.codex.mcpBridge,
      MOSS_ENGINE_NATIVE_TARGETS.codex.providerBridge,
    ]);
    expect(new Set(bridgeTargets).size).toBe(1);
    // codex has a native surface for every projected fixture resource, so no
    // prompt-inject fallback fires and the projection is fully `ready`.
    expect(projection.status).toBe("ready");
    expect(projection.warnings).toEqual([]);
  });

  it("withholds enabled === false resources silently", () => {
    const withDisabled = [
      ...FIXTURE_RESOURCES,
      resource({
        id: "moss:skill:disabled",
        kind: "skill",
        name: "disabled",
        path: `${MOSS_RELATIVE_PATHS.skillsRoot}/disabled/SKILL.md`,
        enabled: false,
        metadata: { mossRole: "skill", entryName: "disabled" },
      }),
    ];
    const projection = buildMossEngineProjection("claudeAgent", withDisabled);
    expect(
      projection.mappings.some((mapping) => mapping.resourceId === "moss:skill:disabled"),
    ).toBe(false);
    // A disabled resource is withheld silently: it produces neither a mapping
    // nor a warning. claudeAgent has a native surface for every enabled fixture
    // resource, so the projection stays fully `ready` with no warnings at all.
    expect(projection.warnings).toEqual([]);
    expect(projection.status).toBe("ready");
  });

  it("covers every supported provider engine", () => {
    expect(MOSS_GOVERNANCE_ENGINE_IDS.length).toBe(14);
    expect([...MOSS_GOVERNANCE_ENGINE_IDS].toSorted()).toEqual(
      [...SUPPORTED_PROVIDER_KINDS].toSorted(),
    );
  });

  it.each(["droid", "kilo"] as const)("rejects retired %s projection engines", (engineId) => {
    expect(buildMossEngineProjection(engineId, FIXTURE_RESOURCES)).toMatchObject({
      engineId,
      status: "unsupported",
      mappings: [],
    });
  });

  it.each(MOSS_GOVERNANCE_ENGINE_IDS)(
    "returns a non-unsupported projection with non-empty mappings for %s",
    (engineId) => {
      const projection = buildMossEngineProjection(engineId, FIXTURE_RESOURCES);
      // A1: no engine returns status:'unsupported' with empty mappings anymore.
      expect(projection.status).not.toBe("unsupported");
      expect(["ready", "partial"]).toContain(projection.status);
      expect(projection.mappings.length).toBeGreaterThan(0);
      // Every enabled fixture resource with a path — except the workspace config
      // (launch-plan input, not a projected resource) — gets exactly one mapping.
      const projectableResources = FIXTURE_RESOURCES.filter(
        (resource) =>
          resource.path &&
          resource.enabled !== false &&
          resource.metadata.mossRole !== "workspace-config",
      );
      expect(projection.mappings.length).toBe(projectableResources.length);
    },
  );

  // A1 reverse: the materializer write set stays at the two lead engines; the
  // non-lead engines are covered by governance but NOT materialized on disk.
  it("keeps the materializer write set at the two lead engines only", () => {
    expect([...MOSS_PROJECTION_ENGINE_IDS]).toEqual(["codex", "claudeAgent"]);
    expect(isMossProjectionEngineId("codex")).toBe(true);
    expect(isMossProjectionEngineId("claudeAgent")).toBe(true);
    for (const engineId of [
      "cursor",
      "droid",
      "gemini",
      "grok",
      "opencode",
      "kilo",
      "pi",
    ] as const) {
      expect(isMossProjectionEngineId(engineId)).toBe(false);
    }
  });

  // SY8 A2: every wired provider has a native-landing MCP action. Antigravity
  // is the explicit downgrade because its adapter has no plugin MCP entrypoint.
  it.each(MOSS_GOVERNANCE_ENGINE_IDS)("classifies %s MCP landing honestly", (engineId) => {
    const mcp = mappingFor(engineId, "moss:mcp:browser");
    expect(mcp).toBeDefined();
    if (engineId === "antigravity") {
      expect(mcp?.action).toBe("unsupported");
      expect(mcp?.targetPath).toBeUndefined();
      expect(buildMossEngineProjection(engineId, FIXTURE_RESOURCES).warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("Antigravity")]),
      );
      return;
    }
    expect(mcp?.action).not.toBe("prompt-inject");
    expect(mcp?.action).not.toBe("none");
    // ACP family injects via session/new mcpServers (adapter-inject); config-file
    // engines and lead engines bridge into a native config (managed-bridge).
    expect(["managed-bridge", "adapter-inject"]).toContain(mcp?.action);
    expect(mcp?.targetPath).toBe(MOSS_ENGINE_NATIVE_TARGETS[engineId].mcpBridge);
  });

  // SY8 A2: for every provider, each kind with no native surface is an
  // explicit fallback ('prompt-inject' or fail-closed 'unsupported', never a
  // fabricated file target) AND carries a paired warning that names the
  // provider + resource.
  it.each(MOSS_GOVERNANCE_ENGINE_IDS)(
    "pairs a named warning with every non-native fallback for %s",
    (engineId) => {
      const projection = buildMossEngineProjection(engineId, FIXTURE_RESOURCES);
      const label = MOSS_ENGINE_NATIVE_TARGETS[engineId].label;
      const fallbacks = projection.mappings.filter(
        (mapping) => mapping.action === "prompt-inject" || mapping.action === "unsupported",
      );

      for (const mapping of fallbacks) {
        // Reverse anchor: a non-native fallback must NOT carry a file target.
        expect(mapping.targetPath).toBeUndefined();
        // A paired warning names this provider AND this resource id.
        const paired = projection.warnings.find(
          (warning) => warning.includes(label) && warning.includes(mapping.resourceId),
        );
        expect(paired).toBeDefined();
      }

      // Every warning corresponds to a real non-native fallback (no orphans).
      expect(projection.warnings.length).toBe(fallbacks.length);
      // Status reflects whether any fallback happened.
      expect(projection.status).toBe(fallbacks.length > 0 ? "partial" : "ready");
    },
  );

  // A2 reverse: the ACP family has no native surface for hooks/subagents, so
  // those land as prompt-inject with a paired warning (never a file target).
  it.each(["cursor", "gemini", "grok"] as const)(
    "routes %s hook + subagent resources to prompt-inject with warnings",
    (engineId) => {
      const hook = mappingFor(engineId, "moss:hook:on-stop");
      const subagent = mappingFor(engineId, "moss:subagent:cleanup");
      expect(hook?.action).toBe("prompt-inject");
      expect(hook?.targetPath).toBeUndefined();
      expect(subagent?.action).toBe("prompt-inject");
      expect(subagent?.targetPath).toBeUndefined();

      const projection = buildMossEngineProjection(engineId, FIXTURE_RESOURCES);
      const label = MOSS_ENGINE_NATIVE_TARGETS[engineId].label;
      expect(
        projection.warnings.some((w) => w.includes(label) && w.includes("moss:hook:on-stop")),
      ).toBe(true);
      expect(
        projection.warnings.some((w) => w.includes(label) && w.includes("moss:subagent:cleanup")),
      ).toBe(true);
    },
  );

  // A2: config-file engines (opencode) read AGENTS.md natively, so the source
  // instruction is a symlink there — not a prompt-inject.
  it("symlinks the source instruction into opencode's native AGENTS.md", () => {
    expect(mappingFor("opencode", "moss:instruction:moss.md")).toMatchObject({
      action: "symlink",
      targetPath: "AGENTS.md",
    });
  });
});
