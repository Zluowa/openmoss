import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MOSS_RELATIVE_PATHS,
  MOSS_ROOT_DIR,
  MOSS_SOURCE_VERSION,
  getMossBootstrapDirectories,
  getMossSourceLayout,
  toMossProjectPath,
} from "./mossSourceLayout";

const PROJECT_PATH = resolve("/workspace/demo");

describe("getMossSourceLayout", () => {
  it("derives every absolute path from the relative single source", () => {
    const layout = getMossSourceLayout(PROJECT_PATH);

    expect(layout.version).toBe(MOSS_SOURCE_VERSION);
    expect(layout.projectPath).toBe(PROJECT_PATH);
    for (const [key, relativePath] of Object.entries(MOSS_RELATIVE_PATHS)) {
      expect(layout[key as keyof typeof MOSS_RELATIVE_PATHS]).toBe(
        join(PROJECT_PATH, relativePath),
      );
    }
  });

  it("keeps every relative path under the Moss root dir", () => {
    for (const relativePath of Object.values(MOSS_RELATIVE_PATHS)) {
      expect(relativePath === MOSS_ROOT_DIR || relativePath.startsWith(`${MOSS_ROOT_DIR}/`)).toBe(
        true,
      );
    }
  });

  it("points workspaceConfig at the existing canonical config.json, not a second config source", () => {
    const layout = getMossSourceLayout(PROJECT_PATH);

    expect(layout.workspaceConfig).toBe(join(layout.root, "config.json"));
    expect(MOSS_RELATIVE_PATHS.workspaceConfig).toBe(".moss/config.json");
  });

  it("exposes control-plane read-only paths used by server and scripts", () => {
    const layout = getMossSourceLayout(PROJECT_PATH);

    expect(layout.projectionsRoot).toBe(join(layout.root, "projections"));
    expect(layout.providerRuntimeFixturesRoot).toBe(
      join(layout.root, "fixtures", "provider-runtime"),
    );
    expect(layout.missionFile).toBe(join(layout.root, "mission.md"));
    expect(layout.ledgerRoot).toBe(join(layout.root, "ledger"));
  });
});

describe("toMossProjectPath", () => {
  it("relativizes absolute paths inside the project", () => {
    const layout = getMossSourceLayout(PROJECT_PATH);

    expect(toMossProjectPath(PROJECT_PATH, layout.sourceInstruction)).toBe(
      join(".moss", "source", "moss.md"),
    );
  });

  it("returns relative paths unchanged", () => {
    expect(toMossProjectPath(PROJECT_PATH, ".moss/memory/notes.md")).toBe(".moss/memory/notes.md");
  });
});

describe("getMossBootstrapDirectories", () => {
  it("lists exactly the resource directories bootstrap may create", () => {
    const layout = getMossSourceLayout(PROJECT_PATH);

    expect(getMossBootstrapDirectories(layout)).toEqual([
      dirname(layout.sourceInstruction),
      layout.memoryRoot,
      layout.skillsRoot,
      layout.pluginsRoot,
      dirname(layout.mcpConfig),
      layout.hooksRoot,
      layout.subagentsRoot,
    ]);
  });

  it("never includes control-plane paths (projections/fixtures/mission/ledger)", () => {
    const layout = getMossSourceLayout(PROJECT_PATH);
    const directories = getMossBootstrapDirectories(layout);

    for (const excluded of [
      layout.projectionsRoot,
      layout.providerRuntimeFixturesRoot,
      dirname(layout.missionFile),
      layout.ledgerRoot,
    ]) {
      expect(directories).not.toContain(excluded);
    }
  });
});
