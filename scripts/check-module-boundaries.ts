// FILE: check-module-boundaries.ts
// Purpose: Layer 1 Static Boundary Guard. Validates docs/factory/modules.json completeness,
//          blocks forbidden cross-layer imports, and enforces Desktop/Mobile single-source invariants.
// Layer: Repository check (`bun run boundaries:check`, wired into `bun run lint`)
// Exports: validateModulesRegistry, findCrossLayerViolations, findMobileSingleSourceViolations, runBoundaryCheck

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export interface BoundaryViolation {
  readonly rule: string;
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
  readonly fix: string;
}

export interface ModuleEntry {
  readonly id: string;
  readonly name: string;
  readonly roleFile: string;
  readonly boardChannel: string;
  readonly charter: string;
  readonly ownedPaths: readonly string[];
  readonly contractTests: readonly string[];
  readonly featureMaps: readonly string[];
  readonly liveProbes: readonly string[];
}

export interface ModulesRegistry {
  readonly version: string;
  readonly canonicalEntry: string;
  readonly modules: readonly ModuleEntry[];
}

export interface SourceFile {
  readonly path: string;
  readonly contents: string;
}

export const REQUIRED_STANDING_MODULE_IDS = [
  "moss-train",
  "moss-ops-voice",
  "moss-mobile-owner",
  "moss-desktop-core",
  "moss-qa-eval",
  "moss-release-bot",
  "moss-infra",
  "moss-launch-compliance",
] as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const REQUIRED_MOBILE_GENERATED_FILES = [
  "apps/mobile/src/ui/theme.generated.ts",
  "apps/mobile/src/ui/mossIcons.generated.ts",
  "apps/mobile/src/ui/mossBrand.generated.ts",
  "apps/mobile/src/features/apps/brandIcons.generated.ts",
  "apps/mobile/src/features/files/fileIcons.generated.ts",
  "apps/mobile/src/features/sessions/alertGlyphs.generated.ts",
] as const;

const GENERATED_HEADER = "// GENERATED FILE — DO NOT EDIT BY HAND.";

const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function normalizePosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function isTestOrFixturePath(filePath: string): boolean {
  const normalized = normalizePosix(filePath);
  return (
    /(?:^|\/)(?:__tests__|test|tests|fixtures|testing)(?:\/|$)/.test(normalized) ||
    /\.(?:test|spec|browser|stories)\.[^.]+$/.test(normalized)
  );
}

function stripCommentLines(source: string): string[] {
  return source.split(/\r?\n/).map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      return "";
    }
    return line;
  });
}

function extractSpecifiers(source: string): Array<{ specifier: string; line: number }> {
  const lines = stripCommentLines(source);
  const cleaned = lines.join("\n");
  const results: Array<{ specifier: string; line: number }> = [];
  for (const match of cleaned.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    const offset = match.index ?? 0;
    const line = cleaned.slice(0, offset).split("\n").length;
    results.push({ specifier, line });
  }
  return results;
}

interface LayerRule {
  readonly scopePrefix: string;
  readonly forbiddenPatterns: readonly {
    readonly pattern: RegExp;
    readonly rule: string;
    readonly reason: string;
    readonly fix: string;
  }[];
}

const LAYER_RULES: readonly LayerRule[] = [
  {
    scopePrefix: "packages/contracts/src/",
    forbiddenPatterns: [
      {
        pattern: /^@moss\/(?:shared|web|server|desktop)|^(?:\.\.\/)+apps\//,
        rule: "contracts-no-app-or-shared-import",
        reason:
          "packages/contracts is schema-only and must not depend on runtime packages or apps.",
        fix: "Keep packages/contracts limited to Effect schemas/types; move runtime code to packages/shared.",
      },
      {
        pattern: /^(?:node:|electron$|react$|react-dom$|react-native$|expo(?:-|\/|$))/,
        rule: "contracts-no-runtime-import",
        reason:
          "packages/contracts must stay runtime-agnostic (no Node, Electron, React, or Expo APIs).",
        fix: "Remove runtime imports from packages/contracts/src and put platform logic in packages/shared or apps/*.",
      },
    ],
  },
  {
    scopePrefix: "packages/shared/src/",
    forbiddenPatterns: [
      {
        pattern: /^@moss\/(?:web|server|desktop)|^(?:\.\.\/)+apps\/|^electron$|^react-native$/,
        rule: "shared-no-app-import",
        reason: "packages/shared cannot depend upward on apps/*, Electron, or React Native.",
        fix: "Inject app callbacks/adapters from apps/* instead of importing apps/* inside packages/shared.",
      },
    ],
  },
  {
    scopePrefix: "apps/web/src/",
    forbiddenPatterns: [
      {
        pattern:
          /^@moss\/(?:server|desktop)|^(?:\.\.\/)+apps\/(?:server|desktop|mobile)\/|^electron$|^node:(?:fs|child_process)$/,
        rule: "web-no-server-desktop-node-import",
        reason:
          "apps/web renderer code must talk to backend/shell via contracts/WS/preload bridges, not direct imports.",
        fix: "Move shared types to packages/contracts, shared utilities to packages/shared, or expose an RPC/IPC bridge.",
      },
    ],
  },
  {
    scopePrefix: "apps/server/src/",
    forbiddenPatterns: [
      {
        pattern: /^@moss\/web|^electron$|^(?:\.\.\/)+apps\/(?:web|desktop|mobile)\//,
        rule: "server-no-ui-or-electron-import",
        reason: "apps/server must stay decoupled from Electron main and React UI layers.",
        fix: "Share contracts via packages/contracts and utilities via packages/shared subpaths.",
      },
    ],
  },
  {
    scopePrefix: "apps/mobile/src/",
    forbiddenPatterns: [
      {
        pattern:
          /^@moss\/(?:web|server|desktop)|^(?:\.\.\/)+apps\/(?:web|server|desktop)\/|^electron$|^node:/,
        rule: "mobile-no-desktop-or-node-import",
        reason:
          "apps/mobile runs in React Native / Expo and must not import desktop, server, Electron, or Node built-ins.",
        fix: "Use @moss/contracts, @moss/shared pure subpaths, or sync generated assets via `node apps/mobile/scripts/sync-moss-assets.mjs`.",
      },
    ],
  },
  {
    scopePrefix: "apps/desktop/src/",
    forbiddenPatterns: [
      {
        pattern: /^@moss\/web|^(?:\.\.\/)+apps\/(?:web|mobile)\//,
        rule: "desktop-no-renderer-or-mobile-import",
        reason:
          "apps/desktop main process must not import apps/web or apps/mobile source directly.",
        fix: "Keep Electron-to-renderer contracts in packages/contracts or packages/shared.",
      },
    ],
  },
];

export function findCrossLayerViolations(files: readonly SourceFile[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const rawFile of files) {
    const filePath = normalizePosix(rawFile.path);
    if (isTestOrFixturePath(filePath)) continue;
    const rule = LAYER_RULES.find((entry) => filePath.startsWith(entry.scopePrefix));
    if (!rule) continue;
    for (const { specifier, line } of extractSpecifiers(rawFile.contents)) {
      for (const forbidden of rule.forbiddenPatterns) {
        if (!forbidden.pattern.test(specifier)) continue;
        violations.push({
          rule: forbidden.rule,
          path: filePath,
          line,
          message: `${forbidden.reason} Found forbidden import "${specifier}".`,
          fix: forbidden.fix,
        });
      }
    }
  }
  return violations;
}

export function validateModulesRegistry(
  registry: ModulesRegistry,
  context: {
    readonly existingPaths: ReadonlySet<string>;
    readonly roleFilesOnDisk: readonly string[];
    readonly featureMapFilesOnDisk: readonly string[];
    readonly goldenJourneyOwners?: readonly string[];
  },
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const registryPath = "docs/factory/modules.json";
  if (!registry.version || !registry.canonicalEntry) {
    violations.push({
      rule: "modules-registry-header",
      path: registryPath,
      line: null,
      message: "modules.json must declare non-empty `version` and `canonicalEntry`.",
      fix: 'Set `version` and `canonicalEntry: "docs/factory/README.md"` in docs/factory/modules.json.',
    });
  }

  const seenIds = new Set<string>();
  const referencedRoles = new Set<string>();
  const referencedMaps = new Set<string>();

  for (const mod of registry.modules ?? []) {
    if (!mod.id) continue;
    if (seenIds.has(mod.id)) {
      violations.push({
        rule: "modules-duplicate-id",
        path: registryPath,
        line: null,
        message: `Duplicate module id "${mod.id}" in modules.json.`,
        fix: `Keep only one entry for "${mod.id}" in docs/factory/modules.json.`,
      });
    }
    seenIds.add(mod.id);

    for (const field of ["ownedPaths", "contractTests", "featureMaps", "liveProbes"] as const) {
      if (!Array.isArray(mod[field]) || mod[field].length === 0) {
        violations.push({
          rule: "modules-missing-field",
          path: registryPath,
          line: null,
          message: `Module "${mod.id}" has empty or missing \`${field}\`.`,
          fix: `Populate \`${field}\` for "${mod.id}" in docs/factory/modules.json.`,
        });
      }
    }

    if (!mod.roleFile || !context.existingPaths.has(normalizePosix(mod.roleFile))) {
      violations.push({
        rule: "modules-missing-role-file",
        path: mod.roleFile || registryPath,
        line: null,
        message: `Module "${mod.id}" references missing roleFile "${mod.roleFile}".`,
        fix: `Create "${mod.roleFile}" and sync it to your local .claude/agents directory.`,
      });
    } else {
      referencedRoles.add(normalizePosix(mod.roleFile));
    }

    for (const mapPath of mod.featureMaps ?? []) {
      const normalized = normalizePosix(mapPath);
      if (!context.existingPaths.has(normalized)) {
        violations.push({
          rule: "modules-missing-feature-map",
          path: normalized,
          line: null,
          message: `Module "${mod.id}" references missing feature map "${normalized}".`,
          fix: `Create "${normalized}" or fix the path in docs/factory/modules.json.`,
        });
      } else {
        referencedMaps.add(normalized);
      }
    }
  }

  for (const requiredId of REQUIRED_STANDING_MODULE_IDS) {
    if (!seenIds.has(requiredId)) {
      violations.push({
        rule: "modules-missing-standing-ai",
        path: registryPath,
        line: null,
        message: `Missing required standing module AI "${requiredId}" in modules.json.`,
        fix: `Add the "${requiredId}" entry to docs/factory/modules.json and .agents/roles/${requiredId}.md.`,
      });
    }
  }

  for (const roleFile of context.roleFilesOnDisk) {
    const normalized = normalizePosix(roleFile);
    if (!referencedRoles.has(normalized)) {
      violations.push({
        rule: "unregistered-role-file",
        path: normalized,
        line: null,
        message: `Role file "${normalized}" is not registered by any module in modules.json.`,
        fix: `Register "${normalized}" under its module in docs/factory/modules.json or remove the stale role file.`,
      });
    }
  }

  for (const mapFile of context.featureMapFilesOnDisk) {
    const normalized = normalizePosix(mapFile);
    if (normalized === ".agents/feature-map/README.md") continue;
    if (!referencedMaps.has(normalized)) {
      violations.push({
        rule: "unowned-feature-map",
        path: normalized,
        line: null,
        message: `Feature map "${normalized}" is not claimed by any standing module AI in modules.json.`,
        fix: `Add "${normalized}" to the owning module's \`featureMaps\` array in docs/factory/modules.json.`,
      });
    }
  }

  for (const ownerId of context.goldenJourneyOwners ?? []) {
    if (!seenIds.has(ownerId)) {
      violations.push({
        rule: "golden-journey-unknown-owner",
        path: "scripts/ops/golden-journeys.json",
        line: null,
        message: `Golden journey owner "${ownerId}" is not registered in docs/factory/modules.json.`,
        fix: `Map the journey's \`owner\` to one of: ${REQUIRED_STANDING_MODULE_IDS.join(", ")}.`,
      });
    }
  }

  return violations;
}

export function findMobileSingleSourceViolations(input: {
  readonly filesByPath: ReadonlyMap<string, string>;
  readonly hasMobileApp: boolean;
  readonly hasSharedBarrelIndex: boolean;
}): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  if (input.hasSharedBarrelIndex) {
    violations.push({
      rule: "shared-no-barrel-index",
      path: "packages/shared/src/index.ts",
      line: null,
      message: "packages/shared must use explicit subpath exports, never a barrel index.ts.",
      fix: "Remove packages/shared/src/index.ts and import via `@moss/shared/<subpath>`.",
    });
  }

  if (!input.hasMobileApp) return violations;

  for (const generatedPath of REQUIRED_MOBILE_GENERATED_FILES) {
    const contents = input.filesByPath.get(generatedPath);
    if (contents === undefined) {
      violations.push({
        rule: "mobile-missing-generated-asset",
        path: generatedPath,
        line: null,
        message: `Missing single-source generated mobile asset "${generatedPath}".`,
        fix: "Run `node apps/mobile/scripts/sync-moss-assets.mjs` to regenerate mobile assets from desktop sources.",
      });
    } else if (!contents.startsWith(GENERATED_HEADER)) {
      violations.push({
        rule: "mobile-hand-edited-generated-asset",
        path: generatedPath,
        line: 1,
        message: `Generated mobile file "${generatedPath}" is missing the generated header.`,
        fix: "Do not hand-edit generated files; edit the desktop/shared source and run `node apps/mobile/scripts/sync-moss-assets.mjs`.",
      });
    }
  }

  const toolActivityPath = "apps/mobile/src/moss/toolActivity.ts";
  const toolActivity = input.filesByPath.get(toolActivityPath);
  if (
    toolActivity !== undefined &&
    !/from\s+["']@moss\/shared\/mossToolPresentation["']/.test(toolActivity)
  ) {
    violations.push({
      rule: "mobile-tool-labels-single-source",
      path: toolActivityPath,
      line: null,
      message:
        "Mobile tool activity labels must be imported from `@moss/shared/mossToolPresentation`.",
      fix: "Import `mossToolLabel` from `@moss/shared/mossToolPresentation` instead of duplicating tool strings in apps/mobile.",
    });
  }

  const mobilePkgRaw = input.filesByPath.get("apps/mobile/package.json");
  const mobileAppRaw = input.filesByPath.get("apps/mobile/app.json");
  if (mobilePkgRaw && mobileAppRaw) {
    try {
      const pkg = JSON.parse(mobilePkgRaw) as { version?: string };
      const app = JSON.parse(mobileAppRaw) as { expo?: { version?: string } };
      if (pkg.version && app.expo?.version && pkg.version !== app.expo.version) {
        violations.push({
          rule: "mobile-version-drift",
          path: "apps/mobile/app.json",
          line: null,
          message: `apps/mobile/package.json (${pkg.version}) != apps/mobile/app.json (${app.expo.version}).`,
          fix: "Align `version` in apps/mobile/package.json and `expo.version` in apps/mobile/app.json.",
        });
      }
    } catch {
      violations.push({
        rule: "mobile-invalid-manifest-json",
        path: "apps/mobile/app.json",
        line: null,
        message: "Failed to parse apps/mobile/package.json or apps/mobile/app.json.",
        fix: "Fix JSON syntax in apps/mobile/package.json and apps/mobile/app.json.",
      });
    }
  }

  for (const [filePath, contents] of input.filesByPath) {
    if (!filePath.startsWith("apps/mobile/src/") || filePath.endsWith(".generated.ts")) continue;
    if (isTestOrFixturePath(filePath)) continue;
    if (/\bMOSS_MCP_TOOL_PRESENTATIONS\b\s*=/.test(contents)) {
      violations.push({
        rule: "mobile-duplicate-tool-table",
        path: filePath,
        line: null,
        message:
          "Mobile defines its own MOSS_MCP_TOOL_PRESENTATIONS table instead of reading @moss/shared.",
        fix: "Delete the local table and import from `@moss/shared/mossToolPresentation`.",
      });
    }
  }

  return violations;
}

function collectFiles(repoRoot: string, relativeDir: string): SourceFile[] {
  const absDir = join(repoRoot, relativeDir);
  if (!existsSync(absDir)) return [];
  const results: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".turbo" ||
        entry.name === ".expo" ||
        entry.name === "android" ||
        entry.name === "ios"
      ) {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "__tests__" ||
          entry.name === "test" ||
          entry.name === "tests" ||
          entry.name === "fixtures" ||
          entry.name === "testing"
        ) {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      const relPath = normalizePosix(relative(repoRoot, fullPath));
      if (isTestOrFixturePath(relPath)) continue;
      results.push({
        path: relPath,
        contents: readFileSync(fullPath, "utf8"),
      });
    }
  };
  walk(absDir);
  return results;
}

function collectMarkdownFiles(repoRoot: string, relativeDir: string): string[] {
  const absDir = join(repoRoot, relativeDir);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => normalizePosix(join(relativeDir, entry.name)))
    .toSorted();
}

export function runBoundaryCheck(repoRoot: string): {
  readonly violations: readonly BoundaryViolation[];
  readonly summary: string;
} {
  const scanRoots = [
    "packages/contracts/src",
    "packages/shared/src",
    "apps/web/src",
    "apps/server/src",
    "apps/desktop/src",
    "apps/mobile/src",
  ];
  const sourceFiles = scanRoots.flatMap((dir) => collectFiles(repoRoot, dir));
  const violations: BoundaryViolation[] = [...findCrossLayerViolations(sourceFiles)];

  const filesByPath = new Map<string, string>(sourceFiles.map((f) => [f.path, f.contents]));
  for (const manifestPath of ["apps/mobile/package.json", "apps/mobile/app.json"]) {
    const abs = join(repoRoot, manifestPath);
    if (existsSync(abs)) filesByPath.set(manifestPath, readFileSync(abs, "utf8"));
  }

  const hasMobileApp = existsSync(join(repoRoot, "apps", "mobile", "src"));
  const hasSharedBarrelIndex = existsSync(join(repoRoot, "packages", "shared", "src", "index.ts"));
  violations.push(
    ...findMobileSingleSourceViolations({
      filesByPath,
      hasMobileApp,
      hasSharedBarrelIndex,
    }),
  );

  let registryChecked = false;
  const modulesJsonPath = join(repoRoot, "docs", "factory", "modules.json");
  if (existsSync(modulesJsonPath)) {
    registryChecked = true;
    const registry = JSON.parse(readFileSync(modulesJsonPath, "utf8")) as ModulesRegistry;
    const roleFilesOnDisk = collectMarkdownFiles(repoRoot, ".agents/roles");
    const featureMapFilesOnDisk = collectMarkdownFiles(repoRoot, ".agents/feature-map");
    const existingPaths = new Set<string>([...roleFilesOnDisk, ...featureMapFilesOnDisk]);
    for (const mod of registry.modules ?? []) {
      for (const candidate of [mod.roleFile, ...(mod.featureMaps ?? [])]) {
        if (candidate && existsSync(join(repoRoot, candidate))) {
          existingPaths.add(normalizePosix(candidate));
        }
      }
    }

    let goldenJourneyOwners: string[] | undefined;
    const goldenPath = join(repoRoot, "scripts", "ops", "golden-journeys.json");
    if (existsSync(goldenPath)) {
      const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
        journeys?: Array<{ owner?: string }>;
      };
      goldenJourneyOwners = (golden.journeys ?? [])
        .map((j) => j.owner)
        .filter((owner): owner is string => typeof owner === "string");
    }

    violations.push(
      ...validateModulesRegistry(registry, {
        existingPaths,
        roleFilesOnDisk,
        featureMapFilesOnDisk,
        ...(goldenJourneyOwners ? { goldenJourneyOwners } : {}),
      }),
    );
  }

  const summary = `Module boundaries verified across ${sourceFiles.length} source files (registry=${registryChecked ? "checked" : "skipped-on-mirror"}, mobile=${hasMobileApp ? "checked" : "skipped-on-mirror"}).`;
  return { violations, summary };
}

function main(): void {
  const repoRoot = join(import.meta.dirname, "..");
  const { violations, summary } = runBoundaryCheck(repoRoot);
  if (violations.length === 0) {
    console.log(summary);
    return;
  }

  console.error(`Module boundary check failed (${violations.length} violation(s)):`);
  for (const v of violations) {
    const loc = v.line === null ? v.path : `${v.path}:${v.line}`;
    console.error(`- [${v.rule}] ${loc}: ${v.message}`);
    console.error(`  Fix: ${v.fix}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
