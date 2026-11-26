import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findCrossLayerViolations,
  findMobileSingleSourceViolations,
  REQUIRED_STANDING_MODULE_IDS,
  runBoundaryCheck,
  validateModulesRegistry,
  type ModulesRegistry,
} from "./check-module-boundaries.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildValidRegistry(): ModulesRegistry {
  return {
    version: "2.0.0",
    canonicalEntry: "docs/factory/README.md",
    modules: REQUIRED_STANDING_MODULE_IDS.map((id) => ({
      id,
      name: id,
      roleFile: `.agents/roles/${id}.md`,
      boardChannel: "lead",
      charter: `Charter for ${id}`,
      ownedPaths: ["scripts/**"],
      contractTests: ["scripts/check-module-boundaries.test.ts"],
      featureMaps: [".agents/feature-map/README.md"],
      liveProbes: ["bun run lint"],
    })),
  };
}

describe("Layer 1 static module boundary guard", () => {
  it("passes on the real repository", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const result = runBoundaryCheck(repoRoot);
    expect(result.violations).toEqual([]);
  }, 30_000);

  it("blocks forbidden cross-layer imports with actionable fix guidance", () => {
    const violations = findCrossLayerViolations([
      {
        path: "packages/contracts/src/bad.ts",
        contents: 'import { something } from "@moss/shared/git";\nimport fs from "node:fs";\n',
      },
      {
        path: "apps/web/src/components/Bad.tsx",
        contents:
          'import { spawn } from "node:child_process";\nimport { ipcMain } from "electron";\n',
      },
      {
        path: "apps/mobile/src/BadScreen.tsx",
        contents: 'import { ChatView } from "../../../../apps/web/src/components/ChatView";\n',
      },
    ]);

    expect(violations.map((v) => v.rule)).toEqual([
      "contracts-no-app-or-shared-import",
      "contracts-no-runtime-import",
      "web-no-server-desktop-node-import",
      "web-no-server-desktop-node-import",
      "mobile-no-desktop-or-node-import",
    ]);
    for (const v of violations) {
      expect(v.fix.length).toBeGreaterThan(10);
    }
  });

  it("allows test files to use node built-ins without tripping production layer rules", () => {
    const violations = findCrossLayerViolations([
      {
        path: "packages/contracts/src/orchestration.test.ts",
        contents: 'import assert from "node:assert/strict";\n',
      },
      {
        path: "apps/web/src/test/helper.ts",
        contents: 'import fs from "node:fs";\n',
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("validates modules.json completeness, role files, feature maps, and golden owners", () => {
    const valid = buildValidRegistry();
    const roleFiles = REQUIRED_STANDING_MODULE_IDS.map((id) => `.agents/roles/${id}.md`);
    const existingPaths = new Set([...roleFiles, ".agents/feature-map/README.md"]);

    expect(
      validateModulesRegistry(valid, {
        existingPaths,
        roleFilesOnDisk: roleFiles,
        featureMapFilesOnDisk: [".agents/feature-map/README.md"],
        goldenJourneyOwners: ["moss-desktop-core", "moss-mobile-owner"],
      }),
    ).toEqual([]);

    const incomplete: ModulesRegistry = {
      ...valid,
      modules: valid.modules.slice(0, 7),
    };
    const issues = validateModulesRegistry(incomplete, {
      existingPaths,
      roleFilesOnDisk: roleFiles,
      featureMapFilesOnDisk: [".agents/feature-map/README.md", ".agents/feature-map/unclaimed.md"],
      goldenJourneyOwners: ["unknown-ai"],
    });
    expect(issues.some((i) => i.rule === "modules-missing-standing-ai")).toBe(true);
    expect(issues.some((i) => i.rule === "unregistered-role-file")).toBe(true);
    expect(issues.some((i) => i.rule === "unowned-feature-map")).toBe(true);
    expect(issues.some((i) => i.rule === "golden-journey-unknown-owner")).toBe(true);
  });

  it("enforces Desktop/Mobile single-source invariants and detects drift", () => {
    const files = new Map<string, string>([
      ["apps/mobile/src/ui/theme.generated.ts", "// GENERATED FILE — DO NOT EDIT BY HAND.\n"],
      ["apps/mobile/src/ui/mossIcons.generated.ts", "// GENERATED FILE — DO NOT EDIT BY HAND.\n"],
      ["apps/mobile/src/ui/mossBrand.generated.ts", "// GENERATED FILE — DO NOT EDIT BY HAND.\n"],
      [
        "apps/mobile/src/features/apps/brandIcons.generated.ts",
        "// GENERATED FILE — DO NOT EDIT BY HAND.\n",
      ],
      [
        "apps/mobile/src/features/files/fileIcons.generated.ts",
        "// GENERATED FILE — DO NOT EDIT BY HAND.\n",
      ],
      [
        "apps/mobile/src/features/sessions/alertGlyphs.generated.ts",
        "// GENERATED FILE — DO NOT EDIT BY HAND.\n",
      ],
      [
        "apps/mobile/src/moss/toolActivity.ts",
        'import { mossToolLabel } from "@moss/shared/mossToolPresentation";\n',
      ],
      ["apps/mobile/package.json", JSON.stringify({ version: "1.0.18" })],
      ["apps/mobile/app.json", JSON.stringify({ expo: { version: "1.0.17" } })],
      ["apps/mobile/src/localHack.ts", "export const MOSS_MCP_TOOL_PRESENTATIONS = {};\n"],
    ]);

    const issues = findMobileSingleSourceViolations({
      filesByPath: files,
      hasMobileApp: true,
      hasSharedBarrelIndex: true,
    });
    expect(issues.map((i) => i.rule)).toEqual([
      "shared-no-barrel-index",
      "mobile-version-drift",
      "mobile-duplicate-tool-table",
    ]);
  });

  it("gracefully skips private-only registry checks on a mirror-like checkout", () => {
    const mirrorDir = mkdtempSync(path.join(tmpdir(), "moss-mirror-boundary-"));
    tempDirs.push(mirrorDir);
    mkdirSync(path.join(mirrorDir, "packages", "contracts", "src"), { recursive: true });
    writeFileSync(
      path.join(mirrorDir, "packages", "contracts", "src", "ok.ts"),
      "export const ok = true;\n",
    );
    const result = runBoundaryCheck(mirrorDir);
    expect(result.violations).toEqual([]);
    expect(result.summary).toContain("registry=skipped-on-mirror");
  });
});
