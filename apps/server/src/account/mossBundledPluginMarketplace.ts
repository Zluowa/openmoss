// FILE: mossBundledPluginMarketplace.ts
// Purpose: Materialize Moss-owned, credential-free plugins as a native local
//          Codex marketplace inside the isolated managed-provider home.
// Safety: Every path segment is fixed by Moss, symlinks are rejected, files are
//         atomically replaced, and no personal Codex marketplace or credential
//         state is read or copied.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { syncDirectoryEntrySync } from "@synara/shared/filesystemPlatform";
import {
  MOSS_BUNDLED_MEDIA_PLUGINS,
  type MossBundledMediaPlugin,
  buildMossBundledMediaSkill,
} from "./mossBundledMediaPlugins";
import {
  MOSS_BUNDLED_PLUGIN_CREATOR_NAME,
  MOSS_PLUGIN_CREATOR_SKILL,
} from "./mossPluginCreatorSkill";
export { MOSS_BUNDLED_PLUGIN_CREATOR_NAME } from "./mossPluginCreatorSkill";
export { MOSS_BUNDLED_IMAGEGEN_PLUGIN_NAME } from "./mossBundledMediaPlugins";

export const MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME = "moss-bundled";
export const MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME = "moss-web-builder";
export const MOSS_BUNDLED_CANVAS_PLUGIN_NAME = "moss-canvas";

const MARKETPLACE_DIRECTORY_NAME = "moss-bundled-marketplace-v1";
const MARKETPLACE_MANIFEST_RELATIVE_PATH = path.join(".agents", "plugins", "marketplace.json");

const MEDIA_MARKETPLACE_ENTRIES = MOSS_BUNDLED_MEDIA_PLUGINS.map((plugin) => ({
  name: plugin.name,
  source: { source: "local", path: `./plugins/${plugin.name}` },
  policy: {
    installation: "defaultInstalled" in plugin ? "INSTALLED_BY_DEFAULT" : "AVAILABLE",
    authentication: "ON_USE",
  },
  category: "Creativity",
}));

// Listed in the order Moss presents its presets: image generation and Canvas
// first, then the other media models, then the developer workflows.
const MARKETPLACE_MANIFEST = {
  name: MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME,
  interface: { displayName: "Moss Built-ins" },
  plugins: [
    ...MEDIA_MARKETPLACE_ENTRIES.slice(0, 1),
    {
      name: MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
      source: { source: "local", path: `./plugins/${MOSS_BUNDLED_CANVAS_PLUGIN_NAME}` },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Creativity",
    },
    ...MEDIA_MARKETPLACE_ENTRIES.slice(1),
    {
      name: MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME,
      source: {
        source: "local",
        path: "./plugins/moss-web-builder",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_USE",
      },
      category: "Developer Tools",
    },
    {
      name: MOSS_BUNDLED_PLUGIN_CREATOR_NAME,
      source: { source: "local", path: `./plugins/${MOSS_BUNDLED_PLUGIN_CREATOR_NAME}` },
      policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" },
      category: "Developer Tools",
    },
  ],
} as const;

const WEB_BUILDER_MANIFEST = {
  name: MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME,
  version: "1.0.0",
  interface: {
    displayName: "Moss Web App Builder",
    shortDescription: "Build and verify production-quality web interfaces",
    longDescription:
      "A Moss-owned workflow for inspecting an existing web stack, implementing focused UI changes, and verifying the real interaction path in a browser.",
    developerName: "Moss",
    category: "Developer Tools",
    capabilities: ["Build web interfaces", "Run browser QA", "Verify interactions"],
    defaultPrompt: [
      "Build or improve this web experience, preserve the existing stack, and verify the real interaction path in a browser.",
    ],
  },
  description:
    "Build and verify web interfaces with repository-aware implementation and browser QA.",
  author: { name: "Moss" },
  license: "MIT",
  keywords: ["moss", "web", "frontend", "browser", "quality"],
  skills: "./skills/",
} as const;

const WEB_BUILDER_SKILL = `---
name: web-app-builder
description: Build or improve a web interface in the current repository and verify its real browser behavior.
---

# Moss Web App Builder

Use this skill when the user asks to build, repair, or polish a web experience.

1. Inspect the existing framework, design system, scripts, and repository instructions before editing.
2. Reuse established components and interaction patterns; keep the change focused and maintainable.
3. Preserve keyboard, loading, error, empty, and reduced-motion behavior relevant to the edited flow.
4. Run the smallest useful source tests while iterating.
5. Launch the actual page in an isolated browser or desktop runtime and exercise the changed interaction end to end.
6. Report only observed behavior. A build, HTTP response, or visible button is not proof that the interaction completed.
`;

const PLUGIN_CREATOR_MANIFEST = {
  name: MOSS_BUNDLED_PLUGIN_CREATOR_NAME,
  version: "1.0.0",
  description: "Create and validate native plugins and skills in your workspace.",
  author: { name: "Moss" },
  license: "MIT",
  skills: "./skills/",
  interface: {
    displayName: "Plugin Creator",
    shortDescription: "Create and validate plugins and skills",
    developerName: "Moss",
    category: "Developer Tools",
    defaultPrompt: ["Help me create a plugin."],
  },
} as const;

const CANVAS_MANIFEST = {
  name: MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
  version: "1.0.0",
  description: "Open Moss Canvas to lay out, compare and edit this conversation's images.",
  author: { name: "Moss" },
  license: "MIT",
  skills: "./skills/",
  interface: {
    displayName: "Moss Canvas",
    shortDescription: "Lay out and edit images on a canvas",
    developerName: "Moss",
    category: "Creativity",
    defaultPrompt: ["Open this image in Moss Canvas."],
  },
} as const;

const CANVAS_SKILL = `---
name: moss-canvas
description: Open Moss Canvas when the user asks to open Canvas or to edit an image there.
---

# Moss Canvas

Moss Canvas is Moss's full image workspace for this conversation.

1. Call \`moss_canvas_open\` only when the user explicitly asks to open Canvas or to edit an image there. Ordinary image generation stays in the conversation and never opens Canvas on its own.
2. To open Canvas on an image from this conversation, pass that image's \`jobId\` (from \`moss_media_list\` or \`moss_media_generate\`) and, for a job with several outputs, its \`imageIndex\`. Without a \`jobId\` it opens this conversation's canvas.
3. Opening Canvas generates nothing and costs nothing; creating or editing images still goes through the media tools.

The tool is provided by the Moss host. If it is absent, say that Canvas is unavailable in this session.
`;

function mediaPluginManifest(plugin: MossBundledMediaPlugin) {
  return {
    name: plugin.name,
    version: "1.0.0",
    description: `Create and edit with ${plugin.title} using your Moss account.`,
    author: { name: "Moss" },
    license: "MIT",
    skills: "./skills/",
    interface: {
      displayName: plugin.title,
      shortDescription: `Generate ${plugin.kind}s with your Moss account`,
      developerName: "Moss",
      category: "Creativity",
      defaultPrompt: [
        `Use ${plugin.title} to ${plugin.kind === "image" ? "create or edit an image" : "create a video"}.`,
      ],
    },
  };
}

function lstatIfExists(candidate: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function assertDirectory(candidate: string, label: string): void {
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link.`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
}

function ensureDirectory(candidate: string, label: string): void {
  const existing = lstatIfExists(candidate);
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link.`);
    if (!existing.isDirectory()) throw new Error(`${label} must be a directory.`);
    chmodSync(candidate, 0o700);
    return;
  }
  mkdirSync(candidate, { mode: 0o700 });
}

function writePrivateFileAtomically(filePath: string, contents: string): void {
  const existing = lstatIfExists(filePath);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Moss bundled marketplace file may not be a symbolic link: ${filePath}`);
  }
  if (existing && !existing.isFile()) {
    throw new Error(`Moss bundled marketplace file must be regular: ${filePath}`);
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
    syncDirectoryEntrySync(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the materialization error.
    }
    throw error;
  }
}

interface BundledPluginFiles {
  readonly name: string;
  readonly manifest: object;
  /** One manifest per CLI plugin format that reads it. */
  readonly manifestDirectories: ReadonlyArray<".codex-plugin" | ".claude-plugin">;
  readonly skillName: string;
  readonly skill: string;
}

const BUNDLED_PLUGIN_FILES: ReadonlyArray<BundledPluginFiles> = [
  {
    name: MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME,
    manifest: WEB_BUILDER_MANIFEST,
    manifestDirectories: [".codex-plugin"],
    skillName: "web-app-builder",
    skill: WEB_BUILDER_SKILL,
  },
  {
    name: MOSS_BUNDLED_PLUGIN_CREATOR_NAME,
    manifest: PLUGIN_CREATOR_MANIFEST,
    manifestDirectories: [".codex-plugin"],
    skillName: "plugin-creator",
    skill: MOSS_PLUGIN_CREATOR_SKILL,
  },
  {
    name: MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
    manifest: CANVAS_MANIFEST,
    manifestDirectories: [".codex-plugin", ".claude-plugin"],
    skillName: MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
    skill: CANVAS_SKILL,
  },
  ...MOSS_BUNDLED_MEDIA_PLUGINS.map((plugin) => ({
    name: plugin.name,
    manifest: mediaPluginManifest(plugin),
    manifestDirectories: [".codex-plugin", ".claude-plugin"] as const,
    skillName: plugin.name,
    skill: buildMossBundledMediaSkill(plugin),
  })),
];

/** Writes one Moss-owned plugin: its manifest for each CLI format and its one skill. */
function writeBundledPlugin(root: string, plugin: BundledPluginFiles): void {
  const pluginRoot = path.join(root, "plugins", plugin.name);
  const skillRoot = path.join(pluginRoot, "skills", plugin.skillName);
  for (const directory of [
    pluginRoot,
    ...plugin.manifestDirectories.map((directory) => path.join(pluginRoot, directory)),
    path.join(pluginRoot, "skills"),
    skillRoot,
  ]) {
    ensureDirectory(directory, `The Moss bundled plugin directory for ${plugin.name}`);
  }
  const manifest = `${JSON.stringify(plugin.manifest, null, 2)}\n`;
  for (const directory of plugin.manifestDirectories) {
    writePrivateFileAtomically(path.join(pluginRoot, directory, "plugin.json"), manifest);
  }
  writePrivateFileAtomically(path.join(skillRoot, "SKILL.md"), plugin.skill);
}

export function mossBundledPluginMarketplaceRoot(managedHomePath: string): string {
  return path.join(path.resolve(managedHomePath), MARKETPLACE_DIRECTORY_NAME);
}

export interface MossBundledPluginMarketplaceMaterialization {
  readonly root: string;
  readonly manifestPath: string;
}

export function materializeMossBundledPluginMarketplace(
  managedHomePath: string,
): MossBundledPluginMarketplaceMaterialization {
  const managedHome = path.resolve(managedHomePath);
  assertDirectory(managedHome, "The managed Moss Codex home");

  const root = mossBundledPluginMarketplaceRoot(managedHome);
  const agentsRoot = path.join(root, ".agents");
  const agentsPluginsRoot = path.join(agentsRoot, "plugins");
  for (const [directory, label] of [
    [root, "The Moss bundled marketplace root"],
    [agentsRoot, "The Moss bundled marketplace .agents directory"],
    [agentsPluginsRoot, "The Moss bundled marketplace manifest directory"],
    [path.join(root, "plugins"), "The Moss bundled marketplace plugins directory"],
  ] as const) {
    ensureDirectory(directory, label);
  }

  const manifestPath = path.join(root, MARKETPLACE_MANIFEST_RELATIVE_PATH);
  writePrivateFileAtomically(manifestPath, `${JSON.stringify(MARKETPLACE_MANIFEST, null, 2)}\n`);
  for (const plugin of BUNDLED_PLUGIN_FILES) writeBundledPlugin(root, plugin);
  return { root, manifestPath };
}
