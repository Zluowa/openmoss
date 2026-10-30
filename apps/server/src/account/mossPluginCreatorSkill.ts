// Moss-owned authoring workflow. Packages remain ordinary native CLI plugins.
export const MOSS_BUNDLED_PLUGIN_CREATOR_NAME = "moss-plugin-creator";

const MANIFEST_EXAMPLE = {
  name: "my-plugin",
  version: "1.0.0",
  description: "A reusable workflow for a specific local task.",
  author: { name: "Your team" },
  license: "MIT",
  skills: "./skills/",
  interface: {
    displayName: "My Plugin",
    shortDescription: "Run the local task workflow",
    longDescription: "Inspect the current workspace and complete the task described by its skill.",
    developerName: "Your team",
    category: "Developer Tools",
    capabilities: ["Inspect the workspace", "Follow the task instructions"],
    defaultPrompt: ["Help me complete this task in the current workspace."],
  },
};

export const MOSS_PLUGIN_CREATOR_SKILL = `---
name: plugin-creator
description: Create, validate, or update a portable Codex or Claude plugin with skills, optional MCP tools, and a local marketplace entry.
---

# Moss Plugin Creator

Create a working plugin in the user's repository. Use the user's request and existing files to choose the scope; ask only about missing decisions that change the result.

## Inspect and design

1. Read repository instructions and any existing plugin, skills, and marketplace files. Preserve unrelated packages and local changes.
2. Choose a stable lowercase hyphenated plugin name and describe when each skill should be used. A skill contains instructions; an MCP server supplies executable tools. Add a server only when the workflow needs tools that the current runtime does not already expose.
3. Identify required accounts, configuration, network access, dependencies, and tool permissions. Use environment-variable references or the platform's OAuth connection flow. Never embed API keys, access tokens, passwords, account IDs, or billing credentials in distributable files.
4. For Moss image/video generation, reuse the authenticated moss_media_list, moss_media_generate, and moss_media_get tools. Keep supplier credentials and billing on the Moss server. Do not implement a second client-side billing or model proxy.

## Build the package

Use this layout, with paths relative to the plugin root:

- .codex-plugin/plugin.json: name, version, description, author, license, skills: "./skills/", and the complete interface metadata shown below.
- skills/<skill-name>/SKILL.md: YAML frontmatter with name and a precise description, followed by concise actionable instructions.
- scripts/ or references/: only the reusable code or reference material required by those instructions.
- README.md: installation, configuration, examples, permissions, troubleshooting, and removal instructions.

Start the manifest from this example and replace its name, author, descriptions, capabilities, and prompt with accurate values for the requested workflow. Moss requires all seven interface fields; capabilities and defaultPrompt are arrays of non-empty strings. A package accepted by the native CLI must also pass Moss's importer validation.

\`\`\`json
${JSON.stringify(MANIFEST_EXAMPLE, null, 2)}
\`\`\`

For Claude compatibility, create .claude-plugin/plugin.json only after validating its manifest against the installed Claude version. For MCP servers or other manifest fields, inspect the current installed CLI schema or official documentation; do not guess fields or declare unsupported compatibility.

For a local Codex marketplace, use .agents/plugins/marketplace.json with a name, interface.displayName, and a plugins array. Each plugin entry contains name, source: { source: "local", path: "./plugins/<plugin-name>" }, policy: { installation: "AVAILABLE", authentication: "ON_USE" }, and category. Keep the plugin directory inside that marketplace. Merge an existing manifest without dropping other entries. Do not edit Moss-managed homes or the user's global CLI configuration directly.

## Validate and hand off

1. Parse each JSON manifest and check names, relative paths, and all referenced files. Reject path traversal and secret-bearing files before packaging.
2. Use the actual installed CLI or Moss plugin catalog to discover the package, read its skills, and check any supported validation command. Do not invent a CLI subcommand. Exercise scripts with a meaningful safe test and report dependencies that could not be tested.
3. For installation, use the user's requested local marketplace through Moss Plugins. Verify the native install result and discovery of the skill; do not equate writing files with successful installation. Respect later uninstall/disable choices.
4. Deliver the exact source paths, tested behavior, and any remaining setup. Publishing to a public marketplace or sending files to another service requires authorization for that destination.
`;
