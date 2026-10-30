import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverMossPluginRuntime } from "../provider/mossPluginRuntime";
import { MOSS_PLUGIN_CREATOR_SKILL } from "./mossPluginCreatorSkill";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function importDocumentedPackage(omitInterfaceField?: string) {
  const example = /```json\n([\s\S]*?)\n```/.exec(MOSS_PLUGIN_CREATOR_SKILL)?.[1];
  expect(example, "The delivered skill must contain a usable manifest example").toBeDefined();
  const manifest = JSON.parse(example!) as {
    name: string;
    skills: string;
    interface: Record<string, unknown>;
  };
  if (omitInterfaceField) delete manifest.interface[omitInterfaceField];
  const workspace = await mkdtemp(path.join(tmpdir(), "moss-creator-contract-"));
  roots.push(workspace);
  const pluginRoot = path.join(workspace, "plugins", manifest.name);
  const skillRoot = path.join(pluginRoot, manifest.skills, "example-workflow");
  await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: example-workflow\ndescription: Inspect a local fixture when verifying plugin authoring.\n---\n\nRead the local fixture and report the result.\n",
  );
  const marketplacePath = path.join(workspace, "marketplace.json");
  await writeFile(
    marketplacePath,
    JSON.stringify({
      name: "creator-contract",
      interface: { displayName: "Creator Contract" },
      plugins: [
        {
          name: manifest.name,
          source: { source: "local", path: `./plugins/${manifest.name}` },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Developer Tools",
        },
      ],
    }),
  );
  return discoverMossPluginRuntime({ cwd: workspace, pluginRoots: [pluginRoot], marketplacePath });
}

it("imports a package built from the manifest delivered in Plugin Creator", async () => {
  const result = await importDocumentedPackage();
  expect(result.errors).toEqual([]);
  expect(result.plugins).toHaveLength(1);
  expect(result.plugins[0]?.validation.ok).toBe(true);
  expect(result.plugins[0]?.components).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "skill", name: "example-workflow" })]),
  );
});

it.each([
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "defaultPrompt",
])("rejects the documented package when required interface.%s is removed", async (field) => {
  const result = await importDocumentedPackage(field);
  expect(result.errors.some((error) => error.includes(field))).toBe(true);
  expect(result.plugins[0]?.validation.ok).toBe(false);
});
