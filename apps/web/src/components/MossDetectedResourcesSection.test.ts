import type { MossResourceImportResource } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { groupDetectedResources } from "./MossDetectedResourcesSection";

const SHA = "a".repeat(64);

function resource(
  overrides: Partial<MossResourceImportResource> &
    Pick<MossResourceImportResource, "id" | "kind" | "provider" | "name">,
): MossResourceImportResource {
  return {
    scope: "user",
    sourcePath: `/home/u/.${overrides.provider}/skills/${overrides.name}`,
    sourceSha256: SHA,
    sizeBytes: 10,
    format: "markdown",
    secretFields: [],
    warnings: [],
    ...overrides,
  };
}

describe("groupDetectedResources", () => {
  it("collapses one skill found in several CLIs into one row", () => {
    const groups = groupDetectedResources([
      resource({ id: "1", kind: "skill", provider: "grok", name: "dst-atlas" }),
      resource({
        id: "2",
        kind: "skill",
        provider: "codex",
        name: "DST-Atlas",
        scope: "workspace",
        description: "Atlas",
      }),
      resource({ id: "3", kind: "mcp", provider: "codex", name: "node_repl" }),
    ]);
    expect(groups.map((group) => [group.key, group.providers, group.source.id])).toEqual([
      ["skill:dst-atlas", ["Codex", "Grok"], "2"],
      ["mcp:node_repl", ["Codex"], "3"],
    ]);
  });

  it("leaves out plugins and quarantined resources", () => {
    expect(
      groupDetectedResources([
        resource({ id: "1", kind: "plugin", provider: "claude", name: "p" }),
        resource({ id: "2", kind: "skill", provider: "agents", name: "q", quarantined: true }),
      ]),
    ).toEqual([]);
  });
});
