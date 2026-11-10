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
import { syncDirectoryEntrySync } from "@moss/shared/filesystemPlatform";
import {
  MOSS_CANVAS_PLUGIN_NAME,
  MOSS_CANVAS_SKILL_DESCRIPTION,
  MOSS_MEDIA_PLUGINS,
  mossMediaPlugin,
  type MossMediaPluginSpec,
} from "@moss/shared/mossMediaPlugins";
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
export {
  MOSS_BUNDLED_IMAGEGEN_PLUGIN_NAME,
  MOSS_BUNDLED_VIDEOGEN_PLUGIN_NAME,
} from "./mossBundledMediaPlugins";

export const MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME = "moss-bundled";
export const MOSS_BUNDLED_WEB_BUILDER_PLUGIN_NAME = "moss-web-builder";
export const MOSS_BUNDLED_CANVAS_PLUGIN_NAME = MOSS_CANVAS_PLUGIN_NAME;

const MARKETPLACE_DIRECTORY_NAME = "moss-bundled-marketplace-v1";
const MARKETPLACE_MANIFEST_RELATIVE_PATH = path.join(".agents", "plugins", "marketplace.json");

const MEDIA_MARKETPLACE_ENTRIES = MOSS_MEDIA_PLUGINS.map((plugin) => ({
  name: plugin.name,
  source: { source: "local", path: `./plugins/${plugin.name}` },
  policy: {
    installation: plugin.defaultInstalled ? "INSTALLED_BY_DEFAULT" : "AVAILABLE",
    authentication: "ON_USE",
  },
  category: "Creativity",
}));

// Listed in the order Moss presents its presets: the general image and video
// skills and Canvas first, then each model vendor, then the developer workflows.
const MARKETPLACE_MANIFEST = {
  name: MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME,
  interface: { displayName: "Moss Built-ins" },
  plugins: [
    ...MEDIA_MARKETPLACE_ENTRIES,
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

function pluginManifest(plugin: MossMediaPluginSpec) {
  return {
    name: plugin.name,
    version: "1.1.0",
    description: plugin.en.longDescription,
    author: { name: "Moss" },
    license: "MIT",
    skills: "./skills/",
    interface: {
      displayName: plugin.en.displayName,
      shortDescription: plugin.en.shortDescription,
      longDescription: plugin.en.longDescription,
      developerName: "Moss",
      category: "Creativity",
      defaultPrompt: [plugin.en.defaultPrompt],
    },
  };
}

const CANVAS_SKILL = `---
name: moss-canvas
description: ${MOSS_CANVAS_SKILL_DESCRIPTION.en}
---

# Moss 画布

Moss 画布是这段对话自己的图片和视频画板：这段对话里生成的图片和视频会自动放到画布上，对方可以在上面排版、比较、标注和继续编辑。

画布不是「资料空间」。资料空间是文档页面，用 \`moss_pages_*\` 工具管理；对方说「画布」「Canvas」「打开画布」时，指的都是 Moss 画布，不要去建文档空间或页面。

## 怎么做

1. 用对方说话的语言回复。
2. 对方要打开或查看画布时，直接调用 \`moss_canvas_open\`。想定位到某张生成的图片时，传入它的 \`jobId\`（多张输出时再传 \`imageIndex\`）。
3. 想知道画布上已经有什么时，调用 \`moss_canvas_read\`：它返回画布上的形状、文字和这段对话放上去的图片与视频。
4. 对方想在画布上放一张新图时，用「生图」技能（\`moss_media_generate\`）生成；完成后按对方的画布要求，用 \`moss_canvas_open\` 加上 jobId 打开画布给对方看。
5. 打开和读取画布不会生成任何内容，也不扣积分；只有生成或编辑图片、视频才会消耗 Moss 积分。

这些工具由 Moss 提供。如果它们不存在，告诉对方这次对话暂时用不了画布，请对方登录 Moss 账号后再试。
`;

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
    manifest: pluginManifest(mossMediaPlugin(MOSS_BUNDLED_CANVAS_PLUGIN_NAME)!),
    manifestDirectories: [".codex-plugin", ".claude-plugin"],
    skillName: MOSS_BUNDLED_CANVAS_PLUGIN_NAME,
    skill: CANVAS_SKILL,
  },
  ...MOSS_BUNDLED_MEDIA_PLUGINS.map((plugin: MossBundledMediaPlugin) => ({
    name: plugin.name,
    manifest: pluginManifest(plugin),
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
